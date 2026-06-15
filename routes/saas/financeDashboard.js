/**
 * FIN_DASH_v1 (2026-06-04) — Finance & Business Dashboard for super-admin.
 *
 * One module that answers "how is the business doing?" against the live
 * control DB. All numbers are computed on-the-fly from tenants / packages /
 * invoices — nothing is pre-aggregated, so the dashboard always reflects
 * the current state.
 *
 * APIs exported:
 *   api_saas_finance_overview        — KPI cards (MRR, ARR, revenue this
 *                                      month, lifetime, new signups,
 *                                      expiring, churned, pending dues)
 *   api_saas_finance_tenantSales     — per-tenant sale table (sort/filter)
 *   api_saas_finance_revenueByMonth  — last 12 months revenue line chart
 *   api_saas_finance_byPackage       — tenant + revenue split by package
 *   api_saas_finance_byStatus        — tenant count by lifecycle status
 *   api_saas_finance_expiringSoon    — tenants expiring in next 30 days
 *   api_saas_finance_overdueInvoices — invoices pending past period_end
 *
 * Auth: requireSuperAdmin.
 *
 * MRR math — packages.recurring_period in {month,quarter,year,lifetime}:
 *   month   → price / count        quarter → price / (3 * count)
 *   year    → price / (12 * count) lifetime → 0 (no recurring revenue)
 * Only tenants with status IN ('active','past_due') contribute.
 */

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

function _safeNum(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : (dflt || 0); }

function _monthlyFromPackage(pkg) {
  if (!pkg) return 0;
  if (Number(pkg.is_lifetime) === 1) return 0;
  const period = String(pkg.recurring_period || 'month').toLowerCase();
  const count  = Math.max(1, _safeNum(pkg.recurring_period_count, 1));
  const price  = _safeNum(pkg.base_price_inr, 0);
  if (price <= 0) return 0;
  if (period === 'month')   return price / count;
  if (period === 'quarter') return price / (3 * count);
  if (period === 'year')    return price / (12 * count);
  return 0;
}

