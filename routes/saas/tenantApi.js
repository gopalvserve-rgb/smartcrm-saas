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

// Pull active tenant slug from tenantStorage context — used to bind freshly
// minted tokens to the issuing tenant.
function _activeSlugForToken() {
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    return store && store.slug ? String(store.slug) : null;
  } catch (_) { return null; }
}

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
  'dashboardWidgets',  /* DASHBOARD_REDESIGN_v1 — 7 new widget APIs */
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
  'invoicing',
  'modules',
  'crmCopilot',
  'waBotFlows',
  'qrForms',
  'forms',
  'pages',
  'nurture',
  'waWidget',
  'packs/education',
  'packs/realestate',
  // PACK_PHASE_2_v1 — 2026-06-07
  'packs/finance',
  'packs/solar',
  'packs/manufacturer',
  'packs/holiday',
  'packs/ecommerce',
  'social',
  'ivr',
  'compliance',  /* COMPLIANCE_v1 */
  'reportTemplates',  /* REPORT_SCHEDULE_v1 */
  'googleCalendar',  /* GMEET_v1 */
  'meetings',        /* GMEET_v1 */
  'devicediag',      /* DEVICE_DIAG_INGEST_FIX_v1 — tenant ingest only; super-admin reads stay in routes/saas/recordingHealth.js */
  'outboundWebhook', /* OUTBOUND_WH_v1 — send each NEW lead to external URLs based on filter rules */
  'team',            /* TEAM_LIVE_STATUS_v1 — Live Team Status panel + Break toggle */
  'changelog',       /* CHANGELOG_v1 — What's New / changelog feed */
  'googleConvExport', /* GOOGLE_CONV_EXPORT_v1 — Google Ads offline-conversion CSV export */
  'metaConvExport',   /* META_CAPI_v1 — Meta Conversions API offline events */
  'leadQuickNote',   /* QNOTE_v1 — AI Quick Note row action (vserve beta) */
  'packs/student360', /* STU360_LIVE_v1 — Student 360 view for Education pack */
  'opportunities',    /* OPPORTUNITIES_v1 — multi-opportunity + multi-pipeline */
  'leadScoring',      /* LEAD_SCORING_v1 — Smart Lead Scoring */
  'copilotProactive', /* COPILOT_v4 — Proactive Sales Coach (vserve beta) */
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

  const token = signToken(user, _activeSlugForToken());
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

  const token = signToken(user, _activeSlugForToken());
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

  // ONE-TIME USE — record the JTI in control.consumed_sso_jti so this
  // exact token cannot be exchanged for a second session. Protects
  // against a super-admin accidentally pasting/sharing a magic link.
  // The unique constraint is what makes this atomic: a concurrent
  // second exchange will fail the INSERT.
  const _control = require('../../db/pg');
  const _jti = String(decoded.jti || (decoded.iat + ':' + decoded.exp + ':' + decoded.as_email));
  try {
    await _control.query(`CREATE TABLE IF NOT EXISTS consumed_sso_jti (
      jti TEXT PRIMARY KEY,
      consumed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      slug TEXT,
      as_email TEXT
    )`);
  } catch (_) { /* may already exist */ }
  try {
    await _control.query(
      `INSERT INTO consumed_sso_jti (jti, slug, as_email) VALUES ($1,$2,$3)`,
      [_jti, slug, String(decoded.as_email || '')]
    );
  } catch (e) {
    // Duplicate key = already consumed. Refuse and instruct user to
    // get a fresh link from super-admin.
    if (/duplicate|unique/i.test(String(e.message))) {
      throw new Error('This login link has already been used. SSO links are one-time-use for security. Please generate a fresh one from the super-admin panel.');
    }
    // Other DB errors — log but allow login (don't lock everyone out
    // if the control table has issues).
    console.warn('[sso] jti tracking failed:', e.message);
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

  const token = signToken(user, _activeSlugForToken());
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

  // CRM_PERF_v1_SERVER — measure how long every tenant API call takes.
  // Anything over the slow-thresholds gets a structured console.log line
  // (auto-surfaces in Railway logs) so we can see WITHOUT any user action
  // which functions are choking, for which tenant.
  const _SLOW_API_MS      = 1000;
  const _VERY_SLOW_API_MS = 3000;
  const _perfStart = Date.now();
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
    const _ms = Date.now() - _perfStart;
    if (_ms >= _SLOW_API_MS) {
      const slug = (req.tenant && req.tenant.slug) || req.tenantSlug || 'unknown';
      const uid  = (req.tenant && req.tenant.user_id) || req.user_id || '?';
      const tag  = _ms >= _VERY_SLOW_API_MS ? 'VERY_SLOW' : 'SLOW';
      console.log('[PERF_SLOW_API]', tag, 'fn=' + fn, 'ms=' + _ms, 'tenant=' + slug, 'user=' + uid);
      // Also pile up a per-process in-memory tally so a GET /api/perf-summary
      // (defined in server.js) can return it without DB writes.
      if (!global._perfSlowTally) global._perfSlowTally = { by_fn: {}, by_tenant: {}, recent: [] };
      const T = global._perfSlowTally;
      T.by_fn[fn] = T.by_fn[fn] || { n: 0, total: 0, max: 0 };
      T.by_fn[fn].n++; T.by_fn[fn].total += _ms; if (_ms > T.by_fn[fn].max) T.by_fn[fn].max = _ms;
      T.by_tenant[slug] = T.by_tenant[slug] || { n: 0, total: 0, max: 0 };
      T.by_tenant[slug].n++; T.by_tenant[slug].total += _ms; if (_ms > T.by_tenant[slug].max) T.by_tenant[slug].max = _ms;
      T.recent.push({ t: Date.now(), fn, ms: _ms, tenant: slug, user: uid });
      if (T.recent.length > 500) T.recent.splice(0, T.recent.length - 500);
      // PERF_HEALTH_DB_PERSIST_v1 — also write to control DB so the data
      // survives Railway redeploys (the in-memory tally wipes on each deploy).
      try {
        const controlDb = require('../../control/db');
        const ua = String(req.headers['user-agent'] || '').slice(0, 250);
        const isApk = /capacitor|wv\)/i.test(ua) || /Capacitor/.test(String(req.headers['x-capacitor'] || ''));
        controlDb.query(
          `INSERT INTO perf_slow_log (created_at, tenant_slug, user_id, fn, ms, tag, source, ua)
           VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7)`,
          [slug, uid === '?' ? null : Number(uid), fn, _ms, tag, isApk ? 'apk' : 'web', ua]
        ).catch(() => {});
      } catch (_) {}
    }
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


