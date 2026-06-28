/* ============================================================================
 * SaaS White-Label Billing (SAAS_ADMIN_REPAIR_v1, 2026-06-28)
 *
 * Backs the super-admin "White-Label Billing" page. Tracks agencies who
 * resell the white-labelled CRM — separate from regular tenants because
 * each WL customer has their own seat count, monthly recurring fee, and
 * collection cadence that the platform owner manages directly.
 *
 * Tables (auto-created idempotently on first call):
 *   wl_customers       — the WL agency record
 *   wl_invoices        — monthly invoices generated for them
 *   wl_payments        — payment receipts
 *
 * APIs (all super-admin gated):
 *   api_saas_wl_customers_list
 *   api_saas_wl_customer_get
 *   api_saas_wl_customer_save  (create or update)
 *   api_saas_wl_customer_delete
 *   api_saas_wl_invoices_list
 *   api_saas_wl_invoice_create
 *   api_saas_wl_invoice_markPaid
 *   api_saas_wl_runBillingNow  (generate monthly invoices for everyone due)
 *   api_saas_wl_generateMonthly (same — alias for SPA button)
 *   api_saas_wl_summary
 * ============================================================================ */
'use strict';
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');

let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;
  await control.query(`CREATE TABLE IF NOT EXISTS wl_customers (
    id              SERIAL PRIMARY KEY,
    agency_name     TEXT NOT NULL,
    contact_name    TEXT,
    contact_email   TEXT,
    contact_mobile  TEXT,
    plan_name       TEXT,
    seat_count      INTEGER DEFAULT 0,
    monthly_fee_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    billing_day     INTEGER DEFAULT 1,
    next_invoice_at DATE,
    status          TEXT NOT NULL DEFAULT 'active',
    domain          TEXT,
    brand_color     TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await control.query(`CREATE INDEX IF NOT EXISTS wl_customers_status_idx ON wl_customers(status)`);
  await control.query(`CREATE INDEX IF NOT EXISTS wl_customers_next_inv_idx ON wl_customers(next_invoice_at)`).catch(()=>{});
  // SAAS_ADMIN_REPAIR_v1 — patch OLD wl_customers tables (created before these columns existed)
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS plan_name TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS seat_count INTEGER DEFAULT 0`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS monthly_fee_inr NUMERIC(12,2) DEFAULT 0`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 1`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS next_invoice_at DATE`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS domain TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS brand_color TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS notes TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS contact_name TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS contact_email TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_customers ADD COLUMN IF NOT EXISTS contact_mobile TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS seat_count INTEGER DEFAULT 0`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS subtotal_inr NUMERIC(12,2) DEFAULT 0`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS tax_inr NUMERIC(12,2) DEFAULT 0`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS total_inr NUMERIC(12,2) DEFAULT 0`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS notes TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS period_start DATE`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS period_end DATE`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS sent_email_at TIMESTAMPTZ`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS sent_wa_at TIMESTAMPTZ`).catch(()=>{});
  // SAAS_ADMIN_REPAIR_v1.2 — wl_invoices may be a completely different old schema. Add core columns.
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS wl_customer_id INTEGER`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS number TEXT`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(()=>{});
  await control.query(`ALTER TABLE wl_invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`).catch(()=>{});

  await control.query(`CREATE TABLE IF NOT EXISTS wl_invoices (
    id              SERIAL PRIMARY KEY,
    wl_customer_id  INTEGER NOT NULL,
    number          TEXT NOT NULL UNIQUE,
    period_start    DATE,
    period_end      DATE,
    seat_count      INTEGER DEFAULT 0,
    subtotal_inr    NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_inr         NUMERIC(12,2) NOT NULL DEFAULT 0,
    total_inr       NUMERIC(12,2) NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'pending',
    paid_at         TIMESTAMPTZ,
    notes           TEXT,
    sent_email_at   TIMESTAMPTZ,
    sent_wa_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await control.query(`CREATE INDEX IF NOT EXISTS wl_invoices_cust_idx   ON wl_invoices(wl_customer_id)`);
  await control.query(`CREATE INDEX IF NOT EXISTS wl_invoices_status_idx ON wl_invoices(status)`);
  _schemaReady = true;
}

function _firstOfNextMonth(from) {
  const d = from ? new Date(from) : new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

async function _nextWLInvoiceNumber() {
  const yr = new Date().getFullYear();
  const r = await control.query(
    `SELECT number FROM wl_invoices WHERE number LIKE $1 ORDER BY id DESC LIMIT 1`,
    [`WL-${yr}-%`]
  );
  let n = 1;
  if (r.rows.length) {
    const m = String(r.rows[0].number).match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `WL-${yr}-${String(n).padStart(5, '0')}`;
}

/* ---------- Customers ---------- */
async function api_saas_wl_customers_list(token, opts) {
  await requireFullAdmin(token);
  await _ensureSchema();
  const o = opts || {};
  const where = [];
  const args  = [];
  if (o.status && o.status !== 'all') { args.push(o.status); where.push(`status = $${args.length}`); }
  if (o.q) {
    args.push('%' + String(o.q).trim() + '%');
    where.push(`(agency_name ILIKE $${args.length} OR contact_email ILIKE $${args.length} OR contact_mobile ILIKE $${args.length})`);
  }
  const r = await control.query(
    `SELECT c.*,
            (SELECT COALESCE(SUM(total_inr),0) FROM wl_invoices WHERE wl_customer_id=c.id AND status='paid') AS revenue_lifetime,
            (SELECT COALESCE(SUM(total_inr),0) FROM wl_invoices WHERE wl_customer_id=c.id AND status='pending') AS outstanding,
            (SELECT COUNT(*)::int FROM wl_invoices WHERE wl_customer_id=c.id) AS invoice_count
       FROM wl_customers c
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY c.created_at DESC LIMIT 500`,
    args
  );
  return { items: r.rows.map(x => ({
    ...x,
    revenue_lifetime: Number(x.revenue_lifetime)||0,
    outstanding:      Number(x.outstanding)||0,
    monthly_fee_inr:  Number(x.monthly_fee_inr)||0
  })) };
}

async function api_saas_wl_customer_get(token, id) {
  await requireFullAdmin(token);
  await _ensureSchema();
  const r = await control.query(`SELECT * FROM wl_customers WHERE id=$1`, [Number(id)]);
  if (!r.rows.length) throw new Error('WL customer not found');
  return { item: r.rows[0] };
}

async function api_saas_wl_customer_save(token, payload) {
  const me = await requireFullAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  if (!p.agency_name) throw new Error('agency_name required');
  const next = p.next_invoice_at || _firstOfNextMonth().toISOString().slice(0,10);
  if (p.id) {
    await control.query(
      `UPDATE wl_customers SET agency_name=$1, contact_name=$2, contact_email=$3, contact_mobile=$4,
         plan_name=$5, seat_count=$6, monthly_fee_inr=$7, billing_day=$8, next_invoice_at=$9,
         status=$10, domain=$11, brand_color=$12, notes=$13, updated_at=NOW()
       WHERE id=$14`,
      [p.agency_name, p.contact_name||null, p.contact_email||null, p.contact_mobile||null,
       p.plan_name||null, parseInt(p.seat_count||0,10), Number(p.monthly_fee_inr)||0,
       parseInt(p.billing_day||1,10), next, p.status||'active', p.domain||null,
       p.brand_color||null, p.notes||null, p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await control.query(
    `INSERT INTO wl_customers (agency_name, contact_name, contact_email, contact_mobile,
       plan_name, seat_count, monthly_fee_inr, billing_day, next_invoice_at, status, domain, brand_color, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [p.agency_name, p.contact_name||null, p.contact_email||null, p.contact_mobile||null,
     p.plan_name||null, parseInt(p.seat_count||0,10), Number(p.monthly_fee_inr)||0,
     parseInt(p.billing_day||1,10), next, p.status||'active', p.domain||null,
     p.brand_color||null, p.notes||null]
  );
  await control.insert('audit_log', { actor_type:'super_admin', actor_id:me.id, actor_email:me.email,
    event:'wl.customer.created', detail: JSON.stringify({ id: r.rows[0].id, agency: p.agency_name }) }).catch(()=>{});
  return { ok: true, id: r.rows[0].id };
}

async function api_saas_wl_customer_delete(token, id) {
  const me = await requireFullAdmin(token);
  await _ensureSchema();
  await control.query(`UPDATE wl_customers SET status='archived', updated_at=NOW() WHERE id=$1`, [Number(id)]);
  await control.insert('audit_log', { actor_type:'super_admin', actor_id:me.id, actor_email:me.email,
    event:'wl.customer.archived', detail: JSON.stringify({ id: Number(id) }) }).catch(()=>{});
  return { ok: true };
}

/* ---------- Invoices ---------- */
async function api_saas_wl_invoices_list(token, opts) {
  await requireFullAdmin(token);
  await _ensureSchema();
  const o = opts || {};
  const where = [];
  const args = [];
  if (o.wl_customer_id) { args.push(o.wl_customer_id); where.push(`i.wl_customer_id = $${args.length}`); }
  if (o.status) { args.push(o.status); where.push(`i.status = $${args.length}`); }
  const r = await control.query(
    `SELECT i.*, c.agency_name, c.contact_email, c.contact_mobile
       FROM wl_invoices i
       LEFT JOIN wl_customers c ON c.id = i.wl_customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY i.created_at DESC LIMIT 500`,
    args
  );
  return { items: r.rows };
}

async function api_saas_wl_invoice_create(token, payload) {
  const me = await requireFullAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  if (!p.wl_customer_id) throw new Error('wl_customer_id required');
  const cust = await control.query(`SELECT * FROM wl_customers WHERE id=$1`, [p.wl_customer_id]);
  if (!cust.rows.length) throw new Error('WL customer not found');
  const c = cust.rows[0];
  const seats = parseInt(p.seat_count || c.seat_count || 0, 10);
  const fee   = Number(p.monthly_fee_inr ?? c.monthly_fee_inr) || 0;
  const sub   = seats > 0 ? seats * fee : fee;
  const tax   = Math.round(sub * 18) / 100;
  const total = Math.round((sub + tax) * 100) / 100;
  const num   = await _nextWLInvoiceNumber();
  const now   = new Date();
  const pStart = p.period_start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const pEnd   = p.period_end   || _firstOfNextMonth(now).toISOString().slice(0,10);
  const r = await control.query(
    `INSERT INTO wl_invoices (wl_customer_id, number, period_start, period_end, seat_count, subtotal_inr, tax_inr, total_inr, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING id, number`,
    [p.wl_customer_id, num, pStart, pEnd, seats, sub, tax, total, p.notes || 'Monthly WL invoice']
  );
  await control.insert('audit_log', { actor_type:'super_admin', actor_id:me.id, actor_email:me.email,
    event:'wl.invoice.created', detail: JSON.stringify({ wl_invoice_id: r.rows[0].id, agency: c.agency_name, total }) }).catch(()=>{});
  return { ok: true, id: r.rows[0].id, number: r.rows[0].number, total };
}

async function api_saas_wl_invoice_markPaid(token, id) {
  const me = await requireFullAdmin(token);
  await _ensureSchema();
  await control.query(`UPDATE wl_invoices SET status='paid', paid_at=NOW(), updated_at=NOW() WHERE id=$1`, [Number(id)]);
  await control.insert('audit_log', { actor_type:'super_admin', actor_id:me.id, actor_email:me.email,
    event:'wl.invoice.paid', detail: JSON.stringify({ wl_invoice_id: Number(id) }) }).catch(()=>{});
  return { ok: true };
}

/** "Run Billing Now" button — generate invoices for every active customer
 *  whose next_invoice_at is today or earlier. */
async function api_saas_wl_runBillingNow(token) {
  const me = await requireFullAdmin(token);
  await _ensureSchema();
  const due = await control.query(
    `SELECT * FROM wl_customers
      WHERE status='active'
        AND (next_invoice_at IS NULL OR next_invoice_at <= CURRENT_DATE)
      ORDER BY id`
  );
  const out = { processed: 0, created: 0, skipped_existing: 0, errors: [] };
  for (const c of due.rows) {
    out.processed++;
    try {
      // Avoid duplicate for the current month
      const now = new Date();
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
      const dup = await control.query(
        `SELECT id FROM wl_invoices WHERE wl_customer_id=$1 AND period_start=$2 AND status IN ('pending','paid')`,
        [c.id, periodStart]
      );
      if (dup.rows.length) { out.skipped_existing++; }
      else {
        await api_saas_wl_invoice_create(token, { wl_customer_id: c.id });
        out.created++;
      }
      const nextDate = _firstOfNextMonth();
      await control.query(`UPDATE wl_customers SET next_invoice_at=$1, updated_at=NOW() WHERE id=$2`, [nextDate.toISOString().slice(0,10), c.id]);
    } catch (e) {
      out.errors.push({ wl_customer_id: c.id, agency: c.agency_name, err: String(e.message||e).slice(0,200) });
    }
  }
  return out;
}

const api_saas_wl_generateMonthly = api_saas_wl_runBillingNow;  // alias for SPA button

async function api_saas_wl_summary(token) {
  await requireFullAdmin(token);
  await _ensureSchema();
  const c = await control.query(`SELECT status, COUNT(*)::int AS n FROM wl_customers GROUP BY status`);
  const i = await control.query(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_inr),0)::numeric AS total FROM wl_invoices GROUP BY status`);
  const by_status = {};
  for (const r of c.rows) by_status[r.status] = r.n;
  const inv = { paid: 0, pending: 0, revenue: 0, outstanding: 0 };
  for (const r of i.rows) {
    if (r.status === 'paid')    { inv.paid    += r.n; inv.revenue     += Number(r.total)||0; }
    if (r.status === 'pending') { inv.pending += r.n; inv.outstanding += Number(r.total)||0; }
  }
  const mrr = await control.query(
    `SELECT COALESCE(SUM(CASE WHEN seat_count > 0 THEN seat_count * monthly_fee_inr ELSE monthly_fee_inr END), 0)::numeric AS mrr
       FROM wl_customers WHERE status='active'`
  );
  return {
    customers_total: Object.values(by_status).reduce((a,b)=>a+b,0),
    customers_by_status: by_status,
    invoices: inv,
    mrr: Number(mrr.rows[0].mrr) || 0,
    arr: (Number(mrr.rows[0].mrr) || 0) * 12
  };
}

module.exports = {
  api_saas_wl_customers_list,
  api_saas_wl_customer_get,
  api_saas_wl_customer_save,
  api_saas_wl_customer_delete,
  api_saas_wl_invoices_list,
  api_saas_wl_invoice_create,
  api_saas_wl_invoice_markPaid,
  api_saas_wl_runBillingNow,
  api_saas_wl_generateMonthly,
  api_saas_wl_summary
};