// ---- 1. Overview KPI cards ------------------------------------------
async function api_saas_finance_overview(token, payload) {
  await requireSuperAdmin(token);
  const _rng = _resolveRange(payload);

  const tRes = await control.query(`
    SELECT t.id, t.slug, t.org_name, t.status, t.created_at,
           t.current_period_start, t.current_period_end, t.pending_delete_at,
           p.id AS pkg_id, p.name AS pkg_name, p.base_price_inr,
           p.recurring_period, p.recurring_period_count, p.is_lifetime
      FROM tenants t
      LEFT JOIN packages p ON p.id = t.package_id
  `);
  const tenants = tRes.rows;

  const now    = new Date();
  // Period boundaries for revenue (driven by date-range picker)
  const periodStart = _rng.from;
  const periodEnd   = _rng.to;
  const prevStart   = _rng.prevFrom;
  const prevEnd     = _rng.prevTo;
  // Calendar-month boundaries — kept for tenant-cohort metrics (new this month, churned)
  const monStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const in7      = new Date(now.getTime() + 7  * 86400e3);
  const in30     = new Date(now.getTime() + 30 * 86400e3);

  let mrr = 0;
  let activeCount = 0, trialCount = 0, pastDueCount = 0;
  let suspendedCount = 0, pendingDeleteCount = 0, deletedCount = 0;
  let newThisMonth = 0;
  let expiredThisMonth = 0;
  let expiringNext7 = 0, expiringNext30 = 0;
  let churnedThisMonth = 0;
  let totalRecurringTenants = 0;

  for (const t of tenants) {
    const created = t.created_at ? new Date(t.created_at) : null;
    if (created && created >= monStart && created < monEnd) newThisMonth++;

    if (t.status === 'active')         activeCount++;
    else if (t.status === 'trial')     trialCount++;
    else if (t.status === 'past_due')  pastDueCount++;
    else if (t.status === 'suspended') suspendedCount++;
    else if (t.status === 'pending_delete') pendingDeleteCount++;
    else if (t.status === 'deleted')   deletedCount++;

    if ((t.status === 'pending_delete' || t.status === 'suspended' || t.status === 'deleted')
        && t.pending_delete_at) {
      const pd = new Date(t.pending_delete_at);
      if (pd >= monStart && pd < monEnd) churnedThisMonth++;
    }

    if (t.status === 'active' || t.status === 'past_due') {
      const pkg = { base_price_inr: t.base_price_inr, recurring_period: t.recurring_period,
                    recurring_period_count: t.recurring_period_count, is_lifetime: t.is_lifetime };
      const m = _monthlyFromPackage(pkg);
      if (m > 0) { mrr += m; totalRecurringTenants++; }
    }

    if (t.current_period_end) {
      const exp = new Date(t.current_period_end);
      if (exp >= monStart && exp < monEnd && t.status !== 'active' && t.status !== 'trial') {
        expiredThisMonth++;
      }
      if (t.status === 'active' || t.status === 'past_due') {
        if (exp >= now && exp <= in7)  expiringNext7++;
        if (exp >= now && exp <= in30) expiringNext30++;
      }
    }
  }

  const invRes = await control.query(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' THEN total_inr ELSE 0 END), 0)::numeric        AS lifetime_paid,
      COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= $1 AND paid_at < $2 THEN total_inr ELSE 0 END), 0)::numeric AS period_paid,
      COALESCE(SUM(CASE WHEN status = 'paid' AND paid_at >= $3 AND paid_at < $4 THEN total_inr ELSE 0 END), 0)::numeric AS prev_period_paid,
      COUNT(*) FILTER (WHERE status = 'paid')::int    AS paid_count,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN total_inr ELSE 0 END), 0)::numeric     AS pending_total,
      COUNT(*) FILTER (WHERE status = 'pending' AND period_end < NOW())::int AS overdue_count,
      COALESCE(SUM(CASE WHEN status = 'pending' AND period_end < NOW() THEN total_inr ELSE 0 END), 0)::numeric AS overdue_total,
      COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed_count
    FROM invoices
  `, [periodStart, periodEnd, prevStart, prevEnd]);
  const inv = invRes.rows[0] || {};

  const periodPaid = _safeNum(inv.period_paid);
  const prevPaid   = _safeNum(inv.prev_period_paid);
  const deltaPct = prevPaid > 0 ? ((periodPaid - prevPaid) / prevPaid) * 100 : null;

  return {
    generated_at: now.toISOString(),
    period: {
      from:  periodStart.toISOString(),
      to:    periodEnd.toISOString(),
      label: _rng.label,
      token: _rng.token,
      prev_from: prevStart.toISOString(),
      prev_to:   prevEnd.toISOString()
    },
    revenue: {
      mrr:           Math.round(mrr * 100) / 100,
      arr:           Math.round(mrr * 12 * 100) / 100,
      lifetime_paid: _safeNum(inv.lifetime_paid),
      period_paid:   periodPaid,
      prev_paid:     prevPaid,
      delta_pct:     deltaPct == null ? null : Math.round(deltaPct * 10) / 10,
      // back-compat fields so anything reading the old keys still works
      this_month:    periodPaid,
      last_month:    prevPaid,
      mom_pct:       deltaPct == null ? null : Math.round(deltaPct * 10) / 10,
      paying_tenants: totalRecurringTenants
    },
    tenants: {
      total:           tenants.length,
      active:          activeCount,
      trial:           trialCount,
      past_due:        pastDueCount,
      suspended:       suspendedCount,
      pending_delete:  pendingDeleteCount,
      deleted:         deletedCount,
      new_this_month:  newThisMonth,
      churned_this_month: churnedThisMonth,
      expired_this_month: expiredThisMonth,
      expiring_in_7:   expiringNext7,
      expiring_in_30:  expiringNext30
    },
    invoices: {
      paid_count:     _safeNum(inv.paid_count),
      pending_count:  _safeNum(inv.pending_count),
      pending_total:  _safeNum(inv.pending_total),
      overdue_count:  _safeNum(inv.overdue_count),
      overdue_total:  _safeNum(inv.overdue_total),
      failed_count:   _safeNum(inv.failed_count)
    }
  };
}

// ---- 2. Tenant-wise sale table --------------------------------------
async function api_saas_finance_tenantSales(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  // FIN_DASH_DATE_FIX_v1 (2026-06-15) — honor the date range picker
  // so per-tenant rows show period_paid + period_paid_count + period_pending
  // alongside the lifetime totals. Without this the table looked identical
  // whether the user picked Today, This week, or All time.
  const _rng = _resolveRange(f);
  const where = [];
  const params = [_rng.from, _rng.to]; // $1, $2 always used by period_* subqueries
  if (f.status)    { params.push(f.status);             where.push(`t.status = $${params.length}`); }
  if (f.package_id){ params.push(Number(f.package_id)); where.push(`t.package_id = $${params.length}`); }
  if (f.q) {
    params.push('%' + String(f.q).toLowerCase() + '%');
    where.push(`(LOWER(t.org_name) LIKE $${params.length} OR LOWER(t.contact_email) LIKE $${params.length} OR t.slug LIKE $${params.length})`);
  }
  const r = await control.query(`
    SELECT t.id, t.slug, t.org_name, t.contact_email, t.status,
           t.created_at, t.current_period_start, t.current_period_end,
           p.id AS pkg_id, p.name AS pkg_name, p.base_price_inr,
           p.recurring_period, p.recurring_period_count, p.is_lifetime,
           COALESCE((SELECT SUM(total_inr) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'paid'), 0)::numeric AS lifetime_paid,
           COALESCE((SELECT COUNT(*)       FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'paid'), 0)::int     AS paid_count,
           COALESCE((SELECT SUM(total_inr) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'paid' AND paid_at >= $1 AND paid_at < $2), 0)::numeric AS period_paid,
           COALESCE((SELECT COUNT(*)       FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'paid' AND paid_at >= $1 AND paid_at < $2), 0)::int     AS period_paid_count,
           COALESCE((SELECT SUM(total_inr) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'pending'), 0)::numeric AS pending_total,
           (SELECT MAX(paid_at) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'paid') AS last_paid_at
      FROM tenants t
      LEFT JOIN packages p ON p.id = t.package_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY period_paid DESC, lifetime_paid DESC, t.created_at DESC
  `, params);

  const now = Date.now();
  const rows = r.rows.map(row => {
    const monthly = _monthlyFromPackage({
      base_price_inr: row.base_price_inr,
      recurring_period: row.recurring_period,
      recurring_period_count: row.recurring_period_count,
      is_lifetime: row.is_lifetime
    });
    const exp = row.current_period_end ? new Date(row.current_period_end).getTime() : null;
    const daysToExpiry = exp == null ? null : Math.round((exp - now) / 86400e3);
    return {
      id: row.id, slug: row.slug, org_name: row.org_name, contact_email: row.contact_email,
      status: row.status, package: row.pkg_name || null, package_id: row.pkg_id || null,
      monthly_value: Math.round(monthly * 100) / 100,
      annual_value:  Math.round(monthly * 12 * 100) / 100,
      lifetime_paid:     _safeNum(row.lifetime_paid),
      paid_count:        _safeNum(row.paid_count),
      period_paid:       _safeNum(row.period_paid),       // FIN_DASH_DATE_FIX_v1
      period_paid_count: _safeNum(row.period_paid_count),
      pending_total:     _safeNum(row.pending_total),
      last_paid_at:      row.last_paid_at,
      created_at:        row.created_at,
      current_period_end: row.current_period_end,
      days_to_expiry:    daysToExpiry
    };
  });
  return {
    rows,
    total: rows.length,
    period: { from: _rng.from.toISOString(), to: _rng.to.toISOString(), label: _rng.label, token: _rng.token }
  };
}

// ---- 3. Revenue by month (last 12) -----------------------------------
async function api_saas_finance_revenueByMonth(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', NOW()) - INTERVAL '11 months',
        date_trunc('month', NOW()),
        INTERVAL '1 month'
      ) AS m
    )
    SELECT TO_CHAR(months.m, 'YYYY-MM') AS month,
           COALESCE(SUM(i.total_inr) FILTER (WHERE i.status = 'paid'), 0)::numeric AS paid_total,
           COUNT(i.id) FILTER (WHERE i.status = 'paid')::int                       AS paid_count
      FROM months
      LEFT JOIN invoices i ON date_trunc('month', i.paid_at) = months.m AND i.status = 'paid'
     GROUP BY months.m ORDER BY months.m ASC
  `);
  return { rows: r.rows.map(x => ({
    month: x.month, paid_total: _safeNum(x.paid_total), paid_count: _safeNum(x.paid_count)
  })) };
}

