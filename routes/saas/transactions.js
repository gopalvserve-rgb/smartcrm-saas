'use strict';
/**
 * SAAS_TXN_v1 — platform transactions ledger (tenant payments).
 * Auto entries are written when a signup is provisioned; manual entries are
 * added by the super-admin. Each row keeps the GST split (sale + GST).
 */
const control = require('../../control/db');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

function _split(gstMode, amount) {
  const total = Number(amount) || 0;
  const m = String(gstMode || '').toLowerCase();
  if (m === 'gst' || m === 'with_gst') {
    const sale = Math.round((total / 1.18) * 100) / 100;
    return { gst_mode: 'gst', sale_amount_inr: sale, gst_amount_inr: Math.round((total - sale) * 100) / 100, amount_inr: total };
  }
  return { gst_mode: 'no_gst', sale_amount_inr: total, gst_amount_inr: 0, amount_inr: total };
}

// Called by provisioning (and elsewhere) to auto-record a payment.
async function recordTransaction(row) {
  row = row || {};
  try {
    await control.query(
      `INSERT INTO transactions
         (tenant_id, type, source, amount_inr, sale_amount_inr, gst_amount_inr, gst_mode,
          transaction_mode, transaction_id, txn_date, notes, invoice_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [row.tenant_id || null, row.type || 'auto', row.source || 'signup',
       Number(row.amount_inr) || 0, row.sale_amount_inr != null ? Number(row.sale_amount_inr) : null,
       Number(row.gst_amount_inr) || 0, row.gst_mode || 'no_gst',
       row.transaction_mode || null, row.transaction_id || null, row.txn_date || null,
       row.notes || null, row.invoice_id || null, row.created_by || null]
    );
  } catch (e) { console.warn('[txn] record failed:', e.message); }
}

async function api_saas_txn_list(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  const where = []; const params = [];
  if (f.type)      { params.push(String(f.type)); where.push(`tx.type = $${params.length}`); }
  if (f.tenant_id) { params.push(Number(f.tenant_id)); where.push(`tx.tenant_id = $${params.length}`); }
  if (f.gst_mode)  { params.push(String(f.gst_mode)); where.push(`tx.gst_mode = $${params.length}`); }
  if (f.from)      { params.push(f.from); where.push(`tx.created_at >= $${params.length}`); }
  if (f.to)        { params.push(f.to); where.push(`tx.created_at <= $${params.length}`); }
  if (f.q)         { params.push('%' + String(f.q).toLowerCase() + '%'); where.push(`(LOWER(COALESCE(t.org_name,'')) LIKE $${params.length} OR LOWER(COALESCE(tx.transaction_id,'')) LIKE $${params.length})`); }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const sum = await control.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(tx.amount_inr),0)::numeric AS total,
            COALESCE(SUM(tx.gst_amount_inr),0)::numeric AS gst,
            COALESCE(SUM(tx.sale_amount_inr),0)::numeric AS sale,
            COUNT(*) FILTER (WHERE tx.type='manual')::int AS manual,
            COUNT(*) FILTER (WHERE tx.type='auto')::int   AS auto
       FROM transactions tx LEFT JOIN tenants t ON t.id = tx.tenant_id ${wsql}`, params);

  const page = Math.max(1, Number(f.page) || 1);
  const pageSize = Math.min(200, Math.max(5, Number(f.pageSize) || 25));
  const lp = params.slice(); lp.push(pageSize); lp.push((page - 1) * pageSize);
  const rows = await control.query(
    `SELECT tx.*, t.org_name, t.slug
       FROM transactions tx LEFT JOIN tenants t ON t.id = tx.tenant_id
       ${wsql} ORDER BY tx.created_at DESC LIMIT $${lp.length - 1} OFFSET $${lp.length}`, lp);

  const s = sum.rows[0] || {};
  return {
    rows: rows.rows,
    summary: { count: s.n || 0, total: Number(s.total) || 0, gst: Number(s.gst) || 0, sale: Number(s.sale) || 0, manual: s.manual || 0, auto: s.auto || 0 },
    page, pageSize, total: s.n || 0
  };
}

async function api_saas_txn_create(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  if (!p.tenant_id) throw new Error('Choose a tenant');
  const amt = Number(p.amount_inr);
  if (!(amt > 0)) throw new Error('Enter a valid amount');
  const sp = _split(p.gst_mode, amt);
  const id = await control.insert('transactions', {
    tenant_id: Number(p.tenant_id), type: 'manual', source: 'manual',
    amount_inr: sp.amount_inr, sale_amount_inr: sp.sale_amount_inr, gst_amount_inr: sp.gst_amount_inr, gst_mode: sp.gst_mode,
    transaction_mode: p.transaction_mode || null, transaction_id: p.transaction_id || null,
    txn_date: p.txn_date || null, notes: p.notes || null, created_by: me.id, created_at: new Date().toISOString()
  });
  return { ok: true, id, split: sp };
}

async function api_saas_txn_delete(token, id) {
  await requireFullAdmin(token);
  await control.query(`DELETE FROM transactions WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_saas_txn_backfill(token, opts) {
  await requireFullAdmin(token);
  const o = opts || {};
  const now = new Date();
  const from = o.from ? new Date(o.from) : new Date(now.getFullYear(), now.getMonth(), 1);
  const to   = o.to   ? new Date(o.to)   : new Date(now.getFullYear(), now.getMonth() + 1, 1);
  // One transaction per NON-DEMO tenant created in range that has billing and
  // no existing transaction. Amount from the tenant billing, else its latest
  // invoice. Works regardless of whether the invoice is marked paid.
  const ten = await control.query(
    `SELECT t.id, t.total_amount_inr, t.sale_amount_inr, t.gst_amount_inr,
            t.transaction_mode, t.transaction_id, t.transaction_date, t.created_at,
            (SELECT i.total_inr    FROM invoices i WHERE i.tenant_id = t.id ORDER BY i.created_at DESC LIMIT 1) AS inv_total,
            (SELECT i.tax_inr      FROM invoices i WHERE i.tenant_id = t.id ORDER BY i.created_at DESC LIMIT 1) AS inv_tax,
            (SELECT i.subtotal_inr FROM invoices i WHERE i.tenant_id = t.id ORDER BY i.created_at DESC LIMIT 1) AS inv_sub,
            (SELECT i.id           FROM invoices i WHERE i.tenant_id = t.id ORDER BY i.created_at DESC LIMIT 1) AS inv_id
       FROM tenants t
      WHERE COALESCE(t.tenant_type, 'live') <> 'demo'
        AND t.created_at >= $1 AND t.created_at < $2
        AND t.id NOT IN (SELECT tenant_id FROM transactions WHERE tenant_id IS NOT NULL)
      ORDER BY t.created_at ASC`,
    [from.toISOString(), to.toISOString()]
  );
  let inserted = 0, skipped = 0;
  for (const r of ten.rows) {
    const total = (Number(r.total_amount_inr) > 0) ? Number(r.total_amount_inr) : (Number(r.inv_total) || 0);
    if (!(total > 0)) { skipped++; continue; }
    const gst = (Number(r.gst_amount_inr) > 0) ? Number(r.gst_amount_inr) : (Number(r.inv_tax) || 0);
    const sale = (Number(r.sale_amount_inr) > 0) ? Number(r.sale_amount_inr)
               : (Number(r.inv_sub) > 0 ? Number(r.inv_sub) : Math.max(0, total - gst));
    await recordTransaction({
      tenant_id: r.id, type: 'auto', source: 'backfill',
      amount_inr: total, sale_amount_inr: sale, gst_amount_inr: gst,
      gst_mode: (gst > 0 ? 'gst' : 'no_gst'),
      transaction_mode: r.transaction_mode || null, transaction_id: r.transaction_id || null,
      txn_date: (r.transaction_date || r.created_at) ? String(r.transaction_date || r.created_at).slice(0, 10) : null,
      invoice_id: r.inv_id || null, notes: 'Backfill · signup'
    });
    inserted++;
  }
  return { ok: true, inserted, scanned: ten.rows.length, skipped, from: from.toISOString(), to: to.toISOString() };
}
async function api_saas_txn_update(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const ex = await control.query('SELECT * FROM transactions WHERE id = $1', [Number(p.id)]);
  if (!ex.rows.length) throw new Error('Transaction not found');
  const cur = ex.rows[0];
  const amt = (p.amount_inr != null && p.amount_inr !== '') ? Number(p.amount_inr) : Number(cur.amount_inr);
  const gstMode = p.gst_mode || cur.gst_mode || 'no_gst';
  const sp = _split(gstMode, amt);
  const data = {
    amount_inr: sp.amount_inr, sale_amount_inr: sp.sale_amount_inr, gst_amount_inr: sp.gst_amount_inr, gst_mode: sp.gst_mode,
    transaction_mode: p.transaction_mode !== undefined ? (p.transaction_mode || null) : cur.transaction_mode,
    transaction_id:   p.transaction_id   !== undefined ? (p.transaction_id   || null) : cur.transaction_id,
    txn_date:         p.txn_date          !== undefined ? (p.txn_date          || null) : cur.txn_date,
    notes:            p.notes             !== undefined ? (p.notes             || null) : cur.notes
  };
  if (p.tenant_id) data.tenant_id = Number(p.tenant_id);
  await control.update('transactions', Number(p.id), data);
  return { ok: true, split: sp };
}

module.exports = { recordTransaction, api_saas_txn_list, api_saas_txn_create, api_saas_txn_delete, api_saas_txn_backfill, api_saas_txn_update };
