/* WA_CATALOGUE_v1 — one-shot auto-enable on vserve at server boot.
 * Mirrors wbChatV2VserveAutoEnable.js exactly. Idempotent.
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
      console.log('[WA_CATALOGUE_AUTOENABLE] vserve tenant not found, skipping.');
      return;
    }
    const tenant = r.rows[0];
    const pool = tenantPool.poolFor(tenant);
    if (!pool) { console.log('[WA_CATALOGUE_AUTOENABLE] no pool for vserve, skipping.'); return; }

    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='WA_CATALOGUE_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (e) {
      console.log('[WA_CATALOGUE_AUTOENABLE] config table read failed:', e.message);
      return;
    }

    if (String(current || '') === '1') {
      console.log('[WA_CATALOGUE_AUTOENABLE] vserve already has WA_CATALOGUE_ENABLED=1, no change.');
      return;
    }

    await pool.query(
      `INSERT INTO config (key, value) VALUES ('WA_C