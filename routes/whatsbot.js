/**
 * routes/whatsbot.js — Full WhatsBot module.
 *
 * Replaces the minimal routes/whatsapp.js with a much wider feature set
 * inspired by the Corbital WhatsBot module:
 *   - Connect Account (set & verify WABA ID, access token, phone id)
 *   - Templates (sync & list approved templates from Meta)
 *   - Campaigns (broadcast a template to many leads, async send loop)
 *   - Live Chat (per-contact threaded view + send text/image/document)
 *   - Message Bot (keyword → text reply)
 *   - Template Bot (keyword → template reply)
 *   - Activity Log (every Meta API call we make)
 *   - Webhook handler — separate Express route at /hook/whatsapp_webhook
 *
 * Functions exposed via the /api dispatcher are prefixed `api_wb_*`.
 * Express routes are mounted in server.js using the exported handlers.
 */
const fetch = require('node-fetch');
const FormData = require('form-data');
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ---------- Platform-wide Facebook credentials -----------------------
// These are the SAME for every tenant/client on the platform — they are the
// CRM vendor's Meta Developer App, not the client's. Clients only press
// "Connect with Facebook" and pick their WABA / phone number; they never see
// or input App ID / Secret / Config ID.
//
// Override via env vars on Railway if you ever need to rotate them without
// a redeploy.
const PLATFORM_FB_APP_ID     = process.env.PLATFORM_FB_APP_ID     || '965594974738358';
const PLATFORM_FB_APP_SECRET = process.env.PLATFORM_FB_APP_SECRET || '3d04f767b437f9083ee45533e97d3c18';
const PLATFORM_FB_CONFIG_ID  = process.env.PLATFORM_FB_CONFIG_ID  || '678267295315635';

// ---------- shared helpers ----------------------------------------

async function _cfg() {
  const [wabaId, token, phoneId, defaultStatus, defaultUser, autoLeadOn, autoLeadSource, defaultCC] = await Promise.all([
    db.getConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || ''),
    db.getConfig('WHATSAPP_ACCESS_TOKEN',        process.env.WHATSAPP_ACCESS_TOKEN || ''),
    db.getConfig('WHATSAPP_PHONE_NUMBER_ID',     process.env.WHATSAPP_PHONE_NUMBER_ID || ''),
    db.getConfig('WB_DEFAULT_STATUS_ID', ''),
    db.getConfig('WB_DEFAULT_USER_ID', ''),
    db.getConfig('WB_AUTOLEAD_ON', '1'),
    db.getConfig('WB_AUTOLEAD_SOURCE', 'WhatsApp'),
    db.getConfig('WB_DEFAULT_COUNTRY_CODE', '91')   // India default
  ]);
  return { wabaId, token, phoneId, defaultStatus, defaultUser, autoLeadOn: String(autoLeadOn) === '1', autoLeadSource, defaultCC: (defaultCC || '91').replace(/\D/g, '') };
}

/**
 * Normalise a phone number to E.164-without-plus, the format Meta requires.
 *
 * Inputs we typically see:
 *   "9876543210"            (10-digit Indian mobile, no country code)
 *   "+91 9876 543 210"      (formatted with code)
 *   "91-9876543210"         (with code, no plus)
 *   "919876543210"          (already correct)
 *   "00919876543210"        (international 00 prefix)
 *
 * Strategy:
 *   1. Strip every non-digit.
 *   2. Drop a leading "00" (international long-distance prefix).
 *   3. If the result is exactly 10 digits AND starts with a valid Indian
 *      mobile-series digit (6/7/8/9), prepend the configured country code
 *      (default "91" for India) — this is the #1 cause of "sent but never
 *      delivered" because Meta silently drops sends to invalid numbers.
 *   4. Otherwise leave alone (assume the user knows what they're doing).
 */
function _normalizePhone(raw, defaultCC) {
  const cc = String(defaultCC || '91').replace(/\D/g, '') || '91';
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  // 10-digit Indian mobile: prepend country code
  if (d.length === 10 && /^[6-9]/.test(d)) d = cc + d;
  // 11-digit number that starts with 0 (e.g. "09876543210" — strip the trunk)
  else if (d.length === 11 && d.startsWith('0') && /^0[6-9]/.test(d)) d = cc + d.slice(1);
  return d;
}

