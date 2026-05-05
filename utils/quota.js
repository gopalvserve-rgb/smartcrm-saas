/**
 * Tenant quota enforcement — single source of truth.
 *
 * Each package has a `quotas` JSONB column on the control plane. Shape:
 *
 *   {
 *     "users":         { "limit": 5,    "period": "one_time"  },
 *     "leads":         { "limit": 1000, "period": "per_month" },
 *     "whatsapp_send": { "limit": 5000, "period": "per_month" }
 *   }
 *
 *   limit = -1   → unlimited (skip the check)
 *   limit = 0    → blocked (treat exactly like exceeded)
 *   period = "one_time"   → count all rows ever
 *          = "per_month"  → count rows in the current calendar month
 *
 * Storage notes
 *   - Stored as JSONB so we don't have to migrate the schema every time
 *     someone wants to add another metric.
 *   - The Admin UI exposes three friendly number inputs and writes back
 *     into this exact shape; old packages that have free-form JSON
 *     keep working unchanged.
 *
 * How callers use this:
 *
 *   const { requireQuota } = require('../../utils/quota');
 *   await requireQuota(req.tenant, 'leads');
 *
 * Throws a quotaExceededError with .quotaExceeded = true so server.js's
 * dispatcher can map it to HTTP 402 (Payment Required) — Stripe's
 * standard "user has hit their plan ceiling" status.
 */
const tenantPool = require('./tenantPool');
const control = require('../control/db');

/* ------------------------------------------------------------------ *
 * Per-metric usage counters. Each takes the tenant pool + period and
 * returns a number (rows counted in that DB / period scope).
 *
 * Always uses the per-tenant pool directly — explicitly NOT going
 * through the AsyncLocalStorage-pooled db/pg.js, because we want this
 * to work identically whether called from a request handler (where
 * ALS is set) or from a control-plane reporting endpoint (where it
 * isn't). The pool is passed in explicitly.
 * ------------------------------------------------------------------ */
const COUNTERS = {
  users: async (pool /*, period */) => {
    // Always count active users only — soft-deleted (is_active=0)
    // shouldn't take up a seat.
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE is_active = 1`);
    return r.rows[0].c;
  },

  leads: async (pool, period) => {
    // Lead count filtered by created_at if period is per_month.
    if (period === 'per_month') {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM leads
          WHERE created_at >= date_trunc('month', NOW())
            AND created_at <  date_trunc('month', NOW()) + INTERVAL '1 month'`
      );
      return r.rows[0].c;
    }
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM leads`);
    return r.rows[0].c;
  },

  whatsapp_send: async (pool, period) => {
    // Outbound WA messages — direction='out' on whatsapp_messages.
    // Default to per_month for this metric since "all-time WA sends"
    // is rarely useful as a billing metric.
    if (period === 'per_month' || !period) {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM whatsapp_messages
          WHERE direction = 'out'
            AND created_at >= date_trunc('month', NOW())
            AND created_at <  date_trunc('month', NOW()) + INTERVAL '1 month'`
      );
      return r.rows[0].c;
    }
    const r = await pool.query(`SELECT COUNT(*)::int AS c FROM whatsapp_messages WHERE direction = 'out'`);
    return r.rows[0].c;
  }
};

/**
 * Read + normalise the package quota for a tenant. Returns
 *   { limit: number, period: 'one_time' | 'per_month' }
 * or `null` when this metric isn't gated for the tenant.
 *
 * `null` ↔ unlimited path so callers can skip COUNTING entirely
 * (counts can be expensive on big tables — don't pay the cost when
 * we know there's no ceiling).
 */
async function _getQuotaForMetric(tenant, metric) {
  if (!tenant || !tenant.package_id) return null;
  const pkg = await control.findById('packages', tenant.package_id);
  if (!pkg) return null;
  let q = pkg.quotas;
  if (!q) return null;
  if (typeof q === 'string') {
    try { q = JSON.parse(q); } catch (_) { return null; }
  }
  const m = q[metric];
  if (!m) return null;
  const limit = Number(m.limit);
  if (!Number.isFinite(limit) || limit === -1) return null;   // unlimited
  const period = (m.period === 'per_month') ? 'per_month' : 'one_time';
  return { limit, period };
}

/**
 * Compute current usage for a tenant + metric without enforcing.
 * Useful for tenant Settings pages ("You've used 437 / 1,000 leads
 * this month"). Returns:
 *   { metric, limit, used, remaining, period, exceeded, percent }
 * or null if there's no quota configured (treat as unlimited).
 */
async function getUsage(tenant, metric) {
  const q = await _getQuotaForMetric(tenant, metric);
  if (!q) return null;
  const counter = COUNTERS[metric];
  if (!counter) return null;
  const pool = tenantPool.poolFor(tenant);
  if (!pool) return null;
  const used = await counter(pool, q.period);
  const limit = q.limit;
  const remaining = Math.max(0, limit - used);
  return {
    metric, limit, used, remaining, period: q.period,
    exceeded: used >= limit,
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100
  };
}

/**
 * Throw if the tenant has hit (or is about to hit) its quota for the
 * given metric. Pass `addBy = N` for bulk operations (e.g. a CSV upload
 * that would create 250 leads in one go) so we reject the whole batch
 * before any rows are written.
 *
 * No-op when:
 *   - tenant is null (control plane / single-tenant fallback)
 *   - the metric isn't configured on the package (treat as unlimited)
 *   - the package's quota object doesn't include this metric
 *
 * Throws an Error with .quotaExceeded = true + .status = 402 so the
 * dispatcher can translate it cleanly.
 */
async function requireQuota(tenant, metric, addBy) {
  const inc = Math.max(1, Number(addBy) || 1);
  const usage = await getUsage(tenant, metric);
  if (!usage) return;
  if (usage.used + inc > usage.limit) {
    const e = new Error(
      `Plan limit reached for "${metric}": used ${usage.used} of ${usage.limit}` +
      (usage.period === 'per_month' ? ' this month' : '') +
      (inc > 1 ? ` (request adds ${inc})` : '') +
      '. Upgrade the workspace plan to continue.'
    );
    e.quotaExceeded = true;
    e.status = 402;
    e.metric = metric;
    e.usage = usage;
    e.requested = inc;
    throw e;
  }
}

module.exports = {
  requireQuota,
  getUsage,
  // Listed metrics so the admin Packages page can build the form
  // without hard-coding its own copy of the names.
  METRICS: Object.keys(COUNTERS)
};
