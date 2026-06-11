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

  // DASHBOARD_SCOPE_v1 — restrict byManager, byTeamLeader, and scope_options
  // to only the users the requester is allowed to see. Without this, every
  // role (including sales) received the full org's user list, leaking names
  // and IDs even though the underlying lead data was already scoped correctly.
  const visible = await getVisibleUserIds(me);
  const visibleSet = new Set(visible.map(Number));

  const byManager = users
    .filter(u => u.role === 'manager' && visibleSet.has(Number(u.id)))
    .map(u => ({ name: u.name, total: 0, won: 0, lost: 0 }));
  const byTeamLeader = users
    .filter(u => u.role === 'team_leader' && visibleSet.has(Number(u.id)))
    .map(u => ({ name: u.name, total: 0, won: 0, lost: 0 }));

  // Scope options — only users visible to the requester (drives the
  // "Filter by user" dropdown; admin sees everyone, manager sees their tree,
  // sales sees only themselves).
  const scope_options = users
    .filter(u => Number(u.is_active) === 1 && visibleSet.has(Number(u.id)))
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
  // Campaign filter — drives the Dashboard / Reports "by campaign" view.
  //   numeric id → leads belonging to that campaign
  //   'none'/'0' → leads NOT in any campaign (campaign_id IS NULL)
  if (filters.campaign_id !== undefined && filters.campaign_id !== '' && filters.campaign_id !== null) {
    const cid = String(filters.campaign_id);
    if (cid === 'none' || cid === '0') {
      rows = rows.filter(l => l.campaign_id == null);
    } else {
      rows = rows.filter(l => Number(l.campaign_id) === Number(cid));
    }
  }
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

// ============================================================
// AI usage report — call-recording transcription cost.
//
// The "AI usage" page under Calls in the tenant sidebar shows the
// tenant's Gemini spend on call transcription / summarisation. Each
// row in lead_recordings carries the AI cost we incurred (input +
// output tokens, USD, INR). We aggregate that over the current
// month + all-time, plus a per-rep breakdown.
// ============================================================

function _monthBoundsIso() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), next: next.toISOString(), label: now.toLocaleString('en', { month: 'long', year: 'numeric' }) };
}

async function api_reports_aiUsage(token, _opts) {
  await authUser(token);
  const m = _monthBoundsIso();

  const monthRes = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE ai_cost_inr IS NOT NULL)::int                         AS calls,
       COALESCE(SUM(duration_s) FILTER (WHERE ai_cost_inr IS NOT NULL), 0)::int     AS audio_seconds,
       COALESCE(SUM(ai_cost_inr), 0)                                                AS cost_inr_billable,
       COALESCE(SUM(ai_cost_usd), 0)                                                AS cost_usd
       FROM lead_recordings
      WHERE created_at >= $1 AND created_at < $2`,
    [m.start, m.next]
  );
  const monthRow = monthRes.rows[0] || {};

  const allRes = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE ai_cost_inr IS NOT NULL)::int                         AS calls,
       COALESCE(SUM(duration_s) FILTER (WHERE ai_cost_inr IS NOT NULL), 0)::int     AS audio_seconds,
       COALESCE(SUM(ai_cost_inr), 0)                                                AS cost_inr_billable
       FROM lead_recordings`
  );
  const allRow = allRes.rows[0] || {};

  const byUserRes = await db.query(
    `SELECT u.id, u.name AS user_name,
            COUNT(r.*)::int                              AS calls,
            COALESCE(SUM(r.duration_s), 0)::int          AS audio_seconds,
            COALESCE(SUM(r.ai_cost_inr), 0)              AS cost_inr_billable
       FROM lead_recordings r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.created_at >= $1 AND r.created_at < $2 AND r.ai_cost_inr IS NOT NULL
      GROUP BY u.id, u.name
      ORDER BY cost_inr_billable DESC NULLS LAST
      LIMIT 50`,
    [m.start, m.next]
  );

  // Run-rate forecast: cost so far / day-of-month × days-in-month.
  const now = new Date();
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const forecast = (Number(monthRow.cost_inr_billable || 0) / Math.max(1, dayOfMonth)) * daysInMonth;

  return {
    month: m.label,
    this_month: {
      calls:             Number(monthRow.calls || 0),
      audio_minutes:     Math.round(Number(monthRow.audio_seconds || 0) / 60),
      cost_inr_billable: Number(Number(monthRow.cost_inr_billable || 0).toFixed(2)),
      cost_usd:          Number(Number(monthRow.cost_usd || 0).toFixed(6)),
    },
    all_time: {
      calls:             Number(allRow.calls || 0),
      audio_minutes:     Math.round(Number(allRow.audio_seconds || 0) / 60),
      cost_inr_billable: Number(Number(allRow.cost_inr_billable || 0).toFixed(2)),
    },
    forecast_monthly_inr: Number(forecast.toFixed(2)),
    by_user: byUserRes.rows.map(r => ({
      user_name:         r.user_name || '\u2014 Unassigned \u2014',
      calls:             Number(r.calls || 0),
      audio_minutes:     Math.round(Number(r.audio_seconds || 0) / 60),
      cost_inr_billable: Number(Number(r.cost_inr_billable || 0).toFixed(2)),
    })),
  };
}

/**
 * Cost estimator — projects what N minutes of AI call analysis will
 * cost the tenant. Anchors per-minute rate on this month's actual
 * usage when available; falls back to a sane default when there's no
 * history yet.
 */