async function _logActivity(payload) {
  try {
    await db.query(
      `INSERT INTO wa_activity_log (category, name, template_name, response_code, type, request_json, response_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        String(payload.category || 'chat'),
        String(payload.name || ''),
        String(payload.template_name || ''),
        Number(payload.response_code || 0) || null,
        String(payload.type || 'leads'),
        payload.request ? JSON.stringify(payload.request) : null,
        payload.response ? JSON.stringify(payload.response) : null
      ]
    );
  } catch (_) {}
}

/** Make an authenticated POST to the Meta Graph API. */
async function _graphPost(path, body, cfg) {
  const c = cfg || await _cfg();
  if (!c.token || !c.phoneId) throw new Error('WhatsApp not configured (set Account ID, Access Token, Phone Number ID first)');
  const r = await fetch(`${GRAPH}/${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  return { status: r.status, body: j };
}

/** Fetch JSON from the Graph API with the WABA token. */
async function _graphGet(path, cfg) {
  const c = cfg || await _cfg();
  if (!c.token) throw new Error('WhatsApp not configured');
  const r = await fetch(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(c.token)}`);
  const j = await r.json();
  return { status: r.status, body: j };
}

// ---------- Connect Account / Settings ----------------------------

async function api_wb_settings_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _cfg();
  const [verifyToken] = await Promise.all([
    db.getConfig('WHATSAPP_VERIFY_TOKEN', '')
  ]);
  const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');
  return {
    waba_id: cfg.wabaId || '',
    access_token_present: !!cfg.token,
    phone_number_id: cfg.phoneId || '',
    verify_token: verifyToken || '',
    webhook_url: (baseUrl || '') + '/hook/whatsapp_webhook',
    autolead_on: cfg.autoLeadOn,
    autolead_source: cfg.autoLeadSource,
    default_user_id: cfg.defaultUser,
    default_status_id: cfg.defaultStatus,
    default_country_code: cfg.defaultCC || '91',
    // Embedded Signup — platform credentials. The App ID & Config ID are
    // exposed because the FB JS SDK needs them in the browser to launch the
    // dialog. The App SECRET stays on the server only.
    fb_app_id: PLATFORM_FB_APP_ID,
    fb_app_secret_set: true,
    fb_config_id: PLATFORM_FB_CONFIG_ID,
    fb_platform_managed: true
  };
}

async function api_wb_settings_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if ('waba_id' in p)             await db.setConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', String(p.waba_id || '').trim());
  if ('access_token' in p && p.access_token) await db.setConfig('WHATSAPP_ACCESS_TOKEN', String(p.access_token).trim());
  if ('phone_number_id' in p)     await db.setConfig('WHATSAPP_PHONE_NUMBER_ID', String(p.phone_number_id || '').trim());
  if ('verify_token' in p)        await db.setConfig('WHATSAPP_VERIFY_TOKEN', String(p.verify_token || '').trim());
  if ('autolead_on' in p)         await db.setConfig('WB_AUTOLEAD_ON', p.autolead_on ? '1' : '0');
  if ('autolead_source' in p)     await db.setConfig('WB_AUTOLEAD_SOURCE', String(p.autolead_source || 'WhatsApp'));
  if ('default_user_id' in p)     await db.setConfig('WB_DEFAULT_USER_ID', String(p.default_user_id || ''));
  if ('default_status_id' in p)   await db.setConfig('WB_DEFAULT_STATUS_ID', String(p.default_status_id || ''));
  if ('default_country_code' in p) await db.setConfig('WB_DEFAULT_COUNTRY_CODE', String(p.default_country_code || '91').replace(/\D/g, '') || '91');
  // NOTE: fb_app_id / fb_app_secret / fb_config_id are platform-managed
  // constants now — silently ignored if a stale client tries to send them.
  return { ok: true };
}

/**
 * Embedded Signup callback — finishes the Facebook Login for Business flow:
 *   1. Receives the OAuth `code` plus the WABA ID and phone number ID that
 *      Facebook sent via postMessage during the dialog.
 *   2. Exchanges the code for a long-lived user access token using our app
 *      credentials.
 *   3. Persists everything to config (waba_id, phone_number_id, access_token).
 *   4. Subscribes the WABA to webhook events so inbound messages start flowing.
 *   5. Syncs the approved templates so the user sees them immediately.
 */
async function api_wb_emb_signin(token, code, phoneNumberId, wabaId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!code) throw new Error('Missing code from Facebook');
  if (!phoneNumberId || !wabaId) {
    throw new Error('Did not receive phone_number_id / waba_id from the dialog. Make sure your Login-for-Business config has WhatsApp asset selection enabled.');
  }
  // Platform-managed FB credentials — same for every tenant.
  const appId = PLATFORM_FB_APP_ID;
  const appSecret = PLATFORM_FB_APP_SECRET;

  // Exchange code → access token
  const exchangeUrl = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&code=${encodeURIComponent(code)}`;
  const r = await fetch(exchangeUrl);
  const j = await r.json();
  if (j.error || !j.access_token) {
    throw new Error('Token exchange failed: ' + (j.error?.message || 'no access_token returned'));
  }
  const accessToken = j.access_token;

  // Persist
  await db.setConfig('WHATSAPP_ACCESS_TOKEN', accessToken);
  await db.setConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', String(wabaId));
  await db.setConfig('WHATSAPP_PHONE_NUMBER_ID', String(phoneNumberId));

  // Subscribe the WABA to webhooks (so inbound messages reach our /hook)
  let subscribeOk = true; let subscribeErr = '';
  try {
    const sub = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
    });
    const sj = await sub.json();
    if (sj.error) { subscribeOk = false; subscribeErr = sj.error.message; }
  } catch (e) { subscribeOk = false; subscribeErr = e.message; }

  // Best-effort template sync — surface failure but don't block
  let templatesSynced = 0; let templateErr = '';
  try {
    const tr = await api_wb_templates_sync(token);
    templatesSynced = tr.count || 0;
  } catch (e) { templateErr = e.message; }

  // Auto-register with the central forwarder on smartcrmsolution.com so it
  // knows where to route Meta webhooks for this phone_number_id. Without
  // this, the admin would have to manually add a row to wa_connections.json
  // every time a client connected. Best-effort: failure is logged but
  // doesn't break the connect flow.
  let registerOk = false; let registerErr = '';
  try {
    const r = await _registerWithCentralForwarder({
      phoneNumberId, wabaId,
      tenantName: (await db.getConfig('COMPANY_NAME', '')) || 'Lead CRM',
      baseUrl: (process.env.BASE_URL || '').replace(/\/+$/, '') || ''
    });
    registerOk = r.ok; registerErr = r.error || '';
  } catch (e) { registerErr = e.message; }

  await _logActivity({
    category: 'template_sync', name: 'embedded_signup',
    response_code: 200,
    request: { phoneNumberId, wabaId },
    response: { subscribed: subscribeOk, templatesSynced, subscribeErr, templateErr, registerOk, registerErr }
  });

  return {
    ok: true,
    waba_id: String(wabaId),
    phone_number_id: String(phoneNumberId),
    subscribed: subscribeOk,
    subscribe_error: subscribeErr,
    templates_synced: templatesSynced,
    template_error: templateErr,
    forwarder_registered: registerOk,
    forwarder_error: registerErr
  };
}

/**
 * POST {phone_number_id, business_account_id, tenant_name, webhook_url}
 * to the central forwarder's registration endpoint. Skipped silently
 * when FORWARDER_REGISTER_URL or FORWARDER_REGISTER_SECRET env vars
 * aren't set (e.g. local dev). Used immediately after a successful
 * embedded sign-in so the forwarder learns about the new tenant
 * automatically.
 */
async function _registerWithCentralForwarder({ phoneNumberId, wabaId, tenantName, baseUrl }) {
  const url    = process.env.FORWARDER_REGISTER_URL || '';
  const secret = process.env.FORWARDER_REGISTER_SECRET || '';
  if (!url) return { ok: false, error: 'FORWARDER_REGISTER_URL not configured' };
  if (!secret) return { ok: false, error: 'FORWARDER_REGISTER_SECRET not configured' };
  if (!baseUrl) return { ok: false, error: 'BASE_URL not configured (cannot derive webhook_url)' };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Register-Secret': secret
      },
      body: JSON.stringify({
        phone_number_id:     String(phoneNumberId),
        business_account_id: String(wabaId),
        tenant_name:         String(tenantName || ''),
        webhook_url:         baseUrl + '/hook/whatsapp_webhook'
      })
    });
    const txt = await r.text();
    if (r.status >= 200 && r.status < 300) return { ok: true };
    return { ok: false, error: 'HTTP ' + r.status + ' · ' + (txt || '').slice(0, 300) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function api_wb_connect_verify(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _cfg();
  if (!cfg.wabaId || !cfg.token || !cfg.phoneId) throw new Error('Fill WABA ID, Access Token and Phone Number ID first.');
  // Hit /<phone-id> to get display number + quality + status
  const r = await _graphGet(`${cfg.phoneId}?fields=display_phone_number,verified_name,quality_rating,status,id`, cfg);
  if (r.body && r.body.error) {
    return { ok: false, error: r.body.error.message };
  }
  return {
    ok: true,
    display_phone_number: r.body.display_phone_number,
    verified_name: r.body.verified_name,
    quality_rating: r.body.quality_rating,
    status: r.body.status,
    phone_number_id: r.body.id
  };
}

async function api_wb_disconnect(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.setConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', '');
  await db.setConfig('WHATSAPP_ACCESS_TOKEN', '');
  await db.setConfig('WHATSAPP_PHONE_NUMBER_ID', '');
  return { ok: true };
}

/**
 * Register the WABA phone number with Cloud API. This is a one-time
 * step required by Meta after connecting a number — without it, every
 * send returns "account is not registered" / error code 133010.
 *
 * If two-factor authentication is OFF, pass pin: '000000'. If 2FA is
 * ON for the number, the user must pass the PIN they set when first
 * registering the number with WhatsApp.
 *
 * Doc: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/registration
 */
/**
 * List every phone number on the connected WhatsApp Business Account,
 * with its quality, status, verified name, and the phone_number_id
 * (used for sending). Useful when the WABA has multiple numbers — the
 * UI shows them as a table with a Register button per row.
 */
/**
 * Webhook health check — gives the admin everything they need to diagnose
 * "I sent a message but never got delivered / read / inbound".
 * Returns:
 *   - webhook_url + verify_token (so they can paste into Meta dashboard)
 *   - whether the WABA is subscribed to our app
 *   - the last inbound webhook entry timestamp (none → Meta isn't reaching us)
 *   - count of webhook events in last 24 h (sanity check)
 */
async function api_wb_webhook_status(token, clientOrigin) {
  await authUser(token);
  const cfg = await _cfg();
  // Prefer BASE_URL env var; fall back to whatever origin the browser is on
  // so the webhook URL is always resolvable even on un-configured deploys.
  const envBase = (process.env.BASE_URL || '').replace(/\/+$/, '');
  const clientBase = String(clientOrigin || '').replace(/\/+$/, '');
  const baseUrl = envBase || clientBase || '';

  // Auto-generate a verify token on first request if one isn't set —
  // saves the admin a step and makes the setup checklist usable
  // immediately. Token is a random 32-char hex string, stored in config.
  let verifyToken = await db.getConfig('WHATSAPP_VERIFY_TOKEN', '');
  if (!verifyToken) {
    try {
      const buf = require('crypto').randomBytes(16);
      verifyToken = buf.toString('hex');
      await db.setConfig('WHATSAPP_VERIFY_TOKEN', verifyToken);
    } catch (_) {}
  }

  let subscribed = null;
  let subscribeError = null;
  if (cfg.token && cfg.wabaId) {
    try {
      const r = await _graphGet(`${cfg.wabaId}/subscribed_apps`, cfg);
      if (r.body && r.body.error) subscribeError = r.body.error.message;
      else subscribed = (r.body.data || []).map(a => ({
        whatsapp_business_api_data: a.whatsapp_business_api_data || a,
        // Meta returns subscribed apps; if our app id is in the list, we're good.
        app_id: a.whatsapp_business_api_data?.id || a.id,
        app_name: a.whatsapp_business_api_data?.name || a.name,
        link: a.whatsapp_business_api_data?.link || ''
      }));
    } catch (e) { subscribeError = e.message; }
  }

  let last_inbound = null;
  let recent_count = 0;
  let last_status = null;
  try {
    const lr = await db.query(
      `SELECT recorded_on, category, name FROM wa_activity_log
        WHERE category IN ('webhook_in', 'webhook_status', 'webhook_message')
        ORDER BY recorded_on DESC LIMIT 1`
    );
    last_inbound = lr.rows[0] || null;
    const cr = await db.query(
      `SELECT COUNT(*)::int AS c FROM wa_activity_log
        WHERE category IN ('webhook_in', 'webhook_status', 'webhook_message')
          AND recorded_on > NOW() - INTERVAL '24 hours'`
    );
    recent_count = cr.rows[0]?.c || 0;
    const sr = await db.query(
      `SELECT recorded_on, name FROM wa_activity_log
        WHERE category = 'webhook_status' ORDER BY recorded_on DESC LIMIT 1`
    );
    last_status = sr.rows[0] || null;
  } catch (_) {}

  return {
    webhook_url: (baseUrl || '') + '/hook/whatsapp_webhook',
    verify_token: verifyToken || '',
    verify_token_set: !!verifyToken,
    subscribed,
    subscribe_error: subscribeError,
    last_inbound, last_status, recent_count_24h: recent_count
  };
}

/**
 * Subscribe our app to the WABA — required for Meta to push webhook
 * events to our /hook/whatsapp_webhook endpoint.
 */
async function api_wb_webhook_subscribe(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _cfg();
  if (!cfg.token || !cfg.wabaId) throw new Error('Connect WhatsApp first.');
  const r = await _graphPost(`${cfg.wabaId}/subscribed_apps`, {}, cfg);
  if (r.body?.error) throw new Error(r.body.error.message);
  await _logActivity({ category: 'chat', name: 'webhook_subscribe', response_code: r.status, request: { wabaId: cfg.wabaId }, response: r.body });
  return { ok: true, body: r.body };
}

async function api_wb_phones_list(token) {
  await authUser(token);
  const cfg = await _cfg();
  if (!cfg.token || !cfg.wabaId) throw new Error('Connect WhatsApp first.');
  const r = await _graphGet(
    `${cfg.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,status,name_status,code_verification_status,certificate,is_official_business_account,messaging_limit_tier,platform_type`,
    cfg
  );
  if (r.body && r.body.error) throw new Error(r.body.error.message);
  const rows = (r.body.data || []).map(p => ({
    id: p.id,
    display_phone_number: p.display_phone_number,
    verified_name: p.verified_name,
    quality_rating: p.quality_rating,
    status: p.status,
    name_status: p.name_status,
    code_verification_status: p.code_verification_status,
    is_official_business_account: !!p.is_official_business_account,
    messaging_limit_tier: p.messaging_limit_tier || '',
    platform_type: p.platform_type || '',
    is_current: String(p.id) === String(cfg.phoneId)
  }));
  return rows;
}

/**
 * Diagnostic — given a raw phone string, return what we'd actually send
 * to Meta and a quick sanity check on whether it looks deliverable.
 * Catches the most common "single tick but not delivered" failure mode:
 * 10-digit Indian number stored without country code.
 */
async function api_wb_phone_check(token, raw) {
  await authUser(token);
  const cfg = await _cfg();
  const original = String(raw || '');
  const stripped = original.replace(/\D/g, '');
  const normalised = _normalizePhone(original, cfg.defaultCC);
  const issues = [];
  if (!normalised) issues.push('Empty after normalisation');
  if (normalised && normalised.length < 10) issues.push('Too short (' + normalised.length + ' digits) — international numbers are 11-15 digits');
  if (normalised && normalised.length > 15) issues.push('Too long (' + normalised.length + ' digits)');
  if (stripped.length === 10 && /^[6-9]/.test(stripped) && cfg.defaultCC === '91') {
    issues.push('Was 10 digits — auto-prepended ' + cfg.defaultCC + ' as Indian country code');
  }
  return {
    original, normalised, country_code_used: cfg.defaultCC,
    looks_ok: issues.length === 0 || issues.every(i => i.startsWith('Was ')),
    issues
  };
}

async function api_wb_phones_set_current(token, phoneNumberId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!phoneNumberId) throw new Error('phoneNumberId required');
  await db.setConfig('WHATSAPP_PHONE_NUMBER_ID', String(phoneNumberId));
  return { ok: true };
}

