/**
 * Monthly Target dashboard.
 *
 * Each row in monthly_targets is one (user_id, month) pair, where
 * user_id = NULL means the org-wide target. The dashboard endpoint
 * computes everything live from the leads + customer_sales + remarks
 * tables, so refreshing always shows current numbers.
 *
 * Revenue source:
 *   - If customer_sales has rows (Stockbox-style tenants) → use it.
 *   - Otherwise → sum lead.value where status name matches /won/i and
 *     last_status_change_at falls in the month (Celeste-style).
 *
 * Metrics returned (ALL the ones requested by product):
 *   revenue_achieved        — total ₹ this month so far
 *   target_remaining        — target_revenue - achieved (≥ 0)
 *   revenue_left            — same as target_remaining (alias)
 *   days_left               — remaining calendar days incl. today
 *   required_daily_target   — target_remaining / max(days_left, 1)
 *   achievement_pct         — achieved / target × 100
 *   conversion_rate         — won / total_new × 100
 *   lead_vs_sale_rate       — same as conversion_rate (alias)
 *   forecast_revenue        — (achieved / days_passed) × days_in_month
 *   weekly_trend            — array of last 4 weeks {week_start, revenue}
 *   funnel                  — count of leads in each status this month
 *                             with cumulative drop-off %
 *   ... plus rep-level breakdown when targets exist per user.
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// ---------- helpers ----------------------------------------------------

function _monthBounds(monthStr) {
  // monthStr = 'YYYY-MM'. Returns { start: 'YYYY-MM-01', end: 'YYYY-MM-DD',
  // daysInMonth, daysPassed, daysLeft } based on current date.
  const m = String(monthStr || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('month must be YYYY-MM');
  const [yr, mo] = m.split('-').map(Number);
  const start = new Date(Date.UTC(yr, mo - 1, 1));
  const end   = new Date(Date.UTC(yr, mo, 0));   // last day
  const daysInMonth = end.getUTCDate();
  const today = new Date();
  let daysPassed = daysInMonth, daysLeft = 0;
  // If we're INSIDE this month, compute live; before/after, just use month boundaries
  if (today.getUTCFullYear() === yr && today.getUTCMonth() === mo - 1) {
    const dayOfMonth = today.getUTCDate();
    daysPassed = dayOfMonth;
    daysLeft = daysInMonth - dayOfMonth + 1;  // include today as still actionable
  } else if (today < start) {
    daysPassed = 0;
    daysLeft = daysInMonth;
  }
  // Strings to use in `column::date >= $1` style queries
  const fmt = d => d.toISOString().slice(0, 10);
  return {
    month: m,
    start: fmt(start),
    end: fmt(end),
    daysInMonth, daysPassed, daysLeft
  };
}

function _inMonth(iso, monthStr) {
  return iso && String(iso).slice(0, 7) === monthStr;
}

function _weekStart(d) {
  // Monday-aligned week start, returns YYYY-MM-DD
  const x = new Date(d);
  const day = x.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);  // shift to Monday
  x.setUTCDate(x.getUTCDate() + diff);
  return x.toISOString().slice(0, 10);
}

// ---------- target CRUD ------------------------------------------------

async function api_targets_get(token, month, userId) {
  await authUser(token);
  const m = String(month || new Date().toISOString().slice(0, 7));
  const all = await db.getAll('monthly_targets');
  // user_id null → org-wide. Match on (user_id, month) pair.
  const wantUid = userId == null ? null : Number(userId);
  const row = all.find(t =>
    String(t.month) === m &&
    (wantUid == null ? (t.user_id == null) : Number(t.user_id) === wantUid)
  );
  return row || null;
}

async function api_targets_list(token, month) {
  await authUser(token);
  const m = String(month || new Date().toISOString().slice(0, 7));
  return (await db.getAll('monthly_targets'))
    .filter(t => String(t.month) === m);
}

async function api_targets_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or manager only');
  const p = payload || {};
  if (!p.month || !/^\d{4}-\d{2}$/.test(String(p.month))) throw new Error('month required (YYYY-MM)');
  const userId = (p.user_id == null || p.user_id === '') ? null : Number(p.user_id);
  const all = await db.getAll('monthly_targets');
  const existing = all.find(t =>
    String(t.month) === String(p.month) &&
    (userId == null ? (t.user_id == null) : Number(t.user_id) === userId)
  );
  const row = {
    user_id:        userId,
    month:          String(p.month),
    target_revenue: Number(p.target_revenue) || 0,
    target_leads:   Number(p.target_leads) || 0,
    target_sales:   Number(p.target_sales) || 0,
    target_calls:   Number(p.target_calls) || 0,
    notes:          p.notes || '',
    updated_at:     db.nowIso()
  };
  if (existing) {
    await db.update('monthly_targets', existing.id, row);
    return { ok: true, id: existing.id, replaced: true };
  }
  row.created_by = me.id;
  row.created_at = db.nowIso();
  const id = await db.insert('monthly_targets', row);
  return { ok: true, id, replaced: false };
}

async function api_targets_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or manager only');
  await db.query('DELETE FROM monthly_targets WHERE id = $1', [Number(id)]);
  return { ok: true };
}

// ---------- dashboard --------------------------------------------------

/**
 * The big report. Args:
 *   month: 'YYYY-MM' (defaults to current month)
 *   user_id: optional — if set, scopes the metrics to one rep. Reps can
 *     only ever see their own scope; admins/managers see any.
 */
