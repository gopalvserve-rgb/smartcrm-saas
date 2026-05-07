/**
 * Tenant API dispatcher — the per-tenant POST /api endpoint.
 *
 * This is the SaaS equivalent of the original Celeste server.js dispatcher:
 * it loads every /routes/* module, builds a name→handler map of every
 * exported `api_*` function, and dispatches { fn, args } JSON requests
 * to them.
 *
 * What's different from the single-tenant Celeste version:
 *   - the route files import ../db/pg, which (in this repo) uses
 *     AsyncLocalStorage to pick the right per-tenant pg.Pool. The
 *     server.js attachTenantApiContext middleware wraps the request
 *     in tenantStorage.run({ pool }) so any DB call from inside a
 *     handler hits tenant_<slug>, not the control DB.h
 *   - we expose a small SSO-login exchange: when the magic link from
 *     /admin → "Login as tenant" arrives with ?ssl=<jwt>, the SPA hits
 *     api_auth_ssoLogin which verifies the token, finds (or creates)
 *     the matching admin user in the tenant DB, and mints a regular
 *     tenant JWT so the rest of the SPA works unchanged.
 *
 * Adding a new route file: drop it in /routes/<name>.js, export
 * functions named api_*, and require() it below. No other wiring
 * needed — the dispatcher picks it up automatically.
 */
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const db = require('../../db/pg');
const quota = require('../../utils/quota');
// Optional platform error logging — writes to the control DB so the
// super-admin /admin/#/errors view picks them up. Absent in single-
// tenant deployments — gracefully skipped.
let errorLogs;
try { errorLogs = require('./errorLogs'); } catch (_) {}

/**
 * Map of fn-names that consume a quota slot. The `metric` is the key
 * inside packages.quotas (see utils/quota.js). The `count` callback
 * computes how many slots this specific call would consume — most
 * are 1, but bulk operations (CSV upload, bulk-WA) need to look at
 * the args to size the request properly.
 *
 * Listed explicitly rather than guessed-by-pattern so a typo or a
 * new endpoint doesn't accidentally bypass enforcement.
 */
const QUOTA_GATES = {
  // Each user-create burns one seat
  api_users_save: { metric: 'users', count: (args) => {
    // api_users_save(token, user) — only count NEW users (no id)
    const u = args && args[1];
    return (u && !u.id) ? 1 : 0;
  } },
  // Each lead-create burns one slot. Bulk uploads count as N.
  api_leads_create: { metric: 'leads', count: () => 1 },
  api_leads_bulkCreate: { metric: 'leads', count: (args) => {
    // api_leads_bulkCreate(token, rows, assign) → rows is the array
    const rows = args && args[1];
    return Array.isArray(rows) ? rows.length : 1;
  } },
  // Each outbound WA send burns one slot (1-to-1 chat send).
  api_wb_chat_send: { metric: 'whatsapp_send', count: () => 1 },
  // Bulk WhatsApp campaign — count by recipient list size if we can
  // get it, otherwise fall back to 1 (the campaign queue itself will
  // re-check per-message via api_wb_chat_send).
  api_wb_campaigns_send: { metric: 'whatsapp_send', count: (args) => {
    const p = args && args[1];
    if (p && Array.isArray(p.recipients)) return p.recipients.length;
    if (p && Number(p.recipients_total) > 0) return Number(p.recipients_total);
    return 1;
  } }
};

/**
 * Run the quota gate for an incoming dispatcher call. No-ops when
 * there's no tenant on the request (single-tenant deployments) or
 * when this fn isn't gated.
 */
async function _checkQuotaForCall(req, fn, args) {
  if (!req || !req.tenant) return;
  const gate = QUOTA_GATES[fn];
  if (!gate) return;
  const inc = Math.max(0, Number(gate.count(args)) || 0);
  if (inc <= 0) return;             // e.g. user UPDATE with id present — no new seat
  await quota.requireQuota(req.tenant, gate.metric, inc);
}

// All the route files that make up the tenant CRM. Listed explicitly
// rather than auto-loaded so a typo or stray file doesn't accidentally
// expose endpoints.
const ROUTE_FILES = [
  'auth', 'users', 'leads', 'admin',
  'customFields', 'tags', 'tat', 'whatsbot', 'whatsapp',
  'sources', 'products', 'statuses', 'rules',
  'notifications', 'reports', 'hr', 'fb',
  'automations', 'permissions', 'recordings', 'push',
  'knowledgeBase', 'announcements', 'chat',
  'savedFilters', 'customers', 'targets',
  'inventory', 'projectStages', 'personalWaTemplates',
  'integrations', 'roles'
];

const API = {};
for (const name of ROUTE_FILES) {
  const p = path.join(__dirname, '..', '..', 'routes', name + '.js');
  if (!fs.existsSync(p)) {
    console.warn('[tenantApi] route file missing, skipping:', name);
    continue;
  }
  try {
    const mod = require(p);
    for (const k of Object.keys(mod)) {
      if (typeof mod[k] === 'function' && k.startsWith('api_')) {
        API[k] = mod[k];
      }
    }
  } catch (e) {
    console.error('[tenantApi] failed to load', name + ':', e.message);
  }
}

// ---- SSO login: magic-link from /admin → "Login as tenant" ----
//
// Flow:
//   1. Admin clicks "🔓 Login as ↗" in /admin → Tenants
//   2. api_saas_tenants_loginAs mints a JWT { ssl, tenant_id, slug, as_email, sa_id, sa_email }
//   3. New tab opens at /t/<slug>/?ssl=<jwt>
//   4. Tenant SPA boots, sees ?ssl= in the URL, POSTs api_auth_ssoLogin
//   5. We verify the JWT, find the user with that email in this tenant
//      DB, and return a normal tenant JWT so the SPA can proceed.
//
// The check `payload.slug === req.tenantSlug` makes sure a token minted
// for tenant A can't be replayed against tenant B even if URLs are
// swapped.
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const TENANT_TOKEN_TTL = '30d';

