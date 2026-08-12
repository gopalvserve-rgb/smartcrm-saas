// LEAD_SHEET_EXPORT_v1 (2026-08-12)
// Push a tenant's leads into a linked Google Sheet.
//   * Manual "Push now" button (api_leadSheetExport_pushNow)
//   * Real-time: onLeadChanged() is called (fire-and-forget) by the lead
//     creation paths; debounced per-tenant so a burst = ONE fresh mirror.
// Each push CLEARS then rewrites the sheet fresh (full mirror of the current
// matching leads) via utils/googleSheetsMaster.writeSheet — the same master
// Google account the Google Ads conversion export already uses.
// Registered by routes/saas/tenantApi.js (ROUTE_FILES).

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _sm = null;
function sheets() { if (!_sm) _sm = require('../utils/googleSheetsMaster'); return _sm; }

const COLUMNS = [
  { key: 'name',             label: 'Name' },
  { key: 'phone',            label: 'Phone' },
  { key: 'alt_phone',        label: 'Alt Phone' },
  { key: 'whatsapp',         label: 'WhatsApp' },
  { key: 'email',            label: 'Email' },
  { key: 'source',           label: 'Source' },
  { key: 'status',           label: 'Status' },
  { key: 'owner',            label: 'Owner' },
  { key: 'company',          label: 'Company' },
  { key: 'city',             label: 'City' },
  { key: 'state',            label: 'State' },
  { key: 'value',            label: 'Value' },
  { key: 'tags',             label: 'Tags' },
  { key: 'notes',            label: 'Notes' },
  { key: 'campaign',         label: 'Campaign' },
  { key: 'product',          label: 'Product' },
  { key: 'created_at',       label: 'Created' },
  { key: 'next_followup_at', label: 'Next Follow-up' }
];
const COLUMN_KEYS = COLUMNS.map(c => c.key);
const DEFAULT_COLUMNS = ['name', 'phone', 'email', 'source', 'status', 'owner', 'city', 'created_at'];

