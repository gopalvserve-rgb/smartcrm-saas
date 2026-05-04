/**
 * routes/admin.js — settings + integration tests
 *
 * Config is stored in the `config` table so changes persist across restarts.
 * We fall back to process.env for anything not in the DB, so a fresh install
 * uses values from .env.
 */
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const CONFIG_KEYS = [
  'COMPANY_NAME', 'COMPANY_LOGO_URL',
  'META_APP_ID', 'META_APP_SECRET', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN', 'META_VERIFY_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_VERIFY_TOKEN',
  'WEBSITE_API_KEY',
  'ENFORCE_GPS', 'OFFICE_LAT', 'OFFICE_LNG', 'OFFICE_RADIUS_M',
  'WORK_START', 'WORK_END', 'WEEKLY_OFFS',
  'DUPLICATE_POLICY', 'DUPLICATE_WINDOW_HOURS', 'DUPLICATE_MATCH_FIELDS', 'DEFAULT_LEAD_COLUMNS',
  'EMAIL_NOTIFY_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD',
  'EMAIL_NOTIFY_FROM', 'EMAIL_NOTIFY_SUBJECT_PREFIX', 'FOLLOWUP_REMIND_MIN',
  'SHOW_LEADS_HEADER',
  // CSV of NAV item IDs the admin has hidden in the sidebar for this tenant.
  'HIDDEN_NAV_IDS',
  // AI call summary / transcription master switch. '1' (default) = on,
  // '0' = paused. Per-tenant setting.
  'AI_TRANSCRIPTION_ENABLED'
];

const SENSITIVE_KEYS = ['META_APP_SECRET', 'META_PAGE_ACCESS_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'SMTP_PASSWORD'];

async function _getAllConfig() {
  const rows = await db.getAll('config').catch(() => []);
  const fromDb = {};
  rows.forEach(r => { fromDb[r.key] = r.value; });
  const out = {};
  CONFIG_KEYS.forEach(k => {
    out[k] = fromDb[k] != null ? fromDb[k] : (process.env[k] || '');
  });
  return out;
}

async function api_company_info(token) {
  if (token) { try { await authUser(token); } catch (_) {} }
  const cfg = await _getAllConfig();
  return { name: cfg.COMPANY_NAME || 'Lead CRM', logo_url: cfg.COMPANY_LOGO_URL || '' };
}

// Preferred name used by the frontend
async function api_admin_getConfig(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _getAllConfig();
  // Redact sensitive values in the response
  const safe = {};
  for (const [k, v] of Object.entries(cfg)) {
    safe[k] = SENSITIVE_KEYS.includes(k) && v ? '••••••••' : v;
  }
  return safe;
}
// Legacy alias
const api_admin_config = api_admin_getConfig;

// Accepts either ({key, value}) object or a full patch object of key/value pairs
async function api_admin_setConfig(token, keyOrPatch, maybeValue) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const patch = (typeof keyOrPatch === 'object' && keyOrPatch !== null)
    ? keyOrPatch
    : { [keyOrPatch]: maybeValue };
  const saved = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!CONFIG_KEYS.includes(k)) continue;
    // Ignore redacted placeholder (user didn't actually change the value)
    if (SENSITIVE_KEYS.includes(k) && String(v).startsWith('••')) continue;
    await db.setConfig(k, v || '');
    process.env[k] = String(v || '');  // keep in-process mirror in sync
    saved.push(k);
  }
  return { ok: true, saved };
}
// Legacy alias — older frontend called api_admin_saveConfig(patch)
const api_admin_saveConfig = api_admin_setConfig;

// Generate a fresh Website API key, save it, return it.
async function api_admin_regenerateApiKey(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const crypto = require('crypto');
  const key = 'leadcrm_' + crypto.randomBytes(16).toString('hex');
  await db.setConfig('WEBSITE_API_KEY', key);
  process.env.WEBSITE_API_KEY = key;
  return { ok: true, key };
}

/**
 * Save a company logo. Accepts a `data:image/...;base64,...` URL the
 * client made by reading a chosen file via FileReader. Stored directly
 * in the config table so it lives across deploys.
 */
async function api_admin_uploadLogo(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const url = (payload && payload.data_url) || '';
  if (!url || !url.startsWith('data:image/')) throw new Error('Expected a data:image/* URL');
  if (url.length > 2 * 1024 * 1024) throw new Error('Logo too large (max ~1.5 MB image — please resize)');
  await db.setConfig('COMPANY_LOGO_URL', url);
  process.env.COMPANY_LOGO_URL = url;
  return { ok: true };
}

async function api_admin_clearLogo(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.setConfig('COMPANY_LOGO_URL', '');
  process.env.COMPANY_LOGO_URL = '';
  return { ok: true };
}

async function api_admin_urls(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  return {
    webAppUrl: '',  // server.js injects the actual base URL via /config.json
    spreadsheetUrl: ''
  };
}

async function api_admin_testMeta(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _getAllConfig();
  const pageToken = cfg.META_PAGE_ACCESS_TOKEN;
  const pageId = cfg.META_PAGE_ID;
  if (!pageToken) return { ok: false, error: 'Missing META_PAGE_ACCESS_TOKEN' };
  try {
    const r = await fetch('https://graph.facebook.com/v19.0/me?fields=id,name,category&access_token=' + encodeURIComponent(pageToken));
    const j = await r.json();
    if (j.error) return { ok: false, error: j.error.message };
    return { ok: true, page: { id: j.id, name: j.name, category: j.category }, match: pageId ? (String(pageId) === String(j.id)) : null };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function api_admin_subscribeMetaLeadgen(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _getAllConfig();
  if (!cfg.META_PAGE_ACCESS_TOKEN || !cfg.META_PAGE_ID) {
    return { ok: false, error: 'Need META_PAGE_ACCESS_TOKEN and META_PAGE_ID' };
  }
  try {
    const body = new URLSearchParams({ subscribed_fields: 'leadgen', access_token: cfg.META_PAGE_ACCESS_TOKEN });
    const r = await fetch('https://graph.facebook.com/v19.0/' + cfg.META_PAGE_ID + '/subscribed_apps', { method: 'POST', body });
    const j = await r.json();
    if (j.error) return { ok: false, error: j.error.message };
    return { ok: true, result: j };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function api_admin_testWhatsApp(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const cfg = await _getAllConfig();
  if (!cfg.WHATSAPP_PHONE_NUMBER_ID || !cfg.WHATSAPP_ACCESS_TOKEN) {
    return { ok: false, error: 'Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN' };
  }
  try {
    const r = await fetch('https://graph.facebook.com/v19.0/' + cfg.WHATSAPP_PHONE_NUMBER_ID + '?access_token=' + encodeURIComponent(cfg.WHATSAPP_ACCESS_TOKEN));
    const j = await r.json();
    if (j.error) return { ok: false, error: j.error.message };
    return { ok: true, phone: { id: j.id, display: j.display_phone_number, verified_name: j.verified_name, quality_rating: j.quality_rating } };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = {
  api_company_info,
  api_admin_getConfig, api_admin_config,
  api_admin_setConfig, api_admin_saveConfig,
  api_admin_regenerateApiKey,
  api_admin_uploadLogo, api_admin_clearLogo,
  api_admin_urls,
  api_admin_testMeta, api_admin_subscribeMetaLeadgen, api_admin_testWhatsApp
};
