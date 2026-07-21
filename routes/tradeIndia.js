/* ============================================================================
 * TRADEINDIA_API_v1 (2026-07-20)
 *
 * Pull TradeIndia inquiries into the CRM as Leads on a schedule.
 *
 *   GET https://www.tradeindia.com/utils/my_inquiry.html
 *       ?userid=&profile_id=&key=&from_date=&to_date=&limit=&page_no=
 *
 * Design notes / why this is a standalone module:
 *   The repo already had a half-built "native pull" framework
 *   (integration_configs + _runNativePull in routes/integrations.js) for
 *   IndiaMART/JustDial, but it has never actually run: the table is not in
 *   db/schema.sql, is NOT registered in db/pg.js SCHEMA (so db.getAll throws
 *   "Unknown table"), the throw is swallowed by a try/catch, there is no UI,
 *   and runDueNativePulls() is invoked with no tenant AsyncLocalStorage scope.
 *   Rather than build on that, this module owns its own schema + scheduler and
 *   is written provider-generically (marketplace_* tables carry a `provider`
 *   column) so IndiaMART / JustDial / ExportersIndia can reuse it later —
 *   the "generic marketplace engine" in the spec's Future Scope.
 *
 * Both tables are registered in db/pg.js SCHEMA in the SAME commit — an
 * unregistered table makes every db.insert/getAll throw "Unknown table: X".
 * ==========================================================================*/

const db = require('../db/pg');

const PROVIDER        = 'tradeindia';
const DEFAULT_API_URL = 'https://www.tradeindia.com/utils/my_inquiry.html';
const PAGE_LIMIT      = 100;
const MAX_PAGES       = 50;      // hard guard against a runaway pagination loop
const MAX_RETRIES     = 3;
const SOURCE_LABEL    = 'TradeIndia';
const MAPPING_SOURCE  = 'tradeindia_api';   // key into lead_source_mapping

/* TradeIndia fields that have no dedicated lead column. Auto-created as real
 * custom fields so they are visible, filterable and mappable in the UI. */
const TI_CUSTOM_FIELDS = [
  { key: 'ti_subject',        label: 'Lead Title' },
  { key: 'ti_inquiry_type',   label: 'Inquiry Type' },
  { key: 'ti_source_detail',  label: 'Source Detail' },
  { key: 'ti_sender_uid',     label: 'External Customer ID' },
  { key: 'ti_view_status',    label: 'Read Status' },
  { key: 'ti_inquiry_date',   label: 'Inquiry Date' },
  { key: 'ti_inquiry_time',   label: 'Inquiry Time' },
];

