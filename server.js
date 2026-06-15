/**
 * SmartCRM SaaS Ã¢ÂÂ single-process multi-tenant server.
 *
 * URL surface:
 *   GET  /                           Ã¢ÂÂ public landing + pricing
 *   POST /api/saas                   Ã¢ÂÂ public + super-admin SaaS dispatcher
 *   GET  /api/saas/brand             Ã¢ÂÂ public brand JSON for the landing page
 *   GET  /signup/return              Ã¢ÂÂ Cashfree return URL (verifies + redirects to /t/<slug>)
 *   POST /hook/cashfree              Ã¢ÂÂ Cashfree webhook (raw-body required for HMAC verify)
 *   GET  /admin/                     Ã¢ÂÂ super-admin SPA shell (calls /api/saas)
 *   GET  /t/<slug>                   Ã¢ÂÂ tenant CRM SPA shell
 *   POST /t/<slug>/api               Ã¢ÂÂ tenant API dispatcher (per-tenant DB)
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
const whatsbotBackfill = require('./routes/saas/whatsbotBackfill');
const applySchema = require('./routes/saas/applySchema');
const crashReport = require('./routes/saas/crashReport');
const aiSettings = require('./routes/saas/aiSettings');
const aiCosting  = require('./routes/saas/aiCosting');
const recordingHealth = require('./routes/saas/recordingHealth'); /* DEVICE_DIAG_v1 */
const dbVolume = require('./routes/saas/dbVolume');
const callEventsRepair = require('./routes/saas/callEventsRepair');
const leadScoringRollout = require('./routes/saas/leadScoringRollout');
const quickNoteRollout = require('./routes/saas/quickNoteRollout');
const whiteLabelBilling = require('./routes/saas/whiteLabelBilling');
const tenantModules = require('./routes/saas/tenantModules');
const demoTenant = require('./routes/saas/demoTenant');
const aiUsageIngest = require('./routes/saas/aiUsageIngest');
const tickets = require('./routes/saas/tickets');
const signupRequests = require('./routes/saas/signupRequests'); /* TENANT_SIGNUP_APPROVAL_v1 */
const financeDashboard = require('./routes/saas/financeDashboard'); /* FIN_DASH_v1 */

// ---- Industry Packs: load + self-register at boot ----------------
// Each pack module calls framework.register({...}) on require, populating
// the in-memory REGISTRY that installPack reads. Without this,
// fw.installPack('education') throws "Unknown pack" because the registry
// is empty — which is why testfv (and any tenant created with industry=
// education/realestate) got the pack column saved in control DB but the
// install actually failed and the SPA's _navAnchor saw an empty
// installedPacks Set. Loading them here makes them registered for both
// the SaaS dispatcher path AND the per-tenant API path.
require('./routes/packs/education');
require('./routes/packs/realestate');
// PACK_PHASE_2_v1 — 2026-06-07
require('./routes/packs/finance');
require('./routes/packs/solar');
require('./routes/packs/manufacturer');
require('./routes/packs/holiday');
require('./routes/packs/ecommerce');

// ── Social Post Publisher — fire scheduled posts every minute ──────
// Runs in-process; idempotent (status='scheduled' rows only).
try {
  const social = require('./routes/social');
  if (social && typeof social._runScheduledPosts === 'function') {
    setInterval(() => social._runScheduledPosts().catch(() => {}), 60_000);
  }
  // Phase S4 — Pull ad insights every hour. Updates today's + yesterday's
  // snapshot rows and regenerates alerts. Cheap on the API quota since
  // we only fetch 2 days at a time.
  if (social && typeof social._runAdDailySnapshot === 'function') {
    setInterval(() => social._runAdDailySnapshot().catch(() => {}), 60 * 60 * 1000);
    // First snapshot after 90 seconds (let the server settle)
    setTimeout(() => social._runAdDailySnapshot().catch(() => {}), 90_000);
  }
} catch (_) {}

// Combine every SaaS api_* into one dispatch map
const SAAS_API = {};
[
  superAdmin, packages, signup, tenants, invoices, settings,
  announcements, customReqs, webhookLogs, errorLogs, whatsbotBackfill, applySchema, crashReport,
  aiSettings, aiCosting,
  tenantModules, demoTenant,
  tickets, signupRequests, /* TENANT_SIGNUP_APPROVAL_v1 */
  financeDashboard, /* FIN_DASH_v1 */
  recordingHealth, /* DEVICE_DIAG_v1 */
  dbVolume, /* DB_VOLUME_v1 */
  callEventsRepair, /* CALL_PHONE_REVERSE_BACKFILL_v1 */
  leadScoringRollout, /* LS_ROLLOUT_ALL_v1 */
  quickNoteRollout, /* QNOTE_ROLLOUT_ALL_v1 */
  whiteLabelBilling /* WL_BILLING_v1 */
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
// ---- Webhook event logger -----------------------------------------
// Captures every external hit on /hook/* (website, leadsource, meta,
// whatsapp, etc.) with timestamp + payload + response. Per-tenant
// table (utils/webhookLogger creates webhook_logs on first insert).
// Admins can view via 'Settings → Webhook logs' in the SPA.
const _webhookLogger = require('./utils/webhookLogger');
app.use('/hook', _webhookLogger.middleware());
// ─────────────────────────────────────────────────────────────
// WL_BILLING_v1 public customer portal — no auth, only the random
// portal_token in the URL grants access. portal HTML + JSON API.
// ─────────────────────────────────────────────────────────────
app.get('/wl/portal/:token', (_req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/wl/portal.html'));
});
app.post('/wl/portal-api', express.json(), async (req, res) => {
  try {
    const fn = req.body && req.body.fn;
    const args = (req.body && req.body.args) || [];
    if (fn === 'view') {
      const out = await whiteLabelBilling.api_saas_wl_portal_view(args[0]);
      return res.json(out);
    }
    if (fn === 'payLink') {
      const out = await whiteLabelBilling.api_saas_wl_portal_payLink(args[0], args[1]);
      return res.json(out);
    }
    res.status(400).json({ error: 'Unknown fn' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/hook/cashfree',
  bodyParser.raw({ type: '*/*', limit: '1mb' }),
  cashfreeWebhook.expressWebhook
);

app.use(bodyParser.json({ limit: '25mb' })); // QUOTE_MANY_ITEMS_v1: was 4mb, bumped for quotes with embedded data:image product images
// Accept form-encoded bodies on /hook/website + /hook/other so HTML
// contact forms (and tools like Zapier) can post directly without
// JSON.stringify.
app.use(bodyParser.urlencoded({ extended: true, limit: '25mb' })); // QUOTE_MANY_ITEMS_v1
app.use(require('cookie-parser')());

// ---- Cross-deployment AI usage ingest (Stockbox/Celeste -> here) ----
// Other CRM clones POST every Gemini call result here so the AI Costing
// dashboard aggregates spend across all deployments under our key.
// Auth via Bearer header against AI_USAGE_INGEST_TOKEN env. Endpoint
// is a no-op (503) until that env var is set.
app.post('/ai-usage/ingest', aiUsageIngest.expressIngest);
const aiProxy = require('./routes/saas/aiProxy');
app.post('/ai/proxy/generate', aiProxy.expressGenerate);

// ---- Static assets --------------------------------------------
// Public landing site lives at /saas/* and is served at the root URL.
//
// Cache strategy:
//   - HTML files always get no-cache so a deploy shows up immediately
//     when the user revisits.
//   - JS / CSS get a short max-age (60s) Ã¢ÂÂ index.html references them
//     with a ?v=Ã¢ÂÂ¦ cache buster, so a deploy that bumps the buster
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
// TUTORIAL_PAGE_v1 — Public client-training tutorial. Single static folder,
// no auth, intentionally cacheable. Surfaced in Help & Support sidebar +
// landing-page nav.
app.use('/tutorial', express.static(path.join(__dirname, 'public', 'tutorial'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));
app.get('/app', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'saas', 'app', 'index.html'));
});
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'saas', 'index.html'));
});

