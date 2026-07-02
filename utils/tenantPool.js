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

// POOL_FIX_v2 (2026-06-25) — bje tenant's AI Bot page fires ~20 parallel
// API calls on load. With per-tenant max=2 those queued behind 2 slots
// and the SPA showed 30-130s response times. Bump back to 3 (matches
// pre-POOL_FIX_v1) but keep LRU at 60 so more tenants stay warm.
//   Net: 60 × 3 = 180 + 5 control = 185, fits Railway Pro PG (200).
//   On Hobby (100 max), set env PG_POOL_LRU_MAX=30 PG_POOL_PER_TENANT_MAX=2.
const POOL_PER_TENANT_MAX = Number(process.env.PG_POOL_PER_TENANT_MAX || 3);
const POOL_LRU_MAX        = Number(process.env.PG_POOL_LRU_MAX || 60);

// POOL_EVICT_RACE_FIX_v1 (2026-06-27) — root cause of recurring
// 'Cannot use a pool after calling end on the pool'.
// attachTenant() grabs poolFor(t) and stashes req.tenantPool at the TOP of
// the middleware chain, but the handler's first DB query runs much later.
// In that gap the pool has totalCount===0 / waitingCount===0 (no client
// checked out yet) so it looks 'idle' and the LRU pass would .end() it —
// then the in-flight request crashes on its first query. The busy-count
// check (FB_OAUTH_POOL_FIX_v2) can't see a pool that's been handed out but
// not yet connected. Two guards close the race:
//   (a) recency grace: never evict a pool handed out within EVICT_GRACE_MS
//       (poolFor() refreshes _poolLastUsed on every hand-out, so any
//        in-flight request keeps its pool 'recent' and protected).
//   (b) drain delay: when we do evict, remove from the cache immediately
//       (no new caller can get it) but defer p.end() by EVICT_DRAIN_MS so
//       any reference that already escaped finishes its query first.
const EVICT_GRACE_MS = Number(process.env.PG_POOL_EVICT_GRACE_MS || 30_000);
const EVICT_DRAIN_MS = Number(process.env.PG_POOL_EVICT_DRAIN_MS || 15_000);

const _pools = new Map();          // db_name -> pg.Pool
const _poolLastUsed = new Map();   // db_name -> ts (for LRU eviction)
const _slugCache = new Map();      // slug -> { tenant row, expiresAt }
const SLUG_TTL_MS = 30 * 1000;     // 30s — long enough to be hot, short enough that suspends/upgrades are picked up quickly

// Evict the least-recently-used pool when we exceed POOL_LRU_MAX.
function _evictIfNeeded() {
  if (_pools.size <= POOL_LRU_MAX) return;
  // Find the oldest entry that is safe to evict. A pool is NOT safe if:
  //   • it has connections checked out or queued (totalCount/waitingCount>0)
  //     — FB_OAUTH_POOL_FIX_v2, covers actively-querying requests; OR
  //   • it was handed out within EVICT_GRACE_MS — POOL_EVICT_RACE_FIX_v1,
  //     covers requests that grabbed the pool but haven't queried yet.
  const now = Date.now();
  const sorted = [..._poolLastUsed.entries()].sort((a, b) => a[1] - b[1]);
  let evicted = false;
  for (const [k, lastUsed] of sorted) {
    const p = _pools.get(k);
    const busy   = p && ((p.totalCount > 0) || (p.waitingCount > 0));
    const recent = (now - (lastUsed || 0)) < EVICT_GRACE_MS;
    if (busy || recent) continue;
    // Pull it from the cache NOW so no new caller can receive it...
    _pools.delete(k);
    _poolLastUsed.delete(k);
    // ...but defer the actual .end() so any reference that already escaped
    // (handed out < EVICT_GRACE_MS ago and now mid-query) drains cleanly.
    if (p) {
      const t = setTimeout(() => { try { p.end().catch(() => {}); } catch (_) {} }, EVICT_DRAIN_MS);
      if (t && typeof t.unref === 'function') t.unref();
    }
    console.log('[tenant-pool] LRU evicted', k, '(drain ' + EVICT_DRAIN_MS + 'ms) cache size now', _pools.size);
    evicted = true;
    break;
  }
  if (!evicted && _pools.size > POOL_LRU_MAX) {
    // Every pool is either busy or freshly handed out — defer eviction.
    // Pools are short-lived (idleTimeout 10s) so capacity recovers on its
    // own; temporarily holding a few extra pools is far safer than ending
    // one out from under an in-flight request.
    console.warn('[tenant-pool] LRU at capacity but all pools busy/recent — deferring eviction. pools=' + _pools.size);
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
    // WARM_CONN_v1 (2026-07-02) — during Railway's packet-loss incident,
    // opening a fresh DB connection took ~6-10s, and the old 10s idle timeout
    // dropped connections between clicks so almost every request re-paid that
    // handshake. Keep connections WARM: TCP keepAlive so the socket isn't
    // dropped while idle, and a longer idle timeout (10s -> 2min) so a normal
    // click-gap reuses the existing connection instead of reconnecting.
    // REVERT: set idleTimeoutMillis back to 10_000 and drop the keepAlive lines.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    idleTimeoutMillis: 120_000,
    // POOL_FIX_v1 — bumped 5s → 12s. Was timing out on login when PG was
    // momentarily saturated by background sweeps; 12s gives the LRU enough
    // breathing room to evict an idle pool and recover.
    connectionTimeoutMillis: 12_000
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