// ---- 4. By package ---------------------------------------------------
async function api_saas_finance_byPackage(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`
    SELECT p.id, p.name, p.base_price_inr, p.recurring_period, p.recurring_period_count, p.is_lifetime,
           COUNT(t.id)::int                                                                                  AS tenant_count,
           COUNT(t.id) FILTER (WHERE t.status = 'active')::int                                               AS active_count,
           COUNT(t.id) FILTER (WHERE t.status = 'trial')::int                                                AS trial_count,
           COUNT(t.id) FILTER (WHERE t.status = 'past_due')::int                                             AS past_due_count,
           COALESCE((SELECT SUM(i.total_inr) FROM invoices i WHERE i.package_id = p.id AND i.status = 'paid'), 0)::numeric AS lifetime_paid
      FROM packages p
      LEFT JOIN tenants t ON t.package_id = p.id
     GROUP BY p.id ORDER BY tenant_count DESC, p.name ASC
  `);
  return { rows: r.rows.map(row => {
    const monthly = _monthlyFromPackage(row);
    const billing = _safeNum(row.active_count) + _safeNum(row.past_due_count);
    return {
      id: row.id, name: row.name,
      tenant_count:   _safeNum(row.tenant_count),
      active_count:   _safeNum(row.active_count),
      trial_count:    _safeNum(row.trial_count),
      past_due_count: _safeNum(row.past_due_count),
      lifetime_paid:  _safeNum(row.lifetime_paid),
      monthly_per_tenant: Math.round(monthly * 100) / 100,
      mrr_contribution:   Math.round(monthly * billing * 100) / 100
    };
  }) };
}

