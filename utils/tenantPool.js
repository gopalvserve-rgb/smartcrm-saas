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

// POOL_EVICT_v1 (2026-05-22) — Per-tenant pools have caused
// 'sorry, too many clients already' errors on Postgres. With 30+
// tenants × max=10 = 300 potential connections, we blew past Postgres
// max_connections (typically 100-200). Fix:
//   • Each tenant pool now max=3 (most tenants have 1-3 concurrent users)
//   • idleTimeoutMillis lowered 30s → 10s so dormant connections release fast
//   • connectionTimeoutMillis=5s — requests fail fast if the DB is saturated
//     instead of piling up and amplifying the problem
//   • LRU eviction: at most POOL_LRU_MAX (default 25) tenant pools cached;
//     least-recently-used pools get .end()'d
//
// Net effect: 25 tenants × max 3 = 75 connections + control pool max 10 =
// 85 connections total, safely under Postgres limits even on small plans.

const POOL_PER_TENANT_MAX = Number(process.env.PG_POOL_PER_TENANT_MAX || 3);
const POOL_LRU_MAX        = Number(process.env.PG_POOL_LRU_MAX || 25);

const _pools = new Map();          // db_name -> pg.Pool
const _poolLastUsed = new Map();   // db_name -> ts (for LRU eviction)
const _slugCache = new Map();      // slug -> { tenant row, expiresAt }
const SLUG_TTL_MS = 30 * 1000;     // 30s — long enough to be hot, short enough that suspends/upgrades are picked up quickly

// Evict the least-recently-used pool when we exceed POOL_LRU_MAX.
function _evictIfNeeded() {
  if (_pools.size <= POOL_LRU_MAX) return;
  // FB_OAUTH_POOL_FIX_v2 — find the oldest entry that is NOT currently busy.
  // Previously we ended pools mid-OAuth (a long /fb/auth/callback was using
  // the pool, then a LRU eviction ended it, and the in-flight query crashed
  // with 'Cannot use a pool after calling end on the pool'). We now skip
  // any pool that has active clients (totalCount includes in-use + idle,
  // waitingCount is queued requests — if either is > 0 the pool is in use).
  const sorted = [..._poolLastUsed.entries()].sort((a, b) => a[1] - b[1]);
  let evicted = false;
  for (const [k] of sorted) {
    const p = _pools.get(k);
    const busy = p && ((p.totalCount > 0) || (p.waitingCount > 0));
    if (busy) continue;
    _pools.delete(k);
    _poolLastUsed.delete(k);
    if (p) { try { p.end().catch(() => {}); } catch (_) {} }
    console.log('[tenant-pool] LRU evicted', k, 'cache size now', _pools.size);
    evicted = true;
    break;
  }
  if (!evicted && _pools.size > POOL_LRU_MAX) {
    // Every pool is busy — defer eviction; pools are short-lived so
    // they'll become idle soon. Logging only.
    console.warn('[tenant-pool] LRU at capacity but every pool is busy — deferring eviction. pools=' + _pools.size);
  }
}

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
  if (_pools.has(tenant.db_name)) {
    _poolLastUsed.set(tenant.db_name, Date.now());
    return _pools.get(tenant.db_name);
  }
  const url = _tenantUrl(tenant.db_name);
  const p = new Pool({
    connectionString: url,
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(url) ? { rejectUnauthorized: false } : false,
    max: POOL_PER_TENANT_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000
  });
  p.on('error', err => console.error('[tenant-db]', tenant.slug, 'pool error:', err.message));
  _pools.set(tenant.db_name, p);
  _poolLastUsed.set(tenant.db_name, Date.now());
  _evictIfNeeded();

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
    _poolLastUsed.delete(dbName);
  }
}

// Expose pool stats for the super-admin diagnostic page.
function getPoolStats() {
  const arr = [];
  for (const [dbName, p] of _pools.entries()) {
    arr.push({
      db_name: dbName,
      total: p.totalCount,
      idle: p.idleCount,
      waiting: p.waitingCount,
      last_used: _poolLastUsed.get(dbName) || 0
    });
  }
  return {
    cached_pools: _pools.size,
    lru_max: POOL_LRU_MAX,
    per_tenant_max: POOL_PER_TENANT_MAX,
    total_connections: arr.reduce((s, x) => s + x.total, 0),
    pools: arr.sort((a, b) => b.last_used - a.last_used)
  };
}

module.exports = {
  poolFor, findActiveTenant, invalidateSlug, removeTenant, getPoolStats
};