// Diagnostic Ã¢ÂÂ admin-only smoke test that the Railway egress can
// actually reach a host:port. Helps debug Gmail SMTP timeouts.
// REC_BACKFILL_DIAG_v1 (2026-06-04) — quick public endpoint to verify
// whether the call_events backfill / cleanup tasks actually ran on this
// deploy. Just exposes the saas_flags rows; nothing sensitive.
app.get('/api/saas/backfill-status', async (_req, res) => {
  try {
    const r = await controlDb.query(
      "SELECT key, value, ran_at FROM saas_flags WHERE key IN ('rec_callevent_time_backfill_v1','rec_direction_backfill_v1','call_today_cleanup_v1') ORDER BY ran_at"
    );
    res.json({ ok: true, flags: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
// handlers POST here Ã¢ÂÂ body is treated as untrusted, capped + redacted
// inside errorLogs.logError(). No auth so anonymous visitors hitting
// the landing page can still report their own browser errors.
app.post('/api/saas/log-error', errorLogs.expressClientErrorEndpoint);

// META_PAGE_DIAG_v1 — page-routing diagnostic.
// GET /api/saas/debug/page-tenant?page_id=12345 returns which tenant owns
// that Facebook Page (per the META_PAGES_LIST config). Super-admin only.
// Helps debug Lead Ads test-tool failures by confirming whether our DB
// thinks the page is connected to any tenant at all.
app.get('/api/saas/debug/page-tenant', async (req, res) => {
  const token = (req.headers['x-auth-token'] || req.query.token || '').toString();
  try { await superAdmin.requireSuperAdmin(token); }
  catch (e) { return res.status(401).json({ error: e.message }); }
  const pageId = String(req.query.page_id || '').trim();
  if (!pageId) return res.status(400).json({ error: 'page_id required' });
  try {
    const t = await _findTenantByLookup(
      `SELECT 1 FROM config WHERE key IN ('META_PAGES_LIST','META_PAGES') AND value LIKE $1 LIMIT 1`,
      ['%' + pageId + '%']
    );
    res.json({ page_id: pageId, tenant: t ? { id: t.id, slug: t.slug, org_name: t.org_name } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Support ticket attachments ---------------------------------
// Multipart upload + bytes download for tenant & super-admin ticket
// attachments. 25 MB cap; tenants only see their own files; admins see
// all. Token may arrive via header OR ?token= query string on the
// download path (so an <a href="..."> works without custom JS).
const _ticketAttachUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});
app.post('/api/saas/ticket-attachment',
  _ticketAttachUpload.single('file'),
  tickets.expressAttachmentUpload
);
app.get('/api/saas/ticket-attachment/:id', tickets.expressAttachmentDownload);

// GOOGLE_CONV_EXPORT_v2 — tenant-scoped public CSV download.
//   GET /exports/google-conv/<slug>.csv?token=<public_token>
// Used by Google Ads bulk upload URL pull, Google Sheets =IMPORTDATA(),
// curl, etc. Auth is via the per-tenant rotating token (NOT a JWT).
try {
  const googleConvExport = require('./routes/googleConvExport');
  if (googleConvExport && googleConvExport.expressPublicDownload) {
    app.get('/exports/google-conv/:slug.csv', googleConvExport.expressPublicDownload);
    app.get('/exports/google-conv/:slug',     googleConvExport.expressPublicDownload);
  }
} catch (e) { console.warn('[gconv] public route mount failed:', e.message); }

// ---- Tenant-scoped Meta/WhatsApp webhooks + FB OAuth callback -----
//
// Facebook only allows ONE OAuth redirect URI per app and ONE webhook
// callback URL per webhook subscription, so all tenants share the same
// platform-wide URLs:
//
//   OAuth callback URL (Valid OAuth Redirect URIs in the Facebook app):
//     https://crm.smartcrmsolution.com/fb/auth/callback
//
//   Lead Ads webhook URL (Webhooks Ã¢ÂÂ Page Ã¢ÂÂ leadgen):
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
//     this for a control-plane page_id Ã¢ÂÂ tenant_id lookup table; for
//     the MVP this is fast enough.)
//   - WhatsApp webhook: payload contains phone_number_id; same lookup.
const fbRoute = require('./routes/fb');
const webhooksRoute = require('./routes/webhooks');
const whatsbotRoute = require('./routes/whatsbot');
const integrations = require('./routes/integrations');
const tenantPoolMod = require('./utils/tenantPool');
const controlDb = require('./control/db');

// PERF_HEALTH_DB_PERSIST_v1 — schema bootstrap. Idempotent; runs once.
(async () => {
  try {
    await controlDb.query(`
      CREATE TABLE IF NOT EXISTS perf_slow_log (
        id          BIGSERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tenant_slug TEXT,
        user_id     INTEGER,
        fn          TEXT,
        ms          INTEGER,
        tag         TEXT,
        source      TEXT,
        ua          TEXT
      )
    `);
    await controlDb.query(`CREATE INDEX IF NOT EXISTS perf_slow_log_tenant_created_idx ON perf_slow_log(tenant_slug, created_at DESC)`);
    await controlDb.query(`
      CREATE TABLE IF NOT EXISTS perf_client_reports (
        id            BIGSERIAL PRIMARY KEY,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tenant_slug   TEXT,
        user_email    TEXT,
        platform      TEXT,
        apk_version   TEXT,
        online        BOOLEAN,
        network       TEXT,
        view          TEXT,
        api_calls     INTEGER,
        slow_1s       INTEGER,
        very_slow_3s  INTEGER,
        long_tasks    INTEGER,
        mem_mb        INTEGER,
        top_by_avg    JSONB,
        very_slow_sample JSONB,
        ua            TEXT
      )
    `);
    await controlDb.query(`CREATE INDEX IF NOT EXISTS perf_client_reports_tenant_created_idx ON perf_client_reports(tenant_slug, created_at DESC)`);
    console.log('[perf-health] DB tables ensured');
  } catch (e) {
    console.error('[perf-health] schema bootstrap failed:', e.message);
  }
})();

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
 * tenant Ã¢ÂÂ find the tenant whose DB has the matching record. Walks the
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
    } catch (_) { /* table missing or other Ã¢ÂÂ skip */ }
  }
  return null;
}

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ---- Facebook OAuth callback (one URL for all tenants) ----------
app.get('/fb/auth/callback', async (req, res) => {
  const stateRaw = (req.query.state || '').toString();
  // Decode state (no verify) to get slug + purpose for routing — the
  // inner handler will do full jwt.verify with secret.
  let slug, purpose;
  try {
    const peek = jwtLib.decode(stateRaw);
    if (peek && peek.slug) slug = peek.slug;
    if (peek && peek.purpose) purpose = peek.purpose;
  } catch (_) {}

  // Pick the handler based on state.purpose. 'social' goes to Social Hub
  // connect; anything else (including legacy/empty) goes to Lead Sync.
  const handler = (purpose === 'social')
    ? (require('./routes/social').expressOAuthCallbackSocial)
    : fbRoute.expressOAuthCallback;

  if (!slug) {
    return handler(req, res);
  }
  return _runAsTenant(slug, req, res, handler);
});

// ---- GMEET_v1 — Google Calendar OAuth callback (one URL for all tenants) ----
// Mirrors the FB callback pattern: decode the state JWT (no verify) to peek
// at the tenant slug, then run the actual handler inside _runAsTenant so
// db.query writes to the right tenant DB.
app.get('/saas/google/callback', async (req, res) => {
  const stateRaw = (req.query.state || '').toString();
  let slug;
  try {
    const peek = jwtLib.decode(stateRaw);
    if (peek && peek.slug) slug = peek.slug;
  } catch (_) {}
  if (!slug) return res.status(400).type('html').send('<h2>Bad state — missing tenant slug</h2>');
  const handler = require('./routes/googleCalendar').expressOAuthCallback;
  return _runAsTenant(slug, req, res, handler);
});

/* GCONV_SHEETS_v1 — Super-admin one-time OAuth setup for the shared
   Google account that pushes conversion data to every tenant's Sheet.
   Anyone with the SUPER_ADMIN_SHEETS_KEY can authorize. */
app.get('/saas/sheets/connect', async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    const expected = process.env.SUPER_ADMIN_SHEETS_KEY || process.env.SUPER_ADMIN_KEY || '';
    if (!expected) return res.status(500).type('html').send('<h2>SUPER_ADMIN_SHEETS_KEY not set on Railway</h2>');
    if (key !== expected) return res.status(403).type('html').send('<h2>Forbidden — pass ?key=&lt;SUPER_ADMIN_SHEETS_KEY&gt;</h2>');
    const sm = require('./utils/googleSheetsMaster');
    const url = sm.getAuthUrl('sheets-master');
    res.redirect(url);
  } catch (e) {
    res.status(500).type('html').send('<h2>Failed to start OAuth: ' + e.message + '</h2>');
  }
});

app.get('/saas/sheets/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).type('html').send('<h2>Missing code</h2>');
    const sm = require('./utils/googleSheetsMaster');
    const result = await sm.exchangeCodeAndSave(code);
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sheets Connected</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:3rem 1.5rem;color:#0f172a;background:#f8fafc}
.box{background:#fff;border-radius:12px;padding:2rem;max-width:480px;margin:0 auto;box-shadow:0 8px 24px rgba(15,23,42,.08)}
.ok{font-size:3rem}.muted{color:#64748b;font-size:.85rem;margin-top:1rem}</style></head>
<body><div class="box"><div class="ok">✅</div>
<h2>Google Sheets master connected</h2>
<p>Account: <b>${result.email || 'unknown'}</b></p>
<p class="muted">Every tenant can now point a Google Sheet at this account.<br>Tell tenants to share their Sheet with <b>${result.email}</b> (Editor access).</p>
</div></body></html>`);
  } catch (e) {
    res.status(500).type('html').send('<h2>OAuth callback failed: ' + e.message + '</h2>');
  }
});

// ---- Meta Lead Ads webhook (one URL for all tenants) ------------
//
// FB calls these in two flavours:
//   GET  with hub.mode=subscribe&hub.verify_token=Ã¢ÂÂ¦&hub.challenge=Ã¢ÂÂ¦ Ã¢ÂÂ echo challenge
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
  // the same trust model FB uses Ã¢ÂÂ they only ever ask once at hook
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
  // attachTenant has already populated req.tenant Ã¢ÂÂ no lookup needed.
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
  // META_PAGES_LIST_KEY_FIX_v1 — the Lead Sync flow saves the connected
  // pages under config key 'META_PAGES_LIST' (a JSON array), not 'META_PAGES'.
  // The original lookup queried the wrong key so EVERY bare /hook/meta hit
  // landed in the 'no owning tenant' branch and was silently dropped, even
  // when the page was correctly connected. Fixed below.
  const t = await _findTenantByLookup(
    `SELECT 1 FROM config WHERE key IN ('META_PAGES_LIST','META_PAGES') AND value LIKE $1 LIMIT 1`,
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
  // Fast path Ã¢ÂÂ forwarder dispatched to /t/<slug>/hook/whatsapp.
  if (req.tenant) return webhooksRoute.whatsappEvent(req, res);
  // Slow path Ã¢ÂÂ bare /hook/whatsapp; look up by phone_number_id.
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

// /hook/whatsapp_webhook is the WhatsBot module's own endpoint Ã¢ÂÂ
// same routing logic, different handler.
app.get('/hook/whatsapp_webhook', async (req, res) => {
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  // Fast path Ã¢ÂÂ verify GET to /t/<slug>/hook/whatsapp_webhook with
  // tenant already resolved. Just check this tenant's stored token.
  if (req.tenant && req.tenantPool) {
    try {
      const hit = await req.tenantPool.query(`SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`);
      const cfg = hit.rows[0] && hit.rows[0].value;
      if (cfg && cfg === token) return res.type('text/plain').send(challenge);
    } catch (_) {}
    return res.status(403).send('Verify token mismatch');
  }
  // Slow path Ã¢ÂÂ direct hit on bare /hook/whatsapp_webhook, walk all tenants.
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
  // Fast path Ã¢ÂÂ forwarder dispatched to /t/<slug>/hook/whatsapp_webhook.
  // This is the canonical path each tenant registers when they connect
  // via Embedded Sign-In (whatsbot.js _registerWithCentralForwarder),
  // so this branch handles the common case zero-lookup.
  if (req.tenant) return whatsbotRoute.expressEvent(req, res);
  // Slow path Ã¢ÂÂ direct hit on bare /hook/whatsapp_webhook.
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

// Ã¢ÂÂÃ¢ÂÂ Website & generic webhook Ã¢ÂÂ API-key authenticated Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
// Any HTML contact form or external tool (Zapier, Make, n8n, Ã¢ÂÂ¦) can POST to
// /hook/website using either:
//   Ã¢ÂÂ¢ application/json          { api_key, name, email, Ã¢ÂÂ¦ }
//   Ã¢ÂÂ¢ application/x-www-form-urlencoded  (standard HTML form)
//   Ã¢ÂÂ¢ x-api-key / Authorization: Bearer  header
//
// The matching tenant is found by looking up WEBSITE_API_KEY in each
// tenant's config table Ã¢ÂÂ so every tenant can have their own key.

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
  // Fast path Ã¢ÂÂ request already resolved to a tenant (via /t/<slug>/Ã¢ÂÂ¦)
  if (req.tenant) return _runAsTenant(req.tenantSlug, req, res, handler);

  // Slow path Ã¢ÂÂ bare /hook/website hit, identify tenant by API key
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

// IVR_HOOK_MOUNT_v1 + IVR_HOOK_DEFENSIVE_v1 — generic IVR / Cloud Calling
// inbound webhook, wrapped in try/catch so a module-level error in
// routes/ivr.js (e.g. a missing dependency in a future change) can NOT
// prevent server.js boot. Without this guard a Railway redeploy that
// breaks ivr.js takes the whole CRM down.
try {
  const ivrRoute = require('./routes/ivr');
  app.post('/hook/ivr/:vendor', (req, res) => _runHookAsTenant(req, res, ivrRoute.expressInbound));
} catch (e) {
  console.error('[boot] routes/ivr.js failed to load — IVR endpoints disabled:', e && e.message);
}

// Ã¢ÂÂÃ¢ÂÂ Public API documentation page Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
app.get('/api-docs', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  res.type('html').send(_apiDocsHtml(host));
});

function _apiDocsHtml(host) {
  const safe = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SmartCRM API Documentation</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6}
  .header{background:linear-gradient(135deg,#1e293b,#0f172a);padding:2rem;border-bottom:1px solid #1e293b}
  .header h1{color:#10b981;font-size:1.8rem;margin-bottom:.25rem}
  .header p{color:#94a3b8}
  .container{max-width:900px;margin:0 auto;padding:2rem}
  h2{color:#10b981;font-size:1.2rem;margin:2rem 0 1rem;padding-bottom:.5rem;border-bottom:1px solid #1e293b}
  h3{color:#38bdf8;font-size:1rem;margin:1.5rem 0 .5rem}
  .endpoint{background:#1e293b;border:1px solid #334155;border-radius:.5rem;padding:1.5rem;margin-bottom:1.5rem}
  .method{display:inline-block;padding:.2rem .6rem;border-radius:.25rem;font-size:.8rem;font-weight:700;margin-right:.5rem}
  .post{background:#065f46;color:#6ee7b7}
  .get{background:#1e40af;color:#93c5fd}
  .url{font-family:monospace;color:#f8fafc;font-size:.95rem}
  .badge{display:inline-block;padding:.15rem .5rem;border-radius:.25rem;font-size:.75rem;margin-left:.5rem}
  .badge-auth{background:#7c3aed;color:#ddd6fe}
  .badge-public{background:#334155;color:#94a3b8}
  table{width:100%;border-collapse:collapse;margin:.5rem 0}
  th{text-align:left;padding:.5rem;background:#0f172a;color:#94a3b8;font-size:.8rem;border-bottom:1px solid #334155}
  td{padding:.5rem;border-bottom:1px solid #1e293b;font-size:.85rem;vertical-align:top}
  td:first-child{font-family:monospace;color:#fbbf24;white-space:nowrap}
  td:last-child{color:#94a3b8}
  pre{background:#0f172a;border:1px solid #334155;border-radius:.375rem;padding:1rem;overflow-x:auto;font-size:.82rem;margin:.75rem 0}
  code{font-family:'Fira Code',monospace;color:#86efac}
  .tab-bar{display:flex;gap:.5rem;margin-bottom:-.5rem}
  .tab{padding:.4rem 1rem;border-radius:.375rem .375rem 0 0;cursor:pointer;font-size:.8rem;border:1px solid #334155;border-bottom:none;background:#0f172a;color:#94a3b8}
  .tab.active{background:#1e293b;color:#e2e8f0}
  .tab-pane{display:none}.tab-pane.active{display:block}
  .response{background:#042f2e;border:1px solid #065f46;border-radius:.375rem;padding:1rem;margin:.75rem 0}
  .copy-btn{float:right;padding:.2rem .6rem;background:#334155;color:#94a3b8;border:none;border-radius:.25rem;cursor:pointer;font-size:.75rem}
  .copy-btn:hover{background:#475569;color:#e2e8f0}
  .note{background:#1c1917;border-left:3px solid #f59e0b;padding:.75rem 1rem;border-radius:0 .375rem .375rem 0;font-size:.85rem;color:#d97706;margin:.75rem 0}
</style>
</head>
<body>
<div class="header">
  <div class="container" style="padding-top:0;padding-bottom:0">
    <h1>SmartCRM API</h1>
    <p>Webhook &amp; integration endpoints for your SmartCRM workspace</p>
    <p style="color:#475569;font-size:.85rem;margin-top:.5rem">Base URL: <code style="color:#38bdf8">${safe(host)}</code></p>
  </div>
</div>
<div class="container">

<h2>Authentication</h2>
<p style="color:#94a3b8;margin-bottom:1rem">All webhook endpoints require your workspace <strong style="color:#fbbf24">API key</strong>. Find it in your CRM under <strong>Settings Ã¢ÂÂ Integrations Ã¢ÂÂ Website API Key</strong>.</p>
<p style="color:#94a3b8">Pass the key using <strong>any one</strong> of these methods:</p>
<table>
  <tr><th>Method</th><th>Example</th></tr>
  <tr><td>Header</td><td><code>x-api-key: your_key_here</code></td></tr>
  <tr><td>Bearer token</td><td><code>Authorization: Bearer your_key_here</code></td></tr>
  <tr><td>Body field</td><td><code>api_key=your_key_here</code></td></tr>
  <tr><td>Query string</td><td><code>?api_key=your_key_here</code></td></tr>
</table>

<h2>Endpoints</h2>

<!-- POST /hook/website -->
<div class="endpoint">
  <div style="margin-bottom:.75rem">
    <span class="method post">POST</span>
    <span class="url">/hook/website</span>
    <span class="badge badge-auth">API Key required</span>
  </div>
  <p style="color:#94a3b8;margin-bottom:1rem">Accepts a lead submission from your website contact form. Creates or updates a lead in your SmartCRM workspace.</p>

  <h3>Built-in fields (no setup required)</h3>
  <table>
    <tr><th>Field</th><th>Aliases / Notes</th></tr>
    <tr><td><b>name</b></td><td>Contact's full name</td></tr>
    <tr><td><b>email</b></td><td>Contact's email</td></tr>
    <tr><td><b>phone</b></td><td>Aliases: <code>mobile</code></td></tr>
    <tr><td><b>whatsapp</b></td><td>WhatsApp number (defaults to phone if omitted)</td></tr>
    <tr><td><b>source</b></td><td>Aliases: <code>lead_source</code> · <code>leadsource</code> · <code>origin</code> · <code>channel</code> · <code>source_name</code> · <code>referrer</code></td></tr>
    <tr><td><b>source_ref</b></td><td>External reference / source ID</td></tr>
    <tr><td><b>product</b></td><td>Product / service of interest</td></tr>
    <tr><td><b>notes</b></td><td>Aliases: <code>message</code></td></tr>
    <tr><td><b>city, state, country</b></td><td>Address fields</td></tr>
    <tr><td><b>company, address</b></td><td>Company name + full address</td></tr>
    <tr><td><b>pincode</b></td><td>Aliases: <code>zip</code></td></tr>
    <tr><td><b>tags</b></td><td>Array <code>["hot","follow-up"]</code> or CSV <code>"hot,follow-up"</code> · alias <code>labels</code></td></tr>
    <tr><td><b>value</b></td><td>Deal value (number)</td></tr>
    <tr><td><b>currency</b></td><td>INR / USD / etc</td></tr>
    <tr><td><b>next_followup_at</b></td><td>ISO date for first follow-up</td></tr>
    <tr><td><b>Google Ads attribution</b></td><td><code>gclid</code> · <code>gad_campaignid</code> · <code>campaign_id</code> · <code>campaign_name</code> · <code>network</code> · <code>keyword</code> · <code>adgroupid</code> · <code>matchtype</code> · <code>device</code> · <code>placement</code> · <code>adposition</code> · <code>landing_page</code></td></tr>
    <tr><td><b>UTM tags</b></td><td><code>utm_source</code> · <code>utm_medium</code> · <code>utm_campaign</code> · <code>utm_term</code> · <code>utm_content</code></td></tr>
    <tr><td><b>meta</b></td><td>Any nested JSON object — saved verbatim to meta_json</td></tr>
  </table>

  <h3 style="margin-top:1.5rem">📌 Custom fields (your own columns)</h3>
  <div class="note" style="background:#fef3c7;border-color:#f59e0b;color:#78350f">
    <b>Step 1:</b> Go to <b>Settings → Custom Fields</b> and create the field first (e.g. <code>travel_plan</code>, <code>fblid</code>, <code>interested_in_kashmir</code>). The <i>Key</i> you enter there is what the webhook recognises.<br><br>
    <b>Step 2:</b> Send the value in any ONE of these three ways:
    <ul style="margin:.5rem 0 0 1.25rem">
      <li><code>"travel_plan": "Next Month"</code> — top-level, using the custom-field key as-is</li>
      <li><code>"cf_travel_plan": "Next Month"</code> — with <code>cf_</code> prefix (recommended for Make / Zapier / Pabbly)</li>
      <li><code>"extra": { "travel_plan": "Next Month" }</code> — nested under <code>extra</code></li>
    </ul>
    All three land in the lead's <code>extra_json</code> and show up on the lead-modal Custom Fields panel + are filterable in the Leads page and Report Builder.
  </div>

  <h3 style="margin-top:1rem">Auth fields</h3>
  <table>
    <tr><th>Field</th><th>Type</th><th>Description</th></tr>
    <tr><td>api_key</td><td>string</td><td>Your API key (if not sent via x-api-key header)</td></tr>
  </table>

  <h3>Examples</h3>

  <div class="tab-bar">
    <div class="tab active" onclick="showTab(this,'wb-json')">JSON</div>
    <div class="tab" onclick="showTab(this,'wb-form')">HTML Form / URL-encoded</div>
    <div class="tab" onclick="showTab(this,'wb-html')">HTML &lt;form&gt; tag</div>
  </div>

  <div id="wb-json" class="tab-pane active">
    <p style="color:#94a3b8;margin-bottom:.5rem">Basic example:</p>
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>curl -X POST ${safe(host)}/hook/website \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_key_here" \
  -d '{
    "name":    "Priya Sharma",
    "email":   "priya@example.com",
    "phone":   "+91 98765 43210",
    "message": "Interested in the enterprise plan",
    "source":  "website"
  }'</code></pre>

    <p style="color:#94a3b8;margin:1rem 0 .5rem">Full example with Google Ads attribution + custom fields:</p>
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>curl -X POST ${safe(host)}/hook/website \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_key_here" \
  -d '{
    "name":          "AKEEL AHMED",
    "email":         "akeel@example.com",
    "phone":         "9610552233",
    "message":       "Interested in Kashmir trip",
    "source":        "Google Ads",

    "campaign_id":   "23930980060",
    "campaign_name": "Kashmir_packages",
    "gclid":         "CjwKCAjwuanRBhBSEiwAY5y6V...",
    "landing_page":  "https://kudostrips.com/?campaign=23930980060",

    "cf_travel_plan":            "Next Month",
    "cf_product_name":           "Kashmir_packages",
    "cf_interested_in_kashmir":  "Yes",
    "cf_fblid":                  "N/A"
  }'</code></pre>
    <p style="color:#94a3b8;font-size:.85rem;margin-top:.5rem">⚠ Create <code>travel_plan</code>, <code>product_name</code>, <code>interested_in_kashmir</code>, <code>fblid</code> in <b>Settings → Custom Fields</b> first — otherwise the webhook will silently drop them.</p>
  </div>

  <div id="wb-form" class="tab-pane">
    <div class="note">Ã¢ÂÂ Supported Ã¢ÂÂ you can POST standard HTML form data directly to this endpoint. No JSON.stringify needed.</div>
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>curl -X POST ${safe(host)}/hook/website \
  -H "x-api-key: your_key_here" \
  --data-urlencode "name=Priya Sharma" \
  --data-urlencode "email=priya@example.com" \
  --data-urlencode "phone=+91 98765 43210" \
  --data-urlencode "message=Interested in the enterprise plan" \
  --data-urlencode "source=website"</code></pre>
    <p style="color:#94a3b8;font-size:.85rem;margin-top:.5rem">Or with <code>-d</code> (URL-encoded string):</p>
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>curl -X POST ${safe(host)}/hook/website \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=your_key_here&amp;name=Priya+Sharma&amp;email=priya%40example.com&amp;phone=%2B91+98765+43210&amp;message=Interested+in+enterprise"</code></pre>
  </div>

  <div id="wb-html" class="tab-pane">
    <div class="note">Embed this on your website. The API key is in the hidden field Ã¢ÂÂ keep it server-side in production.</div>
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>&lt;form method="POST" action="${safe(host)}/hook/website"&gt;
  &lt;input type="hidden" name="api_key" value="your_key_here"&gt;
  &lt;input type="text"   name="name"    placeholder="Your name"&gt;
  &lt;input type="email"  name="email"   placeholder="Email"&gt;
  &lt;input type="tel"    name="phone"   placeholder="Phone"&gt;
  &lt;textarea            name="message" placeholder="Message"&gt;&lt;/textarea&gt;
  &lt;button type="submit"&gt;Send&lt;/button&gt;
&lt;/form&gt;</code></pre>
  </div>

  <h3>Success response</h3>
  <div class="response"><code>{ "ok": true, "result": { "id": 42, "name": "Priya Sharma" } }</code></div>

  <h3>Error responses</h3>
  <table>
    <tr><th>Status</th><th>Error</th><th>Cause</th></tr>
    <tr><td>401</td><td>Missing API key</td><td>No key provided</td></tr>
    <tr><td>401</td><td>Invalid API key</td><td>Key not found in any tenant</td></tr>
    <tr><td>400</td><td>email required</td><td>email field missing</td></tr>
  </table>
</div>

<!-- POST /hook/other -->
<div class="endpoint">
  <div style="margin-bottom:.75rem">
    <span class="method post">POST</span>
    <span class="url">/hook/other</span>
    <span class="badge badge-auth">API Key required</span>
  </div>
  <p style="color:#94a3b8;margin-bottom:1rem">Generic webhook endpoint. Accepts any payload and passes it to your CRM for custom processing.</p>

  <h3>Examples</h3>
  <div class="tab-bar">
    <div class="tab active" onclick="showTab(this,'ot-json')">JSON</div>
    <div class="tab" onclick="showTab(this,'ot-form')">URL-encoded</div>
  </div>
  <div id="ot-json" class="tab-pane active">
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>curl -X POST ${safe(host)}/hook/other \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_key_here" \
  -d '{ "event": "form_submit", "data": { "page": "/contact" } }'</code></pre>
  </div>
  <div id="ot-form" class="tab-pane">
    <pre><button class="copy-btn" onclick="copyPre(this)">Copy</button><code>curl -X POST ${safe(host)}/hook/other \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "api_key=your_key_here&amp;event=form_submit&amp;page=%2Fcontact"</code></pre>
  </div>
</div>

<!-- GET /api-docs -->
<div class="endpoint">
  <div style="margin-bottom:.75rem">
    <span class="method get">GET</span>
    <span class="url">/api-docs</span>
    <span class="badge badge-public">Public</span>
  </div>
  <p style="color:#94a3b8">Returns this documentation page.</p>
</div>

</div><!-- /container -->
<script>
function showTab(btn, id) {
  const bar = btn.closest('.tab-bar');
  bar.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  // Find all sibling tab-panes (next siblings until next tab-bar or endpoint end)
  let el = bar.nextElementSibling;
  while (el && el.classList.contains('tab-pane')) {
    el.classList.remove('active');
    el = el.nextElementSibling;
  }
  document.getElementById(id).classList.add('active');
}
function copyPre(btn) {
  const code = btn.parentElement.querySelector('code').innerText;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 1500);
  });
}
</script>
</body>
</html>`;
}


/* HELP_SHOTS_v1 — public help-page screenshot store. */
const helpShots = require('./routes/saas/helpShots');
const _hsUpload = require('express').json({ limit: '5mb' });
app.post('/api/saas/uploadHelpShot', _hsUpload, helpShots.expressUpload);
app.get('/api/saas/helpShot/:name',  helpShots.expressServe);
app.get('/api/saas/helpShots',       helpShots.expressList);

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

// ---- TENANT_SIGNUP_APPROVAL_v1 public submit -----------------
// Anyone (no auth) can POST to this endpoint to create a tenant
// signup-request. Super-admin reviews + approves from the SPA.
app.post('/api/saas-public-signup-request', express.json({ limit: '32kb' }), signupRequests.expressPublicSubmit);

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
  //   /t/acme?ssl=eyJÃ¢ÂÂ¦
  // by producing /t/acme?ssl=eyJÃ¢ÂÂ¦/ which corrupts the JWT value.
  const qIdx = req.originalUrl.indexOf('?');
  const target = qIdx === -1
    ? req.originalUrl + '/'
    : req.originalUrl.slice(0, qIdx) + '/' + req.originalUrl.slice(qIdx);
  res.redirect(301, target);
});

// Tenant "not found" placeholder Ã¢ÂÂ only serves when the slug doesn't
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
  // Tenant exists Ã¢ÂÂ let attachTenant + the SPA handler take over.
  // (The "?ssl=Ã¢ÂÂ¦" magic-link case also flows through here Ã¢ÂÂ the SPA
  // shell exchanges the token for a real JWT during boot.)
  if (tenant && tenant.status !== 'deleted' && tenant.status !== 'suspended') return next();
  return _renderTenantPlaceholder(req, res, slug, tenant);
});

app.use(attachTenant);

// INDIAMART_WEBHOOK_LOG_FIX_v4 (2026-06-02) — real root cause.
// The webhook logger was originally mounted at /hook BEFORE attachTenant
// (line 110). But the central PHP forwarder dispatches webhooks via
// /t/<slug>/hook/... — and at line-110-time req.url still has the
// /t/<slug> prefix, so the /hook middleware never matched. Result: every
// /hook hit via the forwarder bypassed logging entirely. Mounting again
// here, AFTER attachTenant has stripped the prefix, makes the middleware
// fire for both direct /hook/* requests AND forwarded /t/<slug>/hook/*
// requests (which by this point have been rewritten to /hook/*).
// The earlier mount stays — it covers any pre-attachTenant /hook traffic.
app.use('/hook', _webhookLogger.middleware());

// ---- Public /q/:token quotation viewer (tenant-scoped) ----
app.get('/q/:token', (req, res, next) => {
  if (!req.tenant) return res.status(404).send('Tenant not found');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/quotations').expressPublicQuote(req, res).catch(next);
  });
});

// QUOTE_PDF_v1: stream the quotation as a true PDF document. Used by the
// WhatsApp document-send (Meta needs a publicly-fetchable .pdf URL).
app.get('/q/:token.pdf', (req, res, next) => {
  if (!req.tenant) return res.status(404).send('Tenant not found');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/quotations').expressPublicQuotePdf(req, res).catch(next);
  });
});

// ---- Public QR lead form (tenant-scoped) ----
// GET  /t/<slug>/form/<form-slug>          — branded HTML form
// POST /t/<slug>/form/<form-slug>/submit   — JSON submit → creates lead
app.get('/form/:formSlug', (req, res, next) => {
  if (!req.tenant) return res.status(404).send('Tenant not found');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/qrForms').expressRenderForm(req, res).catch(next);
  });
});
app.post('/form/:formSlug/submit', (req, res, next) => {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/qrForms').expressSubmitForm(req, res).catch(next);
  });
});

// ---- Public Form Builder forms (tenant-scoped) ----
// GET  /t/<slug>/f/<form-slug>          — branded HTML form (responsive)
// POST /t/<slug>/f/<form-slug>/submit   — JSON submit → creates lead
app.get('/f/:formSlug', (req, res, next) => {
  if (!req.tenant) return res.status(404).send('Tenant not found');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/forms').expressRenderForm(req, res).catch(next);
  });
});
app.post('/f/:formSlug/submit', (req, res, next) => {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/forms').expressSubmitForm(req, res).catch(next);
  });
});

// ---- Public Landing Pages (tenant-scoped) ----
// GET  /t/<slug>/p/<page-slug>  — renders the section-based landing page
app.get('/p/:pageSlug', (req, res, next) => {
  if (!req.tenant) return res.status(404).send('Tenant not found');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/pages').expressRenderPage(req, res).catch(next);
  });
});

// ---- Public WhatsApp Chat Widget (tenant-scoped, embeddable on external sites) ----
// GET  /t/<slug>/widget/wa.js?w=<widget-slug>   — self-contained injector JS
// POST /t/<slug>/widget/click                   — beacon: bumps counter + optional lead
app.get('/widget/wa.js', (req, res, next) => {
  if (!req.tenant) return res.status(404).type('application/javascript').send('/* tenant not found */');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/waWidget').expressRenderWidgetJs(req, res).catch(next);
  });
});
app.post('/widget/click', (req, res, next) => {
  if (!req.tenant) return res.status(204).end();
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/waWidget').expressTrackClick(req, res).catch(next);
  });
});
// sendBeacon legacy paths use GET — alias for safety
app.get('/widget/click', (req, res, next) => {
  if (!req.tenant) return res.status(204).end();
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, () => {
    require('./routes/waWidget').expressTrackClick(req, res).catch(next);
  });
});

