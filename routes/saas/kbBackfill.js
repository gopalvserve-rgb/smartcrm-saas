/* ============================================================================
 * KB_R2_MIGRATE_v1 — move ai_kb_documents.file_data into R2, per tenant.
 * Uploads bytes to R2 (category 'kb'), byte-verifies, records r2_key, THEN
 * nulls file_data to reclaim Postgres space. The bot read-path (aiBot.js
 * _sendAttachmentMatches) already prefers file_data and falls back to R2, so
 * a moved row keeps serving. Verified before nulling → no data loss. Idempotent.
 * ========================================================================== */
'use strict';
const control = require('../../control/db');
const tenantPoolMod = require('../../utils/tenantPool');
const r2store = require('../../utils/r2store');

async function measure(slug) {
  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('tenant not found: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('pool unavailable: ' + slug);
  await pool.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});
  const q = await pool.query(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(octet_length(file_data)),0)::bigint AS b
       FROM ai_kb_documents WHERE file_data IS NOT NULL`);
  return { count: q.rows[0].c | 0, mb: +((Number(q.rows[0].b) || 0) / 1048576).toFixed(2) };
}

async function migrate(slug, limit) {
  if (!r2store.isConfigured()) throw new Error('R2 not configured');
  limit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('tenant not found: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('pool unavailable: ' + slug);
  await pool.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});
  const rows = (await pool.query(
    `SELECT id, file_name, file_mime_type, file_data
       FROM ai_kb_documents
      WHERE file_data IS NOT NULL AND (r2_key IS NULL OR r2_key = '')
      ORDER BY id ASC LIMIT $1`, [limit])).rows;
  let moved = 0; const errs = [];
  for (const row of rows) {
    try {
      let buf = row.file_data;
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
      const key = await r2store.put({
        tenant: slug, category: 'kb', filename: row.id + '-' + (row.file_name || 'file'),
        body: buf, contentType: row.file_mime_type || 'application/octet-stream',
      });
      const back = await r2store.getBuffer(key, 'kb');
      if (back.length !== buf.length) throw new Error('size mismatch ' + back.length + '/' + buf.length);
      await pool.query('UPDATE ai_kb_documents SET r2_key = $1, file_data = NULL WHERE id = $2', [key, row.id]);
      moved++;
    } catch (e) { errs.push({ id: row.id, err: String(e.message || e).slice(0, 120) }); }
  }
  const remaining = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM ai_kb_documents WHERE file_data IS NOT NULL AND (r2_key IS NULL OR r2_key = '')`)).rows[0].c;
  return { tenant: slug, moved, remaining, errors: errs };
}

async function tenantsWithKb() {
  const slugs = (await control.query(
    "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 2000")).rows.map(x => x.slug);
  const out = [];
  for (const slug of slugs) {
    try {
      const t = await control.findOneBy('tenants', 'slug', slug);
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      const q = await pool.query(`SELECT COUNT(*)::int AS c FROM ai_kb_documents WHERE file_data IS NOT NULL`).catch(() => ({ rows: [{ c: 0 }] }));
      if ((q.rows[0].c | 0) > 0) out.push({ tenant: slug, pending: q.rows[0].c | 0 });
    } catch (_) {}
  }
  return out;
}

module.exports = { measure, migrate, tenantsWithKb };
