/**
 * routes/invoicing.js
 *
 * GST Invoicing — tenant-scoped backend. Ported from the single-tenant
 * Google Apps Script "GST Invoice System" reference document.
 *
 * All tables live in the PER-TENANT Postgres DB (migrations/2026_05_23_invoicing.sql
 * + db/schema.sql). Module is OPT-IN per tenant via moduleCatalog.js
 * ("invoicing" key) — when a tenant doesn't have it enabled the API
 * returns 403 from _gateModule().
 *
 * Public api_* surface (auto-loaded by routes/saas/tenantApi.js):
 *
 *   Dashboard
 *     api_invoicing_dashboard(token)
 *
 *   Companies (sellers)
 *     api_invoicing_companies_list(token)
 *     api_invoicing_companies_get(token, id)
 *     api_invoicing_companies_save(token, payload)
 *     api_invoicing_companies_delete(token, id)
 *
 *   Customers
 *     api_invoicing_customers_list(token, q?)
 *     api_invoicing_customers_get(token, id)
 *     api_invoicing_customers_save(token, payload)
 *     api_invoicing_customers_delete(token, id)
 *
 *   Items
 *     api_invoicing_items_list(token, q?)
 *     api_invoicing_items_get(token, id)
 *     api_invoicing_items_save(token, payload)
 *     api_invoicing_items_delete(token, id)
 *
 *   Invoices
 *     api_invoicing_invoices_list(token, opts?)
 *     api_invoicing_invoices_get(token, id)
 *     api_invoicing_invoices_save(token, payload)    -- create + update
 *     api_invoicing_invoices_cancel(token, id)
 *     api_invoicing_invoices_pdf_html(token, id)     -- returns printable HTML
 *
 *   Payments
 *     api_invoicing_payments_add(token, invoice_id, payload)
 *     api_invoicing_payments_list(token, invoice_id)
 *     api_invoicing_payments_delete(token, payment_id)
 *
 *   GSTR-1
 *     api_invoicing_gstr1_preview(token, opts)       -- { company_id, from, to }
 *     api_invoicing_gstr1_csv(token, opts)           -- returns { sheets: {name: csv} }
 *
 *   Settings
 *     api_invoicing_settings_get(token)
 *     api_invoicing_settings_save(token, payload)
 */

'use strict';

const db        = require('../db/pg');
const control   = require('../control/db');
const { authUser } = require('../utils/auth');
const { resolveModules } = require('../utils/moduleCatalog');

// =====================================================================
// Module gate — fail closed if super-admin has not enabled invoicing
// =====================================================================
async function _gateModule() {
  let slug = '';
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    slug = (store && store.slug) || '';
  } catch (_) {}
  if (!slug) return; // single-tenant deploys: don't gate
  try {
    const r = await control.query(
      `SELECT id, slug, modules_json FROM tenants WHERE slug = $1`, [slug]
    );
    const row = r.rows[0];
    const active = resolveModules(row || {});
    if (!active.includes('invoicing')) {
      const err = new Error('Invoicing module is not enabled for this workspace. Contact your administrator to opt in.');
      err.status = 403;
      throw err;
    }
  } catch (e) {
    // Control DB unreachable — fail open in single-tenant context, fail
    // closed if we already raised the 403 above.
    if (e && e.status === 403) throw e;
  }
}

// Cache table-ensure per pool so we don't run CREATE TABLE on every call.
const _ensuredPools = new WeakSet();
async function _ensureTables() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _ensuredPools.has(pool)) return;
  // Trigger lazy schema bootstrap by running a no-op SELECT against
  // each table; if it fails, run the migration inline.
  try {
    await db.query(`SELECT 1 FROM inv_companies LIMIT 1`);
  } catch (_) {
    await _runInlineMigration();
  }
  if (pool) _ensuredPools.add(pool);
}

async function _runInlineMigration() {
  const fs = require('fs');
  const path = require('path');
  const sqlPath = path.join(__dirname, '..', 'migrations', '2026_05_23_invoicing.sql');
  if (!fs.existsSync(sqlPath)) return;
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await db.query(sql);
}

// Auth wrapper: gate + auth + table-ensure
async function _ctx(token, opts) {
  opts = opts || {};
  if (opts.gate !== false) await _gateModule();
  await _ensureTables();
  const user = await authUser(token);
  return { user };
}

// =====================================================================
// Helpers
// =====================================================================
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : (d || 0); }
function s(v) { return v == null ? '' : String(v); }
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function pad(n, w) { return String(n).padStart(w || 6, '0'); }

function _validGstin(g) {
  if (!g) return true; // optional
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[A-Z0-9]{1}Z[A-Z0-9]{1}$/i.test(String(g).trim());
}
function _gstStateCode(gstin) {
  if (!gstin) return null;
  const m = /^([0-9]{2})/.exec(String(gstin).trim());
  return m ? m[1] : null;
}

// Compute tax for one line given seller/customer states.
function _taxLine(line, sellerState, customerState) {
  const qty   = num(line.qty, 0);
  const rate  = num(line.rate, 0);
  const disc  = num(line.discount_pct, 0);
  const gross = qty * rate;
  const taxable = round2(gross - (gross * disc / 100));
  const gstPct = num(line.gst_pct, 0);
  let cgst = 0, sgst = 0, igst = 0;
  const sameState = sellerState && customerState &&
    s(sellerState).trim().toLowerCase() === s(customerState).trim().toLowerCase();
  if (sameState) {
    cgst = round2(taxable * gstPct / 200);
    sgst = round2(taxable * gstPct / 200);
  } else {
    igst = round2(taxable * gstPct / 100);
  }
  const total = round2(taxable + cgst + sgst + igst);
  return Object.assign({}, line, {
    qty, rate, discount_pct: disc, gst_pct: gstPct,
    taxable_value: taxable, cgst, sgst, igst, line_total: total
  });
}

