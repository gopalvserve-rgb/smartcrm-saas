/**
 * routes/social.js — Unified Social Inbox + Publisher + Comments + Ads
 *
 * Platform-agnostic module — available to EVERY tenant (not gated by an
 * industry pack). Tables prefixed `social_*` so they don't collide with
 * other features. Reuses existing META_PAGES_LIST config (from fb.js) for
 * page tokens — no new connect flow needed; just enable monitoring on each
 * connected page.
 *
 * Phase S1 (this commit):
 *   - social_messages       — unified inbox for Messenger + Instagram DMs
 *   - api_social_pages_list — pages available for monitoring
 *   - api_social_inbox_*    — list threads / fetch thread / send message
 *   - _handleInboundMessage — called from /hook/meta when DM events arrive
 *
 * Future phases (planned):
 *   S2 — comments inbox (post + ad comments, reply + hide)
 *   S3 — post publisher (FB + IG, schedule)
 *   S4 — ad reporting (Meta Marketing API daily KPIs)
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const GRAPH = 'https://graph.facebook.com/v19.0';

// ─────────────────────────────────────────────────────────────────
// Schema (idempotent, runs lazily on first API call)
// ─────────────────────────────────────────────────────────────────
async function _ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS social_messages (
      id              SERIAL PRIMARY KEY,
      platform        TEXT NOT NULL,            -- 'messenger' | 'instagram'
      page_id         TEXT NOT NULL,            -- our connected page id (FB Page or IG Business)
      thread_id       TEXT NOT NULL,            -- the user PSID (Messenger) or IGSID (Instagram)
      message_id      TEXT,                     -- platform message id (mid) for dedupe
      direction       TEXT NOT NULL,            -- 'in' | 'out'
      sender_name     TEXT,                     -- best-effort display name
      sender_handle   TEXT,                     -- @ username (IG) or PSID (Messenger)
      text            TEXT,
      attachments     JSONB,                    -- array of { type, url, preview_url }
      raw             JSONB,                    -- raw inbound payload for debugging
      lead_id         INTEGER,                  -- linked CRM lead if we matched / created one
      read_at         TIMESTAMPTZ,              -- when an admin/agent read it
      sent_by         INTEGER,                  -- our user id for outbound
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_msg_thread ON social_messages(platform, page_id, thread_id, created_at DESC)`); } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_msg_mid    ON social_messages(message_id) WHERE message_id IS NOT NULL`); } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_msg_unread ON social_messages(direction, read_at) WHERE direction='in' AND read_at IS NULL`); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────
// Pages — DEDICATED social_pages table (separate from Lead Sync)
// The Facebook Lead Sync integration stores its pages in
// META_PAGES_LIST config. We keep Social completely separate so an
// admin can choose to connect different pages for Social vs. Lead
// Sync, use different permission scopes (Social needs messaging/
// comments/publish/ads_read which Lead Sync doesn't), and revoking
// one never breaks the other.
// ─────────────────────────────────────────────────────────────────

async function _ensureSocialPagesSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS social_pages (
      id                      SERIAL PRIMARY KEY,
      page_id                 TEXT NOT NULL UNIQUE,
      page_name               TEXT,
      access_token            TEXT NOT NULL,
      instagram_business_id   TEXT,
      ig_username             TEXT,
      is_monitored            INTEGER NOT NULL DEFAULT 1,
      scopes                  TEXT,           -- comma list of granted permissions
      connected_by            INTEGER,        -- our user id
      connected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_subscribed_at      TIMESTAMPTZ,
      diagnostic              JSONB
    )
  `);
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_pages_monitored ON social_pages(is_monitored) WHERE is_monitored = 1`); } catch (_) {}
}

async function _pagesFromConfig() {
  // Renamed for clarity, kept the name so the rest of the file doesn't change.
  // Reads ONLY from social_pages — never from META_PAGES_LIST (which belongs
  // to the Lead Sync integration).
  await _ensureSocialPagesSchema();
  try {
    const r = await db.query(`SELECT page_id, page_name, access_token, instagram_business_id, is_monitored, ig_username FROM social_pages WHERE is_monitored = 1 ORDER BY page_name`);
    return r.rows || [];
  } catch (_) { return []; }
}

async function _findPage(pageId) {
  await _ensureSocialPagesSchema();
  const r = await db.query(`SELECT page_id, page_name, access_token, instagram_business_id, ig_username FROM social_pages WHERE page_id = $1::text LIMIT 1`, [String(pageId)]);
  return (r.rows && r.rows[0]) || null;
}

async function api_social_pages_list(token) {
  await authUser(token);
  await _ensureSchema();
  await _ensureSocialPagesSchema();
  const r = await db.query(`
    SELECT page_id, page_name, instagram_business_id, ig_username,
           is_monitored, connected_at, last_subscribed_at,
           (access_token IS NOT NULL) AS has_token
      FROM social_pages
     ORDER BY page_name ASC, page_id ASC
  `);
  return (r.rows || []).map(p => ({
    page_id: p.page_id,
    page_name: p.page_name,
    is_monitored: !!Number(p.is_monitored),
    instagram_business_id: p.instagram_business_id || null,
    ig_username: p.ig_username || null,
    connected_at: p.connected_at,
    last_subscribed_at: p.last_subscribed_at,
    has_token: !!p.has_token
  }));
}

// ─────────────────────────────────────────────────────────────────
// Connect / disconnect — Facebook embedded login (separate from
// the Lead Sync flow in routes/fb.js).
// ─────────────────────────────────────────────────────────────────

// Permissions the Social Hub asks for (UNION of all 4 phases needs)
const SOCIAL_FB_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_messaging',
  'pages_manage_posts',
  'pages_manage_engagement',
  'pages_read_user_content',
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'instagram_content_publish',
  'ads_read',
  'business_management'
].join(',');

async function api_social_fb_oauth_url(token, baseUrl) {
  const me = await authUser(token);
  // Same shape as routes/fb.js → api_fb_oauth_url so /fb/auth/callback can
  // peek at the state JWT, find the slug, and dispatch us to the right
  // tenant DB. We add purpose='social' so the callback can route to the
  // SOCIAL handler instead of the Lead Sync handler.
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
  const fbAppId = process.env.PLATFORM_FB_APP_ID || '965594974738358';

  let slug;
  try { slug = (db.tenantStorage && db.tenantStorage.getStore() || {}).slug; } catch (_) {}
  const stateToken = jwt.sign(
    Object.assign({ uid: me.id, t: 'fb_oauth', purpose: 'social' }, slug ? { slug } : {}),
    JWT_SECRET,
    { expiresIn: '10m' }
  );

  const origin = String(baseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  // SAME redirect URI as Lead Sync. Already whitelisted in the Facebook
  // App. The state JWT's purpose='social' field tells the callback to
  // dispatch to our connect handler instead of the Lead Sync one.
  const redirectUri = origin + '/fb/auth/callback';
  const params = new URLSearchParams({
    client_id: fbAppId,
    redirect_uri: redirectUri,
    state: stateToken,
    scope: SOCIAL_FB_SCOPES,
    response_type: 'code',
    auth_type: 'rerequest'
  });
  return {
    auth_url: 'https://www.facebook.com/v19.0/dialog/oauth?' + params.toString(),
    redirect_uri: redirectUri,
    scopes: SOCIAL_FB_SCOPES
  };
}

// Express handler — invoked by server.js /fb/auth/callback when the state
// JWT carries purpose='social'. Exchanges the code for tokens and feeds
// them through the same pipeline as the SDK-popup path (api_social_fb_connect),
// then renders an HTML 'connection complete, close this tab' page.
async function expressOAuthCallbackSocial(req, res) {
  const code = (req.query.code || '').toString();
  const stateRaw = (req.query.state || '').toString();
  const errMsg = (req.query.error_description || req.query.error || '').toString();
  if (errMsg) {
    return res.status(400).send('<h2>Facebook returned an error</h2><pre>' + errMsg + '</pre><p>You can close this tab.</p>');
  }
  if (!code) return res.status(400).send('Missing code from Facebook.');

  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
  let payload;
  try { payload = jwt.verify(stateRaw, JWT_SECRET); }
  catch (_) { return res.status(400).send('Invalid state'); }

  const fbAppId = process.env.PLATFORM_FB_APP_ID || '965594974738358';
  const fbAppSecret = process.env.PLATFORM_FB_APP_SECRET || '3d04f767b437f9083ee45533e97d3c18';

  const origin = req.protocol + '://' + req.get('host');
  const redirectUri = origin + '/fb/auth/callback';

  // 1. Code → short-lived token
  const tokenUrl = `${GRAPH}/oauth/access_token?client_id=${fbAppId}&client_secret=${fbAppSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`;
  const tj = await fetch(tokenUrl).then(r => r.json());
  if (tj.error) return res.status(500).send('<pre>' + tj.error.message + '</pre>');
  const shortToken = tj.access_token;
  if (!shortToken) return res.status(500).send('No token returned');

  // 2. Run the same persist path as the SDK popup. We're already inside
  //    tenantStorage.run() because server.js wraps this callback with
  //    _runAsTenant when the state JWT had a slug.
  try {
    // Fake an authenticated context for api_social_fb_connect by directly
    // calling the underlying logic. Simplest: re-issue a fresh JWT for the
    // operator we recorded in state.uid, call our own dispatcher.
    const me = await db.findById('users', payload.uid);
    if (!me) return res.status(403).send('User not found');
    const jwt2 = require('jsonwebtoken');
    const opToken = jwt2.sign({ id: me.id, email: me.email, role: me.role, t: payload.slug }, JWT_SECRET, { expiresIn: '5m' });
    const r = await api_social_fb_connect(opToken, shortToken);
    return res.send(`
      <html><head><title>Connected</title></head><body style="font-family:system-ui;padding:2rem;max-width:540px;margin:0 auto;text-align:center">
        <h2>✅ Facebook connected for Social Hub</h2>
        <p>Pages connected: <b>${r.pages_connected}</b><br>Instagram accounts linked: <b>${r.ig_accounts}</b></p>
        <p class="muted">You can close this tab and go back to the CRM.</p>
        <script>setTimeout(()=>{ try { window.close(); } catch (_) {} }, 2000)</script>
      </body></html>
    `);
  } catch (e) {
    return res.status(500).send('<pre>' + (e.message || String(e)) + '</pre>');
  }
}

// Exchange a short user token (from FB SDK login) → long-lived user token
// → page access tokens → IG business accounts → persist into social_pages.
async function api_social_fb_connect(token, shortToken, opts) {
  const me = await authUser(token);
  await _ensureSocialPagesSchema();
  if (!shortToken) throw new Error('Facebook short-lived user token required');

  const fbAppId = process.env.PLATFORM_FB_APP_ID || '965594974738358';
  const fbAppSecret = process.env.PLATFORM_FB_APP_SECRET || '3d04f767b437f9083ee45533e97d3c18';

  // 1. Long-lived user token
  const exchUrl = `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${fbAppId}&client_secret=${fbAppSecret}&fb_exchange_token=${encodeURIComponent(shortToken)}`;
  const ex = await fetch(exchUrl).then(r => r.json());
  if (ex.error) throw new Error('Token exchange: ' + ex.error.message);
  const userToken = ex.access_token;
  if (!userToken) throw new Error('No long-lived user token returned');

  // 2. List managed Pages with their (non-expiring) Page Access Tokens
  const pagesResp = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username},tasks&limit=200&access_token=${encodeURIComponent(userToken)}`).then(r => r.json());
  if (pagesResp.error) throw new Error('Pages fetch: ' + pagesResp.error.message);
  const pages = pagesResp.data || [];
  if (!pages.length) throw new Error('No Facebook Pages found for this user');

  let saved = 0;
  for (const p of pages) {
    const pageId   = String(p.id);
    const pageTok  = p.access_token;
    if (!pageTok) continue;
    const igBiz    = p.instagram_business_account ? String(p.instagram_business_account.id) : null;
    const igUser   = p.instagram_business_account && p.instagram_business_account.username || null;

    // 3. Subscribe this page to all social webhook fields
    try {
      const subUrl = `${GRAPH}/${pageId}/subscribed_apps`;
      await fetch(subUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscribed_fields: 'messages,messaging_postbacks,feed,mention',
          access_token: pageTok
        })
      });
    } catch (_) {}

    // 4. Persist into our dedicated table
    await db.query(`
      INSERT INTO social_pages
        (page_id, page_name, access_token, instagram_business_id, ig_username,
         is_monitored, scopes, connected_by, last_subscribed_at)
      VALUES ($1,$2,$3,$4,$5,1,$6,$7,NOW())
      ON CONFLICT (page_id) DO UPDATE SET
        page_name = EXCLUDED.page_name,
        access_token = EXCLUDED.access_token,
        instagram_business_id = EXCLUDED.instagram_business_id,
        ig_username = EXCLUDED.ig_username,
        scopes = EXCLUDED.scopes,
        connected_by = EXCLUDED.connected_by,
        last_subscribed_at = NOW()
    `, [pageId, p.name || '', pageTok, igBiz, igUser, SOCIAL_FB_SCOPES, me.id]);
    saved++;
  }

  return { ok: true, pages_connected: saved, ig_accounts: pages.filter(p => p.instagram_business_account).length };
}

async function api_social_fb_disconnect(token, pageId) {
  await authUser(token);
  await _ensureSocialPagesSchema();
  if (pageId) {
    await db.query(`DELETE FROM social_pages WHERE page_id = $1::text`, [String(pageId)]);
  } else {
    // Disconnect ALL social pages (admin "remove integration")
    await db.query(`DELETE FROM social_pages`);
  }
  return { ok: true };
}

async function api_social_fb_toggleMonitor(token, payload) {
  await authUser(token);
  await _ensureSocialPagesSchema();
  const p = payload || {};
  if (!p.page_id) throw new Error('page_id required');
  await db.query(`UPDATE social_pages SET is_monitored = $1 WHERE page_id = $2::text`,
    [p.monitor === false ? 0 : 1, String(p.page_id)]);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Inbox API — used by SPA chat UI
// ─────────────────────────────────────────────────────────────────
async function api_social_inbox_threads(token, filters) {
  await authUser(token);
  await _ensureSchema();
  const f = filters || {};
  const params = [];
  let where = '1=1';
  if (f.platform) { params.push(String(f.platform)); where += ` AND platform = $${params.length}`; }
  if (f.page_id)  { params.push(String(f.page_id));  where += ` AND page_id = $${params.length}`; }
  if (f.unread)   { where += ` AND EXISTS (SELECT 1 FROM social_messages m2 WHERE m2.thread_id = s.thread_id AND m2.direction='in' AND m2.read_at IS NULL)`; }
  // One row per (platform, page_id, thread_id), with latest preview + unread count
  const r = await db.query(`
    SELECT
      s.platform, s.page_id, s.thread_id,
      MAX(s.sender_name)   AS sender_name,
      MAX(s.sender_handle) AS sender_handle,
      MAX(s.created_at)    AS last_at,
      (SELECT text FROM social_messages
        WHERE platform=s.platform AND page_id=s.page_id AND thread_id=s.thread_id
        ORDER BY created_at DESC LIMIT 1) AS last_text,
      (SELECT direction FROM social_messages
        WHERE platform=s.platform AND page_id=s.page_id AND thread_id=s.thread_id
        ORDER BY created_at DESC LIMIT 1) AS last_direction,
      (SELECT COUNT(*) FROM social_messages
        WHERE platform=s.platform AND page_id=s.page_id AND thread_id=s.thread_id
          AND direction='in' AND read_at IS NULL) AS unread,
      MAX(s.lead_id)       AS lead_id
    FROM social_messages s
    WHERE ${where}
    GROUP BY s.platform, s.page_id, s.thread_id
    ORDER BY last_at DESC
    LIMIT 200
  `, params);
  return r.rows || [];
}

async function api_social_inbox_messages(token, payload) {
  await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  if (!p.platform || !p.page_id || !p.thread_id) throw new Error('platform + page_id + thread_id required');
  const r = await db.query(`
    SELECT id, direction, sender_name, sender_handle, text, attachments,
           message_id, lead_id, read_at, sent_by, created_at
      FROM social_messages
     WHERE platform = $1::text AND page_id = $2::text AND thread_id = $3::text
     ORDER BY created_at ASC
     LIMIT 500
  `, [String(p.platform), String(p.page_id), String(p.thread_id)]);
  // Mark inbound as read
  try {
    await db.query(`
      UPDATE social_messages SET read_at = NOW()
       WHERE platform = $1::text AND page_id = $2::text AND thread_id = $3::text
         AND direction = 'in' AND read_at IS NULL
    `, [String(p.platform), String(p.page_id), String(p.thread_id)]);
  } catch (_) {}
  return r.rows || [];
}

async function api_social_inbox_send(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  if (!p.platform || !p.page_id || !p.thread_id) throw new Error('platform + page_id + thread_id required');
  const text = String(p.text || '').trim();
  if (!text) throw new Error('text required');

  const page = await _findPage(p.page_id);
  if (!page) throw new Error('Page not connected. Open Settings → WhatsApp/Facebook to connect.');
  if (!page.access_token) throw new Error('Page has no access token. Reconnect this page.');

  const platform = String(p.platform).toLowerCase();
  let mid = null;

  if (platform === 'messenger') {
    // POST /{page-id}/messages — Send API
    const url = `${GRAPH}/${page.page_id}/messages?access_token=${encodeURIComponent(page.access_token)}`;
    const body = {
      recipient: { id: String(p.thread_id) },
      messaging_type: 'RESPONSE',
      message: { text }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.error) throw new Error('Messenger: ' + j.error.message);
    mid = j.message_id || null;
  } else if (platform === 'instagram') {
    // IG send needs the FB Page id (the page that owns the IG business account)
    // Endpoint: POST /{ig-user-id}/messages? OR via page Send API depending on
    // API version. v19 uses /{page-id}/messages with recipient.id = IGSID
    const url = `${GRAPH}/${page.page_id}/messages?access_token=${encodeURIComponent(page.access_token)}`;
    const body = {
      recipient: { id: String(p.thread_id) },
      messaging_type: 'RESPONSE',
      message: { text }
    };
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    if (j.error) throw new Error('Instagram: ' + j.error.message);
    mid = j.message_id || null;
  } else {
    throw new Error('Unsupported platform: ' + platform);
  }

  // Persist outbound row
  const ins = await db.query(
    `INSERT INTO social_messages
       (platform, page_id, thread_id, message_id, direction, text, sent_by)
     VALUES ($1,$2,$3,$4,'out',$5,$6)
     RETURNING id, created_at`,
    [platform, String(p.page_id), String(p.thread_id), mid, text, me.id]
  );
  return { ok: true, id: ins.rows[0].id, message_id: mid, created_at: ins.rows[0].created_at };
}

// ─────────────────────────────────────────────────────────────────
// Inbound webhook handler — called from /hook/meta when DM events
// arrive. Meta sends Messenger/IG events with a `messaging` array OR
// (for IG via webhook subscription) a `changes` array with field='messages'.
// We accept both shapes.
// ─────────────────────────────────────────────────────────────────
async function _handleInboundMessage(body) {
  await _ensureSchema();
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  let saved = 0;
  for (const entry of entries) {
    const pageId = String(entry.id || '');
    if (!pageId) continue;
    const page = await _findPage(pageId);
    if (!page) {
      console.warn('[social] inbound for unmonitored page', pageId, '— ignoring');
      continue;
    }

    // --- Messenger flow: entry.messaging[] ----------------------
    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const ev of messaging) {
      if (!ev.message) continue;       // ignore delivery / read receipts
      if (ev.message.is_echo) continue; // skip our own send echoes
      const psid = String(ev.sender && ev.sender.id || '');
      if (!psid) continue;
      // Determine platform — IG events have entry.messaging too but the
      // sender id is an IGSID and entry has 'instagram' or messaging_product
      const platform = (entry.messaging_product === 'instagram' || ev.message?.is_unsupported === false && false /* heuristic */) ? 'instagram' : 'messenger';
      const mid = String(ev.message.mid || '');
      // Dedupe by message_id
      if (mid) {
        try {
          const dup = await db.query(`SELECT 1 FROM social_messages WHERE message_id = $1::text LIMIT 1`, [mid]);
          if (dup.rows && dup.rows[0]) continue;
        } catch (_) {}
      }
      const text = String(ev.message.text || '');
      const attachments = ev.message.attachments
        ? ev.message.attachments.map(a => ({ type: a.type, url: a.payload && a.payload.url || '' }))
        : null;

      // Try to enrich sender name via Graph API (best-effort, cached on first hit)
      let senderName = '', senderHandle = '';
      try {
        const r = await fetch(`${GRAPH}/${psid}?fields=name,username&access_token=${encodeURIComponent(page.access_token)}`);
        const j = await r.json();
        if (!j.error) {
          senderName = j.name || '';
          senderHandle = j.username || psid;
        }
      } catch (_) {}

      await db.query(
        `INSERT INTO social_messages
           (platform, page_id, thread_id, message_id, direction,
            sender_name, sender_handle, text, attachments, raw)
         VALUES ($1,$2,$3,$4,'in',$5,$6,$7,$8::jsonb,$9::jsonb)`,
        [platform, pageId, psid, mid, senderName || senderHandle || psid,
         senderHandle || psid, text, attachments ? JSON.stringify(attachments) : null,
         JSON.stringify(ev)]
      );
      saved++;
    }

    // --- IG via changes[] shape (field='messages') --------------
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change.field !== 'messages' && change.field !== 'instagram') continue;
      const val = change.value || {};
      const sender = String(val.from && val.from.id || '');
      const mid = String(val.id || '');
      if (!sender || !mid) continue;
      try {
        const dup = await db.query(`SELECT 1 FROM social_messages WHERE message_id = $1 LIMIT 1`, [mid]);
        if (dup.rows && dup.rows[0]) continue;
      } catch (_) {}
      await db.query(
        `INSERT INTO social_messages
           (platform, page_id, thread_id, message_id, direction,
            sender_name, sender_handle, text, raw)
         VALUES ('instagram',$1,$2,$3,'in',$4,$5,$6,$7::jsonb)`,
        [pageId, sender, mid, (val.from && val.from.username) || sender, val.from && val.from.username || '',
         String(val.text || ''), JSON.stringify(val)]
      );
      saved++;
    }
  }
  return { ok: true, saved };
}


