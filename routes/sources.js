const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_sources_list(token) {
  await authUser(token);
  return (await db.getAll('sources'))
    .filter(s => Number(s.is_active) !== 0)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
}

async function api_sources_save(token, src) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const s = src || {};
  if (!s.name) throw new Error('name required');
  const payload = {
    name: String(s.name).trim(),
    color: s.color || '#6b7280',
    sort_order: Number(s.sort_order) || 0,
    is_active: s.is_active == null ? 1 : (s.is_active ? 1 : 0)
  };
  if (s.id) { await db.update('sources', s.id, payload); return { id: Number(s.id) }; }
  if (await db.findOneBy('sources', 'name', payload.name)) throw new Error('Source name exists');
  const id = await db.insert('sources', payload);
  return { id };
}

async function api_sources_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.update('sources', id, { is_active: 0 });
  return { ok: true };
}

module.exports = { api_sources_list, api_sources_save, api_sources_delete };
