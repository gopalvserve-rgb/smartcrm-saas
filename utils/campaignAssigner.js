/**
 * utils/campaignAssigner.js
 *
 * Phase 2 of the Campaigns feature: takes a lead and a campaign, picks
 * the right agent based on the campaign's distribution_mode, and
 * persists campaign_id + assigned_to on the lead row.
 *
 * Distribution semantics (kept in sync with migrations/2026_05_08_campaigns.sql):
 *
 *   on_demand   → leave assigned_to NULL. The agent will Pull the lead
 *                 themselves from the unassigned pool inside this
 *                 campaign. Pull rules (batch size, "old leads must be
 *                 updated first") are enforced in routes/leads.js Pull.
 *
 *   equal       → pick the active agent with the LOWEST count of leads
 *                 currently assigned in this campaign. Tie-break by
 *                 lowest rr_position so totals stay balanced over the
 *                 long run even after agents are added/removed.
 *
 *   round_robin → pick the active agent with the lowest rr_position;
 *                 bump that agent's rr_position by 1 so the cursor
 *                 advances strictly across server restarts.
 *
 *   percentage  → weighted random pick using each agent's weight_pct.
 *                 Long-run distribution converges on the configured
 *                 percentages without needing an exact running counter.
 *
 *   conditional → Phase 4. For now we fall back to on_demand (no
 *                 auto-assignment) so the lead still gets the
 *                 campaign_id but stays unassigned, ready for the
 *                 Phase 4 rule engine to claim it.
 *
 * Removed-user policy lives in a separate module (utils/campaignRemoval.js)
 * that runs when an agent is removed from a campaign — see Phase 3.
 */

'use strict';

const db = require('../db/pg');

async function _fireCampaignEvent(eventName, leadId, campaignId, agentId) {
  // Centralised firing of the campaign.* automation events. Best-effort —
  // a fire failure should never break the lead-create / lead-update path
  // that's calling us.
  try {
    const lead = (await db.query('SELECT * FROM leads WHERE id = $1', [leadId])).rows[0];
    if (!lead) return;
    const camp = campaignId
      ? (await db.query('SELECT * FROM campaigns WHERE id = $1', [campaignId])).rows[0]
      : null;
    const agent = agentId
      ? (await db.query('SELECT id, name, email, role FROM users WHERE id = $1', [agentId])).rows[0]
      : null;
    require('./automations').fire(eventName, { lead, campaign: camp, agent });
  } catch (e) {
    console.warn('[campaigns] fire ' + eventName + ' failed:', e.message);
  }
}

/**
 * Pick the next agent_id for a campaign, or null if mode is on_demand /
 * conditional / there are no active agents. Mutates rr_position when
 * mode is round_robin or equal so the next call advances the cursor.
 *
 * Runs inside a transaction so two concurrent leads can't both grab the
 * same "lowest rr_position" agent.
 */
