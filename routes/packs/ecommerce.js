/**
 * routes/packs/ecommerce.js — Ecommerce industry pack (D2C / online stores)
 *
 * Tables (idempotent, namespaced ec_*):
 *   ec_products ec_orders ec_returns ec_abandoned_carts ec_loyalty
 * Seeds: 9 statuses, 7 custom fields, 4 sample products.
 */
'use strict';
const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser } = require('../../utils/auth');
const PACK_ID = 'ecommerce';

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS ec_products (
    id SERIAL PRIMARY KEY, sku TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '',
    mrp NUMERIC(10,2) NOT NULL DEFAULT 0, sale_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0, weight_g NUMERIC(8,2) NOT NULL DEFAULT 0,
    image_url TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_products_sku_idx ON ec_products(sku)`);

  await db.query(`CREATE TABLE IF NOT EXISTS ec_orders (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL,
    order_id TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]',
    subtotal NUMERIC(12,2) NOT NULL DEFAULT 0, discount NUMERIC(12,2) NOT NULL DEFAULT 0,
    shipping NUMERIC(10,2) NOT NULL DEFAULT 0, tax NUMERIC(10,2) NOT NULL DEFAULT 0,
    order_value NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_mode TEXT NOT NULL DEFAULT 'cod', payment_status TEXT NOT NULL DEFAULT 'unpaid',
    shipping_address TEXT NOT NULL DEFAULT '', pincode TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '', courier_partner TEXT NOT NULL DEFAULT '',
    awb TEXT NOT NULL DEFAULT '', tracking_url TEXT NOT NULL DEFAULT '',
    placed_at TIMESTAMPTZ, shipped_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'placed', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_orders_lead_idx ON ec_orders(lead_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_orders_orderid_idx ON ec_orders(order_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_orders_status_idx ON ec_orders(status)`);

  await db.query(`CREATE TABLE IF NOT EXISTS ec_returns (
    id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL, lead_id INTEGER NOT NULL,
    return_no TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]',
    return_reason TEXT NOT NULL DEFAULT '', refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    refund_status TEXT NOT NULL DEFAULT 'pending', refund_mode TEXT NOT NULL DEFAULT '',
    pickup_awb TEXT NOT NULL DEFAULT '', received_at TIMESTAMPTZ, refunded_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'requested', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_returns_order_idx ON ec_returns(order_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS ec_abandoned_carts (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL,
    cart_id TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]',
    cart_value NUMERIC(12,2) NOT NULL DEFAULT 0,
    abandoned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_nudge_at TIMESTAMPTZ, nudge_count INTEGER NOT NULL DEFAULT 0,
    recovered_order_id INTEGER, recovered_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'abandoned', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_carts_lead_idx ON ec_abandoned_carts(lead_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ec_carts_status_idx ON ec_abandoned_carts(status)`);

  await db.query(`CREATE TABLE IF NOT EXISTS ec_loyalty (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL UNIQUE,
    tier TEXT NOT NULL DEFAULT 'bronze', points INTEGER NOT NULL DEFAULT 0,
    lifetime_value NUMERIC(12,2) NOT NULL DEFAULT 0, order_count INTEGER NOT NULL DEFAULT 0,
    last_order_at TIMESTAMPTZ, notes TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function install(opts) {
  await _ensureSchema();
  const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM ec_products`);
  if (cnt.rows[0].n === 0) {
    const products = [
      ['SKU-001','Cotton T-Shirt','Apparel','BrandA',799,499,100,200],
      ['SKU-002','Bluetooth Earbuds','Electronics','BrandB',2999,1799,50,80],
      ['SKU-003','Yoga Mat','Fitness','BrandC',1499,899,30,1200],
      ['SKU-004','Skincare Set','Beauty','BrandD',1999,1299,25,500]
    ];
    for (const p of products) {
      await db.query(`INSERT INTO ec_products (sku,name,category,brand,mrp,sale_price,stock,weight_g) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, p);
    }
  }
  const STATUSES = [
    ['Cart Abandoned','#f97316',1],['Recovered','#22c55e',2],['Order Placed','#3b82f6',3],
    ['Packed','#06b6d4',4],['Shipped','#a855f7',5],['Out for Delivery','#eab308',6],
    ['Delivered','#10b981',7],['Return Requested','#ef4444',8],['Refunded','#84cc16',9],
    ['RTO','#dc2626',10]
  ];
  // PACK_STAGE_TAG_v1 — tag statuses with pack_id for clean industry isolation
  try { await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  try { await db.query(`ALTER TABLE lead_custom_fields ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  // Deactivate any older non-generic pack statuses to keep pipeline clean
  try { await db.query(`UPDATE statuses SET is_active=0 WHERE pack_id IS NOT NULL AND pack_id <> $1`, ['ecommerce']); } catch(_){}
  for (const s of STATUSES) {
    try { await db.query(`INSERT INTO statuses (name,color,sort_order,is_active,pack_id) VALUES ($1,$2,$3,1,'ecommerce') ON CONFLICT (name) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, s); } catch(_){}
  }
  const CFS = [
    ['order_id','Order ID','text'],
    ['sku','SKU','text'],
    ['order_value','Order Value','number'],
    ['payment_mode','Payment Mode','text'],
    ['courier','Courier','text'],
    ['awb','AWB','text'],
    ['return_reason','Return Reason','text']
  ];
  for (const cf of CFS) {
    try { await db.query(`INSERT INTO lead_custom_fields (field_key,label,field_type,is_active,pack_id) VALUES ($1,$2,$3,1,'ecommerce') ON CONFLICT (field_key) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, cf); } catch(_){}
  }
}
async function uninstall() {}

async function api_ec_products_list(token) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM ec_products WHERE is_active=1 ORDER BY category,name`);
  return { products: r.rows };
}
async function api_ec_products_save(token, payload) {
  const me = await authUser(token);
  if (me.role!=='admin'&&me.role!=='manager') throw new Error('Admin / manager only');
  await _ensureSchema(); const p = payload || {};
  if (p.id) {
    await db.query(`UPDATE ec_products SET sku=$1, name=$2, category=$3, brand=$4, mrp=$5, sale_price=$6, stock=$7, weight_g=$8, image_url=$9, is_active=$10 WHERE id=$11`,
      [p.sku||'',p.name,p.category||'',p.brand||'',p.mrp||0,p.sale_price||0,p.stock||0,p.weight_g||0,p.image_url||'',p.is_active!==0?1:0,p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO ec_products (sku,name,category,brand,mrp,sale_price,stock,weight_g,image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.sku||'',p.name,p.category||'',p.brand||'',p.mrp||0,p.sale_price||0,p.stock||0,p.weight_g||0,p.image_url||'']);
  return { ok: true, id: r.rows[0].id };
}

async function _bumpLoyalty(leadId, orderValue) {
  try {
    await db.query(`INSERT INTO ec_loyalty (lead_id, points, lifetime_value, order_count, last_order_at) VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (lead_id) DO UPDATE SET
        points = ec_loyalty.points + EXCLUDED.points,
        lifetime_value = ec_loyalty.lifetime_value + EXCLUDED.lifetime_value,
        order_count = ec_loyalty.order_count + 1,
        last_order_at = NOW(),
        tier = CASE
          WHEN ec_loyalty.lifetime_value + EXCLUDED.lifetime_value >= 50000 THEN 'gold'
          WHEN ec_loyalty.lifetime_value + EXCLUDED.lifetime_value >= 15000 THEN 'silver'
          ELSE 'bronze' END,
        updated_at = NOW()`,
      [leadId, Math.floor(Number(orderValue||0) / 100), Number(orderValue||0)]);
  } catch (_) {}
}

async function api_ec_order_create(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const items = Array.isArray(p.items) ? p.items : [];
  const subtotal = items.reduce((s, it) => s + Number(it.qty||0) * Number(it.price||0), 0);
  const orderValue = subtotal - Number(p.discount||0) + Number(p.shipping||0) + Number(p.tax||0);
  const r = await db.query(`INSERT INTO ec_orders (lead_id,order_id,items_json,subtotal,discount,shipping,tax,order_value,payment_mode,payment_status,shipping_address,pincode,state,courier_partner,awb,tracking_url,placed_at,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [p.lead_id,p.order_id||'',JSON.stringify(items),subtotal,p.discount||0,p.shipping||0,p.tax||0,orderValue,p.payment_mode||'cod',p.payment_status||'unpaid',p.shipping_address||'',p.pincode||'',p.state||'',p.courier_partner||'',p.awb||'',p.tracking_url||'',p.placed_at||new Date(),p.status||'placed',p.notes||'']);
  await _bumpLoyalty(p.lead_id, orderValue);
  return { ok: true, id: r.rows[0].id, order_value: orderValue };
}
async function api_ec_order_update(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('id required');
  await db.query(`UPDATE ec_orders SET courier_partner=$1, awb=$2, tracking_url=$3, shipped_at=$4, delivered_at=$5, payment_status=$6, status=$7, notes=$8 WHERE id=$9`,
    [p.courier_partner||'',p.awb||'',p.tracking_url||'',p.shipped_at||null,p.delivered_at||null,p.payment_status||'unpaid',p.status||'placed',p.notes||'',p.id]);
  return { ok: true };
}
async function api_ec_order_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM ec_orders WHERE lead_id=$1 ORDER BY placed_at DESC NULLS LAST, created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { orders: r.rows.map(o => ({ ...o, items: (function(){ try { return JSON.parse(o.items_json||'[]'); } catch(_){ return []; }})() })) };
}

async function api_ec_return_create(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.order_id || !p.lead_id) throw new Error('order_id and lead_id required');
  const r = await db.query(`INSERT INTO ec_returns (order_id,lead_id,return_no,items_json,return_reason,refund_amount,refund_status,refund_mode,pickup_awb,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.order_id,p.lead_id,p.return_no||'',JSON.stringify(p.items||[]),p.return_reason||'',p.refund_amount||0,p.refund_status||'pending',p.refund_mode||'',p.pickup_awb||'',p.status||'requested',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_ec_return_update(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('id required');
  await db.query(`UPDATE ec_returns SET refund_amount=$1, refund_status=$2, refund_mode=$3, pickup_awb=$4, received_at=$5, refunded_at=$6, status=$7, notes=$8 WHERE id=$9`,
    [p.refund_amount||0,p.refund_status||'pending',p.refund_mode||'',p.pickup_awb||'',p.received_at||null,p.refunded_at||null,p.status||'requested',p.notes||'',p.id]);
  return { ok: true };
}
async function api_ec_return_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM ec_returns WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { returns: r.rows };
}

async function api_ec_cart_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const items = Array.isArray(p.items) ? p.items : [];
  const value = items.reduce((s, it) => s + Number(it.qty||0) * Number(it.price||0), 0);
  if (p.id) {
    await db.query(`UPDATE ec_abandoned_carts SET items_json=$1, cart_value=$2, status=$3, notes=$4 WHERE id=$5`,
      [JSON.stringify(items),value,p.status||'abandoned',p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO ec_abandoned_carts (lead_id,cart_id,items_json,cart_value,status,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.lead_id,p.cart_id||'',JSON.stringify(items),value,p.status||'abandoned',p.notes||'']);
  return { ok: true, id: r.rows[0].id, value };
}
async function api_ec_cart_nudge(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('cart id required');
  await db.query(`UPDATE ec_abandoned_carts SET last_nudge_at=NOW(), nudge_count=nudge_count+1 WHERE id=$1`, [p.id]);
  return { ok: true };
}
async function api_ec_cart_markRecovered(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('cart id required');
  await db.query(`UPDATE ec_abandoned_carts SET status='recovered', recovered_at=NOW(), recovered_order_id=$1 WHERE id=$2`, [p.recovered_order_id||null, p.id]);
  return { ok: true };
}
async function api_ec_cart_listAbandoned(token, payload) {
  await authUser(token); await _ensureSchema();
  const hrs = parseInt(((payload&&payload.hours)||72), 10);
  const r = await db.query(`SELECT c.*, l.name AS lead_name, l.phone AS lead_phone FROM ec_abandoned_carts c LEFT JOIN leads l ON l.id=c.lead_id WHERE c.status='abandoned' AND c.abandoned_at <= NOW() - INTERVAL '1 hour' AND c.abandoned_at >= NOW() - INTERVAL '${hrs} hours' ORDER BY c.abandoned_at DESC LIMIT 200`);
  return { carts: r.rows.map(c => ({ ...c, items: (function(){ try { return JSON.parse(c.items_json||'[]'); } catch(_){ return []; }})() })) };
}

async function api_ec_loyalty_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM ec_loyalty WHERE lead_id=$1`, [(payload&&payload.lead_id)||0]);
  return { loyalty: r.rows[0] || null };
}

async function api_ec_summary(token) {
  await authUser(token); await _ensureSchema();
  const ord30 = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(order_value),0) AS val FROM ec_orders WHERE placed_at >= NOW() - INTERVAL '30 days'`);
  const pending = await db.query(`SELECT COUNT(*)::int AS cnt FROM ec_orders WHERE status IN ('placed','packed','shipped','out_for_delivery')`);
  const carts = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(cart_value),0) AS val FROM ec_abandoned_carts WHERE status='abandoned' AND abandoned_at >= NOW() - INTERVAL '7 days'`);
  const returns = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(refund_amount),0) AS val FROM ec_returns WHERE status NOT IN ('refunded','cancelled')`);
  const gold = await db.query(`SELECT COUNT(*)::int AS cnt FROM ec_loyalty WHERE tier='gold'`);
  return {
    orders_30d: { count: ord30.rows[0].cnt, value: Number(ord30.rows[0].val) },
    fulfillment_pending: pending.rows[0].cnt,
    abandoned_carts_7d: { count: carts.rows[0].cnt, value: Number(carts.rows[0].val) },
    returns_open: { count: returns.rows[0].cnt, refund_pending: Number(returns.rows[0].val) },
    gold_members: gold.rows[0].cnt
  };
}

framework.register({
  id: PACK_ID, name: 'Ecommerce', industry: 'ecommerce',
  summary: 'D2C / online store — product catalog, orders, returns, abandoned-cart recovery, loyalty tiers.',
  version: '1.0.0',
  features: ['Product catalog with SKU + MRP + stock','Order placement + courier + AWB + tracking','Returns + refund tracker','Abandoned-cart recovery (nudge counter)','Auto-tiered loyalty (bronze / silver / gold)','10 Ecommerce statuses + 7 custom fields seeded'],
  nav_items: [
    { id: 'ecorders',  label: '📦 Orders', icon: '📦' },
    { id: 'eccarts',   label: '🛒 Abandoned Carts', icon: '🛒' },
    { id: 'ecreturns', label: '↩️ Returns', icon: '↩️' },
    { id: 'ecloyalty', label: '🏆 Loyalty', icon: '🏆' }
  ],
  install, uninstall
});

module.exports = {
  install, uninstall, _ensureSchema,
  api_ec_products_list, api_ec_products_save,
  api_ec_order_create, api_ec_order_update, api_ec_order_byLead,
  api_ec_return_create, api_ec_return_update, api_ec_return_byLead,
  api_ec_cart_save, api_ec_cart_nudge, api_ec_cart_markRecovered, api_ec_cart_listAbandoned,
  api_ec_loyalty_byLead, api_ec_summary
};
