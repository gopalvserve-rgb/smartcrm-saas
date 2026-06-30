/* SHOWCASE_FOLLOWUP_SEED_v2 — keep the showcase demo tenant's Follow-ups
 * page (Due Today / Overdue / Upcoming) populated.
 *
 * The page (api_notifications_mine) reads the `followups` table first and
 * `leads.next_followup_at` as fallback, excludes final-status leads, and is
 * scoped to the logged-in user. For the demo we therefore:
 *   1. set config FOLLOWUPS_SHOW_ALL='1' so the page shows EVERY user's
 *      follow-ups (read by routes/notifications.js, gated to this flag),
 *   2. re-anchor open `followups.due_at` across the 3 buckets vs today,
 *   3. re-anchor `leads.next_followup_at` for NON-FINAL leads vs today.
 *
 * Scope: slug 'showcase' ONLY. Runs ~25s after boot + once a day.
 */
'use strict';

const SLUG = 'showcase';
const DAY_MS = 24 * 60 * 60 * 1000;

// rn % 5 → 0 today, 1&2 overdue (1-25 / 1-9 days), 3&4 upcoming (1-13 / 1-6 days)
const BUCKET = `CASE (p.rn % 5)
        WHEN 0 THEN CURRENT_DATE + INTERVAL '12 hours'
        WHEN 1 THEN CURRENT_DATE - make_interval(days => (1 + (p.rn % 25))::int) + INTERVAL '11 hours'
        WHEN 2 THEN CURRENT_DATE - make_interval(days => (1 + (p.rn % 9))::int)  + INTERVAL '15 hours'
        WHEN 3 THEN CURRENT_DATE + make_interval(days => (1 + (p.rn % 13))::int) + INTERVAL '11 hours'
        ELSE        CURRENT_DATE + make_interval(days => (1 + (p.rn % 6))::int)  + INTERVAL '16 hours'
      END`;

async function seedOnce() {
  try {
    const control = require('../control/db');
    const tenantPool = require('./tenantPool');

    const r = await control.query(
      `SELECT id, slug, org_name, db_name, status FROM tenants WHERE slug = $1 LIMIT 1`,
      [SLUG]
    );
    if (!r.rows.length) { console.log('[SHOWCASE_FU_SEED] showcase tenant not found, skipping.'); return; }

    const pool = tenantPool.poolFor(r.rows[0]);
    if (!pool) { console.log('[SHOWCASE_FU_SEED] no pool for showcase, skipping.'); return; }

    // 1) show-all flag
    try {
      await pool.query(
        `INSERT INTO config (key, value) VALUES ('FOLLOWUPS_SHOW_ALL', '1')
         ON CONFLICT (key) DO UPDATE SET value = '1'`
      );
    } catch (e) { console.error('[SHOWCASE_FU_SEED] flag set failed:', e.message); }

    // 2) re-anchor open follow-up rows (primary source for the page)
    try {
      const f = await pool.query(
        `WITH p AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn
           FROM followups WHERE COALESCE(is_done, 0) = 0
         )
         UPDATE followups f SET due_at = ${BUCKET}
         FROM p WHERE f.id = p.id`
      );
      console.log('[SHOWCASE_FU_SEED] ✓ followups re-anchored, rows=' + (f.rowCount || 0));
    } catch (e) { console.error('[SHOWCASE_FU_SEED] followups update failed:', e.message); }

    // 3) re-anchor next_followup_at for NON-FINAL leads (fallback source)
    try {
      const l = await pool.query(
        `WITH p AS (
           SELECT l.id, ROW_NUMBER() OVER (ORDER BY l.id DESC) AS rn
           FROM leads l LEFT JOIN statuses s ON s.id = l.status_id
           WHERE COALESCE(s.is_final, 0) = 0
         )
         UPDATE leads l SET next_followup_at = ${BUCKET}
         FROM p WHERE l.id = p.id`
      );
      console.log('[SHOWCASE_FU_SEED] ✓ leads.next_followup_at re-anchored, rows=' + (l.rowCount || 0));
    } catch (e) { console.error('[SHOWCASE_FU_SEED] leads update failed:', e.message); }
  } catch (e) {
    console.error('[SHOWCASE_FU_SEED] failed:', e.message);
  }
}

function startSweep() {
  setTimeout(seedOnce, 25000);
  setInterval(seedOnce, DAY_MS);
}

module.exports = { startSweep, seedOnce };