async function pickAgentForCampaign(campaignId) {
  const cid = Number(campaignId);
  if (!cid) throw new Error('campaignId is required');

  const c = await db.query(
    `SELECT id, distribution_mode FROM campaigns WHERE id = $1 AND is_active = 1`,
    [cid]
  );
  if (!c.rows.length) return { agent_id: null, mode: null, reason: 'campaign-inactive' };
  const mode = c.rows[0].distribution_mode;

  if (mode === 'on_demand') {
    return { agent_id: null, mode, reason: mode };
  }

  // Conditional mode is handled fully inside its own branch below
  // because it needs the LEAD payload to evaluate rules. Callers that
  // don't pass a lead get an on_demand-style "no pick" result so the
  // lead still lands in the campaign without a wrong agent assigned.
  if (mode === 'conditional') {
    return { agent_id: null, mode, reason: 'conditional-needs-lead' };
  }

  // Pull active members + their current open-lead counts in this campaign.
  // Using a single query so we don't N+1 across agents.
  const r = await db.query(
    `SELECT ca.user_id, ca.weight_pct, ca.rr_position,
            COALESCE((SELECT COUNT(*) FROM leads l
                        WHERE l.campaign_id = ca.campaign_id
                          AND l.assigned_to = ca.user_id
                          AND COALESCE(l.is_hidden, 0) = 0), 0) AS open_count
       FROM campaign_agents ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.campaign_id = $1
        AND ca.is_active   = 1
        AND COALESCE(u.is_active, 1) = 1
        AND COALESCE(u.paused_for_leads, FALSE) = FALSE`,
    [cid]
  );
  const agents = r.rows;
  if (!agents.length) return { agent_id: null, mode, reason: 'no-active-agents' };

  if (mode === 'equal') {
    // Lowest open_count wins; tie-break with lowest rr_position so the
    // cursor still advances and we don't pick the same agent twice in
    // a row when multiple are tied at zero.
    agents.sort((a, b) =>
      (Number(a.open_count) - Number(b.open_count)) ||
      (Number(a.rr_position) - Number(b.rr_position))
    );
    const pick = agents[0];
    await db.query(
      `UPDATE campaign_agents SET rr_position = rr_position + 1
        WHERE campaign_id = $1 AND user_id = $2`,
      [cid, pick.user_id]
    );
    return { agent_id: Number(pick.user_id), mode, reason: 'equal' };
  }

  if (mode === 'round_robin') {
    agents.sort((a, b) =>
      (Number(a.rr_position) - Number(b.rr_position)) ||
      (Number(a.user_id)     - Number(b.user_id))
    );
    const pick = agents[0];
    await db.query(
      `UPDATE campaign_agents SET rr_position = rr_position + 1
        WHERE campaign_id = $1 AND user_id = $2`,
      [cid, pick.user_id]
    );
    return { agent_id: Number(pick.user_id), mode, reason: 'round_robin' };
  }

  if (mode === 'percentage') {
    // Weighted random. Falls back to equal odds if all weights are 0.
    const totalWeight = agents.reduce((s, a) => s + Math.max(0, Number(a.weight_pct) || 0), 0);
    if (totalWeight <= 0) {
      const pick = agents[Math.floor(Math.random() * agents.length)];
      return { agent_id: Number(pick.user_id), mode, reason: 'percentage-zero-weights' };
    }
    let r = Math.random() * totalWeight;
    for (const a of agents) {
      const w = Math.max(0, Number(a.weight_pct) || 0);
      if (r < w) {
        return { agent_id: Number(a.user_id), mode, reason: 'percentage' };
      }
      r -= w;
    }
    // Float rounding fallback
    return { agent_id: Number(agents[agents.length - 1].user_id), mode, reason: 'percentage' };
  }

  // Unknown mode → safe default
  return { agent_id: null, mode, reason: 'unknown-mode' };
}

/**
 * Assign a lead to a campaign and run distribution.
 *
 *   leadId      — the lead row to update
 *   campaignId  — pass null to clear the campaign (campaign_id = NULL,
 *                 lead stays where it is)
 *   opts.respectExistingAssignee — if true, keep the lead's current
 *                 assigned_to even if the campaign would have picked
 *                 someone different. Used when an admin manually
 *                 assigned the lead and just wants to bucket it under
 *                 a campaign for reporting. Default: false.
 *   opts.actor  — optional user object that triggered the assignment.
 *                 Currently unused; reserved for an audit log row in
 *                 a follow-up phase.
 *
 * Returns { agent_id, mode, reason, campaign_id }.
 */