async function api_reports_aiCostEstimator(token, opts) {
  await authUser(token);
  const o = opts || {};
  const minutes = Math.max(1, Number(o.minutes || 100));
  const avgCallMinutes = Math.max(0.5, Number(o.avgCallMinutes || 5));

  const m = _monthBoundsIso();
  const r = await db.query(
    `SELECT COALESCE(SUM(ai_cost_inr), 0)        AS cost_inr,
            COALESCE(SUM(duration_s), 0)::int    AS audio_seconds
       FROM lead_recordings
      WHERE created_at >= $1 AND created_at < $2 AND ai_cost_inr IS NOT NULL`,
    [m.start, m.next]
  );
  const row = r.rows[0] || {};
  const minSoFar = Number(row.audio_seconds || 0) / 60;
  const inrSoFar = Number(row.cost_inr || 0);
  const perMinute = minSoFar > 1 ? (inrSoFar / minSoFar) : 0.40;
  const perCall   = perMinute * avgCallMinutes;

  const totalCost = perMinute * minutes;
  const calls     = Math.round(minutes / avgCallMinutes);

  const examples = [50, 100, 250, 500, 1000, 2500].map(n => ({
    label: n + ' min',
    cost_inr_billable: Number((perMinute * n).toFixed(2)),
  }));

  return {
    minutes, calls, avg_call_minutes: avgCallMinutes,
    per_minute_inr_billable: Number(perMinute.toFixed(4)),
    per_call_inr_billable:   Number(perCall.toFixed(4)),
    cost_inr_billable:       Number(totalCost.toFixed(2)),
    examples,
    derived_from: minSoFar > 1
      ? ('Anchored on this month\'s actual ' + minSoFar.toFixed(0) + ' min @ \u20b9' + perMinute.toFixed(3) + '/min')
      : 'Using default rate \u20b90.40/min \u2014 no usage history yet'
  };
}

