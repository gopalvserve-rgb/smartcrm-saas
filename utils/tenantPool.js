/**
 * Per-tenant Postgres connection-pool cache.
 *
 * Each tenant has its own database (tenant_<slug>). We keep a small
 * Map<slug, pg.Pool> so requests don't pay the connect-on-every-call
 * penalty. Pools are lazily created on first use and reused.
 *
 * If a tenant gets deleted we DON'T need to .end() the pool eagerly —
 * the next request will fail to connect, the wrapper resolves to null
 * and the route returns 404. Still, removeTenant() is provided for
 * cleanliness so admin "delete tenant" can release the pool.
 */
const { Pool } = require('pg');
const control = require('../control/db');

const _pools = new Map();
const _slugCache = new Map();   // slug -> { tenant row, expiresAt }
const SLUG_TTL_MS = 30 * 1000;  // 30s — long enough to be hot, short enough that suspends/upgrades are picked up quickly

/**
 * Build a Postgres URL for a specific tenant DB. We parse the control
 * URL once and just swap the database name on the end.
 */
function _tenantUrl(dbName) {
  const base = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  if (!base) throw new Error('No DATABASE_URL configured');
  // Replace the path component (the trailing /<db>) with /<dbName>.
  // URL parsing is robust enough — Railway gives us something like
  //   postgres://user:pass@host:5432/railway?sslmode=require
  const u = new URL(base);
  u.pathname = '/' + dbName;
  return u.toString();
}

/**
 * Return the pg.Pool for this tenant. Creates one if not cached.
 */
function poolFor(tenant) {
  if (!tenant || !tenant.db_name) return null;
  if (_pools.has(tenant.db_name)) return _pools.get(tenant.db_name);
  const url = _tenantUrl(tenant.db_name);
  const p = new Pool({
    connectionString: url,
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(url) ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000
  });
  p.on('error', err => console.error('[tenant-db]', tenant.slug, 'pool error:', err.message));
  _pools.set(tenant.db_name, p);

  // Centralised tenant bootstrap — runs all accumulated schema deltas
  // + seeds default config keys. Fire-and-forget so we don't block the
  // first request that triggered pool creation. The runner is
  // idempotent and remembers which migrations have run via the
  // _tenant_migrations table, so the cost on subsequent boots is
  // basically zero. This is the single durable answer to 'how will
  // future tenants avoid missing-column / missing-default bugs?'.
  setImmediate(() => {
    try {
      const { ensureTenantReady } = require('./tenantBootstrap');
      ensureTenantReady(p).catch(e => console.warn('[tenant-bootstrap]', tenant.slug, 'async fail:', e && e.message));
    } catch (e) {
      console.warn('[tenant-bootstrap]', tenant.slug, 'load fail:', e && e.message);
    }
  });

  return p;
}

/**
 * Look up a tenant row by URL slug, with a short cache.
 * Returns the tenant row (or null if not found / suspended / deleted).
 *
 * Active statuses that should serve traffic: 'active', 'trial', 'past_due'.
 * 'pending_delete' tenants get read-only banner-warned access (handled
 * higher up). 'suspended' / 'deleted' / 'pending_payment' return null
 * so the request 404s.
 */
async function findActiveTenant(slug) {
  const now = Date.now();
  const cached = _slugCache.get(slug);
  if (cached && cached.expiresAt > now) return cached.row;
  const r = await control.query(
    `SELECT * FROM tenants WHERE slug = $1 LIMIT 1`,
    [String(slug || '').toLowerCase()]
  );
  const t = r.rows[0] || null;
  _slugCache.set(slug, { row: t, expiresAt: now + SLUG_TTL_MS });
  return t;
}

/**
 * Force the cache to drop a slug — call this after admin updates a tenant.
 */
function invalidateSlug(slug) {
  _slugCache.delete(slug);
}

/**
 * Drop the pool for a tenant (after deletion). Best-effort.
 */
async function removeTenant(slug, dbName) {
  invalidateSlug(slug);
  const p = _pools.get(dbName);
  if (p) {
    try { await p.end(); } catch (_) {}
    _pools.delete(dbName);
  }
}

module.exports = {
  poolFor, findActiveTenant, invalidateSlug, removeTenant
};