async function assignLeadToCampaign(leadId, campaignId, opts = {}) {
  const lid = Number(leadId);
  if (!lid) throw new Error('leadId is required');

  // Detach case
  if (campaignId == null) {
    await db.query(`UPDATE leads SET campaign_id = NULL WHERE id = $1`, [lid]);
    return { agent_id: null, mode: null, reason: 'detached', campaign_id: null };
  }

  const cid = Number(campaignId);
  // Need the lead row first so we can evaluate conditional rules against it.
  const leadRow = (await db.query('SELECT * FROM leads WHERE id = $1', [lid])).rows[0];
  if (!leadRow) throw new Error('Lead not found: ' + lid);
  // Cheap mode probe so we only run pickAgentForCampaignWithLead when needed.
  const camp = await db.query('SELECT distribution_mode FROM campaigns WHERE id = $1', [cid]);
  const mode = camp.rows[0] && camp.rows[0].distribution_mode;
  const pick = mode === 'conditional'
    ? await pickAgentForCampaignWithLead(cid, leadRow)
    : await pickAgentForCampaign(cid);

  // Use the leadRow we already fetched to compute respect-existing logic.
  const currentAssignee = leadRow.assigned_to == null ? null : Number(leadRow.assigned_to);

  const respectExisting = !!opts.respectExistingAssignee;

  if (pick.agent_id == null) {
    // on_demand / conditional / no-agents — only update campaign_id, keep
    // assignee untouched.
    await db.query(
      `UPDATE leads SET campaign_id = $1 WHERE id = $2`,
      [cid, lid]
    );
    if (Number(leadRow.campaign_id || 0) !== cid) await _fireCampaignEvent('campaign.lead_added', lid, cid, null);
    return { ...pick, campaign_id: cid };
  }

  if (respectExisting && currentAssignee) {
    await db.query(
      `UPDATE leads SET campaign_id = $1 WHERE id = $2`,
      [cid, lid]
    );
    if (Number(leadRow.campaign_id || 0) !== cid) await _fireCampaignEvent('campaign.lead_added', lid, cid, null);
    return { agent_id: currentAssignee, mode: pick.mode, reason: 'kept-existing-assignee', campaign_id: cid };
  }

  // Fast path: full overwrite. Bump last_status_change_at so the lead
  // re-enters the right SLA bucket / Auto-assign rule eligibility.
  await db.query(
    `UPDATE leads
        SET campaign_id = $1,
            assigned_to = $2,
            last_status_change_at = COALESCE(last_status_change_at, NOW())
      WHERE id = $3`,
    [cid, pick.agent_id, lid]
  );
  if (Number(leadRow.campaign_id || 0) !== cid) await _fireCampaignEvent('campaign.lead_added', lid, cid, pick.agent_id);
  if (Number(leadRow.assigned_to || 0) !== Number(pick.agent_id)) await _fireCampaignEvent('campaign.lead_assigned', lid, cid, pick.agent_id);
  return { ...pick, campaign_id: cid };
}


/**
 * Compare a lead's field value to a rule's expected value, with a
 * small operator vocabulary. Designed to feel like the auto-assign
 * Rules tab so admins don't have to learn a new DSL.
 *
 * Supported operators (case-insensitive on string lhs):
 *   eq | equals | ''       → exact match (strings: case-insensitive)
 *   in                     → expected is an array; lhs ∈ expected
 *   contains               → string lhs includes the expected substring
 *   starts_with            → string lhs starts with expected
 *   not_eq | not_equals    → negation of eq
 */
function _matchOp(lhs, op, expected) {
  const lhsStr = lhs == null ? '' : String(lhs).trim().toLowerCase();
  const expArr = Array.isArray(expected) ? expected.map(e => String(e).trim().toLowerCase()) : null;
  const expStr = expected == null ? '' : String(expected).trim().toLowerCase();
  switch ((op || 'eq').toLowerCase()) {
    case 'in':          return expArr ? expArr.includes(lhsStr) : false;
    case 'contains':    return expStr && lhsStr.includes(expStr);
    case 'starts_with': return expStr && lhsStr.startsWith(expStr);
    case 'not_eq':
    case 'not_equals':  return lhsStr !== expStr;
    case 'eq':
    case 'equals':
    case '':
    default:            return lhsStr === expStr;
  }
}

/**
 * Read the value of a 'field' name on the lead, looking through both
 * the columns in the leads table and the parsed extra_json bag. Custom
 * fields are addressed as 'cf_<key>' so admins can reference them in
 * conditional rules using the same key they typed when defining the
 * field.
 */
function _readLeadField(lead, fieldName) {
  if (!lead || !fieldName) return null;
  const f = String(fieldName);
  if (f.startsWith('cf_')) {
    let extra = lead.extra;
    if (!extra) {
      try { extra = lead.extra_json ? (typeof lead.extra_json === 'string' ? JSON.parse(lead.extra_json) : lead.extra_json) : {}; }
      catch (_) { extra = {}; }
    }
    return extra ? extra[f.slice(3)] : null;
  }
  return lead[f] != null ? lead[f] : null;
}

/**
 * Conditional distribution. For each rule (in order), if every
 * `if.<field>` clause matches the lead, return the first valid
 * `then.user_id` that's still an active member of the campaign.
 *
 * Rule shape stored in campaigns.conditional_rules JSONB:
 *   [
 *     { "if": { "source": "Website", "city": "Mumbai" },
 *       "then": { "user_id": 12 } },
 *     { "if": { "source": { "op": "in", "value": ["Facebook", "Instagram"] } },
 *       "then": { "user_id": 13 } }
 *   ]
 *
 * If no rule matches, falls back to round_robin among active agents
 * so the lead still gets routed somewhere instead of vanishing.
 */
