/* LEADS_VIEW_V2 — one-shot auto-enable on vserve at server boot.
 * Mirrors cp4VserveAutoEnable.js. Idempotent.
 */
'use strict';
async function autoEnableOnVserve() {
  try {
    const control = require('../control/db');
    const tenantPool = require('./tenantPool');
    const r = await control.query(`SELECT id, slug, org_name, db_name, status FROM tenants WHERE slug='vserve' LIMIT 1`);
    if (!r.rows.length) return;
    const pool = tenantPool.poolFor(r.rows[0]);
    if (!pool) return;
    let current = null;
    try {
      const c = await pool.query(`SELECT value FROM config WHERE key='LEADS_VIEW_V2_ENABLED' LIMIT 1`);
      current = c.rows[0] && c.rows[0].value;
    } catch (_) { return; }
    if (String(current || '') === '1') return;
    await pool.query(`INSERT INTO config (key,value) VALUES ('LEADS_VIEW_V2_ENABLED','1') ON CONFLICT (key) DO UPDATE SET value='1'`);
    console.log('[LEADS_VIEW_V2_AUTOENABLE] flipped LEADS_VIEW_V2_ENABLED=1 on vserve.');
  } catch (e) { console.error('[LEADS_VIEW_V2_AUTOENABLE] failed:', e.message); }
}
module.exports = { autoEnableOnVserve };
