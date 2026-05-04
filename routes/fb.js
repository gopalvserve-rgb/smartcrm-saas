/**
 * routes/fb.js — Facebook / Meta Lead Ads integration
 *
 * Two-tier model that mirrors the screenshot the user shared:
 *
 * 1. Application Settings (DB-backed via the `config` table):
 *      - META_APP_ID       (FB App ID)
 *      - META_APP_SECRET   (FB App Secret)
 *      - META_VERIFY_TOKEN (webhook verify token)
 *
 * 2. Module Settings (DB-backed):
 *      - META_DEFAULT_USER_ID    (assignee for incoming Meta leads)
 *      - META_DEFAULT_SOURCE     (source label, e.g. "Facebook")
 *      - META_DEFAULT_STATUS_ID  (initial status)
 *
 * 3. Pages: a JSON list in META_PAGES_LIST with each page's id, name,
 *    access_token, and is_monitored flag. Admin connects with FB Login,
 *    we fetch ALL pages they have access to, then they pick which ones
 *    to monitor. Subscribing a page = POSTing /<page-id>/subscribed_apps
 *    with subscribed_fields=leadgen.
 */
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ---------- Platform-managed Meta App credentials ----------
// Same Meta Developer App as the WhatsApp Cloud API integration (a single
// FB app can have WhatsApp Business + Facebook Login + Pages enabled). Baked
// in here so every tenant uses the platform's app — admins never see or
// type these values. Override via env vars on Railway if you ever rotate.
const PLATFORM_FB_APP_ID     = process.env.PLATFORM_FB_APP_ID     || '965594974738358';
const PLATFORM_FB_APP_SECRET = process.env.PLATFORM_FB_APP_SECRET || '3d04f767b437f9083ee45533e97d3c18';

// ---------- helpers ----------

async function _appCreds() {
  // Platform-managed: always return the bundled credentials. We still check
  // DB config first so that if a tenant ever needs to point at a different
  // Meta App (rare), they can set META_APP_ID / META_APP_SECRET via the
  // /api/api_fb_settings_set endpoint and that takes precedence.
  const dbAppId = await db.getConfig('META_APP_ID', '');
  const dbAppSecret = await db.getConfig('META_APP_SECRET', '');
  return {
    app_id: dbAppId || PLATFORM_FB_APP_ID,
    app_secret: dbAppSecret || PLATFORM_FB_APP_SECRET
  };
}

async function _gget(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error('Meta: ' + (j.error.message || JSON.stringify(j.error)));
  return j;
}

/**
 * Walk every page of /me/accounts (or any cursored Graph endpoint), returning
 * the merged data array. Stops at MAX_PAGES iterations to prevent runaway calls.
 */
async function _gpaged(url) {
  const out = [];
  let next = url;
  for (let i = 0; i < 30 && next; i++) {
    const j = await _gget(next);
    if (Array.isArray(j.data)) out.push(...j.data);
    next = (j.paging && j.paging.next) ? j.paging.next : null;
  }
  return out;
}

/**
 * Fetch every page the connected user has access to. Strategy mirrors the
 * battle-tested PHP CRM:
 *   1. /me/accounts — direct page admin grants
 *   2. /me/businesses — Business Manager memberships, then for each business:
 *      /<biz_id>/owned_pages and /<biz_id>/client_pages — pages owned/managed
 *      by that business. This is what makes the Adbullet-style multi-page
 *      setup actually work, because most agency pages live under a Business.
 * Returns a deduped list keyed by page id, each with id, name, access_token,
 * category.
 */
