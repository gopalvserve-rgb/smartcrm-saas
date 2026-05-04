const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// Timezone the user thinks of "today" in. Server runs UTC on Railway but
// our users are in India, so a lead created at 04:00 IST on Apr 26 is stored
// as 22:30 UTC on Apr 25 and was previously bucketed as Apr 25 — which made
// the date+user filter return wrong totals (e.g. "Vaibhav, yesterday" missed
// late-night leads). Convert to the configured timezone before slicing.
const REPORT_TZ = process.env.TIMEZONE || 'Asia/Kolkata';
const _tzFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});
function _tzDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  // en-CA locale formats as "YYYY-MM-DD" — perfect for string compare.
  return _tzFmt.format(d);
}

async function _visibleLeads(me) {
  const visible = await getVisibleUserIds(me);
  return (await db.getAll('leads')).filter(l => {
    if (me.role === 'admin') return true;
    if (!l.assigned_to) return false;
    return visible.includes(Number(l.assigned_to));
  });
}

async function api_reports_summary(token, filters) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);

  const statuses = await db.getAll('statuses');
  const byStatus = statuses.map(s => ({
    status: s.name, color: s.color,
    c: rows.filter(l => Number(l.status_id) === Number(s.id)).length
  }));
  const bySource = {};
  rows.forEach(l => { bySource[l.source || '—'] = (bySource[l.source || '—'] || 0) + 1; });
  const bySourceArr = Object.keys(bySource).map(k => ({ source: k, c: bySource[k] }));

  // Per-product breakdown — uses the products lookup so we show the human
  // name instead of an opaque numeric product_id. Leads without a product
  // bucket under "— None —" so they're still visible in the chart.
  const products = await db.getAll('products');
  const productById = {};
  products.forEach(p => { productById[Number(p.id)] = p; });
  const byProduct = {};
  rows.forEach(l => {
    const pid = Number(l.product_id) || 0;
    const pname = productById[pid]?.name || '— None —';
    byProduct[pname] = (byProduct[pname] || 0) + 1;
  });
  const byProductArr = Object.keys(byProduct)
    .map(k => ({ product: k, c: byProduct[k] }))
    .sort((a, b) => b.c - a.c);

  const won = rows.filter(l => {
    const s = statuses.find(x => Number(x.id) === Number(l.status_id));
    return s && s.name === 'Won';
  }).length;
  const lost = rows.filter(l => {
    const s = statuses.find(x => Number(x.id) === Number(l.status_id));
    return s && s.name === 'Lost';
  }).length;
  const newCount = rows.filter(l => {
    const s = statuses.find(x => Number(x.id) === Number(l.status_id));
    return s && s.name === 'New';
  }).length;

  const byUser = users
    .filter(u => users.find(uu => Number(uu.id) === Number(u.id)))
    .map(u => {
      const mine = rows.filter(l => Number(l.assigned_to) === Number(u.id));
      return {
        id: u.id, name: u.name, role: u.role,
        total: mine.length,
        new_leads: mine.filter(l => statuses.find(s => Number(s.id) === Number(l.status_id) && s.name === 'New')).length,
        open_leads: mine.filter(l => !statuses.find(s => Number(s.id) === Number(l.status_id) && Number(s.is_final) === 1)).length,
        won: mine.filter(l => statuses.find(s => Number(s.id) === Number(l.status_id) && s.name === 'Won')).length,
        lost: mine.filter(l => statuses.find(s => Number(s.id) === Number(l.status_id) && s.name === 'Lost')).length
      };
    }).filter(x => x.total > 0);

  const byManager = users.filter(u => u.role === 'manager').map(u => ({ name: u.name, total: 0, won: 0, lost: 0 }));
  const byTeamLeader = users.filter(u => u.role === 'team_leader').map(u => ({ name: u.name, total: 0, won: 0, lost: 0 }));

  // Scope options (non-admin users)
  const scope_options = users.filter(u => Number(u.is_active) === 1)
    .map(u => ({ id: u.id, name: u.name, role: u.role }));

  return {
    totals: { total: rows.length, new_leads: newCount, won, lost },
    by_status: byStatus, by_source: bySourceArr, by_product: byProductArr, by_user: byUser,
    by_manager: byManager, by_team_leader: byTeamLeader,
    scope_options
  };
}

