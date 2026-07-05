/* ============================================================================
 * SaaS Finance & Business (SAAS_ADMIN_REPAIR_v1, 2026-06-28)
 *
 * Read-only aggregations over invoices + payments + tenants + packages.
 * No schema changes.
 *
 * APIs (all super-admin gated):
 *   api_saas_finance_overview(token, opts)      → KPI summary
 *   api_saas_finance_revenueByMonth(token, opts)→ chart data
 *   api_saas_finance_byPackage(token, opts)     → package breakdown
 *   api_saas_finance_expiringSoon(token, opts)  → tenants expiring < 30d
 *   api_saas_finance_tenantsList(token, opts)   → enriched tenant rows
 * ============================================================================ */
'use strict';
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');

function _periodToRange(period) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  switch (String(period || 'this_month')) {
    case 'today':
      { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); return { from: d.toISOString(), to: now.toISOString() }; }
    case 'yesterday':
      { const d = new Date(now); d.setDate(d.getDate() - 1); const s = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const e = new Date(s); e.setDate(e.getDate() + 1); return { from: s.toISOString(), to: e.toISOString() }; }
    case 'this_week':
      { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return { from: d.toISOString(), to: now.toISOString() }; }
    case 'last_month':
      { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 1); return { from: s.toISOString(), to: e.toISOString() }; }
    case 'last_7d': case 'last_7':
      { const d = new Date(now); d.setDate(d.getDate() - 7); return { from: d.toISOString(), to: now.toISOString() }; }
    case 'last_30d': case 'last_30':
      { const d = new Date(now); d.setDate(d.getDate() - 30); return { from: d.toISOString(), to: now.toISOString() }; }
    case 'last_90d': case 'last_90':
      { const d = new Date(now); d.setDate(d.getDate() - 90); return { from: d.toISOString(), to: now.toISOString() }; }
    case 'this_quarter':
      { const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1); return { from: qStart.toISOString(), to: now.toISOString() }; }
    case 'this_year':
      { return { from: new Date(now.getFullYear(), 0, 1).toISOString(), to: now.toISOString() }; }
    case 'last_year':
      { return { from: new Date(now.getFullYear() - 1, 0, 1).toISOString(), to: new Date(now.getFullYear(), 0, 1).toISOString() }; }
    case 'all_time': case 'all':
      return { from: '2000-01-01', to: now.toISOString() };
    case 'this_month':
    default:
      return { from: startOfMonth.toISOString(), to: now.toISOString() };
  }
}

function _customRange(opts) {
  const o = opts || {};
  if (o.from && o.to) return { from: new Date(o.from).toISOString(), to: new Date(o.to).toISOString() };
  // FIN_RANGE_FIX_v1 — the admin UI sends { range: '<token>' }, not { period }.
  // Reading only o.period made every preset silently fall back to this_month.
  return _periodToRange(o.range || o.period);
}

