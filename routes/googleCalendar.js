/* GMEET_v1 — Google Calendar OAuth + token management for smartcrm-saas.
   Per-user (each rep connects their own Google account). Stores tokens in
   per-tenant google_calendar_tokens table (self-heal CREATE IF NOT EXISTS).

   Required env on Railway:
     GOOGLE_OAUTH_CLIENT_ID
     GOOGLE_OAUTH_CLIENT_SECRET
     PUBLIC_BASE_URL  (e.g. https://crm.smartcrmsolution.com)

   Authorized redirect URI to register on Google Cloud Console:
     <PUBLIC_BASE_URL>/saas/google/callback
*/
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email'
];

function _cid()      { return process.env.GOOGLE_OAUTH_CLIENT_ID     || ''; }
function _csecret()  { return process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''; }
function _baseUrl()  { return (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, ''); }
function _redirectUri() { return _baseUrl() + '/saas/google/callback'; }

async function _ensureTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS google_calendar_tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    email TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    token_type TEXT DEFAULT 'Bearer',
    expires_at TIMESTAMPTZ,
    scope TEXT,
    calendar_id TEXT DEFAULT 'primary',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

/* Returns { connected, configured, email, expires_at } for the current user. */
async function api_gcal_status(token) {
  const me = await authUser(token);
  await _ensureTable();
  const row = await db.findOneBy('google_calendar_tokens', 'user_id', me.id);
  return {
    configured: !!(_cid() && _csecret()),
    connected: !!row,
    email: row ? row.email : null,
    expires_at: row ? row.expires_at : null,
    calendar_id: row ? row.calendar_id : 'primary'
  };
}

/* Returns the OAuth URL the user should click to start the consent flow. */
async function api_gcal_authUrl(token) {
  const me = await authUser(token);
  if (!_cid()) throw new Error('Google OAuth not configured on the platform. Ask support to set GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET on Railway.');

  // Capture the active tenant slug so the callback route knows which DB to write to.
  const tenantStorage = db.tenantStorage;
  const store = tenantStorage && tenantStorage.getStore && tenantStorage.getStore();
  const slug = store && store.slug ? String(store.slug) : '';
  if (!slug) throw new Error('Cannot determine tenant slug for OAuth callback routing');

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
  const state = jwt.sign({ uid: me.id, slug, purpose: 'gcal' }, JWT_SECRET, { expiresIn: '15m' });

  const params = new URLSearchParams({
    client_id: _cid(),
    redirect_uri: _redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: state
  });
  return { url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() };
}

/* Disconnect — drop the token row. */
async function api_gcal_disconnect(token) {
  const me = await authUser(token);
  const row = await db.findOneBy('google_calendar_tokens', 'user_id', me.id);
  if (row) await db.query('DELETE FROM google_calendar_tokens WHERE id = $1', [row.id]);
  return { ok: true };
}

/* Express handler for /saas/google/callback. Called inside _runAsTenant so
   db.query lands in the right tenant. Exchanges code for tokens, fetches the
   Google account email, and upserts google_calendar_tokens. */
async function expressOAuthCallback(req, res) {
  const code = String(req.query.code || '');
  const stateRaw = String(req.query.state || '');
  const error = String(req.query.error || '');
  if (error) return res.status(400).type('html').send('<h2>Google denied: ' + error + '</h2>');
  if (!code) return res.status(400).type('html').send('<h2>No code returned</h2>');

  let uid;
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(stateRaw, process.env.JWT_SECRET || 'dev-secret-change-me');
    uid = decoded.uid;
  } catch (e) {
    return res.status(400).type('html').send('<h2>Bad state: ' + e.message + '</h2>');
  }
  if (!uid) return res.status(400).type('html').send('<h2>State has no user id</h2>');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: _cid(), client_secret: _csecret(),
        redirect_uri: _redirectUri(), grant_type: 'authorization_code'
      }).toString()
    });
    const td = await tokenRes.json();
    if (td.error) return res.status(400).type('html').send('<h2>Token exchange failed: ' + (td.error_description || td.error) + '</h2>');

    // Fetch user email so admin sees which Google account they connected.
    let email = '';
    try {
      const uir = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { 'Authorization': 'Bearer ' + td.access_token }
      });
      const u = await uir.json();
      email = u.email || '';
    } catch (_) {}

    await _ensureTable();
    const expiresAt = new Date(Date.now() + (Number(td.expires_in) || 3600) * 1000).toISOString();
    const existing = await db.findOneBy('google_calendar_tokens', 'user_id', uid);
    if (existing) {
      await db.query(`UPDATE google_calendar_tokens SET
        email = $1, access_token = $2,
        refresh_token = COALESCE($3, refresh_token),
        expires_at = $4, scope = $5, updated_at = NOW()
        WHERE id = $6`,
        [email, td.access_token, td.refresh_token || null, expiresAt, td.scope || '', existing.id]);
    } else {
      await db.insert('google_calendar_tokens', {
        user_id: uid, email,
        access_token: td.access_token,
        refresh_token: td.refresh_token || null,
        expires_at: expiresAt, scope: td.scope || ''
      });
    }

    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connected</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:3rem 1.5rem;color:#0f172a;background:#f8fafc}
.box{background:#fff;border-radius:12px;padding:2rem;max-width:420px;margin:0 auto;box-shadow:0 8px 24px rgba(15,23,42,.08)}
.ok{font-size:3rem}.muted{color:#64748b;font-size:.85rem;margin-top:1rem}</style></head>
<body><div class="box"><div class="ok">✅</div>
<h2>Google Calendar connected</h2>
<p>Account: <b>${email || 'unknown'}</b></p>
<p class="muted">You can close this window and return to CRM.<br>Meetings you schedule will now create Google Meet links automatically.</p>
</div><script>setTimeout(()=>{try{window.close()}catch(_){}}, 1800);</script></body></html>`);
  } catch (e) {
    console.error('[gcal-callback]', e);
    res.status(500).type('html').send('<h2>OAuth callback failed: ' + e.message + '</h2>');
  }
}

/* Internal helper used by routes/meetings.js — returns a valid access token,
   auto-refreshing via the refresh_token if expired/near expiry. */
async function _getValidAccessToken(userId) {
  await _ensureTable();
  const row = await db.findOneBy('google_calendar_tokens', 'user_id', userId);
  if (!row) throw new Error('Google Calendar not connected. Open Settings → Integrations → Google Calendar.');

  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 5 * 60 * 1000 && row.access_token) {
    return row.access_token;
  }
  if (!row.refresh_token) {
    throw new Error('Google token expired and no refresh token saved. Please reconnect Google Calendar.');
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      client_id: _cid(), client_secret: _csecret(),
      grant_type: 'refresh_token'
    }).toString()
  });
  const td = await r.json();
  if (td.error) throw new Error('Google refresh failed: ' + (td.error_description || td.error));

  const newExp = new Date(Date.now() + (Number(td.expires_in) || 3600) * 1000).toISOString();
  await db.query(`UPDATE google_calendar_tokens SET access_token = $1, expires_at = $2, updated_at = NOW() WHERE id = $3`,
    [td.access_token, newExp, row.id]);
  return td.access_token;
}

module.exports = {
  api_gcal_status, api_gcal_authUrl, api_gcal_disconnect,
  expressOAuthCallback,
  _getValidAccessToken
};