// ═════════════════════════════════════════════════════════════════════
// PHASE S2 — Comments inbox (FB posts + FB ads + IG posts)
// ═════════════════════════════════════════════════════════════════════

async function _ensureSchemaS2() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS social_comments (
      id              SERIAL PRIMARY KEY,
      platform        TEXT NOT NULL,            -- 'facebook' | 'instagram'
      page_id         TEXT NOT NULL,            -- our connected page id
      post_id         TEXT NOT NULL,            -- FB post id or IG media id
      comment_id      TEXT NOT NULL,            -- platform comment id (idempotency key)
      parent_id       TEXT,                     -- when this is a reply to another comment
      author_id       TEXT,                     -- commenter's user id (PSID/IGSID/page id)
      author_name     TEXT,
      author_handle   TEXT,                     -- @ username (IG) or fb name
      text            TEXT,
      verb            TEXT,                     -- 'add' | 'edited' | 'remove'
      is_hidden       INTEGER NOT NULL DEFAULT 0,
      is_from_us      INTEGER NOT NULL DEFAULT 0,
      replied_at      TIMESTAMPTZ,              -- when WE replied to this comment
      replied_by      INTEGER,                  -- our user id
      raw             JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_social_comments_cid ON social_comments(comment_id)`); } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_comments_post ON social_comments(platform, page_id, post_id, created_at DESC)`); } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_comments_unreplied ON social_comments(replied_at) WHERE replied_at IS NULL AND is_from_us = 0`); } catch (_) {}
}

// List comments grouped by post, with unreplied counter
async function api_social_comments_posts(token, filters) {
  await authUser(token);
  await _ensureSchemaS2();
  const f = filters || {};
  const params = [];
  let where = '1=1';
  // SOCIAL_COMMENTS_TYPE_FIX_v1: was missing the `$` in front of the
  // parameter index, so the SQL ended up "AND platform = 1" — comparing
  // the TEXT column against the literal integer 1 and erroring out with
  // "operator does not exist: text = integer". Add the $ and cast to TEXT.
  if (f.platform) { params.push(String(f.platform)); where += ` AND platform = $${params.length}::text`; }
  if (f.page_id)  { params.push(String(f.page_id));  where += ` AND page_id  = $${params.length}::text`; }
  if (f.unreplied) {
    where += ` AND EXISTS (SELECT 1 FROM social_comments c2
                            WHERE c2.platform=c.platform AND c2.page_id=c.page_id
                              AND c2.post_id=c.post_id AND c2.is_from_us=0
                              AND c2.replied_at IS NULL AND c2.verb <> 'remove')`;
  }
  const r = await db.query(`
    SELECT
      c.platform, c.page_id, c.post_id,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE c.is_from_us = 0 AND c.replied_at IS NULL AND c.verb <> 'remove') AS unreplied,
      MAX(c.created_at) AS last_at,
      (SELECT text FROM social_comments WHERE post_id = c.post_id ORDER BY created_at DESC LIMIT 1) AS last_text,
      (SELECT author_name FROM social_comments WHERE post_id = c.post_id ORDER BY created_at DESC LIMIT 1) AS last_author
    FROM social_comments c
    WHERE ${where}
    GROUP BY c.platform, c.page_id, c.post_id
    ORDER BY last_at DESC
    LIMIT 200
  `, params);
  return r.rows || [];
}

// Comments on one post (threaded view)
async function api_social_comments_byPost(token, payload) {
  await authUser(token);
  await _ensureSchemaS2();
  const p = payload || {};
  if (!p.post_id) throw new Error('post_id required');
  const r = await db.query(`
    SELECT id, comment_id, parent_id, author_id, author_name, author_handle,
           text, verb, is_hidden, is_from_us, replied_at, replied_by, created_at
      FROM social_comments
     WHERE post_id = $1::text
     ORDER BY created_at ASC
     LIMIT 500
  `, [String(p.post_id)]);
  return r.rows || [];
}

// Reply to a comment — calls /{comment-id}/comments
async function api_social_comments_reply(token, payload) {
  const me = await authUser(token);
  await _ensureSchemaS2();
  const p = payload || {};
  if (!p.page_id || !p.comment_id) throw new Error('page_id + comment_id required');
  const text = String(p.text || '').trim();
  if (!text) throw new Error('text required');

  const page = await _findPage(p.page_id);
  if (!page) throw new Error('Page not connected.');
  if (!page.access_token) throw new Error('Page has no access token.');

  const url = `${GRAPH}/${encodeURIComponent(p.comment_id)}/comments`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, access_token: page.access_token })
  });
  const j = await r.json();
  if (j.error) throw new Error('Reply failed: ' + j.error.message);

  // Mark the parent as replied, and persist our reply row
  try {
    await db.query(`UPDATE social_comments SET replied_at = NOW(), replied_by = $1 WHERE comment_id = $2::text`,
      [me.id, String(p.comment_id)]);
  } catch (_) {}

  // Best-effort: fetch the parent to get the post_id + platform for our row
  let parentRow = null;
  try {
    const pr = await db.query(`SELECT platform, page_id, post_id FROM social_comments WHERE comment_id=$1::text LIMIT 1`, [String(p.comment_id)]);
    parentRow = pr.rows && pr.rows[0];
  } catch (_) {}

  if (j.id && parentRow) {
    try {
      await db.query(`
        INSERT INTO social_comments
          (platform, page_id, post_id, comment_id, parent_id,
           author_name, text, verb, is_from_us, replied_at, replied_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'add',1,NOW(),$8)
        ON CONFLICT (comment_id) DO NOTHING
      `, [parentRow.platform, parentRow.page_id, parentRow.post_id,
          String(j.id), String(p.comment_id), page.page_name || 'Us', text, me.id]);
    } catch (_) {}
  }
  return { ok: true, reply_id: j.id || null };
}

// Hide / unhide
async function api_social_comments_hide(token, payload) {
  await authUser(token);
  await _ensureSchemaS2();
  const p = payload || {};
  if (!p.page_id || !p.comment_id) throw new Error('page_id + comment_id required');
  const page = await _findPage(p.page_id);
  if (!page || !page.access_token) throw new Error('Page not connected.');

  const hide = p.hide === false ? false : true;
  const url = `${GRAPH}/${encodeURIComponent(p.comment_id)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_hidden: hide, access_token: page.access_token })
  });
  const j = await r.json();
  if (j.error) throw new Error('Hide failed: ' + j.error.message);
  try {
    await db.query(`UPDATE social_comments SET is_hidden = $1 WHERE comment_id = $2::text`,
      [hide ? 1 : 0, String(p.comment_id)]);
  } catch (_) {}
  return { ok: true, is_hidden: hide };
}

