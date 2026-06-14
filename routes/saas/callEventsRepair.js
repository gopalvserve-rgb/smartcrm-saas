/**
 * CALL_PHONE_REVERSE_BACKFILL_v1 — Retroactively fill empty-phone outgoing
 * call_events rows by pairing them with lead_recordings the user already
 * uploaded.
 *
 * Why: On Android 10+, PhoneStateReceiver often gets EXTRA_INCOMING_NUMBER
 * null for outgoing calls, and the CallLog fallback only works if
 * READ_CALL_LOG is granted AND the OS has written the entry by the time we
 * query (Vivo/Oppo ROMs delay this). When that fails, server stores the
 * outgoing call_event with phone="".
 *
 * Recording filenames usually DO contain the dialed number (especially on
 * Samsung). When the recording uploads, BRANCH A in the /api/recordings
 * handler backfills the nearest empty-phone call_event. That's a real-time
 * fix.
 *
 * This module is the RETROACTIVE fix — super-admin can click "Backfill
 * empty phones" and we'll walk every existing empty-phone outgoing row
 * across all tenants and try to find a lead_recordings row from the same
 * user within a configurable time window (default 30 minutes) that has a
 * non-empty phone. When found we UPDATE phone in the call_events row.
 *
 * APIs:
 *   api_saas_callEvents_repairPreview(token, { tenant_slug?, window_min? })
 *     → counts how many would be repaired per tenant, no writes
 *   api_saas_callEvents_repairRun(token, { tenant_slug?, window_min? })
 *     → actually performs the UPDATEs
 */

const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin } = require('./superAdminAuth');

const DEFAULT_WINDOW_MIN = 30;

const SQL_FIND_REPAIRABLE = `
  WITH empties AS (
    SELECT ce.id AS event_id,
           ce.user_id,
           ce.created_at,
           ce.direction
      FROM call_events ce
     WHERE (ce.phone IS NULL OR TRIM(ce.phone) = '')
       AND ce.recording_id IS NULL
       AND ce.created_at >= NOW() - INTERVAL '90 days'
  ),
  pairs AS (
    SELECT e.event_id,
           e.user_id,
           e.direction,
           e.created_at AS event_at,
           r.id  AS rec_id,
           r.phone AS rec_phone,
           r.original_filename AS rec_filename,
           r.created_at AS rec_at,
           ABS(EXTRACT(EPOCH FROM (r.created_at - e.created_at))) AS gap_s
      FROM empties e
      JOIN lead_recordings r
        ON r.user_id = e.user_id
       AND r.phone IS NOT NULL
       AND TRIM(r.phone) <> ''
       AND r.created_at BETWEEN e.created_at - ($1 || ' minutes')::INTERVAL
                            AND e.created_at + ($1 || ' minutes')::INTERVAL
  ),
  ranked AS (
    SELECT *,
           ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY gap_s ASC) AS rn
      FROM pairs
  )
  SELECT event_id, user_id, direction, rec_phone AS phone, rec_id, gap_s, event_at
    FROM ranked
   WHERE rn = 1
`;

const SQL_APPLY = `
  UPDATE call_events
     SET phone = $1,
         recording_id = COALESCE(recording_id, $2)
   WHERE id = $3
`;

async function _repairTenant(tenant, windowMin, dryRun) {
  const pool = await tenantPool.get(tenant.db_name);
  let rows;
  try {
    const r = await pool.query(SQL_FIND_REPAIRABLE, [String(windowMin)]);
    rows = r.rows;
  } catch (e) {
    return { slug: tenant.slug, error: e.message, repaired: 0 };
  }
  let updated = 0;
  if (!dryRun) {
    for (const row of rows) {
      try {
        const u = await pool.query(SQL_APPLY, [row.phone, row.rec_id, row.event_id]);
        if (u.rowCount > 0) updated++;
      } catch (e) { /* skip individual failure */ }
    }
  }
  return {
    slug: tenant.slug,
    candidates: rows.length,
    repaired: dryRun ? 0 : updated,
    sample: rows.slice(0, 5).map(r => ({
      event_id: r.event_id, phone: r.phone, gap_s: Math.round(Number(r.gap_s) || 0)
    }))
  };
}

async function _runAcross(token, payload, dryRun) {
  await requireSuperAdmin(token);
  const windowMin = Number(payload && payload.window_min) || DEFAULT_WINDOW_MIN;
  const slug = payload && payload.tenant_slug;
  const where = slug ? "AND slug = $1" : "";
  const args = slug ? [slug] : [];
  const tenants = (await control.query(
    `SELECT slug, db_name FROM tenants WHERE status IN ('active','trial','past_due') ${where} ORDER BY id ASC`,
    args
  )).rows;
  const results = [];
  let total = 0;
  let cand = 0;
  for (const t of tenants) {
    const r = await _repairTenant(t, windowMin, dryRun);
    results.push(r);
    cand += Number(r.candidates) || 0;
    total += Number(r.repaired) || 0;
  }
  return {
    dry_run: dryRun,
    window_min: windowMin,
    tenants_scanned: tenants.length,
    total_candidates: cand,
    total_repaired: total,
    per_tenant: results
  };
}

async function api_saas_callEvents_repairPreview(token, payload) {
  return _runAcross(token, payload, true);
}
async function api_saas_callEvents_repairRun(token, payload) {
  return _runAcross(token, payload, false);
}

module.exports = {
  api_saas_callEvents_repairPreview,
  api_saas_callEvents_repairRun
};
