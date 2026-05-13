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
  'WHATSAPP_COEXISTENCE_MODE',
  'WEBSITE_API_KEY',
  'ENFORCE_GPS', 'OFFICE_LAT', 'OFFICE_LNG', 'OFFICE_RADIUS_M',
  'WORK_START', 'WORK_END', 'WEEKLY_OFFS',
  'DUPLICATE_POLICY', 'DUPLICATE_WINDOW_HOURS', 'DUPLICATE_MATCH_FIELDS', 'DEFAULT_LEAD_COLUMNS',
  'EMAIL_NOTIFY_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD',
  'EMAIL_NOTIFY_FROM', 'EMAIL_NOTIFY_SUBJECT_PREFIX', 'FOLLOWUP_REMIND_MIN',
  // SMTP (new)
  'SMTP_FROM', 'SMTP_ENCRYPTION', 'EMAIL_CHARSET', 'EMAIL_BCC', 'EMAIL_SIGNATURE', 'EMAIL_SUPPORT_TEXT', 'BASE_URL',
  // Per-event notification toggles
  'NOTIFY_NEW_LEAD', 'NOTIFY_LEAD_ASSIGNED', 'NOTIFY_NEW_DEVICE_LOGIN',
  'NOTIFY_MORNING_FOLLOWUPS', 'NOTIFY_DAY_END',
  // Auto-dial: when a new lead is created, push a "📞 Tap to call" notification
  // to the assignee's mobile in addition to the standard "lead assigned" alert.
  'LEAD_AUTODIAL_ON',
  // AI call summary / transcription master switch. '1' (default) = on,
  // '0' = paused (worker won't process new recordings + UI hides the
  // AI panel). Useful for tenants that don't want to spend on Gemini
  // or have privacy concerns.
  'AI_TRANSCRIPTION_ENABLED',
  'SHOW_LEADS_HEADER',
  // CSV of NAV item IDs the admin has hidden in the sidebar for this tenant.
  // E.g. "newleads,overdue,upcoming,whatsbot" hides those four entries.
  'HIDDEN_NAV_IDS',
  // CSV of nav-group LABELS in the order the admin wants the sidebar
  // to render. Groups not listed render after the listed ones in their
  // hardcoded order. Empty = use hardcoded order.
  'SIDEBAR_NAV_GROUP_ORDER',
  // Pull Leads + WhatsApp shortcut config
  'LEAD_PULL_ENABLED', 'LEAD_PULL_INITIAL_COUNT', 'LEAD_PULL_SUBSEQUENT_COUNT', 'LEAD_PULL_ENABLED_ROLES', 'LEAD_PULL_ORDER',
  'COMPANY_WHATSAPP', 'COMPANY_PHONE',
  // Call \u2192 lead auto-conversion (mobile-app callerId capture)
  // '1' = create a lead from each call when no existing match; '0' = skip.
  // CALLS_AUTOLEAD_STATUS_ID = id of the status to apply (falls back to 'New').
  'CALLS_AUTOLEAD_INBOUND', 'CALLS_AUTOLEAD_OUTBOUND', 'CALLS_AUTOLEAD_STATUS_ID',
  // Auto vs Manual mode for call-to-lead creation. 'auto' (default) creates
  // the lead the moment the phone rings. 'manual' just logs the call_event
  // — admin reviews + bulk-converts later from Settings → Pending calls.
  'CALLS_AUTOLEAD_MODE',
  // Tenant theme customisation. Hex colours; THEME_MODE = 'light' | 'dark' | 'auto'.
  // BRAND_PRIMARY = main accent (buttons, links, active nav).
  // BRAND_SIDEBAR = sidebar background. BRAND_TEXT = top/headings text.
  'BRAND_PRIMARY_COLOR', 'BRAND_ACCENT_COLOR', 'BRAND_SIDEBAR_COLOR',
  'BRAND_TEXT_COLOR', 'THEME_MODE',
  // CRM Copilot — per-user/day question quota (default 50).
  'COPILOT_DAILY_LIMIT_PER_USER',
  // Demo tenant flags — set by the showcase seeder. The SPA reads these
  // to enable the in-app tour and the 📚 floating button.
  'DEMO_TENANT', 'DEMO_TOUR_ENABLED',
  // Minimum seconds an answered inbound call must last before it creates a lead.
  // 0 = create on every call (incl. missed). Default 5.
  'CALLS_AUTOLEAD_MIN_SECONDS'
];

const SENSITIVE_KEYS = ['META_APP_SECRET', 'META_PAGE_ACCESS_TOKEN', 'WHATSAPP_ACCESS_TOKEN', 'SMTP_PASSWORD'];

// Keys that default to a non-empty value when no DB row and no env var exists.
// New tenants get sensible behaviour out of the box without an admin touching anything.
const CONFIG_DEFAULTS = {
  WHATSAPP_COEXISTENCE_MODE: '1'  // Coexistence ON by default — clients keep using the WA Business mobile app while the CRM also uses the Cloud API
};