/**
 * Apply the same set of filters everywhere — date range, user/role, product,
 * source, tag, custom field. Centralised so the funnel, daily breakdown, and
 * summary always agree on what's "in scope".
 */
async function _applyReportFilters(rows, filters, users) {
  filters = filters || {};
  if (filters.from) rows = rows.filter(l => _tzDate(l.created_at) >= filters.from);
  if (filters.to)   rows = rows.filter(l => _tzDate(l.created_at) <= filters.to);
  if (filters.scope_user_id) rows = rows.filter(l => Number(l.assigned_to) === Number(filters.scope_user_id));
  if (filters.role) {
    const userIds = (users || []).filter(u => u.role === filters.role).map(u => Number(u.id));
    rows = rows.filter(l => userIds.includes(Number(l.assigned_to)));
  }
  if (filters.product_id) rows = rows.filter(l => Number(l.product_id) === Number(filters.product_id));
  if (filters.source)     rows = rows.filter(l => (l.source || '') === filters.source);
  if (filters.status_id)  rows = rows.filter(l => Number(l.status_id) === Number(filters.status_id));
  // Qualified filter — lead-level boolean. '1' = qualified only, '0' = not
  // qualified. Empty/undefined = no filter (so the default behaviour is the
  // same as before this filter existed).
  if (filters.qualified === '1' || filters.qualified === 1) {
    rows = rows.filter(l => Number(l.qualified) === 1);
  } else if (filters.qualified === '0' || filters.qualified === 0) {
    rows = rows.filter(l => Number(l.qualified) !== 1);
  }
  if (filters.tag) {
    const t = String(filters.tag).toLowerCase();
    rows = rows.filter(l => String(l.tags || '').toLowerCase().split(',').map(s => s.trim()).includes(t));
  }
  if (filters.custom_key && filters.custom_value) {
    rows = rows.filter(l => {
      try {
        const extra = typeof l.extra_json === 'string' ? JSON.parse(l.extra_json) : (l.extra_json || {});
        return String(extra[filters.custom_key] || '').toLowerCase() === String(filters.custom_value).toLowerCase();
      } catch (_) { return false; }
    });
  }
  return rows;
}

async function api_reports_funnel(token, filters) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);
  const statuses = (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const counts = {}; rows.forEach(l => { const k = Number(l.status_id) || 0; counts[k] = (counts[k] || 0) + 1; });
  return statuses.map(s => ({ id: s.id, name: s.name, color: s.color, count: counts[Number(s.id)] || 0, sort_order: s.sort_order }));
}

/**
 * Per-day breakdown for the selected filters. Returns one row per day in the
 * range (including zero-count days so the chart shows a continuous line).
 *
 * Each row: { date: 'YYYY-MM-DD', total, new_leads, won, lost, open }
 *
 * If from/to aren't provided, defaults to the last 30 days based on the data
 * itself. If there's no data, returns an empty array.
 */
