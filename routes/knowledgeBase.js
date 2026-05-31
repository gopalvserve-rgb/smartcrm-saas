/**
 * routes/knowledgeBase.js — admin-curated reference content for the team.
 *
 * Anyone logged in can list and read entries; only admin can create / update /
 * delete. Categories are an open string but the UI offers a fixed dropdown:
 *   script | faq | offer | brochure | pricing | video | link | other
 *
 * Stored fields:
 *   title, category, body (markdown / plain text), url (external link to Drive
 *   / Box / YouTube / etc.), tags (CSV), product_id (optional join to a product),
 *   is_pinned (admin highlight), is_active (soft-delete)
 *
 * MVP is URL-first: admins paste links to files hosted elsewhere (Drive, Box,
 * S3) rather than us shipping native upload + storage. Easy to extend later.
 */

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const VALID_CATEGORIES = ['script', 'faq', 'offer', 'brochure', 'pricing', 'video', 'link', 'other'];

function _hydrate(row, productsById, usersById) {
  return {
    id: row.id,
    title: row.title || '',
    category: row.category || 'other',
    body: row.body || '',
    url: row.url || '',
    tags: row.tags || '',
    product_id: row.product_id || null,
    product_name: productsById[Number(row.product_id)]?.name || '',
    is_pinned: Number(row.is_pinned) === 1,
    is_active: Number(row.is_active) === 1,
    created_by: row.created_by,
    created_by_name: usersById[Number(row.created_by)]?.name || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    // KB_FILE_UPLOAD_v1: attached-file metadata (raw bytes never sent through JSON RPC).
    has_file: !!row.file_name,
    file_name: row.file_name || '',
    file_mime: row.file_mime || '',
    file_size_bytes: row.file_size_bytes ? Number(row.file_size_bytes) : 0
  };
}

// KB_FILE_UPLOAD_v1: self-healing column migration. Idempotent - safe to
// call on every upload/download to keep older tenants in sync.
async function _ensureFileColumns() {
  try {
    await db.query(
      'ALTER TABLE knowledge_base '
      + 'ADD COLUMN IF NOT EXISTS file_bytes BYTEA, '
      + 'ADD COLUMN IF NOT EXISTS file_name TEXT, '
      + 'ADD COLUMN IF NOT EXISTS file_mime TEXT, '
      + 'ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT'
    );
  } catch (e) {
    console.warn('[kb] _ensureFileColumns failed:', e.message);
  }
}

/**
 * List entries — supports a few filters useful from the UI:
 *   - category    — exact match
 *   - q           — case-insensitive search across title + body + tags + url
 *   - product_id  — narrow to one product
 *   - include_inactive — admin-only; everyone else sees only is_active=1
 *
 * Pinned items always sort first; then by updated_at DESC.
 */
async function api_kb_list(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  const includeInactive = me.role === 'admin' && !!filters.include_inactive;

  const [rows, products, users] = await Promise.all([
    db.getAll('knowledge_base'), db.getAll('products'), db.getAll('users')
  ]);
  const productsById = {}; products.forEach(p => { productsById[Number(p.id)] = p; });
  const usersById = {}; users.forEach(u => { usersById[Number(u.id)] = u; });

  let out = rows.map(r => _hydrate(r, productsById, usersById));
  if (!includeInactive) out = out.filter(r => r.is_active);
  if (filters.category && filters.category !== 'all') {
    out = out.filter(r => r.category === filters.category);
  }
  if (filters.product_id) {
    out = out.filter(r => Number(r.product_id) === Number(filters.product_id));
  }
  if (filters.q) {
    const q = String(filters.q).toLowerCase().trim();
    if (q) {
      out = out.filter(r =>
        String(r.title || '').toLowerCase().includes(q) ||
        String(r.body  || '').toLowerCase().includes(q) ||
        String(r.tags  || '').toLowerCase().includes(q) ||
        String(r.url   || '').toLowerCase().includes(q)
      );
    }
  }
  out.sort((a, b) =>
    (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0) ||
    String(b.updated_at).localeCompare(String(a.updated_at))
  );
  return out;
}

async function api_kb_get(token, id) {
  await authUser(token);
  const row = await db.findById('knowledge_base', id);
  if (!row || Number(row.is_active) !== 1) {
    // Admins can still read soft-deleted entries
    const me = await authUser(token);
    if (!row || (Number(row.is_active) !== 1 && me.role !== 'admin')) {
      throw new Error('Not found');
    }
  }
  const [products, users] = await Promise.all([db.getAll('products'), db.getAll('users')]);
  const productsById = {}; products.forEach(p => { productsById[Number(p.id)] = p; });
  const usersById = {}; users.forEach(u => { usersById[Number(u.id)] = u; });
  return _hydrate(row, productsById, usersById);
}