async function _getAllConfig() {
  const rows = await db.getAll('config').catch(() => []);
  const fromDb = {};
  rows.forEach(r => { fromDb[r.key] = r.value; });
  const out = {};
  CONFIG_KEYS.forEach(k => {
    if (fromDb[k] != null && String(fromDb[k]) !== '') {
      out[k] = fromDb[k];
    } else if (Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, k)) {
      out[k] = CONFIG_DEFAULTS[k];
    } else {
      out[k] = '';
    }
  });
  return out;
}

async function api_company_info(token) {
  if (token) { try { await authUser(token); } catch (_) {} }
  const cfg = await _getAllConfig();
  return {
    name: cfg.COMPANY_NAME || 'Lead CRM',
    logo_url: cfg.COMPANY_LOGO_URL || '',
    // Brand theme colours — exposed publicly so the login screen + the
    // SPA's pre-warmCache initial render can theme correctly even before
    // the user authenticates as admin. Non-admin users also get themed
    // via this endpoint because api_admin_getConfig is admin-gated.
    brand: {
      primary:  cfg.BRAND_PRIMARY_COLOR  || '',
      accent:   cfg.BRAND_ACCENT_COLOR   || '',
      sidebar:  cfg.BRAND_SIDEBAR_COLOR  || '',
      text:     cfg.BRAND_TEXT_COLOR     || '',
      mode:     cfg.THEME_MODE           || 'auto'
    }
  };
}

// Public theme-only endpoint — returns just the brand colours, no auth.
// Used by the SPA's warmCache fallback so non-admin users still get the
// themed UI even though api_admin_getConfig rejects them.
async function api_admin_brand(_token) {
  const cfg = await _getAllConfig();
  return {
    BRAND_PRIMARY_COLOR:  cfg.BRAND_PRIMARY_COLOR  || '',
    BRAND_ACCENT_COLOR:   cfg.BRAND_ACCENT_COLOR   || '',
    BRAND_SIDEBAR_COLOR:  cfg.BRAND_SIDEBAR_COLOR  || '',
    BRAND_TEXT_COLOR:     cfg.BRAND_TEXT_COLOR     || '',
    THEME_MODE:           cfg.THEME_MODE           || 'auto',
    COMPANY_NAME:         cfg.COMPANY_NAME         || '',
    COMPANY_LOGO_URL:     cfg.COMPANY_LOGO_URL     || '',
    // Demo tenant flags — read by the SPA so the showcase tour shows up
    // for every role (api_admin_getConfig rejects non-admin users).
    DEMO_TENANT:          cfg.DEMO_TENANT          || '',
    DEMO_TOUR_ENABLED:    cfg.DEMO_TOUR_ENABLED    || ''
  };
}