async function api_reports_daily(token, filters) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);
  const statuses = await db.getAll('statuses');
  const statusById = {};
  statuses.forEach(s => { statusById[Number(s.id)] = s; });
  const isFinal = (l) => {
    const s = statusById[Number(l.status_id)];
    return s && Number(s.is_final) === 1;
  };
  const isName = (l, name) => {
    const s = statusById[Number(l.status_id)];
    return s && s.name === name;
  };

  // Build the date range. Prefer filters.from/to; otherwise span the data.
  let fromDate = filters && filters.from;
  let toDate   = filters && filters.to;
  if (!fromDate || !toDate) {
    if (rows.length === 0) return [];
    const sorted = rows.map(l => _tzDate(l.created_at)).sort();
    if (!fromDate) fromDate = sorted[0];
    if (!toDate)   toDate   = sorted[sorted.length - 1];
  }

  // Bucket leads by local day (in REPORT_TZ) so a lead created at 02:00 IST
  // is counted on its IST date, not the UTC date.
  const buckets = {};
  rows.forEach(l => {
    const d = _tzDate(l.created_at);
    if (!buckets[d]) buckets[d] = { total: 0, new_leads: 0, won: 0, lost: 0, open: 0 };
    buckets[d].total++;
    if (isName(l, 'New'))  buckets[d].new_leads++;
    if (isName(l, 'Won'))  buckets[d].won++;
    if (isName(l, 'Lost')) buckets[d].lost++;
    if (!isFinal(l))       buckets[d].open++;
  });

  // Walk every day in the range so zero-count days appear as a flat zero
  const out = [];
  const start = new Date(fromDate + 'T00:00:00Z');
  const end   = new Date(toDate   + 'T00:00:00Z');
  if (isNaN(start) || isNaN(end) || start > end) return [];
  // Cap at 366 days to keep the response small even on bad input.
  const maxDays = 366;
  let count = 0;
  for (let d = new Date(start); d <= end && count < maxDays; d.setUTCDate(d.getUTCDate() + 1), count++) {
    const key = d.toISOString().slice(0, 10);
    const b = buckets[key] || { total: 0, new_leads: 0, won: 0, lost: 0, open: 0 };
    out.push(Object.assign({ date: key }, b));
  }
  return out;
}

/**
 * Returns the full list of leads matching the current report filters, with
 * lookups already resolved (status name, product name, owner name, etc.) so
 * the frontend can hand the rows directly to SheetJS / CSV with no extra API
 * calls.
 *
 * Why a dedicated endpoint instead of reusing api_leads_list?
 *   - The reports filters (role, scope_user_id, qualified, tag, custom_*)
 *     don't exist on api_leads_list and we want export+chart to agree exactly.
 *   - We want to return ALL matches (no pagination) — capped at a sane upper
 *     bound so a runaway date range can't OOM the page.
 *   - We want a fixed, export-friendly column shape (assigned_name,
 *     status_name, product_name) so the spreadsheet is readable without the
 *     user joining IDs by hand.
 */
async function api_reports_exportLeads(token, filters) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);

  const [statuses, products] = await Promise.all([
    db.getAll('statuses'), db.getAll('products')
  ]);
  const usersById = {}, statusesById = {}, productsById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });
  statuses.forEach(s => { statusesById[Number(s.id)] = s; });
  products.forEach(p => { productsById[Number(p.id)] = p; });

  // Newest first — same default the leads view uses.
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  // Hard cap to avoid pulling the entire DB if someone forgets a date range.
  // 10k leads is plenty for a quarterly export and well under the browser's
  // ability to render an XLSX in memory.
  const MAX = 10000;
  const truncated = rows.length > MAX;
  if (truncated) rows = rows.slice(0, MAX);

  const out = rows.map(l => {
    const u = usersById[Number(l.assigned_to)];
    const s = statusesById[Number(l.status_id)];
    const p = productsById[Number(l.product_id)];
    let extra = {};
    try {
      extra = typeof l.extra_json === 'string' ? JSON.parse(l.extra_json || '{}') : (l.extra_json || {});
    } catch (_) { extra = {}; }
    return {
      id: l.id,
      name: l.name || '',
      phone: l.phone || '',
      whatsapp: l.whatsapp || '',
      email: l.email || '',
      city: l.city || '',
      source: l.source || '',
      status_name: s ? s.name : '',
      product_name: p ? p.name : '',
      assigned_name: u ? u.name : '',
      qualified: Number(l.qualified) === 1 ? 'Yes' : 'No',
      tags: l.tags || '',
      gclid: l.gclid || '',
      utm_source: l.utm_source || '',
      utm_medium: l.utm_medium || '',
      utm_campaign: l.utm_campaign || '',
      utm_term: l.utm_term || '',
      utm_content: l.utm_content || '',
      next_followup_at: l.next_followup_at || '',
      created_at: l.created_at || '',
      notes: l.notes || '',
      extra
    };
  });

  return { leads: out, total: out.length, truncated, max: MAX };
}

