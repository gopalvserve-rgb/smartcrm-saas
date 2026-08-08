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
  // PROFORMA_v1 — invoice document type ('tax' | 'proforma'). Idempotent.
  try { await db.query(`ALTER TABLE invoices_inv ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'tax'`); } catch (_) {}
  // INV_CUSTOM_FIELDS_v1 — invoice custom fields (JSONB) + entity column on
  // the shared custom_fields table. Idempotent self-heal for existing tenants.
  try { await db.query(`ALTER TABLE invoices_inv ADD COLUMN IF NOT EXISTS custom_fields JSONB`); } catch (_) {}
  try { await db.query(`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS entity TEXT NOT NULL DEFAULT 'lead'`); } catch (_) {}
  // INVOICE_SOCIAL_QR_v1 — Instagram + Google Review links printed as QR codes.
  try { await db.query(`ALTER TABLE inv_settings ADD COLUMN IF NOT EXISTS instagram_url TEXT`); } catch (_) {}
  try { await db.query(`ALTER TABLE inv_settings ADD COLUMN IF NOT EXISTS google_review_url TEXT`); } catch (_) {}
  // INV_THEME_v1 — selectable invoice theme (classic | modern | minimal).
  try { await db.query(`ALTER TABLE inv_settings ADD COLUMN IF NOT EXISTS invoice_theme TEXT NOT NULL DEFAULT 'classic'`); } catch (_) {}
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
            customer_id, customer_name, total, amount_paid, paid_status, status, doc_type
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
  const docType = (payload.doc_type === 'proforma') ? 'proforma' : 'tax';  // PROFORMA_v1

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
      if (status === 'draft') {
        invoiceNo = 'DRAFT-' + Date.now().toString(36).toUpperCase();
      } else if (docType === 'proforma') {
        // PROFORMA_v1 — separate PI- series so the legal tax-invoice
        // sequence stays unbroken. Lock the company row to serialise.
        await client.query(`SELECT id FROM inv_companies WHERE id=$1 FOR UPDATE`, [Number(payload.company_id)]);
        const pc = (await client.query(`SELECT COUNT(*)::int AS c FROM invoices_inv WHERE company_id=$1 AND doc_type='proforma'`, [Number(payload.company_id)])).rows[0];
        invoiceNo = 'PI-' + pad((Number(pc.c) || 0) + 1, 5);
      } else {
        invoiceNo = await _allocateInvoiceNumber(client, Number(payload.company_id));
      }
      const ins = await client.query(`
        INSERT INTO invoices_inv (
          invoice_no, invoice_date, due_date, company_id, customer_id,
          customer_name, customer_gstin, customer_state, customer_state_code,
          bill_to_address, ship_to_address, place_of_supply,
          company_name, company_gstin, company_state,
          subtotal, discount, cgst, sgst, igst, cess, round_off, total, amount_in_words,
          status, paid_status, amount_paid, notes, terms, is_reverse_charge, created_by, doc_type, custom_fields
        ) VALUES (
          $1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12, $13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23,$24, $25,$26,$27,$28,$29,$30,$31,$32,$33
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
        user.id, docType,
        (payload.custom_fields && typeof payload.custom_fields === 'object') ? JSON.stringify(payload.custom_fields) : null
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
          notes=$20, terms=$21, is_reverse_charge=$22, custom_fields=$23, updated_at=NOW()
        WHERE id=$24
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
        (payload.custom_fields && typeof payload.custom_fields === 'object') ? JSON.stringify(payload.custom_fields) : null,
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

async function api_invoicing_invoices_delete(token, id) {
  // INVOICE_DELETE_v1 — hard-delete an invoice + its lines + payments.
  const { user } = await _ctx(token);
  const iid = Number(id);
  const ex = await db.query(`SELECT id, invoice_no, total FROM invoices_inv WHERE id=$1`, [iid]);
  if (!ex.rows.length) throw new Error('Invoice not found');
  let store = null; try { store = db.tenantStorage.getStore(); } catch (_) {}
  const pool = store && store.pool;
  if (!pool) throw new Error('Tenant pool unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM invoice_payments_inv WHERE invoice_id=$1`, [iid]).catch(() => {});
    await client.query(`DELETE FROM invoice_lines_inv WHERE invoice_id=$1`, [iid]);
    await client.query(`DELETE FROM invoices_inv WHERE id=$1`, [iid]);
    await client.query('COMMIT');
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
  finally { client.release(); }
  await db.query(
    `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
     VALUES ($1,$2,'invoice.delete','invoice',$3,$4)`,
    [user.id, user.email, iid, JSON.stringify(ex.rows[0])]
  ).catch(() => {});
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

  // --- Brand accent (auto-match tenant branding) ----------------------
  // Pull the tenant's brand colour from config so every tenant's invoice
  // matches their CRM branding. Falls back to a professional indigo.
  let accent = '#4f46e5';
  try {
    const _b = (await db.query("SELECT value FROM config WHERE key='BRAND_PRIMARY_COLOR' LIMIT 1")).rows[0];
    let v = _b && String(_b.value || '').trim();
    if (v) { if (v[0] !== '#') v = '#' + v; if (/^#[0-9a-fA-F]{6}$/.test(v)) accent = v; }
  } catch (_) {}
  const _hx = (h) => { h = String(h || '').replace('#',''); return h.length === 3 ? h.split('').map(c => c + c).join('') : h; };
  const _rgba = (hex, a) => { const h = _hx(hex); return `rgba(${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)},${a})`; };
  const _darken = (hex, f) => { const h = _hx(hex); const r = Math.round(parseInt(h.slice(0,2),16)*(1-f)); const g = Math.round(parseInt(h.slice(2,4),16)*(1-f)); const b = Math.round(parseInt(h.slice(4,6),16)*(1-f)); return `rgb(${r},${g},${b})`; };
  const accentDark = _darken(accent, 0.38);
  const accentSoft = _rgba(accent, 0.10);
  const accentLine = _rgba(accent, 0.28);

  // --- UPI QR (SCAN & PAY) --------------------------------------------
  // Rendered only when the company has a UPI id AND the QR toggle is on
  // (inv_settings.enable_qr, default 1). Embedded as an inline base64 data
  // URI so it prints / exports to PDF with no network call. Falls back to
  // the plain UPI text line if the qrcode dependency is unavailable.
  let qrImgTag = '';
  const _upiId = String(company.upi_id || '').trim();
  const _qrOn = (settings.enable_qr == null) ? true : Number(settings.enable_qr) === 1;
  const _balanceDue = round2(Number(inv.total || 0) - Number(inv.amount_paid || 0));
  if (_upiId && _qrOn) {
    const _amt = (_balanceDue > 0.01 ? _balanceDue : Number(inv.total || 0)).toFixed(2);
    const _pn  = encodeURIComponent(String(inv.company_name || '').slice(0, 60));
    const _tn  = encodeURIComponent(String(inv.invoice_no || '').slice(0, 40));
    const _upiUri = `upi://pay?pa=${encodeURIComponent(_upiId)}&pn=${_pn}&am=${_amt}&cu=INR&tn=${_tn}`;
    try {
      const QRCode = require('qrcode');
      const svg = await QRCode.toString(_upiUri, { type: 'svg', margin: 0, width: 168,
        color: { dark: '#0f172a', light: '#ffffff' } });
      const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
      qrImgTag = `<img src="${dataUri}" width="150" height="150" alt="Scan to pay via UPI"/>`;
    } catch (_e) { qrImgTag = ''; }
  }

  // INVOICE_SOCIAL_QR_v1 — Instagram + Google Review QR codes on every invoice.
  let socialQrHtml = '';
  try {
    const QRCode = require('qrcode');
    const _mkQr = async (url) => {
      const svg = await QRCode.toString(String(url), { type: 'svg', margin: 0, width: 150, color: { dark: '#0f172a', light: '#ffffff' } });
      return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    };
    const _ig = String(settings.instagram_url || '').trim();
    const _gr = String(settings.google_review_url || '').trim();
    const cells = [];
    if (_ig) cells.push(`<div class="sqr"><img src="${await _mkQr(_ig)}" width="92" height="92" alt="Instagram"/><div class="sqr-cap">📸 Follow us on Instagram</div></div>`);
    if (_gr) cells.push(`<div class="sqr"><img src="${await _mkQr(_gr)}" width="92" height="92" alt="Google Review"/><div class="sqr-cap">⭐ Rate us on Google</div></div>`);
    if (cells.length) socialQrHtml = `<div class="social-qr"><div class="social-qr-title">Scan to connect &amp; review us</div><div class="social-qr-row">${cells.join('')}</div></div>`;
  } catch (_e) { socialQrHtml = ''; }

  // --- Brand mark: logo, else initials monogram in the accent colour ---
  const _initials = String(inv.company_name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'CO';
  const brandMark = company.logo_url
    ? `<img class="logo" src="${esc(company.logo_url)}"/>`
    : `<div class="logo-fallback">${esc(_initials)}</div>`;

  const _statusStamp =
      inv.status === 'cancelled' ? '<div class="stamp cancelled">CANCELLED</div>'
    : inv.status === 'draft'     ? '<div class="stamp draft">DRAFT</div>'
    : (String(inv.paid_status) === 'paid') ? '<div class="stamp paid">PAID</div>'
    : '';

  const payCard = (qrImgTag || _upiId || company.bank_account) ? `
      <div class="paybox">
        <div class="paybox-title">Payment</div>
        <div class="paybox-body">
          ${qrImgTag ? `<div class="qr">${qrImgTag}<div class="qr-cap">Scan &amp; Pay</div><div class="qr-apps">PhonePe · GPay · Paytm · any UPI app</div></div>` : ''}
          <div class="paybox-lines">
            ${_upiId ? `<div><span class="k">UPI ID</span><span class="v">${esc(_upiId)}</span></div>` : ''}
            ${company.bank_name ? `<div><span class="k">Bank</span><span class="v">${esc(company.bank_name)}</span></div>` : ''}
            ${company.bank_account ? `<div><span class="k">A/C No.</span><span class="v">${esc(company.bank_account)}</span></div>` : ''}
            ${company.bank_ifsc ? `<div><span class="k">IFSC</span><span class="v">${esc(company.bank_ifsc)}</span></div>` : ''}
            ${_balanceDue > 0.01 ? `<div class="due"><span class="k">Amount Due</span><span class="v">${fmt(_balanceDue)}</span></div>` : ''}
          </div>
        </div>
      </div>` : '';

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>${esc((inv.customer_name ? String(inv.customer_name).trim() + ' - ' : '') + inv.invoice_no)}</title>
<style>
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { font-family:'Segoe UI','Helvetica Neue',Arial,sans-serif; color:#1e293b; font-size:12px; line-height:1.4; background:#eef2f7; }
  .sheet { max-width:800px; margin:0 auto; background:#fff; }
  .accent-bar { height:7px; background:${accent}; }
  .pad { padding:24px 30px; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; }
  .brand { display:flex; gap:13px; align-items:flex-start; }
  .logo { max-height:60px; max-width:168px; object-fit:contain; }
  .logo-fallback { width:56px; height:56px; border-radius:12px; background:${accent}; color:#fff; font-weight:800; font-size:21px; display:flex; align-items:center; justify-content:center; letter-spacing:.5px; }
  .brand h1 { margin:0 0 2px; font-size:18px; font-weight:800; letter-spacing:.2px; color:#0f172a; }
  .brand .sub { font-size:11px; color:#64748b; }
  .brand .sub b { color:#334155; }
  .inv-panel { text-align:right; min-width:200px; }
  .inv-panel .ttl { font-size:23px; font-weight:800; letter-spacing:2px; color:${accent}; margin:0; }
  .inv-panel .no { margin-top:5px; font-size:13px; font-weight:700; color:#0f172a; }
  .inv-panel .row { font-size:11px; color:#64748b; margin-top:2px; }
  .inv-panel .row b { color:#334155; }
  .proforma-note { color:#b45309; font-weight:700; font-size:11px; }
  .parties { display:flex; gap:14px; margin-top:18px; }
  .party { flex:1; background:#f8fafc; border:1px solid #eef2f7; border-radius:10px; padding:11px 13px; }
  .party h4 { margin:0 0 5px; font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:${accentDark}; }
  .party .nm { font-weight:700; color:#0f172a; font-size:12.5px; }
  .party div.ln { font-size:11.3px; color:#475569; }
  table.lines { width:100%; border-collapse:collapse; margin-top:16px; border-radius:10px; overflow:hidden; }
  table.lines thead th { background:#0f172a; color:#e2e8f0; font-size:10px; text-transform:uppercase; letter-spacing:.5px; padding:8px 9px; text-align:left; font-weight:600; }
  table.lines tbody td { padding:7px 9px; border-bottom:1px solid #eef2f7; font-size:11.8px; vertical-align:top; }
  table.lines tbody tr:nth-child(even) td { background:#f8fafc; }
  .r { text-align:right; } .c { text-align:center; }
  .hsn { font-size:10px; color:#94a3b8; }
  .bottom { display:flex; gap:18px; margin-top:16px; align-items:flex-start; }
  .bottom-left { flex:1.25; } .bottom-right { flex:1; }
  .tot { width:100%; border-collapse:collapse; }
  .tot td { padding:6px 10px; font-size:12px; }
  .tot tr td:last-child { text-align:right; font-variant-numeric:tabular-nums; }
  .tot tr.sub td { border-bottom:1px solid #eef2f7; color:#475569; }
  .tot tr.grand td { background:${accentSoft}; color:${accentDark}; font-weight:800; font-size:14.5px; border-top:2px solid ${accent}; }
  .tot tr.paid td { color:#059669; }
  .tot tr.due td { color:#b91c1c; font-weight:700; }
  .words { margin-top:11px; font-size:11.3px; color:#475569; background:#f8fafc; border-left:3px solid ${accent}; padding:7px 11px; border-radius:0 8px 8px 0; }
  .words b { color:#334155; }
  .paybox { border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; }
  .paybox-title { background:${accentSoft}; padding:7px 13px; font-size:10px; text-transform:uppercase; letter-spacing:.8px; color:${accentDark}; font-weight:700; }
  .paybox-body { display:flex; gap:14px; padding:13px; align-items:center; }
  .qr { text-align:center; }
  .qr img { border:1px solid #e2e8f0; border-radius:8px; padding:5px; background:#fff; }
  .qr-cap { font-size:11px; color:#0f172a; margin-top:5px; font-weight:700; }
  .qr-apps { font-size:9px; color:#94a3b8; margin-top:1px; }
  .paybox-lines { flex:1; font-size:11.8px; }
  .paybox-lines > div { display:flex; justify-content:space-between; gap:10px; padding:3px 0; border-bottom:1px dashed #eef2f7; }
  .paybox-lines .k { color:#94a3b8; }
  .paybox-lines .v { color:#0f172a; font-weight:600; text-align:right; word-break:break-all; }
  .paybox-lines .due .v { color:#b91c1c; }
  .foot { margin-top:18px; padding-top:12px; border-top:1px solid #eef2f7; font-size:11px; color:#64748b; display:flex; gap:22px; justify-content:space-between; }
  .foot .notes { flex:1.4; } .foot .sign { flex:1; text-align:right; }
  .social-qr { margin-top:14px; border-top:1px dashed #cbd5e1; padding-top:12px; text-align:center; }
  .social-qr-title { font-size:12px; font-weight:700; color:#334155; margin-bottom:8px; }
  .social-qr-row { display:flex; justify-content:center; gap:40px; flex-wrap:wrap; }
  .sqr { text-align:center; }
  .sqr img { border:1px solid #e2e8f0; border-radius:8px; padding:4px; background:#fff; }
  .sqr-cap { font-size:10px; color:#475569; margin-top:5px; font-weight:600; }
  .foot b { color:#334155; }
  .terms { margin-top:7px; font-size:10.3px; color:#64748b; line-height:1.45; }
  .sign-space { height:40px; }
  .thanks { text-align:center; margin-top:13px; font-size:10.5px; color:#94a3b8; }
  .stamp { display:inline-block; margin-top:7px; padding:3px 13px; border-radius:6px; font-weight:800; letter-spacing:1px; font-size:12px; border:2px solid; transform:rotate(-4deg); }
  .stamp.paid { color:#059669; border-color:#059669; }
  .stamp.cancelled { color:#b91c1c; border-color:#b91c1c; }
  .stamp.draft { color:#b45309; border-color:#b45309; }
  @page { size:A4; margin:11mm; }
  @media print { body { background:#fff; font-size:11px; } .sheet { max-width:none; } .pad { padding:0; } }
  /* INV_THEME_v1 — Modern (coloured header band) + Minimal (clean lines) */
  .theme-modern .accent-bar { display:none; }
  .theme-modern .top { background:linear-gradient(135deg,${accent},${accentDark}); margin:-24px -30px 18px; padding:22px 30px; }
  .theme-modern .brand h1 { color:#fff; }
  .theme-modern .brand .sub, .theme-modern .brand .sub b { color:rgba(255,255,255,.85); }
  .theme-modern .inv-panel .ttl, .theme-modern .inv-panel .no { color:#fff; }
  .theme-modern .inv-panel .row, .theme-modern .inv-panel .row b { color:rgba(255,255,255,.85); }
  .theme-modern .logo-fallback { background:rgba(255,255,255,.25); }
  .theme-minimal .accent-bar { display:none; }
  .theme-minimal .pad { padding:26px 30px; }
  .theme-minimal table.lines thead th { background:#fff; color:#0f172a; border-bottom:2px solid ${accent}; }
  .theme-minimal table.lines tbody tr:nth-child(even) td { background:#fff; }
  .theme-minimal .party { background:#fff; border:0; border-bottom:1px solid #e5e7eb; border-radius:0; padding:11px 2px; }
  .theme-minimal .tot tr.grand td { background:#fff; border-top:2px solid ${accent}; }
</style>
</head><body>
  <div class="sheet theme-${String(settings.invoice_theme || 'classic').toLowerCase()}">
    <div class="accent-bar"></div>
    <div class="pad">
      <div class="top">
        <div class="brand">
          ${brandMark}
          <div>
            <h1>${esc(inv.company_name)}</h1>
            <div class="sub">${esc(company.address || '')}${company.city ? ', ' + esc(company.city) : ''}${company.pincode ? ' ' + esc(company.pincode) : ''}</div>
            <div class="sub">${company.phone ? 'Ph: ' + esc(company.phone) : ''}${company.email ? ' • ' + esc(company.email) : ''}</div>
            <div class="sub">${inv.company_gstin ? '<b>GSTIN:</b> ' + esc(inv.company_gstin) : ''}${company.state ? ' • State: ' + esc(company.state) : ''}</div>
          </div>
        </div>
        <div class="inv-panel">
          <p class="ttl">${(inv.doc_type === 'proforma') ? 'PROFORMA' : 'INVOICE'}</p>
          ${(inv.doc_type === 'proforma') ? '<div class="proforma-note">Not a tax invoice</div>' : ''}
          <div class="no">${esc(inv.invoice_no)}</div>
          <div class="row"><b>Date:</b> ${dt(inv.invoice_date)}</div>
          ${inv.due_date ? `<div class="row"><b>Due:</b> ${dt(inv.due_date)}</div>` : ''}
          ${_statusStamp}
        </div>
      </div>

      <div class="parties">
        <div class="party">
          <h4>Bill To</h4>
          <div class="nm">${esc(inv.customer_name)}</div>
          <div class="ln">${esc(inv.bill_to_address || '')}</div>
          <div class="ln">${inv.customer_gstin ? '<b>GSTIN:</b> ' + esc(inv.customer_gstin) : ''}</div>
          <div class="ln">${inv.customer_state ? 'State: ' + esc(inv.customer_state) : ''}</div>
        </div>
        <div class="party">
          <h4>Ship To</h4>
          <div class="ln">${esc(inv.ship_to_address || inv.bill_to_address || '')}</div>
          <div class="ln">${inv.place_of_supply ? 'Place of Supply: ' + esc(inv.place_of_supply) : ''}</div>
        </div>
      </div>

      <table class="lines">
        <thead><tr>
          <th style="width:30px">#</th>
          <th>Description</th>
          <th class="r" style="width:76px">Qty</th>
          <th class="r" style="width:88px">Rate</th>
          <th class="r" style="width:92px">Taxable</th>
          <th class="r" style="width:54px">GST%</th>
          <th class="r" style="width:100px">Amount</th>
        </tr></thead>
        <tbody>${linesHtml}</tbody>
      </table>

      <div class="bottom">
        <div class="bottom-left">
          ${payCard}
          <div class="words"><b>Amount in words:</b> ${esc(inv.amount_in_words || _amountInWords(inv.total))}</div>
        </div>
        <div class="bottom-right">
          <table class="tot">
            <tr class="sub"><td>Subtotal</td><td>${fmt(inv.subtotal)}</td></tr>
            ${Number(inv.discount) ? `<tr class="sub"><td>Discount</td><td>- ${fmt(inv.discount)}</td></tr>` : ''}
            ${taxBlock}
            ${Number(inv.cess) ? `<tr class="sub"><td>Cess</td><td>${fmt(inv.cess)}</td></tr>` : ''}
            ${Number(inv.round_off) ? `<tr class="sub"><td>Round Off</td><td>${fmt(inv.round_off)}</td></tr>` : ''}
            <tr class="grand"><td>Total</td><td>${fmt(inv.total)}</td></tr>
            ${Number(inv.amount_paid) ? `<tr class="paid"><td>Paid</td><td>${fmt(inv.amount_paid)}</td></tr>
                                          <tr class="due"><td>Balance Due</td><td>${fmt(Number(inv.total) - Number(inv.amount_paid))}</td></tr>` : ''}
          </table>
        </div>
      </div>

      <div class="foot">
        <div class="notes">
          ${inv.notes ? `<div><b>Notes:</b> ${esc(inv.notes)}</div>` : ''}
          ${inv.terms ? `<div class="terms"><b>Terms &amp; Conditions:</b><br/>${esc(inv.terms).replace(/\n/g,'<br/>')}</div>` : ''}
        </div>
        <div class="sign">
          For <b>${esc(inv.company_name)}</b>
          <div class="sign-space"></div>
          Authorised Signatory
        </div>
      </div>

      ${socialQrHtml}
      ${settings.invoice_footer ? `<div class="thanks">${esc(settings.invoice_footer)}</div>` : ''}
    </div>
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
      AND COALESCE(i.doc_type,'tax') <> 'proforma'
    GROUP BY i.id
    ORDER BY i.invoice_date, i.id
  `, [Number(companyId), from, to]);
  const lines = await db.query(`
    SELECT l.*, i.id AS invoice_id, i.invoice_no, i.invoice_date, i.customer_gstin,
           i.customer_state, i.place_of_supply, i.status
    FROM invoice_lines_inv l
    JOIN invoices_inv i ON i.id = l.invoice_id
    WHERE i.company_id = $1 AND i.invoice_date BETWEEN $2 AND $3 AND i.status <> 'cancelled'
      AND COALESCE(i.doc_type,'tax') <> 'proforma'
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

  // GSTR1_CSV_NUMCOERCE_v1 — Postgres returns numeric columns as strings, so
  // r.taxable/cess/qty/cgst/sgst/igst arrive as strings. Calling .toFixed() on a
  // string throws "toFixed is not a function", and "+" would string-concatenate.
  // Coerce every amount through N() before formatting/adding.
  const N = v => Number(v || 0);

  const b2b = [_csvLine(['GSTIN/UIN of Recipient','Receiver Name','Invoice Number','Invoice Date','Invoice Value','Place Of Supply','Reverse Charge','Invoice Type','Rate','Taxable Value','Cess Amount'])]
    .concat(d.b2b.map(r => _csvLine([r.gstin, r.name, r.invoice_no, r.invoice_date, r.invoice_value, r.place_of_supply, r.reverse_charge, r.invoice_type, r.rate, N(r.taxable).toFixed(2), N(r.cess).toFixed(2)])));

  const b2cl = [_csvLine(['Invoice Number','Invoice Date','Invoice Value','Place Of Supply','Rate','Taxable Value','Cess Amount'])]
    .concat(d.b2cl.map(r => _csvLine([r.invoice_no, r.invoice_date, r.invoice_value, r.place_of_supply, r.rate, N(r.taxable).toFixed(2), N(r.cess).toFixed(2)])));

  const b2cs = [_csvLine(['Type','Place Of Supply','Rate','Taxable Value','Cess Amount'])]
    .concat(d.b2cs.map(r => _csvLine([r.type, r.place_of_supply, r.rate, N(r.taxable).toFixed(2), N(r.cess).toFixed(2)])));

  const hsn = [_csvLine(['HSN','Description','UQC','Total Quantity','Total Value','Rate','Taxable Value','Integrated Tax','Central Tax','State Tax','Cess'])]
    .concat(d.hsn.map(r => _csvLine([r.hsn, '', r.unit, N(r.qty).toFixed(2), (N(r.taxable) + N(r.cgst) + N(r.sgst) + N(r.igst) + N(r.cess)).toFixed(2), r.rate, N(r.taxable).toFixed(2), N(r.igst).toFixed(2), N(r.cgst).toFixed(2), N(r.sgst).toFixed(2), N(r.cess).toFixed(2)])));

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
    'enable_qr','enable_round_off','instagram_url','google_review_url','invoice_theme'];
  const sets = []; const vals = []; let i = 1;
  allowed.forEach(k => {
    if (payload[k] !== undefined) { sets.push(`${k} = $${i++}`); vals.push(payload[k]); }
  });
  if (!sets.length) return await api_invoicing_settings_get(token);
  sets.push(`updated_at = NOW()`);
  const r = await db.query(`UPDATE inv_settings SET ${sets.join(', ')} WHERE id=1 RETURNING *`, vals);
  return r.rows[0];
}

/**
 * INVOICE_SETNUMBER_v1 — correct / override an existing invoice's number.
 * Needed when a mis-configured prefix produced a wrong invoice_no and the
 * invoice must be renumbered WITHOUT deleting it (the normal save path keeps
 * invoice_no locked). Refuses a value already used by another invoice of the
 * same seller company so numbers stay unique.
 */
async function api_invoicing_invoices_setNumber(token, payload) {
  const { user } = await _ctx(token);
  payload = payload || {};
  const id    = Number(payload.id);
  const newNo = s(payload.invoice_no).trim();
  if (!id)    throw new Error('Invoice id is required');
  if (!newNo) throw new Error('New invoice number is required');
  const ex = await db.query(`SELECT id, invoice_no, company_id FROM invoices_inv WHERE id=$1`, [id]);
  if (!ex.rows.length) throw new Error('Invoice not found');
  const cur = ex.rows[0];
  const dup = await db.query(
    `SELECT id FROM invoices_inv WHERE company_id=$1 AND invoice_no=$2 AND id<>$3 LIMIT 1`,
    [cur.company_id, newNo, id]
  );
  if (dup.rows.length) throw new Error('Another invoice already uses number ' + newNo);
  const r = await db.query(
    `UPDATE invoices_inv SET invoice_no=$1, updated_at=NOW() WHERE id=$2
       RETURNING id, invoice_no, company_id, total`, [newNo, id]
  );
  try {
    await db.query(
      `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
       VALUES ($1,$2,'invoice.setNumber','invoice',$3,$4)`,
      [user.id, user.email, id, JSON.stringify({ from: cur.invoice_no, to: newNo })]
    );
  } catch (_e) {}
  return { ok: true, id, from: cur.invoice_no, to: newNo };
}

/**
 * INVOICE_CONVERT_TO_TAX_v1 — turn a Proforma (PI-) into a real Tax Invoice.
 * Creates a NEW tax invoice that copies the proforma's customer, addresses,
 * totals, custom fields and line items, and allocates a proper number from the
 * company's tax series (prefix + next_no). The proforma is KEPT for the record
 * and stamped converted_to_id/converted_at so it can't be converted twice.
 */
async function api_invoicing_invoices_convertToTax(token, payload) {
  const { user } = await _ctx(token);
  const id = Number(payload && payload.id != null ? payload.id : payload);
  if (!id) throw new Error('Invoice id is required');

  let store = null; try { store = db.tenantStorage.getStore(); } catch (_) {}
  const pool = store && store.pool;
  if (!pool) throw new Error('No tenant context');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // link columns (idempotent)
    await client.query(`ALTER TABLE invoices_inv ADD COLUMN IF NOT EXISTS converted_to_id   INTEGER`);
    await client.query(`ALTER TABLE invoices_inv ADD COLUMN IF NOT EXISTS converted_from_id INTEGER`);
    await client.query(`ALTER TABLE invoices_inv ADD COLUMN IF NOT EXISTS converted_at       TIMESTAMPTZ`);

    const pi = (await client.query(`SELECT * FROM invoices_inv WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!pi) throw new Error('Invoice not found');
    if (pi.doc_type !== 'proforma') throw new Error('Only a proforma can be converted to a tax invoice');
    if (pi.status === 'cancelled')  throw new Error('This proforma is cancelled');
    if (pi.converted_to_id) {
      const ex = (await client.query(`SELECT invoice_no FROM invoices_inv WHERE id=$1`, [pi.converted_to_id])).rows[0];
      throw new Error('Already converted to ' + ((ex && ex.invoice_no) || ('#' + pi.converted_to_id)));
    }

    const newNo = await _allocateInvoiceNumber(client, pi.company_id);
    const ins = await client.query(`
      INSERT INTO invoices_inv (
        invoice_no, invoice_date, due_date, company_id, customer_id,
        customer_name, customer_gstin, customer_state, customer_state_code,
        bill_to_address, ship_to_address, place_of_supply,
        company_name, company_gstin, company_state,
        subtotal, discount, cgst, sgst, igst, cess, round_off, total, amount_in_words,
        status, paid_status, amount_paid, notes, terms, is_reverse_charge, created_by, doc_type,
        custom_fields, converted_from_id
      ) VALUES (
        $1,$2,$3,$4,$5, $6,$7,$8,$9, $10,$11,$12, $13,$14,$15,
        $16,$17,$18,$19,$20,$21,$22,$23,$24, $25,'unpaid',0,$26,$27,$28,$29,'tax',
        $30,$31
      ) RETURNING id
    `, [
      newNo,
      new Date().toISOString().slice(0,10),   // tax invoice issue date = today
      pi.due_date,
      pi.company_id, pi.customer_id,
      pi.customer_name, pi.customer_gstin, pi.customer_state, pi.customer_state_code,
      pi.bill_to_address, pi.ship_to_address, pi.place_of_supply,
      pi.company_name, pi.company_gstin, pi.company_state,
      pi.subtotal, pi.discount, pi.cgst, pi.sgst, pi.igst, pi.cess, pi.round_off, pi.total, pi.amount_in_words,
      'finalized', pi.notes, pi.terms, pi.is_reverse_charge, user.id,
      (pi.custom_fields != null ? (typeof pi.custom_fields === 'object' ? JSON.stringify(pi.custom_fields) : pi.custom_fields) : null),
      pi.id
    ]);
    const newId = ins.rows[0].id;

    // copy line items verbatim
    const piLines = (await client.query(`SELECT * FROM invoice_lines_inv WHERE invoice_id=$1 ORDER BY line_no`, [id])).rows;
    for (const ln of piLines) {
      await client.query(`
        INSERT INTO invoice_lines_inv
          (invoice_id, line_no, item_id, description, hsn_sac, unit,
           qty, rate, discount_pct, gst_pct,
           taxable_value, cgst, sgst, igst, cess, line_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        newId, ln.line_no, ln.item_id, ln.description, ln.hsn_sac, ln.unit,
        ln.qty, ln.rate, ln.discount_pct, ln.gst_pct,
        ln.taxable_value, ln.cgst, ln.sgst, ln.igst, ln.cess, ln.line_total
      ]);
    }

    // stamp the proforma as converted (kept for record)
    await client.query(`UPDATE invoices_inv SET converted_to_id=$1, converted_at=NOW(), updated_at=NOW() WHERE id=$2`, [newId, id]);

    await client.query(
      `INSERT INTO inv_audit_log (user_id, user_email, action, entity, entity_id, detail)
       VALUES ($1,$2,'invoice.convertToTax','invoice',$3,$4)`,
      [user.id, user.email, newId, JSON.stringify({ from_proforma: pi.invoice_no, to_invoice: newNo })]
    );

    await client.query('COMMIT');
    return { ok: true, id: newId, invoice_no: newNo, from_proforma: pi.invoice_no };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================
// INV_PARTY_REPORTS_v1 — Party-wise (customer) summary + ledger
// ============================================================
async function api_invoicing_party_summary(token, opts) {
  await _ctx(token);
  opts = opts || {};
  const wh = ["status <> 'cancelled'"]; const vals = []; let i = 1;
  if (opts.company_id) { wh.push(`company_id = $${i++}`); vals.push(Number(opts.company_id)); }
  if (opts.from) { wh.push(`invoice_date >= $${i++}`); vals.push(opts.from); }
  if (opts.to)   { wh.push(`invoice_date <= $${i++}`); vals.push(opts.to); }
  const rows = (await db.query(
    `SELECT COALESCE(customer_id,0) AS customer_id,
            MAX(customer_name) AS customer_name,
            COUNT(*)::int AS invoices,
            COALESCE(SUM(total),0) AS invoiced,
            COALESCE(SUM(amount_paid),0) AS paid,
            COALESCE(SUM(total - amount_paid),0) AS balance,
            MAX(invoice_date) AS last_invoice
       FROM invoices_inv
      WHERE ${wh.join(' AND ')}
      GROUP BY COALESCE(customer_id,0), lower(customer_name)
      ORDER BY balance DESC, invoiced DESC`, vals)).rows;
  const totals = rows.reduce((a, r) => ({
    invoiced: a.invoiced + Number(r.invoiced), paid: a.paid + Number(r.paid),
    balance: a.balance + Number(r.balance), invoices: a.invoices + Number(r.invoices)
  }), { invoiced: 0, paid: 0, balance: 0, invoices: 0 });
  return { rows, totals };
}

async function api_invoicing_party_ledger(token, opts) {
  await _ctx(token);
  opts = opts || {};
  const byId = opts.customer_id !== undefined && opts.customer_id !== null && opts.customer_id !== '';
  const invWh = [byId ? 'customer_id = $1' : 'lower(customer_name) = lower($1)', "status <> 'cancelled'"];
  const vals = [byId ? Number(opts.customer_id) : String(opts.customer_name || '')]; let i = 2;
  if (opts.company_id) { invWh.push(`company_id = $${i++}`); vals.push(Number(opts.company_id)); }
  if (opts.from) { invWh.push(`invoice_date >= $${i++}`); vals.push(opts.from); }
  if (opts.to)   { invWh.push(`invoice_date <= $${i++}`); vals.push(opts.to); }
  const invs = (await db.query(
    `SELECT id, invoice_no, invoice_date AS dt, total, customer_name
       FROM invoices_inv WHERE ${invWh.join(' AND ')} ORDER BY invoice_date, id`, vals)).rows;
  const invIds = invs.map(r => r.id);
  let pays = [];
  if (invIds.length) {
    pays = (await db.query(
      `SELECT p.invoice_id, p.pay_date AS dt, p.amount, p.mode, p.reference, i.invoice_no
         FROM invoice_payments_inv p JOIN invoices_inv i ON i.id = p.invoice_id
        WHERE p.invoice_id = ANY($1) ORDER BY p.pay_date, p.id`, [invIds])).rows;
  }
  const entries = [];
  invs.forEach(r => entries.push({ date: r.dt, type: 'Invoice', ref: r.invoice_no, debit: Number(r.total), credit: 0 }));
  pays.forEach(p => entries.push({ date: p.dt, type: 'Payment' + (p.mode ? ' (' + p.mode + ')' : ''), ref: p.invoice_no + (p.reference ? ' · ' + p.reference : ''), debit: 0, credit: Number(p.amount) }));
  entries.sort((a, b) => (String(a.date) < String(b.date) ? -1 : String(a.date) > String(b.date) ? 1 : (b.debit - a.debit)));
  let bal = 0;
  entries.forEach(e => { bal += e.debit - e.credit; e.balance = bal; });
  return {
    customer_name: (invs[0] && invs[0].customer_name) || opts.customer_name || '',
    entries, closing_balance: bal,
    total_invoiced: entries.reduce((a, e) => a + e.debit, 0),
    total_paid: entries.reduce((a, e) => a + e.credit, 0)
  };
}

module.exports = {
  api_invoicing_party_summary,
  api_invoicing_party_ledger,
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
  api_invoicing_invoices_setNumber,
  api_invoicing_invoices_convertToTax,
  api_invoicing_invoices_cancel,
  api_invoicing_invoices_delete,
  api_invoicing_invoices_pdf_html,
  api_invoicing_payments_list,
  api_invoicing_payments_add,
  api_invoicing_payments_delete,
  api_invoicing_gstr1_preview,
  api_invoicing_gstr1_csv,
  api_invoicing_settings_get,
  api_invoicing_settings_save,
};
