/* AI_MGR_v1 — one-shot auto-enable on vserve at server boot.
 * Mirrors utils/cp4VserveAutoEnable.js pattern (COPILOT_v4).
 * Idempotent: checks the flag, sets it only if absent. Runs in background.
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
      console.log('[AI_MGR_AUTOENABLE] vserve tenant not found, skipping.');
      return;
    }
    const tenant = r.rows[0];
    const pool = tenantPool.poolFor(tenant);
    if (!pool) { console.log('[AI_MGR_AUTOENABLE] no pool for vserve, skipping.'); return; }

    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='AI_MANAGER_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (e) {
      console.log('[AI_MGR_AUTOENABLE] config table read failed:', e.message);
      return;
    }

    if (String(current || '') === '1') {
      console.log('[AI_MGR_AUTOENABLE] vserve already has AI_MANAGER_ENABLED=1, no change.');
      return;
    }

    await pool.query(
      `INSERT INTO config (key, value) VALUES ('AI_MANAGER_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    console.log('[AI_MGR_AUTOENABLE] ✓ flipped AI_MANAGER_ENABLED=1 on vserve.');
  } catch (e) {
    console.error('[AI_MGR_AUTOENABLE] failed:', e.message);
  }
}

module.exports = { autoEnableOnVserve };
