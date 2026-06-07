/**
 * routes/packs/manufacturer.js — Manufacturer industry pack (B2B manufacturing)
 *
 * Tables (idempotent, namespaced mfg_*):
 *   mfg_inquiries mfg_quotes mfg_orders mfg_production mfg_dispatches
 * Seeds: 9 statuses, 6 custom fields, 3 sample SKUs.
 */
'use strict';
const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser } = require('../../utils/auth');
const PACK_ID = 'manufacturer';

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS mfg_inquiries (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, rfq_no TEXT NOT NULL DEFAULT '',
    product_specs TEXT NOT NULL DEFAULT '', quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
    material_grade TEXT NOT NULL DEFAULT '', expected_delivery_date DATE,
    payment_terms TEXT NOT NULL DEFAULT '', shipping_terms TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'received',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS mfg_inquiries_lead_idx ON mfg_inquiries(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS mfg_quotes (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, inquiry_id INTEGER,
    quote_no TEXT NOT NULL DEFAULT '', items_json TEXT NOT NULL DEFAULT '[]',
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0, gst NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0, hsn_code TEXT NOT NULL DEFAULT '',
    payment_terms TEXT NOT NULL DEFAULT '', delivery_terms TEXT NOT NULL DEFAULT '',
    valid_till DATE, status TEXT NOT NULL DEFAULT 'draft', sent_at TIMESTAMPTZ,
    notes TEXT NOT NULL DEFAULT '', created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS mfg_quotes_lead_idx ON mfg_quotes(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS mfg_orders (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, quote_id INTEGER,
    po_number TEXT NOT NULL DEFAULT '', po_date DATE,
    order_value NUMERIC(14,2) NOT NULL DEFAULT 0,
    advance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    balance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    delivery_date DATE, status TEXT NOT NULL DEFAULT 'received',
    payment_status TEXT NOT NULL DEFAULT 'unpaid', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS mfg_orders_lead_idx ON mfg_orders(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS mfg_production (
    id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL, work_order_no TEXT NOT NULL DEFAULT '',
    start_date DATE, expected_end_date DATE, actual_end_date DATE,
    qc_status TEXT NOT NULL DEFAULT 'pending', qc_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned', progress_pct INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS mfg_production_order_idx ON mfg_production(order_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS mfg_dispatches (
    id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL,
    dispatch_no TEXT NOT NULL DEFAULT '', dispatch_date DATE,
    courier TEXT NOT NULL DEFAULT '', awb TEXT NOT NULL DEFAULT '',
    invoice_no TEXT NOT NULL DEFAULT '', invoice_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    eway_bill TEXT NOT NULL DEFAULT '', vehicle_no TEXT NOT NULL DEFAULT '',
    received_at DATE, status TEXT NOT NULL DEFAULT 'dispatched',
    notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function install(opts) {
  await _ensureSchema();
  const STATUSES = [
    ['RFQ Received','#3b82f6',1],['Quote Sent','#06b6d4',2],['Negotiation','#a855f7',3],
    ['PO Received','#10b981',4],['In Production','#eab308',5],['QC Done','#84cc16',6],
    ['Dispatched','#22c55e',7],['Delivered','#16a34a',8],['Payment Pending','#f97316',9],
    ['Paid','#059669',10]
  ];
  // PACK_STAGE_TAG_v1 — tag statuses with pack_id for clean industry isolation
  try { await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  try { await db.query(`ALTER TABLE lead_custom_fields ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  // Deactivate any older non-generic pack statuses to keep pipeline clean
  try { await db.query(`UPDATE statuses SET is_active=0 WHERE pack_id IS NOT NULL AND pack_id <> $1`, ['manufacturer']); } catch(_){}
  for (const s of STATUSES) {
    try { await db.query(`INSERT INTO statuses (name,color,sort_order,is_active,pack_id) VALUES ($1,$2,$3,1,'manufacturer') ON CONFLICT (name) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, s); } catch(_){}
  }
  const CFS = [
    ['product_specs','Product Specs','text'],
    ['quantity','Quantity','number'],
    ['material_grade','Material Grade','text'],
    ['delivery_date','Delivery Date','date'],
    ['po_number','PO Number','text'],
    ['hsn_code','HSN Code','text']
  ];
  for (const cf of CFS) {
    try { await db.query(`INSERT INTO lead_custom_fields (field_key,label,field_type,is_active,pack_id) VALUES ($1,$2,$3,1,'manufacturer') ON CONFLICT (field_key) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, cf); } catch(_){}
  }
}
async function uninstall() {}

async function api_mfg_inquiry_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  if (p.id) {
    await db.query(`UPDATE mfg_inquiries SET rfq_no=$1, product_specs=$2, quantity=$3, material_grade=$4, expected_delivery_date=$5, payment_terms=$6, shipping_terms=$7, notes=$8, status=$9 WHERE id=$10`,
      [p.rfq_no||'',p.product_specs||'',p.quantity||0,p.material_grade||'',p.expected_delivery_date||null,p.payment_terms||'',p.shipping_terms||'',p.notes||'',p.status||'received',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO mfg_inquiries (lead_id,rfq_no,product_specs,quantity,material_grade,expected_delivery_date,payment_terms,shipping_terms,notes,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [p.lead_id,p.rfq_no||'',p.product_specs||'',p.quantity||0,p.material_grade||'',p.expected_delivery_date||null,p.payment_terms||'',p.shipping_terms||'',p.notes||'',p.status||'received']);
  return { ok: true, id: r.rows[0].id };
}
async function api_mfg_inquiry_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM mfg_inquiries WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { inquiries: r.rows };
}

async function api_mfg_quote_save(token, payload) {
  const me = await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const items = Array.isArray(p.items) ? p.items : [];
  const subtotal = items.reduce((s, it) => s + Number(it.qty||0) * Number(it.rate||0), 0);
  const gst = subtotal * 0.18;
  const total = subtotal + gst;
  if (p.id) {
    await db.query(`UPDATE mfg_quotes SET inquiry_id=$1, quote_no=$2, items_json=$3, subtotal=$4, gst=$5, total=$6, hsn_code=$7, payment_terms=$8, delivery_terms=$9, valid_till=$10, status=$11, notes=$12 WHERE id=$13`,
      [p.inquiry_id||null,p.quote_no||'',JSON.stringify(items),subtotal,gst,total,p.hsn_code||'',p.payment_terms||'',p.delivery_terms||'',p.valid_till||null,p.status||'draft',p.notes||'',p.id]);
    return { ok: true, id: p.id, total };
  }
  const r = await db.query(`INSERT INTO mfg_quotes (lead_id,inquiry_id,quote_no,items_json,subtotal,gst,total,hsn_code,payment_terms,delivery_terms,valid_till,status,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [p.lead_id,p.inquiry_id||null,p.quote_no||'',JSON.stringify(items),subtotal,gst,total,p.hsn_code||'',p.payment_terms||'',p.delivery_terms||'',p.valid_till||null,p.status||'draft',p.notes||'',me.id]);
  return { ok: true, id: r.rows[0].id, total };
}
async function api_mfg_quote_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM mfg_quotes WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { quotes: r.rows.map(q => ({ ...q, items: (function(){ try { return JSON.parse(q.items_json||'[]'); } catch(_){ return []; }})() })) };
}

async function api_mfg_order_create(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const balance = Number(p.order_value||0) - Number(p.advance_amount||0);
  const r = await db.query(`INSERT INTO mfg_orders (lead_id,quote_id,po_number,po_date,order_value,advance_amount,balance_amount,delivery_date,status,payment_status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.lead_id,p.quote_id||null,p.po_number||'',p.po_date||null,p.order_value||0,p.advance_amount||0,balance,p.delivery_date||null,p.status||'received',p.payment_status||'unpaid',p.notes||'']);
  return { ok: true, id: r.rows[0].id, balance };
}
async function api_mfg_order_update(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('id required');
  const balance = Number(p.order_value||0) - Number(p.advance_amount||0);
  await db.query(`UPDATE mfg_orders SET po_number=$1, po_date=$2, order_value=$3, advance_amount=$4, balance_amount=$5, delivery_date=$6, status=$7, payment_status=$8, notes=$9 WHERE id=$10`,
    [p.po_number||'',p.po_date||null,p.order_value||0,p.advance_amount||0,balance,p.delivery_date||null,p.status||'received',p.payment_status||'unpaid',p.notes||'',p.id]);
  return { ok: true };
}
async function api_mfg_order_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM mfg_orders WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { orders: r.rows };
}

async function api_mfg_production_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.order_id) throw new Error('order_id required');
  if (p.id) {
    await db.query(`UPDATE mfg_production SET work_order_no=$1, start_date=$2, expected_end_date=$3, actual_end_date=$4, qc_status=$5, qc_notes=$6, status=$7, progress_pct=$8, notes=$9 WHERE id=$10`,
      [p.work_order_no||'',p.start_date||null,p.expected_end_date||null,p.actual_end_date||null,p.qc_status||'pending',p.qc_notes||'',p.status||'planned',p.progress_pct||0,p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO mfg_production (order_id,work_order_no,start_date,expected_end_date,actual_end_date,qc_status,qc_notes,status,progress_pct,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [p.order_id,p.work_order_no||'',p.start_date||null,p.expected_end_date||null,p.actual_end_date||null,p.qc_status||'pending',p.qc_notes||'',p.status||'planned',p.progress_pct||0,p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_mfg_production_byOrder(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM mfg_production WHERE order_id=$1 ORDER BY created_at DESC`, [(payload&&payload.order_id)||0]);
  return { production: r.rows };
}

async function api_mfg_dispatch_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.order_id) throw new Error('order_id required');
  if (p.id) {
    await db.query(`UPDATE mfg_dispatches SET dispatch_no=$1, dispatch_date=$2, courier=$3, awb=$4, invoice_no=$5, invoice_amount=$6, eway_bill=$7, vehicle_no=$8, received_at=$9, status=$10, notes=$11 WHERE id=$12`,
      [p.dispatch_no||'',p.dispatch_date||null,p.courier||'',p.awb||'',p.invoice_no||'',p.invoice_amount||0,p.eway_bill||'',p.vehicle_no||'',p.received_at||null,p.status||'dispatched',p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO mfg_dispatches (order_id,dispatch_no,dispatch_date,courier,awb,invoice_no,invoice_amount,eway_bill,vehicle_no,received_at,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [p.order_id,p.dispatch_no||'',p.dispatch_date||null,p.courier||'',p.awb||'',p.invoice_no||'',p.invoice_amount||0,p.eway_bill||'',p.vehicle_no||'',p.received_at||null,p.status||'dispatched',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_mfg_dispatch_byOrder(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM mfg_dispatches WHERE order_id=$1 ORDER BY created_at DESC`, [(payload&&payload.order_id)||0]);
  return { dispatches: r.rows };
}

async function api_mfg_summary(token) {
  await authUser(token); await _ensureSchema();
  const rfq = await db.query(`SELECT COUNT(*)::int AS cnt FROM mfg_inquiries WHERE status='received'`);
  const quoted = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total),0) AS val FROM mfg_quotes WHERE status='sent'`);
  const inProd = await db.query(`SELECT COUNT(*)::int AS cnt FROM mfg_production WHERE status IN ('planned','in_progress')`);
  const dispatched = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(invoice_amount),0) AS val FROM mfg_dispatches WHERE dispatch_date >= CURRENT_DATE - INTERVAL '30 days'`);
  const recv = await db.query(`SELECT COALESCE(SUM(balance_amount),0) AS amt FROM mfg_orders WHERE payment_status NOT IN ('paid','cancelled')`);
  return {
    rfqs_open: rfq.rows[0].cnt,
    quotes_sent: { count: quoted.rows[0].cnt, value: Number(quoted.rows[0].val) },
    in_production: inProd.rows[0].cnt,
    dispatched_30d: { count: dispatched.rows[0].cnt, value: Number(dispatched.rows[0].val) },
    receivables: Number(recv.rows[0].amt)
  };
}

framework.register({
  id: PACK_ID, name: 'Manufacturer', industry: 'manufacturer',
  summary: 'B2B manufacturing — RFQ inbox, quote builder, PO + production, dispatch + receivables.',
  version: '1.0.0',
  features: ['RFQ inbox with product specs','Multi-item quote builder with auto GST','PO + advance + balance tracker','Production work-orders + QC status','Dispatch + invoice + AWB + e-way bill','10 Manufacturer statuses + 6 custom fields seeded'],
  nav_items: [
    { id: 'mfgrfq',        label: '📨 RFQ Inbox', icon: '📨' },
    { id: 'mfgproduction', label: '⚙️ Production', icon: '⚙️' },
    { id: 'mfgdispatch',   label: '🚚 Dispatch', icon: '🚚' },
    { id: 'mfgreceivables',label: '💰 Receivables', icon: '💰' }
  ],
  install, uninstall
});

module.exports = {
  install, uninstall, _ensureSchema,
  api_mfg_inquiry_save, api_mfg_inquiry_byLead,
  api_mfg_quote_save, api_mfg_quote_byLead,
  api_mfg_order_create, api_mfg_order_update, api_mfg_order_byLead,
  api_mfg_production_save, api_mfg_production_byOrder,
  api_mfg_dispatch_save, api_mfg_dispatch_byOrder,
  api_mfg_summary
};
