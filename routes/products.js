const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _columnsEnsured = false;
async function _ensureProductCols() {
  /* WORKSPACE_v1 (2026-07-10) — stop caching module-level. Cross-tenant
   * pool caches on the first tenant and skips ALTER for all others.
   * Same landmine that bit statuses._heal() before. */
  try {
    // Self-healing migration: GST percentage + product image URL.
    await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_pct  NUMERIC(5,2) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT`);
    /* WORKSPACE_v1 — workspace scoping. Empty JSONB [] = all workspaces
     * (today's behaviour, no data migration needed). */
    await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS workspace_ids JSONB DEFAULT '[]'`);
    _columnsEnsured = true;
  } catch (e) {
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
  /* WORKSPACE_v1 — coerce workspace_ids to integer array. Empty = all. */
  let wsIds = [];
  if (Array.isArray(p.workspace_ids)) {
    wsIds = p.workspace_ids.map(x => Number(x)).filter(x => Number.isInteger(x) && x > 0);
  }
  const payload = {
    name: p.name,
    description: p.description || '',
    price: Number(p.price) || 0,
    gst_pct: Math.max(0, Math.min(100, Number(p.gst_pct) || 0)),
    /* PROD_IMG_v1 — allow data: URIs (base64) which can run several hundred KB */
    image_url: p.image_url ? String(p.image_url).slice(0, 5_000_000) : null,
    workspace_ids: JSON.stringify(wsIds),
    is_active: 1
  };
  if (p.id) {
    await db.update('products', p.id, payload);
    try {
      await db.query('UPDATE products SET workspace_ids = $1::jsonb WHERE id = $2', [payload.workspace_ids, Number(p.id)]);
    } catch (e) { console.warn('[products] raw workspace_ids update failed:', e.message); }
    return { id: Number(p.id) };
  }
  const id = await db.insert('products', payload);
  try {
    await db.query('UPDATE products SET workspace_ids = $1::jsonb WHERE id = $2', [payload.workspace_ids, Number(id)]);
  } catch (e) { console.warn('[products] raw workspace_ids insert failed:', e.message); }
  return { id };
}
async function api_products_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.update('products', id, { is_active: 0 });
  return { ok: true };
}
module.exports = { api_products_list, api_products_save, api_products_delete };
