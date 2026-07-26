/* ============================================================================
 * STORAGE_REPORT_v1 — READ-ONLY. Sizes every BYTEA-bearing table across the
 * control DB + all tenant DBs using pg_total_relation_size (catalog lookup, no
 * table scan → fast and cheap). Deletes/changes nothing. Used to prioritise the
 * R2 migration by real size.
 * ========================================================================== */
'use strict';
const control = require('../../control/db');
const tenantPoolMod = require('../../utils/tenantPool');

const SQL = `
  SELECT c.table_name AS t,
         pg_total_relation_size(('public.' || quote_ident(c.table_name))::regclass) AS bytes
    FROM (SELECT DISTINCT table_name
            FROM information_schema.columns
           WHERE data_type = 'bytea' AND table_schema = 'public') c`;

function _add(map, table, bytes) {
  if (!map[table]) map[table] = { table, mb: 0, tenants: 0 };
  map[table].mb += bytes / 1048576;
  map[table].tenants += 1;
}

async function report() {
  const agg = {}; const errors = [];
  // control DB
  try {
    const r = await control.query(SQL);
    r.rows.forEach(x => _add(agg, 'control:' + x.t, Number(x.bytes) || 0));
  } catch (e) { errors.push({ scope: 'control', err: String(e.message).slice(0, 120) }); }
  // tenant DBs
  const slugs = (await control.query(
    "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 2000")).rows.map(x => x.slug);
  let scanned = 0;
  for (const slug of slugs) {
    try {
      const t = await control.findOneBy('tenants', 'slug', slug);
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      const r = await pool.query(SQL);
      r.rows.forEach(x => _add(agg, x.t, Number(x.bytes) || 0));
      scanned++;
    } catch (e) { errors.push({ tenant: slug, err: String(e.message).slice(0, 100) }); }
  }
  const tables = Object.values(agg)
    .map(x => ({ table: x.table, total_mb: +x.mb.toFixed(2), tenants_with_table: x.tenants }))
    .sort((a, b) => b.total_mb - a.total_mb);
  const grand = tables.reduce((s, x) => s + x.total_mb, 0);
  return { tenants_scanned: scanned, grand_total_mb: +grand.toFixed(2), tables, errors: errors.slice(0, 20) };
}

module.exports = { report };
