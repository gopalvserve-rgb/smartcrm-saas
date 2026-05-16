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
// Pages — reads META_PAGES_LIST (set up by routes/fb.js connect flow)
// ─────────────────────────────────────────────────────────────────
async function _pagesFromConfig() {
  try {
    const raw = await db.getConfig('META_PAGES_LIST', '');
    if (!raw) return [];
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

async function _findPage(pageId) {
  const list = await _pagesFromConfig();
  return list.find(p => String(p.page_id) === String(pageId)) || null;
}

async function api_social_pages_list(token) {
  await authUser(token);
  await _ensureSchema();
  const list = await _pagesFromConfig();
  // Strip access_token from response — never leak to SPA
  return list.map(p => ({
    page_id: p.page_id,
    page_name: p.page_name,
    is_monitored: !!p.is_monitored,
    instagram_business_id: p.instagram_business_id || null,
    has_token: !!p.access_token
  }));
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
     WHERE platform = $1 AND page_id = $2 AND thread_id = $3
     ORDER BY created_at ASC
     LIMIT 500
  `, [String(p.platform), String(p.page_id), String(p.thread_id)]);
  // Mark inbound as read
  try {
    await db.query(`
      UPDATE social_messages SET read_at = NOW()
       WHERE platform = $1 AND page_id = $2 AND thread_id = $3
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
          const dup = await db.query(`SELECT 1 FROM social_messages WHERE message_id = $1 LIMIT 1`, [mid]);
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

module.exports = {
  api_social_pages_list,
  api_social_inbox_threads,
  api_social_inbox_messages,
  api_social_inbox_send,
  _handleInboundMessage,
  _ensureSchema
};