async function api_reports_callActivity(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  // Default window: last 30 days
  const to   = filters.to   ? new Date(filters.to)   : new Date();
  const from = filters.from ? new Date(filters.from) : new Date(Date.now() - 30 * 86400 * 1000);
  const fromIso = from.toISOString();
  const toIso   = to.toISOString();

  // Visibility scope — admin/super_admin see all; managers see self+team; reps see self.
  let userScopeSql = '';
  const params = [fromIso, toIso];
  let p = 3;
  if (me.role === 'sales' || me.role === 'employee') {
    userScopeSql = ` AND user_id = $${p++}`;
    params.push(me.id);
  } else if (me.role === 'team_leader' || me.role === 'manager') {
    userScopeSql = ` AND (user_id = $${p} OR user_id IN (SELECT id FROM users WHERE parent_id = $${p}))`;
    params.push(me.id); p++;
  }
  // Optional explicit user filter
  if (filters.userId) {
    userScopeSql += ` AND user_id = $${p++}`;
    params.push(Number(filters.userId));
  }

  // Build the unified "calls" CTE. We bucket within a 5-min window to
  // dedupe ringing+ended pairs into one logical call.
  const callsCte = `
    WITH base_events AS (
      SELECT
        ce.id,
        ce.user_id,
        ce.phone,
        ce.direction,
        ce.event,
        ce.duration_s    AS evt_duration,
        ce.recording_id,
        ce.created_at,
        lr.duration_s    AS rec_duration
      FROM call_events ce
      LEFT JOIN lead_recordings lr ON lr.id = ce.recording_id
      WHERE ce.created_at >= $1 AND ce.created_at <= $2
            -- CALL_INTENT_EXCLUDE_v1 (2026-05-21): exclude push-notification
            -- "intent" events like autodial_requested / dial_requested that
            -- never resulted in an actual call. These were pre-inserted on
            -- lead-create as a recording-sync anchor but they shouldn't show
            -- up in the Call Activity totals.
            AND ce.event != 'autodial_requested'
            ${userScopeSql.replace(/user_id/g, 'ce.user_id')}
    ),
    bucketed AS (
      SELECT
        user_id,
        phone,
        date_trunc('minute', created_at) -
          ((EXTRACT(MINUTE FROM created_at)::int % 5) * INTERVAL '1 minute') AS bucket,
        -- Direction precedence: missed > out > in (so a missed call from a
        -- known number that ALSO has an outbound earlier doesn't get
        -- mis-attributed). 'unknown' last.
        (ARRAY_AGG(direction ORDER BY
          CASE direction
            WHEN 'missed'  THEN 1
            WHEN 'out'     THEN 2
            WHEN 'in'      THEN 3
            WHEN 'unknown' THEN 4
            ELSE 9
          END
        ))[1] AS direction,
        -- Talk time per call: max of recording duration (accurate) or
        -- event-reported duration; 0 means missed/no-answer.
        GREATEST(
          COALESCE(MAX(rec_duration), 0),
          COALESCE(MAX(evt_duration), 0)
        )::int AS duration_s,
        MIN(created_at) AS started_at,
        BOOL_OR(event = 'call_ended' OR recording_id IS NOT NULL) AS connected
      FROM base_events
      GROUP BY user_id, phone, bucket
    ),
    calls AS (
      SELECT
        user_id,
        phone,
        bucket,
        started_at,
        duration_s,
        connected,
        -- A call is "missed" if it never transitioned to call_ended /
        -- no recording was attached, regardless of how the row's
        -- direction column is labelled.
        CASE
          WHEN NOT connected AND direction = 'in' THEN 'missed'
          WHEN direction = 'missed'                THEN 'missed'
          ELSE COALESCE(direction, 'unknown')
        END AS direction
      FROM bucketed
      -- CALL_FILTER_v2 (2026-05-21):
      -- v1 was too aggressive — it filtered out outgoing dial-intents whose
      -- APK never reported call_ended, leaving the report at 0 (shipuncle).
      -- v2: count EVERY bucketed call (intent counts as a dial attempt).
      -- Use the separate connected_calls metric below to show how many were
      -- actually answered. This way the headline counts match what the user
      -- sees in the Recent Calls feed.
    )
  `;

  // --- Summary ---
  const summarySql = callsCte + `
    SELECT
      /* CALL_UNIQUE_v1 — totals + distinct-phone counts */
      COUNT(*)::int                                                            AS total_calls,
      COUNT(*) FILTER (WHERE direction = 'in')::int                            AS incoming,
      COUNT(*) FILTER (WHERE direction = 'out')::int                           AS outgoing,
      COUNT(*) FILTER (WHERE direction = 'missed')::int                        AS missed,
      COUNT(DISTINCT phone)::int                                               AS unique_total,
      COUNT(DISTINCT phone) FILTER (WHERE direction = 'in')::int               AS unique_incoming,
      COUNT(DISTINCT phone) FILTER (WHERE direction = 'out')::int              AS unique_outgoing,
      COUNT(DISTINCT phone) FILTER (WHERE direction = 'missed')::int           AS unique_missed,
      COUNT(*) FILTER (WHERE connected = true)::int                            AS connected_calls,
      COUNT(*) FILTER (WHERE connected = false AND direction = 'out')::int     AS unanswered_outgoing,
      COALESCE(SUM(duration_s), 0)::int                    AS total_talk_s,
      ROUND(COALESCE(AVG(NULLIF(duration_s, 0))::numeric, 0), 0)::int AS avg_talk_s,
      COUNT(DISTINCT user_id)::int                          AS total_users
    FROM calls
  `;
  const summaryRes = await db.query(summarySql, params);
  const summary = summaryRes.rows[0] || {};

  // --- byUser: per-rep breakdown with gap/idle calculations ---
  const byUserSql = callsCte + `,
    user_calls AS (
      /* CALL_UNIQUE_v1_HOTFIX — pass phone through so DISTINCT-phone counts work */
      SELECT
        user_id,
        phone,
        direction,
        duration_s,
        started_at,
        LAG(started_at) OVER (PARTITION BY user_id ORDER BY started_at) AS prev_started_at,
        LAG(duration_s) OVER (PARTITION BY user_id ORDER BY started_at) AS prev_duration_s
      FROM calls
    ),
    user_with_gaps AS (
      SELECT
        user_id, phone, direction, duration_s, started_at,
        -- Gap = seconds between end of previous call and start of this one.
        -- Cap at 1 hour so a lunch break doesn't dominate the average.
        CASE
          WHEN prev_started_at IS NULL THEN NULL
          ELSE LEAST(
            3600,
            GREATEST(0,
              EXTRACT(EPOCH FROM (started_at - prev_started_at))::int - COALESCE(prev_duration_s, 0)
            )
          )
        END AS gap_s
      FROM user_calls
    )
    SELECT
      uwg.user_id,
      u.name AS user_name,
      u.role,
      u.parent_id,
      mgr.name AS manager_name,
      COUNT(*)::int                                          AS total_calls,
      COUNT(*) FILTER (WHERE direction='in')::int            AS in_calls,
      COUNT(*) FILTER (WHERE direction='out')::int           AS out_calls,
      COUNT(*) FILTER (WHERE direction='missed')::int        AS missed_calls,
      /* CALL_UNIQUE_v1_HOTFIX */ COUNT(DISTINCT uwg.phone)::int        AS unique_phones,
      COUNT(DISTINCT uwg.phone) FILTER (WHERE direction='out')::int AS unique_out,
      COALESCE(SUM(duration_s), 0)::int                      AS talk_s,
      ROUND(COALESCE(AVG(NULLIF(duration_s, 0))::numeric, 0), 0)::int AS avg_talk_s,
      ROUND(COALESCE(AVG(gap_s)::numeric, 0), 0)::int        AS avg_gap_s,
      MAX(started_at)                                        AS last_call_at
    FROM user_with_gaps uwg
    LEFT JOIN users u   ON u.id = uwg.user_id
    LEFT JOIN users mgr ON mgr.id = u.parent_id
    GROUP BY uwg.user_id, u.name, u.role, u.parent_id, mgr.name
    ORDER BY talk_s DESC, total_calls DESC
  `;
  const byUserRes = await db.query(byUserSql, params);
  const byUser = byUserRes.rows;

  // --- byManager: team rollup ---
  const byManager = (() => {
    const map = new Map();
    byUser.forEach(u => {
      const mid = u.parent_id || 0;
      const mname = u.manager_name || (u.role === 'team_leader' || u.role === 'manager' ? u.user_name : '— No manager —');
      if (!map.has(mid)) map.set(mid, { manager_id: mid, manager_name: mname, team_size: 0, total_calls: 0, in: 0, out: 0, missed: 0, talk_s: 0 });
      const m = map.get(mid);
      m.team_size    += 1;
      m.total_calls  += u.total_calls;
      m.in           += u.in_calls;
      m.out          += u.out_calls;
      m.missed       += u.missed_calls;
      m.talk_s       += u.talk_s;
    });
    return Array.from(map.values())
      .map(m => ({ ...m, avg_talk_s: m.total_calls ? Math.round(m.talk_s / m.total_calls) : 0 }))
      .sort((a, b) => b.talk_s - a.talk_s);
  })();

  // --- Top / Bottom performers ---
  const ranked = byUser.filter(u => u.total_calls > 0);
  const topUsers    = ranked.slice(0, 5);
  const bottomUsers = ranked.slice(-5).reverse();

  // --- Daily series for trend chart ---
  const dailySql = callsCte + `
    SELECT
      date_trunc('day', started_at)::date AS day,
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE direction='in')::int            AS in_count,
      COUNT(*) FILTER (WHERE direction='out')::int           AS out_count,
      COUNT(*) FILTER (WHERE direction='missed')::int        AS missed,
      COALESCE(SUM(duration_s), 0)::int                      AS talk_s
    FROM calls
    GROUP BY day
    ORDER BY day
  `;
  const dailyRes = await db.query(dailySql, params);
  const dailySeries = dailyRes.rows;

  // Idle time = (window duration in working seconds) - talk_s - gap_s totals.
  // Simple approximation: 8-hour workday per active rep in the window.
  const days = Math.max(1, Math.ceil((to - from) / 86400000));
  const reps = ranked.length || 1;
  const workSeconds = days * 8 * 3600 * reps;
  const idle_s = Math.max(0, workSeconds - (summary.total_talk_s || 0));


  // --- Recent calls feed (like mobile dialer history) ---
  // Latest 200 events with linked lead name + recording id. Role
  // visibility already baked into params via userScopeSql.
  const recentSql = `
    SELECT ce.id, ce.lead_id, ce.user_id, ce.phone, ce.direction, ce.event,
           ce.duration_s, ce.recording_id, ce.created_at,
           l.name AS lead_name,
           u.name AS rep_name,
           r.duration_s AS rec_duration
      FROM call_events ce
      LEFT JOIN leads l ON l.id = ce.lead_id
      LEFT JOIN users u ON u.id = ce.user_id
      LEFT JOIN lead_recordings r ON r.id = ce.recording_id
     WHERE ce.created_at >= $1 AND ce.created_at <= $2
           -- CALL_INTENT_EXCLUDE_v1 — hide intent events from Recent Calls too
           AND ce.event != 'autodial_requested'
           -- CALL_RECENT_DEDUP_v2 (2026-06-03) — hide 'incoming_ringing' rows
           -- that have a paired 'call_ended' OR 'recording_saved' for the
           -- same user+phone within 10 min (call_ended) / 30 min (recording).
           -- v1 only paired with call_ended which left answered-call RINGING
           -- rows orphaned on devices (Samsung/Vivo) whose PhoneStateReceiver
           -- dies between RINGING and IDLE — the recording is the only proof
           -- the call was answered, so the recording_saved row is the anchor.
           AND NOT (
             ce.event = 'incoming_ringing' AND (
               EXISTS (
                 SELECT 1 FROM call_events ce2
                  WHERE ce2.user_id = ce.user_id
                    AND ce2.phone   = ce.phone
                    AND ce2.event   = 'call_ended'
                    AND ce2.created_at BETWEEN ce.created_at AND ce.created_at + INTERVAL '10 minutes'
               )
               OR EXISTS (
                 SELECT 1 FROM call_events ce4
                  WHERE ce4.user_id = ce.user_id
                    AND ce4.phone   = ce.phone
                    AND ce4.event   = 'recording_saved'
                    AND ce4.created_at BETWEEN ce.created_at - INTERVAL '2 minutes'
                                           AND ce.created_at + INTERVAL '30 minutes'
               )
             )
           )
           -- CALL_RECENT_DEDUP_v1 — also collapse near-duplicate rows
           -- posted by the dual-path bridge (Native HTTP + JS broadcast).
           -- Keep the EARLIEST row per (user, phone, event) within any
           -- 12-second sliding window; drop later siblings.
           AND NOT EXISTS (
             SELECT 1 FROM call_events ce3
              WHERE ce3.user_id = ce.user_id
                AND ce3.phone   = ce.phone
                AND ce3.event   = ce.event
                AND ce3.id     < ce.id
                AND ce3.created_at >= ce.created_at - INTERVAL '12 seconds'
           )
           ${userScopeSql.replace(/user_id/g, 'ce.user_id')}
     ORDER BY ce.created_at DESC
     LIMIT 200
  `;
  const recentRes = await db.query(recentSql, params);
  const recentCalls = recentRes.rows;

    return {
    range: { from: fromIso, to: toIso, days },
    summary: { ...summary, idle_s, total_gap_s: byUser.reduce((a,u) => a + (u.avg_gap_s * u.total_calls), 0) },
    byUser,
    byManager,
    topUsers,
    bottomUsers,
    dailySeries,
    recentCalls
  };
}