async function pickAgentForCampaignWithLead(campaignId, lead) {
  const cid = Number(campaignId);
  if (!cid) throw new Error('campaignId is required');

  const c = await db.query(
    `SELECT id, distribution_mode, conditional_rules
       FROM campaigns WHERE id = $1 AND is_active = 1`,
    [cid]
  );
  if (!c.rows.length) return { agent_id: null, mode: null, reason: 'campaign-inactive' };
  const camp = c.rows[0];
  if (camp.distribution_mode !== 'conditional') {
    // Defer to the regular picker so callers can use this single entry
    // point regardless of mode.
    return pickAgentForCampaign(cid);
  }

  let rules = camp.conditional_rules;
  if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch (_) { rules = []; } }
  if (!Array.isArray(rules)) rules = [];

  // Pre-fetch active agent set so we can validate rule.then.user_id
  // and also fall back to round_robin if no rule matches.
  const ag = await db.query(
    `SELECT user_id, rr_position FROM campaign_agents ca
       JOIN users u ON u.id = ca.user_id
      WHERE ca.campaign_id = $1 AND ca.is_active = 1 AND COALESCE(u.is_active, 1) = 1 AND COALESCE(u.paused_for_leads, FALSE) = FALSE`,
    [cid]
  );
  const activeAgentIds = new Set(ag.rows.map(r => Number(r.user_id)));
  const agentsArr = ag.rows;

  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const ifBlock   = rule.if   || rule.when || {};
    const thenBlock = rule.then || rule.action || {};
    const ok = Object.entries(ifBlock).every(([field, cond]) => {
      const lhs = _readLeadField(lead, field);
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        return _matchOp(lhs, cond.op, cond.value);
      }
      return _matchOp(lhs, 'eq', cond);
    });
    if (!ok) continue;
    const targetUserId = Number(thenBlock.user_id);
    if (!targetUserId) continue;
    if (!activeAgentIds.has(targetUserId)) continue;   // user is no longer on the campaign
    return { agent_id: targetUserId, mode: 'conditional', reason: 'rule-matched', rule };
  }

  // No rule matched — fall back to round_robin within active agents.
  if (!agentsArr.length) return { agent_id: null, mode: 'conditional', reason: 'no-active-agents' };
  agentsArr.sort((a, b) =>
    (Number(a.rr_position) - Number(b.rr_position)) ||
    (Number(a.user_id)     - Number(b.user_id))
  );
  const pick = agentsArr[0];
  await db.query(
    `UPDATE campaign_agents SET rr_position = rr_position + 1
      WHERE campaign_id = $1 AND user_id = $2`,
    [cid, pick.user_id]
  );
  return { agent_id: Number(pick.user_id), mode: 'conditional', reason: 'fallback-round-robin' };
}


/**
 * Find the first active campaign whose match_filter matches a lead, in
 * id-ascending order. Returns the campaign row, or null if no campaign
 * has a match_filter that fits.
 *
 * Filter shape (per campaigns.match_filter): JSONB array of rule
 * objects. All rules are AND-joined.
 *
 *   [ { field: 'source',   op: 'equals',   value: 'Make.com' },
 *     { field: 'cf_state', op: 'contains', value: 'Karnataka' } ]
 *
 * cf_<key> fields look up the value in lead.extra_json or
 * lead.custom_fields via the shared matcher in utils/assignmentRules.js.
 */
async function findCampaignForLead(lead) {
  let rows;
  try {
    const q = await db.query(
      `SELECT id, name, match_filter
         FROM campaigns
        WHERE is_active = 1
          AND match_filter IS NOT NULL
        ORDER BY id ASC`
    );
    rows = q.rows;
  } catch (_) { return null; }
  if (!rows || !rows.length) return null;
  const { _matches, _readField } = require('./assignmentRules');
  for (const camp of rows) {
    let rules = camp.match_filter;
    if (typeof rules === 'string') {
      try { rules = JSON.parse(rules); } catch (_) { continue; }
    }
    if (!Array.isArray(rules) || !rules.length) continue;
    let allMatch = true;
    for (const r of rules) {
      const fv = _readField(lead, r.field);
      if (!_matches(r.op || r.operator, fv, r.value)) { allMatch = false; break; }
    }
    if (allMatch) return camp;
  }
  return null;
}


module.exports = { pickAgentForCampaign, pickAgentForCampaignWithLead, assignLeadToCampaign, findCampaignForLead };
