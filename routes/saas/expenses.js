/* ============================================================================
 * SaaS Finance — Expenses & Net Profit (SAAS_EXPENSES_v1, 2026-06-30)
 *   - Expense CATEGORY master (saas_expense_categories)
 *   - Expenses (saas_expenses) booked against a category
 *   - Net profit = PAID invoices for NON-DEMO tenants  −  expenses (in period)
 *
 * All super-admin gated. Uses raw control.query so no schema-cache needed.
 * ============================================================================ */
'use strict';
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');

async function _ensure() {
  await control.query(`CREATE TABLE IF NOT EXISTS saas_expense_categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await control.query(`CREATE TABLE IF NOT EXISTS saas_expenses (
    id SERIAL PRIMARY KEY,
    category_id INTEGER REFERENCES saas_expense_categories(id) ON DELETE SET NULL,
    amount_inr NUMERIC(12,2) NOT NULL DEFAULT 0,
    spent_on DATE NOT NULL DEFAULT CURRENT_DATE,
    vendor TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await control.query(`CREATE INDEX IF NOT EXISTS idx_saas_expenses_date ON saas_expenses(spent_on)`);
  await control.query(`CREATE INDEX IF NOT EXISTS idx_saas_expenses_cat ON saas_expenses(category_id)`);
}

function _ymd(d) { return d.toISOString().slice(0, 10); }
// Resolve a {range} token OR explicit {from,to} into YYYY-MM-DD bounds.
function _resolveRange(o) {
  o = o || {};
  if (o.from || o.to) return { from: o.from || '1970-01-01', to: o.to || '2999-12-31' };
  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth(), D = now.getDate();
  const mk = (y, m, d) => _ymd(new Date(Date.UTC(y, m, d)));
  const q = Math.floor(M / 3);
  switch (String(o.range || 'all')) {
    case 'today':        return { from: mk(Y, M, D), to: mk(Y, M, D) };
    case 'yesterday':    return { from: mk(Y, M, D - 1), to: mk(Y, M, D - 1) };
    case 'this_week':    { const wd = (now.getDay() + 6) % 7; return { from: mk(Y, M, D - wd), to: mk(Y, M, D) }; }
    case 'this_month':   return { from: mk(Y, M, 1), to: mk(Y, M + 1, 0) };
    case 'last_month':   return { from: mk(Y, M - 1, 1), to: mk(Y, M, 0) };
    case 'last_7':       return { from: mk(Y, M, D - 6), to: mk(Y, M, D) };
    case 'last_30':      return { from: mk(Y, M, D - 29), to: mk(Y, M, D) };
    case 'last_90':      return { from: mk(Y, M, D - 89), to: mk(Y, M, D) };
    case 'this_quarter': return { from: mk(Y, q * 3, 1), to: mk(Y, q * 3 + 3, 0) };
    case 'this_year':    return { from: mk(Y, 0, 1), to: mk(Y, 11, 31) };
    case 'last_year':    return { from: mk(Y - 1, 0, 1), to: mk(Y - 1, 11, 31) };
    case 'all':
    default:             return { from: '1970-01-01', to: '2999-12-31' };
  }
}

// ---- Category master --------------------------------------------------------
async function api_saas_expenseCats_list(token) {
  await requireFullAdmin(token); await _ensure();
  const r = await control.query(
    `SELECT c.id, c.name,
            COALESCE((SELECT SUM(e.amount_inr) FROM saas_expenses e WHERE e.category_id = c.id), 0)::numeric AS total_inr,
            (SELECT COUNT(*) FROM saas_expenses e WHERE e.category_id = c.id)::int AS count
       FROM saas_expense_categories c ORDER BY c.name`);
  return { items: r.rows };
}
async function api_saas_expenseCats_create(token, payload) {
  await requireFullAdmin(token); await _ensure();
  const name = String((payload || {}).name || '').trim();
  if (!name) throw new Error('Category name required');
  const r = await control.query(
    `INSERT INTO saas_expense_categories (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [name.slice(0, 120)]);
  return { item: r.rows[0] };
}
async function api_saas_expenseCats_delete(token, payload) {
  await requireFullAdmin(token);
  const id = Number((payload || {}).id);
  if (!id) throw new Error('id required');
  await control.query(`DELETE FROM saas_expense_categories WHERE id = $1`, [id]);
  return { ok: true };
}

// ---- Expenses ---------------------------------------------------------------
async function api_saas_expenses_list(token, payload) {
  await requireFullAdmin(token); await _ensure();
  const { from, to } = _resolveRange(payload);
  const args = [from, to]; const extra = [];
  if (payload && payload.category_id) { args.push(Number(payload.category_id)); extra.push(`e.category_id = $${args.length}`); }
  const r = await control.query(
    `SELECT e.*, c.name AS category_name
       FROM saas_expenses e LEFT JOIN saas_expense_categories c ON c.id = e.category_id
      WHERE e.spent_on >= $1::date AND e.spent_on <= $2::date ${extra.length ? 'AND ' + extra.join(' AND ') : ''}
      ORDER BY e.spent_on DESC, e.id DESC LIMIT 1000`, args);
  return { items: r.rows };
}
async function api_saas_expenses_create(token, payload) {
  const me = await requireFullAdmin(token); await _ensure();
  const p = payload || {};
  const amt = Math.max(0, Number(p.amount_inr) || 0);
  if (!(amt > 0)) throw new Error('Amount must be greater than 0');
  const cat = p.category_id ? Number(p.category_id) : null;
  const date = (String(p.spent_on || '').trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(p.spent_on).trim())) ? String(p.spent_on).trim() : null;
  const vendor = String(p.vendor || '').trim() || null;
  const notes = String(p.notes || '').trim() || null;
  const by = (me && (me.email || ('admin#' + me.id))) || null;
  const r = await control.query(
    `INSERT INTO saas_expenses (category_id, amount_inr, spent_on, vendor, notes, created_by)
     VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6) RETURNING *`,
    [cat, amt, date, vendor, notes, by]);
  return { item: r.rows[0] };
}
async function api_saas_expenses_delete(token, payload) {
  await requireFullAdmin(token);
  const id = Number((payload || {}).id);
  if (!id) throw new Error('id required');
  await control.query(`DELETE FROM saas_expenses WHERE id = $1`, [id]);
  return { ok: true };
}

// ---- Net profit (revenue from non-demo paid invoices − expenses) -----------
async function api_saas_finance_netProfit(token, payload) {
  await requireFullAdmin(token); await _ensure();
  const { from, to } = _resolveRange(payload);
  const rev = await control.query(
    `SELECT COALESCE(SUM(i.total_inr), 0)::numeric AS revenue, COUNT(*)::int AS paid_invoices
       FROM invoices i LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE i.status = 'paid'
        AND COALESCE(i.paid_at, i.updated_at)::date >= $1::date
        AND COALESCE(i.paid_at, i.updated_at)::date <= $2::date
        AND COALESCE(t.tenant_type, 'live') <> 'demo'`, [from, to]);
  const exp = await control.query(
    `SELECT COALESCE(SUM(amount_inr), 0)::numeric AS expenses, COUNT(*)::int AS expense_count
       FROM saas_expenses WHERE spent_on >= $1::date AND spent_on <= $2::date`, [from, to]);
  const byCat = await control.query(
    `SELECT COALESCE(c.name, 'Uncategorised') AS category, COALESCE(SUM(e.amount_inr), 0)::numeric AS total
       FROM saas_expenses e LEFT JOIN saas_expense_categories c ON c.id = e.category_id
      WHERE e.spent_on >= $1::date AND e.spent_on <= $2::date
      GROUP BY COALESCE(c.name, 'Uncategorised') ORDER BY total DESC`, [from, to]);
  const revenue = Number(rev.rows[0].revenue) || 0;
  const expenses = Number(exp.rows[0].expenses) || 0;
  return {
    range: { from, to },
    revenue, expenses, net_profit: revenue - expenses,
    paid_invoices: rev.rows[0].paid_invoices, expense_count: exp.rows[0].expense_count,
    by_category: byCat.rows,
    note: 'Revenue counts PAID invoices for LIVE tenants only (demo tenants excluded).'
  };
}

module.exports = {
  api_saas_expenseCats_list, api_saas_expenseCats_create, api_saas_expenseCats_delete,
  api_saas_expenses_list, api_saas_expenses_create, api_saas_expenses_delete,
  api_saas_finance_netProfit
};