/* LEAD_ACTIVITY_v1 — Activity report.
 * Returns:
 *   summary : { total, today, this_week, this_month, by_action: {...} }
 *   by_user : [ { user_id, user_name, total, today, this_week, by_action } ]
 *   by_day  : [ { day: 'YYYY-MM-DD', total, by_action: {...} } ] (last N days)
 *   grid    : [ { user_id, user_name, days: { 'YYYY-MM-DD': count } } ] (for heatmap)
 *
 * Admin / manager: sees everyone visible to them via getVisibleUserIds.
 * Rep: sees only their own activity.
 * Filters: { from, to, user_ids, action_types } — sensible defaults (last 30 days).
 */
async function api_reports_activityByUser(token, opts) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  opts = opts || {};

  // LEAD_ACTIVITY_v1 HOTFIX — use REPORT_TZ everywhere for day buckets.
  // Server runs UTC on Railway but users think in IST. Use _tzDate() (above)
  // so today / week / month all match what the user sees on their screen.
  const nowTz = _tzDate(new Date());              // 'YYYY-MM-DD' in REPORT_TZ
  const _today = new Date(nowTz + 'T00:00:00');   // midnight of TZ-today, parsed as local
  const defFromD = new Date(_today); defFromD.setDate(defFromD.getDate() - 29);
  const fromStr = (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) ? opts.from : _tzDate(defFromD);
  const toStr   = (opts.to   && /^\d{4}-\d{2}-\d{2}$/.test(opts.to))   ? opts.to   : nowTz;
  // Use a wide UTC window for the SQL to be safe across timezones:
  // start at 18:30 UTC of (fromStr - 1) and end at 18:30 UTC of toStr — covers IST midnight to midnight.
  // Simpler: use the full day in UTC, then filter by TZ-day in JS for precision.
  const fromIso = fromStr + 'T00:00:00.000Z';
  const _toEnd  = new Date(toStr + 'T00:00:00.000Z'); _toEnd.setUTCDate(_toEnd.getUTCDate() + 1);
  const toIso   = _toEnd.toISOString();
  const todayStr = nowTz;
  // Week start = Sunday of TZ-today.
  const weekStartD = new Date(_today); weekStartD.setDate(weekStartD.getDate() - weekStartD.getDay());
  const weekStartStr = _tzDate(weekStartD);
  // Month start = first of TZ-today's month.
  const monthStartStr = nowTz.slice(0, 7) + '-01';

  // User scope: rep sees only self; manager/admin sees their visible set
  let userIds = visible;
  if (Array.isArray(opts.user_ids) && opts.user_ids.length) {
    const wanted = opts.user_ids.map(x => Number(x)).filter(Boolean);
    userIds = userIds.filter(u => wanted.includes(Number(u)));
  }
  if (!userIds.length) {
    return { summary: { total: 0, today: 0, this_week: 0, this_month: 0, by_action: {} }, by_user: [], by_day: [], grid: [], from: fromStr, to: toStr };
  }

  // Action filter — exclude 'created' (not a rep activity) unless explicitly asked.
  const includeCreated = !!opts.include_created;
  const actionFilter = Array.isArray(opts.action_types) && opts.action_types.length
    ? opts.action_types.map(s => String(s))
    : null;

  let where = 'la.created_at BETWEEN $1 AND $2 AND la.user_id = ANY($3::int[])';
  const params = [fromIso, toIso, userIds];
  if (!includeCreated) {
    where += " AND la.action_type <> 'created'";
  }
  /* LEAD_ACTIVITY_v2 — exclude WhatsApp action types from the report by
   * default. Bot replies + auto-template sends + inbound messages would
   * otherwise inflate per-rep totals. Caller can pass include_whatsapp=true
   * to override (used by detailed audit views, not by the default Report). */
  const includeWhatsApp = !!opts.include_whatsapp;
  if (!includeWhatsApp) {
    where += " AND la.action_type NOT IN ('whatsapp_in', 'whatsapp_out')";
  }
  if (actionFilter) {
    params.push(actionFilter);
    where += ' AND la.action_type = ANY($' + params.length + '::text[])';
  }

  // Pull the raw rows once — we summarise in JS so the calls table
  // is not joined N times in SQL. lead_actions is light (1 row per
  // rep action) so even 30 days × 50 reps is small.
  const { rows } = await db.query(
    `SELECT la.user_id, la.action_type, la.created_at,
            u.name AS user_name, u.role AS user_role
       FROM lead_actions la
       LEFT JOIN users u ON u.id = la.user_id
      WHERE ${where}`.replace('${where}', where),
    params
  );

  const summary = { total: 0, today: 0, this_week: 0, this_month: 0, by_action: {} };
  const byUser  = {};
  const byDay   = {};
  const grid    = {};

  for (const r of rows) {
    const uid  = Number(r.user_id) || 0;
    // LEAD_ACTIVITY_v1 HOTFIX — TZ-aware day key. _tzDate() normalises both
    // a JS Date and a string to "YYYY-MM-DD" in REPORT_TZ. String compares
    // against todayStr / weekStartStr / monthStartStr then Just Work.
    const day  = _tzDate(r.created_at);
    const act  = String(r.action_type || 'other');
    // Skip rows outside the requested TZ-window (SQL used a wider UTC slice).
    if (day < fromStr || day > toStr) continue;
    summary.total += 1;
    summary.by_action[act] = (summary.by_action[act] || 0) + 1;
    if (day === todayStr)        summary.today      += 1;
    if (day >= weekStartStr)     summary.this_week  += 1;
    if (day >= monthStartStr)    summary.this_month += 1;

    if (!byUser[uid]) {
      byUser[uid] = { user_id: uid, user_name: r.user_name || '—', user_role: r.user_role || '',
                      total: 0, today: 0, this_week: 0, this_month: 0, by_action: {} };
    }
    const u = byUser[uid];
    u.total += 1;
    u.by_action[act] = (u.by_action[act] || 0) + 1;
    if (day === todayStr)     u.today      += 1;
    if (day >= weekStartStr)  u.this_week  += 1;
    if (day >= monthStartStr) u.this_month += 1;

    if (!byDay[day]) byDay[day] = { day, total: 0, by_action: {} };
    byDay[day].total += 1;
    byDay[day].by_action[act] = (byDay[day].by_action[act] || 0) + 1;

    if (!grid[uid]) grid[uid] = { user_id: uid, user_name: r.user_name || '—', days: {} };
    grid[uid].days[day] = (grid[uid].days[day] || 0) + 1;
  }

  // Fill missing days in by_day so the chart shows a full timeline.
  // LEAD_ACTIVITY_v1 HOTFIX — iterate via fromStr/toStr inclusive in YYYY-MM-DD space.
  const allDays = [];
  {
    const _f = new Date(fromStr + 'T12:00:00Z');  // mid-day UTC to dodge DST drift
    const _t = new Date(toStr   + 'T12:00:00Z');
    for (let d = new Date(_f); d <= _t; d.setUTCDate(d.getUTCDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      allDays.push(ds);
      if (!byDay[ds]) byDay[ds] = { day: ds, total: 0, by_action: {} };
    }
  }

  return {
    from: fromStr,
    to:   toStr,
    days: allDays,
    summary,
    by_user: Object.values(byUser).sort((a, b) => b.total - a.total),
    by_day:  allDays.map(d => byDay[d]),
    grid:    Object.values(grid)
  };
}