// Delete (our comments only — Graph allows page to delete any comment on own posts)
async function api_social_comments_delete(token, payload) {
  await authUser(token);
  await _ensureSchemaS2();
  const p = payload || {};
  if (!p.page_id || !p.comment_id) throw new Error('page_id + comment_id required');
  const page = await _findPage(p.page_id);
  if (!page || !page.access_token) throw new Error('Page not connected.');
  const url = `${GRAPH}/${encodeURIComponent(p.comment_id)}?access_token=${encodeURIComponent(page.access_token)}`;
  const r = await fetch(url, { method: 'DELETE' });
  const j = await r.json();
  if (j.error) throw new Error('Delete failed: ' + j.error.message);
  try {
    await db.query(`UPDATE social_comments SET verb='remove' WHERE comment_id = $1::text`, [String(p.comment_id)]);
  } catch (_) {}
  return { ok: true };
}

// Mark replied without sending (e.g. agent replied outside the tool)
async function api_social_comments_markReplied(token, payload) {
  const me = await authUser(token);
  await _ensureSchemaS2();
  const p = payload || {};
  if (!p.comment_id) throw new Error('comment_id required');
  await db.query(`UPDATE social_comments SET replied_at = NOW(), replied_by = $1 WHERE comment_id = $2`,
    [me.id, String(p.comment_id)]);
  return { ok: true };
}

// Webhook handler — processes feed/comment events from /hook/meta
async function _handleInboundComment(body) {
  await _ensureSchemaS2();
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  let saved = 0;
  for (const entry of entries) {
    const pageId = String(entry.id || '');
    if (!pageId) continue;

    for (const change of (entry.changes || [])) {
      // FB Page feed comment: change.field === 'feed' with value.item === 'comment'
      // IG comment: change.field === 'comments'
      const isFbFeedComment = change.field === 'feed' && change.value && change.value.item === 'comment';
      const isIgComment     = change.field === 'comments';
      if (!isFbFeedComment && !isIgComment) continue;

      const v = change.value || {};
      const commentId = String(v.comment_id || v.id || '');
      if (!commentId) continue;
      // Dedupe
      try {
        const dup = await db.query(`SELECT 1 FROM social_comments WHERE comment_id = $1::text LIMIT 1`, [commentId]);
        if (dup.rows && dup.rows[0]) {
          // If verb='edited' update text
          if (v.verb === 'edited') {
            await db.query(`UPDATE social_comments SET text = $1, verb='edited' WHERE comment_id = $2::text`,
              [String(v.message || ''), commentId]);
          } else if (v.verb === 'remove') {
            await db.query(`UPDATE social_comments SET verb='remove' WHERE comment_id = $1::text`, [commentId]);
          }
          continue;
        }
      } catch (_) {}

      const platform = isIgComment ? 'instagram' : 'facebook';
      const postId   = String(v.post_id || v.media_id || v.parent_id || commentId);
      const parentId = v.parent_id && v.parent_id !== postId ? String(v.parent_id) : null;
      const authorId = String((v.from && v.from.id) || v.user_id || '');
      const authorName = (v.from && v.from.name) || '';
      const text = String(v.message || v.text || '');

      try {
        await db.query(`
          INSERT INTO social_comments
            (platform, page_id, post_id, comment_id, parent_id,
             author_id, author_name, author_handle, text, verb, raw)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          ON CONFLICT (comment_id) DO NOTHING
        `, [platform, pageId, postId, commentId, parentId,
            authorId, authorName, authorName, text, v.verb || 'add', JSON.stringify(v)]);
        saved++;
      } catch (e) {
        console.warn('[social_comments] insert failed:', e.message);
      }
    }
  }
  return { ok: true, saved };
}


// ═════════════════════════════════════════════════════════════════════
// PHASE S3 — Post Publisher (FB + IG, schedule + media)
// ═════════════════════════════════════════════════════════════════════

