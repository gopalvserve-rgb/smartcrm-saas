/* WA_CATALOGUE_ALLTENANTS_v1 (2026-07-08) — one-shot autoRolloutAtBoot.
 * Sets WA_CATALOGUE_ENABLED='1' on EVERY existing tenant on server start.
 * Idempotent — skips tenants that already have the flag set. Ran to replace
 * the earlier vserve-only autoEnableOnVserve() variant so the catalogue
 * feature is available across the fleet.
 */
'use strict';

async function autoEnableOnVserve() { return autoRolloutAtBoot(); } // legacy name kept

async function autoRolloutAtBoot() {
  try {
    const control = require('../control/db');
    const tenantPool = require('./tenantPool');

    const r = await control.query(
      `SELECT id, slug, org_name, db_name, status FROM tenants WHERE status IN ('active','trial','live','demo') OR status IS NULL`
    );
    const tenants = r.rows || [];
    let flipped = 0, alreadyOn = 0, errors = 0;
    for (const tenant of tenants) {
      try {
        const pool = tenantPool.poolFor(tenant);
        if (!pool) { continue; }
        let current = null;
        try {
          const c = await pool.query(`SELECT value FROM config WHERE key='WA_CATALOGUE_ENABLED' LIMIT 1`);
          current = c.rows[0] && c.rows[0].value;
        } catch (e) {
          // config table missing → skip; tenantBootstrap will heal it on next boot
          continue;
        }
        if (String(current || '') === '1') { alreadyOn++; continue; }
        await pool.query(
          `INSERT INTO config (key, value) VALUES ('WA_CATALOGUE_ENABLED', '1')
           ON CONFLICT (key) DO UPDATE SET value = '1'`
        );
        flipped++;
      } catch (e) {
        errors++;
        console.warn('[WA_CATALOGUE_ROLLOUT] tenant', tenant.slug, 'err:', e.message);
      }
    }
    console.log('[WA_CATALOGUE_ROLLOUT] flipped=' + flipped + ' alreadyOn=' + alreadyOn + ' errors=' + errors + ' total=' + tenants.length);
  } catch (e) {
    console.error('[WA_CATALOGUE_ROLLOUT] failed:', e.message);
  }
}

module.exports = { autoEnableOnVserve, autoRolloutAtBoot };