/* REPORT_BUILDER_v4 — true pivot table API.
 * Accepts row_dims[] (one or more) + metrics[] (one or more) + filters.
 * Returns one row per unique tuple of dim values, with all requested
 * metrics computed for that bucket.
 *
 * Shape:
 *   row_dims: ['status', 'source']              // multiple group-by columns
 *   metrics : ['count', 'qualified_count', ...]  // metric keys
 *   filters : { from, to, ... }                  // same as groupBy
 *
 * Returns:
 *   {
 *     row_dims, metrics,
 *     rows: [
 *       { dims: { status: 'NP', source: 'Website' }, key: 'NP||Website', metrics: { count: 12, ... } },
 *       ...
 *     ],
 *     total: <total lead count after filters>,
 *     custom_field_keys: [...]
 *   }
 */
async function api_reports_pivot(token, payload) {
  const me = await authUser(token);
  let leads = await _visibleLeads(me);
  const users = await db.getAll('users');
  const [statuses, products] = await Promise.all([db.getAll('statuses'), db.getAll('products')]);
  const usersById = {}, statusesById = {}, productsById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });
  statuses.forEach(s => { statusesById[Number(s.id)] = s; });
  products.forEach(p => { productsById[Number(p.id)] = p; });

  const p = payload || {};
  const rowDims = Array.isArray(p.row_dims) ? p.row_dims.map(String).filter(Boolean) : [];
  const metrics = Array.isArray(p.metrics) ? p.metrics.map(String).filter(Boolean) : ['count'];
  const filters = p.filters || {};
  leads = await _applyReportFilters(leads, filters, users);

  // BULK_AUDIT_HISTORY_v1 (extended) — apply rule-builder rules after the
  // standard filters. Rules may arrive as payload.rules (top-level, legacy)
  // or payload.filters.rules (new).
  const _rbRules = (Array.isArray(filters.rules) && filters.rules) || (Array.isArray(p.rules) && p.rules) || [];
  if (_rbRules.length) {
    // Build campaigns lookup (already lazily loaded later, but rules can need it now)
    let _campaignsById = {};
    try {
      const cr2 = await db.query("SELECT id, name FROM campaigns").catch(() => null);
      if (cr2 && cr2.rows) cr2.rows.forEach(rr => { _campaignsById[Number(rr.id)] = rr; });
    } catch (_) {}
    leads = _rbApplyRules(leads, _rbRules, {
      statusesById, productsById, campaignsById: _campaignsById, usersById
    });
  }

  if (!rowDims.length) throw new Error('row_dims is required (pass at least one dimension)');

  const NONE = '— None —';
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.now();
  const finalStatusIds = new Set(statuses.filter(s => Number(s.is_final) === 1).map(s => Number(s.id)));

  // Load campaigns table for 'campaign' dimension (best-effort — table may not exist on every tenant)
  let campaignsById = {};
  try {
    const cr = await db.query("SELECT id, name FROM campaigns").catch(() => null);
    if (cr && cr.rows) cr.rows.forEach(r => { campaignsById[Number(r.id)] = r; });
  } catch (_) {}

  function _dimValue(dim, l) {
    if (dim === 'status')        return statusesById[Number(l.status_id)]?.name || NONE;
    if (dim === 'source')        return (l.source && String(l.source).trim()) || NONE;
    if (dim === 'product')       return productsById[Number(l.product_id)]?.name || NONE;
    if (dim === 'assigned_to')   return usersById[Number(l.assigned_to)]?.name || NONE;
    if (dim === 'campaign')      return (campaignsById[Number(l.campaign_id)]?.name) || (l.campaign_id ? ('Campaign #' + l.campaign_id) : NONE);
    if (dim === 'qualified')     return Number(l.qualified) === 1 ? 'Qualified' : 'Not qualified';
    if (dim === 'is_duplicate')  return Number(l.is_duplicate) === 1 ? 'Duplicate' : 'Unique';
    if (dim === 'created_day')   return _tzDate(l.created_at) || NONE;
    if (dim === 'created_month') { const d = _tzDate(l.created_at); return d ? d.slice(0, 7) : NONE; }
    if (dim.startsWith('extra:')) {
      const key = dim.slice('extra:'.length);
      let extra = l.extra_json;
      try { if (typeof extra === 'string') extra = JSON.parse(extra || '{}'); } catch (_) { extra = {}; }
      const v = (extra && extra[key] != null) ? String(extra[key]) : '';
      return v.trim() || NONE;
    }
    if (['city','state','country','utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','gad_campaignid','company'].includes(dim)) {
      return (l[dim] && String(l[dim]).trim()) || NONE;
    }
    return NONE;
  }

  // Discover CF keys for the SPA to dynamically build per-CF metrics
  const cfKeys = new Set();
  leads.forEach(l => {
    let extra = l.extra_json;
    try { if (typeof extra === 'string') extra = JSON.parse(extra || '{}'); } catch (_) { extra = {}; }
    if (extra && typeof extra === 'object') Object.keys(extra).forEach(k => cfKeys.add(k));
  });
  const cfKeysList = Array.from(cfKeys);

  // Bucket — key = JSON-encoded array of dim values to avoid collisions
  const buckets = {};
  function _newBucket(dims) {
    return {
      dims, count: 0, lead_ids: [],
      qualified_count: 0, hot_count: 0, won_count: 0, lost_count: 0, open_count: 0,
      value_sum: 0, value_count_for_avg: 0,
      has_email: 0, has_phone: 0, has_whatsapp: 0,
      _emails: new Set(), _phones: new Set(), _companies: new Set(),
      recent_24h: 0, recent_7d: 0, recent_30d: 0,
      newest_ms: 0, oldest_ms: 0, _age_sum: 0, _age_n: 0,
      cf: {}
    };
  }
  function _accum(b, l) {
    b.count += 1; b.lead_ids.push(Number(l.id));
    if (Number(l.qualified) === 1) b.qualified_count += 1;
    if (Number(l.heat_score) >= 60) b.hot_count += 1;
    const isFinal = finalStatusIds.has(Number(l.status_id));
    if (isFinal && Number(l.qualified) === 1) b.won_count += 1;
    if (isFinal && Number(l.qualified) !== 1) b.lost_count += 1;
    if (!isFinal) b.open_count += 1;
    const val = Number(l.value);
    if (isFinite(val) && val > 0) { b.value_sum += val; b.value_count_for_avg += 1; }
    if (l.email)    { b.has_email += 1; b._emails.add(String(l.email).toLowerCase()); }
    if (l.phone)    { b.has_phone += 1; b._phones.add(String(l.phone).replace(/\D/g, '')); }
    if (l.whatsapp) { b.has_whatsapp += 1; }
    if (l.company)  { b._companies.add(String(l.company).toLowerCase().trim()); }
    const cMs = l.created_at ? new Date(l.created_at).getTime() : 0;
    if (cMs) {
      if (NOW - cMs <= 1 * ONE_DAY)  b.recent_24h += 1;
      if (NOW - cMs <= 7 * ONE_DAY)  b.recent_7d  += 1;
      if (NOW - cMs <= 30 * ONE_DAY) b.recent_30d += 1;
      if (cMs > b.newest_ms || b.newest_ms === 0) b.newest_ms = cMs;
      if (cMs < b.oldest_ms || b.oldest_ms === 0) b.oldest_ms = cMs;
      b._age_sum += Math.max(0, Math.floor((NOW - cMs) / ONE_DAY)); b._age_n += 1;
    }
    if (cfKeysList.length) {
      let extra = l.extra_json;
      try { if (typeof extra === 'string') extra = JSON.parse(extra || '{}'); } catch (_) { extra = {}; }
      if (extra && typeof extra === 'object') {
        cfKeysList.forEach(k => {
          const raw = extra[k];
          if (raw == null || raw === '') return;
          if (!b.cf[k]) b.cf[k] = { filled: 0, sum: 0, num_n: 0 };
          b.cf[k].filled += 1;
          const n = Number(raw);
          if (!isNaN(n)) { b.cf[k].sum += n; b.cf[k].num_n += 1; }
        });
      }
    }
  }

  leads.forEach(l => {
    const dimVals = {};
    rowDims.forEach(d => { dimVals[d] = _dimValue(d, l); });
    const key = rowDims.map(d => dimVals[d]).join('||');
    if (!buckets[key]) buckets[key] = _newBucket(dimVals);
    _accum(buckets[key], l);
  });

  const rows = Object.entries(buckets).map(([key, b]) => ({
    key, dims: b.dims,
    metrics: {
      count: b.count,
      qualified_count: b.qualified_count,
      hot_count: b.hot_count,
      won_count: b.won_count,
      lost_count: b.lost_count,
      open_count: b.open_count,
      conversion_pct: b.count > 0 ? Math.round((b.qualified_count / b.count) * 10000) / 100 : 0,
      win_pct:        b.count > 0 ? Math.round((b.won_count       / b.count) * 10000) / 100 : 0,
      value_sum: Math.round(b.value_sum * 100) / 100,
      value_avg: b.value_count_for_avg > 0 ? Math.round((b.value_sum / b.value_count_for_avg) * 100) / 100 : 0,
      has_email_count: b.has_email,
      has_phone_count: b.has_phone,
      has_whatsapp_count: b.has_whatsapp,
      distinct_emails: b._emails.size,
      distinct_phones: b._phones.size,
      distinct_companies: b._companies.size,
      recent_24h: b.recent_24h, recent_7d: b.recent_7d, recent_30d: b.recent_30d,
      newest_at: b.newest_ms ? new Date(b.newest_ms).toISOString() : null,
      oldest_at: b.oldest_ms ? new Date(b.oldest_ms).toISOString() : null,
      avg_age_days: b._age_n > 0 ? Math.round(b._age_sum / b._age_n) : 0,
      cf: b.cf
    },
    lead_ids: b.lead_ids
  })).sort((a, b) => b.metrics.count - a.metrics.count);

  return { row_dims: rowDims, metrics, rows, total: leads.length, custom_field_keys: cfKeysList };
}