// ============================================================
// Schema
// ============================================================
let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS marketplace_integrations (
    id SERIAL PRIMARY KEY,
    provider          TEXT NOT NULL,
    api_url           TEXT,
    api_user_id       TEXT,
    api_profile_id    TEXT,
    api_key           TEXT,
    sync_interval_min INTEGER NOT NULL DEFAULT 15,
    auto_import       INTEGER NOT NULL DEFAULT 0,
    duplicate_rule    TEXT    NOT NULL DEFAULT 'skip',
    enable_logs       INTEGER NOT NULL DEFAULT 1,
    lookback_days     INTEGER NOT NULL DEFAULT 7,
    last_sync_at      TIMESTAMPTZ,
    sync_status       TEXT,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_int_provider
                  ON marketplace_integrations(provider)`);
  await db.query(`CREATE TABLE IF NOT EXISTS marketplace_sync_logs (
    id SERIAL PRIMARY KEY,
    provider         TEXT NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    api_url          TEXT,
    records_received INTEGER DEFAULT 0,
    imported_count   INTEGER DEFAULT 0,
    updated_count    INTEGER DEFAULT 0,
    skipped_count    INTEGER DEFAULT 0,
    error_count      INTEGER DEFAULT 0,
    response_ms      INTEGER DEFAULT 0,
    status           TEXT,
    message          TEXT,
    trigger_type     TEXT
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_mkt_logs_provider
                  ON marketplace_sync_logs(provider, started_at DESC)`);
  _schemaReady = true;
}

// ============================================================
// Helpers
// ============================================================

/** Strip HTML but keep line breaks — spec: "Preserve line breaks. Plain text only." */
function _stripHtml(input) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  // Block-level tags break the line on BOTH the opening and closing tag —
  // closing-only left "…2,00,000<p>Call me</p>" glued as "2,00,000Call me".
  s = s.replace(/<\s*\/?\s*(p|div|tr|li|h[1-6]|table|ul|ol|blockquote)(\s[^>]*)?>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
       .replace(/&apos;/gi, "'").replace(/&#8377;/gi, '₹');
  s = s.replace(/\r/g, '');
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** TradeIndia may return a bare array or wrap it — normalise every shape. */
function _asArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const k of ['data', 'result', 'results', 'records', 'inquiries', 'rows', 'items', 'response']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  // Single object that looks like an inquiry
  if (payload.rfi_id || payload.sender_name || payload.sender_mobile) return [payload];
  return [];
}

function _ymd(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function _pick(row, keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return String(row[k]).trim();
    }
  }
  return '';
}

function _buildUrl(cfg, fromStr, toStr, page) {
  const base = (cfg.api_url || DEFAULT_API_URL).trim();
  const qs = new URLSearchParams({
    userid:     cfg.api_user_id || '',
    profile_id: cfg.api_profile_id || '',
    key:        cfg.api_key || '',
    from_date:  fromStr,
    to_date:    toStr,
    limit:      String(PAGE_LIMIT),
    page_no:    String(page),
  });
  return base + (base.includes('?') ? '&' : '?') + qs.toString();
}

/** Never store or show the API key in logs. */
function _redactUrl(url) {
  return String(url).replace(/([?&]key=)[^&]*/i, '$1***');
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

/** GET + JSON parse with up to MAX_RETRIES attempts (spec: retry failed requests 3x). */
async function _fetchJson(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let res, text;
      try {
        res = await fetch(url, {
          method: 'GET',
          signal: ctrl.signal,
          headers: { 'Accept': 'application/json', 'User-Agent': 'SmartCRM/1.0' },
        });
        text = await res.text();
      } finally { clearTimeout(timer); }

      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(text || '').slice(0, 200));
      const trimmed = String(text || '').trim();
      if (!trimmed) return [];
      try {
        return JSON.parse(trimmed);
      } catch (_) {
        // TradeIndia sometimes prefixes junk / returns an HTML error page
        const i = trimmed.indexOf('['), j = trimmed.indexOf('{');
        const start = (i === -1) ? j : (j === -1 ? i : Math.min(i, j));
        if (start > 0) {
          try { return JSON.parse(trimmed.slice(start)); } catch (_) {}
        }
        throw new Error('Response was not JSON: ' + trimmed.slice(0, 200));
      }
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await _sleep(attempt * 1500);
    }
  }
  throw new Error('TradeIndia request failed after ' + MAX_RETRIES + ' attempts: ' + (lastErr && lastErr.message));
}

// ============================================================
// Settings
// ============================================================
async function _getSettings() {
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM marketplace_integrations WHERE provider = $1 LIMIT 1`, [PROVIDER]);
  if (r.rows.length) return r.rows[0];
  return {
    provider: PROVIDER, api_url: DEFAULT_API_URL,
    api_user_id: '', api_profile_id: '', api_key: '',
    sync_interval_min: 15, auto_import: 0, duplicate_rule: 'skip',
    enable_logs: 1, lookback_days: 7,
    last_sync_at: null, sync_status: null, last_error: null,
  };
}

async function _persistSettings(patch) {
  await _ensureSchema();
  const cur = await db.query(`SELECT id FROM marketplace_integrations WHERE provider = $1 LIMIT 1`, [PROVIDER]);
  const cols = Object.keys(patch);
  if (!cols.length) return;
  if (cur.rows.length) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    await db.query(
      `UPDATE marketplace_integrations SET ${sets}, updated_at = NOW() WHERE id = $${cols.length + 1}`,
      [...cols.map(c => patch[c]), cur.rows[0].id]
    );
  } else {
    const names = ['provider', ...cols];
    const ph = names.map((_, i) => `$${i + 1}`).join(', ');
    await db.query(
      `INSERT INTO marketplace_integrations (${names.join(', ')}) VALUES (${ph})`,
      [PROVIDER, ...cols.map(c => patch[c])]
    );
  }
}

/** Keep a control-DB registry of which tenants to poll, so the 15-min sweep
 *  never has to open all ~95 tenant databases just to discover config. */