async function api_wb_register_phone(token, pin, phoneIdOverride) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _cfg();
  if (!cfg.token) throw new Error('Connect WhatsApp first.');
  const phoneId = phoneIdOverride || cfg.phoneId;
  if (!phoneId) throw new Error('No phone_number_id available — connect a number first.');
  const usePin = String(pin || '000000').replace(/\D/g, '').slice(0, 6) || '000000';
  const r = await _graphPost(`${phoneId}/register`, {
    messaging_product: 'whatsapp',
    pin: usePin
  }, cfg);
  if (r.body?.error) {
    await _logActivity({ category: 'chat', name: 'register_phone', response_code: r.status, request: { pin: '***' }, response: r.body });
    throw new Error(r.body.error.message);
  }
  await _logActivity({ category: 'chat', name: 'register_phone', response_code: r.status, request: {}, response: r.body });
  return { ok: true, body: r.body };
}

// ---------- Templates ---------------------------------------------

/** Pull approved templates from Meta and cache locally. */
async function api_wb_templates_sync(token) {
  await authUser(token);
  const cfg = await _cfg();
  if (!cfg.wabaId || !cfg.token) throw new Error('WhatsApp not configured');
  const r = await _graphGet(`${cfg.wabaId}/message_templates?limit=100&fields=name,language,status,category,components`, cfg);
  if (r.body && r.body.error) {
    await _logActivity({ category: 'template_sync', response_code: r.status, request: { url: 'message_templates' }, response: r.body });
    throw new Error(r.body.error.message);
  }
  const list = r.body.data || [];
  // Replace the cache atomically
  await db.query('DELETE FROM wa_templates');
  for (const t of list) {
    const bodyText = (t.components || []).find(c => c.type === 'BODY')?.text || '';
    const params = (bodyText.match(/\{\{\d+\}\}/g) || []).length;
    const headerType = (t.components || []).find(c => c.type === 'HEADER')?.format || null;
    const hasBtn = !!(t.components || []).find(c => c.type === 'BUTTONS');
    try {
      await db.query(
        `INSERT INTO wa_templates (name, language, status, category, body_text, components_json, body_params, header_type, has_buttons, refreshed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
         ON CONFLICT (name, language) DO UPDATE
         SET status = EXCLUDED.status, category = EXCLUDED.category,
             body_text = EXCLUDED.body_text, components_json = EXCLUDED.components_json,
             body_params = EXCLUDED.body_params, header_type = EXCLUDED.header_type,
             has_buttons = EXCLUDED.has_buttons, refreshed_at = NOW()`,
        [t.name, t.language, t.status, t.category, bodyText, JSON.stringify(t.components || []), params, headerType, hasBtn ? 1 : 0]
      );
    } catch (_) {}
  }
  await _logActivity({ category: 'template_sync', response_code: 200, request: { url: 'message_templates' }, response: { count: list.length } });
  return { ok: true, count: list.length };
}

async function api_wb_templates_list(token) {
  await authUser(token);
  const rows = await db.getAll('wa_templates');
  return rows
    .map(r => ({
      id: r.id, name: r.name, language: r.language, status: r.status,
      category: r.category, body_text: r.body_text, body_params: r.body_params,
      header_type: r.header_type, has_buttons: !!r.has_buttons,
      components: typeof r.components_json === 'string' ? safeJson(r.components_json) : (r.components_json || []),
      refreshed_at: r.refreshed_at
    }))
    .sort((a, b) => (a.status === 'APPROVED' ? -1 : 1) - (b.status === 'APPROVED' ? -1 : 1) || String(a.name).localeCompare(String(b.name)));
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return []; } }

// ---------- Send a single template (used by chat + bots + campaigns) ----

async function _sendTemplate({ to, templateName, language, variables, imageUrl, leadId, userId }, cfg) {
  const c = cfg || await _cfg();
  // Components: BODY variables + optional HEADER image
  const components = [];
  if (imageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: imageUrl } }] });
  }
  if (Array.isArray(variables) && variables.length) {
    components.push({
      type: 'body',
      parameters: variables.map(v => ({ type: 'text', text: String(v ?? '') }))
    });
  }
  const body = {
    messaging_product: 'whatsapp',
    to: _normalizePhone(to, c.defaultCC),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'en_US' },
      components
    }
  };
  const r = await _graphPost(`${c.phoneId}/messages`, body, c);
  const waMsgId = r.body?.messages?.[0]?.id || null;
  const errorText = r.body?.error?.message || null;

  // Reconstruct a human-readable preview of the template (for the chat log).
  // Pulls the template's body_text from the cache and substitutes {{N}}.
  let preview = JSON.stringify({ template: templateName, variables });
  try {
    const tpl = await db.findOneBy('wa_templates', 'name', templateName);
    if (tpl && tpl.body_text) {
      preview = String(tpl.body_text).replace(/\{\{(\d+)\}\}/g, (_, n) => {
        const idx = Number(n) - 1;
        return (variables && variables[idx] != null) ? String(variables[idx]) : '{{' + n + '}}';
      });
    }
  } catch (_) {}

  try {
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, user_id, direction, from_number, to_number, body, wa_message_id, status, message_type, template_name, error_text, media_url)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, 'template', $8, $9, $10)`,
      [
        leadId || null, userId || null,
        c.phoneId, body.to, preview, waMsgId,
        r.body?.error ? 'failed' : 'sent',
        templateName, errorText, imageUrl || null
      ]
    );
    // Lead activity timeline log
    if (leadId) {
      try {
        require('./tat').logAction(leadId, 'whatsapp_out', userId || null, {
          template: templateName, preview: String(preview).slice(0, 200),
          error: errorText || null, type: 'template'
        });
      } catch (_) {}
    }
  } catch (_) {}
  return { status: r.status, body: r.body, wa_message_id: waMsgId, error: errorText };
}

async function _sendText({ to, text, replyTo, leadId, userId }, cfg) {
  const c = cfg || await _cfg();
  const body = {
    messaging_product: 'whatsapp',
    to: _normalizePhone(to, c.defaultCC),
    type: 'text',
    text: { body: String(text || '') }
  };
  if (replyTo) body.context = { message_id: replyTo };
  const r = await _graphPost(`${c.phoneId}/messages`, body, c);
  const waMsgId = r.body?.messages?.[0]?.id || null;
  const errorText = r.body?.error?.message || null;
  try {
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, user_id, direction, from_number, to_number, body, wa_message_id, status, message_type, reply_to, error_text)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, 'text', $8, $9)`,
      [leadId || null, userId || null, c.phoneId, body.to, text, waMsgId, r.body?.error ? 'failed' : 'sent', replyTo || null, errorText]
    );
    if (leadId) {
      try {
        require('./tat').logAction(leadId, 'whatsapp_out', userId || null, {
          preview: String(text || '').slice(0, 200),
          error: errorText || null, type: 'text'
        });
      } catch (_) {}
    }
  } catch (_) {}
  return { status: r.status, body: r.body, wa_message_id: waMsgId, error: errorText };
}

async function _sendMedia({ to, mediaType, mediaUrl, caption, leadId, userId }, cfg) {
  const c = cfg || await _cfg();
  const body = {
    messaging_product: 'whatsapp',
    to: _normalizePhone(to, c.defaultCC),
    type: mediaType,
    [mediaType]: { link: mediaUrl, caption: caption || undefined }
  };
  const r = await _graphPost(`${c.phoneId}/messages`, body, c);
  const waMsgId = r.body?.messages?.[0]?.id || null;
  const errorText = r.body?.error?.message || null;
  try {
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, user_id, direction, from_number, to_number, body, wa_message_id, status, message_type, media_url, error_text)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [leadId || null, userId || null, c.phoneId, body.to, caption || '', waMsgId, r.body?.error ? 'failed' : 'sent', mediaType, mediaUrl, errorText]
    );
    if (leadId) {
      try {
        require('./tat').logAction(leadId, 'whatsapp_out', userId || null, {
          preview: caption || '[' + mediaType + ']',
          error: errorText || null, type: mediaType
        });
      } catch (_) {}
    }
  } catch (_) {}
  return { status: r.status, body: r.body, wa_message_id: waMsgId, error: errorText };
}

/**
 * Send media by WhatsApp media_id (obtained from /api/wa/upload). Cleaner
 * than the link= variant because it doesn't require us to expose the file
 * publicly. The local mediaUrl (our /api/wa/attachment/:id endpoint) is
 * still saved into whatsapp_messages.media_url so the chat thread can
 * render the preview locally.
 */
