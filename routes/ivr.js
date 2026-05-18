/**
 * IVR / Cloud Calling integration framework.
 *
 * Lets a tenant plug in any cloud telephony / IVR vendor (Exotel,
 * MyOperator, Knowlarity, Tata Tele, Servetel, Ozonetel, Twilio, etc.)
 * by pasting their API credentials + a webhook secret. From that point:
 *
 *   - Inbound calls hit /t/<slug>/hook/ivr/<vendor>, are normalized to
 *     a common shape via per-vendor adapters, and produce a call_event
 *     row + optionally an auto-created lead (using existing config
 *     CALLS_AUTOLEAD_INBOUND / CALLS_AUTOLEAD_STATUS_ID).
 *   - Outbound click-to-call from the SPA fires api_ivr_initiateCall,
 *     which dispatches to the active vendor's API to bridge the agent
 *     and the lead.
 *   - When the call ends and the vendor's webhook posts a recording URL
 *     we attach it to the call_event row (and optionally fetch the
 *     audio bytes and ingest via the existing /api/recordings handler).
 *
 * Vendor adapters live in this file (a single normalize() per vendor +
 * a single initiateCall() per vendor). New vendors are added by writing
 * two small functions and registering them in VENDORS. Tenants without
 * a built-in adapter for their vendor can pick "generic" and provide a
 * field mapping JSON instead.
 */

const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const crypto = require('crypto');