/**
 * Aggregate filtered leads by an arbitrary dimension. Powers the Report
 * Builder tab — pick any field (built-in OR custom) and get a breakdown.
 *
 * `groupBy` accepts:
 *   - Built-in lead fields: 'status', 'source', 'product', 'assigned_to',
 *     'city', 'state', 'country', 'utm_source', 'utm_medium',
 *     'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'qualified',
 *     'is_duplicate', 'created_day', 'created_month', 'tags'
 *   - Custom fields: 'extra:<key>'  (key matches custom_fields.key)
 *
 * Returns `{ rows: [{ value, count, lead_ids }], total, dimension }` with
 * rows sorted DESC by count. Empty values bucket under "— None —" so they
 * show up in the chart instead of being silently dropped.
 *
 * `lead_ids` is included so the UI can offer a "drill in" link straight to
 * the matching leads — no need for a second round-trip.
 */
async function api_reports_groupBy(token, filters, groupBy) {
  const me = await authUser(token);
  let rows = await _visibleLeads(me);
  const users = await db.getAll('users');
  rows = await _applyReportFilters(rows, filters, users);

  const [statuses, products] = await Promise.all([
    db.getAll('statuses'), db.getAll('products')
  ]);
  const usersById = {}, statusesById = {}, productsById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });
  statuses.forEach(s => { statusesById[Number(s.id)] = s; });
  products.forEach(p => { productsById[Number(p.id)] = p; });

  const dim = String(groupBy || '').trim();
  if (!dim) throw new Error('groupBy is required');

  // Resolve the dimension into a "give me the bucket label for this lead"
  // function. Centralising this here means the chart, the table, and the
  // export all see the same bucketing logic.
  const NONE = '— None —';
  let labelFor;
  if (dim === 'status') {
    labelFor = (l) => statusesById[Number(l.status_id)]?.name || NONE;
  } else if (dim === 'source') {
    labelFor = (l) => (l.source && String(l.source).trim()) || NONE;
  } else if (dim === 'product') {
    labelFor = (l) => productsById[Number(l.product_id)]?.name || NONE;
  } else if (dim === 'assigned_to') {
    labelFor = (l) => usersById[Number(l.assigned_to)]?.name || NONE;
  } else if (dim === 'qualified') {
    labelFor = (l) => Number(l.qualified) === 1 ? 'Qualified' : 'Not qualified';
  } else if (dim === 'is_duplicate') {
    labelFor = (l) => Number(l.is_duplicate) === 1 ? 'Duplicate' : 'Unique';
  } else if (dim === 'created_day') {
    labelFor = (l) => _tzDate(l.created_at) || NONE;
  } else if (dim === 'created_month') {
    labelFor = (l) => {
      const d = _tzDate(l.created_at);
      return d ? d.slice(0, 7) : NONE;
    };
  } else if (dim === 'tags') {
    // Tags are multi-valued — explode each lead into one row per tag so the
    // total in this view can exceed the lead count (correct for tags).
    labelFor = null;
  } else if (dim.startsWith('extra:')) {
    const key = dim.slice('extra:'.length);
    labelFor = (l) => {
      let extra = l.extra_json;
      try { if (typeof extra === 'string') extra = JSON.parse(extra || '{}'); } catch (_) { extra = {}; }
      const v = (extra && extra[key] != null) ? String(extra[key]) : '';
      return v.trim() || NONE;
    };
  } else if (['city', 'state', 'country',
              'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
              'gclid', 'gad_campaignid', 'company'].includes(dim)) {
    labelFor = (l) => (l[dim] && String(l[dim]).trim()) || NONE;
  } else {
    throw new Error('Unknown groupBy dimension: ' + dim);
  }

  // Aggregate
  const buckets = {}; // label -> { count, lead_ids: [...] }
  if (dim === 'tags') {
    rows.forEach(l => {
      const tags = String(l.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      if (tags.length === 0) {
        const label = NONE;
        if (!buckets[label]) buckets[label] = { count: 0, lead_ids: [] };
        buckets[label].count++;
        buckets[label].lead_ids.push(Number(l.id));
      } else {
        tags.forEach(t => {
          if (!buckets[t]) buckets[t] = { count: 0, lead_ids: [] };
          buckets[t].count++;
          buckets[t].lead_ids.push(Number(l.id));
        });
      }
    });
  } else {
    rows.forEach(l => {
      const label = labelFor(l);
      if (!buckets[label]) buckets[label] = { count: 0, lead_ids: [] };
      buckets[label].count++;
      buckets[label].lead_ids.push(Number(l.id));
    });
  }

  const out = Object.keys(buckets)
    .map(k => ({ value: k, count: buckets[k].count, lead_ids: buckets[k].lead_ids }))
    .sort((a, b) => b.count - a.count);

  return { rows: out, total: rows.length, dimension: dim };
}