async function _ensureSchemaS3() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id              SERIAL PRIMARY KEY,
      author_id       INTEGER,                  -- our user who composed
      text            TEXT,
      media_url       TEXT,                     -- public URL for the image/video
      media_type      TEXT,                     -- 'image' | 'video' | null
      targets         JSONB NOT NULL,           -- [{ platform, page_id, ig_user_id? }]
      status          TEXT NOT NULL DEFAULT 'draft',  -- draft | scheduled | publishing | published | failed
      scheduled_at    TIMESTAMPTZ,
      published_at    TIMESTAMPTZ,
      results         JSONB,                    -- per-target { platform, page_id, ok, post_id?, error? }
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status, scheduled_at)`); } catch (_) {}
}

async function api_social_posts_list(token, filters) {
  await authUser(token);
  await _ensureSchemaS3();
  const f = filters || {};
  const params = [];
  let where = '1=1';
  // SOCIAL_COMMENTS_TYPE_FIX_v1: same bug — missing `$` in front of params.length.
  if (f.status) { params.push(String(f.status)); where += ` AND status = $${params.length}::text`; }
  const r = await db.query(`
    SELECT id, author_id, text, media_url, media_type, targets, status,
           scheduled_at, published_at, results, error, created_at, updated_at
      FROM social_posts WHERE ${where}
      ORDER BY (published_at IS NULL) DESC, COALESCE(scheduled_at, created_at) DESC
      LIMIT 200
  `, params);
  return r.rows || [];
}

async function api_social_posts_save(token, payload) {
  const me = await authUser(token);
  await _ensureSchemaS3();
  const p = payload || {};
  const targets = Array.isArray(p.targets) ? p.targets : [];
  if (!targets.length) throw new Error('Pick at least one target (FB Page or IG account)');
  const text = String(p.text || '').trim();
  if (!text && !p.media_url) throw new Error('Provide text or attach media');

  const status = p.scheduled_at ? 'scheduled' : 'draft';
  if (p.id) {
    await db.query(`
      UPDATE social_posts SET
        text = $1, media_url = $2, media_type = $3, targets = $4::jsonb,
        status = $5, scheduled_at = $6, updated_at = NOW()
       WHERE id = $7
    `, [text, p.media_url || null, p.media_type || null, JSON.stringify(targets),
        status, p.scheduled_at || null, Number(p.id)]);
    return { ok: true, id: Number(p.id), status };
  }
  const r = await db.query(`
    INSERT INTO social_posts (author_id, text, media_url, media_type, targets, status, scheduled_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id
  `, [me.id, text, p.media_url || null, p.media_type || null, JSON.stringify(targets), status, p.scheduled_at || null]);
  return { ok: true, id: r.rows[0].id, status };
}

async function api_social_posts_delete(token, id) {
  await authUser(token);
  await _ensureSchemaS3();
  await db.query(`DELETE FROM social_posts WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

// Publish to ONE target — Graph API call. Returns { ok, post_id?, error? }
async function _publishOne(target, text, mediaUrl, mediaType) {
  const page = await _findPage(target.page_id);
  if (!page || !page.access_token) return { ok: false, error: 'Page not connected' };

  try {
    if (target.platform === 'facebook') {
      // Page wall: /{page-id}/feed (text) or /{page-id}/photos (image) or /{page-id}/videos (video)
      let url, body;
      if (mediaUrl && mediaType === 'image') {
        url = `${GRAPH}/${page.page_id}/photos`;
        body = { url: mediaUrl, caption: text, access_token: page.access_token };
      } else if (mediaUrl && mediaType === 'video') {
        url = `${GRAPH}/${page.page_id}/videos`;
        body = { file_url: mediaUrl, description: text, access_token: page.access_token };
      } else {
        url = `${GRAPH}/${page.page_id}/feed`;
        body = { message: text, access_token: page.access_token };
      }
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const j = await r.json();
      if (j.error) return { ok: false, error: j.error.message };
      return { ok: true, post_id: j.id || j.post_id || null };
    }

    if (target.platform === 'instagram') {
      // IG needs the IG Business Account id (stored on the page record)
      const igId = page.instagram_business_id || target.ig_user_id;
      if (!igId) return { ok: false, error: 'No Instagram Business Account linked to this page' };
      if (!mediaUrl) return { ok: false, error: 'Instagram requires an image or video' };
      // 1. Create media container
      const containerUrl = `${GRAPH}/${igId}/media`;
      const containerBody = mediaType === 'video'
        ? { media_type: 'VIDEO', video_url: mediaUrl, caption: text, access_token: page.access_token }
        : { image_url: mediaUrl, caption: text, access_token: page.access_token };
      const c = await fetch(containerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(containerBody)
      });
      const cj = await c.json();
      if (cj.error) return { ok: false, error: cj.error.message };
      const containerId = cj.id;
      // 2. Publish (with retry for video processing)
      let publishedId = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const pubUrl = `${GRAPH}/${igId}/media_publish`;
        const pp = await fetch(pubUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ creation_id: containerId, access_token: page.access_token })
        });
        const pj = await pp.json();
        if (pj.id) { publishedId = pj.id; break; }
        if (pj.error && /not ready/i.test(pj.error.message)) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        return { ok: false, error: (pj.error && pj.error.message) || 'IG publish failed' };
      }
      if (!publishedId) return { ok: false, error: 'IG video not ready after retries' };
      return { ok: true, post_id: publishedId };
    }

    return { ok: false, error: 'Unsupported platform: ' + target.platform };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function api_social_posts_publishNow(token, payload) {
  const me = await authUser(token);
  await _ensureSchemaS3();
  const p = payload || {};

  // Save first (or update) so we have a row to track
  const save = await api_social_posts_save(token, Object.assign({}, p, { scheduled_at: null }));
  await db.query(`UPDATE social_posts SET status='publishing', updated_at=NOW() WHERE id=$1`, [save.id]);

  // Refetch the row to get its persisted fields
  const r = await db.query(`SELECT * FROM social_posts WHERE id=$1`, [save.id]);
  const post = r.rows[0];
  if (!post) throw new Error('Post row missing after save');
  const targets = typeof post.targets === 'string' ? JSON.parse(post.targets) : post.targets;

  const results = [];
  let anyOk = false;
  for (const t of targets) {
    const out = await _publishOne(t, post.text, post.media_url, post.media_type);
    results.push(Object.assign({ platform: t.platform, page_id: t.page_id }, out));
    if (out.ok) anyOk = true;
  }
  const status = anyOk ? (results.every(x => x.ok) ? 'published' : 'failed') : 'failed';
  const errLine = anyOk ? null : results.map(x => (x.platform + ':' + (x.error || '?'))).join(' | ');
  await db.query(`
    UPDATE social_posts SET status=$1, published_at=NOW(), results=$2::jsonb, error=$3, updated_at=NOW()
    WHERE id=$4
  `, [status, JSON.stringify(results), errLine, save.id]);
  return { ok: anyOk, id: save.id, status, results };
}

// Worker — fires scheduled posts. Should be called every minute by server.js boot.
async function _runScheduledPosts() {
  try {
    await _ensureSchemaS3();
    const r = await db.query(`
      SELECT id FROM social_posts
       WHERE status = 'scheduled' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT 20
    `);
    for (const row of (r.rows || [])) {
      try {
        await db.query(`UPDATE social_posts SET status='publishing', updated_at=NOW() WHERE id=$1`, [row.id]);
        const post = (await db.query(`SELECT * FROM social_posts WHERE id=$1`, [row.id])).rows[0];
        if (!post) continue;
        const targets = typeof post.targets === 'string' ? JSON.parse(post.targets) : post.targets;
        const results = [];
        let anyOk = false;
        for (const t of targets) {
          const out = await _publishOne(t, post.text, post.media_url, post.media_type);
          results.push(Object.assign({ platform: t.platform, page_id: t.page_id }, out));
          if (out.ok) anyOk = true;
        }
        const status = anyOk ? (results.every(x => x.ok) ? 'published' : 'failed') : 'failed';
        const errLine = anyOk ? null : results.map(x => (x.platform + ':' + (x.error || '?'))).join(' | ');
        await db.query(`
          UPDATE social_posts SET status=$1, published_at=NOW(), results=$2::jsonb, error=$3, updated_at=NOW()
          WHERE id=$4
        `, [status, JSON.stringify(results), errLine, row.id]);
      } catch (e) {
        await db.query(`UPDATE social_posts SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`,
          [String(e.message || e).slice(0, 500), row.id]);
      }
    }
  } catch (e) { console.warn('[social] scheduled posts run failed:', e.message); }
}


// ═════════════════════════════════════════════════════════════════════
// PHASE S4 — Ad Reporting (Meta Marketing API)
// ═════════════════════════════════════════════════════════════════════

async function _ensureSchemaS4() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS social_ad_accounts (
      id              SERIAL PRIMARY KEY,
      ad_account_id   TEXT NOT NULL UNIQUE,     -- 'act_<id>'
      name            TEXT,
      currency        TEXT,
      access_token    TEXT,                     -- user token with ads_read scope
      is_monitored    INTEGER NOT NULL DEFAULT 1,
      last_synced_at  TIMESTAMPTZ,
      added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS social_ad_daily (
      id              SERIAL PRIMARY KEY,
      ad_account_id   TEXT NOT NULL,
      campaign_id     TEXT NOT NULL,
      campaign_name   TEXT,
      date            DATE NOT NULL,
      spend           NUMERIC(14,2),
      impressions     INTEGER,
      reach           INTEGER,
      clicks          INTEGER,
      ctr             NUMERIC(8,4),             -- percent
      cpc             NUMERIC(10,2),
      cpm             NUMERIC(10,2),
      results         INTEGER,                  -- objective-defined results
      cost_per_result NUMERIC(10,2),
      leads           INTEGER,                  -- lead_count from actions
      cost_per_lead   NUMERIC(10,2),
      raw             JSONB,
      pulled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_social_ad_daily_key
                    ON social_ad_daily(ad_account_id, campaign_id, date)`);
  } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_ad_daily_date ON social_ad_daily(date DESC)`); } catch (_) {}

  await db.query(`
    CREATE TABLE IF NOT EXISTS social_ad_alerts (
      id              SERIAL PRIMARY KEY,
      ad_account_id   TEXT NOT NULL,
      campaign_id     TEXT,
      campaign_name   TEXT,
      alert_type      TEXT NOT NULL,            -- cpc_spike | zero_conversions | budget_exhausted | cpa_threshold
      severity        TEXT NOT NULL DEFAULT 'warn',
      message         TEXT NOT NULL,
      acknowledged    INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_social_ad_alerts_unack ON social_ad_alerts(created_at DESC) WHERE acknowledged = 0`); } catch (_) {}

  // META_ADS_v1.2 — additional metric columns for richer Meta insights.
  // Extracted from the `actions` / `cost_per_action_type` / `action_values` /
  // `purchase_roas` arrays the Marketing API returns. Each ALTER is wrapped
  // in try so it's safe to re-run (and tolerant of column-already-exists).
  const _extra = [
    `purchases NUMERIC(14,2)`,
    `cost_per_purchase NUMERIC(10,2)`,
    `purchase_value NUMERIC(14,2)`,
    `purchase_roas NUMERIC(10,4)`,
    `add_to_carts NUMERIC(14,2)`,
    `cost_per_add_to_cart NUMERIC(10,2)`,
    `landing_page_views NUMERIC(14,2)`,
    `cost_per_landing_page_view NUMERIC(10,2)`,
    `frequency NUMERIC(8,2)`,
    `thru_plays NUMERIC(14,2)`,
    `cost_per_thru_play NUMERIC(10,2)`,
    `video_p100_watched NUMERIC(14,2)`,
    `conversations_started NUMERIC(14,2)`,
    `cost_per_conversation NUMERIC(10,2)`,
    `inline_link_clicks NUMERIC(14,2)`,
    `cost_per_inline_link_click NUMERIC(10,2)`
  ];
  for (const def of _extra) {
    const col = def.split(' ')[0];
    try { await db.query(`ALTER TABLE social_ad_daily ADD COLUMN IF NOT EXISTS ${def}`); }
    catch (e) { console.warn('[ads schema] add col', col, 'failed:', e.message); }
  }
}

