/*
 * routes/pool.js — LEAD_POOL_v2 ("Free Pool" / lead recycling)
 * ------------------------------------------------------------------
 * Blind BATCH-pull recycling pool.
 *
 *  Membership is LIVE & status-driven: a lead is "in the pool" iff its
 *  CURRENT status is an admin-chosen pool status (e.g. NP). Nothing is
 *  copied or flagged — it leaves the pool only when its status changes.
 *
 *  Admin rule = pool statuses + a list of users, EACH with their own
 *  per-pull batch size (Rep A = 5, Rep B = 10). Stored as:
 *    POOL_STATUS_IDS   = CSV of status_ids
 *    POOL_PULL_RULES   = JSON [{ user_id, count }]
 *    POOL_ENABLED      = '1' | '0'
 *
 *  Users NEVER see a lead list — only a COUNT (+ date-wise breakdown).
 *  One Pull button hands them their configured batch of the NEWEST pool
 *  leads, SHARED (co-owner via lead_co_owners, original owner kept). A
 *  lead stays in the pool after being pulled (still its status), so it
 *  can be shared with other users too; a user is never handed a lead
 *  they already own/co-own.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ── config helpers (explicit parse — no empty-string trap) ───────────
function _csvIds(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  return String(raw).split(',').map(x => Number(String(x).trim())).filter(n => Number.isFinite(n) && n > 0);
}
async function _poolStatusIds() { return _csvIds(await db.getConfig('POOL_STATUS_IDS', '')); }
async function _poolEnabled()   { return String(await db.getConfig('POOL_ENABLED', '')) === '1'; }
async function _pullRules() {
  const raw = await db.getConfig('POOL_PULL_RULES', '');
  if (!raw || String(raw).trim() === '') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(r => ({ user_id: Number(r.user_id), count: Math.max(0, Number(r.count) || 0) }))
              .filter(r => Number.isFinite(r.user_id) && r.user_id > 0);
  } catch (_) { return []; }
}
function _ruleFor(rules, userId) { return rules.find(r => Number(r.user_id) === Number(userId)) || null; }

const ADMIN_DEFAULT_COUNT = 10; // admins without an explicit rule pull this many

async function _canPull(me, rules) {
  if (!me) return false;
  if (me.role === 'admin') return true;
  return !!_ruleFor(rules || await _pullRules(), me.id);
}
async function _pullCountFor(me, rules) {
  const r = _ruleFor(rules, me.id);
  if (r) return r.count;
  if (me.role === 'admin') return ADMIN_DEFAULT_COUNT;
  return 0;
}

// ── status-change hook (kept only for the lead_actions timeline) ─────
async function applyPoolTransition(leadId, oldLead, newStatusId, actor) {
  try {
    const ids = await _poolStatusIds();
    const nid = Number(newStatusId);
    const wasPool = ids.includes(Number(oldLead && oldLead.status_id));
    const isPool  = ids.includes(nid);
    if (isPool && !wasPool) {
      try { await db.query(`INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
        [Number(leadId), 'entered_pool', actor ? actor.id : null, JSON.stringify({ status_id: nid })]); } catch (_) {}
    } else if (!isPool && wasPool) {
      try { await db.query(`INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
        [Number(leadId), 'left_pool', actor ? actor.id : null, JSON.stringify({ status_id: nid })]); } catch (_) {}
    }
  } catch (e) { console.warn('[pool] applyPoolTransition skipped:', e.message); }
}

// ── admin config: read ───────────────────────────────────────────────
async function api_pool_config_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  return {
    enabled: await _poolEnabled(),
    status_ids: await _poolStatusIds(),
    rules: await _pullRules()
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
  if (p.rules !== undefined) {
    const clean = (Array.isArray(p.rules) ? p.rules : [])
      .map(r => ({ user_id: Number(r.user_id), count: Math.max(0, Number(r.count) || 0) }))
      .filter(r => Number.isFinite(r.user_id) && r.user_id > 0 && r.count > 0);
    await db.setConfig('POOL_PULL_RULES', JSON.stringify(clean));
  }
  return { ok: true, enabled: await _poolEnabled(), status_ids: await _poolStatusIds(), rules: await _pullRules() };
}

// ── user view: available COUNT + date-wise breakdown (no lead list) ──
async function api_pool_summary(token) {
  const me = await authUser(token);
  const rules = await _pullRules();
  if (!await _canPull(me, rules)) throw new Error('Forbidden');
  if (!await _poolEnabled()) return { enabled: false, total: 0, by_date: [], my_count: 0 };
  const poolIds = await _poolStatusIds();
  const my_count = await _pullCountFor(me, rules);
  if (!poolIds.length) return { enabled: true, total: 0, by_date: [], my_count };
  // Available to ME = in a pool status, not hidden, and I don't already
  // own / co-own it.
  const r = await db.query(
    `SELECT to_char((COALESCE(l.last_status_change_at, l.updated_at, l.created_at) AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d,
            COUNT(*)::int AS n
       FROM leads l
      WHERE l.status_id = ANY($1::int[]) AND COALESCE(l.is_hidden,0) = 0
        AND (l.assigned_to IS NULL OR l.assigned_to <> $2)
        AND NOT EXISTS (SELECT 1 FROM lead_co_owners co WHERE co.lead_id = l.id AND co.user_id = $2)
      GROUP BY d ORDER BY d DESC`,
    [poolIds, Number(me.id)]
  );
  const by_date = r.rows.map(x => ({ date: x.d, count: Number(x.n) }));
  return { enabled: true, total: by_date.reduce((a, b) => a + b.count, 0), by_date, my_count };
}

// ── POOL_PULL_FRESH_v1: resolve (or create) the dedicated "Pulled" status ─
let _pulledStatusIdCache = null;
async function _pulledStatusId() {
  if (_pulledStatusIdCache) return _pulledStatusIdCache;
  const sel = await db.query(`SELECT id FROM statuses WHERE lower(name) = 'pulled' ORDER BY id LIMIT 1`);
  if (sel.rows.length) { _pulledStatusIdCache = Number(sel.rows[0].id); return _pulledStatusIdCache; }
  const ins = await db.query(
    `INSERT INTO statuses (name, color, sort_order, is_final) VALUES ('Pulled', '#0ea5e9', 5, 0) RETURNING id`);
  _pulledStatusIdCache = Number(ins.rows[0].id);
  return _pulledStatusIdCache;
}

// ── pull: claim my configured batch (newest-first), shared ───────────
async function api_pool_pull(token) {
  const me = await authUser(token);
  const rules = await _pullRules();
  if (!await _canPull(me, rules)) throw new Error('You are not allowed to pull leads from the pool');
  if (!await _poolEnabled()) throw new Error('Lead Pool is disabled by admin');
  const poolIds = await _poolStatusIds();
  if (!poolIds.length) return { ok: true, pulled_count: 0, lead_ids: [] };
  const count = await _pullCountFor(me, rules);
  if (count <= 0) return { ok: true, pulled_count: 0, lead_ids: [], reason: 'Your pull count is 0 — ask your admin.' };

  // Newest-first batch of leads I don't already own/co-own.
  const sel = await db.query(
    `SELECT l.id
       FROM leads l
      WHERE l.status_id = ANY($1::int[]) AND COALESCE(l.is_hidden,0) = 0
        AND (l.assigned_to IS NULL OR l.assigned_to <> $2)
        AND NOT EXISTS (SELECT 1 FROM lead_co_owners co WHERE co.lead_id = l.id AND co.user_id = $2)
      ORDER BY COALESCE(l.last_status_change_at, l.updated_at, l.created_at) DESC, l.id DESC
      LIMIT $3`,
    [poolIds, Number(me.id), Number(count)]
  );
  // POOL_PULL_FRESH_v1 — a pull now CLAIMS the lead as a fresh task for the
  // puller: flip to the dedicated "Pulled" status, assign it to me, stamp a
  // fresh pull timestamp (surfaced at the top of Recent), and reset the
  // follow-up to now so it lands in today's queue. created_at is preserved
  // for reporting. Race-guarded: only claim while still in a pool status.
  const pulledStatusId = await _pulledStatusId();
  const pulled = [];
  for (const row of sel.rows) {
    const leadId = Number(row.id);
    const upd = await db.query(
      `UPDATE leads
          SET status_id = $1, assigned_to = $2,
              pulled_at = NOW(), last_status_change_at = NOW(),
              next_followup_at = NOW(), updated_at = NOW()
        WHERE id = $3 AND status_id = ANY($4::int[])`,
      [pulledStatusId, Number(me.id), leadId, poolIds]
    );
    if (upd.rowCount > 0) {
      pulled.push(leadId);
      // keep a co-owner row for audit of who pulled it (idempotent)
      try { await db.query(
        `INSERT INTO lead_co_owners (lead_id, user_id, added_by, source)
         VALUES ($1, $2, $3, 'pool_pull') ON CONFLICT (lead_id, user_id) DO NOTHING`,
        [leadId, Number(me.id), Number(me.id)]); } catch (_) {}
      try { await db.query(`INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1,$2,$3,$4)`,
        [leadId, 'pulled_from_pool', me.id, JSON.stringify({ batch: true, claimed: true, status_id: pulledStatusId })]); } catch (_) {}
    }
  }
  return { ok: true, pulled_count: pulled.length, lead_ids: pulled };
}

module.exports = {
  applyPoolTransition,
  api_pool_config_get, api_pool_config_save,
  api_pool_summary, api_pool_pull
};