/**
 * Caller-wise follow-up breakdown — for the team-followup card on the
 * dashboard and the new "Follow-ups by caller" section on Reports.
 *
 * Returns one row per active user with:
 *   - due_today   — open follow-ups whose due_at falls on TODAY (in REPORT_TZ)
 *   - overdue     — open follow-ups whose due_at is before NOW
 *   - upcoming    — open follow-ups in the future (after today)
 *   - total_open  — sum of the three
 *
 * Visibility: admin sees everyone; manager/team_leader sees their tree
 * (via getVisibleUserIds); rank-and-file users only see themselves. The
 * counts are computed off LEAD assignment (lead.assigned_to) regardless
 * of what user_id the followup row carries — that mirrors how the chips
 * in /followups already work.
 */
async function api_reports_followupsByUser(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);

  const [users, leads, followups] = await Promise.all([
    db.getAll('users'), db.getAll('leads'), db.getAll('followups')
  ]);
  const leadsById = {};
  leads.forEach(l => { leadsById[Number(l.id)] = l; });

  // "Today" boundary — same TZ logic as the rest of reports.js so the chip
  // counts on the dashboard, on /followups, and here all agree.
  const todayStr = _tzFmt.format(new Date());
  const nowIso   = new Date().toISOString();

  // Pre-bucket every open follow-up by its assigned-user.
  // Sources: (a) followups table rows, (b) leads.next_followup_at fallback
  // for legacy rows. Same logic as api_notifications_mine — keeps numbers
  // consistent across the app.
  const seenLeadIds = new Set();
  const buckets = {}; // user_id -> { due_today, overdue, upcoming }
  function bump(userId, kind) {
    const k = Number(userId) || 0;
    if (!buckets[k]) buckets[k] = { due_today: 0, overdue: 0, upcoming: 0 };
    buckets[k][kind]++;
  }
  function classify(dueAt) {
    if (!dueAt) return null;
    const dueDay = String(dueAt).slice(0, 10);
    // _tzDate handles TZ; for the day comparison we just use the IST day
    const localDay = _tzDate(dueAt);
    if (localDay === todayStr) return 'due_today';
    if (String(dueAt) < nowIso) return 'overdue';
    return 'upcoming';
  }

  followups.forEach(f => {
    if (Number(f.is_done) === 1) return;
    if (!f.due_at) return;
    const lead = leadsById[Number(f.lead_id)];
    if (!lead) return;
    const ownerId = Number(lead.assigned_to) || 0;
    if (!ownerId) return;
    if (me.role !== 'admin' && !visible.includes(ownerId)) return;
    const kind = classify(f.due_at);
    if (kind) {
      bump(ownerId, kind);
      seenLeadIds.add(Number(f.lead_id));
    }
  });

  // Fallback — legacy leads with next_followup_at but no followup row.
  leads.forEach(l => {
    if (!l.next_followup_at) return;
    if (seenLeadIds.has(Number(l.id))) return;
    const ownerId = Number(l.assigned_to) || 0;
    if (!ownerId) return;
    if (me.role !== 'admin' && !visible.includes(ownerId)) return;
    const kind = classify(l.next_followup_at);
    if (kind) bump(ownerId, kind);
  });

  // Build the result — one row per visible active user with at least one
  // open follow-up. Users with zero counts are omitted to keep the team
  // table focused on people who actually have work to do; managers asked
  // for this so the dashboard doesn't read as a wall of zeros.
  const rows = users
    .filter(u => Number(u.is_active) === 1)
    .filter(u => me.role === 'admin' || visible.includes(Number(u.id)))
    .map(u => {
      const b = buckets[Number(u.id)] || { due_today: 0, overdue: 0, upcoming: 0 };
      return {
        user_id: u.id, name: u.name || '', role: u.role || '',
        due_today: b.due_today, overdue: b.overdue, upcoming: b.upcoming,
        total_open: b.due_today + b.overdue + b.upcoming
      };
    })
    .filter(r => r.total_open > 0)
    .sort((a, b) => (b.overdue - a.overdue) || (b.due_today - a.due_today) || (b.total_open - a.total_open));

  return rows;
}