async function _sendMediaById({ to, mediaType, mediaId, filename, caption, leadId, userId, mediaUrl }, cfg) {
  const c = cfg || await _cfg();
  const payload = { id: mediaId };
  if (caption && (mediaType === 'image' || mediaType === 'video' || mediaType === 'document')) {
    payload.caption = caption;
  }
  if (mediaType === 'document' && filename) payload.filename = filename;
  const body = {
    messaging_product: 'whatsapp',
    to: _normalizePhone(to, c.defaultCC),
    type: mediaType,
    [mediaType]: payload
  };
  const r = await _graphPost(`${c.phoneId}/messages`, body, c);
  const waMsgId = r.body?.messages?.[0]?.id || null;
  const errorText = r.body?.error?.message || null;
  try {
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, user_id, direction, from_number, to_number, body, wa_message_id, status, message_type, media_url, error_text)
       VALUES ($1, $2, 'out', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [leadId || null, userId || null, c.phoneId, body.to, caption || '', waMsgId, r.body?.error ? 'failed' : 'sent', mediaType, mediaUrl || null, errorText]
    );
    if (leadId) {
      try {
        require('./tat').logAction(leadId, 'whatsapp_out', userId || null, {
          preview: caption || ('[' + mediaType + (filename ? ': ' + filename : '') + ']'),
          error: errorText || null, type: mediaType
        });
      } catch (_) {}
    }
  } catch (_) {}
  return { status: r.status, body: r.body, wa_message_id: waMsgId, error: errorText };
}

/**
 * Upload a file to the WhatsApp Media API. Returns { id, mime_type } where
 * `id` is the WhatsApp media_id usable in subsequent /messages calls for
 * up to 30 days. Throws on Graph API errors.
 *
 * Args: buffer (Buffer), mimeType (e.g. 'image/jpeg'), filename, cfg
 */
async function _uploadMediaToWhatsApp(buffer, mimeType, filename, cfg) {
  const c = cfg || await _cfg();
  if (!c.token || !c.phoneId) throw new Error('WhatsApp not configured');
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('file', buffer, { filename: filename || 'upload.bin', contentType: mimeType });
  fd.append('type', mimeType);
  const r = await fetch(`${GRAPH}/${c.phoneId}/media`, {
    method: 'POST',
    headers: Object.assign({ Authorization: 'Bearer ' + c.token }, fd.getHeaders()),
    body: fd
  });
  const j = await r.json();
  if (!j.id) throw new Error(j.error?.message || 'Upload failed');
  return { id: j.id, mime_type: mimeType };
}

// ---------- Live Chat ---------------------------------------------

/**
 * If a chat just got assigned to user `newOwnerId`, mirror that on the
 * matching lead so reports / kanban / dashboards all line up with who's
 * actually handling the conversation. No-op if no lead is linked to
 * the phone, or if the lead is already owned by the same user.
 *
 * Called from every code path that changes a chat owner:
 *   - api_wb_chat_assign   (admin / manager picks an agent)
 *   - api_wb_chat_send     (auto-claim on send by a non-admin)
 *   - _autoAssignChat      (inbound auto-routing rule)
 */
async function _mirrorLeadOwner(phoneDigits, newOwnerId, actorId) {
  if (!phoneDigits || !newOwnerId) return;
  const lead = await _findLeadByPhoneDigits(phoneDigits);
  if (!lead) return;
  if (Number(lead.assigned_to) === Number(newOwnerId)) return;
  try {
    await db.update('leads', lead.id, { assigned_to: Number(newOwnerId) });
    try {
      require('./tat').logAction(lead.id, 'reassigned', actorId || null, {
        from: lead.assigned_to, to: Number(newOwnerId),
        reason: 'wa_chat_assignment'
      });
    } catch (_) {}
  } catch (_) {}
}

/**
 * Find the lead linked to a phone number, by exact digits match against
 * leads.phone OR leads.whatsapp. Returns null if no lead found.
 */
