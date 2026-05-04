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
 *     handler hits tenant_<slug>, not the control DB.
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
  'integrations'
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
    return res.status(404).json({ error: 'Unknown function: ' + fn });
  }
  try {
    const result = await API[fn](...(args || []));
    res.json({ ok: true, result });
  } catch (e) {
    // Mirror the control-plane error shape so the SPA's unified api()
    // helper can keep its current parsing logic.
    const msg = e && e.message ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
}

module.exports = { API, expressHandler, api_auth_ssoLogin };