async function _registerTenantForSync(enabled) {
  try {
    const controlDb = require('../control/db');
    const slug = (db.tenantStorage && db.tenantStorage.getStore &&
                  db.tenantStorage.getStore() || {}).slug;
    if (!slug) return;
    await controlDb.query(`CREATE TABLE IF NOT EXISTS marketplace_sync_registry (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL,
      provider TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await controlDb.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_reg
      ON marketplace_sync_registry(slug, provider)`);
    await controlDb.query(
      `INSERT INTO marketplace_sync_registry (slug, provider, enabled, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (slug, provider) DO UPDATE SET enabled = $3, updated_at = NOW()`,
      [slug, PROVIDER, enabled ? 1 : 0]
    );
  } catch (e) { console.warn('[tradeindia] registry upsert skipped:', e.message); }
}

// ============================================================
// Custom fields + owner
// ============================================================
async function _ensureCustomFields() {
  try {
    const existing = await db.getAll('custom_fields');
    const have = new Set(existing.map(c => c.key));
    let order = existing.length;
    for (const f of TI_CUSTOM_FIELDS) {
      if (have.has(f.key)) continue;
      await db.insert('custom_fields', {
        key: f.key, label: f.label, field_type: 'text', options: '',
        is_required: 0, show_in_list: 0, sort_order: ++order, is_active: 1,
      });
    }
  } catch (e) { console.warn('[tradeindia] custom field ensure skipped:', e.message); }
}

async function _ownerUserId() {
  const users = await db.getAll('users');
  const admin = users.find(u => u.role === 'admin' && Number(u.is_active)) || users[0];
  if (!admin) throw new Error('No active user to own imported leads');
  return admin.id;
}

// ============================================================
// Mapping — defaults, overlaid with the tenant's saved custom mapping
// ============================================================
async function _loadMapping() {
  try {
    const r = await db.query(
      `SELECT mapping FROM lead_source_mapping WHERE source = $1 LIMIT 1`, [MAPPING_SOURCE]);
    if (!r.rows.length) return {};
    const m = r.rows[0].mapping;
    return (typeof m === 'string') ? JSON.parse(m || '{}') : (m || {});
  } catch (_) { return {}; }
}

function _defaultPayload(row) {
  const message = _stripHtml(_pick(row, ['message', 'msg', 'enquiry', 'description']));
  const subject = _pick(row, ['subject', 'title']);
  const notes   = [subject ? ('Subject: ' + subject) : '', message].filter(Boolean).join('\n');
  return {
    name:       _pick(row, ['sender_name', 'name', 'contact_person']),
    phone:      _pick(row, ['sender_mobile', 'mobile', 'phone']),
    alt_phone:  _pick(row, ['sender_other_mobiles', 'other_mobiles', 'alt_phone']),
    email:      _pick(row, ['sender_email', 'email']),
    company:    _pick(row, ['sender_co', 'company', 'sender_company']),
    city:       _pick(row, ['sender_city', 'city']),
    state:      _pick(row, ['sender_state', 'state']),
    country:    _pick(row, ['sender_country', 'country']),
    product:    _pick(row, ['product_name', 'product']),
    notes:      notes,
    source:     SOURCE_LABEL,
    source_ref: _pick(row, ['rfi_id', 'RFI_ID', 'inquiry_id', 'id']),
    custom_fields: {
      ti_subject:       subject,
      ti_inquiry_type:  _pick(row, ['inquiry_type']),
      ti_source_detail: _pick(row, ['source']),
      ti_sender_uid:    _pick(row, ['sender_uid']),
      ti_view_status:   _pick(row, ['view_status']),
      ti_inquiry_date:  _pick(row, ['generated_date']),
      ti_inquiry_time:  _pick(row, ['generated_time']),
    },
  };
}

/** Overlay the tenant's saved mapping: { tradeIndiaKey: 'crm_field' | 'cf_key' } */
function _applyMapping(row, payload, mapping) {
  const out = Object.assign({}, payload);
  out.custom_fields = Object.assign({}, payload.custom_fields);
  for (const [src, target] of Object.entries(mapping || {})) {
    if (!target) continue;
    let v = row[src];
    if (v === undefined || v === null) continue;
    v = String(v).trim();
    if (!v) continue;
    if (src === 'message') v = _stripHtml(v);
    if (String(target).startsWith('cf_')) out.custom_fields[String(target).slice(3)] = v;
    else out[target] = v;
  }
  return out;
}