// ─────────────────────────────────────────────────────────────────
// Industry Pack management — super-admin only.
// listAvailable shows all packs in the registry.
// listInstalled returns this tenant's active packs.
// install/uninstall run inside the tenant's DB context (caller wraps
// these in tenantStorage.run() per usual).
// ─────────────────────────────────────────────────────────────────
async function api_packs_listAvailable(_token) {
  const fw = require('../packs/_framework');
  return fw.listAvailablePacks();
}
async function api_packs_listInstalled(token) {
  const { authUser } = require('../../utils/auth');
  await authUser(token);
  const fw = require('../packs/_framework');
  // Reconcile any legacy state where >1 pack ended up active (pre-mutex
  // data). Then read only active rows — so the SPA sidebar gate can't
  // pick up a stale is_active=0 row and render Education on a Generic
  // tenant (task #442).
  try { await fw._reconcileActivePacks(); } catch (_) {}

  // NEGATIVE SELF-HEAL (task #442 follow-up): if this tenant was
  // explicitly created as 'generic' in the audit_log, any rows in
  // installed_packs are leftover state from a wrong manual install or
  // a buggy past self-heal. Deactivate them so the sidebar gate stops
  // rendering Education/Real Estate menus. Showcase tenants are exempt.
  try {
    const slug = _activeSlugForToken();
    if (slug && slug !== 'showcase-edu' && slug !== 'showcase-re') {
      const control = require('../../control/db');
      const ar = await control.query(
        `SELECT detail FROM audit_log
            WHERE event = 'tenant.created_manually'
              AND detail::jsonb->>'slug' = $1
            ORDER BY created_at DESC LIMIT 1`,
        [slug]
      );
      const det = ar.rows && ar.rows[0] && ar.rows[0].detail;
      const parsed = (typeof det === 'string') ? JSON.parse(det) : det;
      const auditPack = parsed && parsed.industry_pack;
      if (auditPack === 'generic' || auditPack === '' || auditPack == null) {
        // Wipe ONLY self-heal-installed packs (installed_by IS NULL).
        // User-installed packs (via super-admin button) have installed_by set
        // and must NOT be deactivated — those are legitimate post-creation
        // pack additions (task #442 follow-up).
        const db = require('../../db/pg');
        const upd = await db.query(`UPDATE installed_packs SET is_active = 0 WHERE is_active = 1 AND installed_by IS NULL`);
        if (upd && upd.rowCount > 0) {
          console.log('[packs_listInstalled] negative-heal: deactivated', upd.rowCount, 'self-heal pack(s) on generic tenant', slug);
        }
      }
    }
  } catch (e) {
    console.warn('[packs_listInstalled] negative-heal skipped:', e.message);
  }

  let rows = await fw.listInstalledPacks();

  // SELF-HEAL: if no packs are installed but this tenant SHOULD have one
  // (showcase-edu / showcase-re / a manually-created tenant whose
  // industry_pack got saved in the audit_log but failed to install
  // because the pack registry was empty at the time), install it now.
  // Without this, tenants like testfv stay stuck on Generic forever.
  // rows is already filtered to active rows by listInstalledPacks now.
  const activeRows = rows || [];
  if (!activeRows.length) {
    let expected = null;
    const slug = _activeSlugForToken();
    if (slug === 'showcase-edu') expected = 'education';
    else if (slug === 'showcase-re') expected = 'realestate';
    else if (slug) {
      // Fall back to the audit_log entry from tenant creation. The
      // industry_pack chosen on the Create-tenant form is preserved
      // in the 'tenant.created_manually' event's detail JSON.
      try {
        const control = require('../../control/db');
        const ar = await control.query(
          `SELECT detail FROM audit_log
              WHERE event = 'tenant.created_manually'
                AND detail::jsonb->>'slug' = $1
              ORDER BY created_at DESC LIMIT 1`,
          [slug]
        );
        const det = ar.rows && ar.rows[0] && ar.rows[0].detail;
        const parsed = (typeof det === 'string') ? JSON.parse(det) : det;
        if (parsed && parsed.industry_pack && parsed.industry_pack !== 'generic') {
          expected = String(parsed.industry_pack);
        }
      } catch (e) {
        console.warn('[packs_listInstalled] audit_log lookup failed:', e.message);
      }
    }
    if (expected) {
      try {
        await fw.installPack(expected, {});
        rows = await fw.listInstalledPacks();
        console.log('[packs_listInstalled] self-healed: installed', expected, 'on', slug);
      } catch (e) {
        console.warn('[packs_listInstalled] auto-install failed for', slug, expected, '—', e.message);
      }
    }
  }
  return rows;
}
async function api_packs_install(token, packId) {
  const { authUser } = require('../../utils/auth');
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin only');
  const fw = require('../packs/_framework');
  return fw.installPack(String(packId || ''), { userId: me.id });
}
async function api_packs_uninstall(token, packId) {
  const { authUser } = require('../../utils/auth');
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin only');
  const fw = require('../packs/_framework');
  return fw.uninstallPack(String(packId || ''), { userId: me.id });
}
API.api_packs_listAvailable = api_packs_listAvailable;
API.api_packs_listInstalled = api_packs_listInstalled;
API.api_packs_install       = api_packs_install;
API.api_packs_uninstall     = api_packs_uninstall;

module.exports = { expressHandler };