// Ad Account CRUD
async function api_social_ads_accounts_list(token) {
  await authUser(token);
  await _ensureSchemaS4();
  const r = await db.query(
    `SELECT ad_account_id, name, currency, is_monitored, last_synced_at, added_at
       FROM social_ad_accounts ORDER BY added_at DESC`
  );
  return r.rows || [];
}

async function api_social_ads_accounts_save(token, payload) {
  await authUser(token);
  await _ensureSchemaS4();
  const p = payload || {};
  if (!p.ad_account_id) throw new Error('ad_account_id required (e.g. act_1234567890)');
  const adId = String(p.ad_account_id).trim();
  await db.query(`
    INSERT INTO social_ad_accounts (ad_account_id, name, currency, access_token, is_monitored)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (ad_account_id) DO UPDATE SET
      name = COALESCE(EXCLUDED.name, social_ad_accounts.name),
      currency = COALESCE(EXCLUDED.currency, social_ad_accounts.currency),
      access_token = COALESCE(EXCLUDED.access_token, social_ad_accounts.access_token),
      is_monitored = EXCLUDED.is_monitored
  `, [adId, p.name || null, p.currency || null, p.access_token || null,
      p.is_monitored === false ? 0 : 1]);
  return { ok: true };
}

async function api_social_ads_accounts_delete(token, adAccountId) {
  await authUser(token);
  await _ensureSchemaS4();
  await db.query(`DELETE FROM social_ad_accounts WHERE ad_account_id = $1::text`, [String(adAccountId)]);
  return { ok: true };
}

// Helper: pick an access token to use for a given ad account.
// Prefers the account's own stored token; falls back to ANY page's
// access_token (page tokens with ads_read perm work for owned ad accounts).
async function _adAccountToken(adAccountId) {
  const r = await db.query(`SELECT access_token FROM social_ad_accounts WHERE ad_account_id = $1::text LIMIT 1`, [adAccountId]);
  if (r.rows && r.rows[0] && r.rows[0].access_token) return r.rows[0].access_token;
  const pages = await _pagesFromConfig();
  const withToken = pages.find(p => p.access_token);
  return withToken ? withToken.access_token : null;
}