// ============================================================
// Import one inquiry
// ============================================================
async function _importOne(row, cfg, ownerId, mapping) {
  const base    = _defaultPayload(row);
  const payload = _applyMapping(row, base, mapping);
  const rfi     = payload.source_ref;

  if (!String(payload.phone || '').replace(/\D/g, '')) return 'skipped';

  // Duplicate check — primary key is rfi_id, stored on leads.source_ref
  if (rfi) {
    const dup = await db.query(
      `SELECT id FROM leads WHERE source_ref = $1 ORDER BY id DESC LIMIT 1`, [String(rfi)]);
    if (dup.rows.length) {
      if (String(cfg.duplicate_rule || 'skip') !== 'update') return 'skipped';
      const leadId = dup.rows[0].id;
      const patch  = { updated_at: db.nowIso() };
      ['name', 'phone', 'alt_phone', 'email', 'company', 'city', 'state', 'country', 'product']
        .forEach(k => { if (payload[k]) patch[k] = payload[k]; });
      await db.update('leads', leadId, patch);
      await _addTimeline(leadId, ownerId, rfi, true);
      return 'updated';
    }
  }

  const integrations = require('./integrations');
  const created = await integrations._internalCreateLead(payload, ownerId);
  if (created && created.id) await _addTimeline(created.id, ownerId, rfi, false);
  return 'imported';
}

/** Spec: Timeline Entry. The CRM timeline is the `remarks` table. */
async function _addTimeline(leadId, userId, rfi, isUpdate) {
  try {
    const stamp = new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const text = (isUpdate
      ? 'Lead updated automatically from TradeIndia API.'
      : 'Lead imported automatically from TradeIndia API.')
      + (rfi ? ('\nRFI ID: ' + rfi) : '') + '\nImported On: ' + stamp;
    await db.insert('remarks', { lead_id: leadId, user_id: userId, remark: text, status_id: '' });
  } catch (e) { console.warn('[tradeindia] timeline skipped:', e.message); }
}

// ============================================================
// Core sync
// ============================================================
async function runSync(opts) {
  const trigger = (opts && opts.trigger) || 'auto';
  await _ensureSchema();
  const cfg = await _getSettings();

  if (!cfg.api_key || !cfg.api_user_id || !cfg.api_profile_id) {
    throw new Error('TradeIndia credentials incomplete — set User ID, Profile ID and API Key first.');
  }

  const t0 = Date.now();
  const stats = { records_received: 0, imported_count: 0, updated_count: 0, skipped_count: 0, error_count: 0 };
  let status = 'success', message = '', firstUrl = '';

  try {
    await _ensureCustomFields();
    const ownerId = await _ownerUserId();
    const mapping = await _loadMapping();

    const lookback = Math.max(1, Number(cfg.lookback_days) || 7);
    // Re-scan from a day before the last sync so nothing straddling the
    // boundary is missed; rfi_id dedupe makes the overlap harmless.
    const from = cfg.last_sync_at
      ? new Date(new Date(cfg.last_sync_at).getTime() - 24 * 3600 * 1000)
      : new Date(Date.now() - lookback * 24 * 3600 * 1000);
    const fromStr = _ymd(from), toStr = _ymd(new Date());

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = _buildUrl(cfg, fromStr, toStr, page);
      if (page === 1) firstUrl = _redactUrl(url);
      const rows = _asArray(await _fetchJson(url));
      stats.records_received += rows.length;
      for (const row of rows) {
        try {
          const outcome = await _importOne(row, cfg, ownerId, mapping);
          if (outcome === 'imported')      stats.imported_count++;
          else if (outcome === 'updated')  stats.updated_count++;
          else                             stats.skipped_count++;
        } catch (e) {
          stats.error_count++;
          console.warn('[tradeindia] row failed:', e.message);
        }
      }
      if (rows.length < PAGE_LIMIT) break;
    }
  } catch (e) {
    status = 'failed';
    message = e.message;
    stats.error_count++;
  }

  const responseMs = Date.now() - t0;

  if (Number(cfg.enable_logs) !== 0) {
    try {
      await db.insert('marketplace_sync_logs', Object.assign({
        provider: PROVIDER, api_url: firstUrl, response_ms: responseMs,
        status, message: String(message || '').slice(0, 1000), trigger_type: trigger,
      }, stats));
    } catch (e) { console.warn('[tradeindia] log write failed:', e.message); }
  }

  await _persistSettings({
    last_sync_at: new Date().toISOString(),
    sync_status:  status,
    last_error:   status === 'failed' ? String(message).slice(0, 500) : null,
  });

  return Object.assign({ ok: status === 'success', status, message, response_ms: responseMs }, stats);
}

