const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

async function api_notifications_mine(token) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const todayStr = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const [allFollowups, allLeads, allUsers] = await Promise.all([
    db.getAll('followups'), db.getAll('leads'), db.getAll('users')
  ]);
  const leadsById = {};
  allLeads.forEach(l => { leadsById[Number(l.id)] = l; });
  const usersById = {};
  allUsers.forEach(u => { usersById[Number(u.id)] = u; });

  // Build a map of (lead_id -> open followup) so we don't double-count when the lead
  // also has a next_followup_at that matches its open followup row.
  const followupByLead = {};
  allFollowups.forEach(f => {
    if (Number(f.is_done) === 0) followupByLead[Number(f.lead_id)] = f;
  });

  // Collect items (from followups OR from leads.next_followup_at as fallback)
  const items = [];
  const isMine = (lead) => {
    if (me.role === 'admin') return true;
    return lead && visible.includes(Number(lead.assigned_to));
  };

  // From followups table — assigned to me OR for leads I can see
  allFollowups.forEach(f => {
    if (Number(f.is_done) === 1) return;
    if (!f.due_at) return;
    const lead = leadsById[Number(f.lead_id)];
    const isForMe = Number(f.user_id) === Number(me.id);
    if (!isForMe && !isMine(lead)) return;
    items.push({
      id: f.id, lead_id: f.lead_id, due_at: f.due_at, note: f.note || '',
      lead_name: lead?.name || '', lead_phone: lead?.phone || '',
      assigned_to: lead?.assigned_to
    });
  });

  // Fallback: leads with next_followup_at but no matching followup row (legacy rows)
  allLeads.forEach(l => {
    if (!l.next_followup_at) return;
    if (followupByLead[Number(l.id)]) return;
    if (!isMine(l) && Number(l.assigned_to) !== Number(me.id)) return;
    items.push({
      id: null, lead_id: l.id, due_at: l.next_followup_at, note: '',
      lead_name: l.name || '', lead_phone: l.phone || '',
      assigned_to: l.assigned_to
    });
  });

  // Attach the latest remark per lead — used by the Follow-ups list and the
  // dashboard popup so the user sees context without opening the lead.
  const allRemarks = await db.getAll('remarks');
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

  const notifications = (await db.getAll('notifications'))
    .filter(n => Number(n.user_id) === Number(me.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
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

  return {
    overdue, due_today, upcoming, unread_notifications,
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
module.exports = { api_notifications_mine, api_notifications_read, api_notifications_read_all };
