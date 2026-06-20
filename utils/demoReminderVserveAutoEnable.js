/* DEMO_REMINDER_v1 (2026-06-20) — one-shot auto-enable on vserve at boot.
 * Idempotent. Skips if flag already set. */
'use strict';

async function autoEnableOnVserve() {
  try {
    const control = require('../control/db');
    const tenantPool = require('./tenantPool');

    const r = await control.query(
      `SELECT id, slug, org_name, db_name, status FROM tenants WHERE slug = 'vserve' LIMIT 1`
    );
    if (!r.rows.length) {
      console.log('[DEMO_REM_AUTOENABLE] vserve not found, skipping.');
      return;
    }
    const tenant = r.rows[0];
    const pool = tenantPool.poolFor(tenant);
    if (!pool) { console.log('[DEMO_REM_AUTOENABLE] no pool for vserve.'); return; }

    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='DEMO_REMINDER_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (e) {
      console.log('[DEMO_REM_AUTOENABLE] config read failed:', e.message);
      return;
    }

    if (String(current || '') === '1') {
      console.log('[DEMO_REM_AUTOENABLE] vserve already enabled.');
      return;
    }

    await pool.query(
      `INSERT INTO config (key, value) VALUES ('DEMO_REMINDER_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    console.log('[DEMO_REM_AUTOENABLE] ✓ flipped DEMO_REMINDER_ENABLED=1 on vserve.');
  } catch (e) {
    console.error('[DEMO_REM_AUTOENABLE] failed:', e.message);
  }
}

module.exports = { autoEnableOnVserve };