/**
 * Caller-wise OPEN TAT violations (resolved_at IS NULL) grouped by the
 * lead's assignee. Splits by escalation level (1=L1 employee reminder,
 * 2=L2 manager, 3=L3 admin) so a manager scanning the dashboard knows
 * which reps have escalations brewing.
 *
 * Visibility: admin sees everyone; manager/team_leader sees their tree;
 * sales/employee sees only themselves. Returns one row per visible user
 * who has at least one open violation — zero-count users are filtered
 * out (same UX rule as followupsByUser).
 *
 * Each row: { user_id, name, role, l1, l2, l3, total }
 */
async function api_reports_tatViolationsByUser(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);

  const [users, leads, violations] = await Promise.all([
    db.getAll('users'),
    db.getAll('leads'),
    db.query(`SELECT * FROM tat_violations WHERE resolved_at IS NULL`).then(r => r.rows)
  ]);
  const leadsById = {};
  leads.forEach(l => { leadsById[Number(l.id)] = l; });
  const usersById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });

  const buckets = {}; // user_id -> { l1, l2, l3 }
  violations.forEach(v => {
    const lead = leadsById[Number(v.lead_id)];
    if (!lead) return;
    const ownerId = Number(lead.assigned_to) || 0;
    if (!ownerId) return;
    if (me.role !== 'admin' && !visible.includes(ownerId)) return;
    if (!buckets[ownerId]) buckets[ownerId] = { l1: 0, l2: 0, l3: 0 };
    const lvl = Number(v.escalation_level) || 1;
    if (lvl >= 3)      buckets[ownerId].l3++;
    else if (lvl === 2) buckets[ownerId].l2++;
    else                buckets[ownerId].l1++;
  });

  const rows = Object.keys(buckets).map(uid => {
    const u = usersById[Number(uid)];
    const b = buckets[uid];
    const total = b.l1 + b.l2 + b.l3;
    return {
      user_id: Number(uid),
      name: u?.name || ('User #' + uid),
      role: u?.role || '',
      l1: b.l1, l2: b.l2, l3: b.l3,
      total
    };
  })
  .filter(r => r.total > 0)
  // Sort by L3 first (most escalated), then L2, then L1, then total
  .sort((a, b) => (b.l3 - a.l3) || (b.l2 - a.l2) || (b.l1 - a.l1) || (b.total - a.total));

  return rows;
}