/* ---------- 1. OVERVIEW ---------- */
async function api_saas_finance_overview(token, opts) {
  await requireFullAdmin(token);
  const { from, to } = _customRange(opts);

  // Total revenue in period (paid invoices)
  const rev = await control.query(
    `SELECT COALESCE(SUM(i.total_inr), 0)::numeric AS revenue,
            COUNT(*)::int AS invoices
       FROM invoices i LEFT JOIN tenants t ON t.id = i.tenant_id
      WHERE i.status = 'paid'
        AND COALESCE(i.paid_at, i.updated_at) >= $1
        AND COALESCE(i.paid_at, i.updated_at) <  $2
        AND COALESCE(t.tenant_type, 'live') <> 'demo'`,
    [from, to]
  );

  // Outstanding (pending invoices regardless of date)
  const due = await control.query(
    `SELECT COALESCE(SUM(total_inr), 0)::numeric AS outstanding,
            COUNT(*)::int AS pending_invoices
       FROM invoices WHERE status = 'pending'`
  );

  // Tenant counts
  const tCounts = await control.query(
    `SELECT status, COUNT(*)::int AS n FROM tenants GROUP BY status`
  );
  const byStatus = {};
  let active = 0, trial = 0;
  for (const r of tCounts.rows) {
    byStatus[r.status] = r.n;
    if (r.status === 'active') active = r.n;
    if (r.status === 'trial' || r.status === 'trialing') trial += r.n;
  }

  // MRR — sum of currently-active tenants' package prices, normalised to monthly
  // (packages table uses recurring_period: month|quarter|year|lifetime + recurring_period_count)
  const mrr = await control.query(
    `SELECT COALESCE(SUM(
        CASE
          WHEN COALESCE(p.recurring_period, 'month') = 'year'    THEN p.base_price_inr / (12.0 * GREATEST(COALESCE(p.recurring_period_count, 1), 1))
          WHEN COALESCE(p.recurring_period, 'month') = 'quarter' THEN p.base_price_inr / (3.0  * GREATEST(COALESCE(p.recurring_period_count, 1), 1))
          WHEN COALESCE(p.recurring_period, 'month') = 'lifetime' THEN 0
          ELSE p.base_price_inr / GREATEST(COALESCE(p.recurring_period_count, 1), 1)
        END
       ), 0)::numeric AS mrr
       FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
      WHERE t.status IN ('active','past_due')`
  ).catch(() => ({ rows: [{ mrr: 0 }] }));

  // Refunds in period
  const ref = await control.query(
    `SELECT COALESCE(SUM(amount_inr), 0)::numeric AS refunds, COUNT(*)::int AS n
       FROM payments
      WHERE status = 'refunded' AND COALESCE(updated_at, created_at) >= $1 AND COALESCE(updated_at, created_at) < $2`,
    [from, to]
  ).catch(() => ({ rows: [{ refunds: 0, n: 0 }] }));

  // Expiring soon (within next 30 days)
  const exp = await control.query(
    `SELECT COUNT(*)::int AS n FROM tenants
      WHERE status IN ('active','trialing','past_due')
        AND current_period_end IS NOT NULL
        AND current_period_end <= NOW() + INTERVAL '30 days'
        AND current_period_end >= NOW() - INTERVAL '7 days'`
  ).catch(() => ({ rows: [{ n: 0 }] }));

  return {
    range: { from, to, period: (opts || {}).period || 'this_month' },
    revenue:          Number(rev.rows[0].revenue) || 0,
    invoices_paid:    rev.rows[0].invoices || 0,
    outstanding:      Number(due.rows[0].outstanding) || 0,
    pending_invoices: due.rows[0].pending_invoices || 0,
    mrr:              Number(mrr.rows[0].mrr) || 0,
    arr:              (Number(mrr.rows[0].mrr) || 0) * 12,
    refunds:          Number(ref.rows[0].refunds) || 0,
    refund_count:     ref.rows[0].n || 0,
    tenants_total:    Object.values(byStatus).reduce((a, b) => a + b, 0),
    tenants_active:   active,
    tenants_trial:    trial,
    tenants_by_status: byStatus,
    expiring_30d:     exp.rows[0].n || 0
  };
}

/* ---------- 2. REVENUE BY MONTH (chart) ---------- */
async function api_saas_finance_revenueByMonth(token, opts) {
  await requireFullAdmin(token);
  const months = Math.min(parseInt((opts || {}).months || 12, 10) || 12, 24);
  const r = await control.query(
    `SELECT to_char(date_trunc('month', COALESCE(paid_at, updated_at)), 'YYYY-MM') AS month,
            COALESCE(SUM(total_inr), 0)::numeric AS revenue,
            COUNT(*)::int AS invoices
       FROM invoices
      WHERE status = 'paid'
        AND COALESCE(paid_at, updated_at) >= NOW() - ($1 || ' months')::interval
      GROUP BY 1
      ORDER BY 1 ASC`,
    [String(months)]
  );
  return { months: r.rows.map(x => ({ month: x.month, revenue: Number(x.revenue) || 0, invoices: x.invoices })) };
}