function _amountInWords(n) {
  // Simple Indian-numbering words. Good enough for invoices; replace
  // with a battle-tested lib if you need legal precision.
  n = Math.round(num(n, 0) * 100) / 100;
  const rupees = Math.floor(n);
  const paise = Math.round((n - rupees) * 100);
  const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
    'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function inWords(num) {
    if (num < 20) return a[num];
    if (num < 100) return b[Math.floor(num/10)] + (num%10 ? ' ' + a[num%10] : '');
    if (num < 1000) return a[Math.floor(num/100)] + ' Hundred' + (num%100 ? ' ' + inWords(num%100) : '');
    if (num < 100000) return inWords(Math.floor(num/1000)) + ' Thousand' + (num%1000 ? ' ' + inWords(num%1000) : '');
    if (num < 10000000) return inWords(Math.floor(num/100000)) + ' Lakh' + (num%100000 ? ' ' + inWords(num%100000) : '');
    return inWords(Math.floor(num/10000000)) + ' Crore' + (num%10000000 ? ' ' + inWords(num%10000000) : '');
  }
  let txt = 'Rupees ' + (rupees ? inWords(rupees) : 'Zero');
  if (paise) txt += ' and ' + inWords(paise) + ' Paise';
  return txt + ' Only';
}

// =====================================================================
// Dashboard
// =====================================================================
async function api_invoicing_dashboard(token) {
  await _ctx(token);
  const totals = await db.query(`
    SELECT
      COALESCE(COUNT(*) FILTER (WHERE status <> 'cancelled'), 0)         AS invoice_count,
      COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0)        AS total_sales,
      COALESCE(SUM(cgst + sgst + igst + cess) FILTER (WHERE status <> 'cancelled'), 0) AS gst_collected,
      COALESCE(SUM(amount_paid) FILTER (WHERE status <> 'cancelled'), 0)  AS received
    FROM invoices_inv
  `);
  const t = totals.rows[0] || {};
  const sales    = num(t.total_sales, 0);
  const received = num(t.received, 0);
  const recent = await db.query(`
    SELECT id, invoice_no, invoice_date, customer_name, total, paid_status, status
    FROM invoices_inv
    WHERE status <> 'cancelled'
    ORDER BY id DESC LIMIT 10
  `);
  return {
    invoice_count: num(t.invoice_count, 0),
    total_sales:   round2(sales),
    gst_collected: round2(num(t.gst_collected, 0)),
    received:      round2(received),
    pending:       round2(sales - received),
    recent:        recent.rows
  };
}

