/**
 * SmartCRM SaaS â single-process multi-tenant server.
 *
 * URL surface:
 *   GET  /                           â public landing + pricing
 *   POST /api/saas                   â public + super-admin SaaS dispatcher
 *   GET  /api/saas/brand             â public brand JSON for the landing page
 *   GET  /signup/return              â Cashfree return URL (verifies + redirects to /t/<slug>)
 *   POST /hook/cashfree              â Cashfree webhook (raw-body required for HMAC verify)
 *   GET  /admin/                     â super-admin SPA shell (calls /api/saas)
 *   GET  /t/<slug>                   â tenant CRM SPA shell
 *   POST /t/<slug>/api               â tenant API dispatcher (per-tenant DB)
 *
 * The tenant resolver middleware sets req.tenant + req.tenantPool when a
 * /t/<slug>/... path is hit, so downstream tenant routes look identical
 * to the original Celeste/Stockbox single-tenant app. The original
 * monolithic server lives in server.tenant.js for now and will be folded
 * in once we wire per-tenant DB connection injection (Phase 2/3).
 */
require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

const control = require('./control/db');
const { attachTenant } = require('./utils/tenantResolver');
const tenantDb = require('./db/pg');
const tenantApi = require('./routes/saas/tenantApi');

// ---- SaaS modules (control plane) -----------------------------
const superAdmin = require('./routes/saas/superAdminAuth');
const packages = require('./routes/saas/packages');
const signup = require('./routes/saas/signup');
const tenants = require('./routes/saas/tenants');
const invoices = require('./routes/saas/invoices');
const settings = require('./routes/saas/saasSettings');
const announcements = require('./routes/saas/announcements');
const customReqs = require('./routes/saas/customRequirements');
const webhookLogs = require('./routes/saas/webhookLogs');
const cashfreeWebhook = require('./routes/saas/cashfreeWebhook');
const errorLogs = require('./routes/saas/errorLogs');

// Combine every SaaS api_* into one dispatch map
const SAAS_API = {};
[
  superAdmin, packages, signup, tenants, invoices, settings,
  announcements, customReqs, webhookLogs, errorLogs
].forEach(mod => {
  Object.keys(mod).forEach(k => {
    if (typeof mod[k] === 'function' && k.startsWith('api_saas_')) SAAS_API[k] = mod[k];
  });
});

const app = express();
app.set('trust proxy', 1);

// ---- Cashfree webhook: needs raw body for HMAC verify ---------
// Mounted BEFORE bodyParser.json so the webhook receives the raw bytes
// Cashfree signed against; everything else uses parsed JSON.
app.post('/hook/cashfree',
  bodyParser.raw({ type: '*/*', limit: '1mb' }),
  cashfreeWebhook.expressWebhook
);

app.use(bodyParser.json({ limit: '4mb' }));
// Accept form-encoded bodies on /hook/website + /hook/other so HTML
// contact forms (and tools like Zapier) can post directly without
// JSON.stringify.
app.use(bodyParser.urlencoded({ extended: true, limit: '4mb' }));
app.use(require('cookie-parser')());

// ---- Static assets --------------------------------------------
// Public landing site lives at /saas/* and is served at the root URL.
//
// Cache strategy:
//   - HTML files always get no-cache so a deploy shows up immediately
//     when the user revisits.
//   - JS / CSS get a short max-age (60s) â index.html references them
//     with a ?v=â¦ cache buster, so a deploy that bumps the buster
//     invalidates them anyway. Without this, browsers kept happily
//     serving the old admin.js for hours after a deploy and the new
//     /admin/#/errors view rendered as "Unknown view".
const _staticOpts = {
  setHeaders: (res, filePath) => {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/\.(js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
    }
  }
};
app.use('/saas', express.static(path.join(__dirname, 'public', 'saas'), _staticOpts));
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'saas', 'index.html'));
});

// Diagnostic â admin-only smoke test that the Railway egress can
// actually reach a host:port. Helps debug Gmail SMTP timeouts.
app.get('/api/saas/debug/tcp', async (req, res) => {
  const token = (req.headers['x-auth-token'] || req.query.token || '').toString();
  try { await superAdmin.requireFullAdmin(token); }
  catch (e) { return res.status(401).json({ error: e.message }); }
  const host = String(req.query.host || 'smtp.gmail.com');
  const port = Number(req.query.port || 587);
  const net = require('net');
  const start = Date.now();
  const sock = new net.Socket();
  let done = false;
  const finish = (ok, msg) => {
    if (done) return; done = true;
    sock.destroy();
    res.json({ ok, host, port, ms: Date.now() - start, msg });
  };
  sock.setTimeout(10000);
  sock.once('connect', () => finish(true, 'connected'));
  sock.once('timeout', () => finish(false, 'timeout'));
  sock.once('error', e => finish(false, e.code + ': ' + e.message));
  sock.connect(port, host);
});

// Public client-error sink. Frontend window.error / unhandledrejection
// handlers POST here â body is treated as untrusted, capped + redacted
// inside errorLogs.logError(). No auth so anonymous visitors hitting
// the landing page can still report their own browser errors.
app.post('/api/saas/log-error', errorLogs.expressClientErrorEndpoint);

// ---- Tenant-scoped Meta/WhatsApp webhooks + FB OAuth callback -----
//
// Facebook only allows ONE OAuth redirect URI per app and ONE webhook
// callback URL per webhook subscription, so all tenants share the same
// platform-wide URLs:
//
//   OAuth callback URL (Valid OAuth Redirect URIs in the Facebook app):
//     https://crm.smartcrmsolution.com/fb/auth/callback
//
//   Lead Ads webhook URL (Webhooks â Page â leadgen):
//     https://crm.smartcrmsolution.com/hook/meta
//
//   WhatsApp Cloud API webhook URL:
//     https://crm.smartcrmsolution.com/hook/whatsapp
//     https://crm.smartcrmsolution.com/hook/whatsapp_webhook
//
// Tenant routing inside each handler:
//   - OAuth callback: state JWT carries the tenant slug (set by
//     api_fb_oauth_url when minted). We verify, look up the tenant,
//     and run the existing per-tenant handler inside tenantStorage.
//   - Lead Ads webhook: payload contains page_id; we walk every active
//     tenant DB to find which one owns it, then process the leadgen
//     event inside that tenant's pool. (For 1000+ tenants we'd swap
//     this for a control-plane page_id â tenant_id lookup table; for
//     the MVP this is fast enough.)
//   - WhatsApp webhook: payload contains phone_number_id; same lookup.
const fbRoute = require('./routes/fb');
const webhooksRoute = require('./routes/webhooks');
const integrations  = require('./routes/integrations');
const whatsbotRoute = require('./routes/whatsbot');
const tenantPoolMod = require('./utils/tenantPool');
const controlDb = require('./control/db');
const jwtLib = require('jsonwebtoken');

/**
 * Resolve a tenant by slug, build a per-tenant scope, and run `handler`
 * inside tenantStorage.run() so any db.query() call inside the handler
 * goes to that tenant's DB.
 */
async function _runAsTenant(slug, req, res, handler) {
  if (!slug) return res.status(400).json({ error: 'tenant slug missing' });
  let t;
  try { t = await tenantPoolMod.findActiveTenant(slug); }
  catch (e) {
    errorLogs.logError({ source: 'webhook', severity: 'error', message: 'tenant lookup failed: ' + e.message, stack: e.stack }).catch(() => {});
    return res.status(500).json({ error: 'tenant lookup failed' });
  }
  if (!t) return res.status(404).json({ error: 'tenant not found: ' + slug });
  if (t.status === 'suspended' || t.status === 'deleted') {
    return res.status(403).json({ error: 'tenant ' + slug + ' is ' + t.status });
  }
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) return res.status(500).json({ error: 'tenant pool unavailable' });
  // Stash on req so handlers that look at req.tenant still work.
  req.tenant = t;
  req.tenantSlug = slug;
  return tenantDb.tenantStorage.run({ pool, tenant: t, slug }, () => handler(req, res));
}

/**
 * For inbound webhooks where the payload (not state) tells us which
 * tenant â find the tenant whose DB has the matching record. Walks the
 * active tenants, opens each pool briefly, runs the lookup query.
 *
 * `lookupSql` should be a SELECT 1 / SELECT id query that returns at
 * least one row when the tenant owns the record. params bind into it.
 */
async function _findTenantByLookup(lookupSql, params) {
  const r = await controlDb.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 200`
  );
  for (const row of r.rows) {
    let t;
    try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      const hit = await pool.query(lookupSql, params);
      if (hit.rowCount > 0) return t;
    } catch (_) { /* table missing or other â skip */ }
  }
  return null;
}

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ---- Facebook OAuth callback (one URL for all tenants) ----------
app.get('/fb/auth/callback', async (req, res) => {
  const stateRaw = (req.query.state || '').toString();
  // Decode state (no verify) to get slug for routing â the inner
  // expressOAuthCallback will do full jwt.verify with secret.
  let slug;
  try {
    const peek = jwtLib.decode(stateRaw);
    if (peek && peek.slug) slug = peek.slug;
  } catch (_) {}
  if (!slug) {
    // Single-tenant deployment fallback: run the original handler
    // directly. The slug-aware redirect logic in fb.js falls back to
    // / when no slug, so it still works.
    return fbRoute.expressOAuthCallback(req, res);
  }
  return _runAsTenant(slug, req, res, fbRoute.expressOAuthCallback);
});

// ---- Meta Lead Ads webhook (one URL for all tenants) ------------
//
// FB calls these in two flavours:
//   GET  with hub.mode=subscribe&hub.verify_token}â¦&hub.challenge=â¦ â echo challenge
//   POST with leadgen events
//
// VERIFY: tenants share the same verify token (or admin can set
// META_VERIFY_TOKEN per tenant; we accept the platform default if
// any active tenant matches).
app.get('/hook/meta', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  if (mode !== 'subscribe' || !token) return res.status(400).send('Bad verify');
  // Accept if ANY tenant has this verify token configured. This is
  // the same trust model FB uses â they only ever ask once at hook
  // setup, and the challenge response is symmetric.
  const r = await controlDb.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 200`
  );
  for (const row of r.rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      const hit = await pool.query(`SELECT value FROM config WHERE key = 'META_VERIFY_TOKEN' LIMIT 1`);
      const cfgToken = hit.rows[0] && hit.rows[0].value;
      if (cfgToken && cfgToken === token) return res.type('text/plain').send(challenge);
    } catch (_) { /* table missing */ }
  }
  // Platform-wide fallback (env var)
  if (process.env.META_VERIFY_TOKEN && process.env.META_VERIFY_TOKEN === token) {
    return res.type('text/plain').send(challenge);
  }
  return res.status(403).send('Verify token mismatch');
});

app.post('/hook/meta', async (req, res) => {
  // Fast path: when the forwarder dispatches to /t/<slug>/hook/meta
  // attachTenant has already populated req.tenant â no lookup needed.
  if (req.tenant) {
    return webhooksRoute.metaEvent(req, res);
  }
  // Slow path: bare /hook/meta hit (Meta calling our root URL directly,
  // no slug in URL). Walk active tenants and find the one whose stored
  // META_PAGES list includes the page_id from the payload.
  const body = req.body || {};
  const entry = (body.entry && body.entry[0]) || {};
  const pageId = String(entry.id || (entry.changes && entry.changes[0] && entry.changes[0].value && entry.changes[0].value.page_id) || '');
  if (!pageId) {
    errorLogs.logError({
      source: 'webhook', severity: 'warn',
      message: '/hook/meta payload missing page_id',
      context: { body }
    }).catch(() => {});
    return res.sendStatus(200);
  }
  const t = await _findTenantByLookup(
    `SELECT 1 FROM config WHERE key = 'META_PAGES' AND value LIKE $1 LIMIT 1`,
    ['%' + pageId + '%']
  );
  if (!t) {
    errorLogs.logError({
      source: 'webhook', severity: 'warn',
      message: '/hook/meta page_id ' + pageId + ' has no owning tenant',
      context: { pageId }
    }).catch(() => {});
    return res.sendStatus(200);
  }
  return _runAsTenant(t.slug, req, res, webhooksRoute.metaEvent);
});