/* ---------- 3. BY PACKAGE ---------- */
async function api_saas_finance_byPackage(token, opts) {
  await requireFullAdmin(token);
  const { from, to } = _customRange(opts);
  const r = await control.query(
    `SELECT p.id, p.name AS package_name, p.base_price_inr AS price_inr,
            COUNT(DISTINCT t.id)::int AS tenants,
            COALESCE(SUM(CASE WHEN i.status = 'paid' AND COALESCE(i.paid_at, i.updated_at) >= $1 AND COALESCE(i.paid_at, i.updated_at) < $2 THEN i.total_inr ELSE 0 END), 0)::numeric AS revenue,
            COUNT(DISTINCT CASE WHEN i.status = 'paid' AND COALESCE(i.paid_at, i.updated_at) >= $1 AND COALESCE(i.paid_at, i.updated_at) < $2 THEN i.id END)::int AS invoices_paid
       FROM packages p
       LEFT JOIN tenants  t ON t.package_id = p.id AND t.status IN ('active','trialing','past_due')
       LEFT JOIN invoices i ON i.package_id = p.id
      GROUP BY p.id, p.name, p.base_price_inr
      ORDER BY revenue DESC, tenants DESC`,
    [from, to]
  );
  return { items: r.rows.map(x => ({
    id: x.id, package_name: x.package_name, price_inr: Number(x.price_inr) || 0,
    tenants: x.tenants || 0, revenue: Number(x.revenue) || 0, invoices_paid: x.invoices_paid || 0
  })) };
}

/* ---------- 4. EXPIRING SOON ---------- */
async function api_saas_finance_expiringSoon(token, opts) {
  await requireFullAdmin(token);
  const days = Math.min(parseInt((opts || {}).days || 30, 10) || 30, 365);
  const r = await control.query(
    `SELECT t.id, t.slug, t.org_name, t.contact_name, t.contact_email, t.contact_mobile,
            t.status, t.current_period_end,
            p.name AS package_name, p.base_price_inr AS price_inr,
            EXTRACT(DAY FROM (t.current_period_end - NOW()))::int AS days_left
       FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
      WHERE t.status IN ('active','trialing','past_due')
        AND t.current_period_end IS NOT NULL
        AND t.current_period_end <= NOW() + ($1 || ' days')::interval
      ORDER BY t.current_period_end ASC
      LIMIT 200`,
    [String(days)]
  );
  return { items: r.rows };
}

/* ---------- 5. TENANTS LIST (enriched with revenue) ---------- */
async function api_saas_finance_tenantsList(token, opts) {
  await requireFullAdmin(token);
  const { from, to } = _customRange(opts);
  const r = await control.query(
    `SELECT t.id, t.slug, t.org_name, t.contact_email, t.contact_mobile,
            t.status, t.current_period_end, t.created_at,
            p.name AS package_name, p.base_price_inr AS price_inr,
            COALESCE(SUM(CASE WHEN i.status = 'paid' AND COALESCE(i.paid_at, i.updated_at) >= $1 AND COALESCE(i.paid_at, i.updated_at) < $2 THEN i.total_inr ELSE 0 END), 0)::numeric AS revenue_period,
            COALESCE(SUM(CASE WHEN i.status = 'paid' THEN i.total_inr ELSE 0 END), 0)::numeric AS revenue_lifetime,
            COALESCE(SUM(CASE WHEN i.status = 'pending' THEN i.total_inr ELSE 0 END), 0)::numeric AS outstanding
       FROM tenants t
       LEFT JOIN packages p ON p.id = t.package_id
       LEFT JOIN invoices i ON i.tenant_id = t.id
      GROUP BY t.id, p.name, p.base_price_inr
      ORDER BY revenue_period DESC, t.created_at DESC
      LIMIT 500`,
    [from, to]
  );
  return { items: r.rows.map(x => ({
    ...x,
    revenue_period: Number(x.revenue_period) || 0,
    revenue_lifetime: Number(x.revenue_lifetime) || 0,
    outstanding: Number(x.outstanding) || 0,
    price_inr: Number(x.price_inr) || 0
  })) };
}

module.exports = {
  api_saas_finance_overview,
  api_saas_finance_revenueByMonth,
  api_saas_finance_byPackage,
  api_saas_finance_expiringSoon,
  api_saas_finance_tenantsList
};
