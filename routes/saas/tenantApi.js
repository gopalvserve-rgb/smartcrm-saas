/**
 * routes/saas/tenantApi.js
 *
 * Tenant API dispatcher for the SaaS server (server.js).
 * Mirrors the logic in server.tenant.js but only loads the route
 * files that exist inside smartcrm-saas/routes/. Missing route
 * files are skipped gracefully so partial deployments still work.
 *
 * Also provides:
 *   api_login          — email + password login for tenant users
 *   api_auth_ssoLogin  — exchange a super-admin "Login as tenant"
 *                        ssl JWT for a regular tenant session token
 */

'use strict';

const path   = require('path');
const jwt    = require('jsonwebtoken');
const db     = require('../../db/pg');
const { hashPassword, verifyPassword, signToken, authUser } = require('../../utils/auth');

// Optional — gracefully absent in single-tenant deployments.
// In the SaaS server, errorLogs lives next to this file and writes to
// the platform control DB so the super-admin /admin/#/errors view picks
// them up. We require lazily so a missing file never crashes boot.
let errorLogs;
try { errorLogs = require('./errorLogs'); } catch (_) {}

// ── 1. Load every available route file ──────────────────────────────────────
//
// Add more entries here as route files are ported into smartcrm-saas/routes/.
const ROUTE_FILES = [
  'admin',
  'announcements',
  'auth',
  'campaigns',
  'automations',
  'chat',
  'customFields',
  'customers',
  'dashboard',
  'fb',
  'hr',
  'integrations',
  'inventory',
  'knowledgeBase',
  'leads',
  'notifications',
  'permissions',
  'personalWaTemplates',
  'products',
  'projectStages',
  'push',
  'recordings',
  'reports',
  'roles',
  'rules',
  'savedFilters',
  'setup',
  'sources',
  'statuses',
  'tags',
  'targets',
  'tat',
  'users',
  'webhooks',
  'whatsapp',
  'whatsbot',
  'aiBot',
  'quotations',
  'modules',
];

const API = {};

ROUTE_FILES.forEach(name => {
  try {
    const mod = require(`../${name}`);
    Object.keys(mod).forEach(fn => {
      if (typeof mod[fn] === 'function' && fn.startsWith('api_')) {
        API[fn] = mod[fn];
      }
    });
  } catch (e) {
    // Route file doesn't exist yet — skip silently
    if (e.code !== 'MODULE_NOT_FOUND') {
      console.warn(`[tenantApi] Warning: could not load routes/${name}.js —`, e.message);
    }
  }
});

// ── 2. Built-in auth functions ───────────────────────────────────────────────

/**
 * api_login(_token, email, password, meta?)
 *
 * Standard email + password login for tenant users.
 * Returns { token, user }.
 */
async function api_login(_token, email, password) {
  if (!email || !password) throw new Error('email and password required');

  const normalEmail = String(email).toLowerCase().trim();
  const user = await db.findOneBy('users', 'email', normalEmail);

  if (!user) throw new Error('Invalid email or password');
  if (!Number(user.is_active)) throw new Error('Account is deactivated');
  if (!verifyPassword(password, user.password_hash)) throw new Error('Invalid email or password');

  const token = signToken(user);
  return {
    token,
    user: {
      id:         user.id,
      name:       user.name,
      email:      user.email,
      role:       user.role,
      photo_url:  user.photo_url || '',
    }
  };
}

/**
 * api_login_otp_verify — stub so older client code doesn't crash.
 * Full OTP flow requires a notifications route; return the same shape
 * as api_login for now.
 */
async function api_login_otp_verify(_token, challengeToken) {
  // The challenge token IS a short-lived JWT in some implementations.
  // For now, just verify and re-issue.
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
  let payload;
  try { payload = jwt.verify(challengeToken, JWT_SECRET); }
  catch (e) { throw new Error('Invalid or expired OTP challenge'); }

  const user = await db.findById('users', payload.id);
  if (!user || !Number(user.is_active)) throw new Error('User not found or inactive');

  const token = signToken(user);
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, photo_url: user.photo_url || '' }
  };
}

/**
 * api_auth_ssoLogin(_token, payload)
 *
 * Called by the tenant SPA bootstrap (index.html) when the page is
 * opened with ?ssl=<jwt> — i.e. when a super-admin clicks
 * "Login as tenant" in the admin panel.
 *
 * payload = { ssl: '<jwt>', slug: '<tenant-slug>' }
 *
 * The ssl JWT was minted by the admin panel (routes/saas/tenants.js
 * or similar) and contains:
 *   { ssl: true, slug, as_email, sa_email, iat, exp }
 *
 * We verify it, look up the target user in the tenant DB, and return
 * a normal tenant session token so the SPA boots as that user.
 */
