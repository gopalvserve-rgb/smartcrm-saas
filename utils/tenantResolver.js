/**
 * Express middleware: figure out which tenant this request is for and
 * attach the tenant row + Postgres pool to req.
 *
 * Routing convention:
 *   GET  /                       → public landing
 *   POST /api/saas/...           → public + admin SaaS APIs
 *   GET  /admin/*                → super-admin SPA (no tenant context)
 *   GET  /t/<slug>/*             → tenant CRM SPA
 *   POST /api                    → tenant API dispatcher (slug from header / cookie)
 *   POST /hook/cashfree          → Cashfree webhook (no tenant — control plane)
 *
 * We resolve the slug from the URL path FIRST, then fall back to a
 * `x-tenant-slug` header (used by the tenant SPA's xhr calls). If no
 * tenant is matched, req.tenant stays null and downstream routes can
 * decide whether to require it.
 */
const tenantPool = require('./tenantPool');

const TENANT_PATH_RX = /^\/t\/([a-z0-9-]+)(\/.*)?$/i;

async function attachTenant(req, _res, next) {
  let slug = null;
  // 1. From the URL path: /t/<slug>/...
  const m = TENANT_PATH_RX.exec(req.path);
  if (m) {
    slug = m[1].toLowerCase();
    // Rewrite req.url so downstream routes see the un-prefixed path.
    // /t/acme/api/leads → /api/leads
    req.url = (m[2] || '/') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  }
  // 2. From the explicit header (set by the SPA's api() helper)
  if (!slug && req.headers['x-tenant-slug']) {
    slug = String(req.headers['x-tenant-slug']).toLowerCase();
  }
  if (!slug) { req.tenant = null; return next(); }

  try {
    const t = await tenantPool.findActiveTenant(slug);
    if (!t) { req.tenant = null; req.tenantSlug = slug; return next(); }
    req.tenant = t;
    req.tenantSlug = slug;
    req.tenantPool = tenantPool.poolFor(t);
  } catch (e) {
    console.error('[tenantResolver]', slug, e.message);
    req.tenant = null;
  }
  next();
}

/**
 * Helper for routes that require a tenant. Use after attachTenant.
 */
function requireTenant(req, res, next) {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found: ' + (req.tenantSlug || '?') });
  const status = req.tenant.status;
  if (status === 'suspended') return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
  if (status === 'deleted')   return res.status(404).json({ error: 'This account has been deleted.' });
  if (status === 'pending_payment') return res.status(402).json({ error: 'Payment required to activate this account.' });
  // pending_delete — still readable; downstream UI shows a banner
  next();
}

module.exports = { attachTenant, requireTenant };
