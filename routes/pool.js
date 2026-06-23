/*
 * routes/pool.js — LEAD_POOL_v1 ("Free Pool")
 * ------------------------------------------------------------------
 * Status-released, SHARED lead pool / recycling box.
 *
 *  1. Admin marks statuses as "pool statuses" (POOL_STATUS_IDS) and picks
 *     which employees may pull (POOL_PULL_USER_IDS) — both in the Pool
 *     Settings panel on the Lead Pool page.
 *  2. The instant a lead is set to a pool status it drops into the pool
 *     (leads.in_pool=1, pool_entered_at=now). The original owner keeps it.
 *  3. An allowed user pulls a lead → becomes a CO-OWNER (lead_co_owners,
 *     source='pool_pull'); the original owner is untouched (shared model).
 *     The lead stays in the pool so other allowed users can also pull it;
 *     it just disappears from the puller's own pool list.
 *  4. When the lead's status moves OFF a pool status it leaves the
 *     available pool. Existing co-owners keep their shared access.
 *
 * Who can pull/view = role permission (pool.view / pool.pull) OR the
 * admin's per-user allow-list (POOL_PULL_USER_IDS). Admins always can.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

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

// ── config helpers (explicit parse — no empty-string trap) ───────────
function _csvIds(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  return String(raw).split(',').map(x => Number(String(x).trim())).filter(n => Number.isFinite(n) && n > 0);
}
async function _poolStatusIds()  { return _csvIds(await db.getConfig('POOL_STATUS_IDS', '')); }
async function _pullUserIds()    { return _csvIds(await db.getConfig('POOL_PULL_USER_IDS', '')); }
async function _poolEnabled()    { return String(await db.getConfig('POOL_ENABLED', '')) === '1'; }

// View / pull authorisation = role permission OR per-user allow-list.
async function _canViewPool(me) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  try { if (await require('./permissions').can(me, 'pool.view')) return true; } catch (_) {}
  const ids = await _pullUserIds();
  return ids.includes(Number(me.id));
}
async function _canPullPool(me) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  try { if (await require('./permissions').can(me, 'pool.pull')) return true; } catch (_) {}
  const ids = await _pullUserIds();
  return ids.includes(Number(me.id));
}

// ── status-change hook (called from routes/leads.js) ─────────────────
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
      try { await db.query(
        `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
        [Number(leadId), 'entered_pool', actor ? actor.id : null, JSON.stringify({ status_id: nid })]); } catch (_) {}
    } else if (!isPoolStatus && wasInPool) {
      await db.update('leads', leadId, {
        in_pool: 0, pool_entered_at: null, pool_origin_status_id: null, pool_origin_user_id: null
      });
      try { await db.query(
        `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
        [Number(leadId), 'left_pool', actor ? actor.id : null, JSON.stringify({ status_id: nid })]); } catch (_) {}
      // Existing pool_pull co-owners are intentionally retained.
    }
  } catch (e) { console.warn('[pool] applyPoolTransition skipped:', e.message); }
}

// ── admin config: read ───────────────────────────────────────────────
async function api_pool_config_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  return {
    enabled: await _poolEnabled(),
    status_ids: await _poolStatusIds(),
    pull_user_ids: await _pullUserIds()
  };
}

// ── admin config: save ───────────────────────────────────────────────
async function api_pool_config_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (p.enabled !== undefined) {
    await db.setConfig('POOL_ENABLED', (p.enabled === true || p.enabled === 1 || p.enabled === '1') ? '1' : '0');
  }
  if (p.status_ids !== undefined) {
    await db.setConfig('POOL_STATUS_IDS', _csvIds(Array.isArray(p.status_ids) ? p.status_ids.join(',') : p.status_ids).join(','));
  }
  if (p.pull_user_ids !== undefined) {
    await db.setConfig('POOL_PULL_USER_IDS', _csvIds(Array.isArray(p.pull_user_ids) ? p.pull_user_ids.join(',') : p.pull_user_ids).join(','));
  }
  return { ok: true, enabled: await _poolEnabled(), status_ids: await _poolStatusIds(), pull_user_ids: await _pullUserIds() };
}

// ── pool browse: date-wise summary ───────────────────────────────────
// Membership is LIVE: a lead is in the pool iff its CURRENT status is a
// pool status. This means existing NP/etc leads show up immediately — no
// need to re-mark them. "In pool since" = last_status_change_at.
async function api_pool_summary(token) {
  const me = await authUser(token);
  if (!await _canViewPool(me)) throw new Error('Forbidden');
  await _ensureSchema();
  if (!await _poolEnabled()) return { enabled: false, total: 0, by_date: [] };
  const poolIds = await _poolStatusIds();
  if (!poolIds.length) return { enabled: true, total: 0, by_date: [] };
  const r = await db.query(
    `SELECT to_char((COALESCE(l.last_status_change_at, l.updated_at, l.created_at) AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d,
            COUNT(*)::int AS n
       FROM leads l
      WHERE l.status_id = ANY($1::int[]) AND COALESCE(l.is_hidden,0) = 0
        AND NOT EXISTS (SELECT 1 FROM lead_co_owners co WHERE co.lead_id = l.id AND co.user_id = $2)
      GROUP BY d ORDER BY d DESC`,
    [poolIds, Number(me.id)]
  );
  const by_date = r.rows.map(x => ({ date: x.d, count: Number(x.n) }));
  return { enabled: true, total: by_date.reduce((a, b) => a + b.count, 0), by_date };
}

// ── pool browse: pullable list ───────────────────────────────────────
async function api_pool_list(token, filters) {
  const me = await authUser(token);
  if (!await _canViewPool(me)) throw new Error('Forbidden');
  await _ensureSchema();
  if (!await _poolEnabled()) return { enabled: false, rows: [] };
  const poolIds = await _poolStatusIds();
  if (!poolIds.length) return { enabled: true, rows: [] };
  filters = filters || {};
  const params = [Number(me.id), poolIds];
  let dateClause = '';
  if (filters.date) {
    params.push(String(filters.date));
    dateClause = ` AND to_char((COALESCE(l.last_status_change_at, l.updated_at, l.created_at) AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') = $${params.length}`;
  }
  const limit = Math.min(Number(filters.limit) || 1000, 5000);
  const r = await db.query(
    `SELECT l.id, l.name, l.phone, l.status_id, l.assigned_to,
            to_char((COALESCE(l.last_status_change_at, l.updated_at, l.created_at) AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:MI') AS pool_entered,
            s.name AS status_name, ow.name AS owner_name,
            CASE WHEN l.assigned_to = $1 THEN 1 ELSE 0 END AS is_mine,
            CASE WHEN EXISTS (SELECT 1 FROM lead_co_owners co WHERE co.lead_id = l.id AND co.user_id = $1) THEN 1 ELSE 0 END AS already_pulled
       FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
       LEFT JOIN users ow   ON ow.id = l.assigned_to
      WHERE l.status_id = ANY($2::int[]) AND COALESCE(l.is_hidden,0) = 0
        ${dateClause}
      ORDER BY COALESCE(l.last_status_change_at, l.updated_at, l.created_at) DESC, l.id DESC
      LIMIT ${limit}`,
    params
  );
  return { enabled: true, rows: r.rows };
}

// ── pull: claim a pooled lead as a co-owner (shared model) ───────────
async function api_pool_pull(token, leadId) {
  const me = await authUser(token);
  if (!await _canPullPool(me)) throw new Error('You are not allowed to pull leads from the pool');
  await _ensureSchema();
  if (!await _poolEnabled()) throw new Error('Lead Pool is disabled by admin');
  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  const poolIds = await _poolStatusIds();
  if (!poolIds.includes(Number(lead.status_id))) throw new Error('This lead is no longer in the pool');
  if (lead.assigned_to != null && Number(lead.assigned_to) === Number(me.id)) throw new Error('This lead is already yours');

  await db.query(
    `INSERT INTO lead_co_owners (lead_id, user_id, added_by, source)
     VALUES ($1, $2, $3, 'pool_pull') ON CONFLICT (lead_id, user_id) DO NOTHING`,
    [Number(leadId), Number(me.id), Number(me.id)]
  );
  try { await db.query(
    `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
    [Number(leadId), 'pulled_from_pool', me.id,
     JSON.stringify({ from_user: lead.assigned_to || null, origin_status_id: lead.pool_origin_status_id || null })]); } catch (_) {}
  return { ok: true, lead_id: Number(leadId) };
}

module.exports = {
  applyPoolTransition,
  api_pool_config_get, api_pool_config_save,
  api_pool_summary, api_pool_list, api_pool_pull,
  _ensureSchema
};
