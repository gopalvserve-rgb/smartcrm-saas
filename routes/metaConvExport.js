/**
 * META_CAPI_v1 (2026-06-12) — Meta Conversions API (Offline Events) export.
 *
 * Mirrors the GOOGLE_CONV_EXPORT pattern but pushes events to Meta's
 * Conversions API instead of writing a CSV. When a lead's status changes
 * to one configured as a "conversion status", we POST a hashed event to
 *   POST /v20.0/<event_set_id>/events
 * using the access_token already stored on social_ad_accounts (set up
 * during the FB connect OAuth flow). No new tokens, no App Review.
 *
 * Architecture decisions (locked in per memory meta_capi_v1_plan):
 *   Q1=A — Meta API only, no Sheet
 *   Q2=A — manual paste Event Set ID (tenant creates in Events Manager)
 *   Q3=A — phone + email + external_id, SHA-256 hashed
 *
 * Exports:
 *   api_meta_capi_settings_get
 *   api_meta_capi_settings_save
 *   api_meta_capi_verify              — pings Meta with a dry-run event
 *   api_meta_capi_test_event          — sends a single fake event end-to-end
 *   api_meta_capi_send_lead           — manual fire-now for a specific lead
 *   api_meta_capi_events_log          — recent events table
 *   api_meta_capi_stats               — counts for the status card
 *   maybeDispatchOnStatusChange       — called by routes/leads.js after every status_change
 *   _maybeDailyTickForCurrentTenant   — called by the server.js daily worker
 */

