/* COPILOT_v4 — one-shot auto-enable on vserve at server boot.
 * Idempotent: checks the flag, sets it only if absent. Runs in background,
 * never blocks boot. Removable once user confirms it's working.
 */
'use strict';

async function autoEnableOnVserve() {
  try {
    const control = require('../control/db');
    const tenantPool = require('./tenantPool');

    const r = await control.query(
      `SELECT id, slug, org_name, db_name, status FROM tenants WHERE slug = 'vserve' LIMIT 1`
    );
    if (!r.rows.length) {
      console.log('[CP4_AUTOENABLE] vserve tenant not found, skipping.');
      return;
    }
    const tenant = r.rows[0];
    const pool = tenantPool.poolFor(tenant);
    if (!pool) { console.log('[CP4_AUTOENABLE] no pool for vserve, skipping.'); return; }

    // Read existing value first
    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='COPILOT_PROACTIVE_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (e) {
      // config table might not exist on a brand-new tenant — let bootstrap handle it
      console.log('[CP4_AUTOENABLE] config table read failed:', e.message);
      return;
    }

    if (String(current || '') === '1') {
      console.log('[CP4_AUTOENABLE] vserve already has COPILOT_PROACTIVE_ENABLED=1, no change.');
      return;
    }

    await pool.query(
      `INSERT INTO config (key, value) VALUES ('COPILOT_PROACTIVE_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    console.log('[CP4_AUTOENABLE] ✓ flipped COPILOT_PROACTIVE_ENABLED=1 on vserve.');
  } catch (e) {
    console.error('[CP4_AUTOENABLE] failed:', e.message);
  }
}

module.exports = { autoEnableOnVserve };