function _parseArr(v) {
  if (Array.isArray(v)) return v;
  if (v == null || v === '') return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

async function _ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS lead_sheet_export_settings (
      id SERIAL PRIMARY KEY,
      sheet_url TEXT DEFAULT '',
      sheet_tab TEXT DEFAULT 'Leads',
      enabled BOOLEAN DEFAULT FALSE,
      realtime_enabled BOOLEAN DEFAULT FALSE,
      columns TEXT DEFAULT '',
      filter_sources TEXT DEFAULT '',
      filter_status_ids TEXT DEFAULT '',
      filter_campaign_ids TEXT DEFAULT '',
      last_push_at TIMESTAMPTZ,
      last_push_rows INT,
      last_push_error TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`);
}

async function _row() {
  await _ensureSchema();
  const rows = await db.getAll('lead_sheet_export_settings');
  return (rows && rows[0]) || null;
}

async function _requireAdmin(token) {
  const me = await authUser(token);
  if (!me) throw new Error('Not authenticated');
  if (me.role !== 'admin') throw new Error('Only an admin can configure the Google Sheet export.');
  return me;
}

function _view(row) {
  row = row || {};
  const truthy = v => v === true || v === 1 || String(v) === 'true';
  return {
    sheet_url: row.sheet_url || '',
    sheet_tab: row.sheet_tab || 'Leads',
    enabled: truthy(row.enabled),
    realtime_enabled: truthy(row.realtime_enabled),
    columns: _parseArr(row.columns),
    filter_sources: _parseArr(row.filter_sources).map(String),
    filter_status_ids: _parseArr(row.filter_status_ids).map(Number).filter(Boolean),
    filter_campaign_ids: _parseArr(row.filter_campaign_ids).map(Number).filter(Boolean),
    last_push_at: row.last_push_at || null,
    last_push_rows: row.last_push_rows == null ? null : Number(row.last_push_rows),
    last_push_error: row.last_push_error || null
  };
}

async function api_leadSheetExport_get(token) {
  await _requireAdmin(token);
  const s = _view(await _row());
  if (!s.columns.length) s.columns = DEFAULT_COLUMNS.slice();
  const statuses = (await db.getAll('statuses').catch(() => [])) || [];
  let campaigns = [];
  try { campaigns = (await db.getAll('campaigns')) || []; } catch (_) { campaigns = []; }
  let sources = [];
  try {
    const r = await db.query("SELECT DISTINCT source FROM leads WHERE COALESCE(source,'') <> '' ORDER BY source LIMIT 200");
    sources = (r.rows || []).map(x => x.source);
  } catch (_) { sources = []; }
  let connectedEmail = '';
  try { const m = await sheets().getMasterRow(); connectedEmail = (m && (m.email || m.account_email || m.google_email)) || ''; } catch (_) {}
  return {
    settings: s,
    catalog: COLUMNS,
    statuses: statuses.map(x => ({ id: x.id, name: x.name })),
    campaigns: campaigns.map(x => ({ id: x.id, name: x.name })),
    sources: sources,
    connected_email: connectedEmail
  };
}

async function api_leadSheetExport_save(token, payload) {
  await _requireAdmin(token);
  payload = payload || {};
  const cols = _parseArr(payload.columns).filter(k => COLUMN_KEYS.indexOf(k) !== -1);
  const patch = {
    sheet_url: String(payload.sheet_url || '').trim(),
    sheet_tab: String(payload.sheet_tab || 'Leads').trim() || 'Leads',
    enabled: !!payload.enabled,
    realtime_enabled: !!payload.realtime_enabled,
    columns: JSON.stringify(cols.length ? cols : DEFAULT_COLUMNS),
    filter_sources: JSON.stringify(_parseArr(payload.filter_sources).map(String)),
    filter_status_ids: JSON.stringify(_parseArr(payload.filter_status_ids).map(Number).filter(Boolean)),
    filter_campaign_ids: JSON.stringify(_parseArr(payload.filter_campaign_ids).map(Number).filter(Boolean)),
    updated_at: db.nowIso()
  };
  const row = await _row();
  if (row) await db.update('lead_sheet_export_settings', row.id, patch);
  else await db.insert('lead_sheet_export_settings', patch);
  return { ok: true };
}

async function _buildValues(s) {
  const statusMap = {}, userMap = {}, campMap = {};
  try { (await db.getAll('statuses')).forEach(x => { statusMap[x.id] = x.name; }); } catch (_) {}
  try { (await db.getAll('users')).forEach(x => { userMap[x.id] = x.name; }); } catch (_) {}
  try { (await db.getAll('campaigns')).forEach(x => { campMap[x.id] = x.name; }); } catch (_) {}

  const wh = [], vals = [];
  if (s.filter_sources.length) { vals.push(s.filter_sources.map(x => String(x).toLowerCase())); wh.push(`LOWER(COALESCE(source,'')) = ANY($${vals.length}::text[])`); }
  if (s.filter_status_ids.length) { vals.push(s.filter_status_ids); wh.push(`status_id = ANY($${vals.length}::int[])`); }
  if (s.filter_campaign_ids.length) { vals.push(s.filter_campaign_ids); wh.push(`campaign_id = ANY($${vals.length}::int[])`); }
  wh.push('COALESCE(is_hidden,0) = 0');
  wh.push('COALESCE(merged_into,0) = 0');
  const where = 'WHERE ' + wh.join(' AND ');
  const res = await db.query(`SELECT * FROM leads ${where} ORDER BY created_at DESC, id DESC LIMIT 50000`, vals);
  const leads = res.rows || [];

  const cols = (s.columns && s.columns.length) ? s.columns : DEFAULT_COLUMNS;
  const header = cols.map(k => { const c = COLUMNS.find(x => x.key === k); return c ? c.label : k; });
  const fmtDt = v => { if (!v) return ''; try { const d = new Date(v); if (isNaN(d.getTime())) return String(v); return d.toISOString().slice(0, 16).replace('T', ' '); } catch (_) { return String(v); } };
  const cell = (l, k) => {
    switch (k) {
      case 'status':           return statusMap[l.status_id] || '';
      case 'owner':            return userMap[l.assigned_to] || '';
      case 'campaign':         return campMap[l.campaign_id] || '';
      case 'created_at':       return fmtDt(l.created_at);
      case 'next_followup_at': return fmtDt(l.next_followup_at);
      case 'value':            return l.value == null ? '' : String(l.value);
      default:                 return l[k] == null ? '' : String(l[k]);
    }
  };
  const body = leads.map(l => cols.map(k => cell(l, k)));
  return { values2d: [header].concat(body), count: leads.length };
}

async function _doPush(row) {
  const s = _view(row);
  if (!s.sheet_url) throw new Error('No Google Sheet linked yet. Paste your Sheet URL and Save first.');
  const sm = sheets();
  const sheetId = sm.parseSheetId(s.sheet_url);
  if (!sheetId) throw new Error('Sheet URL not recognised. Paste the full https://docs.google.com/spreadsheets/d/<ID>/edit URL.');
  const tab = s.sheet_tab || 'Leads';
  const { values2d, count } = await _buildValues(s);
  try {
    await sm.writeSheet(sheetId, tab, values2d);
  } catch (e) {
    try { await db.update('lead_sheet_export_settings', row.id, { last_push_error: String(e.message || e).slice(0, 500), updated_at: db.nowIso() }); } catch (_) {}
    throw e;
  }
  try { await db.update('lead_sheet_export_settings', row.id, { last_push_at: db.nowIso(), last_push_rows: count, last_push_error: null, updated_at: db.nowIso() }); } catch (_) {}
  return { ok: true, rows: count, sheet_id: sheetId, tab: tab };
}

async function api_leadSheetExport_pushNow(token) {
  await _requireAdmin(token);
  const row = await _row();
  if (!row) throw new Error('Configure and Save the Google Sheet first.');
  return _doPush(row);
}

// ---- real-time hook (debounced per tenant) ------------------------------
const _timers = new Map();
function onLeadChanged() {
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    if (!store) return;
    const key = store.pool || store;
    if (_timers.has(key)) clearTimeout(_timers.get(key));
    const t = setTimeout(() => {
      _timers.delete(key);
      try { db.tenantStorage.run(store, () => { _autoPush().catch(() => {}); }); } catch (_) {}
    }, 5000);
    if (t && t.unref) t.unref();
    _timers.set(key, t);
  } catch (_) {}
}

async function _autoPush() {
  try {
    const row = await _row();
    if (!row) return;
    const s = _view(row);
    if (!s.realtime_enabled || !s.sheet_url) return;
    await _doPush(row);
  } catch (_) {}
}

module.exports = {
  api_leadSheetExport_get,
  api_leadSheetExport_save,
  api_leadSheetExport_pushNow,
  onLeadChanged
};