// ---- 5. By status ---------------------------------------------------
async function api_saas_finance_byStatus(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`
    SELECT status, COUNT(*)::int AS n FROM tenants GROUP BY status ORDER BY n DESC
  `);
  return { rows: r.rows.map(x => ({ status: x.status, count: _safeNum(x.n) })) };
}

// ---- 6. Expiring soon ------------------------------------------------
async function api_saas_finance_expiringSoon(token, payload) {
  await requireSuperAdmin(token);
  const days = Math.max(1, Math.min(180, _safeNum((payload || {}).days, 30)));
  const r = await control.query(`
    SELECT t.id, t.slug, t.org_name, t.contact_email, t.contact_mobile, t.status,
           t.current_period_end,
           p.name AS pkg_name, p.base_price_inr,
           p.recurring_period, p.recurring_period_count, p.is_lifetime
      FROM tenants t
      LEFT JOIN packages p ON p.id = t.package_id
     WHERE t.current_period_end IS NOT NULL
       AND t.current_period_end >= NOW()
       AND t.current_period_end <= NOW() + ($1::int * INTERVAL '1 day')
       AND t.status IN ('active','past_due','trial')
     ORDER BY t.current_period_end ASC
  `, [days]);
  const now = Date.now();
  return { rows: r.rows.map(row => ({
    id: row.id, slug: row.slug, org_name: row.org_name,
    contact_email: row.contact_email, contact_mobile: row.contact_mobile,
    status: row.status, package: row.pkg_name,
    current_period_end: row.current_period_end,
    days_to_expiry: Math.round((new Date(row.current_period_end).getTime() - now) / 86400e3),
    monthly_value: Math.round(_monthlyFromPackage(row) * 100) / 100
  })) };
}

// ---- 7. Overdue invoices --------------------------------------------
async function api_saas_finance_overdueInvoices(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`
    SELECT i.id, i.number, i.tenant_id, i.total_inr, i.status,
           i.period_start, i.period_end, i.created_at,
           t.slug, t.org_name, t.contact_email
      FROM invoices i
      LEFT JOIN tenants t ON t.id = i.tenant_id
     WHERE i.status = 'pending'
       AND (i.period_end < NOW() OR (i.period_end IS NULL AND i.created_at < NOW() - INTERVAL '14 days'))
     ORDER BY i.period_end ASC NULLS LAST, i.created_at ASC
     LIMIT 200
  `);
  const now = Date.now();
  return { rows: r.rows.map(row => {
    const ref = row.period_end || row.created_at;
    const overdueDays = ref ? Math.round((now - new Date(ref).getTime()) / 86400e3) : null;
    return {
      id: row.id, number: row.number,
      tenant_slug: row.slug, tenant_name: row.org_name,
      contact_email: row.contact_email,
      total_inr: _safeNum(row.total_inr),
      period_end: row.period_end, created_at: row.created_at,
      overdue_days: overdueDays
    };
  }) };
}


