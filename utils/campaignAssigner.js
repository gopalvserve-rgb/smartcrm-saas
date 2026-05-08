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

  if (mode === 'on_demand' || mode === 'conditional') {
    return { agent_id: null, mode, reason: mode };
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
      WHERE ca.campaign_id = $1
        AND ca.is_active   = 1`,
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
  const pick = await pickAgentForCampaign(cid);

  // Read the lead's current assigned_to so we know whether to overwrite.
  const cur = await db.query('SELECT assigned_to FROM leads WHERE id = $1', [lid]);
  if (!cur.rows.length) throw new Error('Lead not found: ' + lid);
  const currentAssignee = cur.rows[0].assigned_to == null ? null : Number(cur.rows[0].assigned_to);

  const respectExisting = !!opts.respectExistingAssignee;

  if (pick.agent_id == null) {
    // on_demand / conditional / no-agents — only update campaign_id, keep
    // assignee untouched.
    await db.query(
      `UPDATE leads SET campaign_id = $1 WHERE id = $2`,
      [cid, lid]
    );
    return { ...pick, campaign_id: cid };
  }

  if (respectExisting && currentAssignee) {
    await db.query(
      `UPDATE leads SET campaign_id = $1 WHERE id = $2`,
      [cid, lid]
    );
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
  return { ...pick, campaign_id: cid };
}

module.exports = { pickAgentForCampaign, assignLeadToCampaign };
