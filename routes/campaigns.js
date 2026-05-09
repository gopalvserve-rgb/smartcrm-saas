/**
 * routes/campaigns.js
 *
 * Campaigns admin module — multi-tenant CRM Phase 1.
 *
 * A campaign is a named container that:
 *   - belongs to one (optional) pipeline
 *   - has one manager (a user) and many agents (also users)
 *   - decides how new leads are distributed across its agents
 *     (on_demand | equal | round_robin | percentage | conditional)
 *   - decides what happens to an agent's open leads when that
 *     agent is removed from the campaign (pool | hidden | manager)
 *
 * Phase 1 only delivers the data model + CRUD. Distribution
 * enforcement, pull-rules, automation hooks, and conditional
 * rules live in Phases 2-4 (see migrations/2026_05_08_campaigns.sql
 * header for the per-mode semantics we'll be enforcing).
 */

const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const { applyRemovalPolicy } = require('../utils/campaignRemoval');

const VALID_MODES   = ['on_demand', 'equal', 'round_robin', 'percentage', 'conditional'];
// Idempotent: ensure the match_filter column exists. Pre-existing tenants
// don't have it (it was added 2026-05-09); this runs on first save.
let _matchFilterEnsured = false;
async function _ensureMatchFilterColumn() {
  if (_matchFilterEnsured) return;
  try {
    await db.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS match_filter JSONB`);
    _matchFilterEnsured = true;
  } catch (e) {
    // Best-effort. If it fails, the save below will surface a clearer
    // error than this would.
    console.warn('[campaigns] match_filter column ensure failed:', e.message);
  }
}

const VALID_REMOVED = ['pool', 'hidden', 'manager'];

async function _requireAdmin(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  return me;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

async function _hydrateAgents(campaignId) {
  const r = await db.query(
    `SELECT ca.id, ca.user_id, ca.weight_pct, ca.rr_position, ca.is_active,
            u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM campaign_agents ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.campaign_id = $1
      ORDER BY u.name ASC`,
    [campaignId]
  );
  return r.rows;
}

async function _userExists(userId) {
  if (!userId) return false;
  const r = await db.query('SELECT 1 FROM users WHERE id = $1 AND is_active = 1', [userId]);
  return r.rows.length > 0;
}

function _normaliseAgents(rawAgents, mode) {
  // Accept any of the shapes the SPA might send:
  //   [12, 13, 14]
  //   [{ user_id: 12, weight_pct: 40 }, ...]
  //   [{ id: 12 }, ...]
  if (!Array.isArray(rawAgents)) return [];
  const norm = rawAgents.map(a => {
    if (typeof a === 'number') return { user_id: Number(a), weight_pct: null };
    if (typeof a === 'string') return { user_id: Number(a), weight_pct: null };
    if (a && typeof a === 'object') {
      return {
        user_id:    Number(a.user_id || a.id),
        weight_pct: a.weight_pct != null ? Math.max(0, Math.min(100, Number(a.weight_pct))) : null
      };
    }
    return null;
  }).filter(a => a && Number.isFinite(a.user_id) && a.user_id > 0);

  // Default weights for percentage mode: split evenly when not provided.
  if (mode === 'percentage' && norm.length) {
    const haveAll = norm.every(a => Number.isFinite(a.weight_pct));
    if (!haveAll) {
      const each = Math.floor(100 / norm.length);
      const rem  = 100 - (each * norm.length);
      norm.forEach((a, i) => { a.weight_pct = each + (i === 0 ? rem : 0); });
    } else {
      const sum = norm.reduce((s, a) => s + (a.weight_pct || 0), 0);
      if (sum !== 100) throw new Error(`Percentage weights must sum to 100 (got ${sum}).`);
    }
  } else {
    // For non-percentage modes, weight_pct is informational (default 100).
    norm.forEach(a => { if (!Number.isFinite(a.weight_pct)) a.weight_pct = 100; });
  }
  return norm;
}

// ----------------------------------------------------------------
// API: list — for the Settings → Campaigns table
// ----------------------------------------------------------------

async function api_campaigns_list(token) {
  await authUser(token);   // any signed-in user can see; visibility is admin-tab gated client-side
  const r = await db.query(`
    SELECT c.id, c.name, c.pipeline, c.manager_user_id, c.distribution_mode,
           c.pull_batch_size, c.pull_initial_count,
           c.pull_require_old_updated, c.pull_old_threshold_minutes,
           c.removed_user_action, c.is_active,
           c.created_at, c.updated_at,
           mu.name  AS manager_name,
           mu.email AS manager_email,
           (SELECT COUNT(*) FROM campaign_agents ca
              WHERE ca.campaign_id = c.id AND ca.is_active = 1) AS agent_count,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id) AS lead_count
      FROM campaigns c
      LEFT JOIN users mu ON mu.id = c.manager_user_id
     ORDER BY c.is_active DESC, c.created_at DESC
  `);
  return r.rows;
}

async function api_campaigns_get(token, id) {
  await authUser(token);
  const cid = Number(id);
  if (!cid) throw new Error('Campaign id required');
  const c = await db.query('SELECT * FROM campaigns WHERE id = $1', [cid]);
  if (!c.rows.length) throw new Error('Campaign not found');
  const camp = c.rows[0];
  camp.agents = await _hydrateAgents(cid);
  return camp;
}

// ----------------------------------------------------------------
// API: create / update (upsert) — admin-only
// ----------------------------------------------------------------

async function api_campaigns_save(token, payload) {
  await _requireAdmin(token);
  const p = payload || {};

  const name              = String(p.name || '').trim();
  const pipeline          = p.pipeline ? String(p.pipeline).trim() : null;
  const managerUserId     = p.manager_user_id ? Number(p.manager_user_id) : null;
  const distributionMode  = String(p.distribution_mode || 'on_demand');
  const pullBatch         = Math.max(1, Math.min(500, Number(p.pull_batch_size      || 10)));
  const pullInitial       = Math.max(1, Math.min(500, Number(p.pull_initial_count   || 10)));
  const pullRequireOld    = p.pull_require_old_updated ? 1 : 0;
  const pullThresholdMin  = Math.max(0, Math.min(60 * 24 * 30,
                              Number(p.pull_old_threshold_minutes || 60)));
  const removedAction     = String(p.removed_user_action || 'pool');
  const conditionalRules  = p.conditional_rules == null
                              ? null
                              : (typeof p.conditional_rules === 'string'
                                  ? p.conditional_rules
                                  : JSON.stringify(p.conditional_rules));
  // Lead-match filter: rules a lead must satisfy to auto-join this
  // campaign. Stored as JSONB array of { field, op, value }.
  const matchFilter       = p.match_filter == null
                              ? null
                              : (typeof p.match_filter === 'string'
                                  ? p.match_filter
                                  : JSON.stringify(p.match_filter));
  const isActive          = p.is_active == null ? 1 : (p.is_active ? 1 : 0);

  await _ensureMatchFilterColumn();

  if (!name)                                 throw new Error('Campaign name required.');
  if (!VALID_MODES.includes(distributionMode))
    throw new Error('Invalid distribution_mode. Must be one of: ' + VALID_MODES.join(', '));
  if (!VALID_REMOVED.includes(removedAction))
    throw new Error('Invalid removed_user_action. Must be one of: ' + VALID_REMOVED.join(', '));

  if (managerUserId && !(await _userExists(managerUserId)))
    throw new Error('Manager user does not exist or is inactive.');

  const agents = _normaliseAgents(p.agents, distributionMode);

  // Validate every agent is a real, active user.
  for (const a of agents) {
    if (!(await _userExists(a.user_id)))
      throw new Error(`Agent user_id ${a.user_id} does not exist or is inactive.`);
  }

  const isUpdate = !!Number(p.id);
  let campaignId;
  if (isUpdate) {
    campaignId = Number(p.id);
    const u = await db.query(
      `UPDATE campaigns SET
         name=$1, pipeline=$2, manager_user_id=$3, distribution_mode=$4,
         pull_batch_size=$5, pull_initial_count=$6,
         pull_require_old_updated=$7, pull_old_threshold_minutes=$8,
         removed_user_action=$9, conditional_rules=$10, is_active=$11,
         match_filter=$13,
         updated_at=NOW()
       WHERE id=$12 RETURNING id`,
      [name, pipeline, managerUserId, distributionMode,
       pullBatch, pullInitial, pullRequireOld, pullThresholdMin,
       removedAction, conditionalRules, isActive, campaignId, matchFilter]
    );
    if (!u.rows.length) throw new Error('Campaign not found for update.');
  } else {
    const i = await db.query(
      `INSERT INTO campaigns
         (name, pipeline, manager_user_id, distribution_mode,
          pull_batch_size, pull_initial_count,
          pull_require_old_updated, pull_old_threshold_minutes,
          removed_user_action, conditional_rules, is_active, match_filter)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id`,
      [name, pipeline, managerUserId, distributionMode,
       pullBatch, pullInitial, pullRequireOld, pullThresholdMin,
       removedAction, conditionalRules, isActive, matchFilter]
    );
    campaignId = i.rows[0].id;
  }

  // Replace the agent list. If we move to incremental edits later we
  // can diff & apply removed_user_action; for Phase 1, full replace
  // is the simplest correct behaviour.
  let _removedAgentIds = [];
  let _removalSummary = null;
  if (isUpdate) {
    // Capture which agents got removed from the live list so we can
    // apply the campaign's removed_user_action AFTER we deactivate
    // their campaign_agents rows.
    const stillIn = new Set(agents.map(a => Number(a.user_id)));
    const before = await db.query(
      `SELECT user_id FROM campaign_agents
        WHERE campaign_id = $1 AND is_active = 1`,
      [campaignId]
    );
    _removedAgentIds = before.rows
      .map(r => Number(r.user_id))
      .filter(uid => !stillIn.has(uid));
    await db.query(
      `UPDATE campaign_agents SET is_active = 0
        WHERE campaign_id = $1
          AND user_id NOT IN (${agents.length ? agents.map((_, i) => '$' + (i + 2)).join(',') : 'NULL'})`,
      [campaignId, ...agents.map(a => a.user_id)]
    );
  }
  for (const a of agents) {
    await db.query(
      `INSERT INTO campaign_agents (campaign_id, user_id, weight_pct, is_active)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (campaign_id, user_id) DO UPDATE
          SET weight_pct = EXCLUDED.weight_pct,
              is_active  = 1`,
      [campaignId, a.user_id, a.weight_pct]
    );
  }

  // Phase 3: apply removed_user_action to every lead the dropped agents
  // were owning inside this campaign. Best-effort — a removal failure
  // shouldn't roll back the agent-list update we just committed.
  if (_removedAgentIds.length) {
    try {
      _removalSummary = await applyRemovalPolicy(campaignId, _removedAgentIds);
    } catch (e) {
      console.warn('[campaigns] removal policy failed:', e.message);
      _removalSummary = { action: null, affected: 0, error: e.message };
    }
  }

  const fresh = await api_campaigns_get(token, campaignId);
  if (_removalSummary) fresh._removal = _removalSummary;
  return fresh;
}

// Convenience: explicit "rebalance now" trigger for when an admin
// changes a lead's campaign_id outside the agent-edit flow. Reuses
// the same removal policy infrastructure so the behaviour is identical.
async function api_campaigns_applyRemoval(token, campaignId, userIds) {
  await _requireAdmin(token);
  return applyRemovalPolicy(Number(campaignId), Array.isArray(userIds) ? userIds : []);
}

// ----------------------------------------------------------------
// API: pause / resume — admin-only
// ----------------------------------------------------------------

async function api_campaigns_pause(token, id, paused) {
  await _requireAdmin(token);
  const cid = Number(id);
  if (!cid) throw new Error('Campaign id required');
  const next = paused ? 0 : 1;
  await db.query('UPDATE campaigns SET is_active = $1, updated_at = NOW() WHERE id = $2', [next, cid]);
  return { ok: true, id: cid, is_active: next };
}

// ----------------------------------------------------------------
// API: delete — admin-only
// ----------------------------------------------------------------
// Soft-deletes (is_active = 0) when leads still reference the
// campaign so historical reports stay intact. Hard-deletes when no
// leads are attached so the row doesn't linger.

async function api_campaigns_delete(token, id) {
  await _requireAdmin(token);
  const cid = Number(id);
  if (!cid) throw new Error('Campaign id required');
  const used = await db.query('SELECT 1 FROM leads WHERE campaign_id = $1 LIMIT 1', [cid]);
  if (used.rows.length) {
    await db.query('UPDATE campaigns SET is_active = 0, updated_at = NOW() WHERE id = $1', [cid]);
    return { ok: true, id: cid, soft_deleted: true };
  }
  await db.query('DELETE FROM campaigns WHERE id = $1', [cid]);
  return { ok: true, id: cid, soft_deleted: false };
}

module.exports = {
  api_campaigns_list,
  api_campaigns_get,
  api_campaigns_save,
  api_campaigns_pause,
  api_campaigns_delete,
  api_campaigns_applyRemoval,
};
