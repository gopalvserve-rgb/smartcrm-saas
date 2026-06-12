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
  try {
    const r = await db.query(
      `SELECT access_token FROM social_ad_accounts
        WHERE access_token IS NOT NULL AND access_token <> ''
        ORDER BY is_monitored DESC, added_at DESC LIMIT 1`
    );
    const tok = r && r.rows && r.rows[0] && r.rows[0].access_token;
    return tok ? String(tok) : null;
  } catch (_) { return null; }
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
      last_verified_at:    s.last_verified_at,
      last_verify_error:   s.last_verify_error,
      last_event_at:       s.last_event_at,
      last_event_error:    s.last_event_error
    },
    fb_connected: hasFb,
    event_names: ['Purchase', 'Lead', 'Schedule', 'CompleteRegistration',
                  'Contact', 'SubmitApplication', 'StartTrial']
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
  return await _dispatch(s, tok, eventBody, lead.id, statusId, eventName, eventId, eventTime);
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
  const limit = Math.min(200, Math.max(10, Number((payload && payload.limit) || 50)));
  const r = await db.query(
    `SELECT id, lead_id, status_id, event_name, event_time, event_id,
            dispatch_status, http_status, response_text, created_at
       FROM meta_capi_events_log
       ORDER BY created_at DESC LIMIT $1`, [limit]
  );
  return { rows: r.rows };
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