// FIN_DASH_DATE_v1 (2026-06-12) — Resolve a date-range token + optional
// custom from/to into concrete UTC Date boundaries used by every API in
// this module. Tokens: today | yesterday | this_week | this_month |
// last_month | this_quarter | this_year | last_year | last_7 | last_30 |
// last_90 | all | custom. IST-based (UTC+5:30) so "Today" matches the
// operator's calendar day, not midnight UTC.
function _resolveRange(payload) {
  const p = payload || {};
  const token = String(p.range || p.preset || 'this_month').toLowerCase();
  const IST_OFFSET = 5.5 * 3600 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET);
  const y = nowIst.getUTCFullYear();
  const m = nowIst.getUTCMonth();
  const d = nowIst.getUTCDate();
  function ist(yr, mo, da) { return new Date(Date.UTC(yr, mo, da) - IST_OFFSET); }
  function midnightIstNext(date) {
    const t = new Date(date.getTime() + IST_OFFSET);
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1) - IST_OFFSET);
  }
  let from, to, label;
  switch (token) {
    case 'today':       from = ist(y, m, d);         to = ist(y, m, d + 1);  label = 'Today'; break;
    case 'yesterday':   from = ist(y, m, d - 1);     to = ist(y, m, d);      label = 'Yesterday'; break;
    case 'this_week': {
      const dow = (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Mon=0
      from = ist(y, m, d - dow); to = ist(y, m, d + 1); label = 'This week'; break;
    }
    case 'last_7':      from = ist(y, m, d - 6);     to = ist(y, m, d + 1);  label = 'Last 7 days'; break;
    case 'last_30':     from = ist(y, m, d - 29);    to = ist(y, m, d + 1);  label = 'Last 30 days'; break;
    case 'last_90':     from = ist(y, m, d - 89);    to = ist(y, m, d + 1);  label = 'Last 90 days'; break;
    case 'last_month':  from = ist(y, m - 1, 1);     to = ist(y, m, 1);      label = 'Last month'; break;
    case 'this_quarter': {
      const qm = Math.floor(m / 3) * 3;
      from = ist(y, qm, 1); to = ist(y, qm + 3, 1); label = 'This quarter'; break;
    }
    case 'this_year':   from = ist(y, 0, 1);         to = ist(y + 1, 0, 1);  label = 'This year'; break;
    case 'last_year':   from = ist(y - 1, 0, 1);     to = ist(y, 0, 1);      label = 'Last year'; break;
    case 'all':         from = new Date(2020, 0, 1); to = ist(y, m, d + 1);  label = 'All time'; break;
    case 'custom': {
      const fd = p.from ? new Date(p.from) : null;
      const td = p.to   ? new Date(p.to)   : null;
      if (fd && !isNaN(fd.getTime()) && td && !isNaN(td.getTime())) {
        from = fd; to = midnightIstNext(td); // inclusive upper bound
        label = 'Custom: ' + fd.toISOString().slice(0,10) + ' \u2192 ' + td.toISOString().slice(0,10);
      } else {
        from = ist(y, m, 1); to = ist(y, m + 1, 1); label = 'This month';
      }
      break;
    }
    case 'this_month':
    default:            from = ist(y, m, 1);         to = ist(y, m + 1, 1);  label = 'This month';
  }
  // Previous comparable window (same length, immediately before `from`)
  const len = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - len);
  const prevTo   = from;
  return { from, to, prevFrom, prevTo, label, token };
}

module.exports = {
  api_saas_finance_overview,
  api_saas_finance_tenantSales,
  api_saas_finance_revenueByMonth,
  api_saas_finance_byPackage,
  api_saas_finance_byStatus,
  api_saas_finance_expiringSoon,
  api_saas_finance_overdueInvoices
};