async function _findLeadByPhoneDigits(digits) {
  if (!digits) return null;
  try {
    const r = await db.query(
      `SELECT id, assigned_to, name FROM leads
         WHERE regexp_replace(COALESCE(phone, ''),    '\\D', '', 'g') = $1
            OR regexp_replace(COALESCE(whatsapp, ''), '\\D', '', 'g') = $1
         LIMIT 1`, [String(digits)]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

// =====================================================================
//  Auto-assignment rules (round-robin / least-busy / lead-owner / manual)
// =====================================================================

/**
 * Read the current auto-assign settings. Stored in admin_config so they
 * persist without a schema migration.
 *   mode  — 'lead_owner' | 'round_robin' | 'least_busy' | 'manual'
 *   pool  — CSV of user IDs eligible for round-robin / least-busy
 *   rrIdx — last assigned index (round-robin state)
 */
async function _autoAssignSettings() {
  const [mode, poolCsv, rrIdx] = await Promise.all([
    db.getConfig('WA_AUTO_ASSIGN_MODE',     'lead_owner'),
    db.getConfig('WA_AUTO_ASSIGN_POOL',     ''),
    db.getConfig('WA_AUTO_ASSIGN_RR_INDEX', '0')
  ]);
  return {
    mode: String(mode || 'lead_owner'),
    pool: String(poolCsv || '').split(',').map(s => Number(s)).filter(n => Number.isFinite(n) && n > 0),
    rrIdx: Number(rrIdx) || 0
  };
}

/**
 * Pick the next agent for a new inbound chat, based on the active rule.
 * Returns a userId or null. Never throws.
 */
async function _pickAutoAssignee(phone, leadId, leadAssignedTo) {
  try {
    const s = await _autoAssignSettings();

    // 'manual' — admin will assign by hand
    if (s.mode === 'manual') return null;

    // 'lead_owner' — natural owner from the linked lead, falls back to null
    if (s.mode === 'lead_owner') return Number(leadAssignedTo) || null;

    if (!s.pool.length) return Number(leadAssignedTo) || null;

    // 'round_robin' — pick s.pool[rrIdx % len], then advance the counter
    if (s.mode === 'round_robin') {
      const idx = ((s.rrIdx % s.pool.length) + s.pool.length) % s.pool.length;
      const pick = s.pool[idx];
      try {
        await db.setConfig('WA_AUTO_ASSIGN_RR_INDEX', String(s.rrIdx + 1));
      } catch (_) {}
      return Number(pick) || null;
    }

    // 'least_busy' — agent in pool with fewest active (open) chats today
    if (s.mode === 'least_busy') {
      try {
        const r = await db.query(
          `SELECT a.assigned_to, COUNT(*) AS open_chats
             FROM wa_chat_assignments a
             WHERE a.assigned_to = ANY($1::int[])
             GROUP BY a.assigned_to`,
          [s.pool]
        );
        const counts = {};
        s.pool.forEach(uid => { counts[uid] = 0; });
        r.rows.forEach(x => { counts[Number(x.assigned_to)] = Number(x.open_chats); });
        let bestUid = s.pool[0], bestCount = Infinity;
        s.pool.forEach(uid => {
          if (counts[uid] < bestCount) { bestUid = uid; bestCount = counts[uid]; }
        });
        return Number(bestUid) || null;
      } catch (_) { return Number(leadAssignedTo) || null; }
    }

    return Number(leadAssignedTo) || null;
  } catch (_) { return null; }
}

/**
 * Apply the auto-assign rule for a brand-new chat (no explicit
 * assignment yet). Persists the result into wa_chat_assignments +
 * wa_chat_assignment_log so the chat list shows the agent immediately.
 */
async function _autoAssignChat(phone, leadId, leadAssignedTo) {
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  if (!phoneDigits) return null;
  // Don't override an existing explicit assignment
  try {
    const r = await db.query(
      `SELECT assigned_to FROM wa_chat_assignments WHERE phone = $1 LIMIT 1`,
      [phoneDigits]
    );
    if (r.rows.length) return Number(r.rows[0].assigned_to) || null;
  } catch (_) {}
  const pick = await _pickAutoAssignee(phoneDigits, leadId, leadAssignedTo);
  if (!pick) return null;
  try {
    await db.query(
      `INSERT INTO wa_chat_assignments (phone, assigned_to, assigned_by, assigned_at, note)
       VALUES ($1, $2, NULL, NOW(), 'auto')
       ON CONFLICT (phone) DO NOTHING`,
      [phoneDigits, pick]
    );
    await db.insert('wa_chat_assignment_log', {
      phone: phoneDigits, assigned_to: pick, assigned_by: null, note: 'auto'
    });
  } catch (_) {}
  // Mirror onto the lead so the rest of the CRM (kanban, reports,
  // dashboards) follows who's actually owning the conversation.
  await _mirrorLeadOwner(phoneDigits, pick, null);
  return pick;
}

/**
 * Admin-only API: read the current auto-assign settings + the user roster
 * so the settings UI can populate the multi-select.
 */
async function api_wb_assign_settings_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const s = await _autoAssignSettings();
  const users = (await db.getAll('users')).filter(u => Number(u.is_active) !== 0)
    .map(u => ({ id: u.id, name: u.name, role: u.role }));
  return { mode: s.mode, pool: s.pool, users };
}

/**
 * Admin-only API: save the auto-assign settings.
 *   payload: { mode, pool: [userId, ...] }
 */
async function api_wb_assign_settings_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const validModes = ['lead_owner', 'round_robin', 'least_busy', 'manual'];
  if (!validModes.includes(p.mode)) throw new Error('Invalid mode');
  const pool = Array.isArray(p.pool) ? p.pool.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  await db.setConfig('WA_AUTO_ASSIGN_MODE', p.mode);
  await db.setConfig('WA_AUTO_ASSIGN_POOL', pool.join(','));
  // Reset round-robin counter when the pool changes so we don't skip names.
  await db.setConfig('WA_AUTO_ASSIGN_RR_INDEX', '0');
  return { ok: true, mode: p.mode, pool };
}

/**
 * Resolve the agent currently handling a conversation. Priority:
 *   1. Explicit row in wa_chat_assignments (set via api_wb_chat_assign,
 *      à la WATI / Interakt's "assign to agent")
 *   2. Lead's assigned_to (the natural owner)
 *   3. null — orphan thread, only admins can see
 */
async function _resolveChatOwner(phoneDigits, lead) {
  try {
    const r = await db.query(
      `SELECT assigned_to FROM wa_chat_assignments WHERE phone = $1 LIMIT 1`,
      [String(phoneDigits || '')]
    );
    if (r.rows[0] && r.rows[0].assigned_to) return Number(r.rows[0].assigned_to);
  } catch (_) {}
  return Number(lead?.assigned_to) || null;
}

/**
 * Build a map of { phone -> { assigned_to, assigned_at } } for a list of
 * phone numbers. Used by api_wb_chat_threads to hydrate the thread list
 * with the current assigned agent in one round-trip.
 */
async function _chatAssignmentsByPhone(phones) {
  if (!phones || !phones.length) return {};
  try {
    const r = await db.query(
      `SELECT phone, assigned_to, assigned_at FROM wa_chat_assignments
         WHERE phone = ANY($1::text[])`,
      [phones]
    );
    const m = {};
    r.rows.forEach(x => { m[String(x.phone)] = x; });
    return m;
  } catch (_) { return {}; }
}

/**
 * Privacy gate for the live-chat module. Admins can see every conversation
 * on the API number. Everyone else can only see conversations whose
 * resolved owner is in their visibility tree. Threads with NO owner are
 * admin-only — non-admins shouldn't see "stranger" inbound messages.
 */
async function _canSeeThread(me, visibleSet, ownerId) {
  if (me.role === 'admin') return true;
  const owner = Number(ownerId);
  if (!owner) return false;
  return visibleSet.has(owner);
}

/**
 * Conversation list — group whatsapp_messages by the OTHER party's number.
 * Returns one row per contact with last message preview, lead_id link,
 * and unread count. Filtered by what the caller is allowed to see.
 */
async function api_wb_chat_threads(token) {
  const me = await authUser(token);
  const visible = new Set((await getVisibleUserIds(me)).map(Number));

  // Pull last 1000 messages, group by counterpart
  const { rows } = await db.query(
    `SELECT id, lead_id, direction, from_number, to_number, body, message_type, status, read_at, created_at
       FROM whatsapp_messages
       ORDER BY created_at DESC
       LIMIT 1000`
  );
  const threads = new Map();
  rows.forEach(m => {
    const counter = m.direction === 'in' ? m.from_number : m.to_number;
    if (!counter) return;
    const k = String(counter);
    if (!threads.has(k)) {
      threads.set(k, {
        phone: k, lead_id: m.lead_id || null,
        last_message: m.body || '',
        last_message_type: m.message_type || 'text',
        last_at: m.created_at,
        unread: 0
      });
    }
    const t = threads.get(k);
    if (m.direction === 'in' && !m.read_at) t.unread++;
    if (!t.lead_id && m.lead_id) t.lead_id = m.lead_id;
  });

  // Hydrate with lead name + assignee, then drop threads the user can't see.
  const leadIds = [...new Set([...threads.values()].map(t => t.lead_id).filter(Boolean))];
  let leadById = {};
  if (leadIds.length) {
    const ld = await db.query(`SELECT id, name, assigned_to FROM leads WHERE id = ANY($1::int[])`, [leadIds]);
    ld.rows.forEach(l => { leadById[l.id] = l; });
  }
  const phones = [...threads.keys()];
  const explicit = await _chatAssignmentsByPhone(phones);
  const userIds = [...new Set([
    ...Object.values(explicit).map(e => e?.assigned_to).filter(Boolean),
    ...Object.values(leadById).map(l => l?.assigned_to).filter(Boolean)
  ])].map(Number);
  let usersById = {};
  if (userIds.length) {
    const u = await db.query(`SELECT id, name FROM users WHERE id = ANY($1::int[])`, [userIds]);
    u.rows.forEach(x => { usersById[x.id] = x; });
  }
  const out = [];
  for (const t of threads.values()) {
    const lead = t.lead_id ? leadById[t.lead_id] : null;
    const exp  = explicit[String(t.phone)];
    const ownerId = (exp && exp.assigned_to) ? Number(exp.assigned_to)
                  : (lead ? Number(lead.assigned_to) || null : null);
    if (!await _canSeeThread(me, visible, ownerId)) continue;
    out.push({
      ...t,
      lead_name: lead ? (lead.name || '') : '',
      assigned_to: ownerId,
      assigned_name: ownerId && usersById[ownerId] ? usersById[ownerId].name : '',
      assignment_explicit: !!(exp && exp.assigned_to)
    });
  }
  out.sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
  return out;
}

async function api_wb_chat_messages(token, phone) {
  const me = await authUser(token);
  if (!phone) return [];
  const p = String(phone).replace(/\D/g, '');
  // Reading a thread is permissive — any authenticated user can fetch
  // messages by phone (e.g. when opening a chat from the lead modal or
  // from the WhatsApp icon on the leads list). The threads-LIST is the
  // strict surface that hides other agents' work; once you have the
  // phone, you're allowed to see the history.

  const { rows } = await db.query(
    `SELECT id, direction, body, message_type, media_url, status, reply_to,
            created_at, read_at, delivered_at, error_text, template_name
       FROM whatsapp_messages
       WHERE from_number = $1 OR to_number = $1
       ORDER BY created_at ASC
       LIMIT 500`,
    [p]
  );
  // Mark inbound messages as read
  try {
    await db.query(
      `UPDATE whatsapp_messages SET read_at = NOW() WHERE direction = 'in' AND from_number = $1 AND read_at IS NULL`,
      [p]
    );
  } catch (_) {}
  return rows;
}

async function api_wb_chat_send(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.phone) throw new Error('phone required');
  if (!p.text && !p.media_url && !p.media_id) throw new Error('Empty message');
  const cfg = await _cfg();

  // Resolve lead_id from phone.
  let leadId = p.lead_id || null;
  const ph = String(p.phone).replace(/\D/g, '');
  const lead = await _findLeadByPhoneDigits(ph);
  if (lead) leadId = leadId || lead.id;
  const ownerId = await _resolveChatOwner(ph, lead);

  // Send-side rule (à la WATI / Intercom):
  //   - Admins can send anywhere.
  //   - Otherwise, anyone can SEND. The act of replying takes ownership of
  //     the conversation — we transparently re-assign the chat to the
  //     sender so the chat list reflects who's now handling it. This is
  //     the "auto-claim on send" pattern reps expect: if I reply, the
  //     chat becomes mine.
  //
  // Reading (api_wb_chat_threads / api_wb_chat_messages) stays strict —
  // reps only see chats currently assigned to them.
  if (me.role !== 'admin' && Number(ownerId) !== Number(me.id)) {
    try {
      await db.query(
        `INSERT INTO wa_chat_assignments (phone, assigned_to, assigned_by, assigned_at, note)
         VALUES ($1, $2, $3, NOW(), 'auto-claim on send')
         ON CONFLICT (phone) DO UPDATE
           SET assigned_to = EXCLUDED.assigned_to,
               assigned_by = EXCLUDED.assigned_by,
               assigned_at = NOW(),
               note        = EXCLUDED.note`,
        [ph, me.id, me.id]
      );
      await db.insert('wa_chat_assignment_log', {
        phone: ph, assigned_to: me.id, assigned_by: me.id, note: 'auto-claim on send'
      });
    } catch (_) {}
    // Mirror onto the lead so kanban/reports follow the new owner
    await _mirrorLeadOwner(ph, me.id, me.id);
  }

  let r;
  if (p.media_id) {
    // Media uploaded via /api/wa/upload — send by WA media_id.
    r = await _sendMediaById({
      to: p.phone, mediaType: p.media_type || 'image', mediaId: p.media_id,
      filename: p.filename || undefined, caption: p.text, leadId, userId: me.id,
      mediaUrl: p.media_url || null
    }, cfg);
  } else if (p.media_url) {
    r = await _sendMedia({ to: p.phone, mediaType: p.media_type || 'image', mediaUrl: p.media_url, caption: p.text, leadId, userId: me.id }, cfg);
  } else {
    r = await _sendText({ to: p.phone, text: p.text, replyTo: p.reply_to, leadId, userId: me.id }, cfg);
  }
  await _logActivity({ category: 'chat', response_code: r.status, request: { to: p.phone }, response: r.body });
  if (r.body?.error) throw new Error(r.body.error.message);
  return { ok: true, wa_message_id: r.wa_message_id };
}

/**
 * Assign a chat thread to a specific agent (à la WATI / Interakt).
 * Admins, managers, and team_leaders can change the assignment. Reps
 * can only assign chats to themselves (claim a chat). Writes the
 * current assignment to wa_chat_assignments and appends an audit row
 * to wa_chat_assignment_log.
 *
 * Args: (token, { phone, user_id, note? })
 *   - user_id may be null/0 to UNASSIGN (chat falls back to lead.assigned_to)
 */