/**
 * Calendar event feed — powers the /calendar page (FullCalendar driven).
 *
 * Returns one event per open follow-up + one event per lead with a legacy
 * next_followup_at (no follow-up row) so nothing falls through the cracks.
 *
 * Event shape matches FullCalendar's expectations:
 *   { id, title, start, end?, color, extendedProps }
 *
 * Color rules:
 *   - overdue (due_at < now)        → red    (#ef4444)
 *   - due today                     → amber  (#f59e0b)
 *   - upcoming                      → blue   (#3b82f6)
 *   - status='done' (closed)        → green  (#10b981)  — useful in month view
 *
 * Visibility: admin sees everyone; manager/team_leader sees their tree;
 * sales sees only their assigned leads. `assigned_to` filter param lets
 * admin/manager narrow to a specific rep without changing role.
 */
async function api_calendar_events(token, opts) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const isAdmin = me.role === 'admin';
  opts = opts || {};

  const [followups, leads, users] = await Promise.all([
    db.getAll('followups'), db.getAll('leads'), db.getAll('users')
  ]);
  const leadsById = {};
  leads.forEach(l => { leadsById[Number(l.id)] = l; });
  const usersById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });

  const fromIso = opts.from ? new Date(opts.from).toISOString() : null;
  const toIso   = opts.to   ? new Date(opts.to).toISOString()   : null;
  const now     = new Date();
  const todayStr = _tzFmt.format(now);

  // Optional per-user filter (admin/manager picking a specific rep)
  const filterUserId = opts.assigned_to ? Number(opts.assigned_to) : null;

  function visibleLead(lead) {
    if (!lead) return false;
    if (filterUserId && Number(lead.assigned_to) !== filterUserId) return false;
    if (isAdmin) return true;
    return lead.assigned_to && visible.includes(Number(lead.assigned_to));
  }

  function classify(dueAt, isDone) {
    if (isDone) return { color: '#10b981', label: 'done' };
    if (!dueAt) return { color: '#94a3b8', label: 'unscheduled' };
    const dueDay = _tzDate(dueAt);
    if (dueDay === todayStr) return { color: '#f59e0b', label: 'due today' };
    if (new Date(dueAt) < now) return { color: '#ef4444', label: 'overdue' };
    return { color: '#3b82f6', label: 'upcoming' };
  }

  const events = [];
  const seenLeadIds = new Set();

  // Open & recently-done follow-ups (showing done in green helps with the
  // monthly retrospective view — "we resolved X this week")
  followups.forEach(f => {
    if (!f.due_at) return;
    if (fromIso && String(f.due_at) < fromIso) return;
    if (toIso   && String(f.due_at) > toIso)   return;
    const lead = leadsById[Number(f.lead_id)];
    if (!visibleLead(lead)) return;
    const isDone = Number(f.is_done) === 1;
    const meta = classify(f.due_at, isDone);
    const owner = usersById[Number(lead.assigned_to)];
    events.push({
      id: 'fu-' + f.id,
      title: (lead.name || 'Lead') + (f.note ? ' · ' + String(f.note).slice(0, 40) : ''),
      start: f.due_at,
      // Default 30-min block so events render cleanly in week/day views
      end: new Date(new Date(f.due_at).getTime() + 30 * 60 * 1000).toISOString(),
      color: meta.color,
      extendedProps: {
        lead_id: lead.id,
        lead_name: lead.name,
        lead_phone: lead.phone || '',
        owner_name: owner?.name || 'Unassigned',
        kind: 'followup',
        status: meta.label,
        note: f.note || '',
        is_done: isDone
      }
    });
    seenLeadIds.add(Number(lead.id));
  });

  // Legacy fallback — leads with next_followup_at but no followup row
  leads.forEach(l => {
    if (!l.next_followup_at) return;
    if (seenLeadIds.has(Number(l.id))) return;
    if (!visibleLead(l)) return;
    if (fromIso && String(l.next_followup_at) < fromIso) return;
    if (toIso   && String(l.next_followup_at) > toIso)   return;
    const meta = classify(l.next_followup_at, false);
    const owner = usersById[Number(l.assigned_to)];
    events.push({
      id: 'lead-' + l.id,
      title: l.name || 'Lead',
      start: l.next_followup_at,
      end: new Date(new Date(l.next_followup_at).getTime() + 30 * 60 * 1000).toISOString(),
      color: meta.color,
      extendedProps: {
        lead_id: l.id,
        lead_name: l.name,
        lead_phone: l.phone || '',
        owner_name: owner?.name || 'Unassigned',
        kind: 'lead-next',
        status: meta.label,
        note: '',
        is_done: false
      }
    });
  });

  return events;
}