// ---- WhatsApp webhooks (Meta Cloud API) -------------------------
app.get('/hook/whatsapp', async (req, res) => {
  // Same verify-token-against-any-tenant pattern as /hook/meta.
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  if (!token) return res.status(400).send('Bad verify');
  const r = await controlDb.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 200`
  );
  for (const row of r.rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      const hit = await pool.query(`SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`);
      const cfg = hit.rows[0] && hit.rows[0].value;
      if (cfg && cfg === token) return res.type('text/plain').send(challenge);
    } catch (_) {}
  }
  return res.status(403).send('Verify token mismatch');
});

app.post('/hook/whatsapp', async (req, res) => {
  // Fast path â forwarder dispatched to /t/<slug>/hook/whatsapp.
  if (req.tenant) return webhooksRoute.whatsappEvent(req, res);
  // Slow path â bare /hook/whatsapp; look up by phone_number_id.
  const body = req.body || {};
  const entry = (body.entry && body.entry[0]) || {};
  const change = (entry.changes && entry.changes[0]) || {};
  const phoneId = String(change.value && change.value.metadata && change.value.metadata.phone_number_id || '');
  if (!phoneId) return res.sendStatus(200);
  const t = await _findTenantByLookup(
    `SELECT 1 FROM config WHERE key IN ('WA_PHONE_NUMBER_ID','WHATSAPP_PHONE_NUMBER_ID') AND value = $1 LIMIT 1`,
    [phoneId]
  );
  if (!t) return res.sendStatus(200);
  return _runAsTenant(t.slug, req, res, webhooksRoute.whatsappEvent);
});

// /hook/whatsapp_webhook is the WhatsBot module's own endpoint â
// same routing logic, different handler.
app.get('/hook/whatsapp_webhook', async (req, res) => {
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  // Fast path â verify GET to /t/<slug>/hook/whatsapp_webhook with
  // tenant already resolved. Just check this tenant's stored token.
  if (req.tenant && req.tenantPool) {
    try {
      const hit = await req.tenantPool.query(`SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`);
      const cfg = hit.rows[0] && hit.rows[0].value;
      if (cfg && cfg === token) return res.type('text/plain').send(challenge);
    } catch (_) {}
    return res.status(403).send('Verify token mismatch');
  }
  // Slow path â direct hit on bare /hook/whatsapp_webhook, walk all tenants.
  const r = await controlDb.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 200`
  );
  for (const row of r.rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      const hit = await pool.query(`SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`);
      const cfg = hit.rows[0] && hit.rows[0].value;
      if (cfg && cfg === token) return res.type('text/plain').send(challenge);
    } catch (_) {}
  }
  return res.status(403).send('Verify token mismatch');
});

app.post('/hook/whatsapp_webhook', async (req, res) => {
  // Fast path â forwarder dispatched to /t/<slug>/hook/whatsapp_webhook.
  // This is the canonical path each tenant registers when they connect
  // via Embedded Sign-In (whatsbot.js _registerWithCentralForwarder),
  // so this branch handles the common case zero-lookup.
  if (req.tenant) return whatsbotRoute.expressEvent(req, res);
  // Slow path â direct hit on bare /hook/whatsapp_webhook.
  const body = req.body || {};
  const entry = (body.entry && body.entry[0]) || {};
  const change = (entry.changes && entry.changes[0]) || {};
  const phoneId = String(change.value && change.value.metadata && change.value.metadata.phone_number_id || '');
  if (!phoneId) return res.sendStatus(200);
  const t = await _findTenantByLookup(
    `SELECT 1 FROM config WHERE key IN ('WA_PHONE_NUMBER_ID','WHATSAPP_PHONE_NUMBER_ID') AND value = $1 LIMIT 1`,
    [phoneId]
  );
  if (!t) return res.sendStatus(200);
  return _runAsTenant(t.slug, req, res, whatsbotRoute.expressEvent);
});

// ---- Website / Other lead-intake webhooks (platform-wide) --------------
//
// POST /hook/website and POST /hook/other allow third-party forms and tools
// (Zapier, Pabbly, landing pages, WordPress CF7, etc.) to create leads
// without knowing the /t/<slug> prefix.  The x-api-key (or
// Authorization: Bearer / body.api_key / ?api_key) is unique per tenant,
// so we use it to identify the owning tenant, then run the real handler
// inside that tenant's AsyncLocalStorage context.
//
// Fast path: the request was already routed via /t/<slug>/hook/website,
// attachTenant has rewritten req.url â /hook/website and set req.tenant.
// Slow path: bare /hook/website hit â extract the key, walk active
// tenants, find the one whose WEBSITE_API_KEY matches.
function _extractHookKey(req) {
  const xkey = req.header('x-api-key');
  if (xkey) return String(xkey).trim();
  const auth = req.header('authorization') || '';
  const bearer = /^bearer\s+(.+)$/i.exec(auth);
  if (bearer) return String(bearer[1]).trim();
  if (req.body && req.body.api_key) return String(req.body.api_key).trim();
  if (req.query && req.query.api_key) return String(req.query.api_key).trim();
  return '';
}

async function _runHookAsTenant(req, res, handler) {
  // Fast path â attachTenant already resolved the tenant.
  if (req.tenant) {
    return _runAsTenant(req.tenantSlug, req, res, handler);
  }
  // Slow path â find tenant by WEBSITE_API_KEY.
  const key = _extractHookKey(req);
  if (!key) return res.status(401).json({ error: 'Missing API key' });
  const t = await _findTenantByLookup(
    `SELECT 1 FROM config WHERE key = 'WEBSITE_API_KEY' AND value = $1 LIMIT 1`,
    [key]
  ).catch(() => null);
  if (!t) return res.status(401).json({ error: 'Invalid API key' });
  return _runAsTenant(t.slug, req, res, handler);
}

app.post('/hook/website', (req, res) => _runHookAsTenant(req, res, webhooksRoute.websiteHook));
app.post('/hook/other',   (req, res) => _runHookAsTenant(req, res, webhooksRoute.otherHook));

// ---- Lead-source webhooks (18 platforms) ------------------------------
// POST /hook/leadsource/:source/:key
//   source = indiamart | magicbricks | justdial | tradeindia | 99acres |
//            housing | nobroker | exportersindia | sulekha | googleads |
//            wordpress | cf7 | wpforms | gravityforms | googleforms |
//            pabbly | zapier | make | leadsquared | zoho | hubspot |
//            salesforce | generic
//   key    = WEBSITE_API_KEY (tenant-specific)
// Tenant is resolved by the API key; the handler runs in tenant DB context.
app.post('/hook/leadsource/:source/:key', (req, res) => {
  // _extractHookKey looks at headers/body/query â inject path param too
  if (!req.body) req.body = {};
  if (!req.body.api_key) req.body.api_key = req.params.key;
  return _runHookAsTenant(req, res, integrations.leadSourceWebhook);
});

// Sheet push webhook (Google Apps Script â CRM, token-based, no tenant slug needed)
app.post('/hook/sheet/:token', (req, res) => {
  if (!req.body) req.body = {};
  if (!req.body.api_key) req.body.api_key = req.params.token;
  return _runHookAsTenant(req, res, integrations.sheetPushWebhook);
});

// ---- Public API documentation page ------------------------------------
//
// Accessible at https://crm.smartcrmsolution.com/api-docs (no tenant
// context required) and also at /t/<slug>/api-docs via rewrite.
// Shows both JSON and application/x-www-form-urlencoded examples so
// third-party form tools that can only send urlencoded bodies can
// integrate without any backend proxy.
app.get('/api-docs', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  res.type('html').send(_apiDocsHtml(host));
});

// Public brand JSON (used by the landing page)
app.get('/api/saas/brand', async (_req, res) => {
  try {
    const [name, tagline, subhead, color, logo, support] = await Promise.all([
      control.getSetting('PLATFORM_NAME', 'SmartCRM'),
      control.getSetting('PLATFORM_TAGLINE', 'The CRM your sales team will actually use'),
      control.getSetting('PLATFORM_HERO_SUBHEAD', ''),
      control.getSetting('PLATFORM_PRIMARY_COLOR', '#10b981'),
      control.getSetting('PLATFORM_LOGO_URL', ''),
      control.getSetting('SUPPORT_EMAIL', '')
    ]);
    res.json({ name, tagline, subhead, color, logo, support });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- SaaS API dispatcher --------------------------------------
function _saasToken(req) {
  return (req.headers['x-auth-token'] || (req.body && req.body.token) || '').toString();
}
app.post('/api/saas', async (req, res) => {
  const { fn, args } = req.body || {};
  if (!fn || !SAAS_API[fn]) return res.status(404).json({ error: 'Unknown SaaS function: ' + fn });
  try {
    const token = _saasToken(req);
    const finalArgs = [token, ...((args || []).slice(0, 5))];
    const result = await SAAS_API[fn](...finalArgs);
    res.json({ ok: true, result });
  } catch (e) {
    console.error('[saas-api]', fn, e.message);
    // Persist to the error log so the admin Errors page surfaces it.
    // Auth/validation errors (anything that throws a clean 400-class
    // message like "Invalid credentials") aren't actually bugs, so we
    // tag them severity='warn' to keep the queue clean.
    const looksLikeUserError = /not signed in|invalid|forbidden|required|already|email|password/i
      .test(String(e.message || ''));
    errorLogs.logError({
      source: 'server',
      severity: looksLikeUserError ? 'warn' : 'error',
      message: '[saas-api] ' + fn + ': ' + (e.message || e),
      stack:   e.stack,
      url:     req.originalUrl,
      method:  req.method,
      status_code: 400,
      ua:      req.get('user-agent'),
      context: { fn }
    }).catch(() => {});
    res.status(400).json({ error: e.message });
  }
});

// ---- Cashfree return URL --------------------------------------
// Customer lands here after Hosted Checkout. We verify status (in
// case the webhook hasn't fired yet), provision if needed, then
// redirect to /t/<slug> on success.
app.get('/signup/return', async (req, res) => {
  const orderId = req.query.order_id;
  if (!orderId) return res.redirect('/?error=missing_order_id');
  try {
    const r = await signup.api_saas_signup_verify('', orderId);
    if (r.provisioned) return res.redirect('/t/' + r.slug + '?welcome=1');
    return res.redirect('/?pending=' + orderId);
  } catch (e) {
    // Persist so the platform admin sees stuck signups even though
    // the customer just gets a flash-error in the URL.
    errorLogs.logError({
      source: 'signup',
      severity: 'error',
      message: '[signup/return] order ' + orderId + ': ' + (e.message || e),
      stack:   e.stack,
      url:     req.originalUrl,
      method:  'GET',
      context: { order_id: orderId }
    }).catch(() => {});
    return res.redirect('/?error=' + encodeURIComponent(e.message));
  }
});

// ---- Super-admin SPA shell ------------------------------------
app.get(/^\/admin\/?(.*)$/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'saas', 'admin', 'index.html'));
});

