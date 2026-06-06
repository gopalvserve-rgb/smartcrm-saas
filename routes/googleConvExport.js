// GOOGLE_CONV_EXPORT_v1 (2026-06-06)
// ===================================================================
// Exports Google-sourced leads to a CSV format matching Google Ads'
// Offline Conversion Import spec. Admin downloads the CSV and uploads
// it (or pastes into a linked Google Sheet) — Google Ads pulls daily
// and feeds conversion signals back to its bidding algorithm.
//
// CSV format (7 columns, exact header order):
//   Google Click ID, Conversion Name, Conversion Time, Lead ID,
//   Campaign ID, Mobile, Without GCLID
//
// Notes:
// - Status → Conversion Name comes from per-tenant settings.status_map.
// - Conversion Time is end-of-day IST by default (matches user's sample).
// - Without GCLID = "Yes" when gclid is missing.
// - Toggle is OFF by default; feature does NOTHING until ON.

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const _schemaReady = new Set();
async function _ensureSchema() {
  const tenant = (db._tenantSlug && db._tenantSlug()) || 'default';
  if (_schemaReady.has(tenant)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS google_conv_export_settings (
      id SERIAL PRIMARY KEY,
      is_enabled BOOLEAN DEFAULT FALSE,
      lookback_days INT DEFAULT 7,
      status_map_json JSONB DEFAULT '{}'::jsonb,
      source_filter TEXT DEFAULT 'google,google ads,gads,google lead ad',
      conversion_time_mode TEXT DEFAULT 'end_of_day_ist',
      last_downloaded_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by INT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS google_conv_export_log (
      id SERIAL PRIMARY KEY,
      downloaded_at TIMESTAMPTZ DEFAULT NOW(),
      row_count INT DEFAULT 0,
      with_gclid INT DEFAULT 0,
      without_gclid INT DEFAULT 0,
      lookback_days INT,
      downloaded_by INT,
      filename TEXT
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_gce_log_downloaded ON google_conv_export_log(downloaded_at DESC);`);
  try {
    const existing = await db.getAll('google_conv_export_settings');
    if (!existing || existing.length === 0) {
      await db.insert('google_conv_export_settings', {
        is_enabled: false,
        lookback_days: 7,
        status_map_json: JSON.stringify({
          'Assigned':   'Assigned',
          'Hot':        'Qualified',
          'Demo Done':  'Demo',
          'Won':        'Sale'
        }),
        source_filter: 'google,google ads,gads,google lead ad',
        conversion_time_mode: 'end_of_day_ist',
        updated_at: db.nowIso()
      });
    }
  } catch (_) {}
  _schemaReady.add(tenant);
}

function _splitCsv(s) {
  return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}
function _csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function _formatIstEndOfDay(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(date);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return `${get('year')}/${get('month')}/${get('day')} 23:59:59 +0530`;
}
function _formatIstActual(isoString) {
  if (!isoString) return _formatIstEndOfDay(new Date());
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return _formatIstEndOfDay(new Date());
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}:${get('second')} +0530`;
}
function _pickFromExtra(extra, ...keys) {
  if (!extra || typeof extra !== 'object') return '';
  for (const k of keys) {
    if (extra[k] != null && String(extra[k]).trim()) return String(extra[k]).trim();
  }
  if (extra.ads_meta && typeof extra.ads_meta === 'object') {
    for (const k of keys) {
      if (extra.ads_meta[k] != null && String(extra.ads_meta[k]).trim()) {
        return String(extra.ads_meta[k]).trim();
      }
    }
  }
  return '';
}

async function _loadSettings() {
  await _ensureSchema();
  const rows = await db.getAll('google_conv_export_settings');
  const row = (rows && rows[0]) || {};
  let statusMap = row.status_map_json;
  if (typeof statusMap === 'string') {
    try { statusMap = JSON.parse(statusMap); } catch (_) { statusMap = {}; }
  }
  statusMap = statusMap || {};
  return {
    id: row.id || null,
    is_enabled: row.is_enabled === true || row.is_enabled === 1 || String(row.is_enabled) === 'true',
    lookback_days: Number(row.lookback_days) || 7,
    status_map: statusMap,
    source_filter: row.source_filter || 'google,google ads,gads,google lead ad',
    conversion_time_mode: row.conversion_time_mode || 'end_of_day_ist',
    last_downloaded_at: row.last_downloaded_at || null,
    updated_at: row.updated_at || null
  };
}

async function api_googleConvExport_get(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const settings = await _loadSettings();
  let statuses = [];
  let sources = [];
  try { statuses = (await db.getAll('statuses')).map(s => s.name).filter(Boolean); } catch (_) {}
  try { sources  = (await db.getAll('sources')).map(s => s.name).filter(Boolean); } catch (_) {}
  return { settings, statuses, sources };
}

async function api_googleConvExport_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const p = payload || {};
  let statusMap = p.status_map;
  if (typeof statusMap === 'string') {
    try { statusMap = JSON.parse(statusMap); } catch (_) { throw new Error('status_map must be valid JSON'); }
  }
  statusMap = statusMap || {};
  const row = {
    is_enabled: !!p.is_enabled,
    lookback_days: Math.max(1, Math.min(180, Number(p.lookback_days) || 7)),
    status_map_json: JSON.stringify(statusMap),
    source_filter: String(p.source_filter || 'google,google ads,gads,google lead ad').trim(),
    conversion_time_mode: ['end_of_day_ist', 'status_change_actual'].includes(p.conversion_time_mode)
      ? p.conversion_time_mode : 'end_of_day_ist',
    updated_at: db.nowIso(),
    updated_by: me.id
  };
  const existing = await db.getAll('google_conv_export_settings');
  if (existing && existing[0]) {
    await db.update('google_conv_export_settings', existing[0].id, row);
    return { ok: true, id: existing[0].id };
  } else {
    const newRow = await db.insert('google_conv_export_settings', row);
    return { ok: true, id: newRow.id };
  }
}

async function api_googleConvExport_logs(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const r = await db.query(
    `SELECT id, downloaded_at, row_count, with_gclid, without_gclid, lookback_days, downloaded_by, filename
     FROM google_conv_export_log
     ORDER BY downloaded_at DESC
     LIMIT 25`
  );
  return r.rows || [];
}

async function _buildRows(settings) {
  const sourceTokens = _splitCsv(settings.source_filter);
  const lookbackMs = (settings.lookback_days || 7) * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(Date.now() - lookbackMs).toISOString();
  const statusMap = settings.status_map || {};
  const mappedStatuses = new Set(
    Object.keys(statusMap)
      .filter(k => String(statusMap[k] || '').trim() !== '')
      .map(k => String(k).toLowerCase())
  );
  const r = await db.query(
    `SELECT l.id, l.phone, l.source, l.status_id, l.gclid, l.extra_json,
            l.created_at, l.updated_at,
            s.name AS status_name
     FROM leads l
     LEFT JOIN statuses s ON s.id = l.status_id
     WHERE l.updated_at >= $1
     ORDER BY l.updated_at DESC
     LIMIT 50000`,
    [sinceIso]
  );

  const rows = [];
  let withGclid = 0;
  let withoutGclid = 0;
  for (const lead of (r.rows || [])) {
    const srcRaw = String(lead.source || '').toLowerCase();
    if (sourceTokens.length && !sourceTokens.some(t => srcRaw === t || srcRaw.includes(t))) continue;
    const statusName = String(lead.status_name || '').trim();
    if (!statusName) continue;
    if (!mappedStatuses.has(statusName.toLowerCase())) continue;
    let conversionName = '';
    for (const [k, v] of Object.entries(statusMap)) {
      if (String(k).toLowerCase() === statusName.toLowerCase()) { conversionName = String(v); break; }
    }
    if (!conversionName) continue;
    let extra = lead.extra_json;
    if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch (_) { extra = {}; } }
    extra = extra || {};
    const gclid = String(lead.gclid || extra.gclid || _pickFromExtra(extra, 'gclid', 'click_id') || '').trim();
    const campaignId = _pickFromExtra(extra, 'gad_campaignid', 'campaign_id', 'campaignid', 'gad_campaign_id');
    const phone = String(lead.phone || '').trim();
    const conversionTime = settings.conversion_time_mode === 'status_change_actual'
      ? _formatIstActual(lead.updated_at)
      : _formatIstEndOfDay(new Date(lead.updated_at));
    if (gclid) withGclid++; else withoutGclid++;
    rows.push({
      gclid,
      conversion_name: conversionName,
      conversion_time: conversionTime,
      lead_id: lead.id,
      campaign_id: campaignId,
      mobile: phone,
      without_gclid: gclid ? 'No' : 'Yes'
    });
  }
  return { rows, withGclid, withoutGclid };
}

function _rowsToCsv(rows) {
  const header = ['Google Click ID', 'Conversion Name', 'Conversion Time', 'Lead ID', 'Campaign ID', 'Mobile', 'Without GCLID'];
  const out = [header.map(_csvEscape).join(',')];
  for (const r of rows) {
    out.push([
      r.gclid,
      r.conversion_name,
      r.conversion_time,
      r.lead_id,
      r.campaign_id,
      r.mobile,
      r.without_gclid
    ].map(_csvEscape).join(','));
  }
  return out.join('\r\n') + '\r\n';
}

async function api_googleConvExport_download(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const settings = await _loadSettings();
  if (!settings.is_enabled) throw new Error('Google Ads Conversion Export is OFF. Enable it in Settings → Integrations first.');
  const { rows, withGclid, withoutGclid } = await _buildRows(settings);
  const csv = _rowsToCsv(rows);
  const stamp = new Date();
  const tenant = (db._tenantSlug && db._tenantSlug()) || 'tenant';
  const yyyymmdd = _formatIstEndOfDay(stamp).split(' ')[0].replace(/\//g, '');
  const filename = `google_conv_${tenant}_${yyyymmdd}.csv`;
  try {
    await db.insert('google_conv_export_log', {
      downloaded_at: db.nowIso(),
      row_count: rows.length,
      with_gclid: withGclid,
      without_gclid: withoutGclid,
      lookback_days: settings.lookback_days,
      downloaded_by: me.id,
      filename
    });
    if (settings.id) {
      await db.update('google_conv_export_settings', settings.id, { last_downloaded_at: db.nowIso() });
    }
  } catch (e) {
    console.warn('[googleConvExport] log write failed:', e.message);
  }
  return {
    filename,
    mime: 'text/csv',
    csv,
    row_count: rows.length,
    with_gclid: withGclid,
    without_gclid: withoutGclid,
    lookback_days: settings.lookback_days,
    note: rows.length === 0 ? 'No matching leads in the lookback window. Check your source filter + status map.' : null
  };
}

module.exports = {
  api_googleConvExport_get,
  api_googleConvExport_save,
  api_googleConvExport_logs,
  api_googleConvExport_download
};
