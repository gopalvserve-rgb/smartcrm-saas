const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_products_list(token) {
  await authUser(token);
  return (await db.getAll('products')).filter(p => Number(p.is_active) !== 0);
}
async function api_products_save(token, product) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const p = product || {};
  if (!p.name) throw new Error('name required');
  const payload = { name: p.name, description: p.description || '', price: Number(p.price) || 0, is_active: 1 };
  if (p.id) { await db.update('products', p.id, payload); return { id: Number(p.id) }; }
  const id = await db.insert('products', payload);
  return { id };
}
async function api_products_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.update('products', id, { is_active: 0 });
  return { ok: true };
}
module.exports = { api_products_list, api_products_save, api_products_delete };