// =====================================================================
// Companies
// =====================================================================
async function api_invoicing_companies_list(token) {
  await _ctx(token);
  const r = await db.query(`
    SELECT * FROM inv_companies ORDER BY is_default DESC, name ASC
  `);
  return r.rows;
}
async function api_invoicing_companies_get(token, id) {
  await _ctx(token);
  const r = await db.query(`SELECT * FROM inv_companies WHERE id=$1`, [Number(id)]);
  if (!r.rows.length) throw new Error('Company not found');
  return r.rows[0];
}
async function api_invoicing_companies_save(token, payload) {
  await _ctx(token);
  payload = payload || {};
  if (!s(payload.name).trim()) throw new Error('Company name is required');
  if (payload.gstin && !_validGstin(payload.gstin))
    throw new Error('GSTIN looks invalid');
  const fields = ['name','legal_name','gstin','pan','state','state_code','address','city',
    'pincode','phone','email','website','upi_id','bank_name','bank_account','bank_ifsc',
    'bank_branch','logo_url','signature_url','prefix','next_no','no_padding','default_terms',
    'default_notes','is_active','is_default'];
  const data = {};
  fields.forEach(f => { if (payload[f] !== undefined) data[f] = payload[f]; });
  if (data.gstin && !data.state_code) data.state_code = _gstStateCode(data.gstin);

  if (payload.id) {
    const id = Number(payload.id);
    const sets = []; const vals = []; let i = 1;
    Object.keys(data).forEach(k => { sets.push(`${k} = $${i++}`); vals.push(data[k]); });
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const r = await db.query(`UPDATE inv_companies SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    if (data.is_default) await db.query(`UPDATE inv_companies SET is_default=0 WHERE id <> $1`, [id]);
    return r.rows[0];
  }
  const cols = Object.keys(data); const vals = Object.values(data);
  const phs  = cols.map((_, i) => `$${i+1}`);
  const r = await db.query(
    `INSERT INTO inv_companies (${cols.join(',')}) VALUES (${phs.join(',')}) RETURNING *`,
    vals
  );
  if (data.is_default) await db.query(`UPDATE inv_companies SET is_default=0 WHERE id <> $1`, [r.rows[0].id]);
  return r.rows[0];
}
async function api_invoicing_companies_delete(token, id) {
  await _ctx(token);
  // Soft-delete to preserve invoice history
  await db.query(`UPDATE inv_companies SET is_active=0, updated_at=NOW() WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

// =====================================================================
// Customers
// =====================================================================
async function api_invoicing_customers_list(token, q) {
  await _ctx(token);
  if (q) {
    const r = await db.query(
      `SELECT * FROM inv_customers WHERE is_active=1 AND (LOWER(name) LIKE $1 OR phone LIKE $1 OR LOWER(email) LIKE $1 OR LOWER(COALESCE(gstin,'')) LIKE $1) ORDER BY name LIMIT 200`,
      [`%${String(q).toLowerCase()}%`]
    );
    return r.rows;
  }
  const r = await db.query(`SELECT * FROM inv_customers WHERE is_active=1 ORDER BY name LIMIT 500`);
  return r.rows;
}
async function api_invoicing_customers_get(token, id) {
  await _ctx(token);
  const r = await db.query(`SELECT * FROM inv_customers WHERE id=$1`, [Number(id)]);
  if (!r.rows.length) throw new Error('Customer not found');
  return r.rows[0];
}
async function api_invoicing_customers_save(token, payload) {
  await _ctx(token);
  payload = payload || {};
  if (!s(payload.name).trim()) throw new Error('Customer name is required');
  if (payload.gstin && !_validGstin(payload.gstin))
    throw new Error('GSTIN looks invalid');
  const fields = ['name','legal_name','gstin','customer_type','state','state_code',
    'place_of_supply','country','billing_address','shipping_address','city','pincode',
    'phone','email','notes','is_active'];
  const data = {};
  fields.forEach(f => { if (payload[f] !== undefined) data[f] = payload[f]; });
  if (data.gstin && !data.state_code) data.state_code = _gstStateCode(data.gstin);
  if (!data.customer_type) data.customer_type = data.gstin ? 'B2B' : 'B2C';

  if (payload.id) {
    const id = Number(payload.id);
    const sets = []; const vals = []; let i = 1;
    Object.keys(data).forEach(k => { sets.push(`${k} = $${i++}`); vals.push(data[k]); });
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const r = await db.query(`UPDATE inv_customers SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return r.rows[0];
  }
  const cols = Object.keys(data); const vals = Object.values(data);
  const phs  = cols.map((_, i) => `$${i+1}`);
  const r = await db.query(
    `INSERT INTO inv_customers (${cols.join(',')}) VALUES (${phs.join(',')}) RETURNING *`,
    vals
  );
  return r.rows[0];
}
async function api_invoicing_customers_delete(token, id) {
  await _ctx(token);
  await db.query(`UPDATE inv_customers SET is_active=0, updated_at=NOW() WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

// =====================================================================
// Items
// =====================================================================
async function api_invoicing_items_list(token, q) {
  await _ctx(token);
  if (q) {
    const r = await db.query(
      `SELECT * FROM inv_items WHERE is_active=1 AND (LOWER(name) LIKE $1 OR LOWER(COALESCE(hsn_sac,'')) LIKE $1) ORDER BY name LIMIT 200`,
      [`%${String(q).toLowerCase()}%`]
    );
    return r.rows;
  }
  const r = await db.query(`SELECT * FROM inv_items WHERE is_active=1 ORDER BY name LIMIT 500`);
  return r.rows;
}
async function api_invoicing_items_get(token, id) {
  await _ctx(token);
  const r = await db.query(`SELECT * FROM inv_items WHERE id=$1`, [Number(id)]);
  if (!r.rows.length) throw new Error('Item not found');
  return r.rows[0];
}
async function api_invoicing_items_save(token, payload) {
  await _ctx(token);
  payload = payload || {};
  if (!s(payload.name).trim()) throw new Error('Item name is required');
  const fields = ['name','description','hsn_sac','unit','rate','gst_pct','is_service','is_active'];
  const data = {};
  fields.forEach(f => { if (payload[f] !== undefined) data[f] = payload[f]; });
  if (payload.id) {
    const id = Number(payload.id);
    const sets = []; const vals = []; let i = 1;
    Object.keys(data).forEach(k => { sets.push(`${k} = $${i++}`); vals.push(data[k]); });
    sets.push(`updated_at = NOW()`);
    vals.push(id);
    const r = await db.query(`UPDATE inv_items SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
    return r.rows[0];
  }
  const cols = Object.keys(data); const vals = Object.values(data);
  const phs  = cols.map((_, i) => `$${i+1}`);
  const r = await db.query(
    `INSERT INTO inv_items (${cols.join(',')}) VALUES (${phs.join(',')}) RETURNING *`, vals
  );
  return r.rows[0];
}
async function api_invoicing_items_delete(token, id) {
  await _ctx(token);
  await db.query(`UPDATE inv_items SET is_active=0, updated_at=NOW() WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

// =====================================================================
// Invoices
// =====================================================================
async function api_invoicing_invoices_list(token, opts) {
  await _ctx(token);
  opts = opts || {};
  const wh = []; const vals = []; let i = 1;
  if (opts.company_id)  { wh.push(`company_id  = $${i++}`); vals.push(Number(opts.company_id)); }
  if (opts.customer_id) { wh.push(`customer_id = $${i++}`); vals.push(Number(opts.customer_id)); }
  if (opts.status)      { wh.push(`status      = $${i++}`); vals.push(String(opts.status)); }
  if (opts.paid_status) { wh.push(`paid_status = $${i++}`); vals.push(String(opts.paid_status)); }
  if (opts.from)        { wh.push(`invoice_date >= $${i++}`); vals.push(opts.from); }
  if (opts.to)          { wh.push(`invoice_date <= $${i++}`); vals.push(opts.to); }
  if (opts.q) {
    wh.push(`(invoice_no ILIKE $${i} OR customer_name ILIKE $${i})`);
    vals.push(`%${opts.q}%`); i++;
  }
  const where = wh.length ? ('WHERE ' + wh.join(' AND ')) : '';
  const limit = Math.min(Number(opts.limit) || 200, 1000);
  const r = await db.query(
    `SELECT id, invoice_no, invoice_date, company_id, company_name,
            customer_id, customer_name, total, amount_paid, paid_status, status
       FROM invoices_inv ${where}
       ORDER BY invoice_date DESC, id DESC
       LIMIT ${limit}`,
    vals
  );
  return r.rows;
}

async function api_invoicing_invoices_get(token, id) {
  await _ctx(token);
  const h = await db.query(`SELECT * FROM invoices_inv WHERE id=$1`, [Number(id)]);
  if (!h.rows.length) throw new Error('Invoice not found');
  const l = await db.query(`SELECT * FROM invoice_lines_inv WHERE invoice_id=$1 ORDER BY line_no`, [Number(id)]);
  const p = await db.query(`SELECT * FROM invoice_payments_inv WHERE invoice_id=$1 ORDER BY pay_date DESC, id DESC`, [Number(id)]);
  return Object.assign({}, h.rows[0], { lines: l.rows, payments: p.rows });
}

/**
 * Atomic invoice-number allocator. Uses SELECT ... FOR UPDATE in a
 * transaction so two concurrent saves can never grab the same next_no.
 */
async function _allocateInvoiceNumber(client, companyId) {
  const c = await client.query(
    `SELECT id, prefix, next_no, no_padding FROM inv_companies WHERE id=$1 FOR UPDATE`,
    [companyId]
  );
  if (!c.rows.length) throw new Error('Seller company not found');
  const row = c.rows[0];
  const num = Number(row.next_no) || 1;
  const inv = String(row.prefix || 'INV') + pad(num, Number(row.no_padding) || 6);
  await client.query(`UPDATE inv_companies SET next_no = next_no + 1, updated_at = NOW() WHERE id=$1`, [companyId]);
  return inv;
}

async function api_invoicing_invoices_save(token, payload) {
  const { user } = await _ctx(token);
  payload = payload || {};
  if (!payload.company_id) throw new Error('Seller company is required');

  // Snapshot seller / customer
  const company = (await db.query(`SELECT * FROM inv_companies WHERE id=$1`, [Number(payload.company_id)])).rows[0];
  if (!company) throw new Error('Seller company not found');
  const settings = (await db.query(`SELECT default_terms, default_notes FROM inv_settings WHERE id=1`)).rows[0] || {};
  let customer = null;
  if (payload.customer_id) {
    customer = (await db.query(`SELECT * FROM inv_customers WHERE id=$1`, [Number(payload.customer_id)])).rows[0];
  }
  const customerName  = s(payload.customer_name || (customer && customer.name) || '').trim();
  if (!customerName) throw new Error('Customer name is required');
  const customerState = s(payload.customer_state || (customer && customer.state) || '');
  const sellerState   = s(company.state || '');

  // Recompute every line server-side (never trust client totals)
  const rawLines = Array.isArray(payload.lines) ? payload.lines : [];
  if (!rawLines.length) throw new Error('At least one line item is required');
  const lines = rawLines.map((ln, idx) => {
    const t = _taxLine({
      item_id: ln.item_id || null,
      description: s(ln.description || ''),
      hsn_sac: s(ln.hsn_sac || ''),
      unit: s(ln.unit || 'PCS'),
      qty: ln.qty, rate: ln.rate,
      discount_pct: ln.discount_pct, gst_pct: ln.gst_pct
    }, sellerState, customerState);
    t.line_no = idx + 1;
    if (!t.description) throw new Error(`Line ${idx+1}: description is required`);
    return t;
  });
  const subtotal = round2(lines.reduce((a, l) => a + l.taxable_value, 0));
  const cgst     = round2(lines.reduce((a, l) => a + l.cgst, 0));
  const sgst     = round2(lines.reduce((a, l) => a + l.sgst, 0));
  const igst     = round2(lines.reduce((a, l) => a + l.igst, 0));
  const cess     = round2(lines.reduce((a, l) => a + (l.cess || 0), 0));
  const discount = round2(num(payload.discount, 0));
  const grossTotal = subtotal + cgst + sgst + igst + cess - discount;
  const rounded = Math.round(grossTotal);
  const roundOff = round2(rounded - grossTotal);
  const total = round2(rounded);

  // Pull a tx client
  let store = null;
  try { store = db.tenantStorage.getStore(); } catch (_) {}
  const pool = store && store.pool;
  if (!pool) throw new Error('Tenant pool unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let invoiceNo;
    let id = payload.id ? Number(payload.id) : 0;

    if (id) {
      // UPDATE existing — keep invoice_no, replace lines
      const existing = (await client.query(`SELECT invoice_no FROM invoices_inv WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!existing) throw new Error('Invoice not found');
      invoiceNo = existing.invoice_no;
      await client.query(`DELETE FROM invoice_lines_inv WHERE invoice_id=$1`, [id]);
    } else {
      // INSERT new — allocate number atomically
      const status = (payload.status === 'draft') ? 'draft' : 'finalized';
      invoiceNo = (status === 'draft')
        ? 'DRAFT-' + Date.now().toString(36).toUpperCase()
        : await _allocateInvoiceNumber(client, Number(payload.company_id));
      const ins = await client.query(`
        INSERT INTO invoices_inv (
          invoice_no, invoice_date, due_date, company_id, customer_id,
          customer_name, customer_gstin, customer_state, customer_state_code,
          bill_to_address, ship_to_address, place_of_supply,
          company_name, company_gstin, company_state,
          subtotal, discount, cgst, sgst, igst, cess, round_off, total, amount_in_words,
          status, paid_status, amount_paid, notes, terms, is_reverse_charge, created_by
        ) VALUES (
          $1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12, $13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,$24, $25,$26,$27,$28,$29,$30,$31
        ) RETURNING id
      `, [
        invoiceNo, payload.invoice_date || new Date().toISOString().slice(0,10), payload.due_date || null,
        Number(payload.company_id), payload.customer_id ? Number(payload.customer_id) : null,
        customerName,
        s(payload.customer_gstin || (customer && customer.gstin) || ''),
        customerState,
        s(payload.customer_state_code || (customer && customer.state_code) || _gstStateCode(payload.customer_gstin || (customer && customer.gstin))),
        s(payload.bill_to_address || (customer && customer.billing_address) || ''),
        s(payload.ship_to_address || (customer && customer.shipping_address) || ''),
        s(payload.place_of_supply || customerState),
        s(company.name), s(company.gstin), s(company.state),
        subtotal, discount, cgst, sgst, igst, cess, roundOff, total, _amountInWords(total),
        status, 'unpaid', 0,
        s(payload.notes || company.default_notes || settings.default_notes || ''),
        s(payload.terms || company.default_terms || settings.default_terms || ''),
        payload.is_reverse_charge ? 1 : 0,
        user.id
      ]);
      id = ins.rows[0].id;
    }

    if (payload.id) {
      // UPDATE header
      await client.query(`
        UPDATE invoices_inv SET
          invoice_date=$1, due_date=$2,
          customer_id=$3, customer_name=$4, customer_gstin=$5,
          customer_state=$6, customer_state_code=$7,
          bill_to_address=$8, ship_to_address=$9, place_of_supply=$10,
          subtotal=$11, discount=$12, cgst=$13, sgst=$14, igst=$15, cess=$16,
          round_off=$17, total=$18, amount_in_words=$19,
          notes=$20, terms=$21, is_reverse_charge=$22, updated_at=NOW()
        WHERE id=$23
      `, [
        payload.invoice_date || new Date().toISOString().slice(0,10), payload.due_date || null,
        payload.customer_id ? Number(payload.customer_id) : null,
        customerName,
        s(payload.customer_gstin || (customer && customer.gstin) || ''),
        customerState,
        s(payload.customer_state_code || (customer && customer.state_code) || ''),
        s(payload.bill_to_address || ''), s(payload.ship_to_address || ''),
        s(payload.place_of_supply || customerState),
        subtotal, discount, cgst, sgst, igst, cess, roundOff, total, _amountInWords(total),
        s(payload.notes || ''), s(payload.terms || ''),
        payload.is_reverse_charge ? 1 : 0,
        id
      ]);
    }

    // Insert lines
    for (const ln of lines) {
      await client.query(`
        INSERT INTO invoice_lines_inv
          (invoice_id, line_no, item_id, description, hsn_sac, unit,
           qty, rate, discount_pct, gst_pct,
           taxable_value, cgst, sgst, igst, cess, line_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        id, ln.line_no, ln.item_id || null, ln.description, ln.hsn_sac || null, ln.unit || null,
        ln.qty, ln.rate, ln.discount_pct, ln.gst_pct,
        ln.taxable_value, ln.cgst, ln.sgst, ln.igst, ln.cess || 0, ln.line_total
      ]);
    }

    await client.query(
      `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [user.id, user.email, payload.id ? 'invoice.update' : 'invoice.create',
       'invoice', id, JSON.stringify({ invoice_no: invoiceNo, total })]
    );

    await client.query('COMMIT');
    return { id, invoice_no: invoiceNo, total, subtotal, cgst, sgst, igst, cess, round_off: roundOff };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function api_invoicing_invoices_cancel(token, id) {
  const { user } = await _ctx(token);
  const r = await db.query(
    `UPDATE invoices_inv SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
     WHERE id=$1 RETURNING id, invoice_no, total`, [Number(id)]
  );
  if (!r.rows.length) throw new Error('Invoice not found');
  await db.query(
    `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
     VALUES ($1,$2,'invoice.cancel','invoice',$3,$4)`,
    [user.id, user.email, Number(id), JSON.stringify(r.rows[0])]
  );
  return { ok: true };
}

async function api_invoicing_invoices_pdf_html(token, id) {
  await _ctx(token);
  const inv = await api_invoicing_invoices_get(token, id);
  const company = (await db.query(`SELECT * FROM inv_companies WHERE id=$1`, [inv.company_id])).rows[0] || {};
  const settings = (await db.query(`SELECT * FROM inv_settings WHERE id=1`)).rows[0] || {};
  const cur = settings.currency_symbol || '₹';

  function fmt(n) {
    return cur + ' ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function dt(d) { if (!d) return ''; const x = new Date(d); return x.toLocaleDateString('en-IN'); }

  const sameState = inv.company_state && inv.customer_state &&
    String(inv.company_state).trim().toLowerCase() === String(inv.customer_state).trim().toLowerCase();

  const linesHtml = (inv.lines || []).map((ln, i) => `
    <tr>
      <td style="text-align:center">${i+1}</td>
      <td>${esc(ln.description)}${ln.hsn_sac ? `<div style="font-size:11px;color:#666">HSN/SAC: ${esc(ln.hsn_sac)}</div>` : ''}</td>
      <td style="text-align:right">${Number(ln.qty).toFixed(2)} ${esc(ln.unit||'')}</td>
      <td style="text-align:right">${fmt(ln.rate)}</td>
      <td style="text-align:right">${fmt(ln.taxable_value)}</td>
      <td style="text-align:right">${Number(ln.gst_pct).toFixed(2)}%</td>
      <td style="text-align:right">${fmt(ln.line_total)}</td>
    </tr>
  `).join('');

  const taxBlock = sameState
    ? `<tr><td>CGST</td><td style="text-align:right">${fmt(inv.cgst)}</td></tr>
       <tr><td>SGST</td><td style="text-align:right">${fmt(inv.sgst)}</td></tr>`
    : `<tr><td>IGST</td><td style="text-align:right">${fmt(inv.igst)}</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>${esc(inv.invoice_no)}</title>
<style>
  body { font-family: 'Helvetica', Arial, sans-serif; color:#111; margin:0; padding:24px; font-size:13px; }
  .hdr { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1e293b; padding-bottom:12px; }
  .seller h1 { margin:0; font-size:18px; }
  .seller div { font-size:12px; color:#444; line-height:1.4; }
  .title-block { text-align:right; }
  .title-block h2 { margin:0; font-size:22px; color:#1e293b; letter-spacing:1px; }
  .meta { font-size:12px; color:#444; }
  .pair { display:flex; gap:24px; margin-top:16px; }
  .pair > div { flex:1; }
  .pair h4 { margin:0 0 6px 0; font-size:11px; color:#666; text-transform:uppercase; letter-spacing:.6px; }
  table.lines { width:100%; border-collapse:collapse; margin-top:16px; }
  table.lines th, table.lines td { border:1px solid #e2e8f0; padding:6px 8px; vertical-align:top; }
  table.lines th { background:#f1f5f9; font-size:11px; text-transform:uppercase; letter-spacing:.4px; color:#475569; text-align:left; }
  .tot { width:300px; margin-left:auto; margin-top:12px; border-collapse:collapse; }
  .tot td { padding:5px 8px; border-bottom:1px solid #f1f5f9; font-size:13px; }
  .tot tr.grand td { font-weight:bold; font-size:15px; border-top:2px solid #1e293b; border-bottom:none; padding-top:8px; }
  .footer { margin-top:24px; padding-top:12px; border-top:1px solid #e2e8f0; font-size:12px; color:#555; }
  .badge { display:inline-block; padding:2px 10px; border-radius:10px; font-size:11px; font-weight:600; }
  .badge.cancelled { background:#fee2e2; color:#b91c1c; }
  .badge.draft { background:#fef3c7; color:#92400e; }
  .words { margin-top:10px; font-style:italic; color:#475569; }
</style>
</head><body>
  <div class="hdr">
    <div class="seller">
      ${company.logo_url ? `<img src="${esc(company.logo_url)}" style="max-height:60px;margin-bottom:6px"/>` : ''}
      <h1>${esc(inv.company_name)}</h1>
      <div>${esc(company.address || '')}${company.city ? ', ' + esc(company.city) : ''}${company.pincode ? ' ' + esc(company.pincode) : ''}</div>
      <div>${company.phone ? 'Ph: ' + esc(company.phone) : ''}${company.email ? '  •  ' + esc(company.email) : ''}</div>
      <div>${inv.company_gstin ? '<b>GSTIN:</b> ' + esc(inv.company_gstin) : ''}${company.state ? '  •  State: ' + esc(company.state) : ''}</div>
    </div>
    <div class="title-block">
      <h2>TAX INVOICE</h2>
      <div class="meta"><b>${esc(inv.invoice_no)}</b></div>
      <div class="meta">Date: ${dt(inv.invoice_date)}</div>
      ${inv.due_date ? `<div class="meta">Due: ${dt(inv.due_date)}</div>` : ''}
      ${inv.status === 'cancelled' ? '<div><span class="badge cancelled">CANCELLED</span></div>' : ''}
      ${inv.status === 'draft' ? '<div><span class="badge draft">DRAFT</span></div>' : ''}
    </div>
  </div>

  <div class="pair">
    <div>
      <h4>Bill To</h4>
      <div><b>${esc(inv.customer_name)}</b></div>
      <div>${esc(inv.bill_to_address || '')}</div>
      <div>${inv.customer_gstin ? '<b>GSTIN:</b> ' + esc(inv.customer_gstin) : ''}</div>
      <div>${inv.customer_state ? 'State: ' + esc(inv.customer_state) : ''}</div>
    </div>
    <div>
      <h4>Ship To</h4>
      <div>${esc(inv.ship_to_address || inv.bill_to_address || '')}</div>
      <div>${inv.place_of_supply ? 'Place of Supply: ' + esc(inv.place_of_supply) : ''}</div>
    </div>
  </div>

  <table class="lines">
    <thead><tr>
      <th style="width:30px">#</th>
      <th>Description</th>
      <th style="text-align:right;width:80px">Qty</th>
      <th style="text-align:right;width:90px">Rate</th>
      <th style="text-align:right;width:90px">Taxable</th>
      <th style="text-align:right;width:60px">GST%</th>
      <th style="text-align:right;width:100px">Amount</th>
    </tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <table class="tot">
    <tr><td>Subtotal</td><td style="text-align:right">${fmt(inv.subtotal)}</td></tr>
    ${Number(inv.discount) ? `<tr><td>Discount</td><td style="text-align:right">- ${fmt(inv.discount)}</td></tr>` : ''}
    ${taxBlock}
    ${Number(inv.cess) ? `<tr><td>Cess</td><td style="text-align:right">${fmt(inv.cess)}</td></tr>` : ''}
    ${Number(inv.round_off) ? `<tr><td>Round Off</td><td style="text-align:right">${fmt(inv.round_off)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td style="text-align:right">${fmt(inv.total)}</td></tr>
    ${Number(inv.amount_paid) ? `<tr><td>Paid</td><td style="text-align:right">${fmt(inv.amount_paid)}</td></tr>
                                  <tr><td>Balance</td><td style="text-align:right">${fmt(Number(inv.total) - Number(inv.amount_paid))}</td></tr>` : ''}
  </table>

  <div class="words"><b>Amount in words:</b> ${esc(inv.amount_in_words || _amountInWords(inv.total))}</div>

  <div class="footer">
    ${inv.notes ? `<div><b>Notes:</b> ${esc(inv.notes)}</div>` : ''}
    ${inv.terms ? `<div style="margin-top:6px"><b>Terms & Conditions:</b><br/>${esc(inv.terms).replace(/\n/g,'<br/>')}</div>` : ''}
    ${company.upi_id ? `<div style="margin-top:8px"><b>Pay via UPI:</b> ${esc(company.upi_id)}</div>` : ''}
    ${company.bank_account ? `<div style="margin-top:4px"><b>Bank:</b> ${esc(company.bank_name||'')} • A/c ${esc(company.bank_account)} • IFSC ${esc(company.bank_ifsc||'')}</div>` : ''}
    ${settings.invoice_footer ? `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #cbd5e1;font-size:11px;color:#475569;text-align:center">${esc(settings.invoice_footer)}</div>` : ''}
    <div style="margin-top:14px;text-align:right">For <b>${esc(inv.company_name)}</b><br/><br/><br/>Authorised Signatory</div>
  </div>
</body></html>`;
  return { html, invoice_no: inv.invoice_no };
}

// =====================================================================
// Payments
// =====================================================================
async function api_invoicing_payments_list(token, invoiceId) {
  await _ctx(token);
  const r = await db.query(`SELECT * FROM invoice_payments_inv WHERE invoice_id=$1 ORDER BY pay_date DESC, id DESC`, [Number(invoiceId)]);
  return r.rows;
}

async function _recomputePaid(invoiceId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS paid FROM invoice_payments_inv WHERE invoice_id=$1`,
    [invoiceId]
  );
  const paid = round2(num(r.rows[0].paid, 0));
  const inv = (await db.query(`SELECT total FROM invoices_inv WHERE id=$1`, [invoiceId])).rows[0] || {};
  const total = round2(num(inv.total, 0));
  let status = 'unpaid';
  if (paid >= total - 0.01) status = 'paid';
  else if (paid > 0) status = 'partial';
  await db.query(
    `UPDATE invoices_inv SET amount_paid=$1, paid_status=$2, updated_at=NOW() WHERE id=$3`,
    [paid, status, invoiceId]
  );
  return { amount_paid: paid, paid_status: status };
}

async function api_invoicing_payments_add(token, invoiceId, payload) {
  const { user } = await _ctx(token);
  payload = payload || {};
  const amount = round2(num(payload.amount, 0));
  if (!(amount > 0)) throw new Error('Amount must be greater than zero');
  const r = await db.query(`
    INSERT INTO invoice_payments_inv (invoice_id, pay_date, amount, mode, reference, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [
    Number(invoiceId), payload.pay_date || new Date().toISOString().slice(0,10),
    amount, s(payload.mode || 'UPI'), s(payload.reference || ''), s(payload.notes || ''),
    user.id
  ]);
  const status = await _recomputePaid(Number(invoiceId));
  await db.query(
    `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
     VALUES ($1,$2,'payment.add','payment',$3,$4)`,
    [user.id, user.email, r.rows[0].id, JSON.stringify({ invoice_id: invoiceId, amount })]
  );
  return Object.assign({}, r.rows[0], status);
}

async function api_invoicing_payments_delete(token, paymentId) {
  const { user } = await _ctx(token);
  const r = await db.query(`SELECT invoice_id FROM invoice_payments_inv WHERE id=$1`, [Number(paymentId)]);
  if (!r.rows.length) throw new Error('Payment not found');
  await db.query(`DELETE FROM invoice_payments_inv WHERE id=$1`, [Number(paymentId)]);
  const status = await _recomputePaid(Number(r.rows[0].invoice_id));
  await db.query(
    `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
     VALUES ($1,$2,'payment.delete','payment',$3,$4)`,
    [user.id, user.email, Number(paymentId), JSON.stringify(status)]
  );
  return { ok: true };
}

// =====================================================================
// GSTR-1 export (preview + CSV-sheets bundle)
// =====================================================================
async function _gstr1Data(companyId, from, to) {
  const rows = await db.query(`
    SELECT i.*, COALESCE(SUM(l.taxable_value),0) AS lines_taxable
    FROM invoices_inv i
    LEFT JOIN invoice_lines_inv l ON l.invoice_id = i.id
    WHERE i.company_id = $1
      AND i.invoice_date >= $2
      AND i.invoice_date <= $3
    GROUP BY i.id
    ORDER BY i.invoice_date, i.id
  `, [Number(companyId), from, to]);
  const lines = await db.query(`
    SELECT l.*, i.id AS invoice_id, i.invoice_no, i.invoice_date, i.customer_gstin,
           i.customer_state, i.place_of_supply, i.status
    FROM invoice_lines_inv l
    JOIN invoices_inv i ON i.id = l.invoice_id
    WHERE i.company_id = $1 AND i.invoice_date BETWEEN $2 AND $3 AND i.status <> 'cancelled'
    ORDER BY i.invoice_date, i.id, l.line_no
  `, [Number(companyId), from, to]);

  const settings = (await db.query(`SELECT * FROM inv_settings WHERE id=1`)).rows[0] || {};
  const b2cl_threshold = num(settings.b2cl_threshold, 250000);

  const b2b = [];      // GSTIN, name, invoice, date, value, place_of_supply, reverse_charge, type, rate, taxable, cgst, sgst, igst
  const b2cl = [];     // invoice, date, value, place_of_supply, rate, taxable, igst
  const b2cs = new Map();   // key: place_of_supply|rate → aggregate
  const cdnr = [];     // (cancelled invoices treated as documents in 'docs')
  const hsn  = new Map();   // key: hsn|rate → aggregate
  const docs = { issued: rows.rows.length, cancelled: 0, net: 0 };
  rows.rows.forEach(r => { if (r.status === 'cancelled') docs.cancelled++; });
  docs.net = docs.issued - docs.cancelled;

  // Group lines by invoice for B2B/B2CL/B2CS classification
  const byInv = new Map();
  lines.rows.forEach(ln => {
    if (!byInv.has(ln.invoice_id)) byInv.set(ln.invoice_id, []);
    byInv.get(ln.invoice_id).push(ln);
  });

  rows.rows.forEach(inv => {
    if (inv.status === 'cancelled') return;
    const ls = byInv.get(inv.id) || [];
    const totalValue = num(inv.total, 0);
    const isB2B = !!s(inv.customer_gstin).trim();
    const isInterState = String(inv.company_state||'').toLowerCase() !== String(inv.customer_state||'').toLowerCase();

    ls.forEach(ln => {
      const rate = num(ln.gst_pct, 0);
      if (isB2B) {
        b2b.push({
          gstin: inv.customer_gstin, name: inv.customer_name,
          invoice_no: inv.invoice_no, invoice_date: inv.invoice_date,
          invoice_value: totalValue, place_of_supply: inv.place_of_supply || inv.customer_state,
          reverse_charge: inv.is_reverse_charge ? 'Y' : 'N',
          invoice_type: 'Regular', rate,
          taxable: ln.taxable_value, cgst: ln.cgst, sgst: ln.sgst, igst: ln.igst, cess: ln.cess
        });
      } else if (isInterState && totalValue > b2cl_threshold) {
        b2cl.push({
          invoice_no: inv.invoice_no, invoice_date: inv.invoice_date,
          invoice_value: totalValue, place_of_supply: inv.place_of_supply || inv.customer_state,
          rate, taxable: ln.taxable_value, igst: ln.igst, cess: ln.cess
        });
      } else {
        const key = (inv.place_of_supply || inv.customer_state || '') + '|' + rate.toFixed(2) +
                    '|' + (isInterState ? 'INTER' : 'INTRA');
        const cur = b2cs.get(key) || { type: isInterState ? 'OE' : 'OE', place_of_supply: inv.place_of_supply || inv.customer_state, rate, taxable: 0, cgst:0, sgst:0, igst:0, cess:0 };
        cur.taxable += ln.taxable_value; cur.cgst += ln.cgst; cur.sgst += ln.sgst; cur.igst += ln.igst; cur.cess += (ln.cess || 0);
        b2cs.set(key, cur);
      }

      const hkey = (ln.hsn_sac || '') + '|' + rate.toFixed(2);
      const h = hsn.get(hkey) || { hsn: ln.hsn_sac || '', unit: ln.unit || '', rate, qty: 0, taxable: 0, cgst:0, sgst:0, igst:0, cess:0 };
      h.qty += num(ln.qty, 0);
      h.taxable += ln.taxable_value;
      h.cgst += ln.cgst; h.sgst += ln.sgst; h.igst += ln.igst; h.cess += (ln.cess || 0);
      hsn.set(hkey, h);
    });
  });

  return {
    b2b, b2cl, b2cs: Array.from(b2cs.values()), cdnr, hsn: Array.from(hsn.values()), docs
  };
}

async function api_invoicing_gstr1_preview(token, opts) {
  await _ctx(token);
  opts = opts || {};
  if (!opts.company_id) throw new Error('company_id required');
  if (!opts.from || !opts.to) throw new Error('from and to dates required');
  const d = await _gstr1Data(Number(opts.company_id), opts.from, opts.to);
  return {
    b2b_count:   d.b2b.length,
    b2cl_count:  d.b2cl.length,
    b2cs_count:  d.b2cs.length,
    cdnr_count:  d.cdnr.length,
    hsn_count:   d.hsn.length,
    docs:        d.docs,
    sample_b2b:  d.b2b.slice(0, 5),
    sample_b2cs: d.b2cs.slice(0, 5)
  };
}

function _csvLine(row) {
  return row.map(v => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

async function api_invoicing_gstr1_csv(token, opts) {
  await _ctx(token);
  opts = opts || {};
  if (!opts.company_id) throw new Error('company_id required');
  if (!opts.from || !opts.to) throw new Error('from and to dates required');
  const d = await _gstr1Data(Number(opts.company_id), opts.from, opts.to);

  const b2b = [_csvLine(['GSTIN/UIN of Recipient','Receiver Name','Invoice Number','Invoice Date','Invoice Value','Place Of Supply','Reverse Charge','Invoice Type','Rate','Taxable Value','Cess Amount'])]
    .concat(d.b2b.map(r => _csvLine([r.gstin, r.name, r.invoice_no, r.invoice_date, r.invoice_value, r.place_of_supply, r.reverse_charge, r.invoice_type, r.rate, r.taxable.toFixed(2), (r.cess||0).toFixed(2)])));

  const b2cl = [_csvLine(['Invoice Number','Invoice Date','Invoice Value','Place Of Supply','Rate','Taxable Value','Cess Amount'])]
    .concat(d.b2cl.map(r => _csvLine([r.invoice_no, r.invoice_date, r.invoice_value, r.place_of_supply, r.rate, r.taxable.toFixed(2), (r.cess||0).toFixed(2)])));

  const b2cs = [_csvLine(['Type','Place Of Supply','Rate','Taxable Value','Cess Amount'])]
    .concat(d.b2cs.map(r => _csvLine([r.type, r.place_of_supply, r.rate, r.taxable.toFixed(2), (r.cess||0).toFixed(2)])));

  const hsn = [_csvLine(['HSN','Description','UQC','Total Quantity','Total Value','Rate','Taxable Value','Integrated Tax','Central Tax','State Tax','Cess'])]
    .concat(d.hsn.map(r => _csvLine([r.hsn, '', r.unit, r.qty.toFixed(2), (r.taxable + r.cgst + r.sgst + r.igst + (r.cess||0)).toFixed(2), r.rate, r.taxable.toFixed(2), r.igst.toFixed(2), r.cgst.toFixed(2), r.sgst.toFixed(2), (r.cess||0).toFixed(2)])));

  const docs = [_csvLine(['Nature of Document','Sr. No. From','Sr. No. To','Total Number','Cancelled','Net Issued'])]
    .concat([_csvLine(['Invoices for outward supply','','', d.docs.issued, d.docs.cancelled, d.docs.net])]);

  const cdnr = [_csvLine(['GSTIN/UIN of Recipient','Receiver Name','Note Number','Note Date','Note Type','Place Of Supply','Reverse Charge','Note Supply Type','Note Value','Rate','Taxable Value','Cess Amount'])];

  return {
    period: { from: opts.from, to: opts.to },
    sheets: {
      b2b:  b2b.join('\n'),
      b2cl: b2cl.join('\n'),
      b2cs: b2cs.join('\n'),
      cdnr: cdnr.join('\n'),
      hsn:  hsn.join('\n'),
      docs: docs.join('\n')
    }
  };
}

// =====================================================================
// Settings
// =====================================================================
async function api_invoicing_settings_get(token) {
  await _ctx(token);
  const r = await db.query(`SELECT * FROM inv_settings WHERE id=1`);
  return r.rows[0] || {};
}
async function api_invoicing_settings_save(token, payload) {
  await _ctx(token);
  payload = payload || {};
  const allowed = ['default_gst_pct','currency_symbol','currency_code','date_format',
    'b2cl_threshold','fy_start_month','default_terms','default_notes','invoice_footer',
    'enable_qr','enable_round_off'];
  const sets = []; const vals = []; let i = 1;
  allowed.forEach(k => {
    if (payload[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(payload[k]); }
  });
  if (!sets.length) return await api_invoicing_settings_get(token);
  sets.push(`updated_at = NOW()`);
  const r = await db.query(`UPDATE inv_settings SET ${sets.join(', ')} WHERE id=1 RETURNING *`, vals);
  return r.rows[0];
}

module.exports = {
  api_invoicing_dashboard,
  api_invoicing_companies_list,
  api_invoicing_companies_get,
  api_invoicing_companies_save,
  api_invoicing_companies_delete,
  api_invoicing_customers_list,
  api_invoicing_customers_get,
  api_invoicing_customers_save,
  api_invoicing_customers_delete,
  api_invoicing_items_list,
  api_invoicing_items_get,
  api_invoicing_items_save,
  api_invoicing_items_delete,
  api_invoicing_invoices_list,
  api_invoicing_invoices_get,
  api_invoicing_invoices_save,
  api_invoicing_invoices_cancel,
  api_invoicing_invoices_pdf_html,
  api_invoicing_payments_list,
  api_invoicing_payments_add,
  api_invoicing_payments_delete,
  api_invoicing_gstr1_preview,
  api_invoicing_gstr1_csv,
  api_invoicing_settings_get,
  api_invoicing_settings_save,
};
