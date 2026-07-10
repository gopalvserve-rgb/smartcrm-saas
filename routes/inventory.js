const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// INVENTORY_STOCK_v1 — model-wise stock ledger. Each inventory row carries a
// manually-entered received/opening qty; SOLD qty is derived live from invoice
// line items (matched by model name, case-insensitive) on non-cancelled invoices;
// balance = received - sold.
let _stockColEnsured = false;
async function _ensureStockCol() {
  if (_stockColEnsured) return;
  try { await db.query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS received_qty NUMERIC(14,2) NOT NULL DEFAULT 0`); } catch (_) {}
  _stockColEnsured = true;
}
async function _soldByModel() {
  try {
    const r = await db.query(`
      SELECT LOWER(TRIM(l.description)) AS nm, COALESCE(SUM(l.qty),0) AS sold
        FROM invoice_lines_inv l
        JOIN invoices_inv i ON i.id = l.invoice_id
       WHERE COALESCE(i.status,'') <> 'cancelled'
       GROUP BY LOWER(TRIM(l.description))`);
    const m = {};
    (r.rows || []).forEach(x => { m[x.nm] = Number(x.sold) || 0; });
    return m;
  } catch (_) { return {}; }
}
function _stock(r, soldMap) {
  const received = Number(r.received_qty) || 0;
  const sold = soldMap[String(r.name || '').trim().toLowerCase()] || 0;
  return { received_qty: received, sold_qty: sold, balance_qty: Math.round((received - sold) * 100) / 100 };
}

/**
 * Inventory module — saleable stock the org has on hand: flats / plots /
 * subscription plans / products. The admin maintains this list under
 * the "Inventory" tab; reps see auto-suggested matches on every lead's
 * detail page based on the lead's budget_max and requirement_type.
 *
 * Match algorithm (V1):
 *   - status must be 'available'
 *   - price ≤ budget_max × 1.1 (10% headroom; or no filter if no budget)
 *   - item_type must equal lead.requirement_type when both are set
 *   - score: matched type +2, in-budget +1
 *   - sorted by score desc, price asc
 *   - top 8 returned
 *
 * Phase 2 will add JSONB attribute matching (BHK, sqft, location, etc.)
 * once the per-tenant inventory_attributes admin schema is built.
 */
async function api_inventory_list(token, filters) {
  await authUser(token);
  await _ensureStockCol();
  const soldMap = await _soldByModel();
  const f = filters || {};
  const all = await db.getAll('inventory');
  let rows = all.filter(r => true);
  if (f.status) rows = rows.filter(r => String(r.status) === String(f.status));
  if (f.item_type) rows = rows.filter(r => String(r.item_type || '').toLowerCase() === String(f.item_type).toLowerCase());
  if (f.q) {
    const q = String(f.q).toLowerCase();
    rows = rows.filter(r =>
      String(r.name || '').toLowerCase().includes(q) ||
      String(r.location || '').toLowerCase().includes(q) ||
      String(r.description || '').toLowerCase().includes(q)
    );
  }
  if (f.minPrice != null) rows = rows.filter(r => Number(r.price) >= Number(f.minPrice));
  if (f.maxPrice != null) rows = rows.filter(r => Number(r.price) <= Number(f.maxPrice));
  // Sort: available first, then by created_at desc
  rows.sort((a, b) => {
    const sA = String(a.status) === 'available' ? 0 : 1;
    const sB = String(b.status) === 'available' ? 0 : 1;
    if (sA !== sB) return sA - sB;
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });
  return rows.map(r => Object.assign({
    id: r.id, name: r.name, item_type: r.item_type, price: Number(r.price) || 0,
    status: r.status, location: r.location, description: r.description,
    attributes: r.attributes || {},
    created_at: r.created_at, updated_at: r.updated_at
  }, _stock(r, soldMap)));
}

async function api_inventory_get(token, id) {
  await authUser(token);
  await _ensureStockCol();
  const r = await db.findOneBy('inventory', 'id', id);
  if (!r) throw new Error('Inventory item not found');
  const soldMap = await _soldByModel();
  return Object.assign({
    id: r.id, name: r.name, item_type: r.item_type, price: Number(r.price) || 0,
    status: r.status, location: r.location, description: r.description,
    attributes: r.attributes || {},
    created_at: r.created_at, updated_at: r.updated_at
  }, _stock(r, soldMap));
}

async function api_inventory_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const p = payload || {};
  if (!p.name) throw new Error('Name is required');
  await _ensureStockCol();
  const data = {
    name:        String(p.name).trim(),
    item_type:   p.item_type || '',
    price:       Number(p.price) || 0,
    received_qty: Number(p.received_qty) || 0,
    status:      p.status || 'available',
    location:    p.location || '',
    description: p.description || '',
    attributes:  p.attributes && typeof p.attributes === 'object' ? p.attributes : {},
    updated_at:  db.nowIso()
  };
  if (p.id) {
    await db.update('inventory', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  data.created_by = me.id;
  data.created_at = db.nowIso();
  const id = await db.insert('inventory', data);
  return { id, ok: true };
}

async function api_inventory_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  // Soft delete by flipping status
  await db.update('inventory', id, { status: 'inactive', updated_at: db.nowIso() });
  return { ok: true };
}

async function api_inventory_match(token, leadId) {
  await authUser(token);
  const lead = await db.findOneBy('leads', 'id', leadId);
  if (!lead) throw new Error('Lead not found');
  const budget = Number(lead.budget_max) || 0;
  const reqType = String(lead.requirement_type || '').trim().toLowerCase();
  const all = await db.getAll('inventory');
  const matches = [];
  for (const r of all) {
    if (String(r.status) !== 'available') continue;
    const price = Number(r.price) || 0;
    const itemType = String(r.item_type || '').trim().toLowerCase();
    // Hard filter: type must match if both sides specify
    if (reqType && itemType && reqType !== itemType) continue;
    // Hard filter: price must be ≤ budget*1.1 if budget specified
    if (budget > 0 && price > budget * 1.1) continue;
    let score = 0;
    if (reqType && itemType && reqType === itemType) score += 2;
    if (budget > 0 && price <= budget) score += 1;
    matches.push({
      id: r.id, name: r.name, item_type: r.item_type,
      price, status: r.status, location: r.location,
      description: r.description, attributes: r.attributes || {},
      score
    });
  }
  matches.sort((a, b) => b.score - a.score || a.price - b.price);
  return matches.slice(0, 8);
}

module.exports = {
  api_inventory_list, api_inventory_get, api_inventory_save,
  api_inventory_delete, api_inventory_match
};