// ---- Tenant config snapshot (sidebar brand + apk url + base url) -----
// The SaaS server didn't expose /config.json at all, so the SPA's fetch
// of /t/<slug>/config.json silently failed and CRM.config stayed on its
// 'Lead CRM' / '' defaults — sidebar showed the placeholder name + the
// 🎯 dot instead of the tenant's actual logo and company name.
// Tenant-resolved automatically via the existing attachTenant middleware.
app.get('/config.json', async (req, res) => {
  // Outside a tenant: harmless empty defaults so /config.json on the
  // bare host (workspace picker) doesn't 404.
  if (!req.tenant) {
    return res.json({
      company_name:     'Lead CRM',
      company_logo_url: '',
      hidden_nav_ids:   '',
      apk_url:          '/LeadCRM.apk',
      base_url:         req.protocol + '://' + req.get('host')
    });
  }
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      let cfg = {};
      try {
        const rows = await tenantDb.getAll('config');
        rows.forEach(r => { cfg[r.key] = r.value; });
      } catch (_) { /* config table missing for brand-new tenant — fall through */ }
      const fs = require('fs');
      const path = require('path');
      res.json({
        company_name:     cfg.COMPANY_NAME     || req.tenant.name || 'Lead CRM',
        company_logo_url: cfg.COMPANY_LOGO_URL || cfg.BRAND_LOGO_URL || '',
        hidden_nav_ids:   cfg.HIDDEN_NAV_IDS   || '',
        apk_url: fs.existsSync(path.join(__dirname, 'public', 'LeadCRM.apk'))
          ? '/LeadCRM.apk'
          : (cfg.APK_DOWNLOAD_URL || ''),
        base_url:         req.protocol + '://' + req.get('host')
      });
    });
});

// ============================================================
// ============================================================
// WA_TPL_SAMPLE_UPLOAD_v1 (2026-05-31): host sample media files
// for WhatsApp template headers. Meta requires a public URL for
// IMAGE/VIDEO/DOCUMENT header samples — admins would otherwise
// have to push the file to S3/Drive themselves. The upload is
// tenant-scoped (so the admin must be logged in) but the SERVE
// endpoint is public (no auth) because Meta's review crawlers
// fetch the URL anonymously. A 24-char hex token in the URL keeps
// the link unguessable.
// ============================================================
const _waSampleUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

async function _ensureWaSampleTable(pool) {
  const client = pool ? await pool.connect() : null;
  try {
    const q = (sql) => client ? client.query(sql) : require('./db/pg').query(sql);
    await q('CREATE TABLE IF NOT EXISTS wa_template_samples ('
      + 'token TEXT PRIMARY KEY,'
      + 'mime TEXT,'
      + 'filename TEXT,'
      + 'bytes BYTEA,'
      + 'size_bytes BIGINT,'
      + 'created_by INT,'
      + 'created_at TIMESTAMP DEFAULT NOW()'
      + ')');
  } finally { if (client) client.release(); }
}

app.post('/api/wa-sample', _waSampleUpload.single('file'), async (req, res) => {
  if (!req.tenant || !req.tenantPool) return res.status(404).json({ error: 'No tenant in URL' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        await _ensureWaSampleTable();
        const { authUser } = require('./utils/auth');
        const token = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const me = await authUser(token);
        if (me.role !== 'admin') return res.status(403).json({ error: 'Only admin can upload sample files' });
        if (!req.file) return res.status(400).json({ error: 'file required' });
        if ((req.file.size || 0) > 25 * 1024 * 1024) return res.status(400).json({ error: 'Max 25 MB' });
        const crypto = require('crypto');
        const tk = crypto.randomBytes(12).toString('hex'); // 24-char hex
        await tenantDb.query(
          'INSERT INTO wa_template_samples (token, mime, filename, bytes, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
          [tk, req.file.mimetype || 'application/octet-stream', String(req.file.originalname || 'file').slice(0, 200), req.file.buffer, req.file.size || 0, me.id]
        );
        const proto = req.protocol;
        const host = req.get('host');
        const slug = req.tenantSlug ? ('/t/' + req.tenantSlug) : '';
        const publicUrl = proto + '://' + host + slug + '/api/wa-sample/' + tk;
        res.json({ ok: true, url: publicUrl, token: tk, mime: req.file.mimetype, size_bytes: req.file.size });
      } catch (e) {
        console.error('[wa-sample-upload]', e.message);
        res.status(400).json({ error: e.message });
      }
    });
});

// PUBLIC download — no auth. Random 24-char hex token in the URL
// keeps it from being guessable. Meta needs to fetch this without
// any credentials during template review.
app.get('/api/wa-sample/:token', async (req, res) => {
  if (!req.tenant || !req.tenantPool) return res.status(404).send('not found');
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        await _ensureWaSampleTable();
        const tk = String(req.params.token || '').replace(/[^a-f0-9]/gi, '');
        if (tk.length !== 24) return res.status(400).send('bad token');
        const r = await tenantDb.query('SELECT mime, filename, bytes FROM wa_template_samples WHERE token = $1 LIMIT 1', [tk]);
        const row = r.rows[0];
        if (!row || !row.bytes) return res.status(404).send('not found');
        let buf = row.bytes;
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
        const safe = String(row.filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
        res.setHeader('Content-Type', row.mime || 'application/octet-stream');
        res.setHeader('Content-Length', buf.length);
        res.setHeader('Content-Disposition', 'inline; filename="' + safe + '"');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.end(buf);
      } catch (e) {
        console.error('[wa-sample-dl]', e.message);
        res.status(500).send('error');
      }
    });
});

// KB_FILE_UPLOAD_v1 (2026-05-31): tenant-aware multipart upload +
// streaming download for Knowledge Base file attachments. Admin
// uploads a brochure / PDF / PPT on an entry; any logged-in tenant
// user can view or download it. Both endpoints are mounted at
// /api/kb-file/:id — after attachTenant strips /t/<slug>/ they
// resolve req.tenant + req.tenantPool, so db.* inside the handler
// targets the right tenant DB.
// ============================================================
const _kbUpload = require('multer')({
  storage: require('multer').memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.post('/api/kb-file/:id', _kbUpload.single('file'), async (req, res) => {
  if (!req.tenant || !req.tenantPool) return res.status(404).json({ error: 'No tenant in URL — POST to /t/<slug>/api/kb-file/:id' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      const knowledgeBase = require('./routes/knowledgeBase');
      return knowledgeBase.expressKbFileUpload(req, res);
    });
});

app.get('/api/kb-file/:id', async (req, res) => {
  if (!req.tenant || !req.tenantPool) return res.status(404).json({ error: 'No tenant in URL' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      const knowledgeBase = require('./routes/knowledgeBase');
      return knowledgeBase.expressKbFileDownload(req, res);
    });
});

// ---- Mobile-app call-recording upload (tenant-scoped multipart) ----
// Was missing from the SaaS server entirely — mobile app POSTs to
// /t/<slug>/api/recordings would silently 404 and the 'Sync now' button
// reported '0 synced'. Mount the same multipart handler used in
// server.tenant.js, scoped through tenantStorage so db.query() picks
// up the right tenant pool. Also auto-creates a lead if the recording's
// phone doesn't match an existing lead (uses CALLS_AUTOLEAD_INBOUND /
// CALLS_AUTOLEAD_OUTBOUND / CALLS_AUTOLEAD_STATUS_ID config keys).
const _multer = require('multer');
const _recUpload = _multer({
  storage: _multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});
// ============================================================
// 🔒 LOCKED — /api/recordings upload + AI Call Summary worker
// ============================================================
// The block below (recording upload handler + helpers + AI
// worker) is mission-critical. Read docs/LOCKED_FILES.md before
// editing. Ask the user before any change. The phone fallback
// chain, dedup logic, MIME detection, and lead resolution are
// the result of multiple iterations against real OEM behaviour.
// ============================================================

app.post('/api/recordings', _recUpload.single('audio'), async (req, res, next) => {
  // Tenant-agnostic upload: if the request didn't come through /t/<slug>/
  // (e.g. the native APK posts directly to /api/recordings), resolve the
  // tenant from the auth token. The JWT only carries user.id — we walk
  // active tenants and find the one whose users table has that id. This
  // makes the endpoint work for EVERY tenant with zero URL coupling.
  const tenantDb = require('./db/pg');
  if (!req.tenant) {
    try {
      const jwt = require('jsonwebtoken');
      const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
      const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded;
      try { decoded = jwt.verify(raw, _JWT_SECRET); }
      catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
      const uid = Number(decoded && decoded.id);
      if (!uid) return res.status(401).json({ error: 'Token has no user id' });
      const t = await _findTenantByLookup(
        'SELECT 1 FROM users WHERE id = $1 AND COALESCE(is_active, 1) = 1 LIMIT 1',
        [uid]
      );
      if (!t) return res.status(404).json({ error: 'No active tenant found for this user' });
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) return res.status(500).json({ error: 'tenant pool unavailable' });
      req.tenant = t;
      req.tenantPool = pool;
      req.tenantSlug = t.slug;
    } catch (e) {
      console.error('[/api/recordings] tenant-from-token failed:', e.message);
      return res.status(500).json({ error: 'tenant resolution failed: ' + e.message });
    }
  }
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        const { authUser } = require('./utils/auth');
        const recRoutes = require('./routes/recordings');
        const db = tenantDb;
        const token = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const me = await authUser(token);
        if (!req.file) return res.status(400).json({ error: 'audio file required' });
        // Guard against the empty/partial recording race: OEM dialers
        // (Samsung especially) create the .m4a file at call start and
        // write audio bytes incrementally as the call progresses. If the
        // mobile sync fires before the dialer flushes the buffer to disk,
        // we get a zero-byte / sub-1KB file. Saving that into
        // lead_recordings produces a row that can't be played back.
        const _gotBytes = req.file.size || (req.file.buffer && req.file.buffer.length) || 0;
        if (_gotBytes < 4096) {
          return res.status(400).json({
            error: 'recording still being written by dialer (' + _gotBytes + ' bytes) — retry after a few seconds',
            still_writing: true
          });
        }
        // Transcode at upload time if the codec isn't browser-playable.
        // Samsung 3GP/AMR → MP3 here so playback later is just bytea →
        // <audio>, no transcode round-trip per play.
        try {
          const _tx = require('./utils/audioTranscode');
          if (_tx.needsTranscode(req.file.buffer)) {
            console.log('[/api/recordings] transcoding AMR/3GP → MP3 (' + _gotBytes + ' bytes)');
            const mp3 = await _tx.transcodeToMp3(req.file.buffer);
            if (mp3 && mp3.length > 0) {
              req.file.buffer = mp3;
              req.file.size   = mp3.length;
              req.file.mimetype = 'audio/mpeg';
              console.log('[/api/recordings] transcode OK → ' + mp3.length + ' bytes MP3');
            } else {
              console.warn('[/api/recordings] transcode returned empty — storing original; browsers may not play');
            }
          }
        } catch (e) {
          console.warn('[/api/recordings] transcode failed (storing original):', e.message);
        }
        let phone = String(req.body.phone || '').trim();
        // REC_DIRECTION_INFER_v1 (2026-06-03) — before defaulting to 'out',
        // look up the most recent incoming_ringing for this user+phone in
        // the last 10 min. OEM dialer filenames rarely embed direction, so
        // the APK uploads with no direction; the old default of 'out'
        // mislabeled inbound recordings as Outgoing in Call Activity.
        // Pooja TR's learnimo screenshot showed an inbound call with the
        // recording row tagged Outgoing 0:37 — this fixes it.
        let direction = String(req.body.direction || '').toLowerCase();
        if (!direction || direction === 'unknown') {
          const _phoneRaw = String(req.body.phone || '').replace(/^'/, '').trim();
          const _tail = _phoneRaw.replace(/\D/g, '').slice(-10);
          if (_tail) {
            try {
              const { authUser } = require('./utils/auth');
              const _token = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
              const _me = await authUser(_token);
              const _r = await tenantDb.query(
                `SELECT direction FROM call_events
                  WHERE user_id = $1
                    AND created_at >= NOW() - INTERVAL '10 minutes'
                    AND phone LIKE $2
                    AND event = 'incoming_ringing'
                  ORDER BY created_at DESC LIMIT 1`,
                [_me.id, '%' + _tail]
              );
              if (_r.rows[0] && _r.rows[0].direction === 'in') direction = 'in';
            } catch (_) {}
          }
          if (!direction) direction = 'out';
        }
        const filename = String(req.body.filename || (req.file && req.file.originalname) || '');
        const startedAt = req.body.started_at ? new Date(req.body.started_at) : new Date();
        const lastFourHint = String(req.body.lastfour_hint || '').slice(0, 6);
        let leadId = Number(req.body.lead_id) || null;
        let autoCreated = false;
        // Filename fallback: if cap-app couldn't supply a phone, try to dig one out
        // of the filename. Useful when the OEM file landed but PhoneStateReceiver missed.
        if (!phone && filename) {
          const m = filename.match(/(?:91|\+91|091)?[6-9]\d{9}/) || filename.match(/\d{10,15}/);
          if (m) phone = m[0];
        }
        // Timestamp + last-4 fallback: when phone is still unknown, find a recent
        // call_event (within +/- 5 min of started_at) on this user. lastfour_hint matches
        // tail of phone if filename only had a contact name + last-4 (Samsung style).
        if (!phone || !leadId) {
          try {
            const ev = await db.query(
              `SELECT id, phone, lead_id, created_at FROM call_events
                 WHERE user_id = $1
                   AND created_at BETWEEN $2 AND $3
                 ORDER BY created_at DESC LIMIT 20`,
              [me.id, new Date(startedAt.getTime() - 5*60*1000), new Date(startedAt.getTime() + 5*60*1000)]
            );
            let pick = null;
            if (lastFourHint && /^\d{3,5}$/.test(lastFourHint)) {
              pick = ev.rows.find(r => String(r.phone || '').endsWith(lastFourHint));
            }
            if (!pick) pick = ev.rows[0];
            if (pick) {
              if (!phone) phone = pick.phone || '';
              if (!leadId && pick.lead_id) leadId = pick.lead_id;
            }
          } catch (e) { console.warn('[/api/recordings] call_event lookup failed:', e.message); }
        }
        if (!leadId && phone) {
          const lead = await recRoutes._findLeadByPhone(phone);
          if (lead) leadId = lead.id;
        }
        // CALL_ACTIVITY_UNKNOWN_v1 (2026-06-04) — auto-create-lead REMOVED.
        // Per user instruction: if no lead matches the recording's phone,
        // the recording is stored with lead_id=NULL. No phantom leads.
        // Robust MIME — different phones write different formats. Sniff
        // the magic bytes first; fall back to the filename extension; only
        // trust the multipart Content-Type when both above are unavailable.
        const _tx0 = require('./utils/audioTranscode');
        const _detectedMime = _tx0.guessAudioMime(
          req.file.originalname || req.body.device_path || '',
          req.file.buffer
        );
        const _finalMime = (_detectedMime && _detectedMime !== 'application/octet-stream')
          ? _detectedMime
          : (req.file.mimetype || 'audio/mp4');
        // REC_DEDUP_v1 — idempotent upload so Re-sync All never doubles rows.
        // Build a stable dedup_key from the device file path when present,
        // else (started_at_minute, size_bytes). Same key = same file.
        const _devicePath = String(req.body.device_path || '');
        let _startedAtMs;
        try { _startedAtMs = new Date(req.body.started_at || db.nowIso()).getTime() || Date.now(); }
        catch (_) { _startedAtMs = Date.now(); }
        const _dedupKey = _devicePath
          ? ('p:' + _devicePath)
          : ('t:' + Math.floor(_startedAtMs / 60000) + ':s:' + (req.file.size||0));
        // Self-heal schema on first hit (column + unique index).
        try {
          await db.query('ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS dedup_key TEXT');
          // REC_DEDUP_v2_HOTFIX — partial index broke ON CONFLICT clause matching.
          // Drop it + recreate as non-partial. dedup_key is always computed so NULL never appears,
          // but COALESCE is belt-and-braces. The drop is safe (only runs if old index exists).
          await db.query('DROP INDEX IF EXISTS uniq_lead_rec_user_dedup');
          await db.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_lead_rec_user_dedup ON lead_recordings(user_id, dedup_key)');
        } catch (_) {}
        // Already uploaded? Return its id so client treats as no-op success.
        let id = null;
        // REC_FILENAME_DEDUP_v1: filename match BEFORE dedup_key — protects
        // against reinstall / URI-change cases where dedup_key would differ
        // but it's the same physical file.
        if (filename) {
          try {
            const _exF = await db.query(
              'SELECT id, lead_id FROM lead_recordings WHERE original_filename = $1 LIMIT 1',
              [filename]
            );
            if (_exF.rows[0]) {
              return res.json({
                ok: true,
                id: _exF.rows[0].id,
                lead_id: _exF.rows[0].lead_id,
                auto_created: false,
                already_synced: true,
                dedup_via: 'filename'
              });
            }
          } catch (_) { /* column may not exist yet on first deploy; fall through */ }
        }
        try {
          const _ex = await db.query(
            'SELECT id, lead_id FROM lead_recordings WHERE user_id = $1 AND dedup_key = $2 LIMIT 1',
            [me.id, _dedupKey]
          );
          if (_ex.rows[0]) {
            return res.json({
              ok: true,
              id: _ex.rows[0].id,
              lead_id: _ex.rows[0].lead_id,
              auto_created: false,
              already_synced: true
            });
          }
        } catch (_) {}
        // Fresh upload — INSERT with ON CONFLICT for race safety.
        try {
          // REC_FILENAME_DEDUP_v1 (2026-05-20) — also store original_filename so
          // future syncs can ask "do you already have this filename?" instead of
          // relying on the device_path which changes on reinstall.
          try { await db.query('ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS original_filename TEXT'); } catch (_) {}
          try { await db.query('CREATE INDEX IF NOT EXISTS idx_lead_rec_filename ON lead_recordings(original_filename) WHERE original_filename IS NOT NULL'); } catch (_) {}
          const _ins = await db.query(
            `INSERT INTO lead_recordings
               (lead_id, user_id, phone, direction, duration_s, device_path, mime_type, size_bytes, audio_bytes, started_at, created_at, dedup_key, original_filename)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (user_id, dedup_key) DO NOTHING
             RETURNING id`,
            [leadId, me.id, phone, direction, Number(req.body.duration_s) || 0,
             _devicePath, _finalMime, (req.file.size||0), req.file.buffer,
             req.body.started_at || db.nowIso(), db.nowIso(), _dedupKey, filename || null]
          );
          id = _ins.rows[0] ? _ins.rows[0].id : null;
        } catch (e) {
          // REC_DEDUP_v2_HOTFIX — used to silently swallow this. The actual SQL
          // error (e.g. 'no unique constraint matching ON CONFLICT') has to bubble
          // up to the client so we can see real failures instead of a generic
          // 'insert returned no id' downstream.
          console.error('[/api/recordings] insert error:', e.message);
          throw e;
        }
        if (!id) {
          // Lost race against a concurrent identical upload — find the winner.
          try {
            const _r2 = await db.query(
              'SELECT id, lead_id FROM lead_recordings WHERE user_id = $1 AND dedup_key = $2 LIMIT 1',
              [me.id, _dedupKey]
            );
            if (_r2.rows[0]) {
              return res.json({
                ok: true,
                id: _r2.rows[0].id,
                lead_id: _r2.rows[0].lead_id,
                auto_created: false,
                already_synced: true
              });
            }
          } catch (_) {}
          throw new Error('lead_recordings insert returned no id');
        }
        try {
          // CALL_ACTIVITY_UNKNOWN_v1 (2026-06-04) — three-branch logic:
          //   A) Empty-phone row exists nearby (Samsung process-death case)
          //      → UPDATE that row: backfill phone, set direction='unknown',
          //      attach recording, set duration. The blank '—' row in Call
          //      Activity is now identified.
          //   B) Existing row for same phone within +/- 10 min → just attach
          //      recording_id + duration. Direction stays as-is (don't flip).
          //   C) Otherwise → INSERT new call_events row with direction=
          //      'unknown' at the recording's actual started_at. Becomes
          //      its own Unknown line in Call Activity.
          // In ALL branches: NEVER touch leads.status_id, NEVER auto-create
          // lead. If no lead found by phone, lead_id stays NULL.
          let _evStartedMs = Date.now();
          try {
            const _s = req.body.started_at;
            if (_s) {
              const _ms = new Date(_s).getTime();
              if (!isNaN(_ms) && _ms > 0 && _ms < Date.now() + 60_000) _evStartedMs = _ms;
            }
          } catch (_) {}
          const _evIso = new Date(_evStartedMs).toISOString();
          const _phoneTail = String(phone || '').replace(/\D/g, '').slice(-10);
          const _dur = Number(req.body.duration_s) || 0;

          // Dedup: skip if this recording is already attached.
          const _ce = await db.query('SELECT id FROM call_events WHERE recording_id = $1 LIMIT 1', [id]);
          if (!_ce.rows[0]) {
            let _handled = false;

            // BRANCH A: empty-phone row for this user within +/- 30 min
            // (the Samsung blank-number outgoing case).
            // CALL_PHONE_REVERSE_BACKFILL_v1 (2026-06-13) — window widened
            // from 2 min → 30 min so recordings that sync hours later still
            // pair with their empty-phone outgoing rows. Direction is set
            // to 'out' (not 'unknown') when no other call_event nearby has
            // a definitive direction, since the recording confirms an
            // outgoing call happened around this time.
            try {
              const _emptyRow = await db.query(`
                SELECT id FROM call_events
                 WHERE user_id = $1
                   AND (phone IS NULL OR TRIM(phone) = '')
                   AND recording_id IS NULL
                   AND created_at BETWEEN $2::timestamptz - INTERVAL '30 minutes'
                                      AND $2::timestamptz + INTERVAL '30 minutes'
                 ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $2::timestamptz)))
                 LIMIT 1
              `, [me.id, _evIso]);
              if (_emptyRow.rows[0]) {
                await db.query(
                  `UPDATE call_events
                      SET phone = $1,
                          direction = 'unknown',
                          recording_id = $2,
                          duration_s = GREATEST($3::int, COALESCE(duration_s, 0)),
                          lead_id = COALESCE($4, lead_id)
                    WHERE id = $5`,
                  [phone || '', id, _dur, leadId || null, _emptyRow.rows[0].id]
                );
                _handled = true;
              }
            } catch (e) { console.warn('[recordings] branch A (empty-phone backfill) failed:', e.message); }

            // BRANCH B: existing row for SAME phone within +/- 10 min
            if (!_handled && _phoneTail) {
              try {
                const _sameRow = await db.query(`
                  SELECT id, direction, duration_s FROM call_events
                   WHERE user_id = $1
                     AND phone LIKE $2
                     AND recording_id IS NULL
                     AND created_at BETWEEN $3::timestamptz - INTERVAL '10 minutes'
                                        AND $3::timestamptz + INTERVAL '10 minutes'
                   ORDER BY CASE event WHEN 'call_ended' THEN 1
                                       WHEN 'incoming_ringing' THEN 2 ELSE 3 END,
                            ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz)))
                   LIMIT 1
                `, [me.id, '%' + _phoneTail, _evIso]);
                if (_sameRow.rows[0]) {
                  await db.query(
                    `UPDATE call_events
                        SET recording_id = $1,
                            duration_s = GREATEST($2::int, COALESCE(duration_s, 0)),
                            lead_id = COALESCE($3, lead_id)
                      WHERE id = $4`,
                    [id, _dur, leadId || null, _sameRow.rows[0].id]
                  );
                  _handled = true;
                }
              } catch (e) { console.warn('[recordings] branch B (same-phone attach) failed:', e.message); }
            }

            // BRANCH C: no matching row — INSERT new row direction='unknown'
            if (!_handled) {
              await db.insert('call_events', {
                lead_id: leadId, user_id: me.id, phone, direction: 'unknown',
                event: 'recording_saved',
                duration_s: _dur,
                recording_id: id, created_at: _evIso
              });
            }
          }
        } catch (_) {}
        res.json({ ok: true, id, lead_id: leadId, auto_created: autoCreated });
      } catch (e) {
        console.error('[/api/recordings] tenant upload error:', e.message);
        res.status(400).json({ error: e.message });
      }
    });
});