// Public layout config: nav order + hidden ids. Read on every SPA boot
// so renderShell can sort NAV_GROUPS without an admin-only call.
async function api_layout_get(_token) {
  let order = '', hidden = '';
  try { order  = await db.getConfig('SIDEBAR_NAV_GROUP_ORDER', '') || ''; } catch (_) {}
  try { hidden = await db.getConfig('HIDDEN_NAV_IDS', '') || ''; } catch (_) {}
  return {
    sidebar_nav_group_order: String(order || '').split(',').map(s => s.trim()).filter(Boolean),
    hidden_nav_ids:          String(hidden || '').split(',').map(s => s.trim()).filter(Boolean)
  };
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

/* ---------- Email templates + test send ---------- */
async function api_admin_emailTemplatesList(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const mailer = require('../utils/mailer');
  const events = mailer.SUPPORTED_EVENTS;
  const rows = await db.getAll('email_templates').catch(() => []);
  // Ensure every supported event has a row (auto-seed on demand)
  for (const ev of events) {
    if (!rows.find(r => r.event_type === ev.id)) {
      const id = await db.insert('email_templates', {
        event_type: ev.id, name: ev.label,
        subject: ev.default_subject, body_html: ev.default_body,
        is_active: 1, updated_at: db.nowIso()
      });
      rows.push({ id, event_type: ev.id, name: ev.label,
        subject: ev.default_subject, body_html: ev.default_body, is_active: 1 });
    }
  }
  // Return ordered + decorated with metadata
  return events.map(ev => {
    const row = rows.find(r => r.event_type === ev.id) || {};
    return {
      ...ev,
      id: row.id, subject: row.subject, body_html: row.body_html,
      is_active: row.is_active, updated_at: row.updated_at
    };
  });
}

async function api_admin_emailTemplateSave(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (!p.event_type) throw new Error('event_type required');
  const existing = await db.findOneBy('email_templates', 'event_type', p.event_type).catch(() => null);
  const row = {
    event_type: p.event_type,
    name: p.name || p.event_type,
    subject: p.subject || '',
    body_html: p.body_html || '',
    is_active: p.is_active != null ? (p.is_active ? 1 : 0) : 1,
    updated_at: db.nowIso()
  };
  if (existing) { await db.update('email_templates', existing.id, row); return { ok: true, id: existing.id }; }
  const id = await db.insert('email_templates', row);
  return { ok: true, id };
}

async function api_admin_emailTestSend(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const to = (payload && payload.to) || me.email;
  if (!to) throw new Error('Recipient email required');
  const mailer = require('../utils/mailer');
  await mailer.testSmtp(to);
  return { ok: true, sent_to: to };
}

async function api_admin_emailTriggerCron(token, which) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const mailer = require('../utils/mailer');
  if (which === 'morning') return await mailer.sendMorningFollowups();
  if (which === 'day_end') return await mailer.sendDayEndReport();
  throw new Error('Unknown cron: ' + which);
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

/**
 * api_admin_wipeHrData — one-shot data deletion for HR-side categories.
 * Lets the admin wipe Leaves / Tasks / Attendance / Salary data when they
 * want a clean slate (e.g. starting a new fiscal year, decommissioning a
 * test environment, GDPR right-to-erasure, etc.) without needing direct
 * database access.
 *
 * Args:
 *   - categories: subset of ['leaves','tasks','attendance','salary']
 *   - confirm:    must equal 'WIPE-NOW' (typed by the admin in the UI)
 *
 * Returns:  { ok: true, deleted: { leaves: N, tasks: N, ... } }
 *
 * Behaviour notes:
 *   - DELETE statements run inside a single transaction so a failure
 *     anywhere rolls everything back.
 *   - When 'attendance' is selected, location_pings is wiped first
 *     (FK references attendance.id ON DELETE CASCADE — but we delete
 *     explicitly so the result count is reported transparently).
 *   - Lead data, user accounts, leads/customers, etc. are NEVER touched
 *     by this endpoint. Only the four HR categories.
 */
async function api_admin_wipeHrData(token, categories, confirm) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (String(confirm || '').trim() !== 'WIPE-NOW') {
    throw new Error('Confirmation phrase must be exactly: WIPE-NOW');
  }
  const cats = Array.isArray(categories) ? categories : [];
  const allowed = new Set(['leaves', 'tasks', 'attendance', 'salary']);
  const picked = cats.filter(c => allowed.has(String(c).toLowerCase()));
  if (!picked.length) throw new Error('Pick at least one category to wipe');

  const deleted = {};
  // Run inside a transaction so partial failures don't leave half-wiped
  // state. db.query already uses a pooled client; for transactionality
  // we acquire one client and run BEGIN / COMMIT manually.
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const cat of picked) {
      if (cat === 'attendance') {
        // location_pings has a FK to attendance(id). Delete it first so
        // the count we report is accurate; the CASCADE would handle it
        // but explicit DELETE makes the audit trail clearer.
        const lp = await client.query('DELETE FROM location_pings');
        deleted.location_pings = lp.rowCount || 0;
        const at = await client.query('DELETE FROM attendance');
        deleted.attendance = at.rowCount || 0;
      } else if (cat === 'leaves') {
        const r = await client.query('DELETE FROM leaves');
        deleted.leaves = r.rowCount || 0;
      } else if (cat === 'tasks') {
        const r = await client.query('DELETE FROM tasks');
        deleted.tasks = r.rowCount || 0;
      } else if (cat === 'salary') {
        const r = await client.query('DELETE FROM salaries');
        deleted.salaries = r.rowCount || 0;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw new Error('Wipe failed: ' + e.message);
  } finally {
    client.release();
  }
  return { ok: true, deleted };
}

// ---- Webhook event log viewer (admin) ----
// Thin wrappers around utils/webhookLogger so the tenant API dispatcher
// can route 'api_admin_webhookLogs_list' to the real implementation.
const _whl = require('../utils/webhookLogger');
async function api_admin_webhookLogs_list(token, opts) { return _whl.api_admin_webhookLogs_list(token, opts); }
async function api_admin_webhookLogs_get(token, id)    { return _whl.api_admin_webhookLogs_get(token, id); }
async function api_admin_webhookLogs_backfillSources(token, opts) { return _whl.api_admin_webhookLogs_backfillSources(token, opts); }

// Recording transcode diagnostic log (admin)
const _rdiag = require('../utils/recordingDiag');
async function api_admin_recordingDiag_list(token, opts) { return _rdiag.api_admin_recordingDiag_list(token, opts); }

module.exports = {
  api_company_info,
  api_admin_brand,
  api_admin_webhookLogs_list, api_admin_webhookLogs_get, api_admin_webhookLogs_backfillSources,
  api_admin_recordingDiag_list,
  api_admin_getConfig, api_admin_config, api_layout_get,
  api_admin_setConfig, api_admin_saveConfig,
  api_admin_regenerateApiKey,
  api_admin_uploadLogo, api_admin_clearLogo,
  api_admin_emailTemplatesList, api_admin_emailTemplateSave,
  api_admin_emailTestSend, api_admin_emailTriggerCron,
  api_admin_urls,
  api_admin_testMeta, api_admin_subscribeMetaLeadgen, api_admin_testWhatsApp,
  api_admin_wipeHrData
};
      