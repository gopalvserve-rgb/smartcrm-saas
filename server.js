/**
 * SmartCRM SaaS — single-process multi-tenant server.
 *
 * URL surface:
 *   GET  /                           → public landing + pricing
 *   POST /api/saas                   → public + super-admin SaaS dispatcher
 *   GET  /api/saas/brand             → public brand JSON for the landing page
 *   GET  /signup/return              → Cashfree return URL (verifies + redirects to /t/<slug>)
 *   POST /hook/cashfree              → Cashfree webhook (raw-body required for HMAC verify)
 *   GET  /admin/                     → super-admin SPA shell (calls /api/saas)
 *   GET  /t/<slug>                   → tenant CRM SPA shell
 *   POST /t/<slug>/api               → tenant API dispatcher (per-tenant DB)
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
app.use(require('cookie-parser')());

// ---- Static assets --------------------------------------------
// Public landing site lives at /saas/* and is served at the root URL.
//
// Cache strategy:
//   - HTML files always get no-cache so a deploy shows up immediately
//     when the user revisits.
//   - JS / CSS get a short max-age (60s) — index.html references them
//     with a ?v=… cache buster, so a deploy that bumps the buster
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

// Diagnostic — admin-only smoke test that the Railway egress can
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
// handlers POST here — body is treated as untrusted, capped + redacted
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
//   Lead Ads webhook URL (Webhooks → Page → leadgen):
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
//     this for a control-plane page_id → tenant_id lookup table; for
//     the MVP this is fast enough.)
//   - WhatsApp webhook: payload contains phone_number_id; same lookup.
const fbRoute = require('./routes/fb');
const webhooksRoute = require('./routes/webhooks');
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
 * tenant — find the tenant whose DB has the matching record. Walks the
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
    } catch (_) { /* table missing or other — skip */ }
  }
  return null;
}

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ---- Facebook OAuth callback (one URL for all tenants) ----------
app.get('/fb/auth/callback', async (req, res) => {
  const stateRaw = (req.query.state || '').toString();
  // Decode state (no verify) to get slug for routing — the inner
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
//   GET  with hub.mode=subscribe&hub.verify_token=…&hub.challenge=… → echo challenge
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
  // the same trust model FB uses — they only ever ask once at hook
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
  // attachTenant has already populated req.tenant — no lookup needed.
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
  // Fast path — forwarder dispatched to /t/<slug>/hook/whatsapp.
  if (req.tenant) return webhooksRoute.whatsappEvent(req, res);
  // Slow path — bare /hook/whatsapp; look up by phone_number_id.
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

// /hook/whatsapp_webhook is the WhatsBot module's own endpoint —
// same routing logic, different handler.
app.get('/hook/whatsapp_webhook', async (req, res) => {
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  // Fast path — verify GET to /t/<slug>/hook/whatsapp_webhook with
  // tenant already resolved. Just check this tenant's stored token.
  if (req.tenant && req.tenantPool) {
    try {
      const hit = await req.tenantPool.query(`SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`);
      const cfg = hit.rows[0] && hit.rows[0].value;
      if (cfg && cfg === token) return res.type('text/plain').send(challenge);
    } catch (_) {}
    return res.status(403).send('Verify token mismatch');
  }
  // Slow path — direct hit on bare /hook/whatsapp_webhook, walk all tenants.
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
  // Fast path — forwarder dispatched to /t/<slug>/hook/whatsapp_webhook.
  // This is the canonical path each tenant registers when they connect
  // via Embedded Sign-In (whatsbot.js _registerWithCentralForwarder),
  // so this branch handles the common case zero-lookup.
  if (req.tenant) return whatsbotRoute.expressEvent(req, res);
  // Slow path — direct hit on bare /hook/whatsapp_webhook.
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
  //   /t/acme?ssl=eyJ…
  // by producing /t/acme?ssl=eyJ…/ which corrupts the JWT value.
  const qIdx = req.originalUrl.indexOf('?');
  const target = qIdx === -1
    ? req.originalUrl + '/'
    : req.originalUrl.slice(0, qIdx) + '/' + req.originalUrl.slice(qIdx);
  res.redirect(301, target);
});

// Tenant "not found" placeholder — only serves when the slug doesn't
// resolve to an active tenant row. For valid tenants we fall through
// to the static-asset + SPA-shell handlers further down, which serve
// public/tenant/index.html (the actual CRM UI).
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
  // Tenant exists → let attachTenant + the SPA handler take over.
  // (The "?ssl=…" magic-link case also flows through here — the SPA
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
// hit the control DB (DATABASE_URL) and either crash or — worse —
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
  // Must have a resolved tenant — otherwise this isn't a tenant call
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
// — and the browser saved that JSON as the "sample sheet". Mount the
// same handler the original Celeste server uses, but only inside a
// tenant scope so the custom-field columns come from THIS tenant's DB.
function _csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/sample.csv', async (req, res, next) => {
  if (!req.tenant) return next();   // root-level call → fall through to JSON 404

  // Pull custom fields so the template includes every cf_<key> column
  // currently defined in this tenant's DB. Runs inside tenantStorage,
  // so tenantDb.getAll() picks up the right pool automatically.
  let customFields = [];
  try {
    customFields = (await tenantDb.getAll('custom_fields'))
      .filter(c => Number(c.is_active) !== 0 && c.key)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  } catch (_) { /* fresh tenant with no custom fields — ok */ }

  const baseCols = [
    // 1. Contact
    'name', 'phone', 'alt_phone', 'whatsapp', 'email',
    // 2. Routing — status / source / product accepted by NAME, assigned_to by email-or-name-or-id
    'status', 'source', 'source_ref', 'product', 'assigned_to',
    // 3. Address
    'address', 'city', 'state', 'pincode', 'country', 'company',
    // 4. Qualification
    'value', 'currency', 'qualified', 'tags',
    // 5. Activity
    'next_followup_at', 'notes',
    // 6. Migration timestamps — admins-only override; blank = "now"
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
      notes: 'Demo requested — interested in premium tier'
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

// ---- Tenant SPA shell ---------------------------------------------
// Serve the per-tenant CRM SPA. After attachTenant rewrites
// /t/<slug>/ to /, GET / lands here when there's a tenant on the
// request. Plain /<no-tenant> requests still go to the SaaS landing
// (handled by the earlier app.get('/') registration above).
app.get('/', (req, res, next) => {
  if (!req.tenant) return next();          // no tenant → fall through to landing/static
  res.sendFile(path.join(__dirname, 'public', 'tenant', 'index.html'));
});

// Serve tenant static assets (app.js, styles.css, sw.js, manifests,
// icons) under any path inside the tenant scope. The tenant SPA
// references these as /app.js, /styles.css, etc., which after
// attachTenant rewrites becomes /app.js — served from public/tenant.
app.use((req, res, next) => {
  if (!req.tenant) return next();
  return express.static(path.join(__dirname, 'public', 'tenant'), _staticOpts)(req, res, next);
});

// IMPORTANT — keep the static handler scoped to /saas so it can ONLY
// serve assets from public/saas (the landing site + admin SPA). The
// previous setup mounted public/ at the root, which silently served
// the legacy Celeste SPA (public/index.html + public/app.js) when a
// tenant URL got rewritten. The tenant CRM then tried to fetch /api
// endpoints that don't exist on this server, got HTML 404 responses
// back, and crashed clients with "Unexpected token '<', '<!DOCTYPE'…
// is not valid JSON". The legacy files have now been removed from the
// repo, but we also keep the static handler narrow so the bug can't
// silently come back.

// Renders the tenant welcome / "not found" page. Pure HTML, no JS,
// no fetch — by design, so this surface can never produce a JSON
// parse error on the user's screen.
function _renderTenantPlaceholder(req, res, slug, tenant) {
  const safe = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  // Decode an admin-minted "Login as tenant" token (?ssl=…) if present
  // so we can show the operator who they're impersonating. The token
  // itself is short-lived (5 min) and signed with JWT_SECRET; here we
  // only verify it for display — Phase 2's tenant auth layer will be
  // the actual consumer.
  let ssl = null;
  if (req.query && req.query.ssl) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(String(req.query.ssl), process.env.JWT_SECRET || 'change-me-in-production');
      if (payload && payload.ssl && payload.slug === slug) ssl = payload;
    } catch (_) { /* expired or tampered — ignore, show normal page */ }
  }
  if (!tenant) {
    return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"/>
<title>Workspace not found · SmartCRM</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:5rem auto;padding:0 1rem;color:#0f172a}
.card{background:#fef2f2;border:1px solid #fecaca;padding:1.5rem;border-radius:12px}
code{background:#fff;padding:.2rem .4rem;border-radius:4px}
a{color:#4338ca}</style>
<h1>🤔 Workspace not found</h1>
<div class="card">
  <p>The workspace <code>${safe(slug)}</code> doesn't exist or has been removed.</p>
</div>
<p><a href="/">← Back to SmartCRM home</a></p>`);
  }
  const t = tenant;
  res.type('html').send(`<!doctype html><meta charset="utf-8"/>
<title>${safe(t.org_name)} — SmartCRM</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.25rem;color:#0f172a;line-height:1.55}
.card{background:#ecfdf5;border:1px solid #6ee7b7;padding:1.5rem;border-radius:12px;margin:1.5rem 0}
.warn{background:#fef9c3;border-color:#facc15}
code{background:#fff;padding:.18rem .45rem;border-radius:4px;font-size:.92em}
h1{font-size:1.6rem;margin:0 0 .5rem}
h2{font-size:1.05rem;margin:0 0 .6rem;color:#0f766e}
.row{display:flex;flex-wrap:wrap;gap:.5rem .9rem;margin:.4rem 0}
.lbl{color:#64748b;font-size:.82rem;text-transform:uppercase;letter-spacing:.04em;margin-right:.3rem}
a{color:#4338ca;font-weight:500}</style>
${ssl ? `<div class="card" style="background:#dbeafe;border-color:#60a5fa;color:#1e3a8a">
  <h2 style="color:#1e40af">🔓 Logged in as tenant (admin sudo)</h2>
  <p>You opened this workspace from the admin panel. The tenant CRM SPA isn't mounted yet, so this is the welcome placeholder — but the magic-link token is valid and Phase 2's tenant auth layer will consume it automatically.</p>
  <div class="row"><span class="lbl">Acting as</span> <code>${safe(ssl.as_email)}</code></div>
  <div class="row"><span class="lbl">Sudo by</span> <code>${safe(ssl.sa_email)}</code></div>
  <div class="row"><span class="lbl">Token expires</span> ${new Date(ssl.exp * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
</div>` : ''}
<h1>👋 Welcome to ${safe(t.org_name)}</h1>
<p>Your SmartCRM workspace is registered.</p>
<div class="card">
  <h2>Workspace details</h2>
  <div class="row"><span class="lbl">URL</span> <code>/t/${safe(t.slug)}</code></div>
  <div class="row"><span class="lbl">Plan</span> ${t.package_id ? 'package #' + t.package_id : 'free'}</div>
  <div class="row"><span class="lbl">Status</span> <code>${safe(t.status)}</code></div>
  <div class="row"><span class="lbl">Login email</span> <code>${safe(t.contact_email)}</code></div>
</div>
<div class="card warn">
  <h2>Tenant CRM is still being wired up</h2>
  <p>The full SmartCRM workspace UI (leads, calls, WhatsApp, reports) is in the next deployment phase — the per-tenant DB has been provisioned, but the SPA isn't mounted under <code>/t/&lt;slug&gt;</code> yet.</p>
  <p>If you're the platform admin you can manage this tenant from the <a href="/admin/#/tenants">SmartCRM admin panel</a>.</p>
</div>
<p style="color:#94a3b8;font-size:.85rem;margin-top:2rem">Need help? Email <a href="mailto:support@smartcrmsolution.com">support@smartcrmsolution.com</a></p>`);
}

// JSON-safe 404 for any unmatched API path under either /api or
// /t/<slug>/api. Anything that calls fetch() expecting JSON now gets
// clean JSON back even if the function name is wrong / the route
// doesn't exist — preventing the "Unexpected token '<', '<!DOCTYPE'…"
// crash that the legacy public/app.js was hitting earlier.
app.all(/^\/api(\/.*)?$/, (req, res) => {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.originalUrl });
});

// Static assets live ONLY under /saas (mounted earlier above). No
// catch-all express.static here — see comment block at the top of
// this section for the rationale.

// ---- Global error middleware (must be LAST) -------------------
// Anything a route handler throws or rejects ends up here. Logs to
// the error_logs table + returns 500 to the caller. The user asked
// us to capture every error in our project — this is the catch-all.
app.use(errorLogs.expressErrorMiddleware);

// Process-level safety net — node will keep running after these,
// so as long as we record them we can resolve them later.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  errorLogs.logError({
    source: 'process',
    severity: 'fatal',
    message: (reason && reason.message) || String(reason),
    stack:   reason && reason.stack
  }).catch(() => {});
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  errorLogs.logError({
    source: 'process',
    severity: 'fatal',
    message: err && err.message ? err.message : String(err),
    stack:   err && err.stack
  }).catch(() => {});
});

// ---- Boot -----------------------------------------------------
const PORT = Number(process.env.PORT || 3000);
async function boot() {
  console.log('[boot] migrating control plane…');
  await control.migrate();
  // First-boot seed + per-boot settings backfill. seed-once is fully
  // idempotent — it inserts the super-admin only if none exists, every
  // package only if the row is missing by name, and every default
  // setting only if that key isn't already in saas_settings. Running it
  // every boot is safe and means new platform-default settings (e.g.
  // SMTP defaults added in a later release) auto-apply on next deploy.
  try {
    await require('./control/seed-once')();
  } catch (e) {
    console.warn('[boot] auto-seed skipped:', e.message);
  }
  app.listen(PORT, () => console.log('[boot] SmartCRM SaaS listening on :' + PORT));
}
boot().catch(e => { console.error('[boot] failed:', e); process.exit(1); });
