/* LEADS_V2_HEADER_V4 — one-shot auto-enable on vserve at server boot.
 * Mirrors wbChatV2VserveAutoEnable.js. Idempotent. Removable
 * after the compact sticky header (Option C) is rolled out widely.
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
      console.log('[LEADS_V2_HEADER_V4_AUTOENABLE] vserve tenant not found, skipping.');
      return;
    }
    const tenant = r.rows[0];
    const pool = tenantPool.poolFor(tenant);
    if (!pool) { console.log('[LEADS_V2_HEADER_V4_AUTOENABLE] no pool for vserve, skipping.'); return; }

    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='LEADS_V2_HEADER_V4_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (e) {
      console.log('[LEADS_V2_HEADER_V4_AUTOENABLE] config table read failed:', e.message);
      return;
    }

    if (String(current || '') === '1') {
      console.log('[LEADS_V2_HEADER_V4_AUTOENABLE] vserve already has LEADS_V2_HEADER_V4_ENABLED=1, no change.');
      return;
    }

    await pool.query(
      `INSERT INTO config (key, value) VALUES ('LEADS_V2_HEADER_V4_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    console.log('[LEADS_V2_HEADER_V4_AUTOENABLE] flipped LEADS_V2_HEADER_V4_ENABLED=1 on vserve.');
  } catch (e) {
    console.error('[LEADS_V2_HEADER_V4_AUTOENABLE] failed:', e.message);
  }
}

module.exports = { autoEnableOnVserve };