async function api_auth_ssoLogin(_token, payload) {
  const { ssl, slug } = payload || {};
  if (!ssl)  throw new Error('ssl token required');
  if (!slug) throw new Error('slug required');

  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
  let decoded;
  try {
    decoded = jwt.verify(String(ssl), JWT_SECRET);
  } catch (e) {
    throw new Error('Login link has expired or is invalid. Please generate a new one from the admin panel.');
  }

  // Validate payload shape
  if (!decoded.ssl || decoded.slug !== slug) {
    throw new Error('Token mismatch — slug does not match.');
  }

  // Find the impersonation target in this tenant's DB.
  // as_email is the tenant user (usually the tenant admin / owner).
  const targetEmail = String(decoded.as_email || '').toLowerCase().trim();
  if (!targetEmail) throw new Error('Token missing as_email claim');

  let user = await db.findOneBy('users', 'email', targetEmail);

  // If no user with that email exists in this tenant's DB yet
  // (e.g. tenant was just provisioned and has no users), fall back to
  // the first admin user so the operator at least gets in.
  if (!user) {
    const all = await db.getAll('users');
    user = all.find(u => u.role === 'admin' && Number(u.is_active)) || all[0];
  }

  if (!user) throw new Error('No users found in this tenant workspace yet.');
  if (!Number(user.is_active)) throw new Error('Target user account is deactivated.');

  const token = signToken(user);
  return {
    token,
    user: {
      id:        user.id,
      name:      user.name,
      email:     user.email,
      role:      user.role,
      photo_url: user.photo_url || '',
    }
  };
}

// Register built-in auth handlers
API.api_login              = api_login;
API.api_login_otp_verify   = api_login_otp_verify;
API.api_auth_ssoLogin      = api_auth_ssoLogin;

// ── 3. Express handler ───────────────────────────────────────────────────────

/**
 * expressHandler(req, res, next)
 *
 * Drop-in for the app.post('/api', ...) route in server.js.
 * Expects body: { fn: string, args: any[] }
 *
 * Protocol (matches server.tenant.js + app.js apiRaw()):
 *   args[0]  = bearer token string (CRM.token, may be '')
 *   args[1+] = actual function arguments
 *
 * So we call: handler(...args)  — token is already baked into args.
 */
async function expressHandler(req, res) {
  const { fn, args } = req.body || {};

  if (!fn) {
    return res.status(400).json({ error: 'fn is required' });
  }

  const handler = API[fn];
  if (!handler) {
    const slug = (req.tenant && req.tenant.slug) || req.tenantSlug || 'unknown';
    console.warn(`[tenantApi] Unknown function: ${fn} (tenant: ${slug})`);
    if (errorLogs) {
      errorLogs.logError({
        source:      'tenant-api',
        severity:    'error',
        message:     `Unknown function: ${fn}`,
        url:         req.originalUrl,
        method:      req.method,
        status_code: 404,
        ua:          req.get('user-agent'),
        context:     { fn, tenant: slug }
      }).catch(() => {});
    }
    return res.status(404).json({ error: `Unknown function: ${fn}` });
  }

  try {
    const finalArgs = (args || []).slice();
    if (fn === 'api_login' || fn === 'api_login_otp_verify') {
      finalArgs.push({
        ua: String(req.headers['user-agent'] || ''),
        ip: String(req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '')
              .split(',')[0].trim()
      });
    }

    const result = await handler(...finalArgs);
    return res.json({ ok: true, result });
  } catch (e) {
    const isUserError = /not signed in|invalid.*token|expired|forbidden|required|already/i
      .test(String(e.message || ''));
    const status = /not signed in|invalid.*token|expired/i.test(e.message) ? 401 : 400;

    console.error('[tenantApi]', fn, e.message);

    if (!isUserError && errorLogs) {
      const slug = (req.tenant && req.tenant.slug) || req.tenantSlug || 'unknown';
      errorLogs.logError({
        source:      'tenant-api',
        severity:    'error',
        message:     `[tenant-api] ${fn}: ${e.message || e}`,
        stack:       e.stack,
        url:         req.originalUrl,
        method:      req.method,
        status_code: status,
        ua:          req.get('user-agent'),
        context:     { fn, tenant: slug }
      }).catch(() => {});
    }

    return res.status(status).json({ error: e.message });
  }
}

module.exports = { expressHandler };
