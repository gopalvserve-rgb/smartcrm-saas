/* SHOWCASE_FOLLOWUP_SEED_v1 — keep the showcase demo tenant's follow-up
 * dashboard populated. The seeded showcase leads have static follow-up
 * dates, so over time "Due Today / Overdue / Upcoming" empties out. This
 * re-anchors a spread of leads' next_followup_at relative to CURRENT_DATE
 * on every boot and once a day, so the three buckets always have data.
 *
 * Scope: slug 'showcase' ONLY. Other tenants are never touched.
 * Idempotent + safe: pure UPDATE relative to today, runs in background,
 * never blocks boot. Mirrors utils/saasInvoiceAutoGen start pattern.
 */
'use strict';

const SLUG = 'showcase';
const DAY_MS = 24 * 60 * 60 * 1000;

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

    const sql = `
      WITH picked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS rn FROM leads
      )
      UPDATE leads l SET next_followup_at = CASE (p.rn % 5)
        WHEN 0 THEN CURRENT_DATE + INTERVAL '12 hours'
        WHEN 1 THEN CURRENT_DATE - make_interval(days => (1 + (p.rn % 25))::int) + INTERVAL '11 hours'
        WHEN 2 THEN CURRENT_DATE - make_interval(days => (1 + (p.rn % 9))::int)  + INTERVAL '15 hours'
        WHEN 3 THEN CURRENT_DATE + make_interval(days => (1 + (p.rn % 13))::int) + INTERVAL '11 hours'
        ELSE        CURRENT_DATE + make_interval(days => (1 + (p.rn % 6))::int)  + INTERVAL '16 hours'
      END
      FROM picked p
      WHERE l.id = p.id`;

    const res = await pool.query(sql);
    console.log('[SHOWCASE_FU_SEED] ✓ re-anchored next_followup_at on showcase, rows=' + (res.rowCount || 0));
  } catch (e) {
    console.error('[SHOWCASE_FU_SEED] failed:', e.message);
  }
}

function startSweep() {
  setTimeout(seedOnce, 25000);
  setInterval(seedOnce, DAY_MS);
}

module.exports = { startSweep, seedOnce };
