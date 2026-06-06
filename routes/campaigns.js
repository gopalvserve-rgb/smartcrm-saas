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
/* CAMPAIGN_REPORT_v2_FIX6 (2026-06-04) — column-existence guard.
 * Some tenants don't have leads.remark (column was added later as part of
 * activity tracking). Cache the result of an information_schema lookup so
 * we can conditionally include "contacted" in the campaign report KPI
 * without per-request overhead. */
let _LEADS_HAS_REMARK = null;
async function _leadsHasRemark() {
  if (_LEADS_HAS_REMARK !== null) return _LEADS_HAS_REMARK;
  try {
    const r = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='leads' AND column_name='remark' LIMIT 1`);
    _LEADS_HAS_REMARK = r.rows.length > 0;
  } catch (_) { _LEADS_HAS_REMARK = false; }
  return _LEADS_HAS_REMARK;
}

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

// CAMPAIGN_APPLY_MODE_SCHEMA_HEAL_v1 — pre-existing tenants don't have
// apply_mode / backfill_filters / last_backfilled_at yet (added 2026-05-30).
// Heal defensively on first call so the SELECT doesn't blow up with
// "column c.apply_mode does not exist" on older tenants like smcbroking.
let _applyModeEnsured = false;
async function _ensureApplyModeColumns() {
  if (_applyModeEnsured) return;
  try {
    await db.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS apply_mode      TEXT  DEFAULT 'future'`);
    await db.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS backfill_filters JSONB`);
    await db.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_backfilled_at TIMESTAMP`);
    _applyModeEnsured = true;
  } catch (e) {
    console.warn('[campaigns] apply_mode column ensure failed:', e.message);
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
  await _ensureApplyModeColumns();
  const r = await db.query(`
    SELECT c.id, c.name, c.pipeline, c.manager_user_id, c.distribution_mode, c.auto_share_user_id,
           c.pull_batch_size, c.pull_initial_count,
           c.pull_require_old_updated, c.pull_old_threshold_minutes,
           c.removed_user_action, c.is_active,
           c.apply_mode, c.backfill_filters, c.last_backfilled_at,  /* CAMPAIGN_ATTACH_PERSIST_v1 */
           c.created_at, c.updated_at,
           mu.name  AS manager_name,
           mu.email AS manager_email,
           (SELECT COUNT(*) FROM campaign_agents ca
              WHERE ca.campaign_id = c.id AND ca.is_active = 1) AS agent_count,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id) AS lead_count,
           /* CAMPAIGN_LEAD_BREAKDOWN_v3 — Pullable column matches the EXACT
              gates the pull SQL uses, so admin can see at a glance whether
              leads are actually pull-eligible or filtered out by duplicate/
              hidden/final flags. Free is the raw unassigned count for context. */
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id
                AND l.assigned_to IS NULL
            ) AS leads_unassigned,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id
                AND l.assigned_to IS NOT NULL
            ) AS leads_assigned,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id
                AND l.status_id IN (SELECT id FROM statuses WHERE COALESCE(is_final, 0) = 1)
            ) AS leads_final,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id
                AND COALESCE(l.is_hidden, 0) = 1
            ) AS leads_hidden,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id
                AND COALESCE(l.is_duplicate, 0) = 1
            ) AS leads_duplicate,
           /* leads_pullable = exact match of pull SQL (PULL_NODUP_v1).
              Duplicate gate dropped — Pull no longer excludes is_duplicate=1
              so this count must not either, otherwise admin sees mismatch. */
           (SELECT COUNT(*) FROM leads l
              LEFT JOIN statuses s ON s.id = l.status_id
              WHERE l.campaign_id = c.id
                AND l.assigned_to IS NULL
                AND COALESCE(l.is_hidden, 0) = 0
                AND COALESCE(s.is_final, 0) = 0
            ) AS leads_pullable
      FROM campaigns c
      LEFT JOIN users mu ON mu.id = c.manager_user_id
     ORDER BY c.is_active DESC, c.created_at DESC
  `);
  return r.rows;
}