async function api_kb_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admin can manage the knowledge base');
  const p = payload || {};
  if (!p.title || !String(p.title).trim()) throw new Error('Title is required');

  const cat = String(p.category || 'other').toLowerCase().trim();
  const category = VALID_CATEGORIES.includes(cat) ? cat : 'other';

  const fields = {
    title: String(p.title).trim().slice(0, 240),
    category,
    body: p.body == null ? '' : String(p.body),
    url: p.url == null ? '' : String(p.url).trim().slice(0, 2000),
    tags: p.tags == null ? '' : String(p.tags).trim().slice(0, 500),
    product_id: p.product_id ? Number(p.product_id) : null,
    is_pinned: p.is_pinned ? 1 : 0,
    is_active: p.is_active === 0 ? 0 : 1,
    updated_at: db.nowIso()
  };

  if (p.id) {
    await db.update('knowledge_base', p.id, fields);
    return { id: Number(p.id), ok: true };
  }
  const id = await db.insert('knowledge_base', Object.assign({
    created_by: me.id, created_at: db.nowIso()
  }, fields));
  return { id, ok: true };
}

/**
 * Soft-delete by default (is_active=0) so the entry is hidden but recoverable.
 * Pass `hard: true` from the UI to permanently remove.
 */
async function api_kb_delete(token, id, opts) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admin can delete knowledge base entries');
  if (opts && opts.hard) {
    await db.removeRow('knowledge_base', id);
    return { ok: true, hard: true };
  }
  await db.update('knowledge_base', id, { is_active: 0, updated_at: db.nowIso() });
  return { ok: true };
}

/**
 * KB_FILE_UPLOAD_v1: multipart upload handler. Admin-only.
 * POST /api/kb-file/:id  (multer single 'file')
 * Attaches the uploaded file to an existing entry. Returns the hydrated row.
 */
async function expressKbFileUpload(req, res) {
  try {
    await _ensureFileColumns();
    const token = (req.headers['x-auth-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const me = await authUser(token);
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only admin can upload KB files' });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'entry id required' });
    if (!req.file) return res.status(400).json({ error: 'file required (form field "file")' });
    if ((req.file.size || 0) > 25 * 1024 * 1024) {
      return res.status(400).json({ error: 'Max 25 MB per file' });
    }
    // Confirm the entry exists in this tenant.
    const exists = await db.query('SELECT id FROM knowledge_base WHERE id = $1', [id]);
    if (!exists.rows.length) return res.status(404).json({ error: 'entry not found' });
    await db.query(
      'UPDATE knowledge_base SET file_bytes = $1, file_name = $2, file_mime = $3, file_size_bytes = $4, updated_at = $5 WHERE id = $6',
      [
        req.file.buffer,
        String(req.file.originalname || 'file').slice(0, 200),
        req.file.mimetype || 'application/octet-stream',
        req.file.size || 0,
        db.nowIso(),
        id
      ]
    );
    res.json({ ok: true, id, file_name: req.file.originalname, file_size_bytes: req.file.size, file_mime: req.file.mimetype });
  } catch (e) {
    console.error('[kb-upload]', e.message);
    res.status(400).json({ error: e.message });
  }
}

/**
 * KB_FILE_UPLOAD_v1: streaming download. Any logged-in tenant user.
 * GET /api/kb-file/:id?token=...&dl=1
 * dl=1 forces Content-Disposition: attachment (download). Default is inline so
 * PDFs / images render in the browser.
 */
async function expressKbFileDownload(req, res) {
  try {
    await _ensureFileColumns();
    const token = (req.query.token || req.headers['x-auth-token'] || req.headers.authorization || '').toString().replace(/^Bearer\s+/i, '');
    await authUser(token); // any logged-in user can download (KB is internal-only)
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const r = await db.query('SELECT file_bytes, file_name, file_mime FROM knowledge_base WHERE id = $1 LIMIT 1', [id]);
    const row = r.rows[0];
    if (!row || !row.file_bytes) return res.status(404).json({ error: 'no file attached' });
    let buf = row.file_bytes;
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    const isDl = String(req.query.dl || '') === '1';
    const safeName = String(row.file_name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Type', row.file_mime || 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', (isDl ? 'attachment' : 'inline') + '; filename="' + safeName + '"');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(buf);
  } catch (e) {
    console.error('[kb-download]', e.message);
    res.status(400).json({ error: e.message });
  }
}

/**
 * KB_FILE_UPLOAD_v1: detach the file from an entry (admin only).
 */
async function api_kb_removeFile(token, id) {
  await _ensureFileColumns();
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admin can remove KB files');
  if (!id) throw new Error('id required');
  await db.query(
    'UPDATE knowledge_base SET file_bytes = NULL, file_name = NULL, file_mime = NULL, file_size_bytes = NULL, updated_at = $1 WHERE id = $2',
    [db.nowIso(), Number(id)]
  );
  return { ok: true };
}

module.exports = {
  api_kb_list, api_kb_get, api_kb_save, api_kb_delete, api_kb_removeFile,
  expressKbFileUpload, expressKbFileDownload
};