async function _fetchAllPages(userToken, diag) {
  const seen = new Map();   // page_id → page object
  const fields = 'id,name,access_token,category';
  // Diagnostics container. The caller can pass {} and inspect after the call
  // to see exactly which tiers returned data and which failed.
  const _diag = diag || { tiers: {} };

  // Tier 1 — direct accounts
  try {
    const direct = await _gpaged(`${GRAPH}/me/accounts?fields=${fields}&limit=100&access_token=${userToken}`);
    for (const p of direct) seen.set(String(p.id), p);
    _diag.tiers['me/accounts'] = { ok: true, count: direct.length };
  } catch (e) {
    console.warn('[fb] /me/accounts failed:', e.message);
    _diag.tiers['me/accounts'] = { ok: false, error: e.message };
  }

  // Tier 1b — Embedded Login / Login for Business returns a token whose
  // /me/accounts may be empty BUT the user has selected specific assets
  // visible via /me?fields=accounts{...} (subfield form). Try this if Tier 1
  // came back empty.
  if (seen.size === 0) {
    try {
      const sub = await _gget(`${GRAPH}/me?fields=accounts{${fields}}&access_token=${userToken}`);
      const arr = (sub && sub.accounts && sub.accounts.data) || [];
      for (const p of arr) seen.set(String(p.id), p);
      _diag.tiers['me?fields=accounts{...}'] = { ok: true, count: arr.length };
    } catch (e) {
      _diag.tiers['me?fields=accounts{...}'] = { ok: false, error: e.message };
    }
  }

  // Tier 2 — Business Manager
  let businesses = [];
  try {
    businesses = await _gpaged(`${GRAPH}/me/businesses?fields=id,name&limit=50&access_token=${userToken}`);
    _diag.tiers['me/businesses'] = { ok: true, count: businesses.length };
  } catch (e) {
    console.warn('[fb] /me/businesses failed:', e.message);
    _diag.tiers['me/businesses'] = { ok: false, error: e.message };
  }
  for (const biz of businesses) {
    for (const which of ['owned_pages', 'client_pages']) {
      try {
        const pgs = await _gpaged(`${GRAPH}/${biz.id}/${which}?fields=${fields}&limit=100&access_token=${userToken}`);
        for (const p of pgs) {
          // Business-managed pages may not include access_token in the response;
          // fetch it individually if missing — without it we can't subscribe.
          if (!p.access_token) {
            try {
              const tk = await _gget(`${GRAPH}/${p.id}?fields=access_token&access_token=${userToken}`);
              if (tk && tk.access_token) p.access_token = tk.access_token;
            } catch (_) { /* skip pages we can't get a token for */ }
          }
          if (!seen.has(String(p.id))) seen.set(String(p.id), p);
        }
        _diag.tiers[`${biz.id}/${which}`] = { ok: true, count: pgs.length };
      } catch (e) {
        console.warn(`[fb] /${biz.id}/${which} failed:`, e.message);
        _diag.tiers[`${biz.id}/${which}`] = { ok: false, error: e.message };
      }
    }
  }

  _diag.total = seen.size;
  return Array.from(seen.values());
}

async function _readPagesList() {
  const raw = await db.getConfig('META_PAGES_LIST', '');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (_) { return []; }
}

async function _writePagesList(list) {
  await db.setConfig('META_PAGES_LIST', JSON.stringify(list || []));
}

