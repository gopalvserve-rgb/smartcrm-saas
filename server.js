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
app.use('/saas', express.static(path.join(__dirname, 'public', 'saas')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'saas', 'index.html')));

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
app.use(attachTenant);

// Tenant SPA shell — Phase 1 placeholder. The full tenant CRM (built
// from the original server.tenant.js + public/app.js) will be wired
// up in Phase 2 once per-tenant DB injection is in place.
app.get(/^\/t\/[a-z0-9-]+\/?(.*)$/, async (req, res) => {
  if (!req.tenant) {
    return res.status(404).send(`<h1>Workspace not found</h1><p>The workspace "<code>${(req.tenantSlug || '').replace(/[<>&]/g, '')}</code>" doesn't exist or has been removed.</p><p><a href="/">← Back to home</a></p>`);
  }
  const t = req.tenant;
  res.send(`<!doctype html><meta charset="utf-8"/>
<title>${t.org_name} — SmartCRM</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:5rem auto;padding:0 1rem;color:#0f172a}
.card{background:#ecfdf5;border:1px solid #6ee7b7;padding:1.5rem;border-radius:12px}
code{background:#fff;padding:.2rem .4rem;border-radius:4px}</style>
<h1>👋 Welcome to ${t.org_name}</h1>
<div class="card">
  <p><b>Workspace:</b> <code>/t/${t.slug}</code> · <b>Plan:</b> ${t.package_id ? 'pkg #' + t.package_id : '—'} · <b>Status:</b> ${t.status}</p>
  <p>The tenant CRM SPA loads here in Phase 2 (full Celeste/Stockbox UI under a per-tenant DB connection). Phase 1 ships signup → payment → provisioning, which is what got you to this page.</p>
  <p>Login email: <code>${t.contact_email}</code></p>
</div>`);
});

app.use(express.static(path.join(__dirname, 'public')));

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