/** Called by the scheduler inside a tenant scope. Honours auto_import + interval. */
async function runDueForCurrentTenant() {
  const cfg = await _getSettings();
  if (!Number(cfg.auto_import)) return { skipped: 'auto_import off' };
  if (!cfg.api_key || !cfg.api_user_id || !cfg.api_profile_id) return { skipped: 'not configured' };
  const every = Math.max(5, Number(cfg.sync_interval_min) || 15) * 60 * 1000;
  if (cfg.last_sync_at && (Date.now() - new Date(cfg.last_sync_at).getTime()) < every) {
    return { skipped: 'not due' };
  }
  return runSync({ trigger: 'auto' });
}

// ============================================================
// API handlers  (auto-registered by the tenant API dispatcher)
// ============================================================
const { authUser } = require('../utils/auth');

async function _requireAdmin(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  return me;
}

async function api_tradeindia_settings_get(token) {
  await _requireAdmin(token);
  const cfg = await _getSettings();
  return {
    settings: {
      api_url:           cfg.api_url || DEFAULT_API_URL,
      api_user_id:       cfg.api_user_id || '',
      api_profile_id:    cfg.api_profile_id || '',
      api_key_set:       !!cfg.api_key,
      api_key_hint:      cfg.api_key ? ('••••' + String(cfg.api_key).slice(-4)) : '',
      sync_interval_min: Number(cfg.sync_interval_min) || 15,
      auto_import:       Number(cfg.auto_import) || 0,
      duplicate_rule:    cfg.duplicate_rule || 'skip',
      enable_logs:       cfg.enable_logs === undefined ? 1 : Number(cfg.enable_logs),
      lookback_days:     Number(cfg.lookback_days) || 7,
      last_sync_at:      cfg.last_sync_at || null,
      sync_status:       cfg.sync_status || null,
      last_error:        cfg.last_error || null,
    },
    mapping_source: MAPPING_SOURCE,
    fields: TI_CUSTOM_FIELDS,
  };
}

async function api_tradeindia_settings_save(token, payload) {
  const me = await _requireAdmin(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const patch = {
    api_url:           String(p.api_url || DEFAULT_API_URL).trim(),
    api_user_id:       String(p.api_user_id || '').trim(),
    api_profile_id:    String(p.api_profile_id || '').trim(),
    sync_interval_min: Math.max(5, Number(p.sync_interval_min) || 15),
    auto_import:       p.auto_import ? 1 : 0,
    duplicate_rule:    (String(p.duplicate_rule) === 'update') ? 'update' : 'skip',
    enable_logs:       p.enable_logs ? 1 : 0,
    lookback_days:     Math.min(90, Math.max(1, Number(p.lookback_days) || 7)),
  };
  // Only overwrite the key when a new one is actually supplied, so saving the
  // form without retyping the key does not wipe it.
  if (p.api_key && String(p.api_key).trim() && !/^•+/.test(String(p.api_key))) {
    patch.api_key = String(p.api_key).trim();
  }
  await _persistSettings(patch);
  await _registerTenantForSync(patch.auto_import === 1);
  await _ensureCustomFields();
  return { ok: true };
}

async function api_tradeindia_sync_now(token) {
  await _requireAdmin(token);
  return runSync({ trigger: 'manual' });
}

async function api_tradeindia_logs_list(token, limit) {
  await _requireAdmin(token);
  await _ensureSchema();
  const n = Math.min(200, Math.max(1, Number(limit) || 30));
  const r = await db.query(
    `SELECT * FROM marketplace_sync_logs WHERE provider = $1
      ORDER BY started_at DESC LIMIT ${n}`, [PROVIDER]);
  return { logs: r.rows };
}

module.exports = {
  api_tradeindia_settings_get,
  api_tradeindia_settings_save,
  api_tradeindia_sync_now,
  api_tradeindia_logs_list,
  runSync,
  runDueForCurrentTenant,
  _stripHtml,
  _asArray,
  _defaultPayload,
  PROVIDER,
};