async function api_wb_chat_assign(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const phone = String(p.phone || '').replace(/\D/g, '');
  if (!phone) throw new Error('phone required');

  let newOwner = p.user_id == null || p.user_id === '' ? null : Number(p.user_id);
  if (newOwner !== null && !Number.isFinite(newOwner)) throw new Error('Invalid user_id');

  // Permissions
  const isPriv = (me.role === 'admin' || me.role === 'manager' || me.role === 'team_leader');
  if (!isPriv) {
    // Non-priv users may only claim a chat for themselves.
    if (newOwner !== Number(me.id)) {
      throw new Error('Only admins / managers / team-leaders can assign chats to other agents');
    }
  }
  if (newOwner !== null) {
    const u = await db.findById('users', newOwner);
    if (!u) throw new Error('User not found');
  }

  // Upsert
  await db.query(
    `INSERT INTO wa_chat_assignments (phone, assigned_to, assigned_by, assigned_at, note)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (phone) DO UPDATE
       SET assigned_to = EXCLUDED.assigned_to,
           assigned_by = EXCLUDED.assigned_by,
           assigned_at = NOW(),
           note        = EXCLUDED.note`,
    [phone, newOwner, me.id, p.note || null]
  );
  await db.insert('wa_chat_assignment_log', {
    phone, assigned_to: newOwner, assigned_by: me.id, note: p.note || null
  });
  // Mirror onto the lead — when admin/manager assigns a chat to a rep,
  // the lead also belongs to that rep without needing a rule.
  if (newOwner) await _mirrorLeadOwner(phone, newOwner, me.id);
  return { ok: true, phone, assigned_to: newOwner };
}

/**
 * Return the assignment history for a phone number (newest first).
 * Used by the chat header to show who currently owns the chat plus
 * a small "↻ Reassigned 3 times" trail.
 */
async function api_wb_chat_assignments_list(token, phone) {
  await authUser(token);
  const p = String(phone || '').replace(/\D/g, '');
  if (!p) return { current: null, history: [] };
  const cur = await db.query(
    `SELECT a.phone, a.assigned_to, a.assigned_by, a.assigned_at, a.note,
            u.name AS assigned_name, ub.name AS assigned_by_name
       FROM wa_chat_assignments a
       LEFT JOIN users u  ON u.id  = a.assigned_to
       LEFT JOIN users ub ON ub.id = a.assigned_by
      WHERE phone = $1`, [p]);
  const hist = await db.query(
    `SELECT l.id, l.assigned_to, l.assigned_by, l.note, l.created_at,
            u.name AS assigned_name, ub.name AS assigned_by_name
       FROM wa_chat_assignment_log l
       LEFT JOIN users u  ON u.id  = l.assigned_to
       LEFT JOIN users ub ON ub.id = l.assigned_by
      WHERE phone = $1
      ORDER BY created_at DESC LIMIT 50`, [p]);
  return { current: cur.rows[0] || null, history: hist.rows };
}

/**
 * Initiate Chat — send a TEMPLATE message to a single contact, used by
 * the green WhatsApp icon in the leads list. Variables and image URL are
 * optional. Persisted into whatsapp_messages so the message appears in
 * the Chat tab thread; status/read receipts arrive via the webhook.
 *
 * Args: (token, { lead_id?, phone, template_name, template_language?, variables?, image_url? })
 */
async function api_wb_initiate_chat(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.phone)         throw new Error('phone required');
  if (!p.template_name) throw new Error('template_name required');
  const cfg = await _cfg();
  if (!cfg.token || !cfg.phoneId) throw new Error('WhatsApp not connected. Settings → WhatsBot → Connect Account.');

  // Render @{merge} fields against the lead, if a lead_id is supplied.
  let lead = null;
  if (p.lead_id) {
    try { lead = await db.findById('leads', p.lead_id); } catch (_) {}
  }
  const rendered = (p.variables || []).map(v => _renderMerge(String(v ?? ''), lead, { phone: p.phone }));

  const r = await _sendTemplate({
    to: p.phone, templateName: p.template_name, language: p.template_language || 'en_US',
    variables: rendered, imageUrl: p.image_url || null,
    leadId: p.lead_id || null, userId: me.id
  }, cfg);

  await _logActivity({
    category: 'chat', name: 'initiate_chat', template_name: p.template_name,
    response_code: r.status, request: { to: p.phone, vars: rendered },
    response: r.body
  });
  if (r.body?.error) throw new Error(r.body.error.message);
  return { ok: true, wa_message_id: r.wa_message_id };
}

// ---------- Message Bots ------------------------------------------

async function api_wb_message_bots_list(token) {
  await authUser(token);
  return await db.getAll('wa_message_bots');
}
async function api_wb_message_bots_save(token, bot) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const b = bot || {};
  if (!b.name || !b.trigger_text || !b.reply_text) throw new Error('name, trigger_text, reply_text required');
  const payload = {
    name: b.name, relation_type: b.relation_type || 'leads',
    reply_text: b.reply_text, reply_type: b.reply_type || 'contains',
    trigger_text: b.trigger_text, header: b.header || null, footer: b.footer || null,
    buttons_json: b.buttons ? JSON.stringify(b.buttons) : null,
    cta_button_json: b.cta_button ? JSON.stringify(b.cta_button) : null,
    image_url: b.image_url || null,
    is_active: b.is_active === 0 ? 0 : 1
  };
  if (b.id) { await db.update('wa_message_bots', b.id, payload); return { ok: true, id: Number(b.id) }; }
  payload.created_at = db.nowIso();
  const id = await db.insert('wa_message_bots', payload);
  return { ok: true, id };
}
async function api_wb_message_bots_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.removeRow('wa_message_bots', id);
  return { ok: true };
}

// ---------- Template Bots -----------------------------------------

async function api_wb_template_bots_list(token) {
  await authUser(token);
  return await db.getAll('wa_template_bots');
}
async function api_wb_template_bots_save(token, bot) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const b = bot || {};
  if (!b.name || !b.template_name || !b.trigger_text) throw new Error('name, template_name, trigger_text required');
  const payload = {
    name: b.name, relation_type: b.relation_type || 'leads',
    template_name: b.template_name, template_language: b.template_language || 'en_US',
    variables_json: b.variables ? JSON.stringify(b.variables) : null,
    reply_type: b.reply_type || 'exact', trigger_text: b.trigger_text,
    is_active: b.is_active === 0 ? 0 : 1
  };
  if (b.id) { await db.update('wa_template_bots', b.id, payload); return { ok: true, id: Number(b.id) }; }
  payload.created_at = db.nowIso();
  const id = await db.insert('wa_template_bots', payload);
  return { ok: true, id };
}
async function api_wb_template_bots_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.removeRow('wa_template_bots', id);
  return { ok: true };
}

// ---------- Campaigns ---------------------------------------------

async function api_wb_campaigns_list(token) {
  await authUser(token);
  const rows = await db.getAll('wa_campaigns');
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows.map(c => ({
    ...c,
    variables: typeof c.variables_json === 'string' ? safeJson(c.variables_json) : (c.variables_json || []),
    filter:    typeof c.filter_json === 'string'    ? safeJsonObj(c.filter_json) : (c.filter_json || {}),
  }));
}
function safeJsonObj(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

async function api_wb_campaigns_create(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.name || !p.template_name) throw new Error('name and template_name required');

  // Resolve recipients NOW so we can compute total + queue them in wa_campaign_targets
  const filter = p.filter || {};
  let leads = [];
  if (filter.lead_ids && filter.lead_ids.length) {
    const ld = await db.query(`SELECT id, name, phone, source FROM leads WHERE id = ANY($1::int[])`, [filter.lead_ids.map(Number)]);
    leads = ld.rows;
  } else {
    const all = await db.getAll('leads');
    leads = all.filter(l => {
      if (filter.status_id && Number(l.status_id) !== Number(filter.status_id)) return false;
      if (filter.source && l.source !== filter.source) return false;
      if (filter.assigned_to && Number(l.assigned_to) !== Number(filter.assigned_to)) return false;
      if (filter.tag) {
        const tags = String(l.tags || '').toLowerCase().split(',').map(s => s.trim());
        if (!tags.includes(String(filter.tag).toLowerCase())) return false;
      }
      return !!l.phone;
    });
  }

  const campaignPayload = {
    name: p.name,
    relation_type: p.relation_type || 'leads',
    template_name: p.template_name,
    template_language: p.template_language || 'en_US',
    variables_json: JSON.stringify(p.variables || []),
    image_url: p.image_url || null,
    filter_json: JSON.stringify(filter),
    scheduled_at: p.scheduled_at || null,
    send_now: p.send_now ? 1 : 0,
    status: p.send_now ? 'queued' : (p.scheduled_at ? 'queued' : 'draft'),
    recipients_total: leads.length,
    recipients_sent: 0, recipients_failed: 0,
    recipients_delivered: 0, recipients_read: 0,
    created_by: me.id,
    created_at: db.nowIso()
  };
  const campaignId = await db.insert('wa_campaigns', campaignPayload);

  // Materialise per-recipient rows
  for (const l of leads) {
    await db.insert('wa_campaign_targets', {
      campaign_id: campaignId,
      lead_id: l.id, phone: String(l.phone || '').replace(/\D/g, ''),
      name: l.name || '',
      status: 'queued', created_at: db.nowIso()
    });
  }

  return { ok: true, id: campaignId, recipients: leads.length };
}

async function api_wb_campaigns_send_now(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin or Manager only');
  const c = await db.findById('wa_campaigns', id);
  if (!c) throw new Error('Campaign not found');
  if (c.status === 'sending') return { ok: true, already: true };
  await db.update('wa_campaigns', id, { status: 'queued', send_now: 1, scheduled_at: null });
  // Trigger immediate worker tick (don't await)
  setImmediate(() => _campaignTick().catch(e => console.warn('[wb] campaign tick failed:', e.message)));
  return { ok: true };
}

async function api_wb_campaigns_pause(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin or Manager only');
  await db.update('wa_campaigns', id, { status: 'paused' });
  return { ok: true };
}

async function api_wb_campaigns_targets(token, id) {
  await authUser(token);
  const { rows } = await db.query(
    `SELECT * FROM wa_campaign_targets WHERE campaign_id = $1 ORDER BY id ASC LIMIT 1000`,
    [Number(id)]
  );
  return rows;
}

