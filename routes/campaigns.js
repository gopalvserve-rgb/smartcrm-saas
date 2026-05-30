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
    SELECT c.id, c.name, c.pipeline, c.manager_user_id, c.distribution_mode, c.auto_share_user_id,
           c.pull_batch_size, c.pull_initial_count,
           c.pull_require_old_updated, c.pull_old_threshold_minutes,
           c.removed_user_action, c.is_active,
           c.created_at, c.updated_at,
           mu.name  AS manager_name,
           mu.email AS manager_email,
           (SELECT COUNT(*) FROM campaign_agents ca
              WHERE ca.campaign_id = c.id AND ca.is_active = 1) AS agent_count,
           (SELECT COUNT(*) FROM leads l
              WHERE l.campaign_id = c.id) AS lead_count,
           /* CAMPAIGN_LEAD_BREAKDOWN_v2 — simple mental model:
              Free + Assigned = Total (no status filter). Final is shown as
              informational only — how many of those leads happen to be in
              a status flagged is_final=1. This stops leads with admin-set
              final statuses (Won/Junk/etc.) from disappearing from Assigned. */
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
            ) AS leads_hidden
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
         auto_share_user_id=$14,
         updated_at=NOW()
       WHERE id=$12 RETURNING id`,
      [name, pipeline, managerUserId, distributionMode,
       pullBatch, pullInitial, pullRequireOld, pullThresholdMin,
       removedAction, conditionalRules, isActive, campaignId, matchFilter,
       autoShareUid]
    );
    if (!u.rows.length) throw new Error('Campaign not found for update.');
  } else {
    const i = await db.query(
      `INSERT INTO campaigns
         (name, pipeline, manager_user_id, distribution_mode,
          pull_batch_size, pull_initial_count,
          pull_require_old_updated, pull_old_threshold_minutes,
          removed_user_action, conditional_rules, is_active, match_filter,
          auto_share_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        RETURNING id`,
      [name, pipeline, managerUserId, distributionMode,
       pullBatch, pullInitial, pullRequireOld, pullThresholdMin,
       removedAction, conditionalRules, isActive, matchFilter,
       autoShareUid]
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

module.exports = {
  api_campaigns_list,
  api_campaigns_get,
  api_campaigns_save,
  api_campaigns_pause,
  api_campaigns_delete,
  api_campaigns_applyRemoval,
  api_campaigns_attachExisting, /* CAMPAIGN_ATTACH_EXISTING_v1 */
  api_campaigns_pullDiagnostic, /* CAMPAIGN_PULL_DIAG_v1 */
};