async function api_campaigns_get(token, id) {
  await authUser(token);
  await _ensureApplyModeColumns();
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
  // SHARE_LEAD_v1: per-campaign auto-share. Null clears.
  const autoShareUid = p.auto_share_user_id == null || p.auto_share_user_id === '' ? null : Number(p.auto_share_user_id) || null;
  // Lead-match filter: rules a lead must satisfy to auto-join this
  // campaign. Stored as JSONB array of { field, op, value }.
  const matchFilter       = p.match_filter == null
                              ? null
                              : (typeof p.match_filter === 'string'
                                  ? p.match_filter
                                  : JSON.stringify(p.match_filter));
  const isActive          = p.is_active == null ? 1 : (p.is_active ? 1 : 0);

  await _ensureMatchFilterColumn();
  await _ensureApplyModeColumns();

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

  // CAMPAIGN_ATTACH_PERSIST_v1.1 — persist apply_mode + backfill_filters on UPDATE too
  const applyMode = (p.apply_mode === 'existing' || p.apply_mode === 'both') ? p.apply_mode : 'future';
  const backfillFilters = p.backfill_filters == null
    ? null
    : (typeof p.backfill_filters === 'string' ? p.backfill_filters : JSON.stringify(p.backfill_filters));

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
         auto_share_user_id=$14,
         apply_mode=$15,
         backfill_filters=$16,
         updated_at=NOW()
       WHERE id=$12 RETURNING id`,
      [name, pipeline, managerUserId, distributionMode,
       pullBatch, pullInitial, pullRequireOld, pullThresholdMin,
       removedAction, conditionalRules, isActive, campaignId, matchFilter,
       autoShareUid, applyMode, backfillFilters]
    );
    if (!u.rows.length) throw new Error('Campaign not found for update.');
  } else {
    const i = await db.query(
      `INSERT INTO campaigns
         (name, pipeline, manager_user_id, distribution_mode,
          pull_batch_size, pull_initial_count,
          pull_require_old_updated, pull_old_threshold_minutes,
          removed_user_action, conditional_rules, is_active, match_filter,
          auto_share_user_id, apply_mode, backfill_filters)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING id`,
      [name, pipeline, managerUserId, distributionMode,
       pullBatch, pullInitial, pullRequireOld, pullThresholdMin,
       removedAction, conditionalRules, isActive, matchFilter,
       autoShareUid, applyMode, backfillFilters]
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


// CAMPAIGN_ATTACH_EXISTING_v1 — backfill existing leads into a campaign.
// Admin-only. Takes campaign_id + a filter object. Filter supports:
//   match_mode: 'and' | 'or'   (default 'and')
//   assigned_to: [<user id>, ..., 'unassigned']    (NULL means unassigned)
//   status_id:   [<status id>, ...]
//   source:      ['manual', 'facebook', ...]       (case-insensitive)
//   also_unassign: bool  (when true, also sets assigned_to = NULL)
// payload.preview === true returns just the match count (no writes).
// Without preview, it actually attaches the leads.
async function api_campaigns_attachExisting(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  payload = payload || {};
  const campaignId = Number(payload.campaign_id);
  if (!campaignId) throw new Error('campaign_id required');
  const filters = payload.filters || {};
  const matchMode = String(filters.match_mode || 'and').toLowerCase() === 'or' ? 'OR' : 'AND';
  const alsoUnassign = !!filters.also_unassign;
  const preview = !!payload.preview;

  // Confirm the campaign exists & belongs to this tenant
  const cr = await db.query('SELECT id, name FROM campaigns WHERE id = $1 LIMIT 1', [campaignId]);
  if (!cr.rowCount) throw new Error('Campaign not found');

  // Build WHERE clauses + params.
  // $1 is always the campaign_id (used only in the UPDATE, not in WHERE).
  const conditions = [];
  const params = [campaignId];
  let pi = 2;

  // assigned_to: split into "specific user IDs" + "include unassigned"
  if (Array.isArray(filters.assigned_to) && filters.assigned_to.length) {
    const wantsUnassigned = filters.assigned_to.some(v =>
      v === null || v === 'unassigned' || String(v).toLowerCase() === 'unassigned'
    );
    const userIds = filters.assigned_to
      .filter(v => v !== null && v !== 'unassigned' && String(v).toLowerCase() !== 'unassigned')
      .map(Number).filter(n => Number.isFinite(n) && n > 0);
    const sub = [];
    if (userIds.length) {
      sub.push('l.assigned_to = ANY($' + pi + '::int[])');
      params.push(userIds);
      pi++;
    }
    if (wantsUnassigned) sub.push('l.assigned_to IS NULL');
    if (sub.length) conditions.push('(' + sub.join(' OR ') + ')');
  }

  // status_id: simple ANY()
  if (Array.isArray(filters.status_id) && filters.status_id.length) {
    const statusIds = filters.status_id.map(Number).filter(n => Number.isFinite(n) && n > 0);
    if (statusIds.length) {
      conditions.push('l.status_id = ANY($' + pi + '::int[])');
      params.push(statusIds);
      pi++;
    }
  }

  // source: case-insensitive ANY()
  if (Array.isArray(filters.source) && filters.source.length) {
    const sources = filters.source
      .map(v => String(v || '').trim().toLowerCase())
      .filter(Boolean);
    if (sources.length) {
      conditions.push('LOWER(COALESCE(l.source, \'\')) = ANY($' + pi + '::text[])');
      params.push(sources);
      pi++;
    }
  }

  if (!conditions.length) {
    throw new Error('Pick at least one condition (Assigned user, Status, or Source)');
  }

  // Always exclude leads already attached to this campaign so the count is
  // honest and the UPDATE does no-op writes.
  conditions.push('(l.campaign_id IS NULL OR l.campaign_id <> $1)');

  const whereClause = conditions.join(' ' + matchMode + ' ');

  if (preview) {
    // Preview path: COUNT only.
    const r = await db.query(
      'SELECT COUNT(*)::int AS n FROM leads l WHERE ' + whereClause,
      params
    );
    return { count: Number((r.rows[0] || {}).n || 0), campaign_id: campaignId };
  }

  // Apply path: UPDATE. Optionally also clears assigned_to.
  const setParts = ['campaign_id = $1', 'updated_at = NOW()'];
  if (alsoUnassign) setParts.push('assigned_to = NULL');

  const r = await db.query(
    'UPDATE leads l SET ' + setParts.join(', ') +
    ' WHERE ' + whereClause +
    ' RETURNING id',
    params
  );
  return {
    attached: r.rowCount || 0,
    campaign_id: campaignId,
    also_unassigned: alsoUnassign,
    match_mode: matchMode.toLowerCase()
  };
}


// CAMPAIGN_PULL_DIAG_v1 — admin-only "why can't this user pull?" inspector.
// Takes { user_id, campaign_id } and walks every gate of the pull SQL,
// reporting how many leads survive each step. Returns a clear JSON so
// the admin (or support engineer) can see in one glance which gate
// is the blocker — no DevTools acrobatics needed.
async function api_campaigns_pullDiagnostic(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  payload = payload || {};
  const uid = Number(payload.user_id);
  const cid = Number(payload.campaign_id);
  if (!uid) throw new Error('user_id required');
  if (!cid) throw new Error('campaign_id required');

  // The user
  const ur = await db.query('SELECT id, name, email, role, COALESCE(is_active,1) AS is_active, COALESCE(is_paused,0) AS is_paused FROM users WHERE id = $1', [uid]);
  if (!ur.rowCount) return { ok: false, error: 'user not found', user_id: uid };
  const user = ur.rows[0];

  // The campaign
  const cr = await db.query('SELECT id, name, distribution_mode, COALESCE(is_active,1) AS is_active, pull_batch_size, pull_initial_count, pull_require_old_updated, pull_old_threshold_minutes FROM campaigns WHERE id = $1', [cid]);
  if (!cr.rowCount) return { ok: false, error: 'campaign not found', campaign_id: cid };
  const campaign = cr.rows[0];

  // Is the user an active agent on this campaign?
  const ar = await db.query('SELECT user_id, weight_pct, COALESCE(is_active,1) AS is_active FROM campaign_agents WHERE campaign_id = $1 AND user_id = $2', [cid, uid]);
  const agent_row = ar.rows[0] || null;

  // Funnel: count of leads at each gate. We replicate the exact WHERE
  // of api_leads_pull so the diagnostic matches reality 1:1.
  const counts = {};
  // Step 0 — leads on this campaign
  counts.step0_in_campaign = Number((await db.query('SELECT COUNT(*)::int AS n FROM leads WHERE campaign_id = $1', [cid])).rows[0].n);
  // Step 1 — + unassigned OR assigned to this user
  counts.step1_unassigned_or_mine = Number((await db.query(
    'SELECT COUNT(*)::int AS n FROM leads WHERE campaign_id = $1 AND (assigned_to IS NULL OR assigned_to = $2)',
    [cid, uid]
  )).rows[0].n);
  // Step 2 — + status not final
  counts.step2_status_not_final = Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE l.campaign_id = $1
        AND (l.assigned_to IS NULL OR l.assigned_to = $2)
        AND COALESCE(s.is_final, 0) = 0`,
    [cid, uid]
  )).rows[0].n);
  // Step 3 — + not duplicate
  counts.step3_not_duplicate = Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE l.campaign_id = $1
        AND (l.assigned_to IS NULL OR l.assigned_to = $2)
        AND COALESCE(s.is_final, 0) = 0
        AND COALESCE(l.is_duplicate, 0) = 0`,
    [cid, uid]
  )).rows[0].n);
  // Step 4 — + not hidden
  counts.step4_not_hidden = Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE l.campaign_id = $1
        AND (l.assigned_to IS NULL OR l.assigned_to = $2)
        AND COALESCE(s.is_final, 0) = 0
        AND COALESCE(l.is_duplicate, 0) = 0
        AND COALESCE(l.is_hidden, 0) = 0`,
    [cid, uid]
  )).rows[0].n);
  // Step 5 — + not already pulled by this user
  counts.step5_not_already_pulled = Number((await db.query(
    `SELECT COUNT(*)::int AS n FROM leads l
       LEFT JOIN lead_pull_log p ON p.lead_id = l.id AND p.user_id = $2
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE l.campaign_id = $1
        AND p.id IS NULL
        AND (l.assigned_to IS NULL OR l.assigned_to = $2)
        AND COALESCE(s.is_final, 0) = 0
        AND COALESCE(l.is_duplicate, 0) = 0
        AND COALESCE(l.is_hidden, 0) = 0`,
    [cid, uid]
  )).rows[0].n);

  // Assignee breakdown — who owns the leads tagged to this campaign?
  let assignee_breakdown = [];
  try {
    const r = await db.query(
      `SELECT COALESCE(u.name, '<<unassigned>>') AS owner, COUNT(l.*)::int AS n
         FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.campaign_id = $1
        GROUP BY u.name ORDER BY n DESC LIMIT 20`, [cid]);
    assignee_breakdown = r.rows;
  } catch (_) {}

  // Status breakdown
  let status_breakdown = [];
  try {
    const r = await db.query(
      `SELECT COALESCE(s.name, '<<no status>>') AS status, COALESCE(s.is_final,0) AS is_final, COUNT(l.*)::int AS n
         FROM leads l LEFT JOIN statuses s ON s.id = l.status_id
        WHERE l.campaign_id = $1
        GROUP BY s.name, s.is_final ORDER BY n DESC LIMIT 20`, [cid]);
    status_breakdown = r.rows;
  } catch (_) {}

  // Pull config
  let pull_cfg = null;
  try {
    const r = await db.query(
      "SELECT key, value FROM config WHERE key IN ('LEAD_PULL_ENABLED','LEAD_PULL_ENABLED_ROLES','LEAD_PULL_INITIAL_COUNT','LEAD_PULL_SUBSEQUENT_COUNT')"
    );
    pull_cfg = {};
    r.rows.forEach(row => { pull_cfg[row.key] = row.value; });
  } catch (_) {}

  // Verdict
  let verdict;
  if (!agent_row || Number(agent_row.is_active) !== 1) {
    verdict = 'User is NOT an active agent on this campaign — add them in the campaign editor.';
  } else if (Number(campaign.is_active) !== 1) {
    verdict = 'Campaign is paused — un-pause it.';
  } else if (Number(user.is_paused) === 1) {
    verdict = 'User is paused — un-pause them in Users tab.';
  } else if (counts.step5_not_already_pulled > 0) {
    verdict = 'Pull SHOULD return ' + counts.step5_not_already_pulled + ' leads. If the user still sees 0, check role allow-list and stale-lead block.';
  } else if (counts.step4_not_hidden > 0 && counts.step5_not_already_pulled === 0) {
    verdict = 'All ' + counts.step4_not_hidden + ' eligible leads have already been pulled by this user before.';
  } else if (counts.step3_not_duplicate > 0 && counts.step4_not_hidden === 0) {
    verdict = 'All eligible leads have is_hidden = 1.';
  } else if (counts.step2_status_not_final > 0 && counts.step3_not_duplicate === 0) {
    verdict = 'All eligible leads are flagged as duplicates.';
  } else if (counts.step1_unassigned_or_mine > 0 && counts.step2_status_not_final === 0) {
    verdict = 'All leads in the campaign are in a FINAL status (Won/Lost/Junk/Cancelled).';
  } else if (counts.step0_in_campaign > 0 && counts.step1_unassigned_or_mine === 0) {
    verdict = 'All ' + counts.step0_in_campaign + ' leads in this campaign are ASSIGNED to someone other than this user. Bulk-unassign them first.';
  } else if (counts.step0_in_campaign === 0) {
    verdict = 'No leads have campaign_id = this campaign at all. The attach-existing or auto-attach rule did not write campaign_id on any lead.';
  } else {
    verdict = 'Unknown — share this whole payload with engineering.';
  }

  return {
    ok: true,
    user, campaign,
    agent_row,
    pull_cfg,
    counts,
    assignee_breakdown,
    status_breakdown,
    verdict
  };
}