// ---- Tenant routing -------------------------------------------
//
// IMPORTANT note on order: attachTenant REWRITES req.url to strip
// the /t/<slug> prefix so downstream routes can stay slug-unaware.
// That means any route we want to match against the original
// /t/<slug>/... URL has to be registered BEFORE attachTenant runs,
// otherwise the route's regex sees the already-rewritten URL and
// never matches.
//
// Trailing-slash redirect: tenant pages must be served at /t/<slug>/
// (with the slash) so the relative <link href="styles.css"> etc. in
// index.html resolve to /t/<slug>/styles.css. Without this, a user
// hitting /t/<slug> would see a broken page (relative URLs would
// resolve against /t/, not /t/<slug>/).
app.get(/^\/t\/[a-z0-9-]+$/, (req, res) => {
  // Insert the slash BEFORE the query string. Naively appending '/'
  // to req.originalUrl breaks magic-link URLs like
  //   /t/acme?ssl=eyJâ¦
  // by producing /t/acme?ssl=eyJâ¦/ which corrupts the JWT value.
  const qIdx = req.originalUrl.indexOf('?');
  const target = qIdx === -1
    ? req.originalUrl + '/'
    : req.originalUrl.slice(0, qIdx) + '/' + req.originalUrl.slice(qIdx);
  res.redirect(301, target);
});

// Tenant "not found" placeholder â gonly serves when the slug doesn't
// resolve to an active tenant row. For valid tenants we fall through
// to the static-asset + SPA-shell handlers further down, which serve
// public/tenant/index.html (the actual CRM UI)
//
// Why this runs BEFORE attachTenant: attachTenant rewrites req.url
// to strip the /t/<slug> prefix, which would make the regex below
// stop matching. We need the un-rewritten URL to detect tenant
// requests at this stage.
app.get(/^\/t\/[a-z0-9-]+\/?$/, async (req, res, next) => {
  const m = /^\/t\/([a-z0-9-]+)\/?$/.exec(req.path);
  if (!m) return next();
  const slug = m[1].toLowerCase();
  let tenant = null;
  try {
    const tp = require('./utils/tenantPool');
    tenant = await tp.findActiveTenant(slug);
  } catch (_) {}
  // Tenant exists â let attachTenant + the SPA handler take over.
  // (The "?ssl=â¦" magic-link case also flows through here â the SPA
  // shell exchanges the token for a real JWT during boot.)
  if (tenant && tenant.status !== 'deleted' && tenant.status !== 'suspended') return next();
  return _renderTenantPlaceholder(req, res, slug, tenant);
});

app.use(attachTenant);

// ---- Per-tenant DB injection ---------------------------------------
// After attachTenant runs, req.tenant + req.tenantPool are populated
// for any /t/<slug>/... request. Wrap the rest of the chain in
// AsyncLocalStorage.run so any /routes/* handler that calls
// db.query() / db.getAll() / etc. transparently uses the right
// per-tenant pg.Pool. Without this, the route files would silently
// hit the control DB (DATABASE_URL) and either crash or â worse â
// read/write the wrong tenant's data.
app.use((req, _res, next) => {
  if (!req.tenantPool) return next();
  tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, next);
});

// ---- Tenant API dispatcher ----------------------------------------
// The tenant SPA POSTs to /t/<slug>/api with body { fn, args }.
// attachTenant has already rewritten req.url to /api, so the route
// matches here. The dispatcher loads every /routes/<name>.js and maps
// api_* exports to handlers. See routes/saas/tenantApi.js for details.
app.post('/api', (req, res, next) => {
  // Must have a resolved tenant â otherwise this isn't a tenant call
  // and we just 404 with JSON to avoid the "<!DOCTYPE" parse crash.
  if (!req.tenant) {
    return res.status(404).json({ error: 'Workspace not found: ' + (req.tenantSlug || '') });
  }
  if (req.tenant.status === 'suspended') {
    return res.status(403).json({ error: 'This workspace has been suspended. Contact support.' });
  }
  if (req.tenant.status === 'deleted' || req.tenant.status === 'pending_payment') {
    return res.status(404).json({ error: 'This workspace is not active.' });
  }
  return tenantApi.expressHandler(req, res, next);
});

// ---- /api/sample.csv (tenant-scoped CSV download) -----------------
// The tenant SPA's bulk-upload page links to /api/sample.csv expecting
// a real CSV. Without an explicit handler here the request falls
// through to the JSON-404 catch-all below, which returned
//   {"error":"Not found: GET /api/sample.csv"}
// â and the browser saved that JSON as the "sample sheet". Mount the
// same handler the original Celeste server uses, but only inside a
// tenant scope so the custom-field columns come from THIS tenant's DB.
function _csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------
// SpreadsheetML 2003 helper â generates a single XML file Excel
// (and Numbers / LibreOffice) recognises as a real workbook. We use
// this instead of pulling in the `xlsx` npm dep because:
//   1. No new package = nothing to npm-install on existing deploys
//   2. The output is trivially readable / diffable for debugging
//   3. Excel opens it natively (no "import as text" prompt)
// Returned as application/vnd.ms-excel with a .xls filename so the
// browser respects the download attribute and Excel auto-associates.
// ---------------------------------------------------------------
function _xlsCell(v) {
  const s = v == null ? '' : String(v);
  // SpreadsheetML uses XML-escaped strings inside <Data ss:Type="String">.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function _buildSampleXls(headers, rows) {
  const headerRow = '<Row>' +
    headers.map(h => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${_xlsCell(h)}</Data></Cell>`).join('') +
    '</Row>';
  const dataRows = rows.map(r =>
    '<Row>' +
    headers.map(h => `<Cell><Data ss:Type="String">${_xlsCell(r[h])}</Data></Cell>`).join('') +
    '</Row>'
  ).join('');
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel">
  <Styles>
    <Style ss:ID="hdr"><Font ss:Bold="1"/></Style>
  </Styles>
  <Worksheet ss:Name="Leads">
    <Table>
      ${headerRow}
      ${dataRows}
    </Table>
  </Worksheet>
</Workbook>`;
}

app.get('/api/sample.csv', async (req, res, next) => {
  if (!req.tenant) return next();   // root-level call â fall through to JSON 404

  // Pull custom fields so the template includes every cf_<key> column
  // currently defined in this tenant's DB. Runs inside tenantStorage,
  // so tenantDb.getAll() picks up the right pool automatically.
  let customFields = [];
  try {
    customFields = (await tenantDb.getAll('custom_fields'))
      .filter(c => Number(c.is_active) !== 0 && c.key)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  } catch (_) { /* fresh tenant with no custom fields â ok */ }

  const baseCols = [
    // 1. Contact
    'name', 'phone', 'alt_phone', 'whatsapp', 'email',
    // 2. Routing â status / source / product accepted by NAME, assigned_to by email-or-name-or-id
    'status', 'source', 'source_ref', 'product', 'assigned_to',
    // 3. Address
    'address', 'city', 'state', 'pincode', 'country', 'company',
    // 4. Qualification
    'value', 'currency', 'qualified', 'tags',
    // 5. Activity
    'next_followup_at', 'notes',
    // 6. Migration timestamps â admins-only override; blank = "now"
    'created_at', 'last_status_change_at',
    // 7. Marketing attribution (Google Ads / UTM)
    'gclid', 'gad_campaignid',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'
  ];
  const cfCols = customFields.map(c => 'cf_' + c.key);
  const headers = [...baseCols, ...cfCols];

  const sampleRow = (overrides = {}) => {
    const row = {
      name: '', phone: '', alt_phone: '', whatsapp: '', email: '',
      status: '', source: '', source_ref: '', product: '', assigned_to: '',
      address: '', city: '', state: '', pincode: '', country: '', company: '',
      value: '', currency: '', qualified: '', tags: '',
      next_followup_at: '', notes: '',
      created_at: '', last_status_change_at: '',
      gclid: '', gad_campaignid: '',
      utm_source: '', utm_medium: '', utm_campaign: '', utm_term: '', utm_content: ''
    };
    customFields.forEach(c => { row['cf_' + c.key] = ''; });
    return Object.assign(row, overrides);
  };

  const rows = [
    sampleRow({
      name: 'John Doe', phone: '+919876543210', whatsapp: '+919876543210',
      email: 'john@example.com',
      status: 'New', source: 'Website', product: 'Basic Plan',
      assigned_to: 'sales1@yourcompany.com',
      address: '12 MG Road', city: 'Mumbai', state: 'MH',
      pincode: '400001', country: 'India', company: 'Acme Corp',
      value: '50000', currency: 'INR', qualified: '1',
      tags: 'hot,vip',
      next_followup_at: '2026-05-01 10:00',
      created_at: '2025-12-15 09:30',
      last_status_change_at: '2026-04-22 11:45',
      notes: 'Demo requested â interested in premium tier'
    }),
    sampleRow({
      name: 'Jane Smith', phone: '+919876543211', email: 'jane@example.com',
      status: 'Contacted', source: 'Facebook Lead Ad',
      assigned_to: 'Rajesh Kumar',
      city: 'Delhi', tags: 'vip',
      utm_source: 'facebook', utm_medium: 'paid_social',
      utm_campaign: 'spring_2026'
    }),
    sampleRow({
      name: 'Alex Kumar', phone: '+917777777777',
      source: 'WhatsApp', city: 'Bangalore'
    })
  ];

  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => _csvCell(r[h])).join(','))
  ];
  res.type('text/csv').attachment('lead-crm-sample.csv').send(lines.join('\n'));
});

// ---- /api/sample.xls (real Excel-format sample) -------------------
// Same template the CSV uses, but emitted as SpreadsheetML 2003 so
// Excel opens it as a true spreadsheet â ino "import as text" step.
// Tenant-scoped, identical fall-through pattern to the CSV handler.
app.get('/api/sample.xls', async (req, res, next) => {
  if (!req.tenant) return next();
  let customFields = [];
  try {
    customFields = (await tenantDb.getAll('custom_fields'))
      .filter(c => Number(c.is_active) !== 0 && c.key)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  } catch (_) {}

  const baseCols = [
    'name', 'phone', 'alt_phone', 'whatsapp', 'email',
    'status', 'source', 'source_ref', 'product', 'assigned_to',
    'address', 'city', 'state', 'pincode', 'country', 'company',
    'value', 'currency', 'qualified', 'tags',
    'next_followup_at', 'notes',
    'created_at', 'last_status_change_at',
    'gclid', 'gad_campaignid',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'
  ];
  const cfCols = customFields.map(c => 'cf_' + c.key);
  const headers = [...baseCols, ...cfCols];

  const rows = [
    {
      name: 'Acme Corp', phone: '9876543210', email: 'sales@acme.example',
      status: 'New', source: 'Website', product: 'Premium plan',
      city: 'Mumbai', country: 'India', value: '50000', currency: 'INR',
      qualified: '1', tags: 'enterprise,priority',
      notes: 'Sample row â replace with real data'
    },
    {
      name: 'Jane Doe', phone: '9123456789', email: 'jane@example.com',
      status: 'Contacted', source: 'WhatsApp', city: 'Bangalore'
    }
  ];

  res.type('application/vnd.ms-excel')
     .attachment('lead-crm-sample.xls')
     .send(_buildSampleXls(headers, rows));
});

// ---- Tenant SPA whell ---------------------------------------------
// Serve the per-tenant CRM SPA. After attachTenant rewrites
// /t/<slug>/ to /, GET / lands here when there's a tenant on the
// request. Plain /<no-tenant> requests still go to the SaaS landing
// (handled by the earlier app.get('/') registration above).
app.get('/', (req, res, next) => {
  if (!req.tenant) return next();          // no tenant â fall through to landing/static
  res.sendFile(path.join(__dirname, 'public', 'tenant', 'index.html'));
});

