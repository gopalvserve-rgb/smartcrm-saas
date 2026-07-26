/* ============================================================================
 * CAT_R2_MIGRATE_v1 + VACUUM_v1 — temporary maintenance helpers.
 *  - migrateCatalogue: move wa_catalogue_media.bytes → R2 (byte-verified, then
 *    null bytes to reclaim space). Download handler falls back to R2.
 *  - vacuumTenant: VACUUM FULL on lead_recordings + ai_kb_documents to return
 *    the space freed by the recordings purge / KB move back to disk.
 * ========================================================================== */
'use strict';
const control = require('../../control/db');
const tenantPoolMod = require('../../utils/tenantPool');
const r2store = require('../../utils/r2store');

async function _pool(slug) {
  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('tenant not found: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('pool unavailable: ' + slug);
  return pool;
}

async function catalogueTenants() {
  const slugs = (await control.query(
    "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 2000")).rows.map(x => x.slug);
  const out = [];
  for (const slug of slugs) {
    try {
      const pool = await _pool(slug);
      const q = await pool.query(
        `SELECT COUNT(*)::int c, COALESCE(SUM(octet_length(bytes)),0)::bigint b
           FROM wa_catalogue_media WHERE bytes IS NOT NULL`).catch(() => ({ rows: [{ c: 0, b: 0 }] }));
      if ((q.rows[0].c | 0) > 0) out.push({ tenant: slug, pending: q.rows[0].c | 0, mb: +((Number(q.rows[0].b) || 0) / 1048576).toFixed(2) });
    } catch (_) {}
  }
  return out;
}

async function migrateCatalogue(slug, limit) {
  if (!r2store.isConfigured()) throw new Error('R2 not configured');
  limit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const pool = await _pool(slug);
  await pool.query(`ALTER TABLE wa_catalogue_media ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});
  const rows = (await pool.query(
    `SELECT token, mime, filename, bytes FROM wa_catalogue_media
      WHERE bytes IS NOT NULL AND (r2_key IS NULL OR r2_key = '') ORDER BY created_at ASC LIMIT $1`, [limit])).rows;
  let moved = 0; const errs = [];
  for (const row of rows) {
    try {
      let buf = row.bytes; if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
      const key = await r2store.put({
        tenant: slug, category: 'catalogue', filename: row.token + '-' + (row.filename || 'file'),
        body: buf, contentType: row.mime || 'application/octet-stream',
      });
      const back = await r2store.getBuffer(key, 'catalogue');
      if (back.length !== buf.length) throw new Error('size mismatch');
      await pool.query('UPDATE wa_catalogue_media SET r2_key = $1, bytes = NULL WHERE token = $2', [key, row.token]);
      moved++;
    } catch (e) { errs.push({ token: row.token, err: String(e.message || e).slice(0, 120) }); }
  }
  const remaining = (await pool.query(
    `SELECT COUNT(*)::int c FROM wa_catalogue_media WHERE bytes IS NOT NULL AND (r2_key IS NULL OR r2_key = '')`)).rows[0].c;
  return { tenant: slug, moved, remaining, errors: errs };
}

/** VACUUM FULL the bloated tables for one tenant. Locks each table briefly. */
async function vacuumTenant(slug) {
  const pool = await _pool(slug);
  const done = []; const errs = [];
  for (const tbl of ['lead_recordings', 'ai_kb_documents']) {
    try {
      const before = (await pool.query(
        `SELECT pg_total_relation_size(('public.'||$1)::regclass) AS b`, [tbl])).rows[0].b;
      await pool.query(`VACUUM (FULL) ${tbl}`);
      const after = (await pool.query(
        `SELECT pg_total_relation_size(('public.'||$1)::regclass) AS b`, [tbl])).rows[0].b;
      done.push({ table: tbl, before_mb: +((Number(before) || 0) / 1048576).toFixed(1), after_mb: +((Number(after) || 0) / 1048576).toFixed(1) });
    } catch (e) { errs.push({ table: tbl, err: String(e.message || e).slice(0, 120) }); }
  }
  return { tenant: slug, tables: done, errors: errs };
}

module.exports = { catalogueTenants, migrateCatalogue, vacuumTenant };
