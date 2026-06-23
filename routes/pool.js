/*
 * routes/pool.js — LEAD_POOL_v1 ("Free Pool")
 * ------------------------------------------------------------------
 * A status-released, SHARED lead pool / recycling box.
 *
 * Flow:
 *   1. Admin marks one or more statuses as "pool statuses" (config
 *      POOL_STATUS_IDS = CSV of status_ids, e.g. NP + Lost).
 *   2. The instant a lead is set to a pool status, it drops into the
 *      pool (leads.in_pool = 1, pool_entered_at = now). The original
 *      owner KEEPS the lead — they just see an "In Pool" badge.
 *   3. Users with the `pool.pull` permission browse the pool, see a
 *      DATE-WISE count of available leads, and pull any lead. Pulling
 *      adds them as a CO-OWNER (lead_co_owners, source='pool_pull') —
 *      shared model, the original owner is untouched. The lead stays
 *      in the pool so other authorised users can also pull it; it just
 *      disappears from the puller's own pool list.
 *   4. When the lead's status later moves OFF a pool status it leaves
 *      the available pool. Existing co-owners keep their shared access.
 *
 * Co-ownership + the 🤝 badge + lead-list visibility are all handled by
 * the existing SHARE_LEAD_v1 `lead_co_owners` infrastructure, so this
 * module only manages pool membership + the pull action.
 *
 * Permissions: pool.view (see the box + counts), pool.pull (claim).
 * Schema: leads.in_pool / pool_entered_at / pool_origin_status_id /
 *         pool_origin_user_id — migration 2026_06_23_lead_pool_v1 in
 *         utils/tenantBootstrap.js. _ensureSchema() below heals tenants
 *         that haven't re-bootstrapped yet (idempotent).
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// ── schema heal (idempotent, lazy) ───────────────────────────────────
let _ensured = new Set();
async function _ensureSchema() {
  let key = 'default';
  try { const st = db.tenantStorage && db.tenantStorage.getStore(); if (st && st.slug) key = st.slug; } catch (_) {}
  if (_ensured.has(key)) return;
  for (const sql of [
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS in_pool INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS pool_entered_at TIMESTAMPTZ`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS pool_origin_status_id INTEGER`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS pool_origin_user_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_leads_in_pool ON leads(in_pool, pool_entered_at) WHERE in_pool = 1`,
  ]) { try { await db.query(sql); } catch (_) {} }
  _ensured.add(key);
}

// ── config helpers ───────────────────────────────────────────────────
// Parse POOL_STATUS_IDS — explicit, no `String(v || 'x')` empty-string trap.
async function _poolStatusIds() {
  const raw = await db.getConfig('POOL_STATUS_IDS', '');
  if (raw == null || String(raw).trim() === '') return [];
  return String(raw)
    .split(',')
    .map(x => Number(String(x).trim()))
    .filter(n => Number.isFinite(n) && n > 0);
}
async function _poolEnabled() {
  const v = await db.getConfig('POOL_ENABLED', '');
  return String(v) === '1';
}

// ── the transition hook — called from routes/leads.js on status change ─
// oldLead = the lead row BEFORE the update; newStatusId = the status it's
// moving to; actor = the user making the change. Best-effort: never throw
// into the caller's status-change path.
async function applyPoolTransition(leadId, oldLead, newStatusId, actor) {
  try {
    await _ensureSchema();
    const ids = await _poolStatusIds();
    const nid = Number(newStatusId);
    const isPoolStatus = ids.includes(nid);
    const wasInPool = Number(oldLead && oldLead.in_pool) === 1;

    if (isPoolStatus && !wasInPool) {
      await db.update('leads', leadId, {
        in_pool: 1,
        pool_entered_at: db.nowIso(),
        pool_origin_status_id: nid,
        pool_origin_user_id: (oldLead && oldLead.assigned_to) ? Number(oldLead.assigned_to) : null
      });
      try {
        await db.query(
          `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
          [Number(leadId), 'entered_pool', actor ? actor.id : null,
           JSON.stringify({ status_id: nid })]
        );
      } catch (_) {}
    } else if (!isPoolStatus && wasInPool) {
      await db.update('leads', leadId, {
        in_pool: 0,
        pool_entered_at: null,
        pool_origin_status_id: null,
        pool_origin_user_id: null
      });
      try {
        await db.query(
          `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
          [Number(leadId), 'left_pool', actor ? actor.id : null,
           JSON.stringify({ status_id: nid })]
        );
      } catch (_) {}
      // Existing pool_pull co-owners are intentionally LEFT in place —
      // they earned shared access; the lead just exits the available pool.
    }
  } catch (e) {
    console.warn('[pool] applyPoolTransition skipped:', e.message);
  }
}

// ── admin config: read ───────────────────────────────────────────────
async function api_pool_config_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  return {
    enabled: await _poolEnabled(),
    status_ids: await _poolStatusIds()
  };
}

// ── admin config: save ───────────────────────────────────────────────
async function api_pool_config_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (typeof p.enabled === 'boolean' || p.enabled === 0 || p.enabled === 1 || p.enabled === '0' || p.enabled === '1') {
    await db.setConfig('POOL_ENABLED', (p.enabled === true || p.enabled === 1 || p.enabled === '1') ? '1' : '0');
  }
  if (p.status_ids !== undefined) {
    const csv = (Array.isArray(p.status_ids) ? p.status_ids : String(p.status_ids).split(','))
      .map(x => Number(String(x).trim()))
      .filter(n => Number.isFinite(n) && n > 0)
      .join(',');
    await db.setConfig('POOL_STATUS_IDS', csv);
  }
  return { ok: true, enabled: await _poolEnabled(), status_ids: await _poolStatusIds() };
}

// ── pool browse: date-wise summary ───────────────────────────────────
// Available to the caller = in pool, NOT their own primary lead, and they
// haven't already pulled it (no lead_co_owners row for them).
async function api_pool_summary(token) {
  const me = await authUser(token);
  const _perms = require('./permissions');
  if (!await _perms.can(me, 'pool.view')) throw new Error('Forbidden');
  await _ensureSchema();
  if (!await _poolEnabled()) return { enabled: false, total: 0, by_date: [] };

  const r = await db.query(
    `SELECT to_char((l.pool_entered_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d,
            COUNT(*)::int AS n
       FROM leads l
      WHERE l.in_pool = 1
        AND COALESCE(l.is_hidden,0) = 0
        AND (l.assigned_to IS NULL OR l.assigned_to <> $1)
        AND NOT EXISTS (SELECT 1 FROM lead_co_owners co
                         WHERE co.lead_id = l.id AND co.user_id = $1)
      GROUP BY d
      ORDER BY d DESC`,
    [Number(me.id)]
  );
  const by_date = r.rows.map(x => ({ date: x.d, count: Number(x.n) }));
  const total = by_date.reduce((a, b) => a + b.count, 0);
  return { enabled: true, total, by_date };
}

// ── pool browse: pullable list ───────────────────────────────────────
async function api_pool_list(token, filters) {
  const me = await authUser(token);
  const _perms = require('./permissions');
  if (!await _perms.can(me, 'pool.view')) throw new Error('Forbidden');
  await _ensureSchema();
  if (!await _poolEnabled()) return { enabled: false, rows: [] };
  filters = filters || {};

  const params = [Number(me.id)];
  let dateClause = '';
  if (filters.date) {
    params.push(String(filters.date));
    dateClause = ` AND to_char((l.pool_entered_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') = $${params.length}`;
  }
  const limit = Math.min(Number(filters.limit) || 500, 2000);

  const r = await db.query(
    `SELECT l.id, l.name, l.phone, l.status_id, l.assigned_to,
            l.pool_origin_status_id, l.pool_origin_user_id,
            to_char((l.pool_entered_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:MI') AS pool_entered,
            to_char((l.pool_entered_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS pool_date,
            s.name AS status_name,
            ow.name AS owner_name
       FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
       LEFT JOIN users ow   ON ow.id = l.assigned_to
      WHERE l.in_pool = 1
        AND COALESCE(l.is_hidden,0) = 0
        AND (l.assigned_to IS NULL OR l.assigned_to <> $1)
        AND NOT EXISTS (SELECT 1 FROM lead_co_owners co
                         WHERE co.lead_id = l.id AND co.user_id = $1)
        ${dateClause}
      ORDER BY l.pool_entered_at DESC, l.id DESC
      LIMIT ${limit}`,
    params
  );
  return { enabled: true, rows: r.rows };
}

// ── pull: claim a pooled lead as a co-owner (shared model) ───────────
async function api_pool_pull(token, leadId) {
  const me = await authUser(token);
  const _perms = require('./permissions');
  if (!await _perms.can(me, 'pool.pull')) throw new Error('Your role is not allowed to pull leads from the pool');
  await _ensureSchema();
  if (!await _poolEnabled()) throw new Error('Lead Pool is disabled by admin');

  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  if (Number(lead.in_pool) !== 1) throw new Error('This lead is no longer in the pool');
  if (lead.assigned_to != null && Number(lead.assigned_to) === Number(me.id)) {
    throw new Error('This lead is already yours');
  }

  // Add me as a co-owner (shared). Original owner keeps the lead.
  await db.query(
    `INSERT INTO lead_co_owners (lead_id, user_id, added_by, source)
     VALUES ($1, $2, $3, 'pool_pull')
     ON CONFLICT (lead_id, user_id) DO NOTHING`,
    [Number(leadId), Number(me.id), Number(me.id)]
  );
  try {
    await db.query(
      `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
      [Number(leadId), 'pulled_from_pool', me.id,
       JSON.stringify({ from_user: lead.assigned_to || null,
                        origin_status_id: lead.pool_origin_status_id || null })]
    );
  } catch (_) {}

  // Lead intentionally STAYS in the pool (in_pool=1) so other authorised
  // users can also pull it. It just leaves THIS user's pool list (the
  // co-owner NOT EXISTS filter above handles that).
  return { ok: true, lead_id: Number(leadId) };
}

module.exports = {
  applyPoolTransition,
  api_pool_config_get,
  api_pool_config_save,
  api_pool_summary,
  api_pool_list,
  api_pool_pull,
  _ensureSchema
};