/* ============================================================
 * LEAD_ACTIVITY_DRILL_v1 (2026-05-20)
 *
 * api_reports_activityDetail(token, opts)
 *
 * Drill-down for the Activity Report — given a cell coordinate
 * (user_id + action_type + scope), return the raw lead_action
 * rows so the SPA can list them in a modal. Each row enriched
 * with the lead's name + the status names for status_change
 * meta and a 1-line summary text.
 *
 * opts: {
 *   user_id:      number            // required (cell row identifies a user)
 *   action_type:  string | null     // null = all action types for that user
 *   scope:        'today' | 'this_week' | 'this_month' | 'total'  // optional
 *   from, to:     'YYYY-MM-DD'      // optional — used when scope=='total' or not given
 *   limit:        number            // default 500
 * }
 *
 * Response: {
 *   range:   { from, to },
 *   rows:    [ { id, created_at, lead_id, lead_name, action_type, summary, meta } ]
 * }
 * ============================================================ */
async function api_reports_activityDetail(token, opts) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  opts = opts || {};
  const targetUid = Number(opts.user_id);
  if (!targetUid || !visible.includes(targetUid)) {
    throw new Error('User not visible in your scope');
  }

  // Resolve date range from scope/from/to. Use REPORT_TZ-aware day buckets
  // for parity with the activity-report grid.
  const nowTz = _tzDate(new Date());
  const _today = new Date(nowTz + 'T00:00:00');
  let fromStr, toStr;
  if (opts.scope === 'today') {
    fromStr = nowTz; toStr = nowTz;
  } else if (opts.scope === 'this_week') {
    const ws = new Date(_today); ws.setDate(ws.getDate() - ws.getDay());
    fromStr = _tzDate(ws); toStr = nowTz;
  } else if (opts.scope === 'this_month') {
    fromStr = nowTz.slice(0, 7) + '-01'; toStr = nowTz;
  } else {
    // 'total' / unspecified — fall back to opts.from/to or last 30 days
    const def = new Date(_today); def.setDate(def.getDate() - 29);
    fromStr = (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) ? opts.from : _tzDate(def);
    toStr   = (opts.to   && /^\d{4}-\d{2}-\d{2}$/.test(opts.to))   ? opts.to   : nowTz;
  }
  const fromIso = fromStr + 'T00:00:00.000Z';
  const _toEnd  = new Date(toStr + 'T00:00:00.000Z'); _toEnd.setUTCDate(_toEnd.getUTCDate() + 1);
  const toIso   = _toEnd.toISOString();

  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));

  const params = [fromIso, toIso, targetUid];
  let actSql = '';
  if (opts.action_type && String(opts.action_type) !== 'all') {
    params.push(String(opts.action_type));
    actSql = ' AND la.action_type = $' + params.length;
  }
  // Exclude bot/auto WhatsApp activity from drill-down (same as the
  // main report) unless explicitly requested.
  if (!opts.include_whatsapp) {
    actSql += " AND la.action_type NOT IN ('whatsapp_in', 'whatsapp_out')";
  }
  if (!opts.include_created) {
    actSql += " AND la.action_type <> 'created'";
  }

  const sql = `
    SELECT la.id, la.created_at, la.lead_id, la.action_type, la.meta_json,
           l.name AS lead_name, l.phone AS lead_phone
      FROM lead_actions la
      LEFT JOIN leads l ON l.id = la.lead_id
     WHERE la.created_at BETWEEN $1 AND $2
       AND la.user_id = $3
       ${actSql}
     ORDER BY la.created_at DESC
     LIMIT ${limit}
  `;
  const { rows } = await db.query(sql, params);

  // Filter by TZ-day (safety against UTC bleed-over from $1/$2 wide window)
  const inRange = rows.filter(r => {
    const d = _tzDate(r.created_at);
    return d >= fromStr && d <= toStr;
  });

  // Pre-resolve statuses for nicer status_change summaries
  let statusesById = {};
  try {
    const sRows = await db.getAll('statuses');
    sRows.forEach(s => { statusesById[Number(s.id)] = s.name; });
  } catch (_) { /* tenant might not have statuses table yet */ }

  const out = inRange.map(r => {
    let meta = null;
    try { meta = r.meta_json ? (typeof r.meta_json === 'object' ? r.meta_json : JSON.parse(r.meta_json)) : null; }
    catch (_) { meta = null; }
    let summary = '';
    switch (r.action_type) {
      case 'remark':
        summary = (meta && meta.remark) ? String(meta.remark).slice(0, 200) : '(remark added)';
        break;
      case 'status_change': {
        const f = meta && meta.from_status_id ? (statusesById[Number(meta.from_status_id)] || '?') : '?';
        const t = meta && meta.to_status_id   ? (statusesById[Number(meta.to_status_id)]   || '?') : '?';
        summary = f + ' → ' + t;
        if (meta && meta.reason) summary += '  (' + meta.reason + ')';
        break;
      }
      case 'followup_set':
        summary = meta && meta.due_at ? ('due ' + String(meta.due_at).slice(0, 16).replace('T', ' ')) : '(follow-up set)';
        break;
      case 'note_updated':
        summary = meta && meta.preview ? String(meta.preview).slice(0, 200) : '(notes edited)';
        break;
      case 'assigned':
      case 'reassigned':
        summary = (meta && (meta.from !== undefined) && (meta.to !== undefined))
          ? ('user ' + (meta.from || '—') + ' → ' + (meta.to || '—'))
          : (r.action_type === 'assigned' ? '(assigned)' : '(reassigned)');
        break;
      case 'qualified':
      case 'unqualified':
        summary = r.action_type;
        break;
      case 'tags_updated':
        summary = meta && meta.tags ? ('tags: ' + String(meta.tags).slice(0, 100)) : '(tags edited)';
        break;
      default:
        summary = meta ? JSON.stringify(meta).slice(0, 120) : '';
    }
    return {
      id: r.id,
      created_at: r.created_at,
      lead_id: r.lead_id,
      lead_name: r.lead_name || '—',
      lead_phone: r.lead_phone || '',
      action_type: r.action_type,
      summary,
      meta
    };
  });

  return {
    range: { from: fromStr, to: toStr, scope: opts.scope || null },
    user_id: targetUid,
    action_type: opts.action_type || null,
    rows: out,
    total: out.length,
    truncated: out.length === limit
  };
}