/**
 * Caller-wise call-rating report.
 *
 * Returns one row per rep with:
 *   - total_calls    — number of recordings owned by this rep
 *   - rated_calls    — calls where a manual rating was given
 *   - avg_rating     — average of manual ratings
 *   - avg_ai_rating  — average of AI-suggested ratings (proxy for unrated calls)
 *   - r1..r5         — distribution counts (how many 1-star, 2-star, ... calls)
 *   - last_call_at   — most recent call timestamp
 *
 * Filters:
 *   - from / to       — ISO date range on lead_recordings.created_at
 *   - userId          — limit to a specific rep
 *
 * Visibility:
 *   - admin / manager  → see every rep
 *   - team_leader      → see own team (parent_id = team_leader.id)
 *   - sales            → see only own row
 */
async function api_reports_callRatingByUser(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  const where = ['lr.user_id IS NOT NULL'];
  const params = [];
  let p = 1;
  if (filters.from) { where.push(`lr.created_at >= $${p++}`); params.push(filters.from); }
  if (filters.to)   { where.push(`lr.created_at <= $${p++}`); params.push(filters.to);   }
  if (filters.userId) { where.push(`lr.user_id = $${p++}`); params.push(Number(filters.userId)); }

  // Visibility scope
  if (me.role === 'sales' || me.role === 'employee') {
    where.push(`lr.user_id = $${p++}`); params.push(me.id);
  } else if (me.role === 'team_leader') {
    where.push(`(lr.user_id = $${p} OR lr.user_id IN (SELECT id FROM users WHERE parent_id = $${p}))`);
    params.push(me.id); p++;
  }

  const sql = `
    SELECT
      lr.user_id,
      u.name AS user_name,
      u.role AS user_role,
      COUNT(*)::int                                              AS total_calls,
      COUNT(lr.rating)::int                                      AS rated_calls,
      ROUND(AVG(NULLIF(lr.rating,0))::numeric, 2)::float         AS avg_rating,
      ROUND(AVG(NULLIF(lr.ai_suggested_rating,0))::numeric, 2)::float AS avg_ai_rating,
      COUNT(*) FILTER (WHERE lr.rating = 1)::int AS r1,
      COUNT(*) FILTER (WHERE lr.rating = 2)::int AS r2,
      COUNT(*) FILTER (WHERE lr.rating = 3)::int AS r3,
      COUNT(*) FILTER (WHERE lr.rating = 4)::int AS r4,
      COUNT(*) FILTER (WHERE lr.rating = 5)::int AS r5,
      MAX(lr.created_at) AS last_call_at
    FROM lead_recordings lr
    LEFT JOIN users u ON u.id = lr.user_id
    WHERE ${where.join(' AND ')}
    GROUP BY lr.user_id, u.name, u.role
    ORDER BY total_calls DESC, avg_rating DESC NULLS LAST
  `;
  try {
    const { rows } = await db.query(sql, params);
    return rows;
  } catch (e) {
    // Most likely the rating columns aren't migrated yet on this tenant.
    if (/column .* does not exist/i.test(e.message)) {
      return { error: 'Rating columns not migrated yet — restart the service to apply schema.', rows: [] };
    }
    throw e;
  }
}

module.exports = {
  api_reports_summary, api_reports_funnel, api_reports_daily,
  api_reports_exportLeads, api_reports_groupBy,
  api_reports_followupsByUser, api_reports_tatViolationsByUser,
  api_reports_callRatingByUser,
  api_calendar_events
};