const crypto = require('crypto');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ============================================================================
// Schema  — idempotent on every tenant boot.
// META_CAPI_SCHEMA_FIX_v2 (2026-06-12) — previously kept a per-tenant Set to
// skip the CREATE on subsequent calls, but db._tenantSlug doesn't exist in
// this version of pg.js, so every tenant collided on the 'default' key.
// First tenant to call _ensureSchema created the tables in ITS db; every
// other tenant skipped CREATE and then errored "relation does not exist".
// Fix: drop the dedup. CREATE TABLE IF NOT EXISTS is a single round-trip
// and Postgres no-ops after the first call — totally fine to run every entry.
// ============================================================================
async function _ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS meta_capi_settings (
      id                      SERIAL PRIMARY KEY,
      is_enabled              BOOLEAN DEFAULT FALSE,
      event_set_id            TEXT,
      status_event_map_json   JSONB DEFAULT '{}'::jsonb,
      include_phone           BOOLEAN DEFAULT TRUE,
      include_email           BOOLEAN DEFAULT TRUE,
      include_external_id     BOOLEAN DEFAULT TRUE,
      include_name            BOOLEAN DEFAULT FALSE,
      include_address         BOOLEAN DEFAULT FALSE,
      action_source           TEXT DEFAULT 'system_generated',
      default_currency        TEXT DEFAULT 'INR',
      test_event_code         TEXT,
      capi_access_token       TEXT,
      crm_event_set_id        TEXT,
      crm_access_token        TEXT,
      crm_stage_map_json      JSONB DEFAULT '{}'::jsonb,
      crm_is_enabled          BOOLEAN DEFAULT FALSE,
      last_verified_at        TIMESTAMPTZ,
      last_verify_error       TEXT,
      last_event_at           TIMESTAMPTZ,
      last_event_error        TEXT,
      last_batch_day          TEXT,
      updated_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_by              INT
    );
  `);
  await db.query(`ALTER TABLE meta_capi_settings ADD COLUMN IF NOT EXISTS last_batch_day TEXT;`);
  await db.query(`ALTER TABLE meta_capi_settings ADD COLUMN IF NOT EXISTS capi_access_token TEXT;`);
  await db.query(`ALTER TABLE meta_capi_settings ADD COLUMN IF NOT EXISTS crm_event_set_id TEXT;`);
  await db.query(`ALTER TABLE meta_capi_settings ADD COLUMN IF NOT EXISTS crm_access_token TEXT;`);
  await db.query(`ALTER TABLE meta_capi_settings ADD COLUMN IF NOT EXISTS crm_stage_map_json JSONB DEFAULT '{}'::jsonb;`);
  await db.query(`ALTER TABLE meta_capi_settings ADD COLUMN IF NOT EXISTS crm_is_enabled BOOLEAN DEFAULT FALSE;`)
  await db.query(`
    CREATE TABLE IF NOT EXISTS meta_capi_events_log (
      id              SERIAL PRIMARY KEY,
      lead_id         INT,
      status_id       INT,
      event_name      TEXT,
      event_time      TIMESTAMPTZ,
      event_id        TEXT UNIQUE,
      dispatch_status TEXT,
      http_status     INT,
      response_text   TEXT,
      payload_json    JSONB,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mcapi_log_lead    ON meta_capi_events_log(lead_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mcapi_log_status  ON meta_capi_events_log(dispatch_status, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mcapi_log_created ON meta_capi_events_log(created_at DESC);`);
  try {
    const existing = await db.getAll('meta_capi_settings');
    if (!existing || existing.length === 0) {
      await db.insert('meta_capi_settings', {
        is_enabled: false,
        status_event_map_json: JSON.stringify({}),
        include_phone: true,
        include_email: true,
        include_external_id: true,
        include_name: false,
        include_address: false,
        action_source: 'system_generated',
        default_currency: 'INR',
        updated_at: db.nowIso()
      });
    }
  } catch (_) {}
}

// ============================================================================
// Helpers — hashing, FB token lookup, event normalisation
// ============================================================================
function _sha256(s) {
  return crypto.createHash('sha256').update(String(s || '').trim().toLowerCase()).digest('hex');
}
function _normPhone(p) {
  // Meta expects E.164 without the + sign — strip non-digits, ensure CC.
  const raw = String(p || '').replace(/\D/g, '');
  if (!raw) return '';
  if (raw.length === 10) return '91' + raw;
  if (raw.length === 11 && raw.startsWith('0')) return '91' + raw.slice(1);
  return raw;
}
function _normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

async function _getFbAccessToken() {
  // META_CAPI_DEDICATED_TOKEN_v1 (2026-06-12) — prefer the per-Event-Set
  // CAPI Access Token (generated in Meta Events Manager → Settings →
  // Generate Access Token). That token NEVER expires and is scoped only
  // to send events to that one Event Set — Meta's recommended path.
  try {
    const all = await db.getAll('meta_capi_settings');
    const cTok = all && all[0] && all[0].capi_access_token;
    if (cTok && String(cTok).length > 10) return String(cTok);
  } catch (_) {}
  // Fall back to FB OAuth tokens in order of preference:
  try {
    const uTok = await db.getConfig('META_USER_TOKEN', '');
    if (uTok && String(uTok).length > 10) return String(uTok);
  } catch (_) {}
  try {
    const raw = await db.getConfig('META_PAGES_LIST', '');
    const list = raw ? JSON.parse(raw) : [];
    const withTok = (list || []).find(p => p && p.access_token);
    if (withTok && withTok.access_token) return String(withTok.access_token);
  } catch (_) {}
  try {
    const r1 = await db.query(
      `SELECT access_token FROM social_ad_accounts
        WHERE access_token IS NOT NULL AND access_token <> ''
        ORDER BY is_monitored DESC, added_at DESC LIMIT 1`
    );
    const t1 = r1 && r1.rows && r1.rows[0] && r1.rows[0].access_token;
    if (t1) return String(t1);
  } catch (_) {}
  try {
    const r2 = await db.query(
      `SELECT access_token FROM social_pages
        WHERE access_token IS NOT NULL AND access_token <> ''
        ORDER BY is_monitored DESC LIMIT 1`
    );
    const t2 = r2 && r2.rows && r2.rows[0] && r2.rows[0].access_token;
    if (t2) return String(t2);
  } catch (_) {}
  return null;
}

async function _loadSettings() {
  await _ensureSchema();
  const all = await db.getAll('meta_capi_settings');
  let s = (all && all[0]) || null;
  if (!s) {
    await db.insert('meta_capi_settings', { is_enabled: false, updated_at: db.nowIso() });
    const all2 = await db.getAll('meta_capi_settings');
    s = all2[0];
  }
  let map = {};
  try {
    map = s.status_event_map_json
      ? (typeof s.status_event_map_json === 'string' ? JSON.parse(s.status_event_map_json) : s.status_event_map_json)
      : {};
  } catch (_) {}
  s.status_event_map = map;
  let crmMap = {};
  try {
    crmMap = s.crm_stage_map_json
      ? (typeof s.crm_stage_map_json === 'string' ? JSON.parse(s.crm_stage_map_json) : s.crm_stage_map_json)
      : {};
  } catch (_) {}
  s.crm_stage_map = crmMap;
  return s;
}

// ============================================================================
// APIs — Settings get / save
// ============================================================================
async function api_meta_capi_settings_get(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const s = await _loadSettings();
  const hasFb = !!(await _getFbAccessToken());
  return {
    settings: {
      is_enabled:          !!s.is_enabled,
      event_set_id:        s.event_set_id || '',
      status_event_map:    s.status_event_map || {},
      include_phone:       s.include_phone !== false,
      include_email:       s.include_email !== false,
      include_external_id: s.include_external_id !== false,
      include_name:        !!s.include_name,
      include_address:     !!s.include_address,
      action_source:       s.action_source || 'system_generated',
      default_currency:    s.default_currency || 'INR',
      test_event_code:     s.test_event_code || '',
      capi_access_token:   s.capi_access_token ? '••• saved (paste new to replace)' : '',
      has_capi_token:      !!s.capi_access_token,
      crm_is_enabled:      !!s.crm_is_enabled,
      crm_event_set_id:    s.crm_event_set_id || '',
      crm_access_token:    s.crm_access_token ? '••• saved (paste new to replace)' : '',
      has_crm_token:       !!s.crm_access_token,
      crm_stage_map:       s.crm_stage_map || {},
      last_verified_at:    s.last_verified_at,
      last_verify_error:   s.last_verify_error,
      last_event_at:       s.last_event_at,
      last_event_error:    s.last_event_error
    },
    fb_connected: hasFb,
    event_names: ['Purchase', 'Lead', 'Schedule', 'CompleteRegistration',
                  'Contact', 'SubmitApplication', 'StartTrial'],
    crm_stages: ['new', 'working', 'qualified', 'disqualified', 'converted']
  };
}

async function api_meta_capi_settings_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const p = payload || {};
  const s = await _loadSettings();
  const patch = {
    is_enabled:          p.is_enabled === undefined ? s.is_enabled : !!p.is_enabled,
    event_set_id:        p.event_set_id !== undefined ? String(p.event_set_id || '').trim() : s.event_set_id,
    status_event_map_json: p.status_event_map !== undefined
      ? JSON.stringify(p.status_event_map || {})
      : (s.status_event_map_json || '{}'),
    include_phone:       p.include_phone === undefined ? s.include_phone : !!p.include_phone,
    include_email:       p.include_email === undefined ? s.include_email : !!p.include_email,
    include_external_id: p.include_external_id === undefined ? s.include_external_id : !!p.include_external_id,
    include_name:        p.include_name === undefined ? s.include_name : !!p.include_name,
    include_address:     p.include_address === undefined ? s.include_address : !!p.include_address,
    default_currency:    p.default_currency !== undefined ? String(p.default_currency || 'INR').trim().toUpperCase() : s.default_currency,
    test_event_code:     p.test_event_code !== undefined ? String(p.test_event_code || '').trim() : s.test_event_code,
    capi_access_token:   (p.capi_access_token !== undefined && String(p.capi_access_token).indexOf('•••') < 0)
                         ? String(p.capi_access_token || '').trim()
                         : s.capi_access_token,
    crm_is_enabled:      p.crm_is_enabled === undefined ? s.crm_is_enabled : !!p.crm_is_enabled,
    crm_event_set_id:    p.crm_event_set_id !== undefined ? String(p.crm_event_set_id || '').trim() : s.crm_event_set_id,
    crm_access_token:    (p.crm_access_token !== undefined && String(p.crm_access_token).indexOf('•••') < 0)
                         ? String(p.crm_access_token || '').trim()
                         : s.crm_access_token,
    crm_stage_map_json:  p.crm_stage_map !== undefined
                         ? JSON.stringify(p.crm_stage_map || {})
                         : (s.crm_stage_map_json || '{}'),
    updated_at:          db.nowIso(),
    updated_by:          me.id
  };
  await db.update('meta_capi_settings', s.id, patch);
  return { ok: true };
}

// ============================================================================
// Verify — dry-run ping to Meta
// ============================================================================
async function api_meta_capi_verify(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const s = await _loadSettings();
  if (!s.event_set_id) throw new Error('Paste your Event Set ID first');
  const tok = await _getFbAccessToken();
  if (!tok) throw new Error('Facebook is not connected. Connect it on Meta Ads Manager tab first.');

  const event = {
    event_name: 'PageView',
    event_time: Math.floor(Date.now() / 1000),
    action_source: 'system_generated',
    event_id: 'verify_' + Date.now(),
    user_data: { em: [_sha256('verify@smartcrmsolution.com')] }
  };
  const url = 'https://graph.facebook.com/v20.0/' + encodeURIComponent(s.event_set_id) +
              '/events?access_token=' + encodeURIComponent(tok);
  const fetch = require('node-fetch');
  let resp, body;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event] })
    });
    body = await resp.text();
  } catch (e) {
    await db.update('meta_capi_settings', s.id, {
      last_verified_at: db.nowIso(),
      last_verify_error: 'Network: ' + e.message
    });
    throw new Error('Network error: ' + e.message);
  }
  let parsed = {};
  try { parsed = JSON.parse(body); } catch (_) {}
  if (!resp.ok || parsed.error) {
    const err = (parsed.error && parsed.error.message) || ('HTTP ' + resp.status + ': ' + body.slice(0, 200));
    await db.update('meta_capi_settings', s.id, {
      last_verified_at: db.nowIso(),
      last_verify_error: err
    });
    throw new Error('Meta rejected: ' + err);
  }
  await db.update('meta_capi_settings', s.id, {
    last_verified_at: db.nowIso(),
    last_verify_error: null
  });
  return { ok: true, events_received: parsed.events_received || 1, fbtrace: parsed.fbtrace_id || null };
}

// ============================================================================
// Send event helpers
// ============================================================================
function _buildUserData(s, lead) {
  const ud = {};
  if (s.include_phone) {
    const p = _normPhone(lead.phone);
    if (p) ud.ph = [_sha256(p)];
  }
  if (s.include_email) {
    const e = _normEmail(lead.email);
    if (e) ud.em = [_sha256(e)];
  }
  if (s.include_external_id && lead.id) {
    ud.external_id = [_sha256(String(lead.id))];
  }
  if (s.include_name) {
    const parts = String(lead.name || '').trim().split(/\s+/);
    if (parts[0]) ud.fn = [_sha256(parts[0])];
    if (parts.length > 1) ud.ln = [_sha256(parts[parts.length - 1])];
  }
  if (s.include_address) {
    if (lead.city)    ud.ct = [_sha256(lead.city)];
    if (lead.state)   ud.st = [_sha256(lead.state)];
    if (lead.country) ud.country = [_sha256(lead.country)];
    if (lead.pincode) ud.zp = [_sha256(lead.pincode)];
  }
  // META_CAPI_LEADGEN_ID_v1 — perfect Lead Ad matching via leadgen_id.
  // FB Lead Ads → /hook/meta saves leadgen_id into lead.meta_json. Including
  // it in user_data lets Meta tie the conversion directly to the specific
  // Lead Ad form click — better than PII-only matching, and removes the
  // need for the CRM data source (which is gated behind Meta's partner
  // program and unavailable to most tenants).
  try {
    const m = lead.meta_json
      ? (typeof lead.meta_json === 'string' ? JSON.parse(lead.meta_json) : lead.meta_json)
      : {};
    const leadgenId = m.leadgen_id || m.lead_id;
    if (leadgenId) ud.lead_id = String(leadgenId);
  } catch (_) {}
  if (lead.fbclid) ud.fbc = ['fb.1.' + Math.floor(Date.now() / 1000) + '.' + lead.fbclid];
  return ud;
}

async function _dispatch(s, tok, eventBody, leadId, statusId, eventName, eventId, eventTime) {
  const url = 'https://graph.facebook.com/v20.0/' + encodeURIComponent(s.event_set_id) +
              '/events?access_token=' + encodeURIComponent(tok);
  const fetch = require('node-fetch');
  let dispatchStatus = 'queued', httpStatus = 0, responseText = '';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [eventBody], ...(s.test_event_code ? { test_event_code: s.test_event_code } : {}) })
    });
    httpStatus = resp.status;
    responseText = await resp.text();
    dispatchStatus = (resp.ok && !/"error"/i.test(responseText)) ? 'sent' : 'failed';
  } catch (e) {
    dispatchStatus = 'failed';
    responseText = 'Network: ' + e.message;
  }
  try {
    await db.query(
      `INSERT INTO meta_capi_events_log
         (lead_id, status_id, event_name, event_time, event_id, dispatch_status, http_status, response_text, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO NOTHING`,
      [leadId, statusId, eventName, eventTime, eventId, dispatchStatus, httpStatus, responseText.slice(0, 2000), JSON.stringify(eventBody)]
    );
  } catch (_) {}
  try {
    if (dispatchStatus === 'sent') {
      await db.query(`UPDATE meta_capi_settings SET last_event_at = NOW(), last_event_error = NULL`);
    } else {
      await db.query(`UPDATE meta_capi_settings SET last_event_error = $1`, [responseText.slice(0, 500)]);
    }
  } catch (_) {}
  return { ok: dispatchStatus === 'sent', dispatchStatus, httpStatus, responseText };
}


// META_CAPI_CRM_MODE_v1 — fire LeadCrmStageChanged event to a separate
// CRM dataset (Lead Ads optimisation). Only fires when:
//   1. CRM mode is enabled with its own event_set_id + access_token
//   2. The lead has an fb leadgen_id (came from FB Lead Ads)
//   3. The new status maps to one of Meta's 5 stages
async function _sendCrmStageChange(s, lead, statusId, when) {
  if (!s.crm_is_enabled || !s.crm_event_set_id || !s.crm_access_token) return;
  const stage = (s.crm_stage_map || {})[String(statusId)];
  if (!stage) return;
  // Extract leadgen_id from meta_json (set by /hook/meta and other FB paths)
  let leadgenId = null;
  try {
    const m = lead.meta_json
      ? (typeof lead.meta_json === 'string' ? JSON.parse(lead.meta_json) : lead.meta_json)
      : {};
    leadgenId = m.leadgen_id || m.lead_id || null;
  } catch (_) {}
  if (!leadgenId) return; // CRM-mode only applies to Lead Ad leads
  const eventTime = when || new Date();
  const eventId = 'crmstage_' + lead.id + '_' + statusId + '_' + Math.floor(eventTime.getTime() / 1000);
  const eventBody = {
    event_name: 'LeadCrmStageChanged',
    event_time: Math.floor(eventTime.getTime() / 1000),
    event_id: eventId,
    action_source: 'system_generated',
    lead_event_source: 'SmartCRM',
    user_data: { lead_id: String(leadgenId) },
    custom_data: { lead_event_stage: String(stage).toLowerCase() }
  };
  const url = 'https://graph.facebook.com/v20.0/' + encodeURIComponent(s.crm_event_set_id) +
              '/events?access_token=' + encodeURIComponent(s.crm_access_token);
  const fetch = require('node-fetch');
  let dispatchStatus = 'queued', httpStatus = 0, responseText = '';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [eventBody] })
    });
    httpStatus = resp.status;
    responseText = await resp.text();
    dispatchStatus = (resp.ok && !/"error"/i.test(responseText)) ? 'sent' : 'failed';
  } catch (e) {
    dispatchStatus = 'failed';
    responseText = 'Network: ' + e.message;
  }
  try {
    await db.query(
      `INSERT INTO meta_capi_events_log
         (lead_id, status_id, event_name, event_time, event_id, dispatch_status, http_status, response_text, payload_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO NOTHING`,
      [lead.id, statusId, 'LeadCrmStageChanged:' + stage, eventTime, eventId, dispatchStatus, httpStatus, responseText.slice(0, 2000), JSON.stringify(eventBody)]
    );
  } catch (_) {}
}

async function _sendForLead(s, tok, lead, statusId, eventName, when) {
  const eventTime = when || new Date();
  const eventId = 'crm_' + lead.id + '_' + statusId + '_' + Math.floor(eventTime.getTime() / 1000);
  const userData = _buildUserData(s, lead);
  const customData = {};
  if (lead.value && Number(lead.value) > 0) {
    customData.value = Number(lead.value);
    customData.currency = (lead.currency || s.default_currency || 'INR').toUpperCase();
  }
  const eventBody = {
    event_name: eventName,
    event_time: Math.floor(eventTime.getTime() / 1000),
    event_id: eventId,
    action_source: s.action_source || 'system_generated',
    user_data: userData,
    ...(Object.keys(customData).length ? { custom_data: customData } : {})
  };
  const result = await _dispatch(s, tok, eventBody, lead.id, statusId, eventName, eventId, eventTime);
  // META_CAPI_CRM_MODE_v1 — also fire CRM stage event (if configured + applicable)
  try { await _sendCrmStageChange(s, lead, statusId, eventTime); } catch (e) { console.warn('[meta-capi] CRM stage send failed:', e.message); }
  return result;
}

async function api_meta_capi_send_lead(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const leadId = Number(payload && payload.lead_id);
  if (!leadId) throw new Error('lead_id required');
  const s = await _loadSettings();
  if (!s.is_enabled) throw new Error('Meta CAPI is OFF — enable it in Settings first');
  if (!s.event_set_id) throw new Error('Event Set ID missing');
  const tok = await _getFbAccessToken();
  if (!tok) throw new Error('Facebook not connected');
  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');
  const map = s.status_event_map || {};
  const eventName = map[String(lead.status_id)] || (payload && payload.event_name) || 'Lead';
  return await _sendForLead(s, tok, lead, lead.status_id, eventName);
}

async function api_meta_capi_test_event(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const s = await _loadSettings();
  if (!s.event_set_id) throw new Error('Event Set ID missing');
  const tok = await _getFbAccessToken();
  if (!tok) throw new Error('Facebook not connected');
  const fakeLead = {
    id: 0,
    phone: '+919999999999',
    email: 'test@smartcrmsolution.com',
    name: 'Test Lead',
    value: 1000,
    currency: 'INR'
  };
  return await _sendForLead(s, tok, fakeLead, null, 'Lead');
}

// ============================================================================
// Real-time hook — called from routes/leads.js after every status change
// ============================================================================
async function maybeDispatchOnStatusChange(leadId, newStatusId, oldStatusId, userId) {
  try {
    await _ensureSchema();
    const s = await _loadSettings();
    if (!s.is_enabled || !s.event_set_id) return;
    const map = s.status_event_map || {};
    const eventName = map[String(newStatusId)];
    if (!eventName) return;
    const tok = await _getFbAccessToken();
    if (!tok) return;
    const lead = await db.findById('leads', Number(leadId));
    if (!lead) return;
    await _sendForLead(s, tok, lead, newStatusId, eventName);
  } catch (e) {
    console.warn('[meta-capi] real-time dispatch failed:', e.message);
  }
}

// ============================================================================
// Daily batch tick — catches anything the real-time hook missed
// ============================================================================
async function _maybeDailyTickForCurrentTenant(slug) {
  try {
    await _ensureSchema();
    const s = await _loadSettings();
    if (!s.is_enabled || !s.event_set_id) return;
    const map = s.status_event_map || {};
    if (!Object.keys(map).length) return;

    const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
    if (nowIst.getUTCHours() !== 22) return;
    const todayIst = nowIst.toISOString().slice(0, 10);
    if (s.last_batch_day === todayIst) return;

    const tok = await _getFbAccessToken();
    if (!tok) return;
    const cutoffIso = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const r = await db.query(
      `SELECT la.lead_id, la.created_at, la.meta_json, l.*
         FROM lead_actions la
         JOIN leads l ON l.id = la.lead_id
        WHERE la.action_type = 'status_change'
          AND la.created_at >= $1
        ORDER BY la.created_at ASC LIMIT 500`, [cutoffIso]
    );
    let sent = 0;
    for (const row of r.rows) {
      let meta = {};
      try { meta = typeof row.meta_json === 'string' ? JSON.parse(row.meta_json) : (row.meta_json || {}); } catch (_) {}
      const toId = Number(meta.to_status_id || row.status_id);
      const eventName = map[String(toId)];
      if (!eventName) continue;
      const eventTime = new Date(row.created_at);
      const eventId = 'crm_' + row.lead_id + '_' + toId + '_' + Math.floor(eventTime.getTime() / 1000);
      try {
        const dup = await db.query(`SELECT 1 FROM meta_capi_events_log WHERE event_id = $1 LIMIT 1`, [eventId]);
        if (dup.rows.length) continue;
      } catch (_) {}
      const lead = {
        id: row.lead_id, name: row.name, phone: row.phone, email: row.email,
        value: row.value, currency: row.currency, city: row.city, state: row.state,
        country: row.country, pincode: row.pincode, fbclid: row.fbclid
      };
      const result = await _sendForLead(s, tok, lead, toId, eventName, eventTime);
      if (result.ok) sent++;
    }
    try { await db.query(`UPDATE meta_capi_settings SET last_batch_day = $1`, [todayIst]); } catch (_) {}
    console.log('[meta-capi] daily tick ' + (slug || '') + ' — sent ' + sent + ' events');
  } catch (e) {
    console.warn('[meta-capi] daily tick failed:', e.message);
  }
}

// ============================================================================
// Stats + log for UI
// ============================================================================
async function api_meta_capi_events_log(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const limit     = Math.min(500, Math.max(10, Number((payload && payload.limit) || 200)));
  const sinceDays = Math.min(30, Math.max(1, Number((payload && payload.since_days) || 3)));
  const since = new Date(Date.now() - sinceDays * 86400e3);
  // Optional dispatch_status filter ('sent' | 'failed' | 'all')
  const wantStatus = (payload && payload.status) || 'all';
  let where = 'created_at >= $1';
  const params = [since.toISOString()];
  if (wantStatus === 'sent' || wantStatus === 'failed') {
    where += ' AND dispatch_status = $2';
    params.push(wantStatus);
  }
  // META_CAPI_LOG_VIEWER_v1 — include the payload_json so we can show what was
  // actually sent to Meta, plus joined lead name+phone for human-readable rows.
  const r = await db.query(
    `SELECT l.id, l.lead_id, l.status_id, l.event_name, l.event_time, l.event_id,
            l.dispatch_status, l.http_status, l.response_text, l.payload_json,
            l.created_at,
            ld.name AS lead_name, ld.phone AS lead_phone
       FROM meta_capi_events_log l
       LEFT JOIN leads ld ON ld.id = l.lead_id
       WHERE ${where}
       ORDER BY l.created_at DESC LIMIT $${params.length + 1}`,
    [...params, limit]
  );
  // Summary counts within the window for the SPA header.
  const counts = await db.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE dispatch_status='sent')::int   AS sent,
        COUNT(*) FILTER (WHERE dispatch_status='failed')::int AS failed,
        COUNT(*) FILTER (WHERE dispatch_status='queued')::int AS queued
       FROM meta_capi_events_log
       WHERE created_at >= $1`, [since.toISOString()]
  );
  return {
    rows: r.rows,
    summary: counts.rows[0] || { total: 0, sent: 0, failed: 0, queued: 0 },
    since_days: sinceDays,
    window_from: since.toISOString()
  };
}

async function api_meta_capi_stats(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const week  = new Date(Date.now() - 7 * 86400e3);
  const r = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE dispatch_status='sent' AND created_at >= $1)::int AS today_sent,
        COUNT(*) FILTER (WHERE dispatch_status='sent' AND created_at >= $2)::int AS week_sent,
        COUNT(*) FILTER (WHERE dispatch_status='sent')::int                       AS lifetime_sent,
        COUNT(*) FILTER (WHERE dispatch_status='failed' AND created_at >= $2)::int AS week_failed
       FROM meta_capi_events_log`, [today.toISOString(), week.toISOString()]
  );
  const stats = r.rows[0] || {};
  const lastRow = await db.query(
    `SELECT lead_id, event_name, event_time, dispatch_status
       FROM meta_capi_events_log
       WHERE dispatch_status='sent'
       ORDER BY created_at DESC LIMIT 1`
  );
  return {
    today_sent:    stats.today_sent || 0,
    week_sent:     stats.week_sent || 0,
    lifetime_sent: stats.lifetime_sent || 0,
    week_failed:   stats.week_failed || 0,
    last_event:    lastRow.rows[0] || null
  };
}

module.exports = {
  api_meta_capi_settings_get,
  api_meta_capi_settings_save,
  api_meta_capi_verify,
  api_meta_capi_test_event,
  api_meta_capi_send_lead,
  api_meta_capi_events_log,
  api_meta_capi_stats,
  maybeDispatchOnStatusChange,
  _maybeDailyTickForCurrentTenant,
  _ensureSchema
};