// ---------- Activity Log ------------------------------------------

async function api_wb_activity_list(token, filters) {
  await authUser(token);
  filters = filters || {};
  const cat = filters.category;
  const search = String(filters.q || '').trim();
  let { rows } = await db.query(
    `SELECT id, category, name, template_name, response_code, type, recorded_on
       FROM wa_activity_log
       ORDER BY recorded_on DESC LIMIT 500`
  );
  if (cat)    rows = rows.filter(r => r.category === cat);
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(r =>
      String(r.name || '').toLowerCase().includes(s) ||
      String(r.template_name || '').toLowerCase().includes(s) ||
      String(r.category || '').toLowerCase().includes(s)
    );
  }
  return rows;
}

/**
 * Full payload for a single activity log row — request + response JSON.
 * Used by the "View" button on each Activity Log row to reveal the full
 * Meta API exchange.
 */
async function api_wb_activity_get(token, id) {
  await authUser(token);
  const r = await db.findById('wa_activity_log', id);
  if (!r) throw new Error('Not found');
  return {
    id: r.id, category: r.category, name: r.name, template_name: r.template_name,
    response_code: r.response_code, type: r.type, recorded_on: r.recorded_on,
    request: typeof r.request_json === 'string' ? safeJsonObj(r.request_json) : (r.request_json || {}),
    response: typeof r.response_json === 'string' ? safeJsonObj(r.response_json) : (r.response_json || {})
  };
}

/**
 * Plain-text dump of recent webhook events — designed to be downloaded
 * as wa_webhook_logs.txt for offline / shared analysis. Includes raw
 * request + response JSON for every webhook_in / webhook_status /
 * webhook_message entry, newest first.
 */
async function api_wb_webhook_logs_text(token) {
  await authUser(token);
  const { rows } = await db.query(
    `SELECT id, category, name, response_code, type, request_json, response_json, recorded_on
       FROM wa_activity_log
       WHERE category IN ('webhook_in', 'webhook_status', 'webhook_message')
       ORDER BY recorded_on DESC LIMIT 500`
  );
  const lines = [];
  lines.push('=========================================================');
  lines.push('  WhatsApp Webhook Log');
  lines.push('  Generated: ' + new Date().toISOString());
  lines.push('  Total entries: ' + rows.length);
  lines.push('  (newest first, max 500)');
  lines.push('=========================================================');
  lines.push('');
  for (const r of rows) {
    lines.push('---------------------------------------------------------');
    lines.push('[' + r.recorded_on + ']  ' + r.category + ' / ' + (r.name || '-') + '  (HTTP ' + (r.response_code || '-') + ')');
    const req = typeof r.request_json === 'string' ? safeJsonObj(r.request_json) : (r.request_json || {});
    const res = typeof r.response_json === 'string' ? safeJsonObj(r.response_json) : (r.response_json || {});
    if (req && Object.keys(req).length) {
      lines.push('  Request:  ' + JSON.stringify(req));
    }
    if (res && Object.keys(res).length) {
      lines.push('  Response: ' + JSON.stringify(res, null, 0));
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function api_wb_activity_clear(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.query(`DELETE FROM wa_activity_log`);
  return { ok: true };
}

/**
 * Background trim: drop wa_activity_log rows older than 24 h.
 * Called every 60 min by a setInterval in server.js. The table grows
 * fast (every Meta delivery / read receipt / inbound message + every
 * outbound send all log here), so without this it bloats and slows
 * the Activity Log render. 24 h of recent data is plenty for
 * troubleshooting; longer history was never useful in practice.
 */
async function trimActivityLog() {
  try {
    const r = await db.query(
      `DELETE FROM wa_activity_log WHERE recorded_on < NOW() - INTERVAL '24 hours'`
    );
    if (r && r.rowCount) console.log('[wb] activity-log trim: deleted', r.rowCount, 'rows older than 24h');
  } catch (e) {
    console.error('[wb] activity-log trim failed:', e.message);
  }
}

// ---------- Campaign worker ---------------------------------------

let _campaignWorkerStarted = false;
function startCampaignWorker() {
  if (_campaignWorkerStarted) return;
  _campaignWorkerStarted = true;
  const intervalMs = Number(process.env.WB_CAMPAIGN_TICK_MS || 30_000);
  setInterval(() => { _campaignTick().catch(e => console.warn('[wb] campaign tick failed:', e.message)); }, intervalMs);
  setTimeout(() => _campaignTick().catch(() => {}), 15_000);
  console.log(`[wb] campaign worker started, interval ${intervalMs}ms`);
}

async function _campaignTick() {
  // Find queued campaigns whose scheduled_at has passed (or send_now=1)
  const { rows: due } = await db.query(
    `SELECT * FROM wa_campaigns
       WHERE status IN ('queued', 'sending')
         AND (send_now = 1 OR scheduled_at IS NULL OR scheduled_at <= NOW())
       ORDER BY id ASC`
  );
  if (!due.length) return;
  const cfg = await _cfg();
  if (!cfg.token || !cfg.phoneId) return; // not configured

  for (const camp of due) {
    if (camp.status !== 'sending') {
      await db.update('wa_campaigns', camp.id, { status: 'sending', started_at: db.nowIso() });
    }
    const variables = typeof camp.variables_json === 'string' ? safeJson(camp.variables_json) : (camp.variables_json || []);
    // Pull pending targets in batches of 25 to stay under Meta rate limits
    const { rows: targets } = await db.query(
      `SELECT * FROM wa_campaign_targets WHERE campaign_id = $1 AND status = 'queued' ORDER BY id ASC LIMIT 25`,
      [camp.id]
    );
    if (!targets.length) {
      await db.update('wa_campaigns', camp.id, { status: 'completed', completed_at: db.nowIso() });
      continue;
    }
    for (const t of targets) {
      try {
        // Render variables — replace @{lead_field} placeholders with actual values
        const lead = t.lead_id ? await db.findById('leads', t.lead_id) : null;
        const renderedVars = (variables || []).map(v => _renderMerge(v.value || '', lead, t));
        const r = await _sendTemplate({
          to: t.phone, templateName: camp.template_name, language: camp.template_language,
          variables: renderedVars, imageUrl: camp.image_url || null
        }, cfg);
        if (r.body?.error) {
          await db.update('wa_campaign_targets', t.id, { status: 'failed', error: r.body.error.message, sent_at: db.nowIso() });
          await db.update('wa_campaigns', camp.id, { recipients_failed: Number(camp.recipients_failed || 0) + 1 });
          camp.recipients_failed = Number(camp.recipients_failed || 0) + 1;
        } else {
          await db.update('wa_campaign_targets', t.id, { status: 'sent', wa_message_id: r.wa_message_id, sent_at: db.nowIso() });
          await db.update('wa_campaigns', camp.id, { recipients_sent: Number(camp.recipients_sent || 0) + 1 });
          camp.recipients_sent = Number(camp.recipients_sent || 0) + 1;
        }
        await _logActivity({
          category: 'campaign', name: camp.name, template_name: camp.template_name,
          response_code: r.status, type: camp.relation_type,
          request: { to: t.phone, vars: renderedVars }, response: r.body
        });
      } catch (e) {
        await db.update('wa_campaign_targets', t.id, { status: 'failed', error: e.message, sent_at: db.nowIso() });
        await db.update('wa_campaigns', camp.id, { recipients_failed: Number(camp.recipients_failed || 0) + 1 });
        camp.recipients_failed = Number(camp.recipients_failed || 0) + 1;
      }
      // Tiny pause between sends — keeps us well under 80msg/sec
      await new Promise(r => setTimeout(r, 100));
    }
    // Check if there are more queued targets
    const { rows: rem } = await db.query(
      `SELECT COUNT(*)::int AS c FROM wa_campaign_targets WHERE campaign_id = $1 AND status = 'queued'`,
      [camp.id]
    );
    if (!rem[0]?.c) {
      await db.update('wa_campaigns', camp.id, { status: 'completed', completed_at: db.nowIso() });
    }
  }
}

/** Render a campaign-variable merge field. Supports @{name}, @{phone}, @{email}, @{firstname}, etc. */
function _renderMerge(template, lead, target) {
  if (!template) return '';
  const ctx = lead || {};
  return String(template).replace(/@\{(\w+)\}/g, (_, key) => {
    const k = key.toLowerCase();
    if (k === 'firstname' || k === 'first_name') return String(ctx.name || target?.name || '').split(' ')[0] || '';
    if (k === 'lastname' || k === 'last_name')   return String(ctx.name || target?.name || '').split(' ').slice(1).join(' ') || '';
    if (k === 'name')   return String(ctx.name || target?.name || '');
    if (k === 'phone')  return String(ctx.phone || target?.phone || '');
    if (k === 'email')  return String(ctx.email || '');
    if (k === 'source') return String(ctx.source || '');
    if (ctx[k] !== undefined) return String(ctx[k]);
    return '';
  });
}

// ---------- Webhook (incoming message → bot fire / save / autolead) ------

async function expressVerify(req, res) {
  const verifyToken = await db.getConfig('WHATSAPP_VERIFY_TOKEN', '');
  const mode = req.query['hub.mode'];
  const tk = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && tk && verifyToken && tk === verifyToken) {
    return res.status(200).send(String(challenge));
  }
  return res.status(403).send('forbidden');
}

async function expressEvent(req, res) {
  res.status(200).send('ok'); // Always 200 fast — process async
  try {
    // Be lenient about body shape — many setups put a forwarder /
    // proxy in front of Meta's webhook (one central URL → many
    // tenants), and the forwarder may wrap, rename, or strip the
    // top-level `object` field. We accept any of:
    //   { object: 'whatsapp_business_account', entry: [...] }
    //   { entry: [...] }
    //   { payload: { object: ..., entry: [...] } }   // wrapped
    //   { data: { entry: [...] } }                    // wrapped
    //   "<json string>"                              // text/plain body
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    // Unwrap one common nesting level
    if (!body.entry && body.payload && body.payload.entry) body = body.payload;
    if (!body.entry && body.data && body.data.entry) body = body.data;

    // Always log the raw inbound payload so the user can review every webhook
    // hit, regardless of whether we end up acting on it.
    try {
      await _logActivity({
        category: 'webhook_in', name: body.object || 'forwarded',
        response_code: 200,
        request: { headers: { 'user-agent': req.get('user-agent'), 'content-type': req.get('content-type') } },
        response: body
      });
    } catch (_) {}

    // Process any payload that has the right SHAPE (entry[].changes[].value
    // with messages or statuses). object is no longer a hard gate — your
    // forwarder may strip it. The shape itself is unique to WA Cloud API.
    if (!Array.isArray(body.entry)) return;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        // Status updates (sent / delivered / read / failed). For 'failed'
        // Meta also sends an `errors[]` array with a code + title + reason —
        // capture the first one in error_text so the chat UI can display it.
        if (Array.isArray(value.statuses)) {
          for (const s of value.statuses) {
            // Per-status pretty log entry
            try {
              await _logActivity({
                category: 'webhook_status', name: s.status || 'unknown',
                response_code: 200,
                request: { wa_message_id: s.id, recipient: s.recipient_id, conversation: s.conversation?.id, pricing: s.pricing },
                response: s
              });
            } catch (_) {}
            const upd = {};
            if (s.status === 'delivered') upd.delivered_at = db.nowIso();
            if (s.status === 'read')      upd.read_at = db.nowIso();
            if (s.status) upd.status = s.status;
            const err = (s.errors && s.errors[0]) ? (s.errors[0].title || s.errors[0].message || s.errors[0].error_data?.details || JSON.stringify(s.errors[0])) : null;
            if (s.id && (Object.keys(upd).length || err)) {
              try {
                await db.query(
                  `UPDATE whatsapp_messages
                      SET status = COALESCE($2, status),
                          delivered_at = COALESCE($3, delivered_at),
                          read_at = COALESCE($4, read_at),
                          error_text = COALESCE($5, error_text)
                    WHERE wa_message_id = $1`,
                  [s.id, upd.status || null, upd.delivered_at || null, upd.read_at || null, err]
                );
                // Reflect into campaign_targets too
                if (s.status === 'delivered' || s.status === 'read') {
                  const col = s.status === 'read' ? 'read_at' : 'delivered_at';
                  await db.query(
                    `UPDATE wa_campaign_targets SET status = $2, ${col} = NOW() WHERE wa_message_id = $1 AND status NOT IN ('failed')`,
                    [s.id, s.status]
                  );
                } else if (s.status === 'failed') {
                  await db.query(
                    `UPDATE wa_campaign_targets SET status = 'failed', error = $2 WHERE wa_message_id = $1`,
                    [s.id, err || 'failed']
                  );
                }
              } catch (_) {}
            }
          }
        }
        // Inbound messages
        if (Array.isArray(value.messages)) {
          for (const m of value.messages) {
            await _handleInbound(m, value);
          }
        }
      }
    }
  } catch (e) {
    console.error('[wb] webhook event failed:', e.message);
  }
}