// Pull insights for one ad account from Marketing API
async function _pullAdAccountInsights(adAccountId, dateFrom, dateTo) {
  await _ensureSchemaS4();
  const token = await _adAccountToken(adAccountId);
  if (!token) throw new Error('No access token for ' + adAccountId);
  const acct = adAccountId.startsWith('act_') ? adAccountId : ('act_' + adAccountId);

  // Get campaign-level insights for the date range
  // META_ADS_v1.2 — request the wider field set so column picker has data.
  const fields = 'campaign_id,campaign_name,date_start,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type,action_values,purchase_roas,inline_link_clicks,objective';
  const params = new URLSearchParams({
    level: 'campaign',
    fields,
    time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
    time_increment: '1',
    limit: '500',
    access_token: token
  });
  const url = `${GRAPH}/${acct}/insights?` + params.toString();
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error('Marketing API: ' + j.error.message);

  // META_ADS_v1.2 — pull purchase / ATC / LPV / video / messaging metrics out
  // of the actions / action_values / cost_per_action_type / purchase_roas
  // arrays Meta returns. Each action_type maps to a dedicated column so
  // SQL aggregation is cheap and the column picker is straightforward.
  const _sumAction = (arr, types) => {
    if (!Array.isArray(arr)) return 0;
    let t = 0;
    for (const a of arr) if (types.indexOf(a.action_type) >= 0) t += Number(a.value) || 0;
    return t;
  };
  const _avgAction = (arr, types) => {
    if (!Array.isArray(arr)) return null;
    let t = 0, c = 0;
    for (const a of arr) if (types.indexOf(a.action_type) >= 0) { t += Number(a.value) || 0; c++; }
    return c > 0 ? t / c : null;
  };
  let saved = 0;
  for (const row of (j.data || [])) {
    // Leads (existing behaviour)
    const leads = _sumAction(row.actions, ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped']);
    const cpl = _avgAction(row.cost_per_action_type, ['lead', 'leadgen.other', 'onsite_conversion.lead_grouped']);

    // Purchase, Add to Cart, Landing Page View (Pixel + offsite_conversion)
    const purchases = _sumAction(row.actions, ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase']);
    const cppurch  = _avgAction(row.cost_per_action_type, ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase']);
    const purchVal = _sumAction(row.action_values, ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase']);
    const atc      = _sumAction(row.actions, ['add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'omni_add_to_cart']);
    const cpatc    = _avgAction(row.cost_per_action_type, ['add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'omni_add_to_cart']);
    const lpv      = _sumAction(row.actions, ['landing_page_view']);
    const cplpv    = _avgAction(row.cost_per_action_type, ['landing_page_view']);

    // Video
    const thruPlays = _sumAction(row.actions, ['video_view', 'video_thruplay_watched_actions']);
    const cpThru    = _avgAction(row.cost_per_action_type, ['video_view', 'video_thruplay_watched_actions']);

    // Messaging conversations
    const convs   = _sumAction(row.actions, ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection']);
    const cpConv  = _avgAction(row.cost_per_action_type, ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection']);

    // Inline link clicks (sometimes Meta sends as a top-level number, sometimes
    // in actions only — prefer the top-level if present)
    const ilc   = row.inline_link_clicks != null ? Number(row.inline_link_clicks) : _sumAction(row.actions, ['link_click']);
    const cpilc = _avgAction(row.cost_per_action_type, ['link_click']);

    // purchase_roas is an array of {action_type, value} — take the first numeric value
    let roas = null;
    if (Array.isArray(row.purchase_roas) && row.purchase_roas.length) {
      const v = Number(row.purchase_roas[0].value);
      if (!isNaN(v)) roas = v;
    }

    const results = leads || (Number(row.clicks) || 0);
    const costPerResult = cpl || (row.cpc != null ? Number(row.cpc) : null);

    try {
      await db.query(`
        INSERT INTO social_ad_daily
          (ad_account_id, campaign_id, campaign_name, date,
           spend, impressions, reach, clicks, ctr, cpc, cpm,
           results, cost_per_result, leads, cost_per_lead,
           purchases, cost_per_purchase, purchase_value, purchase_roas,
           add_to_carts, cost_per_add_to_cart,
           landing_page_views, cost_per_landing_page_view,
           frequency, thru_plays, cost_per_thru_play,
           conversations_started, cost_per_conversation,
           inline_link_clicks, cost_per_inline_link_click,
           raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb)
        ON CONFLICT (ad_account_id, campaign_id, date) DO UPDATE SET
          campaign_name = EXCLUDED.campaign_name,
          spend = EXCLUDED.spend,
          impressions = EXCLUDED.impressions,
          reach = EXCLUDED.reach,
          clicks = EXCLUDED.clicks,
          ctr = EXCLUDED.ctr,
          cpc = EXCLUDED.cpc,
          cpm = EXCLUDED.cpm,
          results = EXCLUDED.results,
          cost_per_result = EXCLUDED.cost_per_result,
          leads = EXCLUDED.leads,
          cost_per_lead = EXCLUDED.cost_per_lead,
          purchases = EXCLUDED.purchases,
          cost_per_purchase = EXCLUDED.cost_per_purchase,
          purchase_value = EXCLUDED.purchase_value,
          purchase_roas = EXCLUDED.purchase_roas,
          add_to_carts = EXCLUDED.add_to_carts,
          cost_per_add_to_cart = EXCLUDED.cost_per_add_to_cart,
          landing_page_views = EXCLUDED.landing_page_views,
          cost_per_landing_page_view = EXCLUDED.cost_per_landing_page_view,
          frequency = EXCLUDED.frequency,
          thru_plays = EXCLUDED.thru_plays,
          cost_per_thru_play = EXCLUDED.cost_per_thru_play,
          conversations_started = EXCLUDED.conversations_started,
          cost_per_conversation = EXCLUDED.cost_per_conversation,
          inline_link_clicks = EXCLUDED.inline_link_clicks,
          cost_per_inline_link_click = EXCLUDED.cost_per_inline_link_click,
          raw = EXCLUDED.raw,
          pulled_at = NOW()
      `, [
        acct, String(row.campaign_id), row.campaign_name || null, row.date_start,
        Number(row.spend) || 0, Number(row.impressions) || 0, Number(row.reach) || 0,
        Number(row.clicks) || 0,
        row.ctr != null ? Number(row.ctr) : null,
        row.cpc != null ? Number(row.cpc) : null,
        row.cpm != null ? Number(row.cpm) : null,
        results, costPerResult, leads, cpl,
        purchases, cppurch, purchVal, roas,
        atc, cpatc,
        lpv, cplpv,
        row.frequency != null ? Number(row.frequency) : null,
        thruPlays, cpThru,
        convs, cpConv,
        ilc, cpilc,
        JSON.stringify(row)
      ]);
      saved++;
    } catch (e) { console.warn('[ads] daily upsert failed:', e.message); }
  }

  await db.query(`UPDATE social_ad_accounts SET last_synced_at = NOW() WHERE ad_account_id = $1::text`, [acct]);
  return { ok: true, account: acct, saved };
}

async function api_social_ads_pullNow(token, payload) {
  await authUser(token);
  await _ensureSchemaS4();
  const p = payload || {};
  // META_ADS_v1.2 — accept explicit from/to in addition to days
  let fromStr, toStr;
  if (p.from && p.to) {
    fromStr = String(p.from).slice(0, 10);
    toStr   = String(p.to).slice(0, 10);
  } else {
    const days = Math.min(Math.max(Number(p.days) || 7, 1), 90);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    fromStr = from.toISOString().slice(0, 10);
    toStr   = to.toISOString().slice(0, 10);
  }
  const days = Math.round((new Date(toStr) - new Date(fromStr)) / 86400000) + 1;

  const accounts = await db.query(
    `SELECT ad_account_id FROM social_ad_accounts WHERE is_monitored = 1`
  );
  const out = [];
  for (const a of (accounts.rows || [])) {
    try {
      const r = await _pullAdAccountInsights(a.ad_account_id, fromStr, toStr);
      out.push(r);
    } catch (e) {
      out.push({ ok: false, account: a.ad_account_id, error: e.message });
    }
  }
  // After pulling, regenerate alerts for the most recent day
  try { await _generateAlerts(toStr); } catch (_) {}
  return { ok: true, days, from: fromStr, to: toStr, results: out };
}

// Generate alert rows for a given date based on the data we just pulled.
// Rules (all configurable later via tenant settings):
//   1. CPC spike — today's CPC > 1.5x of campaign's 7-day average
//   2. Zero conversions — today's results = 0 but spend > 100
//   3. Budget exhausted — spend < 10% of yesterday's spend (proxy)
//   4. CPL above threshold — placeholder (no threshold config yet)
async function _generateAlerts(forDate) {
  try {
    // Clear today's previous alerts so we don't dupe
    await db.query(`DELETE FROM social_ad_alerts WHERE acknowledged = 0 AND created_at >= NOW() - INTERVAL '24 hours'`);
    // 1. CPC spike — compare to 7-day avg
    const cpcRows = await db.query(`
      WITH avg7 AS (
        SELECT ad_account_id, campaign_id, AVG(NULLIF(cpc,0)) AS avg_cpc
          FROM social_ad_daily
         WHERE date >= ($1::date - INTERVAL '7 days') AND date < $1::date
         GROUP BY ad_account_id, campaign_id
      )
      SELECT d.ad_account_id, d.campaign_id, d.campaign_name, d.cpc, a.avg_cpc
        FROM social_ad_daily d
        JOIN avg7 a USING (ad_account_id, campaign_id)
       WHERE d.date = $1::date AND d.cpc > a.avg_cpc * 1.5 AND a.avg_cpc > 0
    `, [forDate]);
    for (const row of (cpcRows.rows || [])) {
      await db.query(`
        INSERT INTO social_ad_alerts (ad_account_id, campaign_id, campaign_name, alert_type, severity, message)
        VALUES ($1,$2,$3,'cpc_spike','warn',$4)
      `, [row.ad_account_id, row.campaign_id, row.campaign_name,
          'CPC spiked to ₹' + Number(row.cpc).toFixed(2) + ' (7-day avg ₹' + Number(row.avg_cpc).toFixed(2) + ')']);
    }
    // 2. Zero conversions with spend
    const zeroRows = await db.query(`
      SELECT ad_account_id, campaign_id, campaign_name, spend
        FROM social_ad_daily
       WHERE date = $1::date AND results = 0 AND spend > 100
    `, [forDate]);
    for (const row of (zeroRows.rows || [])) {
      await db.query(`
        INSERT INTO social_ad_alerts (ad_account_id, campaign_id, campaign_name, alert_type, severity, message)
        VALUES ($1,$2,$3,'zero_conversions','warn',$4)
      `, [row.ad_account_id, row.campaign_id, row.campaign_name,
          'Zero results today despite ₹' + Number(row.spend).toFixed(0) + ' spend']);
    }
  } catch (e) { console.warn('[ads] alert gen failed:', e.message); }
}

// Summary KPIs — totals for a date range + delta vs previous equal range
// META_ADS_v1.2 — now accepts {from, to, account_ids} filters in addition to {days}
async function api_social_ads_summary(token, filters) {
  await authUser(token);
  await _ensureSchemaS4();
  const f = filters || {};
  const ymd = d => d.toISOString().slice(0,10);
  let fromStr, toStr, days;
  if (f.from && f.to) {
    fromStr = String(f.from).slice(0,10);
    toStr   = String(f.to).slice(0,10);
    days    = Math.max(1, Math.round((new Date(toStr) - new Date(fromStr)) / 86400000) + 1);
  } else {
    days = Math.min(Math.max(Number(f.days) || 7, 1), 90);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    fromStr = ymd(from); toStr = ymd(to);
  }
  const prevToD   = new Date(new Date(fromStr).getTime() - 86400000);
  const prevFromD = new Date(prevToD.getTime() - (days - 1) * 86400000);
  const prevFromStr = ymd(prevFromD), prevToStr = ymd(prevToD);

  // Optional account filter
  let acctFilter = '';
  const args = [fromStr, toStr];
  if (Array.isArray(f.account_ids) && f.account_ids.length) {
    const placeholders = f.account_ids.map((_, i) => '$' + (i + 3)).join(',');
    acctFilter = ` AND ad_account_id IN (${placeholders})`;
    args.push(...f.account_ids.map(String));
  }

  const aggCols = `
      COALESCE(SUM(spend),0)              AS spend,
      COALESCE(SUM(impressions),0)        AS impressions,
      COALESCE(SUM(reach),0)              AS reach,
      COALESCE(SUM(clicks),0)             AS clicks,
      COALESCE(SUM(results),0)            AS results,
      COALESCE(SUM(leads),0)              AS leads,
      COALESCE(SUM(purchases),0)          AS purchases,
      COALESCE(SUM(purchase_value),0)     AS purchase_value,
      COALESCE(SUM(add_to_carts),0)       AS add_to_carts,
      COALESCE(SUM(landing_page_views),0) AS landing_page_views,
      COALESCE(SUM(thru_plays),0)         AS thru_plays,
      COALESCE(SUM(conversations_started),0) AS conversations_started,
      COALESCE(SUM(inline_link_clicks),0) AS inline_link_clicks
  `;
  const cur = await db.query(
    `SELECT ${aggCols} FROM social_ad_daily WHERE date BETWEEN $1 AND $2 ${acctFilter}`,
    args
  );
  const prevArgs = [prevFromStr, prevToStr, ...(args.slice(2))];
  const prev = await db.query(
    `SELECT ${aggCols} FROM social_ad_daily WHERE date BETWEEN $1 AND $2 ${acctFilter}`,
    prevArgs
  );

  const c = cur.rows[0] || {};
  const p = prev.rows[0] || {};
  const pct = (a, b) => (Number(b) > 0 ? ((Number(a) - Number(b)) / Number(b)) * 100 : (Number(a) > 0 ? 100 : 0));
  return {
    period: { days, from: fromStr, to: toStr },
    current: {
      spend: Number(c.spend), impressions: Number(c.impressions),
      reach: Number(c.reach),
      clicks: Number(c.clicks), results: Number(c.results), leads: Number(c.leads),
      purchases: Number(c.purchases), purchase_value: Number(c.purchase_value),
      add_to_carts: Number(c.add_to_carts),
      landing_page_views: Number(c.landing_page_views),
      thru_plays: Number(c.thru_plays),
      conversations_started: Number(c.conversations_started),
      inline_link_clicks: Number(c.inline_link_clicks),
      cpc: Number(c.clicks) > 0 ? Number(c.spend) / Number(c.clicks) : 0,
      cpl: Number(c.leads)  > 0 ? Number(c.spend) / Number(c.leads)  : 0,
      cpm: Number(c.impressions) > 0 ? (Number(c.spend) / Number(c.impressions)) * 1000 : 0,
      cost_per_purchase: Number(c.purchases) > 0 ? Number(c.spend) / Number(c.purchases) : 0,
      cost_per_add_to_cart: Number(c.add_to_carts) > 0 ? Number(c.spend) / Number(c.add_to_carts) : 0,
      cost_per_landing_page_view: Number(c.landing_page_views) > 0 ? Number(c.spend) / Number(c.landing_page_views) : 0,
      cost_per_thru_play: Number(c.thru_plays) > 0 ? Number(c.spend) / Number(c.thru_plays) : 0,
      cost_per_conversation: Number(c.conversations_started) > 0 ? Number(c.spend) / Number(c.conversations_started) : 0,
      cost_per_inline_link_click: Number(c.inline_link_clicks) > 0 ? Number(c.spend) / Number(c.inline_link_clicks) : 0,
      purchase_roas: Number(c.spend) > 0 ? Number(c.purchase_value) / Number(c.spend) : 0,
      ctr: Number(c.impressions) > 0 ? (Number(c.clicks) / Number(c.impressions)) * 100 : 0,
      frequency: Number(c.reach) > 0 ? Number(c.impressions) / Number(c.reach) : 0
    },
    previous: {
      spend: Number(p.spend), impressions: Number(p.impressions),
      reach: Number(p.reach),
      clicks: Number(p.clicks), results: Number(p.results), leads: Number(p.leads),
      purchases: Number(p.purchases), purchase_value: Number(p.purchase_value)
    },
    delta_pct: {
      spend: pct(c.spend, p.spend),
      impressions: pct(c.impressions, p.impressions),
      reach: pct(c.reach, p.reach),
      clicks: pct(c.clicks, p.clicks),
      results: pct(c.results, p.results),
      leads: pct(c.leads, p.leads),
      purchases: pct(c.purchases, p.purchases),
      purchase_value: pct(c.purchase_value, p.purchase_value)
    }
  };
}

// Per-campaign breakdown
// META_ADS_v1.2 — accepts {from, to, account_ids}, returns ad_account_name from JOIN
// and the full metric set so the column picker doesn't need extra calls.
async function api_social_ads_campaigns(token, filters) {
  await authUser(token);
  await _ensureSchemaS4();
  const f = filters || {};
  const ymd = d => d.toISOString().slice(0,10);
  let fromStr, toStr;
  if (f.from && f.to) {
    fromStr = String(f.from).slice(0,10);
    toStr   = String(f.to).slice(0,10);
  } else {
    const days = Math.min(Math.max(Number(f.days) || 7, 1), 90);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    fromStr = ymd(from); toStr = ymd(to);
  }

  let acctFilter = '';
  const args = [fromStr, toStr];
  if (Array.isArray(f.account_ids) && f.account_ids.length) {
    const placeholders = f.account_ids.map((_, i) => '$' + (i + 3)).join(',');
    acctFilter = ` AND d.ad_account_id IN (${placeholders})`;
    args.push(...f.account_ids.map(String));
  }

  const r = await db.query(`
    SELECT
      d.ad_account_id,
      COALESCE(a.name, d.ad_account_id) AS ad_account_name,
      a.currency AS ad_account_currency,
      d.campaign_id, d.campaign_name,
      SUM(d.spend) AS spend,
      SUM(d.impressions) AS impressions,
      SUM(d.reach) AS reach,
      SUM(d.clicks) AS clicks,
      SUM(d.results) AS results,
      SUM(d.leads) AS leads,
      SUM(d.purchases) AS purchases,
      SUM(d.purchase_value) AS purchase_value,
      SUM(d.add_to_carts) AS add_to_carts,
      SUM(d.landing_page_views) AS landing_page_views,
      SUM(d.thru_plays) AS thru_plays,
      SUM(d.conversations_started) AS conversations_started,
      SUM(d.inline_link_clicks) AS inline_link_clicks,
      MAX(d.date) AS last_day
    FROM social_ad_daily d
    LEFT JOIN social_ad_accounts a ON a.ad_account_id = d.ad_account_id
    WHERE d.date BETWEEN $1 AND $2 ${acctFilter}
    GROUP BY d.ad_account_id, a.name, a.currency, d.campaign_id, d.campaign_name
    ORDER BY SUM(d.spend) DESC NULLS LAST
    LIMIT 500
  `, args);

  return (r.rows || []).map(row => {
    const spend = Number(row.spend) || 0;
    const impr  = Number(row.impressions) || 0;
    const clicks = Number(row.clicks) || 0;
    const reach = Number(row.reach) || 0;
    const purchases = Number(row.purchases) || 0;
    const purchVal  = Number(row.purchase_value) || 0;
    const atc       = Number(row.add_to_carts) || 0;
    const lpv       = Number(row.landing_page_views) || 0;
    const thru      = Number(row.thru_plays) || 0;
    const convs     = Number(row.conversations_started) || 0;
    const ilc       = Number(row.inline_link_clicks) || 0;
    const leads     = Number(row.leads) || 0;
    return {
      ad_account_id: row.ad_account_id,
      ad_account_name: row.ad_account_name,
      ad_account_currency: row.ad_account_currency || '',
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      spend, impressions: impr, reach, clicks,
      results: Number(row.results) || 0,
      leads,
      purchases, purchase_value: purchVal,
      add_to_carts: atc,
      landing_page_views: lpv,
      thru_plays: thru,
      conversations_started: convs,
      inline_link_clicks: ilc,
      cpc: clicks > 0 ? spend / clicks : 0,
      cpl: leads  > 0 ? spend / leads  : 0,
      cpm: impr   > 0 ? (spend / impr) * 1000 : 0,
      ctr: impr   > 0 ? (clicks / impr) * 100 : 0,
      frequency: reach > 0 ? impr / reach : 0,
      cost_per_purchase: purchases > 0 ? spend / purchases : 0,
      cost_per_add_to_cart: atc > 0 ? spend / atc : 0,
      cost_per_landing_page_view: lpv > 0 ? spend / lpv : 0,
      cost_per_thru_play: thru > 0 ? spend / thru : 0,
      cost_per_conversation: convs > 0 ? spend / convs : 0,
      cost_per_inline_link_click: ilc > 0 ? spend / ilc : 0,
      purchase_roas: spend > 0 ? purchVal / spend : 0,
      last_day: row.last_day
    };
  });
}

// META_ADS_v1.2.1 — campaign drill-down: daily breakdown for one campaign
async function api_social_ads_campaign_detail(token, filters) {
  await authUser(token);
  await _ensureSchemaS4();
  const f = filters || {};
  if (!f.campaign_id) throw new Error('campaign_id required');
  const ymd = d => d.toISOString().slice(0,10);
  let fromStr, toStr;
  if (f.from && f.to) {
    fromStr = String(f.from).slice(0,10);
    toStr   = String(f.to).slice(0,10);
  } else {
    const days = Math.min(Math.max(Number(f.days) || 30, 1), 90);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    fromStr = ymd(from); toStr = ymd(to);
  }
  const r = await db.query(`
    SELECT
      d.date,
      d.ad_account_id,
      COALESCE(a.name, d.ad_account_id) AS ad_account_name,
      a.currency AS ad_account_currency,
      d.campaign_id, d.campaign_name,
      d.spend, d.impressions, d.reach, d.clicks,
      d.results, d.leads,
      d.purchases, d.cost_per_purchase, d.purchase_value, d.purchase_roas,
      d.add_to_carts, d.cost_per_add_to_cart,
      d.landing_page_views, d.cost_per_landing_page_view,
      d.frequency, d.thru_plays, d.cost_per_thru_play,
      d.conversations_started, d.cost_per_conversation,
      d.inline_link_clicks, d.cost_per_inline_link_click
    FROM social_ad_daily d
    LEFT JOIN social_ad_accounts a ON a.ad_account_id = d.ad_account_id
    WHERE d.campaign_id = $1::text AND d.date BETWEEN $2 AND $3
    ORDER BY d.date DESC
  `, [String(f.campaign_id), fromStr, toStr]);

  const rows = (r.rows || []).map(row => ({
    date: row.date,
    spend: Number(row.spend) || 0,
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    clicks: Number(row.clicks) || 0,
    leads: Number(row.leads) || 0,
    purchases: Number(row.purchases) || 0,
    purchase_value: Number(row.purchase_value) || 0,
    purchase_roas: Number(row.purchase_roas) || 0,
    add_to_carts: Number(row.add_to_carts) || 0,
    landing_page_views: Number(row.landing_page_views) || 0,
    thru_plays: Number(row.thru_plays) || 0,
    conversations_started: Number(row.conversations_started) || 0,
    inline_link_clicks: Number(row.inline_link_clicks) || 0,
    ctr: Number(row.impressions) > 0 ? (Number(row.clicks) / Number(row.impressions)) * 100 : 0,
    cpc: Number(row.clicks) > 0 ? Number(row.spend) / Number(row.clicks) : 0,
    cpl: Number(row.leads) > 0 ? Number(row.spend) / Number(row.leads) : 0,
    cpm: Number(row.impressions) > 0 ? (Number(row.spend) / Number(row.impressions)) * 1000 : 0
  }));

  const meta = r.rows[0] || {};
  return {
    campaign_id: meta.campaign_id || String(f.campaign_id),
    campaign_name: meta.campaign_name || '',
    ad_account_id: meta.ad_account_id || '',
    ad_account_name: meta.ad_account_name || '',
    ad_account_currency: meta.ad_account_currency || '',
    period: { from: fromStr, to: toStr, days: rows.length },
    rows,
    totals: {
      spend: rows.reduce((a,r) => a + r.spend, 0),
      impressions: rows.reduce((a,r) => a + r.impressions, 0),
      clicks: rows.reduce((a,r) => a + r.clicks, 0),
      leads: rows.reduce((a,r) => a + r.leads, 0),
      purchases: rows.reduce((a,r) => a + r.purchases, 0),
      purchase_value: rows.reduce((a,r) => a + r.purchase_value, 0)
    }
  };
}

// META_ADS_v1.3 — campaign create via Meta Marketing API.
// Requires the user's token to have ads_management scope (in addition to ads_read).
async function api_social_ads_checkScopes(token) {
  await authUser(token);
  await _ensureSchemaS4();
  // Pick any monitored ad account's token to introspect
  const r = await db.query(`SELECT access_token FROM social_ad_accounts WHERE is_monitored = 1 LIMIT 1`);
  const tok = r.rows[0] && r.rows[0].access_token;
  if (!tok) return { connected: false, scopes: [], has_ads_management: false };
  try {
    const u = `${GRAPH}/debug_token?input_token=${encodeURIComponent(tok)}&access_token=${encodeURIComponent(tok)}`;
    const j = await (await fetch(u)).json();
    const scopes = (j && j.data && Array.isArray(j.data.scopes)) ? j.data.scopes : [];
    return {
      connected: true,
      scopes,
      has_ads_management: scopes.indexOf('ads_management') >= 0,
      has_pages_manage_ads: scopes.indexOf('pages_manage_ads') >= 0
    };
  } catch (e) {
    return { connected: true, scopes: [], has_ads_management: false, error: e.message };
  }
}

async function api_social_ads_createCampaign(token, payload) {
  await authUser(token);
  await _ensureSchemaS4();
  const p = payload || {};
  if (!p.name) throw new Error('Campaign name required');
  if (!p.ad_account_id) throw new Error('Ad account required');
  if (!p.objective) throw new Error('Objective required (e.g. OUTCOME_LEADS)');
  const acct = String(p.ad_account_id).startsWith('act_') ? p.ad_account_id : ('act_' + p.ad_account_id);
  const tokR = await db.query(`SELECT access_token FROM social_ad_accounts WHERE ad_account_id = $1`, [acct]);
  const accessToken = tokR.rows[0] && tokR.rows[0].access_token;
  if (!accessToken) throw new Error('No access token for ' + acct + ' — reconnect Facebook');

  const body = new URLSearchParams({
    name: String(p.name).trim(),
    objective: String(p.objective).trim().toUpperCase(),
    status: (String(p.status || 'PAUSED').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED'),
    special_ad_categories: JSON.stringify(Array.isArray(p.special_ad_categories) ? p.special_ad_categories : []),
    access_token: accessToken
  });
  if (p.daily_budget) {
    // Meta wants minor units (paise for INR). User enters rupees, we multiply by 100.
    body.set('daily_budget', String(Math.round(Number(p.daily_budget) * 100)));
  }
  if (p.lifetime_budget) {
    body.set('lifetime_budget', String(Math.round(Number(p.lifetime_budget) * 100)));
  }
  const url = `${GRAPH}/${acct}/campaigns`;
  const r = await fetch(url, { method: 'POST', body });
  const j = await r.json();
  if (j.error) {
    const e = j.error;
    if (/permission|scope|ads_management/i.test(e.message || '')) {
      throw new Error('NEEDS_RECONNECT: Your Facebook connection is missing the ads_management permission. Reconnect Facebook to enable campaign creation.');
    }
    throw new Error('Marketing API: ' + (e.message || JSON.stringify(e)));
  }
  return {
    ok: true,
    campaign_id: j.id,
    ad_account_id: acct,
    name: p.name,
    objective: p.objective,
    status: p.status || 'PAUSED',
    edit_url: `https://business.facebook.com/adsmanager/manage/campaigns/edit?act=${acct.replace(/^act_/,'')}&selected_campaign_ids=${j.id}`,
    ads_url:  `https://business.facebook.com/adsmanager/manage/ads?act=${acct.replace(/^act_/,'')}&selected_campaign_ids=${j.id}`
  };
}

async function api_social_ads_objectives(token) {
  await authUser(token);
  return [
    { value: 'OUTCOME_LEADS',         label: 'Leads' },
    { value: 'OUTCOME_SALES',         label: 'Sales (purchases)' },
    { value: 'OUTCOME_TRAFFIC',       label: 'Traffic (website / clicks)' },
    { value: 'OUTCOME_AWARENESS',     label: 'Awareness (reach / impressions)' },
    { value: 'OUTCOME_ENGAGEMENT',    label: 'Engagement (post / page / messaging)' },
    { value: 'OUTCOME_APP_PROMOTION', label: 'App promotion' }
  ];
}

async function api_social_ads_alerts(token) {
  await authUser(token);
  await _ensureSchemaS4();
  const r = await db.query(`
    SELECT id, ad_account_id, campaign_id, campaign_name, alert_type, severity, message, acknowledged, created_at
      FROM social_ad_alerts
     ORDER BY (acknowledged = 1), created_at DESC
     LIMIT 100
  `);
  return r.rows || [];
}

async function api_social_ads_alerts_ack(token, alertId) {
  await authUser(token);
  await _ensureSchemaS4();
  await db.query(`UPDATE social_ad_alerts SET acknowledged = 1 WHERE id = $1`, [Number(alertId)]);
  return { ok: true };
}

// Background snapshot worker — pulls every hour for the last 2 days
async function _runAdDailySnapshot() {
  try {
    await _ensureSchemaS4();
    const accts = await db.query(`SELECT ad_account_id FROM social_ad_accounts WHERE is_monitored = 1`);
    if (!accts.rows || !accts.rows.length) return;
    const to = new Date();
    const from = new Date(to.getTime() - 86400000); // yesterday
    const ymd = d => d.toISOString().slice(0,10);
    for (const a of accts.rows) {
      try { await _pullAdAccountInsights(a.ad_account_id, ymd(from), ymd(to)); }
      catch (e) { console.warn('[ads] snapshot failed for', a.ad_account_id, e.message); }
    }
    await _generateAlerts(ymd(to));
  } catch (e) { console.warn('[ads] snapshot worker error:', e.message); }
}



// ═════════════════════════════════════════════════════════════════════
// DIAGNOSTICS — for troubleshooting "messages not arriving"
// ═════════════════════════════════════════════════════════════════════
async function api_social_diag(token) {
  await authUser(token);
  await _ensureSchema();
  await _ensureSocialPagesSchema();
  const out = { pages: [], webhook_recent: [], webhook_messages_24h: 0, hint: '' };

  // 1. List each connected page and ask Graph what fields it's subscribed to
  const pagesR = await db.query(`SELECT page_id, page_name, access_token, instagram_business_id, is_monitored FROM social_pages`);
  for (const p of (pagesR.rows || [])) {
    const item = {
      page_id: p.page_id,
      page_name: p.page_name,
      is_monitored: !!Number(p.is_monitored),
      instagram_business_id: p.instagram_business_id || null,
      subscribed_fields: null,
      subscribed_apps_raw: null,
      token_health: null,
      error: null
    };
    try {
      // Page subscription check
      const sUrl = `${GRAPH}/${p.page_id}/subscribed_apps?access_token=${encodeURIComponent(p.access_token)}`;
      const sJ = await fetch(sUrl).then(r => r.json());
      if (sJ.error) {
        item.error = sJ.error.message;
        item.token_health = 'invalid';
      } else {
        item.subscribed_apps_raw = sJ.data || [];
        // The fields are usually inside data[0].subscribed_fields
        const first = (sJ.data || [])[0] || {};
        item.subscribed_fields = first.subscribed_fields || null;
        item.token_health = 'ok';
      }
    } catch (e) {
      item.error = String(e.message || e);
    }
    out.pages.push(item);
  }

  // 2. Recent webhook_log rows for source='meta'
  try {
    const r = await db.query(`SELECT id, payload, processed, error, created_at
                                 FROM webhook_log
                                WHERE source = 'meta'
                                ORDER BY id DESC LIMIT 10`);
    out.webhook_recent = (r.rows || []).map(row => ({
      id: row.id,
      created_at: row.created_at,
      processed: row.processed,
      error: row.error,
      preview: (typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload || {})).slice(0, 400)
    }));
  } catch (_) {}

  // 3. Count how many social_messages we have stored in last 24h
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS c FROM social_messages WHERE created_at > NOW() - INTERVAL '24 hours'`);
    out.webhook_messages_24h = (r.rows && r.rows[0] && r.rows[0].c) || 0;
  } catch (_) {}

  // 4. Friendly hint
  if (!out.pages.length) {
    out.hint = 'No pages connected via the Social Hub flow. Click Connect/Manage and connect at least one Facebook Page.';
  } else if (out.pages.every(p => !p.subscribed_fields || !p.subscribed_fields.includes('messages'))) {
    out.hint = 'Pages are connected but NONE are subscribed to the "messages" webhook field. Hit Re-subscribe below to fix.';
  } else if (out.webhook_recent.length === 0) {
    out.hint = 'Page subscriptions look fine, but no /hook/meta events have arrived yet. This usually means (a) the Facebook App is still in Development mode and the sender is not an App-role user, or (b) the App-level webhook subscription in Meta App Dashboard does not include "messages" + "messaging_postbacks" subscribed fields.';
  } else if (out.webhook_messages_24h === 0) {
    out.hint = 'Events ARE arriving at /hook/meta but nothing is being stored in social_messages. Check webhook_recent for the raw payload — might be leadgen events only.';
  } else {
    out.hint = 'Looks healthy. ' + out.webhook_messages_24h + ' messages stored in the last 24h.';
  }
  return out;
}

async function api_social_resubscribePages(token) {
  await authUser(token);
  await _ensureSocialPagesSchema();
  const r = await db.query(`SELECT page_id, page_name, access_token FROM social_pages`);
  const results = [];
  for (const p of (r.rows || [])) {
    try {
      const url = `${GRAPH}/${p.page_id}/subscribed_apps`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscribed_fields: 'messages,messaging_postbacks,feed,mention',
          access_token: p.access_token
        })
      });
      const j = await resp.json();
      if (j.error) results.push({ page_id: p.page_id, page_name: p.page_name, ok: false, error: j.error.message });
      else {
        results.push({ page_id: p.page_id, page_name: p.page_name, ok: true });
        await db.query(`UPDATE social_pages SET last_subscribed_at = NOW() WHERE page_id = $1::text`, [p.page_id]);
      }
    } catch (e) {
      results.push({ page_id: p.page_id, page_name: p.page_name, ok: false, error: String(e.message || e) });
    }
  }
  return { ok: true, results };
}


/* META_DIAG_v1 — surface the exact Meta callback config for self-service fix */
async function api_social_callbackInfo(token) {
  await authUser(token);
  // The public callback URL Meta should call. We trust the env / config first,
  // then fall back to the request-time host if exposed via a global.
  const base = (process.env.SAAS_PUBLIC_BASE_URL || '').replace(/\/$/, '')
             || (await db.getConfig('PUBLIC_BASE_URL', '') || '').replace(/\/$/, '')
             || 'https://crm.smartcrmsolution.com';
  const callback_url = base + '/hook/meta';

  let verify_token = '';
  try { verify_token = await db.getConfig('META_VERIFY_TOKEN', '') || ''; } catch (_) {}

  // Count successful verify handshakes by looking at server logs is tricky;
  // we approximate by checking if webhook_log has ANY meta rows (verify
  // events get logged with action='verify' or are silently 200'd).
  let any_meta_log = false;
  try {
    const r = await db.query(`SELECT 1 FROM webhook_log WHERE source = 'meta' LIMIT 1`);
    any_meta_log = r.rows.length > 0;
  } catch (_) {}

  return {
    callback_url,
    verify_token,
    verify_token_set: !!verify_token,
    any_meta_log,
    instructions: [
      'Open Meta App Dashboard → your app → Webhooks (left rail) → Page',
      'Edit subscription. Set Callback URL exactly as shown above.',
      'Set Verify Token exactly as shown above (copy/paste).',
      'Subscribe to these fields: messages, messaging_postbacks, feed, mention',
      'Save. Meta will hit GET /hook/meta once to verify (must return 200 with the challenge).',
      'If your app is in Development mode, only users with Admin/Developer/Tester role can trigger webhook events. Either promote your tester or submit the app for Review (Standard Access on pages_messaging + pages_show_list + pages_read_engagement).'
    ]
  };
}

/* META_DIAG_v1 — fire a synthetic webhook into our OWN /hook/meta to prove the receiver is alive */
async function api_social_testReceiver(token) {
  await authUser(token);
  await _ensureSchema();

  // Pick the first connected page so the synthetic payload looks real.
  const p = await db.query(`SELECT page_id, page_name FROM social_pages LIMIT 1`);
  const pg = p.rows[0];
  if (!pg) return { ok: false, error: 'No pages connected yet. Connect a Facebook Page first.' };

  const synthetic = {
    object: 'page',
    entry: [{
      id: pg.page_id,
      time: Math.floor(Date.now() / 1000),
      messaging: [{
        sender: { id: 'TEST_USER_1' },
        recipient: { id: pg.page_id },
        timestamp: Date.now(),
        message: { mid: 'm_test_' + Date.now(), text: '[CRM self-test] hello from Diagnose button' }
      }]
    }]
  };

  // Determine the base URL we should hit (loopback works if same process)
  const base = (process.env.SAAS_PUBLIC_BASE_URL || '').replace(/\/$/, '')
             || (await db.getConfig('PUBLIC_BASE_URL', '') || '').replace(/\/$/, '')
             || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  const url = base + '/hook/meta';

  const before = await db.query(`SELECT COUNT(*)::int AS c FROM webhook_log WHERE source = 'meta'`).then(r => Number(r.rows[0].c || 0)).catch(() => 0);

  let postErr = null, postStatus = null;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(synthetic)
    });
    postStatus = r.status;
  } catch (e) { postErr = String(e.message || e); }

  // Give the writer a beat.
  await new Promise(r => setTimeout(r, 600));
  const after = await db.query(`SELECT COUNT(*)::int AS c FROM webhook_log WHERE source = 'meta'`).then(r => Number(r.rows[0].c || 0)).catch(() => 0);

  return {
    ok: postErr === null && (postStatus >= 200 && postStatus < 300),
    callback_url: url,
    http_status: postStatus,
    post_error: postErr,
    webhook_log_grew_by: after - before,
    interpretation: postErr ? 'Could not even POST to your own /hook/meta — outbound network blocked or wrong URL.' :
                     (postStatus < 200 || postStatus >= 300) ? 'Endpoint returned ' + postStatus + ' — receiver is up but rejected the payload. Check server logs.' :
                     (after - before) > 0 ? '✅ Receiver works. Webhook stored. So 100% sure Meta is NOT actually calling this URL — fix the App Dashboard config.' :
                     'Endpoint returned 200 but no row landed in webhook_log. Possible silent drop — check server logs and routes/webhooks.js metaEvent handler.'
  };
}

module.exports = {
  api_social_pages_list,
  // Phase S1 — dedicated FB connect (separate from Lead Sync)
  api_social_fb_oauth_url,
  api_social_fb_connect,
  expressOAuthCallbackSocial,
  api_social_diag, api_social_callbackInfo, api_social_testReceiver,  /* META_DIAG_v1 */
  api_social_resubscribePages,
  api_social_fb_disconnect,
  api_social_fb_toggleMonitor,
  api_social_inbox_threads,
  api_social_inbox_messages,
  api_social_inbox_send,
  _handleInboundMessage,
  // Phase S2 — Comments
  api_social_comments_posts,
  api_social_comments_byPost,
  api_social_comments_reply,
  api_social_comments_hide,
  api_social_comments_delete,
  api_social_comments_markReplied,
  _handleInboundComment,
  // Phase S3 — Post Publisher
  api_social_posts_list,
  api_social_posts_save,
  api_social_posts_delete,
  api_social_posts_publishNow,
  _runScheduledPosts,
  // Phase S4 — Ad Reporting
  api_social_ads_accounts_list,
  api_social_ads_accounts_save,
  api_social_ads_accounts_delete,
  api_social_ads_pullNow,
  api_social_ads_summary,
  api_social_ads_campaign_detail,
  api_social_ads_checkScopes,
  api_social_ads_createCampaign,
  api_social_ads_objectives,
  api_social_ads_campaigns,
  api_social_ads_alerts,
  api_social_ads_alerts_ack,
  _runAdDailySnapshot,
  _ensureSchema,
  _ensureSchemaS2,
  _ensureSchemaS3,
  _ensureSchemaS4
};
