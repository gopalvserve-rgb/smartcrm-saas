/* SUB_STATUS_v1 — one-shot auto-enable on vserve at server boot.
 * Mirrors wbChatV2VserveAutoEnable.js exactly. Idempotent.
 * Removable after sub-statuses are rolled out to all tenants.
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
      console.log('[SUB_STATUS_AUTOENABLE] vserve tenant not found, skipping.');
      return;
    }
    const tenant = r.rows[0];
    const pool = tenantPool.poolFor(tenant);
    if (!pool) { console.log('[SUB_STATUS_AUTOENABLE] no pool for vserve, skipping.'); return; }

    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='SUB_STATUS_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (e) {
      console.log('[SUB_STATUS_AUTOENABLE] config table read failed:', e.message);
      return;
    }
    if (String(current || '') === '1') {
      console.log('[SUB_STATUS_AUTOENABLE] vserve already has SUB_STATUS_ENABLED=1, no change.');
      return;
    }
    await pool.query(
      `INSERT INTO config (key, value) VALUES ('SUB_STATUS_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    console.log('[SUB_STATUS_AUTOENABLE] flipped SUB_STATUS_ENABLED=1 on vserve.');
  } catch (e) {
    console.error('[SUB_STATUS_AUTOENABLE] failed:', e.message);
  }
}

module.exports = { autoEnableOnVserve };
