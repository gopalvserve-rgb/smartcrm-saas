/**
 * DB_VOLUME_v1 / DB_VOLUME_PERPOOL_v2 — per-tenant Postgres usage + volume.
 *
 * Per-tenant bytes are read from EACH tenant's own database
 * (pg_database_size(current_database()) via its pool) so it works even when
 * the control connection can't size other databases (permissions / separate
 * hosts). The cluster-wide pg_database scan is best-effort and only used for
 * the total/other buckets.
 */
const control    = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin } = require('./superAdminAuth');

function _capacityGB() { const v = Number(process.env.RAILWAY_PG_VOLUME_GB || 0); return v > 0 ? v : 5; }
function _fmt(bytes) {
  bytes = Number(bytes) || 0;
  const mb = bytes / (1024 * 1024);
  if (bytes < 1024) return bytes + ' B';
  if (mb < 1) return Math.round(bytes / 1024) + ' KB';
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
}

async function api_saas_dbVolume_summary(token) {
  await requireSuperAdmin(token);

  // Best-effort cluster scan (may fail on managed PG without rights).
  const sizeMap = new Map();
  let clusterUsed = 0, dbCount = 0;
  try {
    const dbRows = (await control.query(`
      SELECT datname AS db_name, pg_database_size(datname)::BIGINT AS bytes
        FROM pg_database
       WHERE datistemplate = false AND datname NOT IN ('postgres')
    `)).rows;
    dbRows.forEach(r => { sizeMap.set(r.db_name, Number(r.bytes)); clusterUsed += Number(r.bytes) || 0; });
    dbCount = dbRows.length;
  } catch (e) { console.warn('[dbVolume] cluster scan failed:', e.message); }

  const tenants = (await control.query(`
    SELECT id, slug, org_name, db_name, status, current_period_end
      FROM tenants
     WHERE status NOT IN ('deleted')
     ORDER BY id ASC
  `)).rows;

  // Authoritative per-tenant size from each tenant's OWN database, in parallel.
  await Promise.all(tenants.map(async t => {
    let bytes = 0;
    if (t.status !== 'suspended' && t.status !== 'pending_delete' && t.db_name) {
      try {
        const pool = tenantPool.poolFor(t);
        if (pool) {
          const r = await pool.query('SELECT pg_database_size(current_database())::BIGINT AS b');
          bytes = Number(r.rows[0] && r.rows[0].b) || 0;
        }
      } catch (e) { /* unreachable tenant DB — fall back below */ }
    }
    if (!bytes) bytes = Number(sizeMap.get(t.db_name)) || 0;
    t._bytes = bytes;
  }));

  const totalBytes = _capacityGB() * 1024 * 1024 * 1024;
  const tenantSum = tenants.reduce((s, t) => s + (t._bytes || 0), 0);
  const controlBytes = Number(sizeMap.get(process.env.PG_CONTROL_DB_NAME || 'smartcrm_control')) || 0;
  // Prefer the real cluster usage when we got it; else approximate from tenants.
  const usedBytes = clusterUsed > 0 ? clusterUsed : (tenantSum + controlBytes);
  const otherBytes = Math.max(0, usedBytes - tenantSum - controlBytes);
  const percentFull = totalBytes ? +(usedBytes / totalBytes * 100).toFixed(2) : 0;

  const tenantList = tenants.map(t => ({
    id: t.id, slug: t.slug, org_name: t.org_name, db_name: t.db_name, status: t.status,
    bytes: t._bytes || 0,
    pretty: _fmt(t._bytes || 0),
    percent_of_volume: totalBytes ? +((t._bytes || 0) / totalBytes * 100).toFixed(2) : 0,
    percent_of_used: usedBytes ? +((t._bytes || 0) / usedBytes * 100).toFixed(1) : 0
  })).sort((a, b) => b.bytes - a.bytes);

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
    db_count: dbCount || tenants.length,
    generated_at: new Date().toISOString()
  };
}

module.exports = { api_saas_dbVolume_summary };
