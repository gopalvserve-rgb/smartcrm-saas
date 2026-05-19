const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _columnsEnsured = false;
async function _ensureProductCols() {
  if (_columnsEnsured) return;
  try {
    // Self-healing migration: GST percentage + product image URL.
    // Idempotent — safe on every boot for older tenants without these
    // columns. New tenants get them via the columns array in db/pg.js.
    await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_pct  NUMERIC(5,2) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT`);
    _columnsEnsured = true;
  } catch (e) {
    // table might not exist yet on a brand-new tenant — non-fatal
    console.warn('[products] _ensureProductCols:', e.message);
  }
}

async function api_products_list(token) {
  await authUser(token);
  await _ensureProductCols();
  return (await db.getAll('products')).filter(p => Number(p.is_active) !== 0);
}
async function api_products_save(token, product) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  await _ensureProductCols();
  const p = product || {};
  if (!p.name) throw new Error('name required');
  const payload = {
    name: p.name,
    description: p.description || '',
    price: Number(p.price) || 0,
    gst_pct: Math.max(0, Math.min(100, Number(p.gst_pct) || 0)),
    /* PROD_IMG_v1 — allow data: URIs (base64) which can run several hundred KB */
    image_url: p.image_url ? String(p.image_url).slice(0, 5_000_000) : null,
    is_active: 1
  };
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