/* ============================================================
 * CAMPAIGN_RESET_v1 (2026-06-01)
 *
 * Admin button on each campaign row. Use case:
 *   500 leads in a campaign → team called them → 10 reached
 *   final status, 490 still in-play. The 490 are stuck on the
 *   agents they were originally assigned to + already in the
 *   lead_pull_log for those agents (so they wouldn't be re-pulled
 *   even after un-assign). One click puts them back in the free
 *   pool ready for the next Start-Calling pull.
 *
 * What it does for every lead in the campaign WHERE the status
 * is NOT is_final=1 (or has no status):
 *   • assigned_to = NULL  → goes back to "free / unassigned"
 *   • is_hidden    = 0    → eligible for pull
 *   • DELETE FROM lead_pull_log WHERE lead_id = …  →
 *     every previous puller can pull it again
 *
 * Leads keep their campaign_id so the next pull of the campaign
 * picks them up exactly as if they were fresh.
 *
 * Status of "final" follows the standard statuses.is_final flag
 * (Junk / Won / Lost / etc.).
 * ============================================================ */
async function api_campaigns_resetUnclosed(token, campaignId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cid = Number(campaignId);
  if (!cid) throw new Error('campaign_id required');

  // Make sure the campaign exists in this tenant.
  const c = await db.query('SELECT id, name FROM campaigns WHERE id = $1', [cid]);
  if (!c.rows.length) throw new Error('Campaign not found');

  // 1) Find the lead IDs we'll reset (so we can log the count + scope the pull-log delete).
  const cand = await db.query(
    `SELECT l.id
       FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE l.campaign_id = $1
        AND COALESCE(s.is_final, 0) = 0`,
    [cid]
  );
  const ids = cand.rows.map(r => Number(r.id));
  if (!ids.length) {
    return { ok: true, reset_count: 0, campaign_id: cid, campaign_name: c.rows[0].name };
  }

  // 2) Wipe assignment + un-hide + bump updated_at in a transaction.
  // Use the tenant-scoped pool so multi-tenant isolation holds.
  const pool = (function () {
    try { const st = db.tenantStorage && db.tenantStorage.getStore(); if (st && st.pool) return st.pool; } catch (_) {}
    return db.pool;
  })();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE leads
          SET assigned_to = NULL,
              is_hidden   = 0,
              updated_at  = NOW()
        WHERE id = ANY($1::int[])`,
      [ids]
    );
    // 3) Drop every previous-puller record so they can re-pull these leads.
    await client.query(
      `DELETE FROM lead_pull_log WHERE lead_id = ANY($1::int[])`,
      [ids]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return {
    ok: true,
    reset_count: ids.length,
    campaign_id: cid,
    campaign_name: c.rows[0].name
  };
}



/* ============================================================
 * CAMPAIGN_UPLOAD_v1 (2026-06-04) — per-campaign CSV upload with
 * client-supplied row array, server-side dup preview/scan, and
 * optional skip-or-add-duplicates policy. The upload reuses the
 * existing api_leads_bulkCreate path (so campaign distribution
 * rules fire), but pre-stamps campaign_id on every row and forces
 * assigned_to='' so the campaign engine routes leads per its
 * distribution_mode (not the CSV row).
 *
 * Modes:
 *   payload.preview = true   — parse + dup-scan only, no insert
 *   payload.preview = false  — perform the insert with the chosen
 *                              duplicate_policy ('skip' | 'add')
 *
 * Duplicate handling is intentionally NOT delegated to the tenant's
 * global DUPLICATE_POLICY config; this upload always honours the
 * user's choice from the modal regardless of the tenant default.
 * _findDuplicate in routes/leads.js respects a __skipDupCheck flag
 * on each row so we can safely add dupes without the global policy
 * re-rejecting them.
 * ============================================================ */
async function api_campaigns_uploadLeads(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) {
    throw new Error('Admin / manager / team-leader only');
  }
  const p = payload || {};
  const campaignId = Number(p.campaign_id);
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const policy = String(p.duplicate_policy || 'skip').toLowerCase();
  const preview = p.preview === true;

  if (!campaignId) throw new Error('campaign_id is required');
  if (!rows.length) throw new Error('No rows to upload');
  if (!['skip', 'add'].includes(policy)) {
    throw new Error("duplicate_policy must be 'skip' or 'add'");
  }
  await _ensureApplyModeColumns();

  // Verify campaign exists & is active.
  const camp = await db.query(`SELECT id, name, is_active FROM campaigns WHERE id = $1`, [campaignId]);
  if (!camp.rows[0]) throw new Error('Campaign not found');

  // Build the (phone-digits, email-lower) lookup sets from existing leads
  // — one query, no per-row round-trip. Big tenants stay sub-second.
  const dupSet = new Map();   // phoneDigits -> existing lead id
  const dupEmailSet = new Map(); // emailLower -> existing lead id
  try {
    const r = await db.query(`SELECT id, phone, whatsapp, email FROM leads`);
    for (const row of r.rows) {
      const ph = String(row.phone || '').replace(/\D/g, '');
      const wa = String(row.whatsapp || '').replace(/\D/g, '');
      const em = String(row.email || '').trim().toLowerCase();
      if (ph) dupSet.set(ph, row.id);
      if (wa && wa !== ph) dupSet.set(wa, row.id);
      if (em) dupEmailSet.set(em, row.id);
    }
  } catch (_) {}

  // Walk rows once: count parse errors + dup matches + tag each row
  // with _dupeOfId for the later confirm step.
  const tagged = [];
  let dupes = 0, parseErrors = 0;
  const dupSamples = [];
  for (let i = 0; i < rows.length; i++) {
    const r = Object.assign({}, rows[i] || {});
    const phone = String(r.phone || r.mobile || r.whatsapp || '').replace(/\D/g, '');
    const email = String(r.email || '').trim().toLowerCase();
    if (!phone && !email && !String(r.name || '').trim()) {
      parseErrors++;
      tagged.push({ row: r, dupOfId: null, error: 'row has no phone/email/name' });
      continue;
    }
    let dupOfId = null;
    if (phone && dupSet.has(phone))  dupOfId = dupSet.get(phone);
    else if (email && dupEmailSet.has(email)) dupOfId = dupEmailSet.get(email);
    if (dupOfId) {
      dupes++;
      if (dupSamples.length < 5) {
        dupSamples.push({ name: r.name || '(no name)', phone: phone, email: email, existing_lead_id: dupOfId });
      }
    }
    tagged.push({ row: r, dupOfId, error: null });
  }

  if (preview) {
    return {
      ok: true,
      total: rows.length,
      duplicates: dupes,
      parse_errors: parseErrors,
      valid: rows.length - parseErrors,
      dup_samples: dupSamples,
      campaign_name: camp.rows[0].name
    };
  }

  // Confirm path — build the rows we will actually insert.
  const toInsert = [];
  let skipped = 0;
  for (const t of tagged) {
    if (t.error) { skipped++; continue; }
    if (t.dupOfId && policy === 'skip') { skipped++; continue; }
    // Stamp campaign + force-blank assigned_to so the campaign distribution
    // engine (api_leads_create hook) decides ownership per the rule.
    const r = Object.assign({}, t.row, {
      campaign_id: campaignId,
      assigned_to: '',
      __skipDupCheck: true   /* honoured by _findDuplicate in routes/leads.js */
    });
    // When adding dupes, mark them so they're visible in the dedupe UI.
    if (t.dupOfId && policy === 'add') {
      r.is_duplicate = 1;
      r.duplicate_of = t.dupOfId;
    }
    toInsert.push(r);
  }

  // Reuse api_leads_bulkCreate with assignment.mode='csv' so each row's
  // assigned_to='' is respected and the campaign engine routes leads.
  const leads = require('./leads');
  const result = await leads.api_leads_bulkCreate(token, toInsert, { mode: 'csv' });

  return {
    ok: true,
    campaign_id: campaignId,
    campaign_name: camp.rows[0].name,
    total: rows.length,
    parse_errors: parseErrors,
    duplicates_detected: dupes,
    duplicate_policy: policy,
    skipped_duplicates: policy === 'skip' ? dupes : 0,
    skipped_errors: parseErrors,
    created: result.created || 0,
    bulk_errors: (result.errors || []).slice(0, 10),
    bulk_skipped: result.skipped || 0,
    assigned_counts: result.assignedCounts || {}
  };
}



/* ============================================================
 * CAMPAIGN_REPORT_v1 (2026-06-04) — reporting APIs
 *
 *   api_campaigns_report(token, { campaign_id, from, to })
 *     -> per-campaign: KPIs + funnel + status-wise + user-wise
 *        + source/product breakdown + daily inflow.
 *
 *   api_campaigns_reportAll(token, { from, to })
 *     -> all-campaigns comparison: one row per campaign with
 *        Total / Final / Won / Lost / Conv% / TAT.
 *
 * Final-status detection re-uses the same convention the
 * Campaigns list uses (statuses table.is_final = 1, fallback to
 * lowercased name matching Won/Lost/Closed/Junk/etc.).
 * ============================================================ */
function _normalizeDateRange(p) {
  const r = {};
  if (p && p.from) r.from = String(p.from).slice(0, 10);
  if (p && p.to)   r.to   = String(p.to).slice(0, 10);
  return r;
}

async function _finalStatusIdSet() {
  try {
    const r = await db.query(
      `SELECT id, name, COALESCE(is_final, 0) AS is_final FROM statuses`);
    const ids = new Set();
    const WONNAMES  = ['won','closed won','converted','admission done','booked'];
    const LOSTNAMES = ['lost','closed lost','junk','dropped','not interested'];
    for (const s of r.rows) {
      const n = String(s.name || '').trim().toLowerCase();
      if (Number(s.is_final) === 1 || WONNAMES.includes(n) || LOSTNAMES.includes(n)) {
        // CAMPAIGN_REPORT_v2_FIX_v1: store as STRING so the safe text-side
        // comparison in SQL matches. leads.status_id is TEXT on most tenants.
        ids.add(String(s.id));
      }
    }
    return ids;
  } catch (_) { return new Set(); }
}

async function _wonLostNames() {
  try {
    const r = await db.query(`SELECT id, name FROM statuses`);
    const won = new Set(), lost = new Set();
    for (const s of r.rows) {
      const n = String(s.name || '').trim().toLowerCase();
      // CAMPAIGN_REPORT_v2_FIX_v1: store as STRING for text-safe SQL match
      if (['won','closed won','converted','admission done','booked'].includes(n)) won.add(String(s.id));
      if (['lost','closed lost','junk','dropped','not interested'].includes(n))   lost.add(String(s.id));
    }
    return { won, lost };
  } catch (_) { return { won: new Set(), lost: new Set() }; }
}

async function api_campaigns_report(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const campaignId = Number(p.campaign_id);
  if (!campaignId) throw new Error('campaign_id is required');
  const dr = _normalizeDateRange(p);

  // Fetch campaign meta.
  const camp = await db.query(`SELECT id, name, is_active FROM campaigns WHERE id = $1`, [campaignId]);
  if (!camp.rows[0]) throw new Error('Campaign not found');

  const dateClause = (() => {
    const parts = ['campaign_id = $1'];
    const params = [campaignId];
    if (dr.from) { params.push(dr.from); parts.push(`created_at >= $${params.length}::date`); }
    if (dr.to)   { params.push(dr.to);   parts.push(`created_at <  ($${params.length}::date + INTERVAL '1 day')`); }
    return { sql: parts.join(' AND '), params };
  })();

  const finalIds = await _finalStatusIdSet();
  const { won: wonIds, lost: lostIds } = await _wonLostNames();
  const finalArr = Array.from(finalIds);
  const wonArr   = Array.from(wonIds);
  const lostArr  = Array.from(lostIds);

  // ---- KPIs ----
  const kpiRow = await db.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE assigned_to IS NULL OR NULLIF(assigned_to::text, '') IS NULL OR assigned_to::text = '0')::int AS unassigned,
        COUNT(*) FILTER (WHERE assigned_to IS NOT NULL AND NULLIF(assigned_to::text, '') IS NOT NULL AND assigned_to::text <> '0')::int AS assigned,
        COUNT(*) FILTER (WHERE NULLIF(status_id::text, '') = ANY($${dateClause.params.length + 1}::text[]))::int AS final_cnt,
        COUNT(*) FILTER (WHERE NULLIF(status_id::text, '') = ANY($${dateClause.params.length + 2}::text[]))::int AS won_cnt,
        COUNT(*) FILTER (WHERE NULLIF(status_id::text, '') = ANY($${dateClause.params.length + 3}::text[]))::int AS lost_cnt,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(is_duplicate::text,''),'0') = '1')::int AS duplicates
     FROM leads WHERE ${dateClause.sql}`,
    dateClause.params.concat([finalArr, wonArr, lostArr])
  );
  const k = kpiRow.rows[0] || {};
  const total = Number(k.total) || 0;
  const won = Number(k.won_cnt) || 0;

  // ---- Status-wise breakdown ----
  const statusRows = await db.query(
    `SELECT COALESCE(s.name, 'Unset') AS status_name,
            l.status_id,
            COUNT(*)::int AS cnt
       FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE ${dateClause.sql}
      GROUP BY s.name, l.status_id
      ORDER BY cnt DESC`,
    dateClause.params
  );

  // ---- User-wise breakdown ----
  let userRows = { rows: [] };
  try {
    userRows = await db.query(
      `SELECT COALESCE(u.full_name, u.username, 'Unassigned') AS user_name,
              l.assigned_to,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${dateClause.params.length + 1}::text[]))::int AS final_cnt,
              COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${dateClause.params.length + 2}::text[]))::int AS won_cnt
         FROM leads l
         LEFT JOIN users u ON u.id::text = l.assigned_to::text
        WHERE ${dateClause.sql}
        GROUP BY u.full_name, u.username, l.assigned_to
        ORDER BY total DESC`,
      dateClause.params.concat([finalArr, wonArr])
    );
  } catch (_) {}

  // ---- Source breakdown ----
  const sourceRows = await db.query(
    `SELECT COALESCE(NULLIF(source, ''), 'Unspecified') AS source,
            COUNT(*)::int AS cnt
       FROM leads WHERE ${dateClause.sql}
       GROUP BY source ORDER BY cnt DESC LIMIT 20`,
    dateClause.params
  );

  // ---- Daily inflow (last 30 days within range, or full range if shorter) ----
  let daily = { rows: [] };
  try {
    daily = await db.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS cnt
         FROM leads WHERE ${dateClause.sql}
         GROUP BY day ORDER BY day ASC LIMIT 60`,
      dateClause.params
    );
  } catch (_) {}

  // ---- Avg TAT (created_at → final-status row's updated_at) — only over final leads ----
  let tatSecs = 0;
  try {
    const tat = await db.query(
      `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))), 0)::bigint AS avg_secs
         FROM leads
        WHERE ${dateClause.sql}
          AND NULLIF(status_id::text, '') = ANY($${dateClause.params.length + 1}::text[])`,
      dateClause.params.concat([finalArr])
    );
    tatSecs = Number(tat.rows[0] && tat.rows[0].avg_secs) || 0;
  } catch (_) {}

  return {
    ok: true,
    campaign_id: campaignId,
    campaign_name: camp.rows[0].name,
    range: dr,
    kpis: {
      total,
      unassigned: Number(k.unassigned) || 0,
      assigned:   Number(k.assigned)   || 0,
      final:      Number(k.final_cnt)  || 0,
      won,
      lost:       Number(k.lost_cnt)   || 0,
      duplicates: Number(k.duplicates) || 0,
      conv_pct:   total > 0 ? Math.round((won / total) * 1000) / 10 : 0,
      avg_tat_secs: tatSecs
    },
    status_rows: statusRows.rows,
    user_rows:   userRows.rows,
    source_rows: sourceRows.rows,
    daily:       daily.rows
  };
}

async function api_campaigns_reportAll(token, payload) {
  const me = await authUser(token);
  const dr = _normalizeDateRange(payload || {});

  const finalIds = await _finalStatusIdSet();
  const { won: wonIds, lost: lostIds } = await _wonLostNames();
  const finalArr = Array.from(finalIds);
  const wonArr   = Array.from(wonIds);
  const lostArr  = Array.from(lostIds);

  const camps = await db.query(`SELECT id, name, is_active FROM campaigns ORDER BY id DESC`);

  const out = [];
  for (const c of camps.rows) {
    const parts = ['campaign_id = $1'];
    const params = [c.id];
    if (dr.from) { params.push(dr.from); parts.push(`created_at >= $${params.length}::date`); }
    if (dr.to)   { params.push(dr.to);   parts.push(`created_at <  ($${params.length}::date + INTERVAL '1 day')`); }

    const r = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE NULLIF(status_id::text, '') = ANY($${params.length + 1}::text[]))::int AS final_cnt,
              COUNT(*) FILTER (WHERE NULLIF(status_id::text, '') = ANY($${params.length + 2}::text[]))::int AS won_cnt,
              COUNT(*) FILTER (WHERE NULLIF(status_id::text, '') = ANY($${params.length + 3}::text[]))::int AS lost_cnt,
              COALESCE(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)))
                       FILTER (WHERE NULLIF(status_id::text, '') = ANY($${params.length + 1}::text[])), 0)::bigint AS avg_tat_secs
         FROM leads WHERE ${parts.join(' AND ')}`,
      params.concat([finalArr, wonArr, lostArr])
    );
    const row = r.rows[0] || {};
    const total = Number(row.total) || 0;
    const won = Number(row.won_cnt) || 0;
    out.push({
      id: c.id,
      name: c.name,
      is_active: Number(c.is_active) === 1,
      total,
      final:    Number(row.final_cnt) || 0,
      won,
      lost:     Number(row.lost_cnt)  || 0,
      conv_pct: total > 0 ? Math.round((won / total) * 1000) / 10 : 0,
      avg_tat_secs: Number(row.avg_tat_secs) || 0
    });
  }
  return { ok: true, range: dr, campaigns: out };
}