async function _handleInbound(m, value) {
  const cfg = await _cfg();
  const from = String(m.from || '').replace(/\D/g, '');
  const to = String(value?.metadata?.display_phone_number || cfg.phoneId || '');
  // Log the inbound message so admins see it in Activity Log
  try {
    await _logActivity({
      category: 'webhook_message', name: m.type || 'text',
      response_code: 200,
      request: { from, to },
      response: m
    });
  } catch (_) {}
  let text = '';
  let mtype = m.type || 'text';
  let mediaId = null;
  if (m.type === 'text') text = m.text?.body || '';
  else if (m.type === 'interactive') {
    text = m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || JSON.stringify(m.interactive || {});
  } else if (m.type === 'button') {
    text = m.button?.text || '';
  } else if (['image', 'audio', 'video', 'document'].includes(m.type)) {
    text = m[m.type]?.caption || '';
    mediaId = m[m.type]?.id || null;
  }

  // Look up or auto-create the lead
  let leadId = null;
  try {
    const ld = await db.query(`SELECT id FROM leads WHERE regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1 OR regexp_replace(COALESCE(whatsapp, ''), '\\D', '', 'g') = $1 LIMIT 1`, [from]);
    if (ld.rows.length) leadId = ld.rows[0].id;
    else if (cfg.autoLeadOn) {
      // Create a fresh lead for this inbound contact
      const profileName = (value?.contacts || []).find(c => c.wa_id === m.from)?.profile?.name || from;
      const newId = await db.insert('leads', {
        name: profileName, phone: from, whatsapp: from,
        source: cfg.autoLeadSource || 'WhatsApp',
        status_id: cfg.defaultStatus || null,
        assigned_to: cfg.defaultUser || null,
        created_at: db.nowIso(), updated_at: db.nowIso()
      });
      leadId = newId;
      try { require('./tat').logAction(newId, 'created', null, { source: 'whatsapp_inbound' }); } catch (_) {}
    }
  } catch (_) {}

  // Save inbound row
  try {
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, direction, from_number, to_number, body, wa_message_id, status, message_type, media_id)
       VALUES ($1, 'in', $2, $3, $4, $5, 'received', $6, $7)`,
      [leadId, from, to, text, m.id || null, mtype, mediaId]
    );
    if (leadId) {
      try {
        require('./tat').logAction(leadId, 'whatsapp_in', null, {
          preview: String(text || '').slice(0, 200),
          type: mtype, from
        });
      } catch (_) {}
    }
  } catch (e) { console.warn('[wb] save inbound failed:', e.message); }

  // Auto-assign the chat if no explicit assignment exists yet — applies
  // the active rule (lead_owner / round_robin / least_busy / manual).
  try {
    let leadAssignedTo = null;
    if (leadId) {
      const ld = await db.findById('leads', leadId);
      leadAssignedTo = ld ? ld.assigned_to : null;
    }
    await _autoAssignChat(from, leadId, leadAssignedTo);
  } catch (e) { console.warn('[wb] auto-assign failed:', e.message); }

  // Try matching a Message Bot or Template Bot by trigger
  try {
    const triggerLc = String(text || '').toLowerCase().trim();
    if (!triggerLc) return;

    const msgBots = await db.getAll('wa_message_bots');
    for (const b of msgBots) {
      if (Number(b.is_active) !== 1) continue;
      const triggers = String(b.trigger_text || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const hit = (b.reply_type === 'exact')
        ? triggers.includes(triggerLc)
        : triggers.some(t => triggerLc.includes(t));
      if (!hit) continue;
      const replyText = [b.header, b.reply_text, b.footer].filter(Boolean).join('\n');
      const r = await _sendText({ to: from, text: replyText }, cfg);
      await _logActivity({
        category: 'message_bot', name: b.name, response_code: r.status,
        request: { to: from, trigger: triggerLc }, response: r.body
      });
      return; // first match wins
    }

    const tplBots = await db.getAll('wa_template_bots');
    for (const b of tplBots) {
      if (Number(b.is_active) !== 1) continue;
      const triggers = String(b.trigger_text || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const hit = (b.reply_type === 'exact')
        ? triggers.includes(triggerLc)
        : triggers.some(t => triggerLc.includes(t));
      if (!hit) continue;
      const variables = typeof b.variables_json === 'string' ? safeJson(b.variables_json) : (b.variables_json || []);
      const lead = leadId ? await db.findById('leads', leadId) : null;
      const renderedVars = (variables || []).map(v => _renderMerge(v.value || v, lead, { phone: from }));
      const r = await _sendTemplate({
        to: from, templateName: b.template_name, language: b.template_language,
        variables: renderedVars
      }, cfg);
      await _logActivity({
        category: 'template_bot', name: b.name, template_name: b.template_name,
        response_code: r.status, request: { to: from, trigger: triggerLc }, response: r.body
      });
      return;
    }
  } catch (e) { console.warn('[wb] bot dispatch failed:', e.message); }
}

module.exports = {
  // Settings
  api_wb_settings_get, api_wb_settings_save, api_wb_connect_verify, api_wb_disconnect,
  api_wb_emb_signin, api_wb_register_phone,
  api_wb_phones_list, api_wb_phones_set_current, api_wb_phone_check,
  api_wb_webhook_status, api_wb_webhook_subscribe,
  // Templates
  api_wb_templates_sync, api_wb_templates_list,
  // Chat
  api_wb_chat_threads, api_wb_chat_messages, api_wb_chat_send, api_wb_initiate_chat,
  api_wb_chat_assign, api_wb_chat_assignments_list,
  api_wb_assign_settings_get, api_wb_assign_settings_save,
  // Bots
  api_wb_message_bots_list, api_wb_message_bots_save, api_wb_message_bots_delete,
  api_wb_template_bots_list, api_wb_template_bots_save, api_wb_template_bots_delete,
  // Campaigns
  api_wb_campaigns_list, api_wb_campaigns_create, api_wb_campaigns_send_now,
  api_wb_campaigns_pause, api_wb_campaigns_targets,
  // Activity
  api_wb_activity_list, api_wb_activity_get, api_wb_activity_clear,
  api_wb_webhook_logs_text,
  // Express
  expressVerify, expressEvent,
  // Worker + scheduled tasks
  startCampaignWorker,
  trimActivityLog,
  // Helpers exported for the file-upload Express route in server.js
  _cfg, _uploadMediaToWhatsApp, _findLeadByPhoneDigits, _canSeeThread,
  getVisibleUserIds
};