async function api_targets_dashboard(token, month, userId) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const m = _monthBounds(month);
  const wantUid = userId == null ? null : Number(userId);
  // Reps can only see their own; admins/managers see anything they like.
  if (wantUid != null && !['admin', 'manager', 'team_leader'].includes(me.role) && Number(wantUid) !== Number(me.id)) {
    throw new Error('Forbidden');
  }
  // Default scope for non-admins is themselves; admins default to org-wide
  const scopeUid = wantUid != null ? wantUid : (me.role === 'admin' ? null : me.id);

  // ---- Pull the target row (org-wide or per-user) -------------------
  const allTargets = await db.getAll('monthly_targets');
  const target = allTargets.find(t =>
    String(t.month) === m.month &&
    (scopeUid == null ? (t.user_id == null) : Number(t.user_id) === Number(scopeUid))
  ) || null;
  const targetRevenue = target ? Number(target.target_revenue) || 0 : 0;
  const targetLeads   = target ? Number(target.target_leads)   || 0 : 0;
  const targetSales   = target ? Number(target.target_sales)   || 0 : 0;

  // ---- Pull the activity tables --------------------------------------
  const allLeads     = await db.getAll('leads');
  const allStatuses  = await db.getAll('statuses');
  const customerSales = await db.getAll('customer_sales').catch(() => []);
  const statusById   = Object.fromEntries(allStatuses.map(s => [Number(s.id), s]));
  const wonStatusIds = allStatuses
    .filter(s => /\bwon\b/i.test(String(s.name || '')))
    .map(s => Number(s.id));

  // Apply scope filter at the lead level
  const inScope = l => {
    if (scopeUid == null) {
      // org-wide: only respect visibility (admin sees all, others their tree)
      return me.role === 'admin' || (l.assigned_to && visible.includes(Number(l.assigned_to)));
    }
    return Number(l.assigned_to) === Number(scopeUid);
  };

  const scopedLeads = allLeads.filter(inScope);

  // Leads CREATED this month
  const newLeadsMonth = scopedLeads.filter(l => _inMonth(l.created_at, m.month));
  // Leads WON this month (state-change in month, not creation)
  const wonLeadsMonth = scopedLeads.filter(l =>
    wonStatusIds.includes(Number(l.status_id)) &&
    _inMonth(l.last_status_change_at || l.updated_at, m.month)
  );

  // ---- Revenue achieved ---------------------------------------------
  // Stockbox-style tenants: customer_sales has the source of truth.
  // Celeste-style: sum lead.value of Won leads in this month.
  let revenueAchieved = 0;
  let usedSalesTable = false;
  if (customerSales.length) {
    usedSalesTable = true;
    // For per-user scope, customer_sales has sold_by; for org, just by date.
    const filteredSales = customerSales
      .filter(s => _inMonth(s.sold_at, m.month))
      .filter(s => scopeUid == null ? true : Number(s.sold_by) === Number(scopeUid));
    revenueAchieved = filteredSales.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  } else {
    revenueAchieved = wonLeadsMonth.reduce((sum, l) => sum + (Number(l.value) || 0), 0);
  }

  // ---- Headline KPIs ------------------------------------------------
  const targetRemaining = Math.max(0, targetRevenue - revenueAchieved);
  const requiredDailyTarget = m.daysLeft > 0 ? targetRemaining / m.daysLeft : 0;
  const achievementPct = targetRevenue > 0 ? (revenueAchieved / targetRevenue) * 100 : null;
  const dailyAvgSoFar = m.daysPassed > 0 ? revenueAchieved / m.daysPassed : 0;
  const forecastRevenue = dailyAvgSoFar * m.daysInMonth;

  // Lead → Won conversion (same period)
  const conversionRate = newLeadsMonth.length > 0
    ? (wonLeadsMonth.length / newLeadsMonth.length) * 100
    : null;

  // ---- Weekly trend (last 4 ISO weeks) ------------------------------
  const trend = {};
  const trendStart = new Date();
  trendStart.setUTCDate(trendStart.getUTCDate() - 28);
  for (let i = 0; i < 4; i++) {
    const ws = new Date(trendStart);
    ws.setUTCDate(ws.getUTCDate() + i * 7);
    const key = _weekStart(ws);
    trend[key] = { week_start: key, revenue: 0, leads: 0, won: 0 };
  }
  // Populate from sales / leads
  if (usedSalesTable) {
    customerSales.forEach(s => {
      if (scopeUid != null && Number(s.sold_by) !== Number(scopeUid)) return;
      const wk = _weekStart(s.sold_at);
      if (trend[wk]) trend[wk].revenue += Number(s.amount) || 0;
    });
  } else {
    scopedLeads.forEach(l => {
      if (wonStatusIds.includes(Number(l.status_id))) {
        const wk = _weekStart(l.last_status_change_at || l.updated_at);
        if (trend[wk]) {
          trend[wk].revenue += Number(l.value) || 0;
          trend[wk].won++;
        }
      }
    });
  }
  scopedLeads.forEach(l => {
    const wk = _weekStart(l.created_at);
    if (trend[wk]) trend[wk].leads++;
  });
  const weeklyTrend = Object.values(trend).sort((a, b) => a.week_start.localeCompare(b.week_start));

  // ---- Funnel conversion (this month) -------------------------------
  // Counts leads CURRENTLY in each status, ordered by sort_order.
  // Drop-off % = how many fell out vs the previous stage.
  const sortedStatuses = [...allStatuses].sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const stageCounts = sortedStatuses.map(s => {
    const cnt = scopedLeads.filter(l =>
      Number(l.status_id) === Number(s.id) &&
      _inMonth(l.created_at, m.month)
    ).length;
    return { status_id: s.id, name: s.name, color: s.color, count: cnt };
  });
  // Add cumulative + drop-off pct
  const totalIn = stageCounts.reduce((sum, s) => sum + s.count, 0);
  const funnel = stageCounts.map((s, i) => {
    const prev = i > 0 ? stageCounts[i - 1].count : null;
    const dropPct = (prev != null && prev > 0) ? (1 - s.count / prev) * 100 : null;
    return Object.assign({}, s, {
      pct_of_total: totalIn > 0 ? (s.count / totalIn) * 100 : 0,
      drop_pct: dropPct
    });
  });

  // ---- Per-rep breakdown (only meaningful when org-wide) ------------
  let repBreakdown = null;
  if (scopeUid == null) {
    const users = await db.getAll('users');
    const usersById = Object.fromEntries(users.map(u => [Number(u.id), u]));
    const repIds = users
      .filter(u => Number(u.is_active) === 1 && (me.role === 'admin' || visible.includes(Number(u.id))))
      .map(u => Number(u.id));
    repBreakdown = repIds.map(uid => {
      const u = usersById[uid];
      const myLeads = scopedLeads.filter(l => Number(l.assigned_to) === uid);
      const myNew  = myLeads.filter(l => _inMonth(l.created_at, m.month));
      const myWon  = myLeads.filter(l => wonStatusIds.includes(Number(l.status_id)) && _inMonth(l.last_status_change_at || l.updated_at, m.month));
      let myRev = 0;
      if (usedSalesTable) {
        myRev = customerSales
          .filter(s => Number(s.sold_by) === uid && _inMonth(s.sold_at, m.month))
          .reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
      } else {
        myRev = myWon.reduce((sum, l) => sum + (Number(l.value) || 0), 0);
      }
      const myTarget = allTargets.find(t => Number(t.user_id) === uid && String(t.month) === m.month);
      const myTargetRev = myTarget ? Number(myTarget.target_revenue) || 0 : 0;
      return {
        user_id: uid,
        name: u.name,
        revenue_achieved: Math.round(myRev),
        target_revenue: myTargetRev,
        achievement_pct: myTargetRev > 0 ? (myRev / myTargetRev) * 100 : null,
        new_leads: myNew.length,
        won_leads: myWon.length,
        conversion_rate: myNew.length > 0 ? (myWon.length / myNew.length) * 100 : null
      };
    }).sort((a, b) => b.revenue_achieved - a.revenue_achieved);
  }

  return {
    month: m.month,
    days_in_month: m.daysInMonth,
    days_passed: m.daysPassed,
    days_left: m.daysLeft,
    scope: {
      user_id: scopeUid,
      label: scopeUid == null ? 'Org-wide' : ((await db.findById('users', scopeUid))?.name || 'User #' + scopeUid)
    },
    target: target,
    target_revenue: targetRevenue,
    target_leads: targetLeads,
    target_sales: targetSales,
    revenue_achieved: Math.round(revenueAchieved),
    target_remaining: Math.round(targetRemaining),
    revenue_left: Math.round(targetRemaining),                 // alias
    required_daily_target: Math.round(requiredDailyTarget),
    achievement_pct: achievementPct == null ? null : Math.round(achievementPct * 10) / 10,
    forecast_revenue: Math.round(forecastRevenue),
    forecast_vs_target_pct: targetRevenue > 0 ? Math.round((forecastRevenue / targetRevenue) * 1000) / 10 : null,
    new_leads: newLeadsMonth.length,
    won_leads: wonLeadsMonth.length,
    conversion_rate: conversionRate == null ? null : Math.round(conversionRate * 10) / 10,
    lead_vs_sale_rate: conversionRate == null ? null : Math.round(conversionRate * 10) / 10,
    weekly_trend: weeklyTrend,
    funnel,
    rep_breakdown: repBreakdown,
    revenue_source: usedSalesTable ? 'customer_sales' : 'won_leads'
  };
}

module.exports = {
  api_targets_get, api_targets_list, api_targets_save, api_targets_delete,
  api_targets_dashboard
};