// ---- Native call-event ingest (no WebView dependency) -----------
// PhoneStateReceiver in the Android APK POSTs here every time the
// phone rings or a call ends. Tenant resolved from the stored auth
// token so the receiver doesn't need to know the tenant slug — it
// just needs a token saved at login. This is the resilient path
// that fires even when the WebView is paused or the app is killed.
app.post('/api/call_event_native', require('express').json({ limit: '64kb' }), async (req, res) => {
  const tenantDb = require('./db/pg');
  const jwt = require('jsonwebtoken');
  const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
  try {
    const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) return res.status(401).json({ error: 'No auth token' });
    let decoded; try { decoded = jwt.verify(raw, _JWT_SECRET); } catch (_) { return res.status(401).json({ error: 'Bad token' }); }
    const uid = Number(decoded && decoded.id);
    if (!uid) return res.status(401).json({ error: 'Token has no user id' });
    // CALL_EVENT_TENANT_DIRECT_v1: prefer slug from JWT (decoded.t — set
    // by signToken at login). Falling back to _findTenantByLookup —
    // which scans every tenant pool — would make this endpoint 30+s
    // with ~30 tenants, and the APK PhoneStateReceiver POSTs here on
    // every call event, so the slow path is unacceptable.
    let t = null;
    const slugFromJwt = decoded && (decoded.t || decoded.slug);
    if (slugFromJwt) {
      try { t = await tenantPoolMod.findActiveTenant(String(slugFromJwt).toLowerCase()); } catch (_) {}
    }
    if (!t) {
      // Slow legacy path — only used if older clients are still on a JWT
      // that doesn't carry the slug.
      t = await _findTenantByLookup('SELECT 1 FROM users WHERE id=$1 AND COALESCE(is_active,1)=1 LIMIT 1', [uid]);
    }
    if (!t) return res.status(404).json({ error: 'No active tenant for user' });
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) return res.status(500).json({ error: 'tenant pool unavailable' });
    return tenantDb.tenantStorage.run({ pool, tenant: t, slug: t.slug }, async () => {
      const recRoutes = require('./routes/recordings');
      const result = await recRoutes.api_call_logEvent(raw, {
        phone: req.body && req.body.phone,
        direction: req.body && req.body.direction,
        event: req.body && req.body.event,
        duration_s: req.body && req.body.duration_s,
        missed: req.body && req.body.missed,
        // CALL_HISTORY_TIME_FIX_v1 (2026-06-04) — accept the call's real
        // wall-clock time. Used by APK CallLog bulk import so historical
        // events aren't all stamped at NOW(). PhoneStateReceiver live posts
        // can also send this; if omitted, server falls back to NOW().
        at: req.body && (req.body.at || req.body.started_at || req.body.call_time)
      });
      // Enrich the response with the rich-notification payload so the
      // native PhoneStateReceiver can render a heads-up notification
      // RIGHT NOW — Android shows it on top of the dialer screen, which
      // means the rep sees the previous remark + last call date even
      // before they pick up. Cheaper than another round-trip.
      let lookup = null;
      try {
        lookup = await recRoutes.api_call_lookup(raw, req.body && req.body.phone);
      } catch (_) {}
      result.lookup = lookup || null;
      console.log('[/api/call_event_native]', t.slug, 'phone=', req.body && req.body.phone,
                  'event=', req.body && req.body.event, '→ lead_id=', result && result.lead_id,
                  '· lookup=', lookup && lookup.match ? (lookup.name || 'matched') : 'unmatched');
      res.json(result);
    });
  } catch (e) {
    console.error('[/api/call_event_native] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// INCOMING_CARD_v1 — lightweight read-only endpoint used by IncomingCallActivity
// to fetch lead-by-phone for the on-screen card. Same JWT auth + tenant
// resolution as /api/call_event_native (the slug claim on the JWT lets us
// pick the right tenant pool fast — no scanning).
app.get('/api/lookup_lead_native', async (req, res) => {
  const tenantDb = require('./db/pg');
  const jwt = require('jsonwebtoken');
  const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
  try {
    const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) return res.status(401).json({ error: 'No auth token' });
    let decoded; try { decoded = jwt.verify(raw, _JWT_SECRET); } catch (_) { return res.status(401).json({ error: 'Bad token' }); }
    const uid = Number(decoded && decoded.id);
    if (!uid) return res.status(401).json({ error: 'Token has no user id' });
    let t = null;
    const slugFromJwt = decoded && (decoded.t || decoded.slug);
    if (slugFromJwt) {
      try { t = await tenantPoolMod.findActiveTenant(String(slugFromJwt).toLowerCase()); } catch (_) {}
    }
    if (!t) return res.status(404).json({ error: 'No tenant' });
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) return res.status(500).json({ error: 'tenant pool unavailable' });
    const phone = String(req.query.phone || '').slice(0, 32);
    if (!phone) return res.json({ lead: null });
    return tenantDb.tenantStorage.run({ pool, tenant: t, slug: t.slug }, async () => {
      const recRoutes = require('./routes/recordings');
      let lookup = null;
      try { lookup = await recRoutes.api_call_lookup(raw, phone); } catch (_) {}
      if (!lookup || !lookup.match) return res.json({ lead: null });
      // Shape it down to just the fields the Activity card needs.
      res.json({
        lead: {
          id: lookup.id || 0,
          name: lookup.name || '',
          status: lookup.status || '',
          last_remark: lookup.last_remark || lookup.last_note || ''
        }
      });
    });
  } catch (e) {
    console.error('[/api/lookup_lead_native] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// REC_DIAG_PING_v1 — receives status pings from RecordingsBackgroundSyncWorker
// on the APK. Lets us see in Railway logs exactly what the worker is doing
// without device-side adb logcat. Auth-optional: the whole point is to
// diagnose missing-creds cases, so don't reject when token is absent.
app.post('/api/rec-diag', require('express').json({ limit: '8kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    console.log('[/api/rec-diag]',
      'trigger=', b.trigger || '?',
      'phase=', b.phase || '?',
      'tenant=', b.tenant || '?',
      'user=', b.user_id != null ? b.user_id : '?',
      'apk_version=', b.apk_version || '?',
      'has_folder=', b.has_folder ? 'yes' : 'NO',
      'has_token=', b.has_token ? 'yes' : 'NO',
      'has_base=', b.has_base ? 'yes' : 'NO',
      'folder_readable=', b.folder_readable != null ? (b.folder_readable ? 'yes' : 'NO') : '?',
      'files=', b.file_count != null ? b.file_count : '?',
      'uploaded=', b.uploaded != null ? b.uploaded : '?',
      'skipped=', b.skipped != null ? b.skipped : '?',
      'failed=', b.failed != null ? b.failed : '?',
      'note=', (b.note || '').toString().slice(0, 200)
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[/api/rec-diag] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// CRM_PERF_v1_SERVER — read the live per-process tally of slow API calls.
// Aggregated from the tenantApi dispatcher whenever any handler takes
// >=1000ms. No DB writes — pure in-memory accumulator that resets on each
// Railway redeploy.
// PERF_HEALTH_PANEL_v1 + PERF_HEALTH_TENANT_SCOPE_v1 — admin can reset the
// tally for their own tenant only (super-admin clears everything).
app.post('/api/perf-reset', async (req, res) => {
  try {
    let tenantSlug = '';
    let isSuper = false;
    try {
      const jwt = require('jsonwebtoken');
      const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
      const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded;
      try { decoded = jwt.verify(raw, _JWT_SECRET); }
      catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
      if (decoded && decoded.t) tenantSlug = String(decoded.t);
      isSuper = !!(decoded && (decoded.is_super_admin || decoded.super_admin));
    } catch (_) {}

    if (isSuper) {
      global._perfSlowTally = { by_fn: {}, by_tenant: {}, recent: [] };
      global._perfClientReports = [];
    } else if (tenantSlug) {
      const T = global._perfSlowTally || { by_fn: {}, by_tenant: {}, recent: [] };
      T.recent = (T.recent || []).filter(r => String(r.tenant || '') !== tenantSlug);
      delete (T.by_tenant || {})[tenantSlug];
      global._perfSlowTally = T;
      // Rebuild by_fn from the remaining recent slice (best-effort).
      const agg = {};
      (T.recent || []).forEach(r => {
        const k = r.fn || '?';
        if (!agg[k]) agg[k] = { n: 0, total: 0, max: 0 };
        agg[k].n++; agg[k].total += r.ms; if (r.ms > agg[k].max) agg[k].max = r.ms;
      });
      T.by_fn = agg;
      global._perfClientReports = (global._perfClientReports || []).filter(r => String(r.tenant || '') !== tenantSlug);
    } else {
      return res.status(403).json({ error: 'Tenant context missing' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/perf-summary', async (req, res) => {
  try {
    // PERF_HEALTH_TENANT_SCOPE_v1 — require auth + filter to the requester's
    // tenant unless they're a super-admin. Without this, every tenant could
    // see every other tenant's slow APIs and client dumps.
    let tenantSlug = '';
    let isSuper = false;
    try {
      const jwt = require('jsonwebtoken');
      const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
      const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded;
      try { decoded = jwt.verify(raw, _JWT_SECRET); }
      catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
      // JWT may carry the tenant slug directly (\'t\' claim) — that's the
      // cheapest signal. Fall back to looking up the user's tenant.
      if (decoded && decoded.t) tenantSlug = String(decoded.t);
      isSuper = !!(decoded && (decoded.is_super_admin || decoded.super_admin));
      if (!tenantSlug && !isSuper) {
        const uid = Number(decoded && decoded.id);
        if (uid) {
          try {
            const t = await _findTenantByLookup(
              'SELECT 1 FROM users WHERE id = $1 AND COALESCE(is_active, 1) = 1 LIMIT 1',
              [uid]
            );
            if (t) tenantSlug = t.slug || '';
          } catch (_) {}
        }
      }
      if (!isSuper && !tenantSlug) return res.status(403).json({ error: 'Tenant context missing' });
    } catch (e) {
      return res.status(500).json({ error: 'auth check failed: ' + e.message });
    }

    const T = global._perfSlowTally || { by_fn: {}, by_tenant: {}, recent: [] };

    // Filter recent slow calls by this tenant (unless super-admin).
    const recentAll = T.recent || [];
    const recent_filtered = isSuper ? recentAll : recentAll.filter(r => String(r.tenant || '') === tenantSlug);

    // top_fn is re-aggregated from the filtered recent slice so the average
    // reflects only this tenant's calls. (The cross-tenant by_fn table on
    // the global tally is super-admin-only.)
    let top_fn;
    if (isSuper) {
      top_fn = Object.entries(T.by_fn || {}).map(([fn, st]) => ({ fn, n: st.n, avg: Math.round(st.total / st.n), max: st.max })).sort((a, b) => b.avg - a.avg).slice(0, 20);
    } else {
      const agg = {};
      recent_filtered.forEach(r => {
        const k = r.fn || '?';
        if (!agg[k]) agg[k] = { n: 0, total: 0, max: 0 };
        agg[k].n++; agg[k].total += r.ms; if (r.ms > agg[k].max) agg[k].max = r.ms;
      });
      top_fn = Object.entries(agg).map(([fn, st]) => ({ fn, n: st.n, avg: Math.round(st.total / st.n), max: st.max })).sort((a, b) => b.avg - a.avg).slice(0, 20);
    }

    // top_tenant is super-admin only — for tenant users it's just their row.
    let top_tenant;
    if (isSuper) {
      top_tenant = Object.entries(T.by_tenant || {}).map(([t, st]) => ({ tenant: t, n: st.n, avg: Math.round(st.total / st.n), max: st.max })).sort((a, b) => b.n - a.n).slice(0, 20);
    } else {
      const my = (T.by_tenant || {})[tenantSlug];
      top_tenant = my ? [{ tenant: tenantSlug, n: my.n, avg: Math.round(my.total / my.n), max: my.max }] : [];
    }

    const reportsAll = global._perfClientReports || [];
    const reports = isSuper
      ? reportsAll.slice(-30).reverse()
      : reportsAll.filter(r => String(r.tenant || '') === tenantSlug).slice(-30).reverse();

    // PERF_HEALTH_DB_PERSIST_v1 — also pull persisted rows from DB (last 7 days)
    // so the page survives Railway redeploys. Tenant-scoped via SQL WHERE.
    let dbSlow = [];
    let dbReports = [];
    try {
      const slowQ = isSuper
        ? `SELECT EXTRACT(EPOCH FROM created_at)*1000 AS t, fn, ms, tenant_slug AS tenant,
                  user_id AS \"user\", source, ua
             FROM perf_slow_log
            WHERE created_at >= NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC LIMIT 200`
        : `SELECT EXTRACT(EPOCH FROM created_at)*1000 AS t, fn, ms, tenant_slug AS tenant,
                  user_id AS \"user\", source, ua
             FROM perf_slow_log
            WHERE tenant_slug = $1 AND created_at >= NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC LIMIT 200`;
      const r1 = isSuper
        ? await controlDb.query(slowQ)
        : await controlDb.query(slowQ, [tenantSlug]);
      dbSlow = (r1.rows || []).map(r => ({
        t: Number(r.t), fn: r.fn, ms: Number(r.ms),
        tenant: r.tenant, user: r.user, source: r.source
      }));

      const repQ = isSuper
        ? `SELECT EXTRACT(EPOCH FROM created_at)*1000 AS at_ms,
                  tenant_slug AS tenant, user_email AS \"user\", platform,
                  apk_version AS apk, online, network, view, api_calls, slow_1s,
                  very_slow_3s, long_tasks, mem_mb, top_by_avg, very_slow_sample, ua
             FROM perf_client_reports
            WHERE created_at >= NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC LIMIT 50`
        : `SELECT EXTRACT(EPOCH FROM created_at)*1000 AS at_ms,
                  tenant_slug AS tenant, user_email AS \"user\", platform,
                  apk_version AS apk, online, network, view, api_calls, slow_1s,
                  very_slow_3s, long_tasks, mem_mb, top_by_avg, very_slow_sample, ua
             FROM perf_client_reports
            WHERE tenant_slug = $1 AND created_at >= NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC LIMIT 50`;
      const r2 = isSuper
        ? await controlDb.query(repQ)
        : await controlDb.query(repQ, [tenantSlug]);
      dbReports = (r2.rows || []).map(r => Object.assign({}, r, {
        at_ms: Number(r.at_ms),
        top_by_avg: typeof r.top_by_avg === 'string' ? JSON.parse(r.top_by_avg || '[]') : (r.top_by_avg || []),
        very_slow_sample: typeof r.very_slow_sample === 'string' ? JSON.parse(r.very_slow_sample || '[]') : (r.very_slow_sample || [])
      }));
    } catch (e) {
      console.warn('[perf-summary] DB read failed:', e.message);
    }

    // Merge in-memory + DB rows. In-memory wins (fresher). Cap at 200.
    const mergedSlow = recent_filtered.concat(dbSlow);
    const seen = new Set();
    const dedupedSlow = mergedSlow.filter(r => {
      const k = r.t + '|' + r.fn + '|' + r.ms;
      if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b) => b.t - a.t).slice(0, 200);

    // Re-aggregate top_fn from the merged set (so the top APIs reflect ALL
    // history, not just since the last deploy).
    const agg = {};
    dedupedSlow.forEach(r => {
      const k = r.fn || '?';
      if (!agg[k]) agg[k] = { n: 0, total: 0, max: 0 };
      agg[k].n++; agg[k].total += r.ms; if (r.ms > agg[k].max) agg[k].max = r.ms;
    });
    const top_fn_merged = Object.entries(agg)
      .map(([fn, st]) => ({ fn, n: st.n, avg: Math.round(st.total / st.n), max: st.max }))
      .sort((a, b) => b.avg - a.avg).slice(0, 20);

    // Merge client dumps (in-memory + DB).
    const mergedReports = reports.concat(dbReports)
      .filter((r, i, arr) => arr.findIndex(x => x.at_ms === r.at_ms && x.user === r.user) === i)
      .sort((a, b) => b.at_ms - a.at_ms).slice(0, 50);

    res.json({
      ok: true,
      slow_threshold_ms: 1000,
      total_slow: dedupedSlow.length,
      top_fn: top_fn_merged.length ? top_fn_merged : top_fn,
      top_tenant,
      recent_slow: dedupedSlow,
      client_reports: mergedReports,
      scope: isSuper ? 'all_tenants' : ('tenant:' + tenantSlug),
      persisted_to_db: true
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PERF_ROOT_v1 — /api/perf-pgactivity
// Read-only DB-side diagnostic. Returns live pg_stat_activity for the
// caller's tenant DB, the JS pool stats, indexes on recordings + leads,
// and the per_tenant_max env value. Lets us see in one shot whether the
// "slow API" cluster is queries actually running long OR connection-pool
// wait, and whether the indexes we shipped are present on this DB.
app.get('/api/perf-pgactivity', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
    const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) return res.status(401).json({ error: 'No auth token' });
    let decoded;
    try { decoded = jwt.verify(raw, _JWT_SECRET); }
    catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }

    let tenantSlug = decoded && decoded.t ? String(decoded.t) : '';
    const isSuper = !!(decoded && (decoded.is_super_admin || decoded.super_admin));
    const askedSlug = String(req.query.slug || '').trim();
    if (isSuper && askedSlug) tenantSlug = askedSlug;
    if (!tenantSlug) return res.status(400).json({ error: 'No tenant slug (pass ?slug= as super-admin or use a tenant token)' });

    const t = await tenantPoolMod.findActiveTenant(tenantSlug);
    if (!t) return res.status(404).json({ error: 'tenant not found: ' + tenantSlug });
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) return res.status(500).json({ error: 'no pool for tenant' });

    let activity = [];
    try {
      const r = await pool.query(
        "SELECT pid, EXTRACT(EPOCH FROM (now() - query_start)) AS age_sec, state, wait_event_type, wait_event, LEFT(query, 300) AS query FROM pg_stat_activity WHERE datname = current_database() AND state IS NOT NULL AND state <> 'idle' ORDER BY age_sec DESC NULLS LAST LIMIT 40"
      );
      activity = r.rows;
    } catch (e) { activity = [{ error: 'pg_stat_activity: ' + e.message }]; }

    let conn_summary = [];
    try {
      const r = await pool.query(
        "SELECT state, COUNT(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() GROUP BY state ORDER BY n DESC"
      );
      conn_summary = r.rows;
    } catch (_) {}

    let recordings_indexes = [];
    let leads_indexes = [];
    let wa_indexes = [];
    try { const r = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'recordings' ORDER BY indexname"); recordings_indexes = r.rows; } catch (_) {}
    try { const r = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'leads' ORDER BY indexname"); leads_indexes = r.rows; } catch (_) {}
    try { const r = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'whatsapp_messages' ORDER BY indexname"); wa_indexes = r.rows; } catch (_) {}

    let row_counts = {};
    try {
      const r = await pool.query("SELECT 'recordings' AS t, COUNT(*)::bigint AS n FROM recordings UNION ALL SELECT 'leads', COUNT(*) FROM leads UNION ALL SELECT 'whatsapp_messages', COUNT(*) FROM whatsapp_messages");
      r.rows.forEach(row => { row_counts[row.t] = Number(row.n); });
    } catch (e) { row_counts.error = e.message; }

    return res.json({
      ok: true,
      tenant: { slug: t.slug, db_name: t.db_name },
      env_per_tenant_max: process.env.PG_POOL_PER_TENANT_MAX || null,
      hardcoded_default_pool: 3,
      js_pool_stats: tenantPoolMod.getPoolStats(),
      conn_summary, activity, row_counts,
      recordings_indexes, leads_indexes, wa_indexes,
      now: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CRM_PERF_v1_APK — receive a performance diagnostic dump from the SPA / APK.
// Console-logged so it surfaces in Railway logs. Compact 1-line summary plus
// the full JSON for support inspection. Auth optional — the whole point is
// to capture cases where the user is having trouble.
app.post('/api/perf-report', require('express').json({ limit: '256kb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const ev = Array.isArray(b.events) ? b.events : [];
    const apiCalls = ev.filter(e => e && e.type === 'api');
    const slow = apiCalls.filter(e => e.ms >= 1000);
    const verySlow = apiCalls.filter(e => e.ms >= 3000);
    const lt = ev.filter(e => e && e.type === 'longtask');
    const memSeries = ev.filter(e => e && e.type === 'mem');
    const topByAvg = {};
    apiCalls.forEach(e => { if (!topByAvg[e.fn]) topByAvg[e.fn] = { n: 0, total: 0, max: 0 }; topByAvg[e.fn].n++; topByAvg[e.fn].total += e.ms; if (e.ms > topByAvg[e.fn].max) topByAvg[e.fn].max = e.ms; });
    const top5 = Object.entries(topByAvg).map(([fn, st]) => ({ fn, n: st.n, avg: Math.round(st.total / st.n), max: st.max })).sort((a, b) => b.avg - a.avg).slice(0, 5);
    console.log('[/api/perf-report]',
      'tenant=', b.tenant || '?',
      'user=', b.user || '?',
      'platform=', b.platform || 'web',
      'apk=', b.apk_version || '?',
      'events=', ev.length,
      'api_calls=', apiCalls.length,
      'slow_1s=', slow.length,
      'very_slow_3s=', verySlow.length,
      'long_tasks=', lt.length,
      'mem_mb=', memSeries.length ? memSeries[memSeries.length - 1].mb : '?',
      'online=', b.online != null ? b.online : '?',
      'network=', b.network || '?',
      'ua=', String(b.ua || '').slice(0, 120)
    );
    if (top5.length) console.log('[/api/perf-report] TOP_BY_AVG_MS', JSON.stringify(top5));
    if (verySlow.length) console.log('[/api/perf-report] VERY_SLOW', JSON.stringify(verySlow.slice(0, 10).map(e => ({ fn: e.fn, ms: e.ms, view: e.view }))));
    /* PERF_HEALTH_PANEL_v1 — persist a compact dump summary so the admin
       dashboard can show recent client-uploaded reports without us having
       to grep Railway logs. Keep last 50 in-memory. */
    try {
      if (!global._perfClientReports) global._perfClientReports = [];
      global._perfClientReports.push({
        at_ms: Date.now(),
        tenant: b.tenant || '?',
        user: b.user || '?',
        platform: b.platform || 'web',
        apk: b.apk_version || '',
        online: b.online != null ? Boolean(b.online) : null,
        network: b.network || '',
        view: b.current_view || '',
        api_calls: apiCalls.length,
        slow_1s: slow.length,
        very_slow_3s: verySlow.length,
        long_tasks: lt.length,
        mem_mb: memSeries.length ? memSeries[memSeries.length - 1].mb : null,
        top_by_avg: top5,
        very_slow_sample: verySlow.slice(0, 10).map(e => ({ fn: e.fn, ms: e.ms, view: e.view })),
        ua: String(b.ua || '').slice(0, 200)
      });
      if (global._perfClientReports.length > 50) {
        global._perfClientReports = global._perfClientReports.slice(-50);
      }
      // PERF_HEALTH_DB_PERSIST_v1 — also persist to DB so the report survives
      // Railway redeploys. Tenant slug is read from the JWT if present (so an
      // APK can't lie about which tenant the dump belongs to), falling back
      // to the body's b.tenant for older clients.
      try {
        let dbTenant = '';
        try {
          const jwt = require('jsonwebtoken');
          const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
          const raw = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
          if (raw) {
            const dec = jwt.verify(raw, _JWT_SECRET);
            if (dec && dec.t) dbTenant = String(dec.t);
          }
        } catch (_) {}
        if (!dbTenant) dbTenant = String(b.tenant || '');
        controlDb.query(
          `INSERT INTO perf_client_reports
           (created_at, tenant_slug, user_email, platform, apk_version, online, network, view,
            api_calls, slow_1s, very_slow_3s, long_tasks, mem_mb, top_by_avg, very_slow_sample, ua)
           VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15)`,
          [
            dbTenant || null,
            String(b.user || '').slice(0, 200),
            String(b.platform || 'web').slice(0, 30),
            String(b.apk_version || '').slice(0, 30),
            b.online != null ? Boolean(b.online) : null,
            String(b.network || '').slice(0, 30),
            String(b.current_view || '').slice(0, 100),
            apiCalls.length,
            slow.length,
            verySlow.length,
            lt.length,
            memSeries.length ? Number(memSeries[memSeries.length - 1].mb) : null,
            JSON.stringify(top5),
            JSON.stringify(verySlow.slice(0, 10).map(e => ({ fn: e.fn, ms: e.ms, view: e.view }))),
            String(b.ua || '').slice(0, 250)
          ]
        ).catch(err => console.warn('[perf-report] DB insert failed:', err.message));
      } catch (_) {}
    } catch (_) {}
    res.json({ ok: true, received: ev.length });
  } catch (e) {
    console.error('[/api/perf-report] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Admin diag: run ffmpeg -i on the stored bytes and report whether
// ffmpeg itself can decode them. Returns the head hex of the first 1KB
// so support can inspect the file format without downloading megabytes.
app.get('/api/recordings/:id/verify', async (req, res) => {
  const tenantDb = require('./db/pg');
  const jwt = require('jsonwebtoken');
  const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
  try {
    if (!req.tenant) {
      const raw = (req.query.token || req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded; try { decoded = jwt.verify(raw, _JWT_SECRET); } catch (_) { return res.status(401).json({ error: 'Bad token' }); }
      const uid = Number(decoded && decoded.id);
      const t = await _findTenantByLookup('SELECT 1 FROM users WHERE id=$1 AND COALESCE(is_active,1)=1 LIMIT 1', [uid]);
      if (!t) return res.status(404).json({ error: 'No tenant' });
      req.tenant = t; req.tenantPool = tenantPoolMod.poolFor(t); req.tenantSlug = t.slug;
    }
    return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, async () => {
      const r = await tenantDb.query('SELECT mime_type, audio_bytes FROM lead_recordings WHERE id=$1', [Number(req.params.id)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      let buf = r.rows[0].audio_bytes;
      if (!Buffer.isBuffer(buf)) buf = buf ? Buffer.from(buf) : null;
      if (!buf || buf.length === 0) return res.json({ ok: false, reason: 'no bytes stored', mime_type: r.rows[0].mime_type });

      const fs = require('fs'), os = require('os'), path = require('path');
      const cp = require('child_process');
      const tx = require('./utils/audioTranscode');
      const bin = (tx.getFfmpegBinary && tx.getFfmpegBinary()) || 'ffmpeg';
      const tmp = path.join(os.tmpdir(), 'verify-' + Date.now());
      try {
        fs.writeFileSync(tmp, buf);
        // 'ffmpeg -i' on its own probes the file and exits — stderr has the
        // codec/container info or the decode error.
        let decoded = false;
        let stderr = '';
        let durSec = 0;
        try {
          // -t 0.1 reads 100ms of audio and dumps to /dev/null — proves
          // the bitstream is actually decodable, not just structurally OK
          const out = cp.execFileSync(bin, ['-v', 'error', '-i', tmp, '-t', '0.1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
          decoded = true;
        } catch (e) {
          stderr = (e.stderr || e.message || '').toString().slice(-1500);
        }
        // Also run ffprobe-style query for duration
        try {
          const probeOut = cp.execFileSync(bin, ['-v', 'error', '-i', tmp], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
          stderr = stderr || probeOut;
        } catch (e) {
          // ffmpeg exits non-zero on -i with no output — stderr has the info
          stderr = stderr || (e.stderr || '').toString().slice(-1500);
          const m = /Duration: ([0-9:.]+)/.exec(stderr);
          if (m) durSec = parseFloat(m[1].split(':').reduce((a, b) => a * 60 + parseFloat(b), 0));
        }
        const head = buf.slice(0, 1024).toString('hex');
        res.json({
          ok: decoded,
          bytes: buf.length,
          stored_mime: r.rows[0].mime_type,
          ffmpeg_binary: bin,
          decode_ok: decoded,
          ffmpeg_stderr: stderr,
          duration_s: durSec,
          head_hex_1024: head
        });
      } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Stream uploaded audio bytes (token in query string) ----
// Diagnostic — returns metadata about a stored recording (mime, size in
// the row, actual length of the audio_bytes column as Postgres sees it,
// and a sha256 prefix of the first 16 bytes). Useful when playback fails
// to determine whether the upload landed correctly or the bytes are
// corrupt / empty. Tenant-resolves from token just like /audio.
app.get('/api/recordings/:id/info', async (req, res, next) => {
  const tenantDb = require('./db/pg');
  if (!req.tenant) {
    try {
      const jwt = require('jsonwebtoken');
      const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
      const raw = (req.query.token || req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded; try { decoded = jwt.verify(raw, _JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
      const uid = Number(decoded && decoded.id);
      const t = await _findTenantByLookup(
        'SELECT 1 FROM users WHERE id = $1 AND COALESCE(is_active, 1) = 1 LIMIT 1', [uid]
      );
      if (!t) return res.status(404).json({ error: 'No active tenant' });
      const pool = tenantPoolMod.poolFor(t);
      req.tenant = t; req.tenantPool = pool; req.tenantSlug = t.slug;
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        const r = await tenantDb.query(
          `SELECT id, lead_id, mime_type, size_bytes, duration_s, OCTET_LENGTH(audio_bytes) AS real_bytes, encode(substring(audio_bytes from 1 for 16), 'hex') AS head_hex, created_at FROM lead_recordings WHERE id = $1`,
          [Number(req.params.id)]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'not found' });
        res.json({ tenant: req.tenantSlug, row: r.rows[0] });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
});

// Admin diagnostic: confirm ffmpeg is available and working. Returns the
// resolved binary path + version + a smoke-test transcode of a tiny AMR
// blob. If this fails, browser playback for 3GP/AMR recordings won't work.
app.get('/api/recordings/ffmpeg-status', async (req, res) => {
  try {
    const tx = require('./utils/audioTranscode');
    const cp = require('child_process');
    const bin = tx.getFfmpegBinary && tx.getFfmpegBinary();
    let version = null;
    try {
      version = cp.execFileSync(bin || 'ffmpeg', ['-version'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0];
    } catch (e) {
      version = 'ffmpeg binary not runnable: ' + e.message;
    }
    res.json({ ok: !!bin, binary: bin || '(not resolved)', version });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: bulk re-transcode every recording that needs it. Useful when
// we change the transcode settings (e.g. bump sample rate) — one call
// fixes every old recording in the tenant. Streams JSON-per-line progress.
app.get('/api/recordings/retranscode-all', async (req, res) => {
  const tenantDb = require('./db/pg');
  const jwt = require('jsonwebtoken');
  const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
  try {
    if (!req.tenant) {
      const raw = (req.query.token || req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded; try { decoded = jwt.verify(raw, _JWT_SECRET); } catch (_) { return res.status(401).json({ error: 'Bad token' }); }
      const uid = Number(decoded && decoded.id);
      const t = await _findTenantByLookup('SELECT 1 FROM users WHERE id=$1 AND COALESCE(is_active,1)=1 LIMIT 1', [uid]);
      if (!t) return res.status(404).json({ error: 'No tenant' });
      req.tenant = t; req.tenantPool = tenantPoolMod.poolFor(t); req.tenantSlug = t.slug;
    }
    return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, async () => {
      const tx = require('./utils/audioTranscode');
      const diag = require('./utils/recordingDiag');
      // Pick every recording. The transcoder's needsTranscode() filter
      // skips those already in a browser-playable container (saves time).
      const rows = (await tenantDb.query('SELECT id, OCTET_LENGTH(audio_bytes) AS sz FROM lead_recordings ORDER BY id DESC LIMIT 500')).rows;
      let done = 0, skip = 0, fail = 0;
      const errors = [];
      for (const r of rows) {
        if (!r.sz || r.sz < 100) { skip++; continue; }
        const got = await tenantDb.query('SELECT audio_bytes FROM lead_recordings WHERE id=$1', [r.id]);
        let buf = got.rows[0] && got.rows[0].audio_bytes;
        if (!Buffer.isBuffer(buf)) buf = buf ? Buffer.from(buf) : null;
        if (!buf || buf.length === 0) { skip++; continue; }
        // Always run the transcode — even if the file is already MP3, the
        // new settings (44.1kHz + Xing) make it WebView-compatible.
        const t0 = Date.now();
        try {
          const mp3 = await tx.transcodeToMp3(buf);
          if (mp3 && mp3.length > 0) {
            await tenantDb.query('UPDATE lead_recordings SET audio_bytes=$1, size_bytes=$2, mime_type=$3 WHERE id=$4', [mp3, mp3.length, 'audio/mp4', r.id]);
            diag.log({ recording_id: r.id, action: 'bulk_retranscode', result: 'ok', bytes_in: buf.length, bytes_out: mp3.length, mime_out: 'audio/mp4', duration_ms: Date.now() - t0 });
            done++;
          } else {
            fail++; errors.push({ id: r.id, error: 'transcode returned null' });
            diag.log({ recording_id: r.id, action: 'bulk_retranscode', result: 'fail', bytes_in: buf.length, error_message: 'null/empty', duration_ms: Date.now() - t0 });
          }
        } catch (e) {
          fail++; errors.push({ id: r.id, error: e.message });
          diag.log({ recording_id: r.id, action: 'bulk_retranscode', result: 'fail', bytes_in: buf.length, error_message: e.message + (e._stderr ? ' | stderr: ' + e._stderr.slice(-300) : ''), duration_ms: Date.now() - t0 });
        }
      }
      return res.json({ ok: true, scanned: rows.length, done, skipped: skip, failed: fail, errors: errors.slice(0, 20) });
    });
  } catch (e) {
    console.error('[bulk-retranscode]', e);
    res.status(500).json({ error: e.message });
  }
});

// Admin: force a recording to re-transcode now. Replaces the stored
// bytes with MP3 so the in-app player works. Pass the auth token in
// ?token=. Returns { ok, from_bytes, to_bytes, mime } or an error.
app.get('/api/recordings/:id/retranscode', async (req, res) => {
  const tenantDb = require('./db/pg');
  const jwt = require('jsonwebtoken');
  const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
  try {
    if (!req.tenant) {
      const raw = (req.query.token || req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded; try { decoded = jwt.verify(raw, _JWT_SECRET); } catch (_) { return res.status(401).json({ error: 'Bad token' }); }
      const uid = Number(decoded && decoded.id);
      const t = await _findTenantByLookup('SELECT 1 FROM users WHERE id=$1 AND COALESCE(is_active,1)=1 LIMIT 1', [uid]);
      if (!t) return res.status(404).json({ error: 'No tenant' });
      req.tenant = t; req.tenantPool = tenantPoolMod.poolFor(t); req.tenantSlug = t.slug;
    }
    return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug }, async () => {
      const r = await tenantDb.query('SELECT audio_bytes FROM lead_recordings WHERE id=$1', [Number(req.params.id)]);
      if (!r.rows[0]) return res.status(404).json({ error: 'recording not found' });
      let buf = r.rows[0].audio_bytes;
      if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
      const fromBytes = buf.length;
      const tx = require('./utils/audioTranscode');
      const mp3 = await tx.transcodeToMp3(buf);
      const _diag = require('./utils/recordingDiag');
      if (!mp3) {
        _diag.log({ recording_id: Number(req.params.id), action: 'manual_retranscode', result: 'fail', bytes_in: fromBytes, error_message: 'transcode returned null (binary missing or ffmpeg threw)' });
        return res.status(500).json({ error: 'transcode returned null — check /api/recordings/ffmpeg-status', from_bytes: fromBytes });
      }
      await tenantDb.query('UPDATE lead_recordings SET audio_bytes=$1, size_bytes=$2, mime_type=$3 WHERE id=$4', [mp3, mp3.length, 'audio/mp4', Number(req.params.id)]);
      _diag.log({ recording_id: Number(req.params.id), action: 'manual_retranscode', result: 'ok', bytes_in: fromBytes, bytes_out: mp3.length, mime_in: 'audio/3gpp', mime_out: 'audio/mp4' });
      return res.json({ ok: true, from_bytes: fromBytes, to_bytes: mp3.length, mime: 'audio/mp4' });
    });
  } catch (e) {
    console.error('[retranscode]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recordings/:id/audio', async (req, res, next) => {
  // Tenant-agnostic playback: <audio src> bypasses the fetch monkey-patch
  // so the URL hits bare /api/recordings/:id/audio without /t/<slug>/.
  // Resolve the tenant from the auth token (same approach as the POST
  // upload handler) so the player works for every tenant.
  const tenantDb = require('./db/pg');
  if (!req.tenant) {
    try {
      const jwt = require('jsonwebtoken');
      const _JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
      const raw = (req.query.token || req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!raw) return res.status(401).json({ error: 'No auth token' });
      let decoded;
      try { decoded = jwt.verify(raw, _JWT_SECRET); }
      catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
      const uid = Number(decoded && decoded.id);
      if (!uid) return res.status(401).json({ error: 'Token has no user id' });
      const t = await _findTenantByLookup(
        'SELECT 1 FROM users WHERE id = $1 AND COALESCE(is_active, 1) = 1 LIMIT 1',
        [uid]
      );
      if (!t) return res.status(404).json({ error: 'No active tenant for this user' });
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) return res.status(500).json({ error: 'tenant pool unavailable' });
      req.tenant = t;
      req.tenantPool = pool;
      req.tenantSlug = t.slug;
    } catch (e) {
      console.error('[/api/recordings/:id/audio] tenant-from-token failed:', e.message);
      return res.status(500).json({ error: 'tenant resolution failed: ' + e.message });
    }
  }
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        const { authUser } = require('./utils/auth');
        const token = req.query.token || req.headers['x-auth-token'] || '';
        await authUser(token);
        const r = await tenantDb.query(
          `SELECT mime_type, audio_bytes FROM lead_recordings WHERE id = $1`,
          [Number(req.params.id)]
        );
        const row = r.rows[0];
        if (!row) {
          // Diagnostic: include WHICH tenant resolved and any recording IDs
          // present in that tenant — so a 404 surface tells the admin
          // whether the tenant resolution picked the wrong DB.
          let visibleIds = [];
          try {
            const v = await tenantDb.query(
              'SELECT id FROM lead_recordings ORDER BY id DESC LIMIT 5'
            );
            visibleIds = v.rows.map(x => x.id);
          } catch (_) {}
          return res.status(404).json({
            error: 'recording not found',
            requested_id: Number(req.params.id),
            tenant_resolved: req.tenantSlug || null,
            recent_recording_ids: visibleIds,
            hint: 'If tenant_resolved is wrong, log out + back in. If recent_recording_ids is empty, no recordings have synced for this tenant.'
          });
        }
        // Buffer.from is a no-op when audio_bytes already IS a Buffer (pg
        // returns bytea as Buffer); it normalises if some driver path
        // returned a base64 string instead.
        let buf = row.audio_bytes;
        if (!buf) return res.status(410).json({ error: 'recording has no audio bytes (zero-byte upload — re-sync after the dialer finishes writing)' });
        if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
        const total = buf.length;
        if (total === 0) return res.status(410).json({ error: 'recording has zero bytes' });
        // Sniff the actual container from the first 16 bytes — Samsung's
        // OEM call recorder often writes a 3GP container (with AMR codec
        // inside) but the upload pipeline tagged it as 'audio/m4a' because
        // of the filename or the multipart MIME guess. Browsers refuse to
        // decode AMR, so sending the wrong Content-Type silently breaks
        // playback. Sniffing gives us the truth.
        //
        // ISO Base Media File Format header layout:
        //   [4 bytes: box size][4 bytes: 'ftyp'][4 bytes: major brand]…
        // Common major brands:
        //   'M4A '  → AAC-in-MP4 (plays everywhere)         → audio/mp4
        //   'mp42'  → MP4 v2 (plays everywhere)             → audio/mp4
        //   'isom'  → MP4 base (plays everywhere)           → audio/mp4
        //   '3gp4'  → 3GPP r4 (usually AMR audio — NO browser decoder)
        //   '3gp5'  → 3GPP r5 (same)
        //   '3gp6'  → 3GPP r6 (same)
        // Lazy transcode for rows uploaded BEFORE the upload-side
        // transcoder shipped. If we sniff a 3GP/AMR file, transcode now,
        // write the MP3 back into the row so subsequent plays are
        // instant, and stream the MP3 in this response.
        try {
          const _tx = require('./utils/audioTranscode');
          // ?force=1 bypasses the needsTranscode gate so admin can force
          // a fresh transcode even on a file that's already in MP4/AAC.
          // Useful when the cached output itself is corrupt for some reason.
          const _force = String(req.query.force || '') === '1';
          if (_force || _tx.needsTranscode(buf)) {
            console.log('[/audio] lazy transcoding row ' + req.params.id + ' (' + total + ' bytes)');
            const _diag = require('./utils/recordingDiag');
            const _t0 = Date.now();
            let mp3 = null;
            try { mp3 = await _tx.transcodeToMp3(buf); }
            catch (txErr) {
              _diag.log({ recording_id: Number(req.params.id), action: 'lazy_on_play', result: 'fail', bytes_in: total, error_message: 'ffmpeg threw: ' + txErr.message + (txErr._stderr ? ' | stderr: ' + txErr._stderr.slice(-500) : ''), duration_ms: Date.now() - _t0 });
              mp3 = null;
            }
            if (mp3 && mp3.length > 0) {
              buf = mp3;
              try {
                await tenantDb.query(
                  'UPDATE lead_recordings SET audio_bytes = $1, size_bytes = $2, mime_type = $3 WHERE id = $4',
                  [mp3, mp3.length, 'audio/mp4', Number(req.params.id)]
                );
              } catch (e) { console.warn('[/audio] cache write failed:', e.message); }
              row.mime_type = 'audio/mp4';
              console.log('[/audio] lazy transcode OK row ' + req.params.id + ' → ' + mp3.length + ' bytes MP3');
              _diag.log({ recording_id: Number(req.params.id), action: 'lazy_on_play', result: 'ok', bytes_in: total, bytes_out: mp3.length, mime_in: 'audio/3gpp', mime_out: 'audio/mp4', duration_ms: Date.now() - _t0 });
            } else {
              _diag.log({ recording_id: Number(req.params.id), action: 'lazy_on_play', result: 'fail', bytes_in: total, mime_in: 'audio/3gpp', error_message: 'transcode returned null/empty (ffmpeg binary missing or threw)', duration_ms: Date.now() - _t0 });
            }
          }
        } catch (e) {
          console.warn('[/audio] lazy transcode skipped:', e.message);
        }
        // Recompute total against the (possibly transcoded) buffer
        // Sniff via guessAudioMime — covers .mp3/.wav/.ogg/.flac/.m4a/.amr
        // plus opus and 3gpp variants. Returns 'application/octet-stream'
        // only when neither magic bytes nor extension are recognised.
        const _tx0b = require('./utils/audioTranscode');
        let mime = _tx0b.guessAudioMime(null, buf);
        if (mime === 'application/octet-stream') mime = row.mime_type || 'audio/mp4';
        const codec_playable = _tx0b.isBrowserPlayable(mime);
        // Tell the SPA whether this is a codec the browser is likely
        // to decode. The audio element's onerror will check this and
        // surface a download-fallback message if false.
        res.setHeader('X-Audio-Browser-Playable', codec_playable ? '1' : '0');
        res.setHeader('X-Audio-Detected-Mime', mime);
        const _finalTotal = buf.length;
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (m) {
            let start = m[1] ? Number(m[1]) : 0;
            let end   = m[2] ? Number(m[2]) : _finalTotal - 1;
            if (Number.isNaN(start) || start < 0) start = 0;
            if (Number.isNaN(end) || end >= _finalTotal) end = _finalTotal - 1;
            if (start > end) { res.status(416).setHeader('Content-Range', 'bytes */' + _finalTotal); return res.end(); }
            const chunk = buf.slice(start, end + 1);
            res.status(206);
            res.setHeader('Content-Type', mime);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunk.length);
            res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + _finalTotal);
            res.setHeader('Cache-Control', 'private, max-age=60');
            return res.end(chunk);
          }
        }
        res.setHeader('Content-Type', mime);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', _finalTotal);
        res.setHeader('Cache-Control', 'private, max-age=60');
        return res.end(buf);
      } catch (e) {
        console.error('[/api/recordings/:id/audio] stream error:', e && e.stack || e);
        return res.status(500).json({ error: e && e.message ? e.message : String(e) });
      }
    });
});

// ---- Per-tenant DB injection ---------------------------------------
// After attachTenant runs, req.tenant + req.tenantPool are populated
// for any /t/<slug>/... request. Wrap the rest of the chain in
// AsyncLocalStorage.run so any /routes/* handler that calls
// db.query() / db.getAll() / etc. transparently uses the right
// per-tenant pg.Pool. Without this, the route files would silently
// hit the control DB (DATABASE_URL) and either crash or Ã¢ÂÂ worse Ã¢ÂÂ
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
  // Must have a resolved tenant Ã¢ÂÂ otherwise this isn't a tenant call
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

// ---- Tenant-scoped webhook routes ---------------------------------
// The bare /hook/* routes registered above (before attachTenant)
// handle root URLs like /hook/whatsapp_webhook hit directly by Meta
// or by the central PHP forwarder's slow-path fallback. Those bare
// routes never see /t/<slug>/ URLs because attachTenant runs after
// them and Express does not re-process routes after URL rewrites.
//
// These tenant-scoped registrations sit AFTER attachTenant + the
// tenantStorage middleware, so when the central forwarder dispatches
// to /t/<slug>/hook/whatsapp_webhook (the canonical URL each tenant
// registers in wa_connections.json), attachTenant strips the prefix,
// req.tenant is populated, and the handler runs inside the right
// tenant's pg.Pool — fast path, zero DB lookup.
//
// We delegate to the same per-route handler modules the bare routes
// use, so behaviour stays identical.
app.get('/hook/whatsapp_webhook', async (req, res, next) => {
  if (!req.tenant) return next();   // bare URL hit — let upstream 404 chain run
  // Verify GET — check this tenant's stored verify token.
  const token     = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  try {
    const hit = await req.tenantPool.query(
      `SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`
    );
    const cfg = hit.rows[0] && hit.rows[0].value;
    if (cfg && cfg === token) return res.type('text/plain').send(challenge);
  } catch (_) {}
  return res.status(403).send('Verify token mismatch');
});
// IVR_HOOK_TENANT_SCOPED_v1 — tenant-prefixed IVR webhook so the URL we
// surface to vendors (/t/<slug>/hook/ivr/<vendor>) actually matches a
// route. Mirrors the whatsapp_webhook pattern: bare URL handler is
// registered before attachTenant (above), tenant-scoped handler here
// runs AFTER attachTenant strips the /t/<slug>/ prefix.
app.post('/hook/ivr/:vendor', (req, res, next) => {
  if (!req.tenant) return next();
  let ivrMod;
  try { ivrMod = require('./routes/ivr'); }
  catch (e) { console.error('[hook/ivr] ivr module load failed:', e.message); return res.status(500).json({ error: 'IVR module unavailable' }); }
  return ivrMod.expressInbound(req, res);
});
app.post('/hook/whatsapp_webhook', (req, res, next) => {
  if (!req.tenant) return next();
  // CRITICAL: scope the handler in tenantStorage.run so _handleInbound's
  // db.tenantStorage.getStore() returns this tenant's slug. Without it,
  // tenantSlug ends up '' → ai_usage_log rows have empty slug →
  // super-admin AI Costing filter sees zero rows for the tenant.
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    () => whatsbotRoute.expressEvent(req, res)
  );
});
app.get('/hook/whatsapp', async (req, res, next) => {
  if (!req.tenant) return next();
  const token     = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  try {
    const hit = await req.tenantPool.query(
      `SELECT value FROM config WHERE key IN ('WA_VERIFY_TOKEN','WHATSAPP_VERIFY_TOKEN') LIMIT 1`
    );
    const cfg = hit.rows[0] && hit.rows[0].value;
    if (cfg && cfg === token) return res.type('text/plain').send(challenge);
  } catch (_) {}
  return res.status(403).send('Verify token mismatch');
});
app.post('/hook/whatsapp', (req, res, next) => {
  if (!req.tenant) return next();
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    () => webhooksRoute.whatsappEvent(req, res)
  );
});
app.post('/hook/meta', (req, res, next) => {
  if (!req.tenant) return next();
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    () => webhooksRoute.metaEvent(req, res)
  );
});


// ---- /api/sample.csv (tenant-scoped CSV download) -----------------
// The tenant SPA's bulk-upload page links to /api/sample.csv expecting
// a real CSV. Without an explicit handler here the request falls
// through to the JSON-404 catch-all below, which returned
//   {"error":"Not found: GET /api/sample.csv"}
// Ã¢ÂÂ and the browser saved that JSON as the "sample sheet". Mount the
// same handler the original Celeste server uses, but only inside a
// tenant scope so the custom-field columns come from THIS tenant's DB.
function _csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// ---------------------------------------------------------------
// SpreadsheetML 2003 helper Ã¢ÂÂ generates a single XML file Excel
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
  if (!req.tenant) return next();   // root-level call Ã¢ÂÂ fall through to JSON 404

  // Pull custom fields so the template includes every cf_<key> column
  // currently defined in this tenant's DB. Runs inside tenantStorage,
  // so tenantDb.getAll() picks up the right pool automatically.
  let customFields = [];
  try {
    customFields = (await tenantDb.getAll('custom_fields'))
      .filter(c => Number(c.is_active) !== 0 && c.key)
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0));
  } catch (_) { /* fresh tenant with no custom fields Ã¢ÂÂ ok */ }

  const baseCols = [
    // 1. Contact
    'name', 'phone', 'alt_phone', 'whatsapp', 'email',
    // 2. Routing Ã¢ÂÂ status / source / product accepted by NAME, assigned_to by email-or-name-or-id
    'status', 'source', 'source_ref', 'product', 'assigned_to',
    // 3. Address
    'address', 'city', 'state', 'pincode', 'country', 'company',
    // 4. Qualification
    'value', 'currency', 'qualified', 'tags',
    // 5. Activity
    'next_followup_at', 'notes',
    // 6. Migration timestamps Ã¢ÂÂ admins-only override; blank = "now"
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
      notes: 'Demo requested Ã¢ÂÂ interested in premium tier'
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
// Excel opens it as a true spreadsheet Ã¢ÂÂ so "import as text" step.
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
      notes: 'Sample row Ã¢ÂÂ replace with real data'
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

// ---- APK download (tenant-scoped) ------------------------------------
// GET /LeadCRM.apk is triggered by the WhatsBot "Download LeadCRM.apk"
// button in the Connect Account dialog.  After attachTenant rewrites
// /t/<slug>/LeadCRM.apk â /LeadCRM.apk the request lands here.
//
// Set APK_DOWNLOAD_URL in Railway environment variables to a direct-
// download link (Google Drive, S3, Cloudflare R2, etc.) and the button
// works immediately.  Fallback: place LeadCRM.apk in public/ (Git LFS).
app.get('/LeadCRM.apk', (req, res) => {
  const cdnUrl = process.env.APK_DOWNLOAD_URL;
  if (cdnUrl) return res.redirect(302, cdnUrl);
  const filePath = path.join(__dirname, 'public', 'LeadCRM.apk');
  res.download(filePath, 'LeadCRM.apk', (err) => {
    if (err && !res.headersSent) {
      res.status(503).type('html').send(
        '<h2>APK not available</h2>' +
        '<p>Set the <code>APK_DOWNLOAD_URL</code> environment variable in Railway ' +
        'to a direct-download link (Google Drive, S3, Cloudflare R2, etc.) so ' +
        'the <em>Download LeadCRM.apk</em> button on the WhatsBot page works.</p>'
      );
    }
  });
});

// APK_AUTO_UPDATE_v1 (2026-05-31): serve the version sidecar JSON so the
// in-app update banner can compare the installed APK build to the latest
// one CI just published. The file is written by build-android.yml.
app.get('/LeadCRM.apk.version.json', (req, res) => {
  const _fs = require('fs');
  const filePath = path.join(__dirname, 'public', 'LeadCRM.apk.version.json');
  if (!_fs.existsSync(filePath)) {
    return res.status(404).type('json').send({ error: 'version metadata not yet built' });
  }
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(filePath);
});

// ---- Tenant SPA shell ---------------------------------------------
// Serve the per-tenant CRM SPA. After attachTenant rewrites
// /t/<slug>/ to /, GET / lands here when there's a tenant on the
// request. Plain /<no-tenant> requests still go to the SaaS landing
// (handled by the earlier app.get('/') registration above).
app.get('/', (req, res, next) => {
  if (!req.tenant) return next();          // no tenant Ã¢ÂÂ fall through to landing/static
  // INDEX_NO_CACHE_v1 - force browsers to revalidate the SPA shell on
  // every request. Without this, browsers cached index.html and kept
  // loading the OLD app.js?v= reference even after we shipped new
  // versions, locking users on stale JS.
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'tenant', 'index.html'));
});

// Serve tenant static assets (app.js, styles.css, sw.js, manifests,
// icons) under any path inside the tenant scope. The tenant SPA
// references these as /app.js, /styles.css, etc., which after
// attachTenant rewrites becomes /app.js Ã¢ÂÂ served from public/tenant.
app.use((req, res, next) => {
  if (!req.tenant) return next();
  return express.static(path.join(__dirname, 'public', 'tenant'), _staticOpts)(req, res, next);
});

// IMPORTANT Ã¢ÂÂ keep the static handler scoped to /saas so it can ONLY
// serve assets from public/saas (the landing site + admin SPA). The
// previous setup mounted public/ at the root, which silently served
// the legacy Celeste SPA (public/index.html + public/app.js) when a
// tenant URL got rewritten. The tenant CRM then tried to fetch /api
// endpoints that don't exist on this server, got HTML 404 responses
// back, and crashed clients with "Unexpected token '<', '<!DOCTYPE'Ã¢ÂÂ¦
// is not valid JSON". The legacy files have now been removed from the
// repo, but we also keep the static handler narrow so the bug can't
// silently come back.

// Renders the tenant welcome / "not found" page. Pure HTML, no JS,
// no fetch Ã¢ÂÂ by design, so this surface can never produce a JSON
// parse error on the user's screen.
function _renderTenantPlaceholder(req, res, slug, tenant) {
  const safe = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  // Decode an admin-minted "Login as tenant" token (?ssl=Ã¢ÂÂ¦) if present
  // so we can show the operator who they're impersonating. The token
  // itself is short-lived (5 min) and signed with JWT_SECRET; here we
  // only verify it for display Ã¢ÂÂ Phase 2's tenant auth layer will be
  // the actual consumer.
  let ssl = null;
  if (req.query && req.query.ssl) {
    try {
      const jwt = require('jsonwebtoken');
      const payload = jwt.verify(String(req.query.ssl), process.env.JWT_SECRET || 'change-me-in-production');
      if (payload && payload.ssl && payload.slug === slug) ssl = payload;
    } catch (_) { /* expired or tampered Ã¢ÂÂ ignore, show normal page */ }
  }
  if (!tenant) {
    return res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Workspace not found - SmartCRM</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1rem;color:#0f172a}
.card{background:#fef2f2;border:1px solid #fecaca;padding:1.5rem;border-radius:12px;margin-bottom:1rem}
code{background:#fff;padding:.2rem .4rem;border-radius:4px}
a{color:#4338ca;text-decoration:none}
.btn{display:block;width:100%;padding:.85rem 1rem;border-radius:10px;border:none;cursor:pointer;font-size:1rem;font-weight:600;margin:.5rem 0;text-align:center}
.btn-primary{background:#6366f1;color:#fff}
.btn-ghost{background:#fff;color:#475569;border:1px solid #cbd5e1}</style>
<h1>Workspace not found</h1>
<div class="card">
  <p>The workspace <code>${safe(slug)}</code> doesn't exist or has been removed.</p>
</div>
<p style="color:#475569;margin-bottom:.4rem">Pick a different workspace, or go to the home page:</p>
<a href="/app?stay=1" class="btn btn-primary">Choose a different workspace</a>
<a href="/" class="btn btn-ghost">Back to SmartCRM home</a>
<script>
  // Clear the saved slug so the picker doesn't auto-redirect right back here.
  try { localStorage.removeItem('tenant_slug'); } catch (e) {}
  try { localStorage.removeItem('crm_token'); } catch (e) {}
  try { localStorage.removeItem('crm_user'); } catch (e) {}
</script>`);
  }
  const t = tenant;
  res.type('html').send(`<!doctype html><meta charset="utf-8"/>
<title>${safe(t.org_name)} Ã¢ÂÂ SmartCRM</title>
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
  <h2 style="color:#1e40af">Ã°ÂÂÂ Logged in as tenant (admin sudo)</h2>
  <p>You opened this workspace from the admin panel. The tenant CRM SPA isn't mounted yet, so this is the welcome placeholder Ã¢ÂÂ but the magic-link token is valid and Phase 2's tenant auth layer will consume it automatically.</p>
  <div class="row"><span class="lbl">Acting as</span> <code>${safe(ssl.as_email)}</code></div>
  <div class="row"><span class="lbl">Sudo by</span> <code>${safe(ssl.sa_email)}</code></div>
  <div class="row"><span class="lbl">Token expires</span> ${new Date(ssl.exp * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC</div>
</div>` : ''}
<h1>Ã°ÂÂÂ Welcome to ${safe(t.org_name)}</h1>
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
  <p>The full SmartCRM workspace UI (leads, calls, WhatsApp, reports) is in the next deployment phase Ã¢ÂÂ the per-tenant DB has been provisioned, but the SPA isn't mounted under <code>/t/&lt;slug&gt;</code> yet.</p>
  <p>If you're the platform admin you can manage this tenant from the <a href="/admin/#/tenants">SmartCRM admin panel</a>.</p>
</div>
<p style="color:#94a3b8;font-size:.85rem;margin-top:2rem">Need help? Email <a href="mailto:support@smartcrmsolution.com">support@smartcrmsolution.com</a></p>`);
}

// JSON-safe 404 for any unmatched API path under either /api or
// /t/<slug>/api. Anything that calls fetch() expecting JSON now gets
// clean JSON back even if the function name is wrong / the route
// doesn't exist Ã¢ÂÂ preventing the "Unexpected token '<', '<!DOCTYPE'Ã¢ÂÂ¦"
// crash that the legacy public/app.js was hitting earlier.
// ---- WhatsApp chat: media upload + media proxy ----
// /api/wa/upload  — multipart POST. Receives a file from the chat
//                   composer, forwards it to Meta Graph as a media
//                   asset, returns { wa_media_id, mime_type, filename }
//                   so the SPA can include media_id when sending.
// /api/wa/media/:msgId — GET. Streams the Meta-hosted inbound media
//                   bytes back to the browser. Solves the 'inbound
//                   image won't display' issue: the webhook only
//                   stores Meta's media_id; this endpoint resolves
//                   it to a fresh download URL per request and
//                   proxies the bytes through.
const _waUpload = _multer({
  storage: _multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }   // 100 MB ceiling
});
app.post('/api/wa/upload', _waUpload.single('file'), (req, res) => {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        const { authUser } = require('./utils/auth');
        const token = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        await authUser(token);
        if (!req.file) return res.status(400).json({ error: 'file required (multipart field "file")' });

        // Tenant WhatsApp creds. Falls back to default phone — Phase 2
        // multi-WA per-message phone selection happens in api_wb_chat_send,
        // not here at upload time. The same media_id works on any phone
        // belonging to the same WABA.
        const cfg = await require('./routes/whatsbot')._cfg();
        if (!cfg.token || !cfg.phoneId) {
          return res.status(400).json({ error: 'WhatsApp not configured (missing token or phone_number_id)' });
        }

        const fd = new FormData();
        fd.append('messaging_product', 'whatsapp');
        fd.append('type', req.file.mimetype || 'application/octet-stream');
        // Node 18+ Blob — fileFromBlob keeps the filename
        const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
        fd.append('file', blob, req.file.originalname || 'upload.bin');

        const r = await fetch('https://graph.facebook.com/v19.0/' + cfg.phoneId + '/media', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.token },
          body: fd
        });
        const j = await r.json();
        if (!r.ok || j.error) {
          const msg = (j.error && (j.error.message || j.error.error_user_msg)) || ('upload failed (HTTP ' + r.status + ')');
          return res.status(500).json({ error: 'Meta upload failed: ' + msg });
        }
        return res.json({
          wa_media_id: j.id,
          mime_type:   req.file.mimetype || '',
          filename:    req.file.originalname || '',
          // Local preview URL — not durable, just for the composer's
          // optimistic rendering before send.
          url: 'data:' + (req.file.mimetype || 'application/octet-stream') + ';base64,' +
                req.file.buffer.toString('base64')
        });
      } catch (e) {
        console.error('[/api/wa/upload] error:', e && e.message);
        return res.status(500).json({ error: e && e.message || 'upload failed' });
      }
    });
});

app.get('/api/wa/media/:msgId', async (req, res) => {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found' });
  const tenantDb = require('./db/pg');
  return tenantDb.tenantStorage.run({ pool: req.tenantPool, tenant: req.tenant, slug: req.tenantSlug },
    async () => {
      try {
        const { authUser } = require('./utils/auth');
        const token = (req.headers['x-auth-token'] || req.headers.authorization
                    || (req.query && req.query.token) || '').replace(/^Bearer\s+/i, '');
        await authUser(token);
        const msgId = Number(req.params.msgId);
        if (!msgId) return res.status(400).json({ error: 'msgId required' });

        const r = await tenantDb.query(
          `SELECT id, media_id, message_type FROM whatsapp_messages WHERE id = $1`, [msgId]);
        if (!r.rows.length) return res.status(404).json({ error: 'message not found' });
        const row = r.rows[0];
        if (!row.media_id) return res.status(404).json({ error: 'no media on this message' });

        const cfg = await require('./routes/whatsbot')._cfg();
        if (!cfg.token) return res.status(400).json({ error: 'WhatsApp token not configured' });

        // Step 1: resolve media_id → temporary URL + mime_type
        const meta = await fetch(
          'https://graph.facebook.com/v19.0/' + encodeURIComponent(row.media_id),
          { headers: { Authorization: 'Bearer ' + cfg.token } });
        const metaJson = await meta.json();
        if (!meta.ok || !metaJson.url) {
          return res.status(502).json({ error: 'Meta media lookup failed: ' + (metaJson.error?.message || meta.status) });
        }

        // Step 2: stream bytes from the temp URL
        const bin = await fetch(metaJson.url, { headers: { Authorization: 'Bearer ' + cfg.token } });
        if (!bin.ok) return res.status(502).json({ error: 'media fetch HTTP ' + bin.status });
        res.setHeader('Content-Type', metaJson.mime_type || bin.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=300');
        if (metaJson.file_size) res.setHeader('Content-Length', metaJson.file_size);
        const buf = Buffer.from(await bin.arrayBuffer());
        return res.end(buf);
      } catch (e) {
        console.error('[/api/wa/media] error:', e && e.message);
        return res.status(500).json({ error: e && e.message || 'media proxy failed' });
      }
    });
});

app.all(/^\/api(\/.*)?$/, (req, res) => {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.originalUrl });
});

// Static assets live ONLY under /saas (mounted earlier above). No
// catch-all express.static here Ã¢ÂÂ see comment block at the top of
// this section for the rationale.

// ---- Global error middleware (must be LAST) -------------------
// Anything a route handler throws or rejects ends up here. Logs to
// the error_logs table + returns 500 to the caller. The user asked
// us to capture every error in our project Ã¢ÂÂ this is the catch-all.
app.use(errorLogs.expressErrorMiddleware);

// Process-level safety net Ã¢ÂÂ node will keep running after these,
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
  console.log('[boot] migrating control planeÃ¢ÂÂ¦');
  await control.migrate();
  // First-boot seed + per-boot settings backfill. seed-once is fully
  // idempotent Ã¢ÂÂ it inserts the super-admin only if none exists, every
  // package only if the row is missing by name, and every default
  // setting only if that key isn't already in saas_settings. Running it
  // every boot is safe and means new platform-default settings (e.g.
  // SMTP defaults added in a later release) auto-apply on next deploy.
  try {
    await require('./control/seed-once')();
  } catch (e) {
    console.warn('[boot] auto-seed skipped:', e.message);
  }

// ── Lead-source & Google Sheet webhook endpoints ────────────────────────────
// INDIAMART_WEBHOOK_v1 (2026-05-28): always log every hit on /hook/leadsource/*
// to control.error_logs BEFORE auth/tenant routing so we can debug 401s
// and wrong-URL pokes. IndiaMart in particular sometimes calls the URL
// with GET during their "Test" verification — we now answer those with
// a friendly 200 OK so the test passes while still logging the visit.
app.get('/hook/leadsource/:source/:key', (req, res) => {
  try {
    errorLogs.logError({
      source: 'leadsource-ping',
      severity: 'info',
      message: 'GET ping on /hook/leadsource/' + req.params.source + ' (test/verification)',
      stack: 'method=GET key=' + String(req.params.key || '').slice(0, 4) + '... ua=' + (req.get('user-agent') || '').slice(0, 80)
    }).catch(() => {});
  } catch (_) {}
  return res.json({ ok: true, msg: 'leadsource endpoint reachable. Send a POST with JSON body to push leads.', source: req.params.source });
});

app.post('/hook/leadsource/:source/:key', (req, res) => {
  // INDIAMART_WEBHOOK_v1 — always log the incoming POST attempt FIRST so
  // even a wrong-key 401 leaves a breadcrumb the super-admin can see.
  try {
    const keyShown = String(req.params.key || '').slice(0, 4) + '...' + String(req.params.key || '').slice(-4);
    const bodyPreview = JSON.stringify(req.body || {}).slice(0, 800);
    errorLogs.logError({
      source: 'leadsource-attempt',
      severity: 'info',
      message: 'POST /hook/leadsource/' + req.params.source + ' key=' + keyShown,
      stack: 'body=' + bodyPreview + ' ua=' + (req.get('user-agent') || '').slice(0, 80) + ' ip=' + (req.ip || '')
    }).catch(() => {});
  } catch (_) {}

  req.body.api_key = req.params.key;
  req.body._hookSource = req.params.source;
  // Pass the actual handler function — earlier code passed `next` and
  // a string, which made _runAsTenant try to invoke a string as a
  // function and fall through to Express's default HTML 500 page.
  _runHookAsTenant(req, res, integrations.leadSourceWebhook);
});

app.post('/hook/sheet/:token', async (req, res) => {
  /* SHEET_SYNC_v3 HOTFIX — the previous code called _runHookAsTenant which
   * authenticates via config.WEBSITE_API_KEY. Sheet integration tokens
   * (sht_xxx) live in tenant.sheet_integrations.webhook_token instead,
   * so every Apps Script POST was returning 401 'Invalid API key' and
   * no leads ever arrived. Resolve the tenant by scanning that table. */
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ error: 'missing token' });
  req.body = req.body || {};
  req.body.api_key = token;
  const t = await _findTenantByLookup(
    'SELECT 1 FROM sheet_integrations WHERE webhook_token = $1 LIMIT 1',
    [token]
  ).catch(() => null);
  if (!t) return res.status(404).json({ error: 'Unknown sheet webhook token — re-copy the URL from the CRM' });
  return _runAsTenant(t.slug, req, res, integrations.sheetPushWebhook);
});

// Background: run sheet syncs and native pulls every 5 minutes
setInterval(() => {
  try { integrations.runDueSheetSyncs(); } catch(e) { console.error('[bg] sheet sync error:', e.message); }
  try { integrations.runDueNativePulls(); } catch(e) { console.error('[bg] native pull error:', e.message); }
}, 5 * 60 * 1000);

// ── Background: per-tenant follow-up reminder runner ────────────────────
// utils/reminders.js was wired into server.tenant.js but never called from
// the multi-tenant SaaS server, so smartcrm-saas tenants got NO follow-up
// reminders at all. Walk every active tenant once a minute and run the
// reminder pass inside that tenant's storage scope so push notifications
// fire for due/upcoming follow-ups.
async function _runReminderForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[reminders] tenant list failed:', e.message); return; }
  const reminders = require('./utils/reminders');
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => reminders._runOnce()
      );
    } catch (e) { console.warn(`[reminders] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runReminderForAllTenants().catch(e => console.error('[reminders] cycle failed:', e.message));
}, Number(process.env.REMINDER_INTERVAL_MS || 60_000));
// Initial run after boot settles
setTimeout(() => _runReminderForAllTenants().catch(() => {}), 15_000);
console.log('[reminders] SaaS-aware follow-up scheduler started');
// ── Background: per-tenant AI re-engagement worker ───────────────────────
// Walks every active tenant and sends scheduled soft-follow-up pings the
// AI bot has queued (when a customer goes silent after a bot reply).
async function _runReengageForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[reengage] tenant list failed:', e.message); return; }
  let aiBot;
  try { aiBot = require('./routes/aiBot'); } catch (e) { return; }
  if (!aiBot._reengageTick) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => aiBot._reengageTick()
      );
    } catch (e) { console.warn(`[reengage] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runReengageForAllTenants().catch(e => console.error('[reengage] cycle failed:', e.message));
}, Number(process.env.REENGAGE_INTERVAL_MS || 60_000));
setTimeout(() => _runReengageForAllTenants().catch(() => {}), 30_000);
console.log('[reengage] AI bot re-engagement worker started');

// ── GOOGLE_CONV_EXPORT_v2 — daily auto-export per tenant at 22:00 IST ──
// Walks every active tenant once a minute. Each tenant's tick decides
// whether to fire (IST hour matches + not already fired today + feature
// is ON). The CSV is written to disk + served by the public route.
async function _runGoogleConvForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[gconv] tenant list failed:', e.message); return; }
  let gconv;
  try { gconv = require('./routes/googleConvExport'); } catch (e) { return; }
  if (!gconv._maybeDailyTickForCurrentTenant) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => gconv._maybeDailyTickForCurrentTenant(row.slug)
      );
    } catch (e) { console.warn(`[gconv] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runGoogleConvForAllTenants().catch(e => console.error('[gconv] cycle failed:', e.message));
}, 60_000);
setTimeout(() => _runGoogleConvForAllTenants().catch(() => {}), 60_000);
console.log('[gconv] Google Ads conversion export daily worker started');

// ── WL_BILLING_CRON_v1 — daily auto-bill at 9am IST ──
// Runs once at 9:00 IST. Generates invoices for every active customer
// whose billing_day == today's day-of-month, then auto-sends the invoice
// via WhatsApp (uses WL_WA_PHONE_NUMBER_ID + WL_WA_ACCESS_TOKEN).
// Single-fire guard: tracks last-fired-day in-memory so a process that
// stays up through 9am only fires once. A restart after 9am won't re-fire
// because generateMonth is idempotent (skips if invoice exists for the
// current period_month).
let _wlBillingLastFiredYMD = null;
async function _maybeRunWLBillingCron() {
  try {
    const ist = new Date(Date.now() + 5.5 * 3600e3);
    const ymd = ist.toISOString().slice(0, 10);
    const hourIST = ist.getUTCHours();
    if (hourIST !== 9) return;
    if (_wlBillingLastFiredYMD === ymd) return;
    let wl; try { wl = require('./routes/saas/whiteLabelBilling'); } catch (e) { return; }
    if (typeof wl._runBillingForToday !== 'function') return;
    _wlBillingLastFiredYMD = ymd;
    const out = await wl._runBillingForToday({});
    console.log('[wl-billing-cron] fired @09 IST — due_today=' + out.due_today +
                ' generated=' + (out.generated || []).length +
                ' sent=' + (out.sent || []).length +
                (out.errors && out.errors.length ? ' errors=' + out.errors.length : ''));
  } catch (e) { console.warn('[wl-billing-cron]', e.message); }
}
setInterval(_maybeRunWLBillingCron, 5 * 60 * 1000);  // every 5 min
setTimeout(_maybeRunWLBillingCron, 60_000);
console.log('[wl-billing-cron] WL Billing daily worker started (fires 9am IST)');

// ── META_CAPI_v1 — daily 10pm IST per-tenant Meta Conversions API tick ──
// Mirrors the Google CSV path. Each tenant tick decides whether to fire
// (IST hour=22 + not already today + feature is ON). Real-time dispatch
// already runs via routes/leads.js status-change hook — this catches any
// events the real-time path missed (network errors, server restarts).
async function _runMetaCapiForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[meta-capi] tenant list failed:', e.message); return; }
  let mcapi;
  try { mcapi = require('./routes/metaConvExport'); } catch (e) { return; }
  if (!mcapi._maybeDailyTickForCurrentTenant) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => mcapi._maybeDailyTickForCurrentTenant(row.slug)
      );
    } catch (e) { console.warn(`[meta-capi] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runMetaCapiForAllTenants().catch(e => console.error('[meta-capi] cycle failed:', e.message));
}, 60_000);
setTimeout(() => _runMetaCapiForAllTenants().catch(() => {}), 90_000);
console.log('[meta-capi] Meta Conversions API daily worker started');

// ── Background: per-tenant Nurture sequence worker ──────────────────────
// Picks up nurture_step_runs that are due and dispatches them via the
// channel-appropriate send path (WA template / email / AI bot). Exit
// conditions (customer reply, status change) are evaluated per step.
async function _runNurtureForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[nurture] tenant list failed:', e.message); return; }
  let nurtureWorker;
  try { nurtureWorker = require('./utils/nurtureWorker'); } catch (e) { return; }
  if (!nurtureWorker.tick) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => nurtureWorker.tick()
      );
    } catch (e) { console.warn(`[nurture] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runNurtureForAllTenants().catch(e => console.error('[nurture] cycle failed:', e.message));
}, Number(process.env.NURTURE_INTERVAL_MS || 5 * 60_000));
setTimeout(() => _runNurtureForAllTenants().catch(() => {}), 45_000);
console.log('[nurture] sequence worker started');

// ── Background: per-tenant Education fee-reminder worker ────────────────
// Runs hourly. For tenants with the Education pack active, picks up
// installments due in 15 / 7 / 1 / 0 days and sends one reminder each
// via WhatsApp (preferred) or email. Idempotent — never reminds twice
// for the same bucket.
async function _runEduRemindersForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[eduReminder] tenant list failed:', e.message); return; }
  let worker;
  try { worker = require('./utils/eduReminderWorker'); } catch (e) { return; }
  if (!worker.tick) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => worker.tick()
      );
    } catch (e) { console.warn(`[eduReminder] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runEduRemindersForAllTenants().catch(e => console.error('[eduReminder] cycle failed:', e.message));
}, Number(process.env.EDU_REMINDER_INTERVAL_MS || 60 * 60_000));   // hourly
setTimeout(() => _runEduRemindersForAllTenants().catch(() => {}), 90_000);
console.log('[eduReminder] worker started — hourly tick');

// ── Background: per-tenant Real Estate demand-letter reminder worker ──
async function _runReRemindersForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[reReminder] tenant list failed:', e.message); return; }
  let worker;
  try { worker = require('./utils/reReminderWorker'); } catch (e) { return; }
  if (!worker || !worker.tick) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => worker.tick()
      );
    } catch (e) { console.warn(`[reReminder] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runReRemindersForAllTenants().catch(e => console.error('[reReminder] cycle failed:', e.message));
}, Number(process.env.RE_REMINDER_INTERVAL_MS || 60 * 60_000));   // hourly
setTimeout(() => _runReRemindersForAllTenants().catch(() => {}), 120_000);
console.log('[reReminder] Real Estate demand-letter worker started — hourly tick');


// ── COMPLIANCE_v1 — daily violation scan ───────────────────────────────
// Every tenant gets a compliance.runDailyScan() once per hour. Cheap if
// no rules are enabled (early-exit), otherwise sweeps all daily-flagged
// rules (np_min_dials, idle_in_stage, min_daily_activity) and writes to
// compliance_violations. The real-time rules (followup_requires_call)
// fire from routes/leads.js so don't need the scheduler.
async function _runComplianceScanForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[compliance] tenant list failed:', e.message); return; }
  let compliance;
  try { compliance = require('./routes/compliance'); } catch (_) { return; }
  if (!compliance || !compliance.runDailyScan) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug }, async () => {
        const r = await compliance.runDailyScan();
        if (r && Number(r.violations_logged) > 0) {
          console.log('[compliance] ' + row.slug + ': ' + r.violations_logged + ' violations from ' + r.rules_run + ' rules');
        }
      });
    } catch (e) { console.warn('[compliance] ' + row.slug + ' scan failed:', e.message); }
  }
}
setInterval(() => {
  _runComplianceScanForAllTenants().catch(e => console.error('[compliance] cycle failed:', e.message));
}, Number(process.env.COMPLIANCE_INTERVAL_MS || 60 * 60_000));   // hourly
setTimeout(() => _runComplianceScanForAllTenants().catch(() => {}), 180_000);
console.log('[compliance] daily violation scan worker started — hourly tick');


// ── REPORT_SCHEDULE_v1 — scheduled-report dispatcher (per-tenant, hourly) ──
// Walks tenants once per hour. For each, picks up report_schedules whose
// next_run_at <= NOW, runs the saved report, sends to email + WhatsApp
// recipients, advances next_run_at by frequency.
async function _runScheduledReportsForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[reportSchedule] tenant list failed:', e.message); return; }
  let mod;
  try { mod = require('./routes/reportTemplates'); } catch (_) { return; }
  if (!mod || !mod.tickScheduledReports) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug }, async () => {
        const r = await mod.tickScheduledReports();
        if (r && r.ran > 0) console.log('[reportSchedule] ' + row.slug + ': ran ' + r.ran + ' schedules');
      });
    } catch (e) { console.warn('[reportSchedule] ' + row.slug + ' tick failed:', e.message); }
  }
}
setInterval(() => {
  _runScheduledReportsForAllTenants().catch(e => console.error('[reportSchedule] cycle failed:', e.message));
}, Number(process.env.REPORT_SCHEDULE_INTERVAL_MS || 15 * 60_000));   // every 15 min
setTimeout(() => _runScheduledReportsForAllTenants().catch(() => {}), 240_000);
console.log('[reportSchedule] scheduled-report dispatcher started — 15-min tick');


// ── Background: per-tenant AI Call Summary worker ──────────────────────
// aiCallSummary.startWorker() is only wired in server.tenant.js. Without
// this, SaaS-tenant recordings never get auto-processed by Gemini — they
// stay at ai_processed_at = NULL until a user clicks the manual ↻ Retry
// button. Walk every active tenant once a minute and run _tick() inside
// that tenant's storage scope so the existing 'WHERE ai_processed_at IS
// NULL LIMIT 5' query runs against per-tenant DB pools.
// 🔒 LOCKED — AI Call Summary worker. Respects per-tenant
// AI_TRANSCRIPTION_ENABLED config (see processRecording in
// utils/aiCallSummary.js). Ask before modifying the schedule.

async function _runAiCallSummaryForAllTenants() {
  let rows = [];
  try {
    const r = await controlDb.query(
      `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500`
    );
    rows = r.rows;
  } catch (e) { console.warn('[ai-summary] tenant list failed:', e.message); return; }
  let aiSummary;
  try { aiSummary = require('./utils/aiCallSummary'); } catch (_) { return; }
  if (!aiSummary._tick) return;
  for (const row of rows) {
    let t; try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) continue;
    try {
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug },
        () => aiSummary._tick()
      );
    } catch (e) { console.warn(`[ai-summary] ${row.slug} tick failed:`, e.message); }
  }
}
setInterval(() => {
  _runAiCallSummaryForAllTenants().catch(e => console.error('[ai-summary] cycle failed:', e.message));
}, Number(process.env.AI_CALL_SUMMARY_INTERVAL_MS || 60_000));
// Initial pass 45s after boot to let the AI key + DB pools warm up.
setTimeout(() => _runAiCallSummaryForAllTenants().catch(() => {}), 45_000);
console.log('[ai-summary] SaaS-aware Gemini call-summary worker started');




// REC_CALLEVENT_TIME_FIX_v1 — one-shot backfill: any historical
// call_events.created_at that was stamped at upload time gets rewritten
// to the recording's actual started_at. Gated by a control-DB flag so
// it runs ONCE across deploys. The UPDATE itself is idempotent (only
// touches rows where the gap exceeds 60s) so re-runs are safe; the
// flag is just to avoid the wasted scan on every boot.
async function _runCallEventTimeBackfill() {
  try {
    const ranAlready = await controlDb.query(
      "SELECT 1 FROM saas_flags WHERE key = 'rec_callevent_time_backfill_v1' LIMIT 1"
    ).catch(() => ({ rows: [] }));
    if (ranAlready.rows && ranAlready.rows.length) {
      console.log('[rec-callevent-backfill] already ran on a prior boot — skipping');
      return;
    }
    // Ensure flags table exists (rare on fresh installs).
    try {
      await controlDb.query(
        'CREATE TABLE IF NOT EXISTS saas_flags (key TEXT PRIMARY KEY, value TEXT, ran_at TIMESTAMPTZ DEFAULT NOW())'
      );
    } catch (_) {}
    const r = await controlDb.query(
      "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500"
    );
    const slugs = r.rows.map(x => x.slug);
    console.log('[rec-callevent-backfill] starting — ' + slugs.length + ' tenants');
    let totalUpdated = 0, totalTenants = 0;
    for (const slug of slugs) {
      let t; try { t = await tenantPoolMod.findActiveTenant(slug); } catch (_) { continue; }
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      try {
        const u = await pool.query(`
          UPDATE call_events ce
             SET created_at = lr.started_at
            FROM lead_recordings lr
           WHERE ce.recording_id = lr.id
             AND ce.event = 'recording_saved'
             AND lr.started_at IS NOT NULL
             AND lr.started_at < ce.created_at - INTERVAL '60 seconds'
        `);
        const n = u.rowCount || 0;
        if (n > 0) {
          console.log('[rec-callevent-backfill] ' + slug + ' — updated ' + n + ' rows');
          totalUpdated += n;
        }
        totalTenants++;
      } catch (e) {
        console.warn('[rec-callevent-backfill] ' + slug + ' failed: ' + e.message);
      }
    }
    console.log('[rec-callevent-backfill] done — ' + totalUpdated + ' rows updated across ' + totalTenants + ' tenants');
    try {
      await controlDb.query(
        "INSERT INTO saas_flags (key, value) VALUES ('rec_callevent_time_backfill_v1', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({ tenants: totalTenants, rows: totalUpdated })]
      );
    } catch (_) {}
  } catch (e) {
    console.error('[rec-callevent-backfill] failed:', e.message);
  }
}
// Run 90s after boot so per-tenant pools have warmed up.
setTimeout(() => _runCallEventTimeBackfill().catch(() => {}), 90_000);

// REC_DIRECTION_BACKFILL_v1 (2026-06-04) — flip historical recording_saved
// rows that were defaulted to direction='out' but should have been 'in'.
// Criterion: a paired incoming_ringing exists for the same user+phone
// within ±10 min of the recording_saved row. Only affects the last 7 days
// of data per tenant to keep the scan bounded and conservative.
// Idempotent: re-running only flips rows that still match the criterion;
// once flipped to 'in', they won't match the WHERE clause again.
async function _runRecordingDirectionBackfill() {
  try {
    const ranAlready = await controlDb.query(
      "SELECT 1 FROM saas_flags WHERE key = 'rec_direction_backfill_v1' LIMIT 1"
    ).catch(() => ({ rows: [] }));
    if (ranAlready.rows && ranAlready.rows.length) {
      console.log('[rec-direction-backfill] already ran on a prior boot — skipping');
      return;
    }
    try {
      await controlDb.query(
        'CREATE TABLE IF NOT EXISTS saas_flags (key TEXT PRIMARY KEY, value TEXT, ran_at TIMESTAMPTZ DEFAULT NOW())'
      );
    } catch (_) {}
    const r = await controlDb.query(
      "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500"
    );
    const slugs = r.rows.map(x => x.slug);
    console.log('[rec-direction-backfill] starting — ' + slugs.length + ' tenants');
    let totalUpdated = 0, totalTenants = 0;
    for (const slug of slugs) {
      let t; try { t = await tenantPoolMod.findActiveTenant(slug); } catch (_) { continue; }
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      try {
        const u = await pool.query(`
          UPDATE call_events ce
             SET direction = 'in'
           WHERE ce.event = 'recording_saved'
             AND ce.direction = 'out'
             AND ce.created_at >= NOW() - INTERVAL '7 days'
             AND EXISTS (
               SELECT 1 FROM call_events ce2
                WHERE ce2.user_id = ce.user_id
                  AND ce2.phone   = ce.phone
                  AND ce2.event   = 'incoming_ringing'
                  AND ce2.direction = 'in'
                  AND ce2.created_at BETWEEN ce.created_at - INTERVAL '10 minutes'
                                         AND ce.created_at + INTERVAL '2 minutes'
             )
        `);
        const n = u.rowCount || 0;
        if (n > 0) {
          console.log('[rec-direction-backfill] ' + slug + ' — flipped ' + n + ' rows to direction=in');
          totalUpdated += n;
        }
        totalTenants++;
      } catch (e) {
        console.warn('[rec-direction-backfill] ' + slug + ' failed: ' + e.message);
      }
    }
    console.log('[rec-direction-backfill] done — ' + totalUpdated + ' rows flipped across ' + totalTenants + ' tenants');
    try {
      await controlDb.query(
        "INSERT INTO saas_flags (key, value) VALUES ('rec_direction_backfill_v1', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({ tenants: totalTenants, rows: totalUpdated })]
      );
    } catch (_) {}
  } catch (e) {
    console.error('[rec-direction-backfill] failed:', e.message);
  }
}
// Run 120s after boot — 30s after the call-event time backfill, so they
// don't contend for tenant pools.
setTimeout(() => _runRecordingDirectionBackfill().catch(() => {}), 120_000);

// CALL_TODAY_CLEANUP_v1 (2026-06-04) — hard-clean today's call_events
// (last 24h) across every tenant. The read-time dedup SQL handles new
// data correctly, but historical rows from BEFORE the dedup landed are
// still polluting Call Activity feeds (especially on tenants like
// learnimo and vserve where calls are frequent). This task physically
// removes the noise rows so reports + recent-calls feed agree exactly.
//
// Steps per tenant pool (all bounded to ce.created_at >= NOW() - 24h):
//   1. Delete duplicate call_events posted by the dual-bridge —
//      same (user_id, phone, event) within 12s of an earlier row.
//      Keep the earliest, drop the later siblings.
//   2. Delete orphan incoming_ringing rows that have a paired
//      call_ended (within 10 min) OR recording_saved (within
//      -2 min to +30 min). The pairing event represents the call;
//      the RINGING is redundant.
//   3. Flip call_ended direction='out' → 'in' when a paired
//      incoming_ringing (direction='in') exists in the prior 10 min.
//      Same defaulting bug as recording_saved had.
//   4. Belt-and-braces: re-run the recording_saved direction flip.
async function _runCallTodayCleanup() {
  try {
    const ranAlready = await controlDb.query(
      "SELECT 1 FROM saas_flags WHERE key = 'call_today_cleanup_v1' LIMIT 1"
    ).catch(() => ({ rows: [] }));
    if (ranAlready.rows && ranAlready.rows.length) {
      console.log('[call-today-cleanup] already ran on a prior boot — skipping');
      return;
    }
    try {
      await controlDb.query(
        'CREATE TABLE IF NOT EXISTS saas_flags (key TEXT PRIMARY KEY, value TEXT, ran_at TIMESTAMPTZ DEFAULT NOW())'
      );
    } catch (_) {}
    const r = await controlDb.query(
      "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500"
    );
    const slugs = r.rows.map(x => x.slug);
    console.log('[call-today-cleanup] starting — ' + slugs.length + ' tenants');
    let totalDupDeleted = 0, totalRingDeleted = 0, totalCallEndedFlipped = 0, totalRecFlipped = 0, totalTenants = 0;
    for (const slug of slugs) {
      let t; try { t = await tenantPoolMod.findActiveTenant(slug); } catch (_) { continue; }
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      let dupN = 0, ringN = 0, ceFlipN = 0, recFlipN = 0;
      try {
        // Step 1: dedup dual-bridge duplicates
        const d1 = await pool.query(`
          WITH dups AS (
            SELECT ce.id
              FROM call_events ce
              JOIN call_events ce_earlier
                ON ce_earlier.user_id = ce.user_id
               AND ce_earlier.phone   = ce.phone
               AND ce_earlier.event   = ce.event
               AND ce_earlier.id      < ce.id
               AND ce_earlier.created_at >= ce.created_at - INTERVAL '12 seconds'
             WHERE ce.created_at >= NOW() - INTERVAL '24 hours'
          )
          DELETE FROM call_events WHERE id IN (SELECT id FROM dups)
        `);
        dupN = d1.rowCount || 0;

        // Step 2: delete orphan incoming_ringing rows paired with call_ended OR recording_saved
        const d2 = await pool.query(`
          DELETE FROM call_events ce
           WHERE ce.event = 'incoming_ringing'
             AND ce.created_at >= NOW() - INTERVAL '24 hours'
             AND (
               EXISTS (
                 SELECT 1 FROM call_events ce2
                  WHERE ce2.user_id = ce.user_id
                    AND ce2.phone   = ce.phone
                    AND ce2.event   = 'call_ended'
                    AND ce2.created_at BETWEEN ce.created_at AND ce.created_at + INTERVAL '10 minutes'
               )
               OR EXISTS (
                 SELECT 1 FROM call_events ce3
                  WHERE ce3.user_id = ce.user_id
                    AND ce3.phone   = ce.phone
                    AND ce3.event   = 'recording_saved'
                    AND ce3.created_at BETWEEN ce.created_at - INTERVAL '2 minutes'
                                           AND ce.created_at + INTERVAL '30 minutes'
               )
             )
        `);
        ringN = d2.rowCount || 0;

        // Step 3: flip call_ended direction
        const u3 = await pool.query(`
          UPDATE call_events ce
             SET direction = 'in'
           WHERE ce.event = 'call_ended'
             AND ce.direction = 'out'
             AND ce.created_at >= NOW() - INTERVAL '24 hours'
             AND EXISTS (
               SELECT 1 FROM call_events ce2
                WHERE ce2.user_id = ce.user_id
                  AND ce2.phone   = ce.phone
                  AND ce2.event   = 'incoming_ringing'
                  AND ce2.direction = 'in'
                  AND ce2.created_at BETWEEN ce.created_at - INTERVAL '10 minutes'
                                         AND ce.created_at + INTERVAL '2 minutes'
             )
        `);
        ceFlipN = u3.rowCount || 0;

        // Step 4: flip recording_saved direction (belt-and-braces in case the prior backfill missed any)
        const u4 = await pool.query(`
          UPDATE call_events ce
             SET direction = 'in'
           WHERE ce.event = 'recording_saved'
             AND ce.direction = 'out'
             AND ce.created_at >= NOW() - INTERVAL '24 hours'
             AND EXISTS (
               SELECT 1 FROM call_events ce2
                WHERE ce2.user_id = ce.user_id
                  AND ce2.phone   = ce.phone
                  AND ce2.event   = 'incoming_ringing'
                  AND ce2.direction = 'in'
                  AND ce2.created_at BETWEEN ce.created_at - INTERVAL '10 minutes'
                                         AND ce.created_at + INTERVAL '2 minutes'
             )
        `);
        recFlipN = u4.rowCount || 0;

        if (dupN || ringN || ceFlipN || recFlipN) {
          console.log('[call-today-cleanup] ' + slug + ' — dup-del:' + dupN
            + ' ring-del:' + ringN + ' ce-flip:' + ceFlipN + ' rec-flip:' + recFlipN);
          totalDupDeleted += dupN; totalRingDeleted += ringN;
          totalCallEndedFlipped += ceFlipN; totalRecFlipped += recFlipN;
        }
        totalTenants++;
      } catch (e) {
        console.warn('[call-today-cleanup] ' + slug + ' failed: ' + e.message);
      }
    }
    console.log('[call-today-cleanup] done — '
      + totalDupDeleted + ' dups, '
      + totalRingDeleted + ' orphan rings, '
      + totalCallEndedFlipped + ' call_ended flipped, '
      + totalRecFlipped + ' recording_saved flipped across '
      + totalTenants + ' tenants');
    try {
      await controlDb.query(
        "INSERT INTO saas_flags (key, value) VALUES ('call_today_cleanup_v1', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({
          tenants: totalTenants,
          dups_deleted: totalDupDeleted,
          rings_deleted: totalRingDeleted,
          ce_flipped: totalCallEndedFlipped,
          rec_flipped: totalRecFlipped
        })]
      );
    } catch (_) {}
  } catch (e) {
    console.error('[call-today-cleanup] failed:', e.message);
  }
}
// Run 180s after boot — after the other two backfills so we don't
// contend for tenant pools and so this runs AFTER REC_DIRECTION_BACKFILL_v1
// has already done the 7-day window. This step is the surgical 24h pass.
setTimeout(() => _runCallTodayCleanup().catch(() => {}), 180_000);

// CALL_HISTORY_BURST_DELETE_v1 (2026-06-04) — APK CallLog bulk import
// (CALL_HISTORY_SYNC_v2) posted historical entries with created_at=NOW(),
// so any one tenant ends up with many different phones stamped at the
// exact same second. The user's screenshot showed 9 calls all at one
// 10:19:32 am moment on learnimo, with mixed directions and 8 of 9
// having no duration — classic bulk-import artifact.
// This pass deletes burst clusters from the last 7 days, defined as:
//   any (user_id, created_at down-to-second) group containing >= 5
//   different phone numbers. That signature is impossible for real-time
//   call posting (no human dials 5 distinct numbers in one second).
async function _runCallHistoryBurstDelete() {
  try {
    const ranAlready = await controlDb.query(
      "SELECT 1 FROM saas_flags WHERE key = 'call_history_burst_delete_v1' LIMIT 1"
    ).catch(() => ({ rows: [] }));
    if (ranAlready.rows && ranAlready.rows.length) {
      console.log('[call-history-burst-delete] already ran on a prior boot — skipping');
      return;
    }
    try {
      await controlDb.query(
        'CREATE TABLE IF NOT EXISTS saas_flags (key TEXT PRIMARY KEY, value TEXT, ran_at TIMESTAMPTZ DEFAULT NOW())'
      );
    } catch (_) {}
    const r = await controlDb.query(
      "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500"
    );
    const slugs = r.rows.map(x => x.slug);
    console.log('[call-history-burst-delete] starting — ' + slugs.length + ' tenants');
    let totalDeleted = 0, totalTenants = 0;
    for (const slug of slugs) {
      let t; try { t = await tenantPoolMod.findActiveTenant(slug); } catch (_) { continue; }
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      try {
        const u = await pool.query(`
          WITH bursts AS (
            SELECT user_id, date_trunc('second', created_at) AS ts
              FROM call_events
             WHERE created_at >= NOW() - INTERVAL '7 days'
             GROUP BY user_id, date_trunc('second', created_at)
            HAVING COUNT(DISTINCT phone) >= 5
          )
          DELETE FROM call_events ce
           WHERE ce.created_at >= NOW() - INTERVAL '7 days'
             AND EXISTS (
               SELECT 1 FROM bursts b
                WHERE b.user_id = ce.user_id
                  AND b.ts = date_trunc('second', ce.created_at)
             )
             -- Keep rows that have an attached recording — those represent
             -- real talk time and shouldn't be wiped by a burst-detector.
             AND ce.recording_id IS NULL
        `);
        const n = u.rowCount || 0;
        if (n > 0) {
          console.log('[call-history-burst-delete] ' + slug + ' — deleted ' + n + ' burst rows');
          totalDeleted += n;
        }
        totalTenants++;
      } catch (e) {
        console.warn('[call-history-burst-delete] ' + slug + ' failed: ' + e.message);
      }
    }
    console.log('[call-history-burst-delete] done — ' + totalDeleted + ' rows across ' + totalTenants + ' tenants');
    try {
      await controlDb.query(
        "INSERT INTO saas_flags (key, value) VALUES ('call_history_burst_delete_v1', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify({ tenants: totalTenants, rows: totalDeleted })]
      );
    } catch (_) {}
  } catch (e) {
    console.error('[call-history-burst-delete] failed:', e.message);
  }
}
setTimeout(() => _runCallHistoryBurstDelete().catch(() => {}), 240_000);

// CALL_LAST48H_CLEANUP_v1 (2026-06-04) — re-run every cleanup step with
// a 48-hour window to catch YESTERDAY's data (the original 24h pass
// missed cross-midnight rows on tenants like learnimo and vserve where
// the user did test calls before the cutoff).
//
// All six steps in one pass, ordered so each step is safe even if a
// prior step already ran via the older one-shot tasks:
//   1. Backfill call_events.created_at from lead_recordings.started_at
//      where the gap is >60s (covers recording_saved + the new 'at' path).
//   2. Burst delete (>=5 distinct phones at same created_at second).
//   3. Delete duplicate dual-bridge posts (same user+phone+event in 12s).
//   4. Delete orphan incoming_ringing rows paired with call_ended OR
//      recording_saved.
//   5. Flip call_ended direction 'out' → 'in' when paired RINGING exists.
//   6. Flip recording_saved direction 'out' → 'in' when paired RINGING.
async function _runCallLast48hCleanup() {
  try {
    const ranAlready = await controlDb.query(
      "SELECT 1 FROM saas_flags WHERE key = 'call_last48h_cleanup_v1' LIMIT 1"
    ).catch(() => ({ rows: [] }));
    if (ranAlready.rows && ranAlready.rows.length) {
      console.log('[call-48h-cleanup] already ran on a prior boot — skipping');
      return;
    }
    try {
      await controlDb.query(
        'CREATE TABLE IF NOT EXISTS saas_flags (key TEXT PRIMARY KEY, value TEXT, ran_at TIMESTAMPTZ DEFAULT NOW())'
      );
    } catch (_) {}
    const r = await controlDb.query(
      "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 500"
    );
    const slugs = r.rows.map(x => x.slug);
    console.log('[call-48h-cleanup] starting — ' + slugs.length + ' tenants');
    let totals = { tenants: 0, time_fixed: 0, burst_del: 0, dup_del: 0, ring_del: 0, ce_flip: 0, rec_flip: 0 };
    for (const slug of slugs) {
      let t; try { t = await tenantPoolMod.findActiveTenant(slug); } catch (_) { continue; }
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      const per = { time_fixed: 0, burst_del: 0, dup_del: 0, ring_del: 0, ce_flip: 0, rec_flip: 0 };
      try {
        // Step 1: backfill created_at from recording's started_at
        const u1 = await pool.query(`
          UPDATE call_events ce SET created_at = lr.started_at
            FROM lead_recordings lr
           WHERE ce.recording_id = lr.id
             AND ce.created_at >= NOW() - INTERVAL '48 hours'
             AND lr.started_at IS NOT NULL
             AND lr.started_at < ce.created_at - INTERVAL '60 seconds'
        `); per.time_fixed = u1.rowCount || 0;

        // Step 2: burst delete — >=5 distinct phones at same second, no recording
        const u2 = await pool.query(`
          WITH bursts AS (
            SELECT user_id, date_trunc('second', created_at) AS ts
              FROM call_events
             WHERE created_at >= NOW() - INTERVAL '48 hours'
             GROUP BY user_id, date_trunc('second', created_at)
            HAVING COUNT(DISTINCT phone) >= 5
          )
          DELETE FROM call_events ce
           WHERE ce.created_at >= NOW() - INTERVAL '48 hours'
             AND ce.recording_id IS NULL
             AND EXISTS (
               SELECT 1 FROM bursts b
                WHERE b.user_id = ce.user_id
                  AND b.ts = date_trunc('second', ce.created_at)
             )
        `); per.burst_del = u2.rowCount || 0;

        // Step 3: dual-bridge duplicate dedup
        const u3 = await pool.query(`
          WITH dups AS (
            SELECT ce.id FROM call_events ce
              JOIN call_events ce_earlier ON
                   ce_earlier.user_id = ce.user_id
               AND ce_earlier.phone   = ce.phone
               AND ce_earlier.event   = ce.event
               AND ce_earlier.id      < ce.id
               AND ce_earlier.created_at >= ce.created_at - INTERVAL '12 seconds'
             WHERE ce.created_at >= NOW() - INTERVAL '48 hours'
          )
          DELETE FROM call_events WHERE id IN (SELECT id FROM dups)
        `); per.dup_del = u3.rowCount || 0;

        // Step 4: orphan incoming_ringing paired with call_ended OR recording_saved
        const u4 = await pool.query(`
          DELETE FROM call_events ce
           WHERE ce.event = 'incoming_ringing'
             AND ce.created_at >= NOW() - INTERVAL '48 hours'
             AND (
               EXISTS (
                 SELECT 1 FROM call_events ce2
                  WHERE ce2.user_id = ce.user_id AND ce2.phone = ce.phone
                    AND ce2.event = 'call_ended'
                    AND ce2.created_at BETWEEN ce.created_at AND ce.created_at + INTERVAL '10 minutes'
               )
               OR EXISTS (
                 SELECT 1 FROM call_events ce3
                  WHERE ce3.user_id = ce.user_id AND ce3.phone = ce.phone
                    AND ce3.event = 'recording_saved'
                    AND ce3.created_at BETWEEN ce.created_at - INTERVAL '2 minutes'
                                           AND ce.created_at + INTERVAL '30 minutes'
               )
             )
        `); per.ring_del = u4.rowCount || 0;

        // Step 5: flip call_ended direction
        const u5 = await pool.query(`
          UPDATE call_events ce SET direction = 'in'
           WHERE ce.event = 'call_ended'
             AND ce.direction = 'out'
             AND ce.created_at >= NOW() - INTERVAL '48 hours'
             AND EXISTS (
               SELECT 1 FROM call_events ce2
                WHERE ce2.user_id = ce.user_id AND ce2.phone = ce.phone
                  AND ce2.event = 'incoming_ringing' AND ce2.direction = 'in'
                  AND ce2.created_at BETWEEN ce.created_at - INTERVAL '10 minutes'
                                         AND ce.created_at + INTERVAL '2 minutes'
             )
        `); per.ce_flip = u5.rowCount || 0;

        // Step 6: flip recording_saved direction
        const u6 = await pool.query(`
          UPDATE call_events ce SET direction = 'in'
           WHERE ce.event = 'recording_saved'
             AND ce.direction = 'out'
             AND ce.created_at >= NOW() - INTERVAL '48 hours'
             AND EXISTS (
               SELECT 1 FROM call_events ce2
                WHERE ce2.user_id = ce.user_id AND ce2.phone = ce.phone
                  AND ce2.event = 'incoming_ringing' AND ce2.direction = 'in'
                  AND ce2.created_at BETWEEN ce.created_at - INTERVAL '10 minutes'
                                         AND ce.created_at + INTERVAL '2 minutes'
             )
        `); per.rec_flip = u6.rowCount || 0;

        const sum = per.time_fixed + per.burst_del + per.dup_del + per.ring_del + per.ce_flip + per.rec_flip;
        if (sum > 0) {
          console.log('[call-48h-cleanup] ' + slug
            + ' — time:' + per.time_fixed
            + ' burst:' + per.burst_del
            + ' dup:' + per.dup_del
            + ' ring:' + per.ring_del
            + ' ce:' + per.ce_flip
            + ' rec:' + per.rec_flip);
          totals.time_fixed += per.time_fixed; totals.burst_del += per.burst_del;
          totals.dup_del += per.dup_del; totals.ring_del += per.ring_del;
          totals.ce_flip += per.ce_flip; totals.rec_flip += per.rec_flip;
        }
        totals.tenants++;
      } catch (e) {
        console.warn('[call-48h-cleanup] ' + slug + ' failed: ' + e.message);
      }
    }
    console.log('[call-48h-cleanup] done — '
      + totals.tenants + ' tenants · '
      + 'time:' + totals.time_fixed + ' burst:' + totals.burst_del
      + ' dup:' + totals.dup_del + ' ring:' + totals.ring_del
      + ' ce:' + totals.ce_flip + ' rec:' + totals.rec_flip);
    try {
      await controlDb.query(
        "INSERT INTO saas_flags (key, value) VALUES ('call_last48h_cleanup_v1', $1) ON CONFLICT (key) DO NOTHING",
        [JSON.stringify(totals)]
      );
    } catch (_) {}
  } catch (e) {
    console.error('[call-48h-cleanup] failed:', e.message);
  }
}
// Run 300s after boot — after every other backfill so we're the final
// pass that catches anything they left behind in the yesterday window.
setTimeout(() => _runCallLast48hCleanup().catch(() => {}), 300_000);


  app.listen(PORT, () => {
    console.log('[boot] SmartCRM SaaS listening on :' + PORT);
    // COPILOT_v4 — one-shot enable on vserve. Idempotent, non-blocking.
    try {
      const { autoEnableOnVserve } = require('./utils/cp4VserveAutoEnable');
      setTimeout(() => { autoEnableOnVserve().catch(e => console.error('[CP4_AUTOENABLE]', e.message)); }, 5000);
    } catch (e) { console.warn('[CP4_AUTOENABLE] require failed:', e.message); }
  });
}
boot().catch(e => { console.error('[boot] failed:', e); process.exit(1); });
