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
    updated_at: row.updated_at
  };
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

module.exports = {
  api_kb_list, api_kb_get, api_kb_save, api_kb_delete
};