// Serve tenant static assets (app.js, styles.css, sw.js, manifests,
// icons) under any path inside the tenant scope. The tenant SPA
// references these as /app.js, /styles.css, etc., which after
// attachTenant rewrites becomes /app.js â served from public/tenant.
app.use((req, res, next) => {
  if (!req.tenant) return next();
  return express.static(path.join(__dirname, 'public', 'tenant'), _staticOpts)(req, res, next);
});

// IMPORTANT â keep the static handler scoped to /saas so it can ONLY
// serve assets from public/saas (the landing site + admin SPA). The
// previous setup mounted public/ at the root, which silently served
// the legacy Celeste SPA (public/index.html + public/app.js) when a
// tenant URL got rewritten. The tenant CRM then tried to fetch /api
// endpoints that don't exist on this server, got HTML 404 responses
// back, and crashed clients with "Unexpected token '<', '<!DOCTYPE'â¦
// is not valid JSON". The legacy files have now been removed from the
// repo, but we also keep the static handler narrow so the bug can't
// silently come back.

// Renders the tenant welcome / "not found" page. Pure HTML, no JS,
// no fetch â by design, so this surface can never produce a JSON
// parse error on the user's screen.
function _renderTenantPlaceholder(req, res, slug, tenant) {
  const safe = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  // Decode an admin-minted "Login as tenant" token (?ssl=â¦) if present
  // so we can show the operator who they're impersonating. The token
  // itself is short-lived (5 min) and signed with JWT_SECRET; here we
  // only verify it for display â Phase 2's tenant auth layer will be
  // the actual consumer.
  let ssl = null;
  if (req.query && req.query.ssl) {
    try {
      const jwP = require('jsonwebtoken');
      const payload = jwt.verify(String(req.query.ssl), process.env.JWT_SECRET || 'change-me-in-production');
      if (payload && payload.ssl && payload.slug === slug) ssl = payload;
    } catch (_) { /* expired or tampered â ignore, show normal page */ }
  }
  if (!tenant) {
    return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"/>
<title>Workspace not found Â· SmartCRM</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:5rem autm;padding:0 1rem;color:#0f172a}
.card{background:#fef2f2;border:1px solid #fecaca;padding:1.5rem;border-radius:12px}
code¶&6¶w&÷VæC¢6ffc·FFæs¢ã'&VÒãG&VÓ¶&÷&FW"×&FW3£GÐ¦¶6öÆ÷#¢3C336ÓÂ÷7GÆSà£Æï	úIBv÷&·76Ræ÷Bf÷VæCÂöà£ÆFb6Æ73Ò&6&B#à¢ÇåFRv÷&·76RÆ6öFSâG·6fR6ÇVrÓÂö6öFSâFöW6âwBW7B÷"2&VVâ&VÖ÷fVBãÂ÷à£ÂöFcà£ÇãÆ&VcÒ"ò#î(i&6²Fò6Ö'D5$ÒöÖSÂöãÂ÷æ°¢Ð¢6öç7BBÒFVæçC°¢&W2çGRvFÖÂrç6VæBÂFö7GRFÖÃãÆÖWF6'6WCÒ'WFbÓ"óà£ÇFFÆSâG·6fRBæ÷&uöæÖRÒ(	B6Ö'D5$ÓÂ÷FFÆSà£Ç7GÆSæ&öG¶föçBÖfÖÇ§77FVÒ×VÇ6ç2×6W&c¶Ö×vGF£cC¶Ö&vã£G&VÒWFó·FFæs£ã#W&VÓ¶6öÆ÷#¢3cs&¶ÆæRÖVvC£ãSWÐ¢æ6&G¶&6¶w&÷VæC¢6V6fFcS¶&÷&FW#£6öÆB3fVSv#s·FFæs£ãW&VÓ¶&÷&FW"×&FW3£'¶Ö&vã£ãW&VÒÐ¢çv&ç¶&6¶w&÷VæC¢6fVc33¶&÷&FW"Ö6öÆ÷#¢6f63WÐ¦6öFW¶&6¶w&÷VæC¢6ffc·FFæs¢ã&VÒãCW&VÓ¶&÷&FW"×&FW3£G¶föçB×6¦S¢ã&V×Ð¦¶föçB×6¦S£ãg&VÓ¶Ö&vã£ãW&V×Ð¦'¶föçB×6¦S£ãW&VÓ¶Ö&vã£ãg&VÓ¶6öÆ÷#¢3cscfWÐ¢ç&÷w¶F7Æ¦fÆW¶fÆW×w&§w&¶v¢ãW&VÒã&VÓ¶Ö&vã¢ãG&VÒÐ¢æÆ&Ç¶6öÆ÷#¢3cCsC#¶föçB×6¦S¢ã'&VÓ·FWB×G&ç6f÷&Ó§WW&66S¶ÆWGFW"×76æs¢ãFVÓ¶Ö&vâ×&vC¢ã7&V×Ð¦¶6öÆ÷#¢3C336¶föçB×vVvC£SÓÂ÷7GÆSà¢G·76ÂòÆFb6Æ73Ò&6&B"7GÆSÒ&&6¶w&÷VæC¢6F&VfS¶&÷&FW"Ö6öÆ÷#¢3cVf¶6öÆ÷#¢3S6#à¢Æ"7GÆSÒ&6öÆ÷#¢3SCb#ï	ùI2ÆövvVBâ2FVæçBFÖâ7VFòÂö#à¢Çå÷R÷VæVBF2v÷&·76Rg&öÒFRFÖâæVÂâFRFVæçB5$Ò56âwBÖ÷VçFVBWBÂ6òF22FRvVÆ6öÖRÆ6VöÆFW"(	B'WBFRÖv2ÖÆæ²Fö¶Vâ2fÆBæB6R"w2FVæçBWFÆW"vÆÂ6öç7VÖRBWFöÖF6ÆÇãÂ÷à¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#ä7Fær3Â÷7ãâÆ6öFSâG·6fR76Âæ5öVÖÂÓÂö6öFSãÂöFcà¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#å7VFò'Â÷7ãâÆ6öFSâG·6fR76Âç6öVÖÂÓÂö6öFSãÂöFcà¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#åFö¶VâW&W3Â÷7ãâG¶æWrFFR76ÂæW¢çFô4õ7G&ærç&WÆ6RuBrÂrrç6Æ6RÂÒUD3ÂöFcà£ÂöFcæ¢rwÐ£Æï	ù²vVÆ6öÖRFòG·6fRBæ÷&uöæÖRÓÂöà£Çå÷W"6Ö'D5$Òv÷&·76R2&Vv7FW&VBãÂ÷à£ÆFb6Æ73Ò&6&B#à¢Æ#åv÷&·76RFWFÇ3Âö#à¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#åU$ÃÂ÷7ãâÆ6öFSâ÷BòG·6fRBç6ÇVrÓÂö6öFSãÂöFcà¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#åÆãÂ÷7ãâG·Bç6¶vUöBòw6¶vR2r²Bç6¶vUöB¢vg&VRwÓÂöFcà¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#å7FGW3Â÷7ãâÆ6öFSâG·6fRBç7FGW2ÓÂö6öFSãÂöFcà¢ÆFb6Æ73Ò'&÷r#ãÇ7â6Æ73Ò&Æ&Â#äÆövâVÖÃÂ÷7ãâÆ6öFSâG·6fRBæ6öçF7EöVÖÂÓÂö6öFSãÂöFcà£ÂöFcà£ÆFb6Æ73Ò&6&Bv&â#à¢Æ#åFVæçB5$Ò27FÆÂ&Værv&VBWÂö#à¢ÇåFRgVÆÂ6Ö'D5$Òv÷&·76RTÆVG2Â6ÆÇ2ÂvG4Â&W÷'G22âFRæWBFWÆ÷ÖVçB6R(	BFRW"×FVæçBD"2&VVâ&÷f6öæVBÂ'WBFR56âwBÖ÷VçFVBVæFW"Æ6öFSâ÷BòfÇC·6ÇVrfwC³Âö6öFSâWBãÂ÷à¢Çäb÷Rw&RFRÆFf÷&ÒFÖâ÷R6âÖævRF2FVæçBg&öÒFRÆ&VcÒ"öFÖâò2÷FVæçG2#å6Ö'D5$ÒFÖâæVÃÂöâãÂ÷à£ÂöFcà£Ç7GÆSÒ&6öÆ÷#¢3F6#¶föçB×6¦S¢ãW&VÓ¶Ö&vâ×F÷£'&VÒ#äæVVBVÇòVÖÂÆ&VcÒ&ÖÇFó§7W÷'D6Ö'F7&×6öÇWFöâæ6öÒ#ç7W÷'D6Ö'F7&×6öÇWFöâæ6öÓÂöãÂ÷æ°§Ð ¢òò¥4ôâ×6fRCBf÷"çVæÖF6VBFVæFW"VFW"ö÷ ¢òò÷BóÇ6ÇVsâöâçFærFB6ÆÇ2fWF6WV7Fær¥4ôâæ÷rvWG0¢òò6ÆVâ¥4ôâ&6²WfVâbFRgVæ7FöâæÖR2w&öæròFR&÷WFP¢òòFöW6âwBW7B(	B&WfVçFærFR%VæWV7FVBFö¶VâsÂrÂsÂDô5ERrà¢òò7&6FBFRÆVv7V&Æ2öæ§2v2GFærV&ÆW"à¦æÆÂõåÂöÂòâ¢òBòÂ&WÂ&W2Óâ°¢&W2ç7FGW2CBæ§6öâ²W'&÷#¢tæ÷Bf÷VæC¢r²&WæÖWFöB²rr²&Wæ÷&væÅW&ÂÒ°§Ò° ¢òò7FF276WG2ÆfRôäÅVæFW"÷62Ö÷VçFVBV&ÆW"&÷fRâæð¢òò6F6ÖÆÂW&W72ç7FF2W&R(	B6VR6öÖÖVçB&Æö6²BFRF÷ö`¢òòF26V7Föâf÷"FR&FöæÆRà ¢òòÒÒÒÒ&6¶w&÷VæBöÆÆW'2vöövÆR6VWB7æ2²æFfRVÆÂçFVw&Föç2ÒÒÒÒÒÐ¢òò'Vç2WfW'RÖâ7&÷72ÆÂ7FfRFVæçG2âV6çFVw&Föâw2÷và¢òòöÆÅöçFW'fÅöÖâ6öçG&öÇ27GVÂVÆÂg&WVVæ7²FRRÖÖâF6²0¢òò§W7BFR÷WFW"6V6²6FVæ6Rà ¦7æ2gVæ7Föâ÷'VäÆÅFVæçEöÆÆW'2°¢ÆWB&÷w3°¢G'°¢&÷w2ÒvB6öçG&öÄF"çVW'¢4TÄT5B6ÇVre$ôÒFVæçG2tU$R7FGW2âv7FfRrÂwG&ÂrÂw7EöGVRrõ$DU"%B42ÄÔBS ¢°¢Ò6F6R°¢6öç6öÆRæW'&÷"u·öÆÆW%Ò6öçG&öÄF"VW'fÆVC¢rÂRæÖW76vR°¢&WGW&ã°¢Ð¢f÷"6öç7B&÷röb&÷w2ç&÷w2ÇÂµÒ°¢ÆWBC°¢G'²BÒvBFVæçEööÄÖöBæfæD7FfUFVæçB&÷rç6ÇVr²Ò6F6ò²6öçFçVS²Ð¢bB6öçFçVS°¢6öç7BööÂÒFVæçEööÄÖöBçööÄf÷"B°¢bööÂ6öçFçVS°¢FVæçDF"çFVæçE7F÷&vRç'Vâ²ööÂÂFVæçC¢BÂ6ÇVs¢&÷rç6ÇVrÒÂ7æ2Óâ°¢G'²vBçFVw&Föç2ç'VäGVU6VWE7æ72²Ð¢6F6R²6öç6öÆRæW'&÷"u·6VWEöÆÆW%ÒrÂ&÷rç6ÇVrÂRæÖW76vR²Ð¢G'²vBçFVw&Föç2ç'VäGVTæFfUVÆÇ2²Ð¢6F6R²6öç6öÆRæW'&÷"u¶æFfUöÆÆW%ÒrÂ&÷rç6ÇVrÂRæÖW76vR²Ð¢Ò°¢Ð§Ð ¢òòf'7B'Vâ32gFW"&ö÷BvfW2D"6öææV7Föç2FÖRFò6WGFÆRÀ¢òòFVâWfW'RÖâFW&VgFW"à§6WEFÖV÷WBÓâ°¢÷'VäÆÅFVæçEöÆÆW'2æ6F6RÓâ6öç6öÆRæW'&÷"u·öÆÆW%ÒæB'Vã¢rÂRæÖW76vR°¢6WDçFW'fÂÓâ°¢÷'VäÆÅFVæçEöÆÆW'2æ6F6RÓâ6öç6öÆRæW'&÷"u·öÆÆW%ÒF6³¢rÂRæÖW76vR°¢ÒÂR¢c¢°§ÒÂ3¢° ¢òòÒÒÒÒvÆö&ÂW'&÷"ÖFFÆWv&R×W7B&RÄ5BÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¢òòçFær&÷WFRæFÆW"F&÷w2÷"fV¦V7G2VæG2WW&RâÆöw2Fð¢òòFRW'&÷%öÆöw2F&ÆR²&WGW&ç2SFòFR6ÆÆW"âFRW6W"6¶V@¢òòW2Fò6GW&RWfW'W'&÷"â÷W"&ö¦V7B(	BF22FR6F6ÖÆÂà¦çW6RW'&÷$Æöw2æW&W74W'&÷$ÖFFÆWv&R° ¢òò&ö6W72ÖÆWfVÂ6fWGæWB(	BæöBvÆÂ¶VW'VææærgFW"FW6RÀ¢òò6ò2Æöær2vR&V6÷&BFVÒvR6â&W6öÇfRFVÒÆFW"à§&ö6W72æöâwVææFÆVE&V¦V7FöârÂ&V6öâÓâ°¢6öç6öÆRæW'&÷"u·VææFÆVE&V¦V7FöåÒrÂ&V6öâ°¢W'&÷$Æöw2æÆötW'&÷"°¢6÷W&6S¢w&ö6W72rÀ¢6WfW&G¢vfFÂrÀ¢ÖW76vS¢&V6öâbb&V6öâæÖW76vRÇÂ7G&ær&V6öâÀ¢7F6³¢&V6öâbb&V6öâç7F6°¢Òæ6F6Óâ·Ò°§Ò°§&ö6W72æöâwVæ6VvDW6WFöârÂW'"Óâ°¢6öç6öÆRæW'&÷"u·Væ6VvDW6WFöåÒrÂW'"°¢W'&÷$Æöw2æÆötW'&÷"°¢6÷W&6S¢w&ö6W72rÀ¢6WfW&G¢vfFÂrÀ¢ÖW76vS¢W'"bbW'"æÖW76vRòW'"æÖW76vR¢7G&ærW'"À¢7F6³¢W'"bbW'"ç7F6°¢Òæ6F6Óâ·Ò°§Ò° ¢òòÒÒÒÒFö72DÔÂvVæW&F÷"ÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦gVæ7FöâöFö74FÖÂ÷7B°¢6öç7BVæGöçBÒ÷7B²rööö²÷vV'6FRs°¢&WGW&âÂFö7GRFÖÃãÆFÖÂÆæsÒ&Vâ#ãÆVCà£ÆÖWF6'6WCÒ'WFbÓ"óà£ÆÖWFæÖSÒ'fWw÷'B"6öçFVçCÒ'vGFÖFWf6R×vGFÆæFÂ×66ÆSÓ"óà£ÇFFÆSäÆVB5$Ò(	BFö7VÖVçFFöãÂ÷FFÆSà£Ç7GÆSà¢§&ö÷B²ÒÖ&s¢3cs&²ÒÖ6&C¢6ffc²Ò×6ögC¢6cff3²Ò×FWC¢3cs&²ÒÖ×WFVC¢3cCsC#²ÒÖ'&æC¢3c3cfc²ÒÖ'&æC#¢6V3C²ÒÖ6öFS¢3cs&²ÒÖ6öFWFWC¢6Vc6f3²ÒÖ&÷&FW#¢6SVSvV#²Ð¢¢²&÷×6¦æs¢&÷&FW"Ö&÷²Ð¢&öG²Ö&vã£²föçBÖfÖÇ¢ÖÆR×77FVÒÅ6VvöRTÅ&ö&÷FòÇ6ç2×6W&c²&6¶w&÷VæC¢6c6cFcc²6öÆ÷#§f"Ò×FWB²ÆæRÖVvC£ãc²Ð¢VFW"²&6¶w&÷VæC¦ÆæV"Öw&FVçB3VFVrÇf"ÒÖ'&æBÂ3#V6cbÇf"ÒÖ'&æC"²6öÆ÷#¢6ffc²FFæs£"ãW&VÒãW&VÒ'&VÓ²Ð¢VFW"²Ö&vã£ã3W&VÓ²föçB×6¦S£ã&VÓ²Ð¢VFW"²Ö&vã£²÷6G¢ã²Ð¢Öâ²Ö×vGF£#²Ö&vã¢ÓãW&VÒWFò7&VÓ²FFæs£&VÓ²Ð¢æ6&B²&6¶w&÷VæC§f"ÒÖ6&B²&÷&FW"×&FW3£G²FFæs£ãW&VÒãsW&VÓ²Ö&vâÖ&÷GFöÓ£ã&VÓ²&÷×6F÷s£GG&v&RÃ#2ÃC"Âã²Ð¢"²Ö&vã£ãW&VÓ²föçB×6¦S£ã#W&VÓ²&÷&FW"ÖÆVgC£G6öÆBf"ÒÖ'&æB²FFærÖÆVgC¢ãw&VÓ²Ð¢2²Ö&vã£ãG&VÒãW&VÓ²föçB×6¦S£ãW&VÓ²6öÆ÷#§f"Ò×FWB²Ð¢6öFRÂ&R²föçBÖfÖÇ¢%4bÖöæò"ÄÖVæÆòÄÖöæ6òÄ6öç6öÆ2ÆÖöæ÷76S²Ð¢&R²&6¶w&÷VæC§f"ÒÖ6öFR²6öÆ÷#§f"ÒÖ6öFWFWB²FFæs£&VÒã&VÓ²&÷&FW"×&FW3£²÷fW&fÆ÷r×¦WFó²föçB×6¦S¢ã7&VÓ²ÆæRÖVvC£ãS²Ð¢&Ræ²²6öÆ÷#¢3vFC6f3²Ð¢&Rç2²6öÆ÷#¢6f6C3FC²Ð¢&Ræ2²6öÆ÷#¢3F6#²föçB×7GÆS¦FÆ3²Ð¢F&ÆR²vGF£S²&÷&FW"Ö6öÆÆ6S¦6öÆÆ6S²Ö&vã¢ãW&VÒ&VÓ²föçB×6¦S¢ã'&VÓ²Ð¢FÂFB²FWBÖÆvã¦ÆVgC²FFæs¢ãSW&VÒãg&VÓ²&÷&FW"Ö&÷GFöÓ£6öÆBf"ÒÖ&÷&FW"²fW'F6ÂÖÆvã§F÷²Ð¢F²&6¶w&÷VæC§f"Ò×6ögB²föçB×vVvC£c²föçB×6¦S¢ã'&VÓ²FWB×G&ç6f÷&Ó§WW&66S²ÆWGFW"×76æs¢ãVVÓ²6öÆ÷#§f"ÒÖ×WFVB²Ð¢FBæfVÆB6öFR²&6¶w&÷VæC§f"Ò×6ögB²FFæs£'g²&÷&FW"×&FW3£G²6öÆ÷#§f"ÒÖ'&æB²föçB×vVvC£c²Ð¢ç&W²6öÆ÷#¢6F3#c#c²föçB×vVvC£c²Ð¢çÆÂ²F7Æ¦æÆæRÖ&Æö6³²FFæs£'²&÷&FW"×&FW3£²föçB×6¦S¢ãs'&VÓ²föçB×vVvC£c²fW'F6ÂÖÆvã¦ÖFFÆS²Ð¢çÆÂ×÷7B²&6¶w&÷VæC¢3#²6öÆ÷#¢6ffc²Ð¢çW&Â²&6¶w&÷VæC§f"Ò×6ögB²FFæs¢ãcW&VÒãW&VÓ²&÷&FW"×&FW3£²föçBÖfÖÇ¦Ööæ÷76S²föçB×6¦S¢ãW&VÓ²v÷&BÖ'&V³¦'&V²ÖÆÃ²F7Æ¦fÆW²v¢ãW&VÓ²ÆvâÖFV×3¦6VçFW#²Ð¢æ6÷Ö'Fâ²&6¶w&÷VæC§f"ÒÖ'&æB²6öÆ÷#¢6ffc²&÷&FW#¦æöæS²FFæs¢ã3W&VÒãsW&VÓ²&÷&FW"×&FW3£g²7W'6÷#§öçFW#²föçB×6¦S¢ã&VÓ²Ð¢æ6÷Ö'Fã¦7FfR²G&ç6f÷&Ó§66ÆRãR²Ð¢VÂ²FFærÖÆVgC£ãG&VÓ²Ð¢Æ²Ö&vâÖ&÷GFöÓ¢ã7&VÓ²Ð¢çF'2²F7Æ¦fÆW²v¢ãG&VÓ²&÷&FW"Ö&÷GFöÓ£'6öÆBf"ÒÖ&÷&FW"²Ö&vâÖ&÷GFöÓ£²fÆW×w&§w&²Ð¢çF"²FFæs¢ãcW&VÒ&VÓ²7W'6÷#§öçFW#²&÷&FW#¦æöæS²&6¶w&÷VæC§G&ç7&VçC²6öÆ÷#§f"ÒÖ×WFVB²föçB×vVvC£S²föçB×6¦S¢ã&VÓ²&÷&FW"Ö&÷GFöÓ£'6öÆBG&ç7&VçC²Ö&vâÖ&÷GFöÓ¢Ó'²Ð¢çF"æ7FfR²6öÆ÷#§f"ÒÖ'&æB²&÷&FW"Ö&÷GFöÒÖ6öÆ÷#§f"ÒÖ'&æB²Ð¢çF"Ö&öG²F7Æ¦æöæS²Ð¢çF"Ö&öGæ7FfR²F7Æ¦&Æö6³²Ð¢ææbÖ&6²²F7Æ¦æÆæRÖ&Æö6³²6öÆ÷#¢6ffc²FWBÖFV6÷&Föã¦æöæS²÷6G¢ãS²Ö&vâÖ&÷GFöÓ¢ãW&VÓ²föçB×6¦S¢ãW&VÓ²Ð¢ææbÖ&6³¦÷fW"²÷6G£²Ð¢æÆW'B²&6¶w&÷VæC¢6fVc63s²&÷&FW"ÖÆVgC£G6öÆB6cSS#²FFæs¢ãsW&VÒ&VÓ²&÷&FW"×&FW3£g²Ö&vã£&VÒ²föçB×6¦S¢ã&VÓ²Ð¢æ&FvR²F7Æ¦æÆæRÖ&Æö6³²&6¶w&÷VæC¢6V6fFcS²6öÆ÷#¢3cVcCc²&÷&FW#£6öÆB3fVSv#s²FFæs£'²&÷&FW"×&FW3£G²föçB×6¦S¢ã&VÓ²föçB×vVvC£c²Ö&vâÖÆVgC¢ãG&VÓ²Ð£Â÷7GÆSà£ÂöVCãÆ&öGà£ÆVFW#à¢Æ6Æ73Ò&æbÖ&6²"&VcÒ"ò#î(i&6²Fò5$ÓÂöà¢Æï	ù9¢ÆVB5$Ò(	BFö7VÖVçFFöãÂöà¢Çå6VæBÆVG2g&öÒ÷W"vV'6FRÂÆæFærvRÂBÆFf÷&Ò÷"çWFW&æÂ77FVÒçFòFR5$ÒãÂ÷à£ÂöVFW#à£ÆÖãà £ÆFb6Æ73Ò&6&B#à¢Æ#ãâVæGöçCÂö#à¢ÇãÇ7â6Æ73Ò'ÆÂÆÂ×÷7B#åõ5CÂ÷7ãâ6VæBÆVG2Fó£Â÷à¢ÆFb6Æ73Ò'W&Â#à¢Æ6öFRCÒ&VæGöçB#âG¶VæGöçGÓÂö6öFSà¢Æ'WGFöâ6Æ73Ò&6÷Ö'Fâ"öæ6Æ6³Ò&6÷FWBrG¶VæGöçGÒrÂF2#ä6÷Âö'WGFöãà¢ÂöFcà¢Ç7GÆSÒ&Ö&vâ×F÷£&VÒ#ä66WG2&÷FÆ6öFSæÆ6Föâö§6öãÂö6öFSâæBÆ6öFSæÆ6Föâ÷×wwrÖf÷&Ò×W&ÆVæ6öFVCÂö6öFSâ&öFW2(	B6VæBv6WfW"2V6W"g&öÒ÷W"7F6²ãÂ÷à£ÂöFcà £ÆFb6Æ73Ò&6&B#à¢Æ#ã"âWFVçF6FöãÂö#à¢ÇäÆÂ&WVW7G2×W7Bæ6ÇVFR÷W"¶WâçöbFW6RÆö6Föç2266WFVC£Â÷à¢ÇF&ÆSà¢ÇFVCãÇG#ãÇFäÖWFöCÂ÷FãÇFäW×ÆSÂ÷FãÂ÷G#ãÂ÷FVCà¢ÇF&öGà¢ÇG#ãÇFCãÆ6öFSçÖÖ¶WÂö6öFSâVFW"Ç7â7GÆSÒ&6öÆ÷#¢3#¶föçB×vVvC£c#î)R&VfW'&VCÂ÷7ããÂ÷FCãÇFCãÆ6öFSçÖÖ¶W¢ÆVF7&Õ÷(
cÂö6öFSãÂ÷FCãÂ÷G#à¢ÇG#ãÇFCãÆ6öFSäWF÷&¦Föã¢&V&W#Âö6öFSâVFW#Â÷FCãÇFCãÆ6öFSäWF÷&¦Föã¢&V&W"ÆVF7&Õ÷(
cÂö6öFSãÂ÷FCãÂ÷G#à¢ÇG#ãÇFCãÆ6öFSæö¶WÂö6öFSâ&öGfVÆCÂ÷FCãÇFCãÆ6öFSæö¶WÖÆVF7&Õ÷(
cÂö6öFSâf÷&Ò÷7BÂ÷FCãÂ÷G#à¢ÇG#ãÇFCãÆ6öFSãöö¶WÓÂö6öFSâVW'&ÓÂ÷FCãÇFCãÆ6öFSâG¶VæGöçGÓöö¶WÖÆVF7&Õ÷(
cÂö6öFSãÂ÷FCãÂ÷G#à¢Â÷F&öGà¢Â÷F&ÆSà¢ÇävWB÷W"¶Wg&öÒ5$Ò(i"6WGFæw2(i"F"â6Æ6²Æ#ï	ùHB&VvVæW&FSÂö#âbBWfW"ÆV·2ãÂ÷à¢ÆFb6Æ73Ò&ÆW'B#î)ªûò¶VW÷W"¶W6V7&WBâFöâwBWBBâ6ÆVçB×6FR¦f67&B÷"V&Æ2vDV"&WòâW6R6W'fW"×6FR&÷b÷W"f÷&Ò2öâ7FF26FRãÂöFcà£ÂöFcà £ÆFb6Æ73Ò&6&B#à¢Æ#ã2â&WVW7B&öGÂö#à¢Çå6VæBVFW"¥4ôâ&öG÷"U$ÂÖVæ6öFVBf÷&ÒfVÆG2ÆÂ÷FöæÂW6WBÆ6öFSææÖSÂö6öFSâ²BÆV7BöæRöbÆ6öFSçöæSÂö6öFSâóÆ6öFSæVÖÃÂö6öFSâ£Â÷à¢ÇF&ÆSà¢ÇFVCãÇG#ãÇFäfVÆCÂ÷FãÇFåGSÂ÷FãÇFäFW67&FöãÂ÷FãÂ÷G#ãÂ÷FVCà¢ÇF&öGà¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSææÖSÂö6öFSâÇ7â6Æ73Ò'&W#â£Â÷7ããÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCäÆVBw2gVÆÂæÖSÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSçöæSÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCåöæRvF6÷VçG'6öFRÂRærâÆ6öFSâ³scSC3#Âö6öFSââÆ3¢Æ6öFSæÖö&ÆSÂö6öFSãÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSçvG6Âö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCåvG4çVÖ&W"âfÆÇ2&6²FòÆ6öFSçöæSÂö6öFSâböÖGFVBãÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSæVÖÃÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCäVÖÂFG&W73Â÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSç6÷W&6SÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCåvW&RFRÆVB6ÖRg&öÒâFVfVÇC¢Æ6öFSåvV'6FSÂö6öFSãÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSç&öGV7CÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCå&öGV7B÷"ÆâFWw&RçFW&W7FVBãÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSææ÷FW3Âö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCäg&VRÖf÷&Òæ÷FW2âÆ3¢Æ6öFSæÖW76vSÂö6öFSãÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSçFw3Âö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCä6öÖÖ×6W&FVBÆ&VÇ3¢Æ6öFSâ&÷BÇf#Âö6öFSââÆ3¢Æ6öFSæÆ&VÇ3Âö6öFSãÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSæ6ö×çÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCä6ö×çæÖSÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSæ6GÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCä6GÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSçWFÕ÷6÷W&6SÂö6öFSâòÆ6öFSçWFÕöÖVFVÓÂö6öFSâòÆ6öFSçWFÕö6×vãÂö6öFSâòÆ6öFSçWFÕ÷FW&ÓÂö6öFSâòÆ6öFSçWFÕö6öçFVçCÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCåUDÒGG&'WFöâ&ÖWFW'3Â÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSæv6ÆCÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCävöövÆR6Æ6²CÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSæÆæFæu÷vSÂö6öFSãÂ÷FCãÇFCç7G&æsÂ÷FCãÇFCåU$ÂFRÆVB7V&ÖGFVBg&öÓÂ÷FCãÂ÷G#à¢ÇG#ãÇFB6Æ73Ò&fVÆB#ãÆ6öFSæÖWFÂö6öFSãÂ÷FCãÇFCæö&¦V7B¥4ôâöæÇÂ÷FCãÇFCäçFFFöæÂ7G'V7GW&VBFFÂ÷FCãÂ÷G#à¢Â÷F&öGà¢Â÷F&ÆSà£ÂöFcà £ÆFb6Æ73Ò&6&B#à¢Æ#ãBâ6öFR6×ÆW3Âö#à¢ÆFb6Æ73Ò'F'2#à¢Æ'WGFöâ6Æ73Ò'F"7FfR"FF×F#Ò&7W&ÂÖ§6öâ#æ5U$Â¥4ôâÂö'WGFöãà¢Æ'WGFöâ6Æ73Ò'F""FF×F#Ò&7W&ÂÖf÷&Ò#æ5U$ÂU$ÂÖVæ6öFVBÇ7â6Æ73Ò&&FvR#ääUsÂ÷7ããÂö'WGFöãà¢Æ'WGFöâ6Æ73Ò'F""FF×F#Ò&§2#ä¦f67&CÂö'WGFöãà¢Æ'WGFöâ6Æ73Ò'F""FF×F#Ò&§6öf÷&Ò#äDÔÂf÷&ÓÂö'WGFöãà¢Æ'WGFöâ6Æ73Ò'F""FF×F#Ò'#åÂö'WGFöãà¢Æ'WGFöâ6Æ73Ò'F""FF×F#Ò'Föâ#åFöãÂö'WGFöãà¢Æ'WGFöâ6Æ73Ò'F""FF×F#Ò'w#åv÷&E&W73Âö'WGFöãà¢ÂöFcà ¢ÆFb6Æ73Ò'F"Ö&öG7FfR"FF×F#Ò&7W&ÂÖ§6öâ#à£Ç&SãÇ7â6Æ73Ò&2#â2¥4ôâ&öG(	BÖ÷7B6öÖÖöâf÷"6W'fW"×Fò×6W'fW#Â÷7ãà¦7W&ÂÕõ5BÇ7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâÅÀ¢ÔÇ7â6Æ73Ò'2#âwÖÖ¶W¢õU%ôô´UsÂ÷7ãâÅÀ¢ÔÇ7â6Æ73Ò'2#ât6öçFVçBÕGS¢Æ6Föâö§6öâsÂ÷7ãâÅÀ¢ÖBÇ7â6Æ73Ò'2#âw°¢&æÖR#¢%&¦W6·VÖ""À¢'öæR#¢"³scSC3#"À¢&VÖÂ#¢'&¦W6W×ÆRæ6öÒ"À¢'6÷W&6R#¢%vV'6FR6öçF7Bf÷&Ò"À¢&æ÷FW2#¢%vçG2FVÖò"À¢'Fw2#¢&÷BÆFVÖò×&WVW7FVB"À¢'WFÕ÷6÷W&6R#¢&vöövÆR"À¢'WFÕö6×vâ#¢'7VÖÖW"×6ÆR ¢ÒsÂ÷7ããÂ÷&Sà¢ÂöFcà ¢ÆFb6Æ73Ò'F"Ö&öG"FF×F#Ò&7W&ÂÖf÷&Ò#à£Ç&SãÇ7â6Æ73Ò&2#â2Æ6Föâ÷×wwrÖf÷&Ò×W&ÆVæ6öFVB(	Bv÷&·2vFDÔÂf÷&×2ÃÂ÷7ãà£Ç7â6Æ73Ò&2#â2¦W"Â&&ÇÂÖ¶RÂãâ$EE&WVW7B"æöFW2ÂWF2ãÂ÷7ãà¦7W&ÂÕõ5BÇ7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâÅÀ¢ÔÇ7â6Æ73Ò'2#âwÖÖ¶W¢õU%ôô´UsÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âvæÖSÕ&¦W6·VÖ"sÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âwöæSÒ³scSC3#sÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âvVÖÃ×&¦W6W×ÆRæ6öÒsÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âw6÷W&6SÕvV'6FR6öçF7Bf÷&ÒsÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âvæ÷FW3ÕvçG2FVÖòsÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âwFw3Ö÷BÆFVÖò×&WVW7FVBsÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âwWFÕ÷6÷W&6SÖvöövÆRsÂ÷7ãâÅÀ¢ÒÖFF×W&ÆVæ6öFRÇ7â6Æ73Ò'2#âwWFÕö6×vã×7VÖÖW"×6ÆRsÂ÷7ãà £Ç7â6Æ73Ò&2#â2÷"vFÖB÷R×W7BW&6VçBÖVæ6öFRÖçVÆÇ£Â÷7ãà¦7W&ÂÕõ5BÇ7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâÅÀ¢ÔÇ7â6Æ73Ò'2#âwÖÖ¶W¢õU%ôô´UsÂ÷7ãâÅÀ¢ÔÇ7â6Æ73Ò'2#ât6öçFVçBÕGS¢Æ6Föâ÷×wwrÖf÷&Ò×W&ÆVæ6öFVBsÂ÷7ãâÅÀ¢ÖBÇ7â6Æ73Ò'2#âvæÖSÕ&¦W6´·VÖ"f×·öæSÒS$#scSC3#f×¶VÖÃ×&¦W6SCW×ÆRæ6öÒf×·6÷W&6SÕvV'6FRf×·Fw3Ö÷BS$6FVÖòsÂ÷7ããÂ÷&Sà¢ÂöFcà ¢ÆFb6Æ73Ò'F"Ö&öG"FF×F#Ò&§2#à£Ç&SãÇ7â6Æ73Ò&2#âòòæöFRæ§2òæWBæ§2(	B¥4ôâ&öG6W'fW"×6FRöæÇÂæWfW"W÷6R¶Wâ'&÷w6W"Â÷7ãà£Ç7â6Æ73Ò&²#æ6öç7CÂ÷7ãâ&W7öç6RÒÇ7â6Æ73Ò&²#ævCÂ÷7ãâfWF6Ç7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâÂ°¢ÖWFöC¢Ç7â6Æ73Ò'2#âuõ5BsÂ÷7ãâÀ¢VFW'3¢°¢Ç7â6Æ73Ò'2#âwÖÖ¶WsÂ÷7ãã¢&ö6W72æVçbäÄTD5$Õôô´UÀ¢Ç7â6Æ73Ò'2#ât6öçFVçBÕGRsÂ÷7ãã¢Ç7â6Æ73Ò'2#âvÆ6Föâö§6öâsÂ÷7ãà¢ÒÀ¢&öG¢¥4ôâç7G&ævg°¢æÖS¢Ç7â6Æ73Ò'2#âu&¦W6·VÖ"sÂ÷7ãâÂöæS¢Ç7â6Æ73Ò'2#âr³scSC3#sÂ÷7ãâÀ¢VÖÃ¢Ç7â6Æ73Ò'2#âw&¦W6W×ÆRæ6öÒsÂ÷7ãâÂ6÷W&6S¢Ç7â6Æ73Ò'2#âuvV'6FRsÂ÷7ãâÀ¢Fw3¢Ç7â6Æ73Ò'2#âv÷BÆFVÖò×&WVW7FVBsÂ÷7ãâÂæ÷FW3¢Ç7â6Æ73Ò'2#âuvçG2FVÖòsÂ÷7ãà¢Ò§Ò°£Ç7â6Æ73Ò&²#æ6öç7CÂ÷7ãâFFÒÇ7â6Æ73Ò&²#ævCÂ÷7ãâ&W7öç6Ræ§6öâ°¦6öç6öÆRæÆörFF²Ç7â6Æ73Ò&2#âòò²ö³¢G'VRÂÆVEöC¢#3BÂ76væVE÷Fó¢RÓÂ÷7ããÂ÷&Sà¢ÂöFcà ¢ÆFb6Æ73Ò'F"Ö&öG"FF×F#Ò&§2Öf÷&Ò#à£Ç&SâfÇC³Ç7â6Æ73Ò&²#æf÷&ÓÂ÷7ãâCÓÇ7â6Æ73Ò'2#â&ÆVBÖf÷&Ò#Â÷7ãâfwC°¢fÇC³Ç7â6Æ73Ò&²#æçWCÂ÷7ãâæÖSÓÇ7â6Æ73Ò'2#â&æÖR#Â÷7ãâ&WV&VBòfwC°¢fÇC³Ç7â6Æ73Ò&²#æçWCÂ÷7ãâæÖSÓÇ7â6Æ73Ò'2#â'öæR#Â÷7ãâ&WV&VBòfwC°¢fÇC³Ç7â6Æ73Ò&²#æçWCÂ÷7ãâæÖSÓÇ7â6Æ73Ò'2#â&VÖÂ#Â÷7ãâòfwC°¢fÇC³Ç7â6Æ73Ò&²#çFWF&VÂ÷7ãâæÖSÓÇ7â6Æ73Ò'2#â&ÖW76vR#Â÷7ãâfwC²fÇC²÷FWF&VfwC°¢fÇC³Ç7â6Æ73Ò&²#æ'WGFöãÂ÷7ãâfwCµ7V&ÖBfÇC²ö'WGFöâfwC°¢fÇC²óÇ7â6Æ73Ò&²#æf÷&ÓÂ÷7ãâfwC°¢fÇC³Ç7â6Æ73Ò&²#ç67&CÂ÷7ãâfwC°¦Fö7VÖVçBævWDVÆVÖVçD'BÇ7â6Æ73Ò'2#âvÆVBÖf÷&ÒsÂ÷7ãâæFDWfVçDÆ7FVæW"Ç7â6Æ73Ò'2#âw7V&ÖBsÂ÷7ãâÂÇ7â6Æ73Ò&²#æ7æ3Â÷7ãâRÒfwC²°¢Rç&WfVçDFVfVÇB°¢Ç7â6Æ73Ò&²#æ6öç7CÂ÷7ãâFFÒö&¦V7Bæg&öÔVçG&W2Ç7â6Æ73Ò&²#ææWsÂ÷7ãâf÷&ÔFFRçF&vWB°¢FFç6÷W&6RÒÇ7â6Æ73Ò'2#âtÆæFærvRsÂ÷7ãã°¢Ç7â6Æ73Ò&²#æ6öç7CÂ÷7ãâ"ÒÇ7â6Æ73Ò&²#ævCÂ÷7ãâfWF6Ç7â6Æ73Ò'2#âuõU%ô$4´TäEõ$õõU$ÂsÂ÷7ãâÂ²Ç7â6Æ73Ò&2#âòò(i&÷WFRF&÷Vv÷W"&6¶VæCÂ÷7ãà¢ÖWFöC¢Ç7â6Æ73Ò'2#âuõ5BsÂ÷7ãâÀ¢VFW'3¢²Ç7â6Æ73Ò'2#ât6öçFVçBÕGRsÂ÷7ãã¢Ç7â6Æ73Ò'2#âvÆ6Föâö§6öâsÂ÷7ãâÒÀ¢&öG¢¥4ôâç7G&ævgFF¢Ò°¢ÆW'B"æö²òÇ7â6Æ73Ò'2#âuFæ·2(	BvRvÆÂ&V6÷WBsÂ÷7ãâ¢Ç7â6Æ73Ò'2#âu6öÖWFærvVçBw&öærsÂ÷7ãâ°§Ò°¢fÇC²óÇ7â6Æ73Ò&²#ç67&CÂ÷7ãâfwC³Â÷&Sà¢ÆFb6Æ73Ò&ÆW'B#î)ªûòæWfW"WB÷W"¶Wâ'&÷w6W"¥2â&÷WFRf÷&Ò7V&Ö76öç2F&÷Vv&6¶VæBVæGöçBFBFG2FR¶WãÂöFcà¢ÂöFcà ¢ÆFb6Æ73Ò'F"Ö&öG"FF×F#Ò'#à£Ç&SâfÇC³óÇ7â6Æ73Ò&²#çÂ÷7ãà£Ç7â6Æ73Ò&2#âòò¥4ôâ&öGÂ÷7ãà¢FFFÒ²væÖRrÒfwC²u&¦W6·VÖ"rÂwöæRrÒfwC²r³scSC3#rÀ¢vVÖÂrÒfwC²w&¦W6W×ÆRæ6öÒrÂwFw2rÒfwC²v÷BÆFVÖòuÓ°¢F6Ò7W&ÅöæBÇ7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâ°¦7W&Å÷6WF÷Eö'&F6Â°¢5U$ÄõEõõ5BÒfwC²Ç7â6Æ73Ò&²#çG'VSÂ÷7ãâÂ5U$ÄõEõ$UEU$åE$å4dU"ÒfwC²Ç7â6Æ73Ò&²#çG'VSÂ÷7ãâÀ¢5U$ÄõEôEETDU"ÒfwC²²wÖÖ¶W¢râvWFVçbtÄTD5$Õôô´UrÀ¢t6öçFVçBÕGS¢Æ6Föâö§6öâuÒÀ¢5U$ÄõEõõ5DdTÄE2ÒfwC²§6öåöVæ6öFRFFFÀ¥Ò°¢G&W7VÇBÒ§6öåöFV6öFR7W&ÅöWV2F6ÂÇ7â6Æ73Ò&²#çG'VSÂ÷7ãâ°¦7W&Åö6Æ÷6RF6° £Ç7â6Æ73Ò&2#âòòU$ÂÖVæ6öFVB&öGÇFW&æFfR(	Bv÷&·2vFçf÷&ÒÂ÷7ãà¦7W&Å÷6WF÷Eö'&F6"Ò7W&ÅöæBÇ7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâÂ°¢5U$ÄõEõõ5BÒfwC²Ç7â6Æ73Ò&²#çG'VSÂ÷7ãâÂ5U$ÄõEõ$UEU$åE$å4dU"ÒfwC²Ç7â6Æ73Ò&²#çG'VSÂ÷7ãâÀ¢5U$ÄõEôEETDU"ÒfwC²²wÖÖ¶W¢râvWFVçbtÄTD5$Õôô´UrÒÀ¢5U$ÄõEõõ5DdTÄE2ÒfwC²GGö'VÆE÷VW'FFFÂÇ7â6Æ73Ò&2#âòò6VæG22W&ÆVæ6öFVCÂ÷7ãà¥Ò°¢G&W7VÇC"Ò§6öåöFV6öFR7W&ÅöWV2F6"ÂÇ7â6Æ73Ò&²#çG'VSÂ÷7ãâ³Â÷&Sà¢ÂöFcà ¢ÆFb6Æ73Ò'F"Ö&öG"FF×F#Ò'Föâ#à£Ç&SãÇ7â6Æ73Ò&²#æ×÷'CÂ÷7ãâ&WVW7G2Â÷0¤TDU%2Ò³Ç7â6Æ73Ò'2#â'ÖÖ¶W#Â÷7ãã¢÷2æVçf&öå³Ç7â6Æ73Ò'2#â$ÄTD5$Õôô´U#Â÷7ãå×Ð§ÆöBÒ³Ç7â6Æ73Ò'2#â&æÖR#Â÷7ãã¢Ç7â6Æ73Ò'2#â%&¦W6·VÖ"#Â÷7ãâÂÇ7â6Æ73Ò'2#â'öæR#Â÷7ãã¢Ç7â6Æ73Ò'2#â"³scSC3##Â÷7ãâÀ¢Ç7â6Æ73Ò'2#â&VÖÂ#Â÷7ãã¢Ç7â6Æ73Ò'2#â'&¦W6W×ÆRæ6öÒ#Â÷7ãâÂÇ7â6Æ73Ò'2#â'Fw2#Â÷7ãã¢Ç7â6Æ73Ò'2#â&÷BÆFVÖò#Â÷7ãçÐ £Ç7â6Æ73Ò&2#â2¥4ôãÂ÷7ãà§"Ò&WVW7G2ç÷7BÇ7â6Æ73Ò'2#â"G¶VæGöçGÒ#Â÷7ãâÂVFW'3ÔTDU%2Â§6öã×ÆöBÂFÖV÷WCÓ £Ç7â6Æ73Ò&2#â2U$ÂÖVæ6öFVB6ÖR&W7VÇB(	BW6VgVÂf÷"¦W"vV&öö·2òfÆ6²f÷&ÒæFÆW'2Â÷7ãà§"Ò&WVW7G2ç÷7BÇ7â6Æ73Ò'2#â"G¶VæGöçGÒ#Â÷7ãâÂVFW'3ÔTDU%2ÂFF×ÆöBÂFÖV÷WCÓ £Ç7â6Æ73Ò&²#ç&çCÂ÷7ãâ"æ§6öâÂ÷&Sà¢ÂöFcà¢ÆFb6Æ73Ò'F"Ö&öG"FF×F#Ò'w#à£Ç&SãÇ7â6Æ73Ò&2#âòòFBFògVæ7Föç2ç(	B6VæG2WfW'6öçF7Bf÷&Òr7V&Ö76öâFò5$ÓÂ÷7ãà¦FEö7FöâÇ7â6Æ73Ò'2#âww6cuöÖÅ÷6VçBsÂ÷7ãâÂÇ7â6Æ73Ò&²#ægVæ7FöãÂ÷7ãâFf÷&Ò°¢G7V"Òu4cuõ7V&Ö76öã£¦vWEöç7Fæ6R°¢Ç7â6Æ73Ò&²#æcÂ÷7ãâG7V"Ç7â6Æ73Ò&²#ç&WGW&ãÂ÷7ãã°¢FBÒG7V"ÓævWE÷÷7FVEöFF°¢w÷&VÖ÷FU÷÷7BÇ7â6Æ73Ò'2#ârG¶VæGöçGÒsÂ÷7ãâÂ°¢Ç7â6Æ73Ò'2#âvVFW'2sÂ÷7ãâÒfwC²³Ç7â6Æ73Ò'2#âwÖÖ¶WsÂ÷7ãâÒfwC²Ç7â6Æ73Ò'2#âuõU%õtT%4DUôô´UsÂ÷7ãâÀ¢Ç7â6Æ73Ò'2#ât6öçFVçBÕGRsÂ÷7ãâÒfwC²Ç7â6Æ73Ò'2#âvÆ6Föâö§6öâsÂ÷7ãåÒÀ¢Ç7â6Æ73Ò'2#âv&öGsÂ÷7ãâÒfwC²wö§6öåöVæ6öFR°¢Ç7â6Æ73Ò'2#âvæÖRsÂ÷7ãâÒfwC²FE³Ç7â6Æ73Ò'2#âw÷W"ÖæÖRsÂ÷7ãåÒóòÇ7â6Æ73Ò'2#ârsÂ÷7ãâÀ¢Ç7â6Æ73Ò'2#âvVÖÂsÂ÷7ãâÒfwC²FE³Ç7â6Æ73Ò'2#âw÷W"ÖVÖÂsÂ÷7ãåÒóòÇ7â6Æ73Ò'2#ârsÂ÷7ãâÀ¢Ç7â6Æ73Ò'2#âwöæRsÂ÷7ãâÒfwC²FE³Ç7â6Æ73Ò'2#âw÷W"×öæRsÂ÷7ãåÒóòÇ7â6Æ73Ò'2#ârsÂ÷7ãâÀ¢Ç7â6Æ73Ò'2#âvæ÷FW2sÂ÷7ãâÒfwC²FE³Ç7â6Æ73Ò'2#âw÷W"ÖÖW76vRsÂ÷7ãåÒóòÇ7â6Æ73Ò'2#ârsÂ÷7ãâÀ¢ÒÀ¢Ç7â6Æ73Ò'2#âwFÖV÷WBsÂ÷7ãâÒfwC²À¢Ò°§Ò³Â÷&Sà¢ÂöFcà £ÂöFcãÂÒÒòæ6&B6öFR6×ÆW2ÒÓà £ÆFb6Æ73Ò&6&B#à¢Æ#ãRâÆfRFW7CÂö#à¢ÇåW6RFRf÷&Ò&VÆ÷rFò6VæBFW7BÆVBF&V7FÇFòF2v÷&·76RâFRÆVBvÆÂV"ÖÖVFFVÇâ÷W"5$ÒãÂ÷à¢Æf÷&ÒCÒ'FW7Df÷&Ò"7GÆSÒ&F7Æ¦w&C¶v¢ãsW&VÓ¶Ö×vGF£C#à¢ÆçWBæÖSÒ&æÖR"Æ6VöÆFW#Ò$gVÆÂæÖR"&WV&VB7GÆSÒ'FFæs¢ãSW&VÒãsW&VÓ¶&÷&FW#£6öÆBf"ÒÖ&÷&FW"¶&÷&FW"×&FW3£¶föçB×6¦S£&VÒ"óà¢ÆçWBæÖSÒ'öæR"Æ6VöÆFW#Ò%öæRçVÖ&W""7GÆSÒ'FFæs¢ãSW&VÒãsW&VÓ¶&÷&FW#£6öÆBf"ÒÖ&÷&FW"¶&÷&FW"×&FW3£¶föçB×6¦S£&VÒ"óà¢ÆçWBæÖSÒ&VÖÂ"Æ6VöÆFW#Ò$VÖÂFG&W72"7GÆSÒ'FFæs¢ãSW&VÒãsW&VÓ¶&÷&FW#£6öÆBf"ÒÖ&÷&FW"¶&÷&FW"×&FW3£¶föçB×6¦S£&VÒ"óà¢ÆçWBæÖSÒ&æ÷FW2"Æ6VöÆFW#Ò$æ÷FW2÷FöæÂ"7GÆSÒ'FFæs¢ãSW&VÒãsW&VÓ¶&÷&FW#£6öÆBf"ÒÖ&÷&FW"¶&÷&FW"×&FW3£¶föçB×6¦S£&VÒ"óà¢Æ'WGFöâGSÒ'7V&ÖB"7GÆSÒ&&6¶w&÷VæC§f"ÒÖ'&æB¶6öÆ÷#¢6ffc¶&÷&FW#¦æöæS·FFæs¢ãcW&VÒã'&VÓ¶&÷&FW"×&FW3£¶föçB×6¦S£&VÓ¶7W'6÷#§öçFW#¶föçB×vVvC£c#å6VæBFW7BÆVCÂö'WGFöãà¢ÆFbCÒ'FW7E&W7VÇB"7GÆSÒ&F7Æ¦æöæS·FFæs¢ãcW&VÓ¶&÷&FW"×&FW3£¶föçB×6¦S¢ã'&VÒ#ãÂöFcà¢Âöf÷&Óà£ÂöFcà £ÂöÖãà£Ç67&Cà¢òòF"7vF6W ¦Fö7VÖVçBçVW'6VÆV7F÷$ÆÂrçF'2ræf÷$V6F'2Óâ°¢F'2çVW'6VÆV7F÷$ÆÂrçF"ræf÷$V6'FâÓâ°¢'FâæFDWfVçDÆ7FVæW"v6Æ6²rÂÓâ°¢6öç7B¶WÒ'FâæFF6WBçF#°¢6öç7B6&BÒ'Fâæ6Æ÷6W7Bræ6&Br°¢6&BçVW'6VÆV7F÷$ÆÂrçF"ræf÷$V6BÓâBæ6Æ74Æ7BçFövvÆRv7FfRrÂBæFF6WBçF"ÓÓÒ¶W°¢6&BçVW'6VÆV7F÷$ÆÂrçF"Ö&öGræf÷$V6"Óâ"æ6Æ74Æ7BçFövvÆRv7FfRrÂ"æFF6WBçF"ÓÓÒ¶W°¢Ò°¢Ò°§Ò°¢òò6÷VÇW ¦gVæ7Föâ6÷FWBFWBÂ'Fâ°¢æfvF÷"æ6Æ&ö&Bçw&FUFWBFWBçFVâÓâ°¢6öç7B÷&rÒ'FâçFWD6öçFVçC°¢'FâçFWD6öçFVçBÒt6÷VBs°¢6WEFÖV÷WBÓâ'FâçFWD6öçFVçBÒ÷&rÂS°¢Ò°§Ð¢òòÆfRFW7Bf÷&Ð¦Fö7VÖVçBævWDVÆVÖVçD'BwFW7Df÷&ÒræFDWfVçDÆ7FVæW"w7V&ÖBrÂ7æ2RÓâ°¢Rç&WfVçDFVfVÇB°¢6öç7BfBÒæWrf÷&ÔFFRçF&vWB°¢6öç7B&öGÒ·Ó°¢fBæf÷$V6bÂ²Óâ²bb&öG¶µÒÒc²Ò°¢6öç7B&W2ÒFö7VÖVçBævWDVÆVÖVçD'BwFW7E&W7VÇBr°¢&W2ç7GÆRæF7ÆÒv&Æö6²s°¢&W2ç7GÆRæ&6¶w&÷VæBÒr6fVc32s°¢&W2çFWD6öçFVçBÒu6VæFæ~(
bs°¢G'°¢6öç7B"ÒvBfWF6rG¶VæGöçGÒrÂ°¢ÖWFöC¢uõ5BrÀ¢VFW'3¢²t6öçFVçBÕGRs¢vÆ6Föâö§6öârÒÀ¢&öG¢¥4ôâç7G&ævg&öGÀ¢Ò°¢6öç7B§6öâÒvB"æ§6öâ°¢b§6öâæö²°¢&W2ç7GÆRæ&6¶w&÷VæBÒr6V6fFcRs²&W2ç7GÆRæ6öÆ÷"Òr3cVcCbs°¢&W2çFWD6öçFVçBÒ~)É2ÆVB7&VFVB6V6²÷W"5$ÒF6&ö&Bâs°¢ÒVÇ6R°¢&W2ç7GÆRæ&6¶w&÷VæBÒr6fVc&c"s²&W2ç7GÆRæ6öÆ÷"Òr3#"s°¢&W2çFWD6öçFVçBÒ~)Érr²§6öâæW'&÷"ÇÂuVæ¶æ÷vâW'&÷"r°¢Ð¢Ò6F6W'"°¢&W2ç7GÆRæ&6¶w&÷VæBÒr6fVc&c"s²&W2ç7GÆRæ6öÆ÷"Òr3#"s°¢&W2çFWD6öçFVçBÒ~)Ér&WVW7BfÆVC¢r²W'"æÖW76vS°¢Ð§Ò°£Â÷67&Cà£Âö&öGãÂöFÖÃæ°§Ð ¢òòÒÒÒÒ&ö÷BbÆ7FVâÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÒÐ¦6öç7Bõ%BÒçVÖ&W"&ö6W72æVçbåõ%BÇÂ3°¦6öç7Bõ5BÒ&ö6W72æVçbäõ5BÇÂsãããs° ¢7æ2Óâ°¢6öç6öÆRæÆör¶&ö÷EÒ6Ö'D5$Ò627F'FæröâG´õ5GÓ¢Gµõ%GÒæöFRG·&ö6W72çfW'6öçÒ°¢6öç6öÆRæÆör¶&ö÷EÒDD$4UõU$Â6WC¢G²&ö6W72æVçbäDD$4UõU$ÇÖ°¢6öç6öÆRæÆör¶&ö÷EÒ4ôåE$ôÅôDD$4UõU$Â6WC¢G²&ö6W72æVçbä4ôåE$ôÅôDD$4UõU$ÇÖ°¢6öç6öÆRæÆör¶&ö÷EÒ¥uEõ4T5$UB6WC¢G²&ö6W72æVçbä¥uEõ4T5$UGÖ°¢æÆ7FVâõ%BÂõ5BÂÓâ°¢6öç6öÆRæÆörsÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒr°¢6öç6öÆRæÆör6Ö'D5$Ò62'Vææær(i"GG¢òòG´õ5GÓ¢Gµõ%GÖ°¢6öç6öÆRæÆörsÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÓÒr°¢Ò°§Ò° 
