const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// Follow-up lists (Overdue / Due today / Upcoming) only show leads whose
// current status is in this whitelist. Anything else (Lost, Won, Booked,
// Junk, etc.) is hidden so reps see only the live pipeline that needs
// follow-up effort. Match is case/space/punctuation-insensitive.
const FOLLOWUP_ALLOWED_STATUSES = [
  'Follow Up',
  'Visit Done',
  'Visit Schedule',
  'Re-visit',
  'Not Pick'
];
const _normStatus = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const FOLLOWUP_ALLOWED_NORM = new Set(FOLLOWUP_ALLOWED_STATUSES.map(_normStatus));

async function api_notifications_mine(token, opts) {
  // MOBILE_PERF_v1 (2026-05-30): when opts.mobile, cap each list to 20 rows,
  // scope remarks to referenced leads only (was full table scan), and cap
  // unread_notifications to last 7 days (50 rows). Drops payload from
  // ~200-500KB on busy tenants to ~15-20KB.
  const isMobile = !!(opts && opts.mobile);
  // NOTIFICATIONS_PERF_v1 (2026-05-29) — was loading EVERY row from
  // followups + leads + users + statuses on every 30s poll. On busy
  // tenants this averaged 14.5s and was a top pool blocker. Now scoped
  // to: open follow-ups + leads referenced + (small) users + statuses.
  // We still load users + statuses fully because they're tiny tables.
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  // SHOWCASE_FU_SHOWALL_v1 — on the demo tenant a config flag makes the
  // Follow-ups page/counters show EVERY user's follow-ups (not just mine),
  // so the demo always looks populated. Flag is only set on slug 'showcase'.
  let _fuShowAll = false;
  try {
    const _fc = await db.query("SELECT value FROM config WHERE key = 'FOLLOWUPS_SHOW_ALL' LIMIT 1");
    _fuShowAll = !!(_fc.rows[0] && String(_fc.rows[0].value) === '1');
  } catch (_) {}
  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const [openFollowupsRes, allUsers, allStatuses] = await Promise.all([
    // Only open follow-ups in the upcoming/overdue window matter for the
    // notification panel. Skip rows that are done, ancient, or far in
    // the future. We also pre-filter by user_id OR assigned-to scope.
    db.query(
      `SELECT id, lead_id, user_id, due_at, note, is_done
         FROM followups
        WHERE COALESCE(is_done, 0) = 0
          AND due_at IS NOT NULL
          AND due_at >= NOW() - INTERVAL '60 days'
          AND due_at <= NOW() + INTERVAL '90 days'`
    ),
    db.getAll('users'),
    db.getAll('statuses')
  ]);
  const followups = openFollowupsRes.rows;
  // Fetch only the leads referenced by those follow-ups + any with
  // their own next_followup_at in window (legacy path). Up to ~2000
  // leads in window — cheap with a single SELECT.
  const referencedLeadIds = [...new Set(followups.map(f => Number(f.lead_id)).filter(Boolean))];
  const allLeadsRes = await db.query(
    `SELECT id, name, phone, status_id, assigned_to, next_followup_at
       FROM leads
      WHERE id = ANY($1::int[])
         OR (next_followup_at IS NOT NULL
             AND next_followup_at >= NOW() - INTERVAL '60 days'
             AND next_followup_at <= NOW() + INTERVAL '90 days')`,
    [referencedLeadIds.length ? referencedLeadIds : [0]]
  );
  const allLeads = allLeadsRes.rows;
  const allFollowups = followups;
  const leadsById = {};
  allLeads.forEach(l => { leadsById[Number(l.id)] = l; });
  const usersById = {};
  allUsers.forEach(u => { usersById[Number(u.id)] = u; });
  const statusById = {};
  allStatuses.forEach(s => { statusById[Number(s.id)] = s; });
  const _isAllowedLeadStatus = (lead) => {
    if (!lead) return false;
    const s = statusById[Number(lead.status_id)];
    if (!s) return true; // No status row → don't hide. Better to show than to lose data.
    // Primary rule: anything that's NOT a final status is eligible for follow-up.
    // Final statuses (Won/Lost/Booked/Junk/Cancelled etc.) are excluded.
    if (Number(s.is_final) === 1) return false;
    return true;
  };

  // Build a map of (lead_id -> open followup) so we don't double-count when the lead
  // also has a next_followup_at that matches its open followup row.
  const followupByLead = {};
  allFollowups.forEach(f => {
    if (Number(f.is_done) === 0) followupByLead[Number(f.lead_id)] = f;
  });

  // Collect items (from followups OR from leads.next_followup_at as fallback)
  const items = [];
  // FU_REMINDER_v2 — admin must NOT see other users' follow-up reminders.
  // Only the assignee gets reminded (or self-created followup.user_id).
  const isMine = (lead) => {
    return lead && Number(lead.assigned_to) === Number(me.id);
  };
  // FU_TEAM_SCOPE_v1 — the Follow-ups PAGE passes { scope:'team' }; admins /
  // managers / team-leaders then see the whole VISIBLE team's follow-ups (not
  // just their own). Regular reps + the notification poll (no scope) are
  // unchanged, so the bell never floods an admin with everyone's reminders.
  const _visSet = Array.isArray(visible) ? new Set(visible.map(Number)) : null; // null = see all
  const _teamScope = !!(opts && opts.scope === 'team') && ['admin', 'manager', 'team_leader'].includes(String(me.role || ''));
  const _canSeeFU = (uid) => {
    if (_fuShowAll) return true;
    if (_teamScope) return (_visSet === null) ? true : _visSet.has(Number(uid));
    return Number(uid) === Number(me.id);
  };

  // From followups table — assigned to me OR for leads I can see
  allFollowups.forEach(f => {
    if (Number(f.is_done) === 1) return;
    if (!f.due_at) return;
    const lead = leadsById[Number(f.lead_id)];
    // FU_NEXT_AUTHORITATIVE_v1 — leads.next_followup_at is the current follow-up
    // (what the lead modal/dashboard/mobile all use). If the lead has one, emit it
    // from the leads path below so a STALE/out-of-window followups row can't hide the
    // lead. This one is only for leads that have NO next_followup_at (legacy rows).
    if (lead && lead.next_followup_at) return;
    const isForMe = Number(f.user_id) === Number(me.id);
    if (!_canSeeFU(f.user_id) && !_canSeeFU(lead && lead.assigned_to)) return;
    // Only show follow-ups whose current lead status is in the allowed list.
    if (!_isAllowedLeadStatus(lead)) return;
    items.push({
      id: f.id, lead_id: f.lead_id, due_at: f.due_at, note: f.note || '',
      lead_name: lead?.name || '', lead_phone: lead?.phone || '',
      assigned_to: lead?.assigned_to
    });
  });

  // Fallback: leads with next_followup_at but no matching followup row (legacy rows)
  allLeads.forEach(l => {
    if (!l.next_followup_at) return;
    if (!_canSeeFU(l.assigned_to)) return;
    if (!_isAllowedLeadStatus(l)) return;
    const _fu = followupByLead[Number(l.id)];
    items.push({
      id: _fu ? _fu.id : null, lead_id: l.id, due_at: l.next_followup_at, note: _fu ? (_fu.note || '') : '',
      lead_name: l.name || '', lead_phone: l.phone || '',
      assigned_to: l.assigned_to
    });
  });

  // Attach the latest remark per lead — used by the Follow-ups list and the
  // dashboard popup so the user sees context without opening the lead.
  // MOBILE_PERF_v1: when mobile, scope to referenced leads (and only leads
  // appearing in items) instead of `db.getAll('remarks')` full-table scan.
  const itemLeadIds = [...new Set(items.map(it => Number(it.lead_id)).filter(Boolean))];
  let allRemarks;
  if (isMobile && itemLeadIds.length) {
    const r = await db.query(
      `SELECT DISTINCT ON (lead_id) lead_id, remark, created_at
         FROM remarks
        WHERE lead_id = ANY($1::int[])
        ORDER BY lead_id, created_at DESC`,
      [itemLeadIds]
    );
    allRemarks = r.rows;
  } else {
    allRemarks = await db.getAll('remarks');
  }
  const latestByLead = {};
  allRemarks.forEach(r => {
    const lid = Number(r.lead_id);
    if (!lid) return;
    const cur = latestByLead[lid];
    if (!cur || String(r.created_at || '') > String(cur.created_at || '')) latestByLead[lid] = r;
  });
  items.forEach(row => {
    const lr = latestByLead[Number(row.lead_id)];
    row.latest_remark = lr ? (lr.remark || '') : '';
    row.latest_remark_at = lr ? (lr.created_at || null) : null;
    // Hydrate the assignee name so the follow-up tables can show "Assigned to"
    // without a second round-trip. Falls back to "" if the lead is unassigned
    // or the user has been deleted.
    const u = usersById[Number(row.assigned_to)];
    row.assigned_name = u ? (u.name || '') : '';
  });

  const overdue = [], due_today = [], upcoming = [];
  items.forEach(row => {
    const due = String(row.due_at);
    const dueDay = due.slice(0, 10);
    if (dueDay === todayStr) due_today.push(row);
    else if (due < now) overdue.push(row);
    else upcoming.push(row);
  });
  overdue.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  due_today.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));
  upcoming.sort((a, b) => String(a.due_at).localeCompare(String(b.due_at)));

  let notifications;
  if (isMobile) {
    // MOBILE_PERF_v1: SQL-scope to last 7 days OR unread, cap 50
    const r = await db.query(
      `SELECT * FROM notifications
        WHERE user_id = $1
          AND (COALESCE(is_read, 0) = 0 OR created_at > NOW() - INTERVAL '7 days')
        ORDER BY created_at DESC
        LIMIT 50`,
      [me.id]
    );
    notifications = r.rows;
  } else {
    notifications = (await db.getAll('notifications'))
      .filter(n => Number(n.user_id) === Number(me.id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  const unread_notifications = notifications.filter(n => Number(n.is_read) === 0);

  // Today's NEW leads — visible to this user, created today (in IST so the
  // "today" boundary matches what the user expects, not server UTC).
  const tzFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const localToday = tzFmt.format(new Date());
  const new_today_leads = allLeads.filter(l => {
    if (!isMine(l) && Number(l.assigned_to) !== Number(me.id) && me.role !== 'admin') return false;
    const created = l.created_at;
    if (!created) return false;
    const localDay = tzFmt.format(new Date(created));
    return localDay === localToday;
  });

  // MOBILE_PERF_v1: cap each visible array to 20 rows. Counts stay accurate.
  const overdueOut   = isMobile ? overdue.slice(0, 20)   : overdue;
  const dueTodayOut  = isMobile ? due_today.slice(0, 20) : due_today;
  const upcomingOut  = isMobile ? upcoming.slice(0, 20)  : upcoming;
  const unreadOut    = isMobile ? unread_notifications.slice(0, 20) : unread_notifications;

  return {
    overdue: overdueOut,
    due_today: dueTodayOut,
    upcoming: upcomingOut,
    unread_notifications: unreadOut,
    new_today: new_today_leads.length,
    counts: {
      overdue: overdue.length,
      due_today: due_today.length,
      unread: unread_notifications.length,
      upcoming: upcoming.length,
      new_today: new_today_leads.length
    }
  };
}

async function api_notifications_read(token, id) {
  await authUser(token);
  await db.update('notifications', id, { is_read: 1 });
  return { ok: true };
}
async function api_notifications_read_all(token) {
  const me = await authUser(token);
  const mine = (await db.getAll('notifications')).filter(n => Number(n.user_id) === Number(me.id) && Number(n.is_read) === 0);
  for (const n of mine) await db.update('notifications', n.id, { is_read: 1 });
  return { ok: true, count: mine.length };
}
async function api_followups_debug(token) {
  // FU_DEBUG_v1 — read-only diagnostic for "Follow-ups empty" issues.
  const me = await authUser(token);
  const now = new Date();
  const one = async (sql) => Number((await db.query(sql)).rows[0].c) || 0;
  const statuses = (await db.getAll('statuses')).map(x => ({ id: Number(x.id), name: x.name, is_final: Number(x.is_final) || 0 }));
  const sample = (await db.query(
    `SELECT l.id, l.name, l.status_id, l.assigned_to, l.next_followup_at,
            COALESCE(s.name,'(none)') AS status_name, COALESCE(s.is_final,0)::int AS status_final
       FROM leads l LEFT JOIN statuses s ON s.id = l.status_id
      WHERE l.next_followup_at IS NOT NULL
      ORDER BY l.next_followup_at DESC LIMIT 12`)).rows;
  return {
    me: { id: me.id, role: me.role },
    server_now: now.toISOString(),
    today_utc: now.toISOString().slice(0, 10),
    counts: {
      leads_total: await one(`SELECT COUNT(*)::int c FROM leads`),
      leads_with_next_followup: await one(`SELECT COUNT(*)::int c FROM leads WHERE next_followup_at IS NOT NULL`),
      leads_next_in_window: await one(`SELECT COUNT(*)::int c FROM leads WHERE next_followup_at IS NOT NULL AND next_followup_at >= NOW()-INTERVAL '60 days' AND next_followup_at <= NOW()+INTERVAL '90 days'`),
      leads_next_in_window_NONFINAL: await one(`SELECT COUNT(*)::int c FROM leads l LEFT JOIN statuses s ON s.id=l.status_id WHERE l.next_followup_at IS NOT NULL AND l.next_followup_at >= NOW()-INTERVAL '60 days' AND l.next_followup_at <= NOW()+INTERVAL '90 days' AND COALESCE(s.is_final,0)=0`),
      open_followups: await one(`SELECT COUNT(*)::int c FROM followups WHERE COALESCE(is_done,0)=0`),
      open_followups_in_window: await one(`SELECT COUNT(*)::int c FROM followups WHERE COALESCE(is_done,0)=0 AND due_at IS NOT NULL AND due_at >= NOW()-INTERVAL '60 days' AND due_at <= NOW()+INTERVAL '90 days'`)
    },
    final_status_ids: statuses.filter(x => x.is_final === 1).map(x => x.id + ':' + x.name),
    statuses,
    sample
  };
}

module.exports = { api_notifications_mine, api_notifications_read, api_notifications_read_all, api_followups_debug };
