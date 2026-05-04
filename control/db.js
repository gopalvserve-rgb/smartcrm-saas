/**
 * Control-plane Postgres connection + helpers.
 *
 * The control DB (smartcrm_control) holds packages, tenants, invoices,
 * payments, super-admins, audit log — i.e. everything platform-wide.
 * Tenant-specific data lives in per-tenant DBs (see utils/tenantPool.js).
 *
 * Every export here is sync-safe to call at module load — the actual
 * pg.Pool is lazily instantiated on first use, so requiring this file
 * during boot doesn't open a connection.
 */
const { Pool } = require('pg');

let _pool = null;

function pool() {
  if (_pool) return _pool;
  const url = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error('CONTROL_DATABASE_URL (or DATABASE_URL) env var is required for the control plane');
  }
  _pool = new Pool({
    connectionString: url,
    // Railway's managed Postgres requires SSL; local dev usually doesn't.
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(url) ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000
  });
  _pool.on('error', err => console.error('[control-db] pool error:', err.message));
  return _pool;
}

async function query(sql, params) {
  return pool().query(sql, params);
}

/**
 * Get a single row by id from a table. Returns null if not found.
 */
async function findById(table, id) {
  const r = await query(`SELECT * FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  return r.rows[0] || null;
}

async function findOneBy(table, column, value) {
  const r = await query(`SELECT * FROM ${table} WHERE ${column} = $1 LIMIT 1`, [value]);
  return r.rows[0] || null;
}

async function getAll(table, where, params) {
  const sql = where ? `SELECT * FROM ${table} WHERE ${where} ORDER BY id ASC` : `SELECT * FROM ${table} ORDER BY id ASC`;
  const r = await query(sql, params || []);
  return r.rows;
}

/**
 * Tables whose columns we trust the caller to supply. The control
 * plane is small enough that we don't need a per-table whitelist —
 * insert() / update() will silently allow any column the caller
 * passes, but Postgres itself rejects unknown columns at the SQL
 * layer, so a typo throws cleanly. Listed here for grep discoverability:
 *
 *   super_admins, packages, tenants, invoices, payments, saas_settings,
 *   platform_announcements, custom_requirements, audit_log, signups,
 *   cashfree_webhook_logs
 */

/**
 * Generic insert. Returns the inserted row's id.
 *   await insert('packages', { name: '...', base_price_inr: 999 })
 */
async function insert(table, data) {
  const cols = Object.keys(data);
  if (!cols.length) throw new Error('insert(): no columns provided');
  const vals = cols.map((c, i) => '$' + (i + 1));
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING id`;
  const r = await query(sql, cols.map(c => data[c]));
  return r.rows[0].id;
}

/**
 * Generic update by id.
 */
async function update(table, id, data) {
  const cols = Object.keys(data);
  if (!cols.length) return;
  const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const sql = `UPDATE ${table} SET ${sets}, updated_at = NOW() WHERE id = $${cols.length + 1}`;
  await query(sql, [...cols.map(c => data[c]), id]);
}

/**
 * SaaS settings (key/value). Falls back to env var if the row is missing
 * — handy for bootstrap when the DB exists but settings haven't been
 * configured yet via the admin panel.
 */
async function getSetting(key, fallback) {
  try {
    const r = await query('SELECT value FROM saas_settings WHERE key = $1 LIMIT 1', [key]);
    if (r.rows[0] && r.rows[0].value != null) return r.rows[0].value;
  } catch (_) {}
  return process.env[key] || fallback;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO saas_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

/**
 * Run the schema.sql file once on startup. Idempotent (CREATE TABLE IF NOT EXISTS).
 */
async function migrate() {
  const fs = require('fs');
  const path = require('path');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await query(sql);
}

function nowIso() { return new Date().toISOString(); }

module.exports = {
  pool, query, migrate,
  findById, findOneBy, getAll, insert, update,
  getSetting, setSetting,
  nowIso
};
