/**
 * utils/campaignRemoval.js
 *
 * Phase 3 of the Campaigns feature: when an admin removes one or more
 * agents from a campaign (via the Settings → 🎯 Campaigns edit modal),
 * apply the campaign's `removed_user_action` to every lead in this
 * campaign currently owned by the removed agents.
 *
 * The three actions (declared in migrations/2026_05_08_campaigns.sql):
 *
 *   pool      → leads.assigned_to = NULL
 *               (the campaign's distribution mode will redistribute
 *               them on the next lead-create or via a manual bulk-
 *               assign; for on_demand mode, the leads return to the
 *               unassigned pool and the next agent's Pull picks them
 *               up.)
 *
 *   hidden    → leads.is_hidden = 1
 *               (lead stays assigned to the now-removed user but is
 *               filtered out of every list view until an admin
 *               manually reassigns it. The Leads list shows them only
 *               for admins with the "🙈 Show hidden" toggle on.)
 *
 *   manager   → leads.assigned_to = campaign.manager_user_id
 *               (or the admin user if manager_user_id is NULL — we
 *               find the lowest-id active admin as the platform-wide
 *               fallback so a campaign without an explicit manager
 *               doesn't leave orphaned leads behind.)
 *
 * Only leads whose status isn't a final status (won/lost/closed) get
 * touched — already-closed leads aren't worth redistributing.
 *
 * Returns a summary { affected, action, manager_used } so the caller
 * (api_campaigns_save) can include it in its API response and the
 * Settings UI can toast something like "Removed 2 agents — 17 leads
 * returned to pool".
 */

'use strict';

const db = require('../db/pg');

async function _fallbackAdminId() {
  const r = await db.query(
    `SELECT id FROM users
      WHERE role = 'admin' AND COALESCE(is_active, 1) = 1
      ORDER BY id ASC LIMIT 1`
  );
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

/**
 * Apply the campaign's removed_user_action to every open lead in this
 * campaign currently owned by any of the given userIds.
 *
 *   campaignId — the campaign these users were just removed from
 *   userIds    — array of user_ids that were just dropped from the
 *                campaign_agents list (or marked is_active=0)
 *
 * Returns:
 *   { action, affected, manager_used? }
 */
async function applyRemovalPolicy(campaignId, userIds) {
  const cid = Number(campaignId);
  const ids = (userIds || []).map(Number).filter(Boolean);
  if (!cid || !ids.length) return { action: null, affected: 0 };

  const c = await db.query(
    `SELECT id, removed_user_action, manager_user_id
       FROM campaigns WHERE id = $1`,
    [cid]
  );
  if (!c.rows.length) return { action: null, affected: 0 };
  const action  = c.rows[0].removed_user_action;
  const manager = c.rows[0].manager_user_id ? Number(c.rows[0].manager_user_id) : null;

  // We scope all three actions to OPEN leads: status not final, not
  // already hidden (so re-applying the policy is idempotent), and
  // belonging to this exact campaign + assignee.
  const baseFilter = `
    campaign_id = $1
    AND assigned_to = ANY($2::int[])
    AND COALESCE(is_hidden, 0) = 0
    AND status_id IN (
      SELECT id FROM statuses WHERE COALESCE(is_final, 0) = 0
    )
  `;

  if (action === 'pool') {
    const r = await db.query(
      `UPDATE leads SET assigned_to = NULL, updated_at = NOW()
        WHERE ${baseFilter}`,
      [cid, ids]
    );
    return { action, affected: r.rowCount || 0 };
  }

  if (action === 'hidden') {
    const r = await db.query(
      `UPDATE leads SET is_hidden = 1, updated_at = NOW()
        WHERE ${baseFilter}`,
      [cid, ids]
    );
    return { action, affected: r.rowCount || 0 };
  }

  if (action === 'manager') {
    const target = manager || (await _fallbackAdminId());
    if (!target) {
      // No manager set AND no admin in this tenant — fall back to pool
      // rather than leave the leads stuck on the removed user.
      const r = await db.query(
        `UPDATE leads SET assigned_to = NULL, updated_at = NOW()
          WHERE ${baseFilter}`,
        [cid, ids]
      );
      return { action: 'pool', affected: r.rowCount || 0,
               manager_used: null, fallback_reason: 'no-manager-or-admin' };
    }
    const r = await db.query(
      `UPDATE leads SET assigned_to = $3, updated_at = NOW()
        WHERE ${baseFilter}`,
      [cid, ids, target]
    );
    return { action, affected: r.rowCount || 0, manager_used: target };
  }

  return { action, affected: 0 };
}

module.exports = { applyRemovalPolicy };