// ---------------------------------------------------------------------------
// WA_REPORT_v1 (2026-05-30) — WhatsApp Report
// ---------------------------------------------------------------------------
// Volume + delivery, per-user productivity, per-template performance.
// Reads from whatsapp_messages with a date range filter. Status counts use
// the most-progressed state (read > delivered > sent > failed) per row.
// ---------------------------------------------------------------------------
async function api_reports_whatsapp(token, filters) {
  const me = await authUser(token);
  if (!(me.role === 'admin' || me.role === 'manager' || me.role === 'team_leader')) {
    throw new Error('Forbidden');
  }
  const f = filters || {};
  const tz = process.env.REPORT_TZ || 'Asia/Kolkata';
  const from = f.from || null;  // 'YYYY-MM-DD' inclusive
  const to   = f.to   || null;
  let where = ' WHERE 1=1';
  const args = [];
  if (from) { args.push(from); where += ` AND DATE(created_at AT TIME ZONE '${tz}') >= $${args.length}`; }
  if (to)   { args.push(to);   where += ` AND DATE(created_at AT TIME ZONE '${tz}') <= $${args.length}`; }

  // 1. KPI tiles + status donut
  let inbound = 0, outbound = 0;
  let sent = 0, delivered = 0, read = 0, failed = 0;
  let uniqueContacts = 0;
  try {
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'in')::int  AS inbound,
         COUNT(*) FILTER (WHERE direction = 'out')::int AS outbound,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'sent')::int      AS sent,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'delivered')::int AS delivered,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'read')::int      AS read,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'failed')::int    AS failed,
         COUNT(DISTINCT CASE WHEN direction = 'in' THEN from_number ELSE to_number END)::int AS unique_contacts
       FROM whatsapp_messages ${where}`,
      args
    );
    const row = r.rows[0] || {};
    inbound = Number(row.inbound) || 0;
    outbound = Number(row.outbound) || 0;
    sent = Number(row.sent) || 0;
    delivered = Number(row.delivered) || 0;
    read = Number(row.read) || 0;
    failed = Number(row.failed) || 0;
    uniqueContacts = Number(row.unique_contacts) || 0;
  } catch (e) { console.warn('[wa report kpi]', e.message); }

  // 2. By user
  let byUser = [];
  try {
    const r = await db.query(
      `SELECT
         user_id,
         COUNT(*) FILTER (WHERE direction = 'out')::int                          AS sent_total,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'delivered')::int AS delivered,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'read')::int      AS read,
         COUNT(*) FILTER (WHERE direction = 'out' AND status = 'failed')::int    AS failed
       FROM whatsapp_messages ${where} AND user_id IS NOT NULL
       GROUP BY user_id
       ORDER BY sent_total DESC NULLS LAST
       LIMIT 50`,
      args
    );
    const users = await db.getAll('users');
    const byId = {};
    users.forEach(u => { byId[Number(u.id)] = u; });
    byUser = r.rows.map(row => ({
      user_id: Number(row.user_id),
      name: (byId[Number(row.user_id)] && byId[Number(row.user_id)].name) || ('User #' + row.user_id),
      sent_total: Number(row.sent_total) || 0,
      delivered: Number(row.delivered) || 0,
      read: Number(row.read) || 0,
      failed: Number(row.failed) || 0
    }));
  } catch (e) { console.warn('[wa report byUser]', e.message); }

  // 3. By template — only outbound rows with a template_name
  let byTemplate = [];
  try {
    const r = await db.query(
      `SELECT
         template_name,
         COUNT(*)::int                                              AS sent_total,
         COUNT(*) FILTER (WHERE status = 'delivered')::int          AS delivered,
         COUNT(*) FILTER (WHERE status = 'read')::int               AS read,
         COUNT(*) FILTER (WHERE status = 'failed')::int             AS failed
       FROM whatsapp_messages ${where} AND direction = 'out' AND template_name IS NOT NULL AND template_name <> ''
       GROUP BY template_name
       ORDER BY sent_total DESC
       LIMIT 50`,
      args
    );
    byTemplate = r.rows.map(row => ({
      template: row.template_name,
      sent_total: Number(row.sent_total) || 0,
      delivered: Number(row.delivered) || 0,
      read: Number(row.read) || 0,
      failed: Number(row.failed) || 0
    }));
  } catch (e) { console.warn('[wa report byTemplate]', e.message); }

  // 4. Daily volume — line chart by date
  let daily = [];
  try {
    const r = await db.query(
      `SELECT
         DATE(created_at AT TIME ZONE '${tz}') AS d,
         COUNT(*) FILTER (WHERE direction = 'in')::int  AS inbound,
         COUNT(*) FILTER (WHERE direction = 'out')::int AS outbound
       FROM whatsapp_messages ${where}
       GROUP BY d
       ORDER BY d ASC`,
      args
    );
    daily = r.rows.map(row => ({
      date: String(row.d).slice(0, 10),
      inbound: Number(row.inbound) || 0,
      outbound: Number(row.outbound) || 0
    }));
  } catch (e) { console.warn('[wa report daily]', e.message); }

  return {
    kpi: { inbound, outbound, sent, delivered, read, failed, unique_contacts: uniqueContacts },
    by_user: byUser,
    by_template: byTemplate,
    daily
  };
}



module.exports = {
  api_reports_summary, api_reports_funnel, api_reports_daily,
  api_reports_exportLeads, api_reports_groupBy,
  api_reports_followupsByUser, api_reports_tatViolationsByUser,
  api_reports_callRatingByUser, api_reports_callActivity,
  api_reports_aiUsage, api_reports_aiCostEstimator,
  api_calendar_events,
  api_reports_activityByUser,
  api_reports_activityDetail,
  api_reports_pivot,
  api_reports_whatsapp
};