async function _longLived(shortToken) {
  const { app_id, app_secret } = await _appCreds();
  if (!app_id || !app_secret) {
    throw new Error('Set Facebook Application ID and Secret first (Admin → Facebook).');
  }
  const url = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${app_id}&client_secret=${app_secret}&fb_exchange_token=${shortToken}`;
  const j = await _gget(url);
  return j.access_token;
}

// Subscribe / unsubscribe a single page to leadgen.
async function _subscribePage(pageId, pageAccessToken, subscribe) {
  const method = subscribe ? 'POST' : 'DELETE';
  const r = await fetch(`${GRAPH}/${pageId}/subscribed_apps`, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: subscribe
      ? `subscribed_fields=leadgen&access_token=${encodeURIComponent(pageAccessToken)}`
      : `access_token=${encodeURIComponent(pageAccessToken)}`
  });
  const j = await r.json();
  if (j.error) throw new Error((subscribe ? 'Subscribe' : 'Unsubscribe') + ' failed: ' + j.error.message);
  return j;
}

// ---------- API: Settings (Application + Module) ----------

async function api_fb_settings_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const [verify_token, default_user_id, default_source, default_status_id] = await Promise.all([
    db.getConfig('META_VERIFY_TOKEN', ''),
    db.getConfig('META_DEFAULT_USER_ID', ''),
    db.getConfig('META_DEFAULT_SOURCE', 'Facebook'),
    db.getConfig('META_DEFAULT_STATUS_ID', '')
  ]);
  return {
    // Platform-managed Meta App. Surface the App ID so the FB JS SDK can
    // launch login dialogs from the browser, but never leak the secret.
    app_id: PLATFORM_FB_APP_ID,
    app_secret_present: true,
    fb_platform_managed: true,
    verify_token,
    default_user_id, default_source, default_status_id
  };
}

async function api_fb_settings_set(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  // app_id / app_secret are platform-managed constants now — silently
  // ignore if a stale client tries to send them.
  if ('verify_token' in p) await db.setConfig('META_VERIFY_TOKEN', String(p.verify_token || '').trim());
  if ('default_user_id' in p) await db.setConfig('META_DEFAULT_USER_ID', String(p.default_user_id || '').trim());
  if ('default_source' in p) await db.setConfig('META_DEFAULT_SOURCE', String(p.default_source || '').trim());
  if ('default_status_id' in p) await db.setConfig('META_DEFAULT_STATUS_ID', String(p.default_status_id || '').trim());
  return { ok: true };
}

// ---------- API: Connect (FB Login) ----------

async function api_fb_connect(token, shortToken) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!shortToken) throw new Error('Facebook token missing');

  const { app_id, app_secret } = await _appCreds();
  if (!app_id || !app_secret) {
    throw new Error('Set the Facebook Application ID and Secret first.');
  }

  // 1. Long-lived user token
  const longToken = await _longLived(shortToken);

  // 2. Fetch every page (direct + Business Manager owned + Business Manager
  //    client). Without this, agency users who manage pages through a Business
  //    get an empty list — that's the exact bug we're fixing here.
  const pages = await _fetchAllPages(longToken);

  // 3. Merge with existing list — preserve is_monitored state for pages the
  //    admin already chose, refresh access_token for everyone (FB rotates them).
  const existing = await _readPagesList();
  const merged = pages.map(p => {
    const prev = existing.find(e => String(e.page_id) === String(p.id));
    return {
      page_id: String(p.id),
      page_name: p.name || '',
      category: p.category || '',
      access_token: p.access_token || '',
      is_monitored: prev ? !!prev.is_monitored : false,
      added_at: prev?.added_at || db.nowIso(),
      last_seen_at: db.nowIso()
    };
  });
  await _writePagesList(merged);

  // 4. Persist the long-lived USER token so we can refresh later without re-login.
  await db.setConfig('META_USER_TOKEN', longToken);
  await db.setConfig('META_CONNECTED_AT', db.nowIso());

  return { ok: true, pages_count: merged.length };
}

async function api_fb_disconnect(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Unsubscribe every monitored page so we stop receiving webhooks.
  const list = await _readPagesList();
  for (const pg of list.filter(p => p.is_monitored)) {
    try { await _subscribePage(pg.page_id, pg.access_token, false); }
    catch (_) { /* best-effort */ }
  }
  await db.setConfig('META_USER_TOKEN', '');
  await db.setConfig('META_CONNECTED_AT', '');
  await _writePagesList([]);
  return { ok: true };
}

// ---------- API: Pages ----------

async function api_fb_pages_list(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const list = await _readPagesList();
  // Don't leak the access_token to the frontend.
  return list.map(({ access_token, ...rest }) => rest);
}

/** Re-fetch pages from Meta using the stored user token (refresh action). */
async function api_fb_pages_refetch(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const userToken = await db.getConfig('META_USER_TOKEN', '');
  if (!userToken) throw new Error('Connect with Facebook first.');
  const pages = await _fetchAllPages(userToken);
  const existing = await _readPagesList();
  const merged = pages.map(p => {
    const prev = existing.find(e => String(e.page_id) === String(p.id));
    return {
      page_id: String(p.id),
      page_name: p.name || '',
      category: p.category || '',
      access_token: p.access_token || '',
      is_monitored: prev ? !!prev.is_monitored : false,
      added_at: prev?.added_at || db.nowIso(),
      last_seen_at: db.nowIso()
    };
  });
  await _writePagesList(merged);
  return { ok: true, count: merged.length };
}

/**
 * Manually register a page using a Page Access Token the admin has obtained
 * out-of-band (Graph API Explorer, System User in Business Manager, etc.).
 * Bypasses OAuth entirely — useful when:
 *   - The Meta app isn't yet approved for `business_management` scope
 *   - The admin already has a never-expiring System User token
 *   - The admin can't or won't go through the FB Login dialog
 *
 * Validates the token by hitting Graph API for the page name + id, then
 * subscribes the page to leadgen webhooks immediately so leads start flowing.
 */
async function api_fb_pages_addManual(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const pageId = String(p.page_id || '').trim();
  const pageToken = String(p.page_access_token || '').trim();
  if (!pageId) throw new Error('Page ID is required');
  if (!pageToken) throw new Error('Page Access Token is required');

  // 1. Validate the token: it must return the page object with matching id.
  let info;
  try {
    info = await _gget(`${GRAPH}/${pageId}?fields=id,name,category&access_token=${encodeURIComponent(pageToken)}`);
  } catch (e) {
    throw new Error('Token check failed — make sure the token is a Page Access Token for page ' + pageId + '. ' + e.message);
  }
  if (String(info.id) !== pageId) {
    throw new Error('Page Access Token does not belong to page ' + pageId + ' (it belongs to ' + info.id + ').');
  }

  // 2. Subscribe to leadgen so we receive webhooks for this page.
  try {
    await _subscribePage(pageId, pageToken, true);
  } catch (e) {
    throw new Error('Page validated but leadgen subscribe failed: ' + e.message +
      '. Ensure the Meta app webhook is configured for "leadgen" and the page admin granted leads_retrieval.');
  }

  // 3. Persist alongside any OAuth-fetched pages.
  const list = await _readPagesList();
  const existingIdx = list.findIndex(x => String(x.page_id) === pageId);
  const entry = {
    page_id: pageId,
    page_name: info.name || (p.page_name || pageId),
    category: info.category || (p.category || ''),
    access_token: pageToken,
    is_monitored: true,
    added_at: existingIdx >= 0 ? list[existingIdx].added_at : db.nowIso(),
    last_seen_at: db.nowIso(),
    source: 'manual'
  };
  if (existingIdx >= 0) list[existingIdx] = entry;
  else list.push(entry);
  await _writePagesList(list);
  return { ok: true, page: { page_id: entry.page_id, page_name: entry.page_name, is_monitored: true } };
}

/** Toggle monitoring for one page. */
async function api_fb_pages_toggle(token, pageId, monitor) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const list = await _readPagesList();
  const pg = list.find(p => String(p.page_id) === String(pageId));
  if (!pg) throw new Error('Page not in list — refetch pages first.');

  // Subscribe / unsubscribe at Meta
  await _subscribePage(pg.page_id, pg.access_token, !!monitor);
  pg.is_monitored = !!monitor;
  pg.last_action_at = db.nowIso();
  await _writePagesList(list);
  return { ok: true, page: { page_id: pg.page_id, page_name: pg.page_name, is_monitored: pg.is_monitored } };
}

/** Status — used by the admin page header. */
async function api_fb_status(token) {
  await authUser(token);
  const userToken = await db.getConfig('META_USER_TOKEN', '');
  const at = await db.getConfig('META_CONNECTED_AT', '');
  const app_id = await db.getConfig('META_APP_ID', '');
  const list = await _readPagesList();
  const monitored = list.filter(p => p.is_monitored);
  return {
    connected: !!userToken,
    app_id,
    pages_total: list.length,
    pages_monitored: monitored.length,
    monitored_pages: monitored.map(p => ({ page_id: p.page_id, page_name: p.page_name })),
    connected_at: at || null
  };
}

/**
 * Internal helper used by the webhook handler — given a page_id, return
 * its access token and the configured defaults so the lead can be created
 * with the right assignee / source / status.
 */
async function _pageContextForWebhook(pageId) {
  const list = await _readPagesList();
  const pg = list.find(p => String(p.page_id) === String(pageId));
  const [defaultUserId, defaultSource, defaultStatusId] = await Promise.all([
    db.getConfig('META_DEFAULT_USER_ID', ''),
    db.getConfig('META_DEFAULT_SOURCE', 'Facebook'),
    db.getConfig('META_DEFAULT_STATUS_ID', '')
  ]);
  return {
    access_token: pg ? pg.access_token : '',
    page_name: pg ? pg.page_name : '',
    is_monitored: pg ? !!pg.is_monitored : false,
    default_user_id: defaultUserId ? Number(defaultUserId) : null,
    default_source: defaultSource || 'Facebook',
    default_status_id: defaultStatusId ? Number(defaultStatusId) : null
  };
}

// =====================================================================
// Server-side OAuth flow — bypasses the FB JS SDK entirely.
// User clicks "Connect" → redirected to facebook.com → logs in → FB
// redirects to our /fb/auth/callback with a `code` → server exchanges for
// access token → fetches pages → persists everything → redirects user
// back to /#/admin/fb. No popup, no SDK, no browser permission needed.
// =====================================================================

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const FB_OAUTH_SCOPE = [
  'public_profile',
  'pages_show_list',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_ads',
  'leads_retrieval',
  'ads_management',
  'ads_read',
  'business_management'
].join(',');

/**
 * Frontend calls this. Returns a Facebook OAuth URL the user can navigate to.
 * State token is signed with our JWT secret + 10-min expiry, carrying the
 * admin's user_id so the callback knows who to attribute the connection to.
 */
async function api_fb_oauth_url(token, baseUrl) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const { app_id } = await _appCreds();
  if (!app_id) throw new Error('Set Facebook Application ID first.');
  const stateToken = jwt.sign({ uid: me.id, t: 'fb_oauth' }, JWT_SECRET, { expiresIn: '10m' });
  // Use the configured BASE_URL or the URL the frontend told us.
  const cfgBase = await db.getConfig('BASE_URL', '');
  const origin = (cfgBase || baseUrl || '').replace(/\/+$/, '');
  if (!origin) throw new Error('BASE_URL not configured. Set it in Admin → Company Settings.');
  const redirectUri = origin + '/fb/auth/callback';
  const params = new URLSearchParams({
    client_id: app_id,
    redirect_uri: redirectUri,
    state: stateToken,
    response_type: 'code',
    auth_type: 'rerequest',
    scope: FB_OAUTH_SCOPE
  });
  return {
    auth_url: 'https://www.facebook.com/v19.0/dialog/oauth?' + params.toString(),
    redirect_uri: redirectUri
  };
}

/**
 * Express handler — mounted at GET /fb/auth/callback by server.js.
 * NOT an api_* function (uses real query params, not the /api dispatcher).
 */
async function expressOAuthCallback(req, res) {
  const code = (req.query.code || '').toString();
  const stateRaw = (req.query.state || '').toString();
  const errMsg = (req.query.error_description || req.query.error || '').toString();
  // We always end on the admin Facebook tab, with a flash param the SPA
  // can show as a toast.
  const adminUrl = '/#/admin/fb';
  function done(flash) { return res.redirect(adminUrl + (flash ? '?fb=' + encodeURIComponent(flash) : '')); }

  try {
    if (errMsg) return done('error: ' + errMsg);
    if (!code) return done('error: missing code');
    let payload;
    try { payload = jwt.verify(stateRaw, JWT_SECRET); }
    catch (_) { return done('error: invalid state (link expired or tampered)'); }
    if (payload.t !== 'fb_oauth' || !payload.uid) return done('error: bad state');

    // Confirm the user is still an admin
    const user = await db.findById('users', payload.uid);
    if (!user || user.role !== 'admin') return done('error: not an admin');

    // Exchange code for access token
    const { app_id, app_secret } = await _appCreds();
    const cfgBase = await db.getConfig('BASE_URL', '');
    const origin = (cfgBase || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
    const redirectUri = origin + '/fb/auth/callback';
    const tokenJson = await _gget(
      `${GRAPH}/oauth/access_token?client_id=${app_id}&client_secret=${app_secret}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`
    );
    const shortToken = tokenJson.access_token;
    if (!shortToken) return done('error: no token from Facebook');

    // Long-lived token + fetch all pages (multi-tier — direct + Business Manager)
    const longToken = await _longLived(shortToken);
    const diag = { tiers: {} };
    const pages = await _fetchAllPages(longToken, diag);
    // Persist the last connect diagnostic so admin can hit api_fb_debug to
    // see exactly what FB returned (or didn't) — invaluable when "connected
    // but no pages" happens with the new Login for Business flow.
    try { await db.setConfig('META_LAST_DIAG', JSON.stringify(diag)); } catch (_) {}

    const existing = await _readPagesList();
    const merged = pages.map(p => {
      const prev = existing.find(e => String(e.page_id) === String(p.id));
      return {
        page_id: String(p.id),
        page_name: p.name || '',
        category: p.category || '',
        access_token: p.access_token || '',
        is_monitored: prev ? !!prev.is_monitored : false,
        added_at: prev?.added_at || db.nowIso(),
        last_seen_at: db.nowIso()
      };
    });
    await _writePagesList(merged);
    await db.setConfig('META_USER_TOKEN', longToken);
    await db.setConfig('META_CONNECTED_AT', db.nowIso());
    return done(`connected:${pages.length}`);
  } catch (e) {
    console.error('[fb oauth callback]', e);
    return done('error: ' + e.message);
  }
}

/**
 * Debug — pulls the current persisted user token, makes the same Graph API
 * calls _fetchAllPages would, and returns a structured diagnostic. Lets the
 * admin see why "Connected but no pages" — the most common cause is that
 * the new "Login for Business" flow returns a granular token that doesn't
 * surface assets via the legacy endpoints.
 */
async function api_fb_debug(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const userToken = await db.getConfig('META_USER_TOKEN', '');
  const lastDiag = await db.getConfig('META_LAST_DIAG', '');
  if (!userToken) {
    return {
      connected: false,
      message: 'No saved Facebook user token. Click "Connect with Facebook" first.',
      last_diag: lastDiag ? safeJson(lastDiag) : null
    };
  }
  // Run the live probes
  const out = {
    connected: true,
    last_diag: lastDiag ? safeJson(lastDiag) : null,
    probes: {}
  };
  async function probe(name, url) {
    try { out.probes[name] = await _gget(url); }
    catch (e) { out.probes[name] = { error: e.message }; }
  }
  await probe('me',           `${GRAPH}/me?fields=id,name&access_token=${userToken}`);
  await probe('me/permissions', `${GRAPH}/me/permissions?access_token=${userToken}`);
  await probe('me/accounts',  `${GRAPH}/me/accounts?fields=id,name,category&limit=100&access_token=${userToken}`);
  await probe('me/businesses', `${GRAPH}/me/businesses?fields=id,name&limit=50&access_token=${userToken}`);
  await probe('me?fields=accounts{...}', `${GRAPH}/me?fields=accounts{id,name,category}&access_token=${userToken}`);
  // Re-run the full fetch with fresh diagnostics
  const liveDiag = { tiers: {} };
  const pages = await _fetchAllPages(userToken, liveDiag);
  out.live_fetch = { pages_count: pages.length, diag: liveDiag };
  return out;
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return { raw: s }; } }

module.exports = {
  api_fb_connect, api_fb_disconnect, api_fb_status,
  api_fb_settings_get, api_fb_settings_set,
  api_fb_pages_list, api_fb_pages_refetch, api_fb_pages_toggle, api_fb_pages_addManual,
  api_fb_oauth_url, api_fb_debug,
  // exported for server.js to mount as a plain route
  expressOAuthCallback,
  // exported for use inside webhooks.js
  _pageContextForWebhook
};
