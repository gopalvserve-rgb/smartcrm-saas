/**
 * DB_VOLUME_v1 — Per-tenant Postgres disk usage + Railway volume capacity.
 *
 * Why: Railway sent a "volume 80% full" alert. Each tenant has its own
 * Postgres database (`tenant_<slug>`) on the shared cluster. We expose:
 *   1. Total Postgres bytes used (sum of all DBs)
 *   2. Per-tenant bytes used (so super-admin can see top consumers)
 *   3. Railway volume capacity (from RAILWAY_PG_VOLUME_GB env var)
 *   4. Percent full + threshold flag (warning 75%, critical 90%)
 *
 * API:
 *   api_saas_dbVolume_summary()
 *
 * Render in super-admin Tenants list: under each tenant name show
 *   "💾 142 MB · 1.4%"  color-coded green/amber/red.
 * Top banner: total usage + warns at >80%.
 */

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

function _capacityGB() {
  const v = Number(process.env.RAILWAY_PG_VOLUME_GB || 0);
  return v > 0 ? v : 5;
}

function _fmt(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return Math.round(bytes / 1024) + ' KB';
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}

async function api_saas_dbVolume_summary(token) {
  await requireSuperAdmin(token);

  const dbRows = (await control.query(`
    SELECT datname AS db_name,
           pg_database_size(datname)::BIGINT AS bytes
      FROM pg_database
     WHERE datistemplate = false
       AND datname NOT IN ('postgres')
     ORDER BY bytes DESC
  `)).rows;

  const sizeMap = new Map();
  dbRows.forEach(r => sizeMap.set(r.db_name, Number(r.bytes)));

  const tenants = (await control.query(`
    SELECT id, slug, org_name, db_name, status, current_period_end
      FROM tenants
     WHERE status NOT IN ('deleted')
     ORDER BY id ASC
  `)).rows;

  const totalBytes = _capacityGB() * 1024 * 1024 * 1024;
  let usedBytes = 0;
  dbRows.forEach(r => { usedBytes += Number(r.bytes); });

  const tenantList = tenants.map(t => {
    const bytes = sizeMap.get(t.db_name) || 0;
    return {
      id: t.id,
      slug: t.slug,
      org_name: t.org_name,
      db_name: t.db_name,
      status: t.status,
      bytes,
      pretty: _fmt(bytes),
      percent_of_volume: totalBytes ? +(bytes / totalBytes * 100).toFixed(2) : 0,
      percent_of_used: usedBytes ? +(bytes / usedBytes * 100).toFixed(1) : 0
    };
  }).sort((a, b) => b.bytes - a.bytes);

  const tenantSum = tenantList.reduce((s, t) => s + t.bytes, 0);
  const controlBytes = sizeMap.get(process.env.PG_CONTROL_DB_NAME || 'smartcrm_control') || 0;
  const otherBytes = Math.max(0, usedBytes - tenantSum - controlBytes);

  const percentFull = totalBytes ? +(usedBytes / totalBytes * 100).toFixed(2) : 0;

  return {
    capacity_gb: _capacityGB(),
    total_bytes: totalBytes,
    used_bytes: usedBytes,
    used_pretty: _fmt(usedBytes),
    free_bytes: Math.max(0, totalBytes - usedBytes),
    free_pretty: _fmt(Math.max(0, totalBytes - usedBytes)),
    percent_full: percentFull,
    warning: percentFull >= 75,
    critical: percentFull >= 90,
    tenants: tenantList,
    control_bytes: controlBytes,
    control_pretty: _fmt(controlBytes),
    other_bytes: otherBytes,
    other_pretty: _fmt(otherBytes),
    db_count: dbRows.length,
    generated_at: new Date().toISOString()
  };
}

module.exports = {
  api_saas_dbVolume_summary
};
