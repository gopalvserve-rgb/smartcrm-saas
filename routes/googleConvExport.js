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
  // GOOGLE_CONV_EXPORT_v2 — add auto-export columns (idempotent)
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS auto_export_enabled BOOLEAN DEFAULT TRUE;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS auto_hour_ist INT DEFAULT 22;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS last_auto_export_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS public_token TEXT;`);
  /* GCONV_SHEETS_v1 — Google Sheet push fields */
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS sheet_url TEXT;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS sheet_tab TEXT DEFAULT 'Conversions';`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS sheet_push_enabled BOOLEAN DEFAULT FALSE;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS last_sheet_push_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS last_sheet_push_rows INT;`);
  await db.query(`ALTER TABLE google_conv_export_settings ADD COLUMN IF NOT EXISTS last_sheet_push_error TEXT;`);
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
    auto_export_enabled: row.auto_export_enabled !== false,
    auto_hour_ist: Number(row.auto_hour_ist) || 22,
    last_auto_export_at: row.last_auto_export_at || null,
    public_token: row.public_token || null,
    last_downloaded_at: row.last_downloaded_at || null,
    /* GCONV_SHEETS_BUG_FIX_v1 — these were silently dropped, causing pushSheet to always throw 'No Sheet URL configured' */
    sheet_url: row.sheet_url || '',
    sheet_tab: row.sheet_tab || 'Conversions',
    sheet_push_enabled: row.sheet_push_enabled === true || row.sheet_push_enabled === 1 || String(row.sheet_push_enabled) === 'true',
    last_sheet_push_at: row.last_sheet_push_at || null,
    last_sheet_push_rows: row.last_sheet_push_rows || null,
    last_sheet_push_error: row.last_sheet_push_error || null,
    updated_at: row.updated_at || null
  };
}

async function api_googleConvExport_get(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();  /* GCONV_SCHEMA_HEAL_v1 — was missing; new tenants saw 'relation google_conv_export_settings does not exist' on first page open */
  const settings = await _loadSettings();
  let statuses = [];
  let sources = [];
  try { statuses = (await db.getAll('statuses')).map(s => s.name).filter(Boolean); } catch (_) {}
  try { sources  = (await db.getAll('sources')).map(s => s.name).filter(Boolean); } catch (_) {}
  /* GCONV_SHEETS_v1 — surface the master Sheets account so the SPA can show
     "Share your Sheet with X" + a clear "not connected yet" warning. */
  let sheets_master = null;
  try {
    const sm = require('../utils/googleSheetsMaster');
    const row = await sm.getMasterRow();
    sheets_master = row ? { connected: true, email: row.user_email, connected_at: row.connected_at } : { connected: false };
  } catch (e) { sheets_master = { connected: false, error: e.message }; }
  return { settings, statuses, sources, sheets_master };
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
  /* GCONV_SHEETS_PARTIAL_SAVE_v1 — every field is now partial-save aware. If the SPA omits a key,
     we leave it alone in the DB instead of resetting it to a default. This lets the Sheet card
     auto-save just {sheet_url, sheet_tab, sheet_push_enabled} on Push Now without wiping is_enabled
     or status_map. */
  const row = {
    is_enabled: typeof p.is_enabled === 'boolean' ? p.is_enabled : undefined,
    lookback_days: p.lookback_days !== undefined ? Math.max(1, Math.min(180, Number(p.lookback_days) || 7)) : undefined,
    status_map_json: (p.status_map !== undefined || typeof payload?.status_map === 'object') ? JSON.stringify(statusMap) : undefined,
    source_filter: p.source_filter !== undefined ? String(p.source_filter || 'google,google ads,gads,google lead ad').trim() : undefined,
    conversion_time_mode: p.conversion_time_mode !== undefined
      ? (['end_of_day_ist', 'status_change_actual'].includes(p.conversion_time_mode) ? p.conversion_time_mode : 'end_of_day_ist')
      : undefined,
    auto_export_enabled: typeof p.auto_export_enabled === 'boolean' ? p.auto_export_enabled : undefined,
    auto_hour_ist: p.auto_hour_ist !== undefined ? Math.max(0, Math.min(23, Number(p.auto_hour_ist) || 22)) : undefined,
    /* GCONV_SHEETS_v1 — Google Sheet push target */
    sheet_url: p.sheet_url !== undefined ? String(p.sheet_url || '').trim() : undefined,
    sheet_tab: p.sheet_tab !== undefined ? (String(p.sheet_tab || '').trim() || 'Conversions') : undefined,
    sheet_push_enabled: typeof p.sheet_push_enabled === 'boolean' ? p.sheet_push_enabled : undefined,
    updated_at: db.nowIso(),
    updated_by: me.id
  };
  // Drop undefined keys so db.update doesn't NULL them
  Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });
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
  await _ensureSchema();  /* GCONV_SCHEMA_HEAL_v1 */
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

// ===================================================================
// GOOGLE_CONV_EXPORT_v2 (2026-06-06) — daily auto-export at 22:00 IST
// + tenant-scoped public URL so admin can paste it into their Google
// Sheet (IMPORTRANGE / =IMPORTDATA) or hand it to Google Ads bulk
// upload.
// ===================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Persistent storage root. Railway volumes mount under /data when
// configured; falls back to repo root /tmp on free dynos (still works
// for a daily fresh-export-then-serve flow since we regenerate from
// scratch every night anyway — disk loss isn't catastrophic).
function _exportDir() {
  const root = process.env.GOOGLE_CONV_EXPORT_DIR
    || (fs.existsSync('/data') ? '/data/google_conv' : path.join(process.cwd(), 'data', 'google_conv'));
  try { fs.mkdirSync(root, { recursive: true }); } catch (_) {}
  return root;
}

function _genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function _ensureTokenOnSettings(settings) {
  return new Promise(async resolve => {
    if (settings && settings.public_token) return resolve(settings.public_token);
    const t = _genToken();
    try {
      if (settings && settings.id) {
        await db.update('google_conv_export_settings', settings.id, { public_token: t });
      }
    } catch (_) {}
    resolve(t);
  });
}

function _todayInIst() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function _hourMinuteInIst() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const parts = fmt.formatToParts(new Date());
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return { hour: Number(get('hour')), minute: Number(get('minute')) };
}

// Generate the CSV file on disk for a single tenant. Returns the
// metadata (path, row count, etc.). Caller is responsible for already
// being inside that tenant's tenantStorage scope so `db.query` etc.
// hits the right pool.
async function _runDailyExportForCurrentTenant(slug) {
  await _ensureSchema();
  const settings = await _loadSettings();
  if (!settings.is_enabled) return { skipped: 'feature_off' };

  const token = await _ensureTokenOnSettings(settings);
  const { rows, withGclid, withoutGclid } = await _buildRows(settings);
  const csv = _rowsToCsv(rows);

  const today = _todayInIst();
  const dir = path.join(_exportDir(), slug);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const dailyPath = path.join(dir, `${today}.csv`);
  const latestPath = path.join(dir, `latest.csv`);
  try {
    fs.writeFileSync(dailyPath, csv, 'utf8');
    fs.writeFileSync(latestPath, csv, 'utf8');
  } catch (e) {
    console.warn(`[gconv] write failed for ${slug}:`, e.message);
    return { error: 'write_failed: ' + e.message };
  }

  // Log + update last_auto_export_at
  try {
    await db.insert('google_conv_export_log', {
      downloaded_at: db.nowIso(),
      row_count: rows.length,
      with_gclid: withGclid,
      without_gclid: withoutGclid,
      lookback_days: settings.lookback_days,
      downloaded_by: null,
      filename: `auto-${today}.csv`
    });
    if (settings.id) {
      await db.update('google_conv_export_settings', settings.id, {
        last_auto_export_at: db.nowIso()
      });
    }
  } catch (_) {}

  /* GCONV_SHEETS_v1 — also push to Google Sheet if configured. Errors are
     caught + stamped on settings; they don't break the CSV path. */
  try {
    if (settings.sheet_push_enabled && settings.sheet_url) {
      await _pushToSheet(settings, null);
      console.log(`[gconv] daily sheet push OK for ${slug}`);
    }
  } catch (e) {
    console.warn(`[gconv] daily sheet push FAILED for ${slug}:`, e.message);
  }

  return {
    slug, today, dailyPath, latestPath,
    row_count: rows.length, with_gclid: withGclid, without_gclid: withoutGclid,
    token
  };
}

// Called once per minute by the server.js scheduler — only fires the
// real per-tenant pass when current IST hour matches auto_hour_ist and
// last_auto_export_at is not today.
async function _maybeDailyTickForCurrentTenant(slug) {
  try {
    await _ensureSchema();
    const settings = await _loadSettings();
    if (!settings.is_enabled) return;
    const autoEnabled = settings.auto_export_enabled !== false; // default ON when feature is ON
    if (!autoEnabled) return;
    const targetHour = Number(settings.auto_hour_ist) || 22;
    const { hour, minute } = _hourMinuteInIst();
    if (hour !== targetHour) return;
    if (minute > 5) return; // only first 5 min of the hour
    // already exported today?
    const today = _todayInIst();
    const lastIso = settings.last_auto_export_at;
    if (lastIso) {
      const lastDay = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date(lastIso));
      if (lastDay === today) return;
    }
    const result = await _runDailyExportForCurrentTenant(slug);
    console.log(`[gconv] daily auto-export for ${slug}:`, result);
  } catch (e) {
    console.warn(`[gconv] daily tick failed for ${slug}:`, e.message);
  }
}

// Express route handler exposed publicly:
//   GET /exports/google-conv/:slug.csv?token=<public_token>
// Returns the latest.csv for that tenant if the token matches.
// Designed for Google Ads bulk-upload URL pull / Google Sheets
// =IMPORTDATA() / curl / wget.
async function expressPublicDownload(req, res) {
  try {
    const slug = String(req.params.slug || '').replace(/\.csv$/i, '');
    const token = String(req.query.token || req.query.t || '').trim();
    if (!slug || !token) return res.status(400).type('text').send('Bad request');

    // Look up the tenant + its settings WITHOUT going through authUser (this is a
    // tenant-scoped public endpoint guarded by the per-tenant token).
    const tenantPool = require('../utils/tenantPool');
    const tenantDb = require('../db/tenantDb');
    const t = await tenantPool.findActiveTenant(slug);
    if (!t) return res.status(404).type('text').send('Tenant not found');
    const pool = tenantPool.poolFor(t);
    if (!pool) return res.status(503).type('text').send('Tenant unavailable');

    let settings;
    await tenantDb.tenantStorage.run({ pool, tenant: t, slug }, async () => {
      try {
        await _ensureSchema();
        settings = await _loadSettings();
      } catch (e) { /* surfaced below */ }
    });
    if (!settings) return res.status(500).type('text').send('Settings load failed');
    if (!settings.is_enabled) return res.status(403).type('text').send('Feature is OFF for this tenant');
    if (!settings.public_token || settings.public_token !== token) {
      return res.status(401).type('text').send('Invalid token');
    }

    const latest = path.join(_exportDir(), slug, 'latest.csv');
    if (!fs.existsSync(latest)) {
      // No daily export yet — generate one on the fly so the URL is usable
      // immediately after enabling the feature. Subsequent reads hit the
      // file cache.
      await tenantDb.tenantStorage.run({ pool, tenant: t, slug }, () =>
        _runDailyExportForCurrentTenant(slug)
      );
    }
    if (!fs.existsSync(latest)) return res.status(404).type('text').send('No export yet');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="google_conv_${slug}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(latest).pipe(res);
  } catch (e) {
    console.error('[gconv] expressPublicDownload error:', e);
    try { res.status(500).type('text').send('Error: ' + e.message); } catch (_) {}
  }
}

// SPA-facing: return the public URL the admin should paste / share.
async function api_googleConvExport_publicUrl(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const settings = await _loadSettings();
  let publicToken = settings.public_token;
  if (!publicToken) {
    publicToken = _genToken();
    if (settings.id) {
      try { await db.update('google_conv_export_settings', settings.id, { public_token: publicToken }); } catch (_) {}
    }
  }
  const slug = (db._tenantSlug && db._tenantSlug()) || 'tenant';
  const base = process.env.PUBLIC_URL_BASE || 'https://crm.smartcrmsolution.com';
  const url = `${base}/exports/google-conv/${slug}.csv?token=${publicToken}`;
  return {
    url,
    last_auto_export_at: settings.last_auto_export_at,
    auto_export_enabled: settings.auto_export_enabled !== false,
    auto_hour_ist: settings.auto_hour_ist || 22,
    is_enabled: settings.is_enabled
  };
}

// SPA-facing: rotate the public token (invalidates the old URL).
async function api_googleConvExport_rotateToken(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const settings = await _loadSettings();
  const newToken = _genToken();
  if (settings.id) {
    await db.update('google_conv_export_settings', settings.id, { public_token: newToken });
  }
  return { ok: true, token: newToken };
}

/* GCONV_SHEETS_v1 — build the same 7-column rows as the CSV path, then write
   them to the tenant's chosen Google Sheet via the shared master account. */
async function _pushToSheet(settings, userId) {
  const sm = require('../utils/googleSheetsMaster');
  const sheetId = sm.parseSheetId(settings.sheet_url);
  if (!sheetId) throw new Error('Sheet URL is missing or unrecognised. Paste the full https://docs.google.com/spreadsheets/d/<ID>/edit URL.');
  const tab = String(settings.sheet_tab || 'Conversions').trim() || 'Conversions';
  const { rows, withGclid, withoutGclid } = await _buildRows(settings);
  // Header row matches Google Ads' Offline Conversion Import spec
  const header = ['Google Click ID', 'Conversion Name', 'Conversion Time', 'Lead ID', 'Campaign ID', 'Mobile', 'Without GCLID'];
  const values2d = [header].concat(rows.map(r => [
    r.gclid || '', r.conversion_name, r.conversion_time,
    String(r.lead_id || ''), r.campaign_id || '', r.mobile || '', r.without_gclid || ''
  ]));
  let result;
  try {
    result = await sm.writeSheet(sheetId, tab, values2d);
  } catch (e) {
    // Stamp the error on settings so the SPA shows what went wrong
    const existing = await db.getAll('google_conv_export_settings');
    if (existing && existing[0]) {
      try {
        await db.update('google_conv_export_settings', existing[0].id, {
          last_sheet_push_error: String(e.message || e).slice(0, 500),
          updated_at: db.nowIso()
        });
      } catch (_) {}
    }
    throw e;
  }
  // Success — stamp last_sheet_push_at + row count, clear any prior error
  const existing = await db.getAll('google_conv_export_settings');
  if (existing && existing[0]) {
    try {
      await db.update('google_conv_export_settings', existing[0].id, {
        last_sheet_push_at: db.nowIso(),
        last_sheet_push_rows: rows.length,
        last_sheet_push_error: null,
        updated_at: db.nowIso()
      });
    } catch (_) {}
  }
  // Best-effort log row
  try {
    await db.insert('google_conv_export_log', {
      downloaded_at: db.nowIso(),
      row_count: rows.length,
      with_gclid: withGclid,
      without_gclid: withoutGclid,
      lookback_days: settings.lookback_days,
      downloaded_by: userId || null,
      filename: '[Sheet] ' + sheetId + ' / ' + tab
    });
  } catch (_) {}
  return { ok: true, rows: rows.length, with_gclid: withGclid, without_gclid: withoutGclid, sheet_id: sheetId, tab };
}

/* SPA-facing: admin clicks "Push to Sheet now". */
async function api_googleConvExport_pushSheet(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const settings = await _loadSettings();
  if (!settings.is_enabled) throw new Error('Google Ads Conversion Export is OFF. Enable it first.');
  if (!settings.sheet_url) throw new Error('No Sheet URL configured. Paste your Sheet URL in the Google Sheet section first.');
  return _pushToSheet(settings, me.id);
}


module.exports = {
  api_googleConvExport_get,
  api_googleConvExport_save,
  api_googleConvExport_logs,
  api_googleConvExport_download,
  api_googleConvExport_pushSheet,  /* GCONV_SHEETS_v1 */
  api_googleConvExport_publicUrl,
  api_googleConvExport_rotateToken,
  _maybeDailyTickForCurrentTenant,
  _runDailyExportForCurrentTenant,
  expressPublicDownload
};
