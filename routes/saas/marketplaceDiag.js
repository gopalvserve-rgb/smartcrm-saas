/* TRADEINDIA_DIAG_v1 (2026-07-29) — super-admin diagnostic for the TradeIndia
 * pull. Given a tenant slug, runs INSIDE that tenant's DB and reports the saved
 * settings (key redacted), whether it's enrolled in the auto-pull cron, the
 * last sync status/error, the most recent sync-log rows, and a LIVE test fetch
 * showing exactly what TradeIndia returns for today. This is how we see why a
 * client's leads stopped importing without needing to log into their workspace. */
const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

async function _withTenantDb(slug, fn) {
  const tenantDb = require('../../db/pg');
  const pools = require('../../utils/tenantPool');
  const t = await pools.findActiveTenant(slug);
  if (!t) throw new Error('Tenant not found: ' + slug);
  const pool = pools.poolFor(t);
  if (!pool) throw new Error('Tenant pool unavailable: ' + slug);
  return await tenantDb.tenantStorage.run({ pool, tenant: t, slug }, fn);
}

async function api_saas_marketplace_diag(token, payload) {
  await requireSuperAdmin(token);
  const slug = String((payload && payload.slug) || '').trim().toLowerCase();
  if (!slug) throw new Error('slug required');
  const provider = String((payload && payload.provider) || 'tradeindia');

  // Enrollment lives in the CONTROL db.
  let enrolled = false, registryRow = null;
  try {
    const r = await control.query(
      `SELECT enabled, updated_at FROM marketplace_sync_registry WHERE slug=$1 AND provider=$2 LIMIT 1`,
      [slug, provider]);
    if (r.rows[0]) { registryRow = r.rows[0]; enrolled = Number(r.rows[0].enabled) === 1; }
  } catch (_) {}

  const out = await _withTenantDb(slug, async () => {
    const ti = require('../tradeIndia');
    const db = require('../../db/pg');
    let settings = null, logs = [], live = null;
    // settings (redact the key)
    try {
      const r = await db.query(`SELECT * FROM marketplace_integrations WHERE provider=$1 LIMIT 1`, [provider]);
      const row = r.rows[0] || {};
      settings = {
        configured: !!(row.api_key && row.api_user_id && row.api_profile_id),
        api_user_id: row.api_user_id || '', api_profile_id: row.api_profile_id || '',
        api_key_hint: row.api_key ? ('••••' + String(row.api_key).slice(-4)) : '(none)',
        auto_import: Number(row.auto_import) || 0,
        sync_interval_min: Number(row.sync_interval_min) || 15,
        last_sync_at: row.last_sync_at || null,
        sync_status: row.sync_status || null,
        last_error: row.last_error || null,
      };
    } catch (e) { settings = { error: e.message }; }
    // recent logs
    try {
      const r = await db.query(
        `SELECT started_at, trigger_type, records_received, imported_count, updated_count,
                skipped_count, error_count, status, message FROM marketplace_sync_logs
          WHERE provider=$1 ORDER BY started_at DESC LIMIT 10`, [provider]);
      logs = r.rows;
    } catch (_) {}
    // LIVE test fetch (today) — reuses the same builder as the real sync
    try {
      live = await ti._previewCore({});
    } catch (e) { live = { error: e.message }; }
    return { settings, logs, live };
  });

  return { slug, provider, enrolled, registry: registryRow, schedule: (function(){ try { return require('../tradeIndia').pullScheduleLabel(); } catch(_) { return ''; } })(), ...out };
}

module.exports = { api_saas_marketplace_diag };
