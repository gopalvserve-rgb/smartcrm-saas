/* GCONV_SHEETS_v1 (2026-06-08)
 * Single shared Google account that pushes conversion data to every tenant's
 * Sheet. Token lives in control.google_sheets_master (one row). Super-admin
 * authorizes ONCE as sales@smartcrmsolution.com via /saas/sheets/connect.
 * Every CRM tenant just shares their Sheet with sales@smartcrmsolution.com
 * (Editor permission) and pastes the URL in Settings.
 */

const controlDb = require('../control/db');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email'
];

function _cid()      { return process.env.GOOGLE_OAUTH_CLIENT_ID     || ''; }
function _csecret()  { return process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''; }
function _baseUrl()  { return (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, ''); }
function _redirectUri() { return _baseUrl() + '/saas/sheets/callback'; }

async function _ensureMasterTable() {
  await controlDb.query(`CREATE TABLE IF NOT EXISTS google_sheets_master (
    id              SERIAL PRIMARY KEY,
    user_email      TEXT NOT NULL,
    access_token    TEXT NOT NULL,
    refresh_token   TEXT,
    expires_at      TIMESTAMPTZ,
    scope           TEXT,
    connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function getMasterRow() {
  await _ensureMasterTable();
  const r = await controlDb.query(`SELECT * FROM google_sheets_master ORDER BY id ASC LIMIT 1`);
  return r.rows && r.rows[0] || null;
}

function getAuthUrl(state) {
  if (!_cid()) throw new Error('GOOGLE_OAUTH_CLIENT_ID not set on Railway');
  const params = new URLSearchParams({
    client_id: _cid(),
    redirect_uri: _redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state: state || ''
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function exchangeCodeAndSave(code) {
  if (!_cid() || !_csecret()) throw new Error('Google OAuth not configured');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: _cid(), client_secret: _csecret(),
      redirect_uri: _redirectUri(), grant_type: 'authorization_code'
    }).toString()
  });
  const td = await tokenRes.json();
  if (td.error) throw new Error('Token exchange: ' + (td.error_description || td.error));

  let email = '';
  try {
    const uir = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': 'Bearer ' + td.access_token }
    });
    const u = await uir.json();
    email = u.email || '';
  } catch (_) {}

  await _ensureMasterTable();
  const expiresAt = new Date(Date.now() + (Number(td.expires_in) || 3600) * 1000).toISOString();
  const existing = await getMasterRow();
  if (existing) {
    await controlDb.query(
      `UPDATE google_sheets_master SET user_email=$1, access_token=$2,
         refresh_token=COALESCE($3, refresh_token), expires_at=$4,
         scope=$5, updated_at=NOW() WHERE id=$6`,
      [email, td.access_token, td.refresh_token || null, expiresAt, td.scope || '', existing.id]
    );
  } else {
    await controlDb.query(
      `INSERT INTO google_sheets_master (user_email, access_token, refresh_token, expires_at, scope)
       VALUES ($1, $2, $3, $4, $5)`,
      [email, td.access_token, td.refresh_token || null, expiresAt, td.scope || '']
    );
  }
  return { email };
}

async function getValidAccessToken() {
  const row = await getMasterRow();
  if (!row) throw new Error('Google Sheets master account not connected yet. Super-admin must visit /saas/sheets/connect to authorize sales@smartcrmsolution.com first.');
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp - Date.now() > 120000) return row.access_token;
  if (!row.refresh_token) throw new Error('Sheets master has no refresh_token — reconnect via /saas/sheets/connect');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: _cid(), client_secret: _csecret(),
      refresh_token: row.refresh_token, grant_type: 'refresh_token'
    }).toString()
  });
  const td = await tokenRes.json();
  if (td.error) throw new Error('Refresh failed: ' + (td.error_description || td.error));
  const newExp = new Date(Date.now() + (Number(td.expires_in) || 3600) * 1000).toISOString();
  await controlDb.query(
    `UPDATE google_sheets_master SET access_token=$1, expires_at=$2, updated_at=NOW() WHERE id=$3`,
    [td.access_token, newExp, row.id]
  );
  return td.access_token;
}

function parseSheetId(urlOrId) {
  const s = String(urlOrId || '').trim();
  if (!s) return '';
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;
  return '';
}

async function writeSheet(spreadsheetId, tabName, values2d) {
  const token = await getValidAccessToken();
  const tab = String(tabName || 'Conversions').trim() || 'Conversions';
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tab } } }] })
    });
  } catch (_) {}
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab)}:clear`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: '{}'
  });
  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tab)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: tab, majorDimension: 'ROWS', values: values2d })
    }
  );
  const wj = await writeRes.json();
  if (wj.error) {
    const msg = wj.error.message || JSON.stringify(wj.error);
    if (/does not have permission|permissionDenied|insufficient/i.test(msg)) {
      throw new Error('Permission denied on Sheet. Share the Sheet (Editor access) with sales@smartcrmsolution.com, then retry. (Google: ' + msg + ')');
    }
    if (/Requested entity was not found|notFound/i.test(msg)) {
      throw new Error('Sheet not found. Check the URL/ID — should look like https://docs.google.com/spreadsheets/d/<long_id>/edit (Google: ' + msg + ')');
    }
    throw new Error('Sheets API: ' + msg);
  }
  return { ok: true, updated_range: wj.updatedRange, updated_cells: wj.updatedCells };
}

module.exports = { getMasterRow, getAuthUrl, exchangeCodeAndSave, getValidAccessToken, parseSheetId, writeSheet };
