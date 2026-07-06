/**
 * routes/waCatalogue.js — WA_CATALOGUE_v1 (2026-07-06)
 *
 * WhatsApp Catalogue: a per-tenant library of reusable images / videos /
 * documents that reps can pick and send into any WhatsApp chat in 2 clicks.
 * Modeled after WhatsApp Business's "Catalog" but living inside SmartCRM so
 * every rep on the team shares one library.
 *
 * Tables (auto-created on first use — no separate migration required):
 *   wa_catalogue_folders  — id, name, position, created_by, created_at
 *   wa_catalogue_items    — id, folder_id, name, sku, price, currency,
 *                           description, caption, tags TEXT[], file_url,
 *                           file_mime, file_size, wa_media_id, wa_media_at,
 *                           send_count, is_active, created_by, created_at,
 *                           updated_at
 *   wa_catalogue_sends    — id, item_id, lead_id, user_id, phone,
 *                           wa_message_id, sent_at
 *
 * File storage lives in wa_catalogue_media (BYTEA) — same per-tenant Postgres
 * pattern as wa_chat_media / wa_template_samples so no external deps.
 *
 * APIs (all `api_wa_catalogue_*`, auto-registered by tenantApi dispatcher):
 *   Folders:
 *     _folders_list, _folders_upsert, _folders_delete
 *   Items:
 *     _list, _get, _upsert, _delete, _import_csv
 *   Send:
 *     _send      — send one or more items to a WA chat
 *
 * File upload endpoint: POST /api/wa-catalogue-upload — see server.js.
 * File serve endpoint : GET  /api/wa-catalogue-file/:token — see server.js.
 *
 * Auth: everything requires an authenticated tenant user.
 * Permissions:
 *   - Any user can list / send.
 *   - Only admin / manager can upsert / delete / import.
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ─────────────────────────────────────────────────────────────────────────────
// Schema — auto-installed on first API call. Idempotent.
// ─────────────────────────────────────────────────────────────────────────────
let _schemaReady = new Set(); // per-tenant slug
async function _ensureSchema() {
  const slug = (db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore() || {}).slug || 'default';
  if (_schemaReady.has(slug)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_catalogue_folders (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_catalogue_items (
      id SERIAL PRIMARY KEY,
      folder_id INTEGER,
      name TEXT NOT NULL,
      sku TEXT,
      price NUMERIC,
      currency TEXT DEFAULT 'INR',
      description TEXT,
      caption TEXT,
      tags TEXT[] DEFAULT '{}',
      file_url TEXT,
      file_mime TEXT,
      file_size BIGINT,
      wa_media_id TEXT,
      wa_media_at TIMESTAMPTZ,
      send_count INTEGER DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_catalogue_sends (
      id SERIAL PRIMARY KEY,
      item_id INTEGER,
      lead_id INTEGER,
      user_id INTEGER,
      phone TEXT,
      wa_message_id TEXT,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_catalogue_media (
      token TEXT PRIMARY KEY,
      mime TEXT,
      filename TEXT,
      size BIGINT,
      bytes BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS wa_cat_items_folder ON wa_catalogue_items(folder_id) WHERE is_active`);
  await db.query(`CREATE INDEX IF NOT EXISTS wa_cat_items_active ON wa_catalogue_items(is_active, id DESC)`);
  _schemaReady.add(slug);
}

async function _requireAdmin(me) {
  if (!me) throw new Error('Not authenticated');
  if (me.role === 'admin' || me.role === 'manager') return true;
  throw new Error('Only admin or manager can manage the WA Catalogue');
}

// ─────────────────────────────────────────────────────────────────────────────
// Folders
// ─────────────────────────────────────────────────────────────────────────────
async function api_wa_catalogue_folders_list(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(
    `SELECT f.id, f.name, f.position, f.created_at,
            (SELECT COUNT(*)::int FROM wa_catalogue_items i WHERE i.folder_id = f.id AND i.is_active) AS item_count
       FROM wa_catalogue_folders f
       ORDER BY f.position ASC, f.name ASC`
  );
  return { items: r.rows };
}

async function api_wa_catalogue_folders_upsert(token, payload) {
  const me = await authUser(token);
  await _requireAdmin(me);
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('folder name required');
  if (p.id) {
    await db.query(`UPDATE wa_catalogue_folders SET name=$1, position=$2 WHERE id=$3`,
      [name, Number(p.position || 0), Number(p.id)]);
    return { ok: true, id: Number(p.id) };
  }
  const r = await db.query(
    `INSERT INTO wa_catalogue_folders (name, position, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [name, Number(p.position || 0), me.id]);
  return { ok: true, id: r.rows[0].id };
}

async function api_wa_catalogue_folders_delete(token, id) {
  const me = await authUser(token);
  await _requireAdmin(me);
  await _ensureSchema();
  const fid = Number(id);
  if (!fid) throw new Error('folder id required');
  // Detach items from this folder rather than cascade-delete them
  await db.query(`UPDATE wa_catalogue_items SET folder_id = NULL WHERE folder_id = $1`, [fid]);
  await db.query(`DELETE FROM wa_catalogue_folders WHERE id = $1`, [fid]);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────
async function api_wa_catalogue_list(token, opts) {
  await authUser(token);
  await _ensureSchema();
  const o = opts || {};
  const w = ['i.is_active'];
  const args = [];
  if (o.folder_id) { args.push(Number(o.folder_id)); w.push(`i.folder_id = $${args.length}`); }
  if (o.type) {
    args.push(String(o.type).toLowerCase());
    if (args[args.length-1] === 'image') w.push(`i.file_mime LIKE 'image/%'`);
    else if (args[args.length-1] === 'video') w.push(`i.file_mime LIKE 'video/%'`);
    else if (args[args.length-1] === 'document') w.push(`(i.file_mime NOT LIKE 'image/%' AND i.file_mime NOT LIKE 'video/%')`);
    else args.pop();
  }
  if (o.search) {
    args.push('%' + String(o.search).toLowerCase() + '%');
    w.push(`(LOWER(i.name) LIKE $${args.length} OR LOWER(COALESCE(i.sku,'')) LIKE $${args.length} OR LOWER(COALESCE(i.description,'')) LIKE $${args.length} OR EXISTS (SELECT 1 FROM unnest(i.tags) t WHERE LOWER(t) LIKE $${args.length}))`);
  }
  let order = 'i.send_count DESC, i.id DESC';
  if (o.sort === 'newest') order = 'i.id DESC';
  else if (o.sort === 'name') order = 'LOWER(i.name) ASC';
  else if (o.sort === 'size') order = 'i.file_size DESC NULLS LAST';
  const sql = `SELECT i.id, i.folder_id, f.name AS folder_name, i.name, i.sku, i.price, i.currency,
                      i.description, i.caption, i.tags, i.file_url, i.file_mime, i.file_size,
                      i.send_count, i.created_at
                 FROM wa_catalogue_items i
                 LEFT JOIN wa_catalogue_folders f ON f.id = i.folder_id
                 WHERE ${w.join(' AND ')}
                 ORDER BY ${order}
                 LIMIT ${Math.min(Number(o.limit || 500), 2000)}`;
  const r = await db.query(sql, args);
  return { items: r.rows };
}

async function api_wa_catalogue_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(
    `SELECT i.*, f.name AS folder_name
       FROM wa_catalogue_items i
       LEFT JOIN wa_catalogue_folders f ON f.id = i.folder_id
       WHERE i.id = $1`, [Number(id)]);
  if (!r.rows.length) throw new Error('Catalogue item not found');
  return { item: r.rows[0] };
}

async function api_wa_catalogue_upsert(token, payload) {
  const me = await authUser(token);
  await _requireAdmin(me);
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('name required');
  const tags = Array.isArray(p.tags) ? p.tags.map(String)
              : String(p.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const price = p.price === '' || p.price == null ? null : Number(p.price);

  if (p.id) {
    // update — new file only if provided
    const parts = [`name=$1`, `sku=$2`, `price=$3`, `currency=$4`, `description=$5`, `caption=$6`,
                   `tags=$7::text[]`, `folder_id=$8`, `updated_at=NOW()`];
    const args = [name, p.sku || null, price, p.currency || 'INR',
                  p.description || null, p.caption || null, tags,
                  p.folder_id ? Number(p.folder_id) : null];
    if (p.file_url) {
      parts.push(`file_url=$${args.length+1}`,
                 `file_mime=$${args.length+2}`,
                 `file_size=$${args.length+3}`,
                 `wa_media_id=NULL`, `wa_media_at=NULL`);
      args.push(p.file_url, p.file_mime || null, Number(p.file_size) || null);
    }
    args.push(Number(p.id));
    await db.query(`UPDATE wa_catalogue_items SET ${parts.join(', ')} WHERE id=$${args.length}`, args);
    return { ok: true, id: Number(p.id) };
  }
  if (!p.file_url) throw new Error('file required — upload first');
  const r = await db.query(
    `INSERT INTO wa_catalogue_items
       (folder_id, name, sku, price, currency, description, caption, tags,
        file_url, file_mime, file_size, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12)
       RETURNING id`,
    [p.folder_id ? Number(p.folder_id) : null, name, p.sku || null, price,
     p.currency || 'INR', p.description || null, p.caption || null, tags,
     p.file_url, p.file_mime || null, Number(p.file_size) || null, me.id]);
  return { ok: true, id: r.rows[0].id };
}

async function api_wa_catalogue_delete(token, id) {
  const me = await authUser(token);
  await _requireAdmin(me);
  await _ensureSchema();
  await db.query(`UPDATE wa_catalogue_items SET is_active=FALSE, updated_at=NOW() WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk CSV import — columns: name, sku, price, description, caption, file_url, tags, folder
// (file_url should be a public HTTPS URL; the row is created without file bytes;
//  we cache media_id on first send.)
// ─────────────────────────────────────────────────────────────────────────────
async function api_wa_catalogue_import_csv(token, payload) {
  const me = await authUser(token);
  await _requireAdmin(me);
  await _ensureSchema();
  const rows = (payload && Array.isArray(payload.rows)) ? payload.rows : [];
  if (!rows.length) throw new Error('rows[] required');
  // Ensure folders exist
  const folderCache = {};
  async function _folderId(name) {
    if (!name) return null;
    if (folderCache[name] !== undefined) return folderCache[name];
    const fx = await db.query(`SELECT id FROM wa_catalogue_folders WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]);
    if (fx.rows.length) { folderCache[name] = fx.rows[0].id; return folderCache[name]; }
    const ins = await db.query(`INSERT INTO wa_catalogue_folders (name, created_by) VALUES ($1, $2) RETURNING id`, [name, me.id]);
    folderCache[name] = ins.rows[0].id;
    return folderCache[name];
  }
  let inserted = 0, skipped = 0;
  for (const r of rows) {
    if (!r || !r.name || !r.file_url) { skipped++; continue; }
    const folderId = await _folderId(r.folder || null);
    const tags = Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    await db.query(
      `INSERT INTO wa_catalogue_items
         (folder_id, name, sku, price, currency, description, caption, tags,
          file_url, file_mime, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11)`,
      [folderId, String(r.name), r.sku || null, r.price == null || r.price === '' ? null : Number(r.price),
       r.currency || 'INR', r.description || null, r.caption || null, tags,
       String(r.file_url), r.file_mime || null, me.id]);
    inserted++;
  }
  return { ok: true, inserted, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Send — the core action. Uploads to Meta on first use, caches media_id,
// then sends via WhatsApp Cloud API. Logs into whatsapp_messages +
// wa_catalogue_sends. Bumps send_count.
// ─────────────────────────────────────────────────────────────────────────────
async function _fetchItemBytes(item) {
  // If file_url is one of our /api/wa-catalogue-file/<token> URLs, pull from
  // wa_catalogue_media directly. Otherwise fetch over HTTPS.
  const m = String(item.file_url || '').match(/\/api\/wa-catalogue-file\/([a-f0-9]+)/i);
  if (m) {
    const r = await db.query(`SELECT bytes, mime, filename FROM wa_catalogue_media WHERE token=$1`, [m[1]]);
    if (!r.rows.length) throw new Error('Catalogue file not found on server');
    return { buffer: r.rows[0].bytes, mime: r.rows[0].mime || item.file_mime || 'application/octet-stream',
             filename: r.rows[0].filename || item.name };
  }
  // External URL — fetch it
  const rr = await fetch(item.file_url);
  if (!rr.ok) throw new Error('Could not fetch external file (HTTP ' + rr.status + ')');
  const ab = await rr.arrayBuffer();
  return { buffer: Buffer.from(ab), mime: item.file_mime || rr.headers.get('content-type') || 'application/octet-stream',
           filename: item.name };
}

async function _uploadItemToMeta(item, cfg) {
  const { buffer, mime, filename } = await _fetchItemBytes(item);
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mime);
  const blob = new Blob([buffer], { type: mime });
  fd.append('file', blob, filename || 'upload.bin');
  const r = await fetch('https://graph.facebook.com/v19.0/' + cfg.phoneId + '/media', {
    method: 'POST', headers: { Authorization: 'Bearer ' + cfg.token }, body: fd });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('Meta upload failed: ' + (j.error && j.error.message || 'HTTP ' + r.status));
  return { media_id: j.id, mime };
}

function _mediaKindFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

async function api_wa_catalogue_send(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  if (!p.phone) throw new Error('phone required');
  const ids = Array.isArray(p.item_ids) && p.item_ids.length ? p.item_ids
            : (p.item_id ? [p.item_id] : []);
  if (!ids.length) throw new Error('item_id or item_ids[] required');

  const wb = require('./whatsbot');
  const cfg = await wb._cfgForPhone(p.from_phone_number_id).catch(async () => wb._cfg());
  if (!cfg.token || !cfg.phoneId) throw new Error('WhatsApp not configured (missing token or phone_number_id)');

  // Resolve lead by phone if not provided
  const phoneDigits = String(p.phone).replace(/\D/g, '');
  let leadId = p.lead_id || null;
  if (!leadId) {
    const lx = await db.query(
      `SELECT id FROM leads WHERE regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $1
         OR regexp_replace(COALESCE(whatsapp,''), '\\D', '', 'g') = $1 LIMIT 1`, [phoneDigits]);
    if (lx.rows.length) leadId = lx.rows[0].id;
  }

  const results = [];
  for (const rawId of ids) {
    const id = Number(rawId);
    const rx = await db.query(
      `SELECT * FROM wa_catalogue_items WHERE id=$1 AND is_active`, [id]);
    if (!rx.rows.length) { results.push({ id, error: 'not found' }); continue; }
    const item = rx.rows[0];

    // Cache-age check — Meta media IDs are valid ~30 days
    const cacheOK = item.wa_media_id && item.wa_media_at
      && (Date.now() - new Date(item.wa_media_at).getTime()) < 25 * 24 * 3600 * 1000;

    let mediaId = cacheOK ? item.wa_media_id : null;
    let mime = item.file_mime || 'application/octet-stream';
    if (!mediaId) {
      try {
        const up = await _uploadItemToMeta(item, cfg);
        mediaId = up.media_id;
        mime = up.mime;
        await db.query(
          `UPDATE wa_catalogue_items SET wa_media_id=$1, wa_media_at=NOW(), file_mime=COALESCE(file_mime, $2) WHERE id=$3`,
          [mediaId, mime, id]);
      } catch (e) {
        results.push({ id, error: e.message || 'upload failed' });
        continue;
      }
    }

    const kind = _mediaKindFromMime(mime);
    const caption = String(p.caption || item.caption || '').trim();
    try {
      const r = await wb._sendMediaById({
        to: p.phone, mediaType: kind, mediaId: mediaId,
        filename: kind === 'document' ? (item.name || 'file') : undefined,
        caption: caption, leadId: leadId, userId: me.id,
        mediaUrl: item.file_url || null
      }, cfg);
      const waMsgId = r && r.wa_message_id || null;
      await db.query(
        `INSERT INTO wa_catalogue_sends (item_id, lead_id, user_id, phone, wa_message_id) VALUES ($1,$2,$3,$4,$5)`,
        [id, leadId, me.id, phoneDigits, waMsgId]);
      await db.query(`UPDATE wa_catalogue_items SET send_count = send_count + 1 WHERE id=$1`, [id]);
      results.push({ id, ok: true, wa_message_id: waMsgId });
    } catch (e) {
      // If Meta rejected the cached media_id, invalidate cache + retry once
      const msg = String(e.message || '');
      if (cacheOK && /media|not found|expired/i.test(msg)) {
        await db.query(`UPDATE wa_catalogue_items SET wa_media_id=NULL, wa_media_at=NULL WHERE id=$1`, [id]);
        results.push({ id, error: 'cache invalidated, please retry' });
      } else {
        results.push({ id, error: msg || 'send failed' });
      }
    }
  }
  const okCount = results.filter(r => r.ok).length;
  return { ok: okCount > 0, sent: okCount, results: results };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats — most-sent items for a Reports card (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────
async function api_wa_catalogue_topSent(token, opts) {
  await authUser(token);
  await _ensureSchema();
  const o = opts || {};
  const days = Math.min(Math.max(Number(o.days || 7), 1), 365);
  const r = await db.query(
    `SELECT i.id, i.name, i.sku, i.price, i.file_url, i.file_mime,
            COUNT(s.id)::int AS sends
       FROM wa_catalogue_items i
       LEFT JOIN wa_catalogue_sends s ON s.item_id = i.id AND s.sent_at >= NOW() - INTERVAL '${days} days'
       WHERE i.is_active
       GROUP BY i.id
       ORDER BY sends DESC, i.send_count DESC
       LIMIT 20`);
  return { items: r.rows };
}

module.exports = {
  api_wa_catalogue_folders_list,
  api_wa_catalogue_folders_upsert,
  api_wa_catalogue_folders_delete,
  api_wa_catalogue_list,
  api_wa_catalogue_get,
  api_wa_catalogue_upsert,
  api_wa_catalogue_delete,
  api_wa_catalogue_import_csv,
  api_wa_catalogue_send,
  api_wa_catalogue_topSent,
  _ensureSchema,
};