/**
 * Tenant-side quota report. The SPA can call this to render
 * "Plan usage" cards (Settings → Plan) without rebuilding the
 * counters. Returns null per-metric when there's no quota set
 * for the package (i.e. unlimited).
 */
async function api_quota_report(_token /*, ignored */) {
  const store = (db.tenantStorage && db.tenantStorage.getStore()) || {};
  const tenant = store.tenant;
  if (!tenant) return { metrics: {}, package_id: null };
  const out = {};
  for (const metric of quota.METRICS) {
    try { out[metric] = await quota.getUsage(tenant, metric); }
    catch (_) { out[metric] = null; }
  }
  return { metrics: out, package_id: tenant.package_id };
}
API.api_quota_report = api_quota_report;

async function api_auth_ssoLogin(_token, payload) {
  const ssl = String((payload && payload.ssl) || '').trim();
  const expectedSlug = String((payload && payload.slug) || '').toLowerCase();
  if (!ssl)         throw new Error('Missing magic-link token');
  if (!expectedSlug) throw new Error('Missing slug');

  let claims;
  try { claims = jwt.verify(ssl, JWT_SECRET); }
  catch (_) { throw new Error('Magic link expired or invalid — please re-open from the admin panel'); }
  if (!claims || !claims.ssl) throw new Error('Not a sudo-login token');
  if (String(claims.slug || '').toLowerCase() !== expectedSlug) {
    throw new Error('Token issued for a different workspace');
  }

  const targetEmail = String(claims.as_email || '').toLowerCase().trim();
  if (!targetEmail) throw new Error('Token missing target email');

  // Find or create the admin user in the tenant DB. provisioning.js
  // already seeds an admin row with the contact email; this is a
  // safety net in case that row was deleted or someone added a new
  // admin email to the tenant manually.
  let user = await db.findOneBy('users', 'email', targetEmail);
  if (!user) {
    // Create a placeholder admin so the sudo-login still works. The
    // password is random — operator never uses it because they have
    // the magic link.
    const pwHash = bcrypt.hashSync('sudo-' + Math.random().toString(36).slice(2), 10);
    const id = await db.insert('users', {
      name: 'Admin (auto-created via sudo-login)',
      email: targetEmail,
      role: 'admin',
      password_hash: pwHash,
      is_active: 1,
      created_at: db.nowIso()
    });
    user = await db.findById('users', id);
  }
  if (Number(user.is_active) === 0) throw new Error('User account is inactive');

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, sso_by: claims.sa_email },
    JWT_SECRET,
    { expiresIn: TENANT_TOKEN_TTL }
  );
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    sudo_by: claims.sa_email
  };
}
API.api_auth_ssoLogin = api_auth_ssoLogin;

/**
 * Express handler for POST /api on a tenant request. The body shape is
 * { fn: 'api_xxx', args: [token, ...] } — same contract as the original
 * Celeste server.
 *
 * Important: we do NOT need to call db.tenantStorage.run() here —
 * server.js's attachTenantApiContext middleware has already done that
 * around the entire request, so any await chain inside the handler
 * sees the right tenant pool transparently.
 */
async function expressHandler(req, res) {
  const { fn, args } = req.body || {};
  if (!fn || !API[fn]) {
        const slug = (req.tenant && req.tenant.slug) || req.tenantSlug || 'unknown';
        console.warn(`[tenantApi] Unknown function: ${fn} (tenant: ${slug})`);
        if (errorLogs) {
                errorLogs.logError({
                          source: 'tenant-api', severity: 'error',
                          message: `Unknown function: ${fn}`,
                          url: req.originalUrl, method: req.method, status_code: 404,
                          ua: req.get('user-agent'), context: { fn, tenant: slug }
                }).catch(() => {});
        }
    return res.status(404).json({ error: 'Unknown function: ' + fn });
  }
  try {
    // Quota gate: rejects plan-limit-exceeded calls BEFORE the handler
    // runs so we never write a half-row that puts the tenant over.
    // Throws with .quotaExceeded = true → caught below and returned
    // as HTTP 402 so the SPA can render a "Upgrade plan" prompt.
    await _checkQuotaForCall(req, fn, args || []);
    const result = await API[fn](...(args || []));
    res.json({ ok: true, result });
  } catch (e) {
    // Mirror the control-plane error shape so the SPA's unified api()
    // helper can keep its current parsing logic.
    const msg = e && e.message ? e.message : String(e);
    if (e && e.quotaExceeded) {
      return res.status(402).json({
        error: msg, quota_exceeded: true,
        metric: e.metric || null, usage: e.usage || null
      });
    }
        // Log genuine server errors to the admin panel (not quota/auth noise).
        const isUserError = /not signed in|invalid.*token|expired|forbidden|required|already/i.test(msg);
        if (!isUserError && errorLogs) {
                const slug = (req.tenant && req.tenant.slug) || req.tenantSlug || 'unknown';
                errorLogs.logError({
                          source: 'tenant-api', severity: 'error',
                          message: `[tenant-api] ${fn}: ${msg}`,
                          stack: e.stack, url: req.originalUrl, method: req.method,
                          status_code: 400, ua: req.get('user-agent'),
                          context: { fn, tenant: slug }
                }).catch(() => {});
        }
    res.status(400).json({ error: msg });
  }
}

module.exports = { API, expressHandler, api_auth_ssoLogin };
