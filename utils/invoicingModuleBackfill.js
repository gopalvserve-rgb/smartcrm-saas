/* INVOICING_BACKFILL_v1 — one-time boot backfill so EVERY existing tenant
 * gets the GST Invoicing module, matching INVOICING_DEFAULT_ON_v1.
 *
 * Coverage:
 *   - Tenants with NULL / '[]' modules_json  → already covered by
 *     resolveModules (default_on:true) — untouched here.
 *   - Tenants with an EXPLICIT non-empty modules_json array that does NOT
 *     contain 'invoicing' → we append 'invoicing' so Billing & Accounts works.
 *
 * Idempotent: the WHERE guard skips arrays that already include 'invoicing',
 * so re-running on every boot is a cheap no-op after the first pass.
 */
'use strict';

async function runOnce() {
  try {
    const control = require('../control/db');
    const r = await control.query(
      `UPDATE tenants
          SET modules_json = (modules_json::jsonb || '["invoicing"]'::jsonb)
        WHERE modules_json IS NOT NULL
          AND jsonb_typeof(modules_json::jsonb) = 'array'
          AND jsonb_array_length(modules_json::jsonb) > 0
          AND NOT (modules_json::jsonb ? 'invoicing')
        RETURNING id, slug`
    );
    const n = (r && r.rowCount) || 0;
    if (n > 0) {
      console.log('[INVOICING_BACKFILL] +invoicing added to ' + n + ' tenant(s): ' +
        r.rows.map(x => x.slug).join(', '));
      // Bust cached tenant pools/config so the change is picked up immediately.
      try {
        const tenantPool = require('./tenantPool');
        r.rows.forEach(x => { try { tenantPool.invalidateSlug(x.slug); } catch (_) {} });
      } catch (_) {}
    } else {
      console.log('[INVOICING_BACKFILL] nothing to backfill (all tenants already have invoicing or use defaults).');
    }
  } catch (e) {
    console.error('[INVOICING_BACKFILL] failed:', e.message);
  }
}

function startSweep() {
  // Run ~20s after boot so the control pool is warm.
  setTimeout(runOnce, 20000);
}

module.exports = { startSweep, runOnce };
