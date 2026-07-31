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
/* TRADEINDIA_SCHEMA_PERPOOL_FIX_v1 (2026-07-20) — _schemaReady was a single
 * MODULE-LEVEL boolean, so the FIRST tenant to touch TradeIndia flipped it true
 * process-wide and every OTHER tenant then skipped CREATE TABLE — their DB
 * never got marketplace_integrations/marketplace_sync_logs ("relation does not
 * exist", e.g. PRAM ELECTECH). Track readiness PER TENANT POOL instead, exactly
 * like routes/aiBot.js _aiBotEnsuredPools. */
const _schemaReadyPools = new WeakSet();
async function _ensureSchema() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _schemaReadyPools.has(pool)) return;
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
  if (pool) _schemaReadyPools.add(pool);
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

function _buildUrl(cfg, fromStr, toStr, page, limit) {
  const base = (cfg.api_url || DEFAULT_API_URL).trim();
  const qs = new URLSearchParams({
    userid:     cfg.api_user_id || '',
    profile_id: cfg.api_profile_id || '',
    key:        cfg.api_key || '',
    from_date:  fromStr,
    to_date:    toStr,
    limit:      String(limit || PAGE_LIMIT),
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
/* TRADEINDIA_ENROLL_SELFHEAL_v1 (2026-07-29) — is this tenant currently enrolled
 * in the auto-pull cron (control-DB registry, enabled=1)? */
async function _isEnrolled() {
  try {
    const controlDb = require('../control/db');
    const slug = (db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore() || {}).slug;
    if (!slug) return false;
    const r = await controlDb.query(
      `SELECT enabled FROM marketplace_sync_registry WHERE slug = $1 AND provider = $2 LIMIT 1`,
      [slug, PROVIDER]);
    return !!(r.rows[0] && Number(r.rows[0].enabled) === 1);
  } catch (_) { return false; }
}

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

    /* CF... TRADEINDIA_DAYWINDOW_v1 (2026-07-20) — TradeIndia's my_inquiry.html
     * rejects any range wider than 24h ("greater than 24 hours not allowed for
     * inquiries", HTTP 400). The old code sent from=(last_sync-1d or now-7d) →
     * to=today in ONE call, which is >24h and always failed. Fix: iterate ONE
     * DAY AT A TIME (from_date == to_date), newest day first, so every request
     * is a valid ≤24h window. rfi_id dedupe makes day overlaps harmless. */
    const lookback = Math.max(1, Number(cfg.lookback_days) || 7);
    // How many days back to cover: for a scheduled run since a recent sync,
    // just today + yesterday; for a first run, the lookback window. Hard-capped
    // so a stale last_sync can't spawn hundreds of calls.
    let daysBack;
    if (cfg.last_sync_at) {
      const gapDays = Math.ceil((Date.now() - new Date(cfg.last_sync_at).getTime()) / (24 * 3600 * 1000));
      daysBack = Math.min(31, Math.max(1, gapDays + 1));   // +1 to cover the boundary day
    } else {
      daysBack = Math.min(31, lookback);
    }

    for (let d = 0; d < daysBack; d++) {
      const day = new Date(Date.now() - d * 24 * 3600 * 1000);
      const dayStr = _ymd(day);   // from_date == to_date == this single day
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = _buildUrl(cfg, dayStr, dayStr, page);
        if (!firstUrl) firstUrl = _redactUrl(url);
        let rows;
        try {
          rows = _asArray(await _fetchJson(url));
        } catch (e) {
          // One bad day shouldn't abort the whole run — log it and move on.
          stats.error_count++;
          console.warn('[tradeindia] ' + dayStr + ' p' + page + ' failed:', e.message);
          if (!message) message = e.message;
          break;   // stop paging this day
        }
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
        if (rows.length < PAGE_LIMIT) break;   // last page for this day
      }
    }
    // If nothing came back and we hit errors, this run genuinely failed —
    // don't paint a green 'success' pill over a wall of HTTP 400s.
    if (stats.records_received === 0 && stats.error_count > 0) {
      status = 'failed';
      if (!message) message = 'All requests failed';
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
/* TRADEINDIA_FIXED_SLOTS_v1 (2026-07-20) — auto-pull runs at FIXED times each
 * day: 08:00, 13:00 and 17:00 IST, for every tenant with auto-pull ON. The
 * 5-min sweep in server.js calls this; a pull fires on the first sweep at/after
 * a slot, and last_sync_at dedupes so each slot pulls exactly once per day.
 * (Env PULL_SLOTS_IST can override, e.g. "8,13,17".) */
const PULL_SLOTS_IST = String(process.env.PULL_SLOTS_IST || '8,13,17')
  .split(',').map(x => parseInt(x, 10)).filter(n => n >= 0 && n <= 23);
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The most recent scheduled slot start (as a real Date/instant) that has
 * already passed today in IST, or null if we're before the first slot. */
function _mostRecentSlotStart(now) {
  const nowMs = (now ? now.getTime() : Date.now());
  const ist = new Date(nowMs + IST_OFFSET_MS);   // IST wall-clock in UTC fields
  const y = ist.getUTCFullYear(), mo = ist.getUTCMonth(), d = ist.getUTCDate();
  const curMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  let slotHour = null;
  PULL_SLOTS_IST.slice().sort((a, b) => a - b).forEach(h => { if (curMin >= h * 60) slotHour = h; });
  if (slotHour === null) return null;
  // Convert that IST wall-time back to a real UTC instant.
  return new Date(Date.UTC(y, mo, d, slotHour, 0, 0) - IST_OFFSET_MS);
}

/** Human-readable slot list, e.g. "8:00 AM, 1:00 PM, 5:00 PM IST" — used by the
 * settings API so the tenant sees exactly when auto-pull runs. */
function pullScheduleLabel() {
  const fmt = h => {
    const ap = h < 12 ? 'AM' : 'PM';
    const hr = h % 12 === 0 ? 12 : h % 12;
    return hr + ':00 ' + ap;
  };
  return PULL_SLOTS_IST.slice().sort((a, b) => a - b).map(fmt).join(', ') + ' IST';
}

async function runDueForCurrentTenant() {
  const cfg = await _getSettings();
  if (!Number(cfg.auto_import)) return { skipped: 'auto_import off' };
  if (!cfg.api_key || !cfg.api_user_id || !cfg.api_profile_id) return { skipped: 'not configured' };
  /* Self-enroll: any configured+auto tenant we reach (via the catch-all sweep)
   * gets added to the fast 5-min registry sweep too, so enrollment can't lapse. */
  try { await _registerTenantForSync(1); } catch (_) {}
  const slotStart = _mostRecentSlotStart();
  if (!slotStart) return { skipped: 'before first slot today' };
  // Already pulled at/after this slot's start today → not due again until the
  // next slot. (Manual 'Pull leads now' also stamps last_sync_at, which just
  // means the automatic run for that slot is skipped — no double pull.)
  if (cfg.last_sync_at && new Date(cfg.last_sync_at).getTime() >= slotStart.getTime()) {
    return { skipped: 'already pulled this slot' };
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
  /* SELF-HEAL: keep the auto-pull registry in sync with the saved auto_import
   * flag every time the panel loads. This fixes tenants that were configured
   * before the schema fix (Save failed) or only ever used 'Pull leads now', so
   * they were never enrolled and the cron never visited them. */
  try { await _registerTenantForSync(Number(cfg.auto_import) === 1); } catch (_) {}
  const _enrolled = await _isEnrolled();
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
      auto_enrolled:     _enrolled,        /* in the auto-pull cron registry */
      pull_schedule_hint: pullScheduleLabel(),
    },
    mapping_source: MAPPING_SOURCE,
    fields: TI_CUSTOM_FIELDS,
    pull_schedule: pullScheduleLabel(),   /* TRADEINDIA_FIXED_SLOTS_v1 */
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
  /* Clicking 'Pull leads now' also enrolls the tenant in the auto-pull cron if
   * auto-import is on, so the automatic schedule can never silently lapse. */
  try { const cfg = await _getSettings(); await _registerTenantForSync(Number(cfg.auto_import) === 1); } catch (_) {}
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

/* TRADEINDIA_API_v1 — build the exact per-tenant URL from saved credentials and
 * do ONE live fetch so the tenant can eyeball the response before enabling the
 * cron. Returns the full openable URL (the admin's own key, their own screen)
 * plus a redacted copy and a 3-record sample. No leads are imported here. */
async function api_tradeindia_preview(token, payload) {
  await _requireAdmin(token);
  const cfg = await _getSettings();
  if (!cfg.api_key || !cfg.api_user_id || !cfg.api_profile_id) {
    throw new Error('Enter and Save your User ID, Profile ID and API Key first.');
  }
  const p = payload || {};
  const today = _ymd(new Date());
  const from  = p.from_date || today;
  const to    = p.to_date   || today;
  const page  = Math.max(1, Number(p.page_no) || 1);
  const limit = Math.min(100, Math.max(1, Number(p.limit) || 10));
  const url   = _buildUrl(cfg, from, to, page, limit);
  const t0 = Date.now();
  let rows = [], err = null, rawFirst = null;
  try {
    const parsed = await _fetchJson(url);
    rows = _asArray(parsed);
    rawFirst = Array.isArray(parsed) ? parsed.slice(0, 3) : parsed;
  } catch (e) { err = e.message; }
  return {
    ok: !err,
    url,                       // full, openable (tenant admin's own credentials)
    url_redacted: _redactUrl(url),
    from_date: from, to_date: to, limit, page_no: page,
    count: rows.length,
    response_ms: Date.now() - t0,
    sample: rows.slice(0, 3),
    raw: err ? null : rawFirst,
    error: err,
  };
}

module.exports = {
  api_tradeindia_settings_get,
  api_tradeindia_preview,
  api_tradeindia_settings_save,
  api_tradeindia_sync_now,
  api_tradeindia_logs_list,
  runSync,
  runDueForCurrentTenant,
  pullScheduleLabel,
  _stripHtml,
  _asArray,
  _defaultPayload,
  PROVIDER,
};