/* ============================================================
 * CAMPAIGN_REPORT_v1.1 (2026-06-04) — full Reports page API.
 *   api_campaigns_reportAdvanced(token, {
 *     campaign_ids: [1,2] (optional, null = all),
 *     user_ids: [10,11]   (optional),
 *     products: ['MBA','BBA'] (optional, by lead.product or cf_product),
 *     cf:  { key1: value1, key2: value2 }   (optional, custom-field filters),
 *     from, to                              (date range)
 *   }) -> {
 *     kpis: {...},
 *     funnel: [{ stage, cnt, pct }],
 *     status_rows, user_rows, product_rows, source_rows, campaign_rows,
 *     daily: [{ day, cnt }]
 *   }
 * ============================================================ */
async function api_campaigns_reportAdvanced(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const dr = _normalizeDateRange(p);

  const finalIds = await _finalStatusIdSet();
  const { won: wonIds, lost: lostIds } = await _wonLostNames();
  const finalArr = Array.from(finalIds);
  const wonArr   = Array.from(wonIds);
  const lostArr  = Array.from(lostIds);

  // Build WHERE clause + params dynamically.
  // CAMPAIGN_REPORT_CREATED_AT_AMBIG_FIX_v1 (2026-06-06) — every column
  // in the shared WHERE clause is now aliased with `l.` so the same W
  // can be reused across sub-queries that JOIN users/campaigns (both
  // of which ALSO have a created_at column). Every sub-query below now
  // uses `FROM leads l` consistently.
  const where = [];
  const params = [];
  where.push(`(l.campaign_id IS NOT NULL AND NULLIF(l.campaign_id::text, '') IS NOT NULL AND l.campaign_id::text <> '0')`);
  if (Array.isArray(p.campaign_ids) && p.campaign_ids.length) {
    params.push(p.campaign_ids.map(String).filter(Boolean));
    where.push(`l.campaign_id::text = ANY($${params.length}::text[])`);
  }
  if (Array.isArray(p.user_ids) && p.user_ids.length) {
    params.push(p.user_ids.map(String));
    where.push(`l.assigned_to::text = ANY($${params.length}::text[])`);
  }
  if (dr.from) { params.push(dr.from); where.push(`l.created_at >= $${params.length}::date`); }
  if (dr.to)   { params.push(dr.to);   where.push(`l.created_at <  ($${params.length}::date + INTERVAL '1 day')`); }
  const W = where.join(' AND ');

  // ---- KPIs ----
  const _HAS_REMARK = await _leadsHasRemark();
  const baseParams = params.slice();
  const kpi = await db.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE l.assigned_to IS NULL OR NULLIF(l.assigned_to::text, '') IS NULL OR l.assigned_to::text = '0')::int AS unassigned,
        COUNT(*) FILTER (WHERE l.assigned_to IS NOT NULL AND NULLIF(l.assigned_to::text, '') IS NOT NULL AND l.assigned_to::text <> '0')::int AS assigned,
        COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${baseParams.length + 1}::text[]))::int AS final_cnt,
        COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${baseParams.length + 2}::text[]))::int AS won_cnt,
        COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${baseParams.length + 3}::text[]))::int AS lost_cnt,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(l.is_duplicate::text,''),'0') = '1')::int AS duplicates,
        ${_HAS_REMARK ? "COUNT(*) FILTER (WHERE COALESCE(l.remark,'') <> '')::int" : '0::int'} AS contacted_cnt
     FROM leads l WHERE ${W}`,
    baseParams.concat([finalArr, wonArr, lostArr])
  );
  const k = kpi.rows[0] || {};
  const total = Number(k.total) || 0;
  const won = Number(k.won_cnt) || 0;

  // ---- Status-wise breakdown ----
  // CAMPAIGN_REPORT_v3_CLEAN — only reference statuses columns that exist
  // on every tenant (id, name). display_order/sort fields don't exist on
  // vserve and similar; ordering by cnt DESC is fine — gives the most
  // common statuses at the top which is what the user actually wants.
  const statusRows = await db.query(
    `SELECT COALESCE(s.name, 'Unset') AS status_name,
            l.status_id,
            COUNT(*)::int AS cnt
       FROM leads l
       LEFT JOIN statuses s ON s.id = l.status_id
      WHERE ${W}
      GROUP BY s.name, l.status_id
      ORDER BY cnt DESC`,
    params
  );

  // ---- Funnel (Total → Assigned → Contacted → Final → Won) ----
  const tot = total;
  const ass = Number(k.assigned) || 0;
  const con = Number(k.contacted_cnt) || 0;
  const fin = Number(k.final_cnt) || 0;
  const wo  = won;
  const pct = (a, base) => base > 0 ? Math.round((a / base) * 1000) / 10 : 0;
  const funnel = [
    { stage: 'Total leads',  cnt: tot, pct_from_top: 100 },
    { stage: 'Assigned',     cnt: ass, pct_from_top: pct(ass, tot) },
    { stage: 'Contacted',    cnt: con, pct_from_top: pct(con, tot) },
    { stage: 'Final',        cnt: fin, pct_from_top: pct(fin, tot) },
    { stage: 'Won',          cnt: wo,  pct_from_top: pct(wo, tot) }
  ];

  // ---- User-wise breakdown ----
  let userRows = { rows: [] };
  try {
    userRows = await db.query(
      `SELECT COALESCE(u.full_name, u.username, 'Unassigned') AS user_name,
              l.assigned_to,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${params.length + 1}::text[]))::int AS final_cnt,
              COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${params.length + 2}::text[]))::int AS won_cnt
         FROM leads l
         LEFT JOIN users u ON u.id::text = l.assigned_to::text
        WHERE ${W}
        GROUP BY u.full_name, u.username, l.assigned_to
        ORDER BY total DESC`,
      params.concat([finalArr, wonArr])
    );
  } catch (_) {}

  // ---- Product breakdown ----
  const productRows = await db.query(
    `SELECT COALESCE(NULLIF(l.product, ''), 'Unspecified') AS product,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${params.length + 1}::text[]))::int AS won_cnt
       FROM leads l WHERE ${W}
       GROUP BY l.product ORDER BY total DESC LIMIT 25`,
    params.concat([wonArr])
  );

  // ---- Source breakdown ----
  const sourceRows = await db.query(
    `SELECT COALESCE(NULLIF(l.source, ''), 'Unspecified') AS source,
            COUNT(*)::int AS cnt
       FROM leads l WHERE ${W}
       GROUP BY l.source ORDER BY cnt DESC LIMIT 20`,
    params
  );

  // ---- Campaign-wise breakdown (when filter is all campaigns) ----
  const campRows = await db.query(
    `SELECT COALESCE(c.name, '#' || l.campaign_id::text) AS campaign_name,
            l.campaign_id,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE NULLIF(l.status_id::text, '') = ANY($${params.length + 1}::text[]))::int AS won_cnt
       FROM leads l
       LEFT JOIN campaigns c ON c.id::text = l.campaign_id::text
      WHERE ${W}
      GROUP BY c.name, l.campaign_id ORDER BY total DESC LIMIT 50`,
    params.concat([wonArr])
  );

  // ---- Daily inflow ----
  let daily = { rows: [] };
  try {
    daily = await db.query(
      `SELECT to_char(date_trunc('day', l.created_at), 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS cnt
         FROM leads l WHERE ${W}
         GROUP BY day ORDER BY day ASC LIMIT 90`,
      params
    );
  } catch (_) {}

  // ---- Avg TAT ----
  let tatSecs = 0;
  try {
    const tat = await db.query(
      `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (l.updated_at - l.created_at))), 0)::bigint AS avg_secs
         FROM leads l WHERE ${W} AND NULLIF(l.status_id::text, '') = ANY($${params.length + 1}::text[])`,
      params.concat([finalArr])
    );
    tatSecs = Number(tat.rows[0] && tat.rows[0].avg_secs) || 0;
  } catch (_) {}

  return {
    ok: true,
    range: dr,
    filters: {
      campaign_ids: p.campaign_ids || [],
      user_ids:     p.user_ids     || []
    },
    kpis: {
      total,
      unassigned: Number(k.unassigned) || 0,
      assigned:   ass,
      contacted:  con,
      final:      fin,
      won,
      lost:       Number(k.lost_cnt) || 0,
      duplicates: Number(k.duplicates) || 0,
      conv_pct:   pct(won, total),
      avg_tat_secs: tatSecs
    },
    funnel,
    status_rows:   statusRows.rows,
    user_rows:     userRows.rows,
    product_rows:  productRows.rows,
    source_rows:   sourceRows.rows,
    campaign_rows: campRows.rows,
    daily:         daily.rows
  };
}

module.exports = {
  api_campaigns_list,
  api_campaigns_uploadLeads,   /* CAMPAIGN_UPLOAD_v1 */
  api_campaigns_reportAdvanced, /* CAMPAIGN_REPORT_v1.1 */
  api_campaigns_report,        /* CAMPAIGN_REPORT_v1 */
  api_campaigns_reportAll,     /* CAMPAIGN_REPORT_v1 */
  api_campaigns_get,
  api_campaigns_save,
  api_campaigns_pause,
  api_campaigns_delete,
  api_campaigns_applyRemoval,
  api_campaigns_attachExisting, /* CAMPAIGN_ATTACH_EXISTING_v1 */
  api_campaigns_pullDiagnostic, /* CAMPAIGN_PULL_DIAG_v1 */
  api_campaigns_resetUnclosed, /* CAMPAIGN_RESET_v1 */
};