// ----------------------------------------------------------------
// Schema self-heal — runs once per process per tenant
// ----------------------------------------------------------------
const _ensured = new WeakSet();
async function _ensureSchema() {
  // Detect tenant DB via tenantStorage; we mark the pool object once
  // schema's been confirmed for this process so we only run DDL once.
  const pool = db.currentPool ? db.currentPool() : null;
  if (pool && _ensured.has(pool)) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ivr_configs (
        id                SERIAL PRIMARY KEY,
        vendor_key        TEXT NOT NULL,
        display_name      TEXT NOT NULL,
        is_active         INTEGER NOT NULL DEFAULT 1,
        is_default        INTEGER NOT NULL DEFAULT 0,
        api_base_url      TEXT,
        account_sid       TEXT,
        api_key           TEXT,
        api_token         TEXT,
        caller_id         TEXT,
        webhook_secret    TEXT,
        field_mapping     JSONB,
        auto_create_lead  INTEGER NOT NULL DEFAULT 1,
        default_status_id INTEGER,
        notes             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ivr_active ON ivr_configs(is_active);
      CREATE INDEX IF NOT EXISTS idx_ivr_vendor ON ivr_configs(vendor_key);

      ALTER TABLE users ADD COLUMN IF NOT EXISTS ivr_agent_id  TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS ivr_extension TEXT;

      ALTER TABLE call_events ADD COLUMN IF NOT EXISTS ivr_call_id TEXT;
      ALTER TABLE call_events ADD COLUMN IF NOT EXISTS ivr_vendor  TEXT;
      ALTER TABLE call_events ADD COLUMN IF NOT EXISTS recording_url TEXT;
    `);
    if (pool) _ensured.add(pool);
  } catch (e) { console.warn('[ivr] _ensureSchema:', e.message); }
}

// ----------------------------------------------------------------
// Vendor adapters
// Each vendor exports two methods:
//   normalize(req)     — webhook payload → { phone, agent_id, direction,
//                          duration_s, recording_url, event, call_id, raw }
//   initiateCall(cfg, { fromAgent, toNumber }) — outbound trigger
// ----------------------------------------------------------------
function _digits(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }
function _firstDefined(obj, keys) {
  for (const k of keys) { if (obj && obj[k] != null && obj[k] !== '') return obj[k]; }
  return '';
}

const ADAPTERS = {
  // ---- Generic field-mapping mode ----
  // Tenant provides a JSON map like:
  //   { phone:'from', agent_id:'agent', direction:'type',
  //     duration_s:'duration', recording_url:'recording',
  //     event:'event', call_id:'callId' }
  generic: {
    normalize(req, cfg) {
      const body = req.body || {};
      const flat = Object.assign({}, body, req.query || {});
      const map = (cfg && cfg.field_mapping) || {};
      const get = (k, fallbacks) => {
        if (map[k] && flat[map[k]] != null) return flat[map[k]];
        if (Array.isArray(fallbacks)) return _firstDefined(flat, fallbacks);
        return '';
      };
      return {
        phone:         _digits(get('phone',         ['from', 'caller', 'caller_number', 'CallFrom', 'mobile'])),
        toPhone:       _digits(get('to_phone',      ['to', 'called', 'called_number', 'CallTo', 'virtual_number', 'caller_id'])),
        agent_id:      String(get('agent_id',       ['agent', 'agent_id', 'agentId', 'extension', 'user']) || ''),
        direction:     String(get('direction',      ['direction', 'type', 'CallType', 'Direction']) || 'in').toLowerCase(),
        duration_s:    Number(get('duration_s',     ['duration', 'duration_s', 'DialCallDuration', 'CallDuration', 'Duration']) || 0),
        recording_url: String(get('recording_url',  ['recording', 'recording_url', 'RecordingUrl', 'RecordingURL', 'audio']) || ''),
        event:         String(get('event',          ['event', 'status', 'CallStatus', 'EventType']) || 'call_ended').toLowerCase(),
        call_id:       String(get('call_id',        ['call_id', 'CallSid', 'uuid', 'callId', 'id']) || ''),
        raw: body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      // Generic outbound requires the tenant to also configure an
      // outbound URL template in their field_mapping (key: outbound_url)
      // with {agent} and {to} placeholders. Anything else is on them.
      const tmpl = String(cfg && cfg.field_mapping && cfg.field_mapping.outbound_url || '');
      if (!tmpl) throw new Error('Generic outbound requires field_mapping.outbound_url with {agent}/{to} placeholders');
      const url = tmpl.replace(/\{agent\}/g, encodeURIComponent(fromAgent || '')).replace(/\{to\}/g, encodeURIComponent(toNumber || ''));
      const r = await fetch(url, { method: 'POST' });
      return { ok: r.ok, status: r.status, http: r.status };
    }
  },

  // ---- Exotel (Indian SaaS telephony) ----
  // Inbound payload field names: From, To, CallSid, CallType, Direction, RecordingUrl, DialCallDuration
  // Outbound: POST https://<apikey>:<apitoken>@api.exotel.com/v1/Accounts/<sid>/Calls/connect.json
  exotel: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.From || b.CallFrom),
        toPhone:       _digits(b.To || b.CallTo),
        agent_id:      String(b.AgentNumber || b.AgentId || ''),
        direction:     (b.Direction || b.CallType || 'inbound').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.DialCallDuration || b.ConversationDuration || 0),
        recording_url: String(b.RecordingUrl || ''),
        event:         String(b.CallType || b.EventType || 'call_ended').toLowerCase(),
        call_id:       String(b.CallSid || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.account_sid || !cfg.api_key || !cfg.api_token) {
        throw new Error('Exotel: account_sid + api_key + api_token are required');
      }
      const url = `https://api.exotel.com/v1/Accounts/${encodeURIComponent(cfg.account_sid)}/Calls/connect.json`;
      const fd = new URLSearchParams();
      fd.set('From', String(fromAgent || ''));
      fd.set('To',   String(toNumber  || ''));
      if (cfg.caller_id) fd.set('CallerId', cfg.caller_id);
      const auth = Buffer.from(cfg.api_key + ':' + cfg.api_token).toString('base64');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Exotel: ' + (j.RestException && j.RestException.Message || r.status));
      return { ok: true, call_id: j.Call && j.Call.Sid, raw: j };
    }
  },

  // ---- MyOperator ----
  // Inbound payload uses caller / receiver / call_id / call_duration / recording
  // Outbound: POST https://api.myoperator.co/v1/click_to_call with token header
  myoperator: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.caller || b.from || b.caller_number),
        toPhone:       _digits(b.receiver || b.to || b.virtual_number),
        agent_id:      String(b.agent || b.agent_id || b.extension || ''),
        direction:     String(b.call_type || b.type || 'incoming').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.call_duration || b.duration || 0),
        recording_url: String(b.recording || b.recording_url || ''),
        event:         String(b.event || b.status || 'call_ended').toLowerCase(),
        call_id:       String(b.call_id || b.uuid || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.api_token) throw new Error('MyOperator: api_token required');
      const url = (cfg.api_base_url && cfg.api_base_url.replace(/\/$/, '') || 'https://api.myoperator.co') + '/v1/click_to_call';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'token': cfg.api_token },
        body: JSON.stringify({ agent_number: fromAgent, customer_number: toNumber, caller_id: cfg.caller_id || undefined })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.status === 'error') throw new Error('MyOperator: ' + (j.message || r.status));
      return { ok: true, call_id: j.call_id || j.unique_id, raw: j };
    }
  },

  // ---- Knowlarity (Super Receptionist) ----
  knowlarity: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.caller_number || b.caller_id || b.from),
        toPhone:       _digits(b.virtual_number || b.dispnumber || b.to),
        agent_id:      String(b.agent_number || b.agent_id || ''),
        direction:     String(b.call_type || 'inbound').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.call_duration || b.duration || 0),
        recording_url: String(b.recording_url || b.uri || ''),
        event:         String(b.event_type || b.event || 'call_ended').toLowerCase(),
        call_id:       String(b.uuid || b.call_id || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.api_key || !cfg.account_sid) throw new Error('Knowlarity: api_key + account_sid required');
      const url = (cfg.api_base_url || 'https://kpi.knowlarity.com/Basic/v1') + '/account/call/makecall';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'authorization': cfg.api_key, 'x-api-key': cfg.account_sid },
        body: JSON.stringify({ k_number: cfg.caller_id, agent_number: fromAgent, customer_number: toNumber, caller_id: cfg.caller_id })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error('Knowlarity: ' + (j.message || r.status));
      return { ok: true, call_id: j.uuid || j.call_id, raw: j };
    }
  },

  // ---- Tata Tele (Smartflo) ----
  tata: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.caller_id_number || b.caller_no_with_prefix || b.from),
        toPhone:       _digits(b.call_to_number || b.did_number || b.to),
        agent_id:      String(b.agent_number || b.agent_name || ''),
        direction:     String(b.direction || b.call_type || 'inbound').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.duration || b.call_duration || 0),
        recording_url: String(b.recording_url || b.call_recording || ''),
        event:         String(b.status || b.event || 'call_ended').toLowerCase(),
        call_id:       String(b.uuid || b.call_id || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.api_token) throw new Error('Tata Tele: api_token required');
      const url = (cfg.api_base_url || 'https://api-smartflo.tatateleservices.com/v1') + '/click_to_call';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_token },
        body: JSON.stringify({ agent_number: fromAgent, destination_number: toNumber, caller_id: cfg.caller_id || undefined })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.success === false) throw new Error('Tata Tele: ' + (j.message || r.status));
      return { ok: true, call_id: j.callid || j.call_id, raw: j };
    }
  },

  // ---- Servetel ----
  servetel: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.caller_id_number || b.from),
        toPhone:       _digits(b.did_number || b.to),
        agent_id:      String(b.agent_number || b.agent_id || ''),
        direction:     String(b.direction || 'inbound').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.call_duration || b.duration || 0),
        recording_url: String(b.recording_url || ''),
        event:         String(b.status || 'call_ended').toLowerCase(),
        call_id:       String(b.uuid || b.call_id || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.api_token) throw new Error('Servetel: api_token required');
      const url = (cfg.api_base_url || 'https://api.servetel.in/v1') + '/click_to_call';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.api_token },
        body: JSON.stringify({ agent_number: fromAgent, customer_number: toNumber, caller_id: cfg.caller_id || undefined })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Servetel: ' + (j.message || r.status));
      return { ok: true, call_id: j.call_id, raw: j };
    }
  },

  // ---- Ozonetel (CloudAgent) ----
  ozonetel: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.cli || b.caller_id_number || b.from),
        toPhone:       _digits(b.did || b.to),
        agent_id:      String(b.agent_id || b.user_id || ''),
        direction:     String(b.direction || b.calltype || 'inbound').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.duration || b.call_duration || 0),
        recording_url: String(b.recording_url || b.recording_filename || ''),
        event:         String(b.event || b.status || 'call_ended').toLowerCase(),
        call_id:       String(b.uuid || b.callid || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.api_key || !cfg.account_sid) throw new Error('Ozonetel: api_key + account_sid required');
      const url = (cfg.api_base_url || 'https://api1.cloudagent.in/CAServices/CAServices/agentManualDial.php') +
        '?apiKey=' + encodeURIComponent(cfg.api_key) +
        '&userName=' + encodeURIComponent(cfg.account_sid) +
        '&customerNumber=' + encodeURIComponent(toNumber) +
        '&agentNumber=' + encodeURIComponent(fromAgent);
      const r = await fetch(url, { method: 'GET' });
      const txt = await r.text().catch(() => '');
      if (!r.ok) throw new Error('Ozonetel: ' + r.status);
      return { ok: true, raw: txt };
    }
  },

  // ---- Twilio (international) ----
  twilio: {
    normalize(req) {
      const b = Object.assign({}, req.body || {}, req.query || {});
      return {
        phone:         _digits(b.From || b.Caller),
        toPhone:       _digits(b.To || b.Called),
        agent_id:      String(b.AgentSid || b.ForwardedFrom || ''),
        direction:     String(b.Direction || 'inbound').toLowerCase().startsWith('out') ? 'out' : 'in',
        duration_s:    Number(b.CallDuration || b.Duration || 0),
        recording_url: String(b.RecordingUrl || ''),
        event:         String(b.CallStatus || 'call_ended').toLowerCase(),
        call_id:       String(b.CallSid || ''),
        raw: req.body
      };
    },
    async initiateCall(cfg, { fromAgent, toNumber }) {
      if (!cfg.account_sid || !cfg.api_token) throw new Error('Twilio: account_sid + api_token required');
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.account_sid)}/Calls.json`;
      const fd = new URLSearchParams();
      fd.set('From', String(cfg.caller_id || fromAgent || ''));
      fd.set('To',   String(toNumber || ''));
      // Tenant must provide a TwiML URL via field_mapping.twiml_url
      const twimlUrl = (cfg.field_mapping && cfg.field_mapping.twiml_url) || '';
      if (twimlUrl) fd.set('Url', twimlUrl);
      const auth = Buffer.from(cfg.account_sid + ':' + cfg.api_token).toString('base64');
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fd
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Twilio: ' + (j.message || r.status));
      return { ok: true, call_id: j.sid, raw: j };
    }
  }
};

const VENDORS = Object.keys(ADAPTERS);

// ----------------------------------------------------------------
// APIs
// ----------------------------------------------------------------

/** List vendor catalog (for the SPA's vendor picker). No auth needed. */
async function api_ivr_vendors() {
  return {
    vendors: [
      { key: 'exotel',     name: 'Exotel',                docs_url: 'https://developer.exotel.com/api/' },
      { key: 'myoperator', name: 'MyOperator',            docs_url: 'https://developers.myoperator.com/' },
      { key: 'knowlarity', name: 'Knowlarity (Super Receptionist)', docs_url: 'https://docs.knowlarity.com/' },
      { key: 'tata',       name: 'Tata Tele (Smartflo)',  docs_url: 'https://api-smartflo.tatateleservices.com/' },
      { key: 'servetel',   name: 'Servetel',              docs_url: 'https://www.servetel.in/api-documentation' },
      { key: 'ozonetel',   name: 'Ozonetel (CloudAgent)', docs_url: 'https://docs.ozonetel.com/' },
      { key: 'twilio',     name: 'Twilio',                docs_url: 'https://www.twilio.com/docs/voice/api' },
      { key: 'generic',    name: 'Generic / Custom',      docs_url: '' }
    ]
  };
}

/** List all IVR configs for the tenant (admin/manager only). */
async function api_ivr_configs_list(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  const r = await db.query('SELECT * FROM ivr_configs ORDER BY id ASC');
  return r.rows.map(c => Object.assign({}, c, {
    // mask credentials in the listing view
    api_key:   c.api_key   ? '••••' + String(c.api_key).slice(-4)   : '',
    api_token: c.api_token ? '••••' + String(c.api_token).slice(-4) : ''
  }));
}

/** Get one config WITH the credentials in the clear (for edit form). */
async function api_ivr_config_get(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const r = await db.query('SELECT * FROM ivr_configs WHERE id = $1 LIMIT 1', [Number(id)]);
  return r.rows[0] || null;
}

/** Create or update an IVR config. */
async function api_ivr_config_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const p = payload || {};
  const vendorKey = String(p.vendor_key || '').toLowerCase();
  if (!VENDORS.includes(vendorKey)) throw new Error('Unknown vendor: ' + vendorKey);
  if (!p.display_name) throw new Error('Display name required');
  const data = {
    vendor_key:        vendorKey,
    display_name:      String(p.display_name).slice(0, 120),
    is_active:         p.is_active != null ? Number(p.is_active) : 1,
    is_default:        Number(p.is_default) === 1 ? 1 : 0,
    api_base_url:      String(p.api_base_url || ''),
    account_sid:       String(p.account_sid || ''),
    api_key:           String(p.api_key || ''),
    api_token:         String(p.api_token || ''),
    caller_id:         String(p.caller_id || ''),
    webhook_secret:    String(p.webhook_secret || crypto.randomBytes(16).toString('hex')),
    field_mapping:     p.field_mapping || null,
    auto_create_lead:  Number(p.auto_create_lead) === 0 ? 0 : 1,
    default_status_id: p.default_status_id ? Number(p.default_status_id) : null,
    notes:             String(p.notes || '')
  };
  // Only one default
  if (data.is_default === 1) {
    await db.query('UPDATE ivr_configs SET is_default = 0');
  }
  if (p.id) {
    await db.query(
      `UPDATE ivr_configs SET vendor_key=$1, display_name=$2, is_active=$3, is_default=$4,
         api_base_url=$5, account_sid=$6, api_key=$7, api_token=$8, caller_id=$9,
         webhook_secret=$10, field_mapping=$11, auto_create_lead=$12, default_status_id=$13,
         notes=$14, updated_at=NOW()
       WHERE id=$15`,
      [data.vendor_key, data.display_name, data.is_active, data.is_default,
       data.api_base_url, data.account_sid, data.api_key, data.api_token, data.caller_id,
       data.webhook_secret, data.field_mapping ? JSON.stringify(data.field_mapping) : null,
       data.auto_create_lead, data.default_status_id, data.notes, Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  } else {
    const id = await db.insert('ivr_configs', data);
    return { ok: true, id };
  }
}

async function api_ivr_config_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.query('DELETE FROM ivr_configs WHERE id = $1', [Number(id)]);
  return { ok: true };
}

/** Build the webhook URL to paste into the vendor dashboard. */
async function api_ivr_webhook_url(token, id) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query('SELECT vendor_key, webhook_secret FROM ivr_configs WHERE id=$1', [Number(id)]);
  const c = r.rows[0]; if (!c) throw new Error('Config not found');
  const base = process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com';
  // tenantStorage exposes slug
  const slug = (db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore() && db.tenantStorage.getStore().slug) || '';
  return {
    inbound_url: `${base}/t/${slug}/hook/ivr/${c.vendor_key}?secret=${encodeURIComponent(c.webhook_secret)}`,
    secret: c.webhook_secret
  };
}

/** Outbound click-to-call. Called from the SPA when a user clicks Call. */
async function api_ivr_initiateCall(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  const toNumber = String(p.phone || '').replace(/[^\d+]/g, '');
  if (!toNumber) throw new Error('Phone required');
  // Pick config: explicit id wins, else the default-active row, else any active.
  let cfg;
  if (p.config_id) {
    const r = await db.query('SELECT * FROM ivr_configs WHERE id=$1 AND is_active=1', [Number(p.config_id)]);
    cfg = r.rows[0];
  }
  if (!cfg) {
    const r = await db.query('SELECT * FROM ivr_configs WHERE is_active=1 ORDER BY is_default DESC, id ASC LIMIT 1');
    cfg = r.rows[0];
  }
  if (!cfg) throw new Error('No active IVR config — connect a vendor in Settings → Integrations → Cloud Calling');
  // Resolve agent number: per-user override > caller_id default
  const ur = await db.query('SELECT ivr_agent_id, ivr_extension, phone FROM users WHERE id=$1', [me.id]);
  const u = ur.rows[0] || {};
  const fromAgent = String(p.from_agent || u.ivr_agent_id || u.ivr_extension || u.phone || '');
  if (!fromAgent) throw new Error('Your user record has no IVR agent number/extension. Set it in Users → Edit.');
  const adapter = ADAPTERS[cfg.vendor_key] || ADAPTERS.generic;
  let result;
  try { result = await adapter.initiateCall(cfg, { fromAgent, toNumber }); }
  catch (e) { throw new Error(cfg.display_name + ' click-to-call failed: ' + e.message); }
  // Log a call_event placeholder so the call shows in Recent Calls
  try {
    let leadId = null;
    if (p.lead_id) leadId = Number(p.lead_id);
    await db.insert('call_events', {
      lead_id: leadId, user_id: me.id,
      phone: toNumber, direction: 'out',
      event: 'click_to_call_initiated',
      duration_s: 0,
      ivr_call_id: result.call_id || '',
      ivr_vendor: cfg.vendor_key,
      created_at: db.nowIso()
    });
  } catch (_) {}
  return { ok: true, vendor: cfg.vendor_key, call_id: result.call_id || null };
}

// ----------------------------------------------------------------
// Express inbound webhook handler.
// Mounted by server.js as: POST /t/<slug>/hook/ivr/:vendor
// (already runs inside tenantStorage scope via the same wrapper as
// /hook/leadsource etc.)
// ----------------------------------------------------------------
async function expressInbound(req, res) {
  try {
    await _ensureSchema();
    const vendorKey = String(req.params.vendor || '').toLowerCase();
    const r = await db.query(
      `SELECT * FROM ivr_configs WHERE vendor_key=$1 AND is_active=1
        ORDER BY is_default DESC, id ASC LIMIT 1`,
      [vendorKey]
    );
    const cfg = r.rows[0];
    if (!cfg) {
      // No config — log to error log via warn but still 200 so the vendor
      // doesn't retry forever.
      console.warn('[ivr] inbound on /hook/ivr/' + vendorKey + ' but no active config for this vendor on this tenant');
      return res.sendStatus(200);
    }
    // Verify shared secret if configured (in query or header)
    if (cfg.webhook_secret) {
      const got = String(req.query.secret || req.headers['x-ivr-secret'] || req.body && req.body.secret || '');
      if (got !== cfg.webhook_secret) {
        console.warn('[ivr] bad secret for ' + vendorKey);
        return res.status(401).send('bad secret');
      }
    }
    const adapter = ADAPTERS[vendorKey] || ADAPTERS.generic;
    const ev = adapter.normalize(req, cfg);
    if (!ev.phone) {
      console.warn('[ivr] inbound missing phone:', req.body);
      return res.sendStatus(200);
    }
    // Find lead by phone (uses existing helper if available)
    let leadId = null;
    try {
      const lr = await db.query(
        `SELECT id FROM leads
          WHERE regexp_replace(phone::text, '\\D', '', 'g') LIKE '%' || $1
             OR regexp_replace(whatsapp::text, '\\D', '', 'g') LIKE '%' || $1
          ORDER BY id DESC LIMIT 1`,
        [ev.phone.slice(-10)]
      );
      if (lr.rows[0]) leadId = lr.rows[0].id;
    } catch (_) {}
    // Auto-create lead from inbound if configured
    if (!leadId && Number(cfg.auto_create_lead) === 1 && ev.direction === 'in') {
      try {
        const statusId = cfg.default_status_id || (await db.query(`SELECT id FROM statuses WHERE LOWER(name)='new' LIMIT 1`)).rows[0]?.id || null;
        leadId = await db.insert('leads', {
          name: ev.phone, phone: ev.phone, whatsapp: ev.phone,
          source: cfg.display_name || 'IVR',
          source_ref: 'auto-created from inbound IVR call',
          status_id: statusId,
          notes: 'Auto-created from inbound call via ' + cfg.display_name,
          created_at: db.nowIso(),
          updated_at: db.nowIso(),
          last_status_change_at: db.nowIso()
        });
      } catch (e) { console.warn('[ivr] auto-create lead failed:', e.message); }
    }
    // Resolve which user this call belongs to (by ivr_agent_id mapping)
    let userId = null;
    if (ev.agent_id) {
      try {
        const ur = await db.query(`SELECT id FROM users WHERE ivr_agent_id=$1 OR ivr_extension=$1 LIMIT 1`, [String(ev.agent_id)]);
        if (ur.rows[0]) userId = ur.rows[0].id;
      } catch (_) {}
    }
    // Write call_event
    await db.insert('call_events', {
      lead_id: leadId,
      user_id: userId,
      phone: ev.phone,
      direction: ev.direction === 'out' ? 'out' : (ev.event.includes('miss') ? 'missed' : 'in'),
      event: ev.event || 'call_ended',
      duration_s: Number(ev.duration_s) || 0,
      ivr_call_id: ev.call_id || '',
      ivr_vendor: vendorKey,
      recording_url: ev.recording_url || null,
      created_at: db.nowIso()
    });
    res.json({ ok: true, lead_id: leadId, user_id: userId });
  } catch (e) {
    console.error('[ivr] inbound error:', e.message);
    res.status(400).json({ error: e.message });
  }
}

module.exports = {
  // Tenant APIs
  api_ivr_vendors,
  api_ivr_configs_list,
  api_ivr_config_get,
  api_ivr_config_save,
  api_ivr_config_delete,
  api_ivr_webhook_url,
  api_ivr_initiateCall,
  // Express
  expressInbound,
  // Introspection
  ADAPTERS, VENDORS
};
