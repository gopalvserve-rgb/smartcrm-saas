/**
 * routes/hr.js — Attendance, Leaves, Tasks, Salary, Bank Details
 * Mirrors the Apps Script HR module. Same API shape.
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

function todayIso() { return new Date().toISOString().slice(0, 10); }

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = x => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- Attendance -----------------------------------------------------

const VALID_WORK_MODES = ['office', 'home', 'on_site'];

async function api_attendance_checkIn(token, lat, lng, deviceInfo, locationName, workMode) {
  const me = await authUser(token);
  const date = todayIso();

  if (String(process.env.ENFORCE_GPS || '0') === '1') {
    const olat = Number(process.env.OFFICE_LAT);
    const olng = Number(process.env.OFFICE_LNG);
    const rad  = Number(process.env.OFFICE_RADIUS_M || 300);
    // GPS office-radius enforcement only applies when the user said
    // they're at the office. Work-from-home and on-site (field) work
    // are intentionally unconstrained.
    const wm = VALID_WORK_MODES.includes(workMode) ? workMode : 'office';
    if (wm === 'office' && olat && olng && lat && lng) {
      const dist = haversine(olat, olng, Number(lat), Number(lng));
      if (dist > rad) throw new Error(`Too far from office (${Math.round(dist)}m > ${rad}m)`);
    }
  }

  const existing = (await db.getAll('attendance'))
    .find(a => Number(a.user_id) === Number(me.id) &&
               String(a.date).slice(0, 10) === date);
  if (existing && existing.check_in) throw new Error('Already checked in today');

  const now = db.nowIso();
  const d = deviceInfo || {};
  const device_info = d.summary || '';
  const user_agent = d.user_agent || '';
  const payload = {
    check_in: now,
    check_in_lat: lat || null,
    check_in_lng: lng || null,
    check_in_location_name: locationName ? String(locationName).slice(0, 255) : null,
    work_mode: VALID_WORK_MODES.includes(workMode) ? workMode : 'office',
    status: 'present',
    device_info, user_agent
  };
  if (existing) {
    await db.update('attendance', existing.id, payload);
    return { id: existing.id, check_in: now };
  }
  const id = await db.insert('attendance', Object.assign({
    user_id: me.id, date
  }, payload));
  return { id, check_in: now };
}

async function api_attendance_checkOut(token, lat, lng, deviceInfo, locationName) {
  const me = await authUser(token);
  const date = todayIso();
  const row = (await db.getAll('attendance'))
    .find(a => Number(a.user_id) === Number(me.id) &&
               String(a.date).slice(0, 10) === date);
  if (!row) throw new Error('No check-in found for today');
  if (row.check_out) throw new Error('Already checked out');
  const now = db.nowIso();
  const d = deviceInfo || {};
  await db.update('attendance', row.id, {
    check_out: now,
    check_out_lat: lat || null,
    check_out_lng: lng || null,
    check_out_location_name: locationName ? String(locationName).slice(0, 255) : null,
    device_info: d.summary || row.device_info,
    user_agent: d.user_agent || row.user_agent
  });
  return { id: row.id, check_out: now };
}

async function api_attendance_mine(token, from, to) {
  const me = await authUser(token);
  let rows = (await db.getAll('attendance'))
    .filter(a => Number(a.user_id) === Number(me.id));
  if (from) rows = rows.filter(a => String(a.date).slice(0, 10) >= from);
  if (to)   rows = rows.filter(a => String(a.date).slice(0, 10) <= to);
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows;
}

/**
 * Monthly attendance report grid: rows = users, columns = dates.
 * Returns { month, dates[], users[], matrix[uid][date] = { in, out, hours, status } }
 */
async function api_attendance_report(token, month, userId) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  const visible = await getVisibleUserIds(me);

  const [year, mm] = String(month || new Date().toISOString().slice(0, 7)).split('-').map(Number);
  const first = new Date(year, mm - 1, 1);
  const last = new Date(year, mm, 0);
  const dates = [];
  for (let d = 1; d <= last.getDate(); d++) {
    dates.push(`${year}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }

  const [users, att] = await Promise.all([db.getAll('users'), db.getAll('attendance')]);
  let userList = users.filter(u => Number(u.is_active) === 1);
  if (me.role !== 'admin') userList = userList.filter(u => visible.includes(Number(u.id)));
  if (userId) userList = userList.filter(u => Number(u.id) === Number(userId));

  const byUser = {};
  userList.forEach(u => { byUser[Number(u.id)] = { id: u.id, name: u.name, role: u.role, department: u.department || '' }; });

  const matrix = {};
  const totals = {};
  userList.forEach(u => { matrix[u.id] = {}; totals[u.id] = { present: 0, absent: 0, hours: 0 }; });

  att.forEach(r => {
    if (!byUser[Number(r.user_id)]) return;
    const d = String(r.date).slice(0, 10);
    if (!d.startsWith(`${year}-${String(mm).padStart(2, '0')}`)) return;
    const cell = {
      in: r.check_in,
      out: r.check_out,
      status: r.status || 'present',
      hours: (r.check_in && r.check_out) ? ((new Date(r.check_out) - new Date(r.check_in)) / 3600000) : 0,
      device: r.device_info || '',
      has_location: !!(r.check_in_lat && r.check_in_lng)
    };
    matrix[r.user_id][d] = cell;
    if (cell.status === 'present') totals[r.user_id].present++;
    totals[r.user_id].hours += cell.hours;
  });

  // Absent days: any date <= today with no cell
  const todayStr = new Date().toISOString().slice(0, 10);
  Object.keys(matrix).forEach(uid => {
    dates.forEach(d => {
      if (d > todayStr) return;
      if (!matrix[uid][d]) totals[uid].absent++;
    });
  });

  return {
    month: `${year}-${String(mm).padStart(2, '0')}`,
    dates,
    users: Object.values(byUser),
    matrix,
    totals
  };
}

async function api_attendance_team(token, from, to, userId) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  let rows = await db.getAll('attendance');
  if (me.role !== 'admin') rows = rows.filter(a => visible.includes(Number(a.user_id)));
  if (userId) rows = rows.filter(a => Number(a.user_id) === Number(userId));
  if (from)   rows = rows.filter(a => String(a.date).slice(0, 10) >= from);
  if (to)     rows = rows.filter(a => String(a.date).slice(0, 10) <= to);
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  rows = rows.map(r => Object.assign({}, r, { user_name: byId[Number(r.user_id)]?.name || '' }));
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return rows;
}

// ---- Leaves ---------------------------------------------------------

/**
 * Resolve the chain of approvers for a given user:
 *   - their immediate parent (direct supervisor — could be team_leader/manager/admin)
 *   - everyone above them in the parent_id chain (so a team_leader's leave still
 *     reaches the manager and admin even if the team_leader's direct supervisor
 *     is a manager)
 *   - plus all active admins as a safety net (so requests never get stuck if
 *     parent_id was set incorrectly when the user was created)
 *
 * Dedup'd, excludes the applicant themselves. This is the "supervisor list" we
 * fan notifications out to whenever a leave is applied or decided.
 */
async function _leaveApprovers(applicantId) {
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  const approvers = new Set();

  // Walk up the parent_id chain
  const visited = new Set([Number(applicantId)]);
  let cursor = byId[Number(applicantId)];
  let safety = 10;
  while (cursor && cursor.parent_id && !visited.has(Number(cursor.parent_id)) && safety-- > 0) {
    visited.add(Number(cursor.parent_id));
    const parent = byId[Number(cursor.parent_id)];
    if (!parent || Number(parent.is_active) === 0) break;
    if (['admin', 'manager', 'team_leader'].includes(parent.role)) {
      approvers.add(Number(parent.id));
    }
    cursor = parent;
  }

  // Always include all active admins so a request never gets stuck
  users.forEach(u => {
    if (u.role === 'admin' && Number(u.is_active) === 1 && Number(u.id) !== Number(applicantId)) {
      approvers.add(Number(u.id));
    }
  });

  return [...approvers].map(id => byId[id]).filter(Boolean);
}

async function api_leaves_mine(token) {
  const me = await authUser(token);
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  const rows = (await db.getAll('leaves'))
    .filter(l => Number(l.user_id) === Number(me.id))
    .sort((a, b) => String(b.from_date).localeCompare(String(a.from_date)))
    .map(l => Object.assign({}, l, {
      approver_name: byId[Number(l.approved_by)]?.name || ''
    }));
  return rows;
}

async function api_leaves_apply(token, leave) {
  const me = await authUser(token);
  if (!leave.from_date || !leave.to_date) throw new Error('Dates required');
  const id = await db.insert('leaves', {
    user_id: me.id,
    from_date: leave.from_date,
    to_date: leave.to_date,
    reason: leave.reason || '',
    status: 'pending',
    created_at: db.nowIso()
  });

  // Notify every supervisor in the chain (and all admins as safety net).
  // In-app notification + Web Push so the supervisor's phone pings even if
  // they're not in the CRM at the moment.
  try {
    const approvers = await _leaveApprovers(me.id);
    const title = '🏖️ Leave request from ' + (me.name || 'Employee');
    const body  = `${leave.from_date} → ${leave.to_date}` + (leave.reason ? ` · ${leave.reason}` : '');
    const link  = '#/leaves';
    for (const a of approvers) {
      try {
        await db.insert('notifications', {
          user_id: a.id,
          type: 'leave_request',
          title, body, link,
          is_read: 0,
          created_at: db.nowIso()
        });
      } catch (_) {}
      try {
        const push = require('./push');
        await push.sendPushToUser(a.id, { title, body, url: '/#/leaves', tag: 'leave-' + id, sticky: true });
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[leaves] supervisor notify failed:', e.message);
  }
  return { id };
}

async function api_leaves_pending(token) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  const visible = await getVisibleUserIds(me);
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return (await db.getAll('leaves'))
    .filter(l => l.status === 'pending' &&
                 (me.role === 'admin' || visible.includes(Number(l.user_id))))
    .map(l => Object.assign({}, l, { user_name: byId[Number(l.user_id)]?.name || '' }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

/**
 * Admin-only: every leave in the system, regardless of hierarchy.
 * Safety net for when an employee's parent_id wasn't set correctly so their
 * application doesn't show up under any manager.
 */
async function api_leaves_all(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admins only');
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return (await db.getAll('leaves'))
    .map(l => Object.assign({}, l, {
      user_name: byId[Number(l.user_id)]?.name || '',
      approver_name: byId[Number(l.approved_by)]?.name || ''
    }))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function api_leaves_decide(token, id, decision) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Bad decision');
  const leave = await db.findById('leaves', id);
  if (!leave) throw new Error('Leave not found');
  await db.update('leaves', id, { status: decision, approved_by: me.id });

  // Notify the applicant of the decision so they don't have to keep checking
  // the leaves page. Push + in-app banner mirror the apply flow.
  try {
    const emoji = decision === 'approved' ? '✅' : '❌';
    const title = `${emoji} Leave ${decision} by ${me.name || 'Manager'}`;
    const body  = `${leave.from_date} → ${leave.to_date}`;
    await db.insert('notifications', {
      user_id: leave.user_id,
      type: 'leave_decision',
      title, body, link: '#/leaves',
      is_read: 0,
      created_at: db.nowIso()
    });
    try {
      const push = require('./push');
      await push.sendPushToUser(leave.user_id, { title, body, url: '/#/leaves', tag: 'leave-decision-' + id });
    } catch (_) {}
  } catch (e) {
    console.warn('[leaves] applicant notify failed:', e.message);
  }
  return { ok: true };
}

// ---- Tasks (HR-style daily tasks) ----------------------------------

async function api_tasks_list(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  let rows = await db.getAll('tasks');
  const visible = await getVisibleUserIds(me);
  if (me.role !== 'admin') {
    rows = rows.filter(t =>
      Number(t.assigned_to) === Number(me.id) ||
      Number(t.created_by) === Number(me.id) ||
      visible.includes(Number(t.assigned_to))
    );
  }
  if (filters.status)       rows = rows.filter(t => t.status === filters.status);
  if (filters.assigned_to)  rows = rows.filter(t => Number(t.assigned_to) === Number(filters.assigned_to));
  if (filters.from)         rows = rows.filter(t => String(t.due_at || '').slice(0, 10) >= filters.from);
  if (filters.to)           rows = rows.filter(t => String(t.due_at || '').slice(0, 10) <= filters.to);

  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  rows = rows.map(t => Object.assign({}, t, {
    assigned_name: byId[Number(t.assigned_to)]?.name || '',
    creator_name:  byId[Number(t.created_by)]?.name  || ''
  }));
  rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows;
}

async function api_tasks_save(token, task) {
  const me = await authUser(token);
  const t = task || {};
  if (!t.title) throw new Error('Title required');
  const payload = {
    title: t.title,
    description: t.description || '',
    assigned_to: t.assigned_to || me.id,
    due_at: t.due_at || null,
    priority: t.priority || 'normal',
    status: t.status || 'open'
  };
  if (t.id) { await db.update('tasks', t.id, payload); return { id: Number(t.id) }; }
  payload.created_by = me.id;
  payload.created_at = db.nowIso();
  const id = await db.insert('tasks', payload);
  return { id };
}

async function api_tasks_complete(token, id) {
  const me = await authUser(token);
  const t = await db.findById('tasks', id);
  if (!t) throw new Error('Task not found');
  if (Number(t.assigned_to) !== Number(me.id) && me.role !== 'admin') {
    throw new Error('Not your task');
  }
  await db.update('tasks', id, { status: 'done', completed_at: db.nowIso() });
  return { ok: true };
}

/** "What did I get done today" — tasks completed today, grouped by user for managers. */
async function api_tasks_doneToday(token, dateOverride) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const target = dateOverride || todayIso();

  const [tasks, users] = await Promise.all([db.getAll('tasks'), db.getAll('users')]);
  const byUser = {}; users.forEach(u => { byUser[Number(u.id)] = u; });

  const done = tasks.filter(t =>
    t.status === 'done' &&
    t.completed_at &&
    String(t.completed_at).slice(0, 10) === target
  );

  const mineToday = done
    .filter(t => Number(t.assigned_to) === Number(me.id))
    .map(t => Object.assign({}, t, {
      completed_at_label: new Date(t.completed_at).toLocaleTimeString()
    }));

  // Team view (managers/admin): group by assignee they can see
  let teamToday = [];
  if (me.role === 'admin' || me.role === 'manager' || me.role === 'team_leader') {
    const teamTasks = done.filter(t => visible.includes(Number(t.assigned_to)) && Number(t.assigned_to) !== Number(me.id));
    const grouped = {};
    teamTasks.forEach(t => {
      const uid = Number(t.assigned_to);
      if (!grouped[uid]) grouped[uid] = { user: byUser[uid], tasks: [] };
      grouped[uid].tasks.push(t);
    });
    teamToday = Object.values(grouped).map(g => ({
      user_id: g.user?.id,
      user_name: g.user?.name || '—',
      user_role: g.user?.role || '',
      count: g.tasks.length,
      tasks: g.tasks
    }));
  }

  // Also include follow-ups marked done today (nice to see in daily report)
  const followupsDoneToday = (await db.getAll('followups'))
    .filter(f => Number(f.is_done) === 1 && f.done_at && String(f.done_at).slice(0, 10) === target)
    .filter(f => Number(f.user_id) === Number(me.id));

  return {
    date: target,
    my_tasks_done: mineToday,
    my_followups_done: followupsDoneToday,
    team_done: teamToday,
    totals: {
      my_tasks: mineToday.length,
      my_followups: followupsDoneToday.length,
      team_tasks: teamToday.reduce((s, g) => s + g.count, 0)
    }
  };
}

// ---- Salary ---------------------------------------------------------

async function api_salary_mine(token) {
  const me = await authUser(token);
  return (await db.getAll('salaries'))
    .filter(s => Number(s.user_id) === Number(me.id))
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
}

async function api_salary_list(token, userId) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const visible = await getVisibleUserIds(me);
  let rows = await db.getAll('salaries');
  if (me.role !== 'admin') rows = rows.filter(s => visible.includes(Number(s.user_id)));
  if (userId) rows = rows.filter(s => Number(s.user_id) === Number(userId));
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return rows.map(s => Object.assign({}, s, { user_name: byId[Number(s.user_id)]?.name || '' }))
             .sort((a, b) => String(b.month).localeCompare(String(a.month)));
}

async function api_salary_save(token, sal) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!sal.user_id || !sal.month) throw new Error('user_id and month required');
  const base = Number(sal.base) || 0;
  const allowances = Number(sal.allowances) || 0;
  const deductions = Number(sal.deductions) || 0;
  const payload = {
    user_id: sal.user_id, month: sal.month,
    base, allowances, deductions,
    net_pay: base + allowances - deductions,
    notes: sal.notes || ''
  };
  // Upsert: update if a row for this user+month already exists
  const existing = (await db.getAll('salaries')).find(s =>
    Number(s.user_id) === Number(sal.user_id) && s.month === sal.month
  );
  if (sal.id || existing) {
    const id = sal.id || existing.id;
    await db.update('salaries', id, payload);
    return { id: Number(id) };
  }
  payload.created_at = db.nowIso();
  const id = await db.insert('salaries', payload);
  return { id };
}

/** Save multiple salary rows in one call. rows: [{user_id, month, base, allowances, deductions, notes}] */
async function api_salary_bulkSave(token, rows) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const saved = [];
  for (const r of (rows || [])) {
    try { saved.push(await api_salary_save(token, r)); }
    catch (e) { saved.push({ error: e.message, row: r }); }
  }
  return { saved: saved.length, results: saved };
}

/** Monthly report: totals + per-user breakdown for a specific month. */
async function api_salary_report(token, month) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const visible = await getVisibleUserIds(me);
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  let rows = (await db.getAll('salaries')).filter(s => s.month === month);
  if (me.role !== 'admin') rows = rows.filter(s => visible.includes(Number(s.user_id)));
  const hydrated = rows.map(s => Object.assign({}, s, {
    user_name: byId[Number(s.user_id)]?.name || '',
    user_role: byId[Number(s.user_id)]?.role || ''
  }));
  const totals = hydrated.reduce((acc, r) => ({
    base: acc.base + Number(r.base || 0),
    allowances: acc.allowances + Number(r.allowances || 0),
    deductions: acc.deductions + Number(r.deductions || 0),
    net_pay: acc.net_pay + Number(r.net_pay || 0)
  }), { base: 0, allowances: 0, deductions: 0, net_pay: 0 });
  return { month, rows: hydrated, totals };
}

/** Generate an HTML payslip for a single salary record. Returns a blob-ready HTML. */
async function api_salary_payslip(token, salaryId) {
  const me = await authUser(token);
  const s = await db.findById('salaries', salaryId);
  if (!s) throw new Error('Salary record not found');
  if (me.role !== 'admin' && Number(s.user_id) !== Number(me.id)) throw new Error('Forbidden');
  const u = await db.findById('users', s.user_id);
  const bank = await db.findOneBy('bank_details', 'user_id', s.user_id);
  const company = (await db.getConfig('COMPANY_NAME', process.env.COMPANY_NAME)) || 'Lead CRM';
  const maskedAcc = bank?.account_number ? '****' + String(bank.account_number).slice(-4) : '';
  const fmt = n => '₹ ' + Number(n || 0).toFixed(2);
  const [year, mm] = String(s.month).split('-');
  const monthLabel = new Date(Number(year), Number(mm) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Payslip — ${u?.name || ''} — ${s.month}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;max-width:720px;margin:2rem auto;padding:1rem;color:#0f172a}
h1{margin:0 0 .2rem;color:#6366f1}
h2{font-size:1rem;color:#475569;font-weight:600;margin:0 0 1.2rem}
table{width:100%;border-collapse:collapse;margin:1rem 0}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #e2e8f0}
.right{text-align:right}
.totals td{font-weight:700;background:#f1f5f9}
.note{color:#64748b;font-size:.85rem;margin-top:1rem}
@media print{body{margin:0}}
</style></head><body>
<h1>${company}</h1>
<h2>Payslip — ${monthLabel}</h2>
<table>
  <tr><th>Employee</th><td>${u?.name || ''}</td><th>Role</th><td>${u?.role || ''}</td></tr>
  <tr><th>Department</th><td>${u?.department || '—'}</td><th>Designation</th><td>${u?.designation || '—'}</td></tr>
  <tr><th>Month</th><td>${s.month}</td><th>Generated</th><td>${new Date().toLocaleDateString()}</td></tr>
  ${bank ? `<tr><th>Bank</th><td>${bank.bank_name || '—'}</td><th>A/c</th><td>${maskedAcc}</td></tr>` : ''}
</table>
<table>
  <thead><tr><th>Earnings</th><th class="right">Amount</th><th>Deductions</th><th class="right">Amount</th></tr></thead>
  <tbody>
    <tr>
      <td>Base salary</td><td class="right">${fmt(s.base)}</td>
      <td>Total deductions</td><td class="right">${fmt(s.deductions)}</td>
    </tr>
    <tr>
      <td>Allowances</td><td class="right">${fmt(s.allowances)}</td>
      <td></td><td></td>
    </tr>
    <tr class="totals">
      <td>Gross pay</td><td class="right">${fmt(Number(s.base) + Number(s.allowances))}</td>
      <td>Net pay</td><td class="right">${fmt(s.net_pay)}</td>
    </tr>
  </tbody>
</table>
${s.notes ? `<p class="note"><b>Notes:</b> ${s.notes}</p>` : ''}
<p class="note">This is a system-generated payslip.</p>
</body></html>`;
  return { html, filename: `payslip-${u?.name || 'user'}-${s.month}.html` };
}

// ---- Bank Details ---------------------------------------------------

async function api_bank_mine(token) {
  const me = await authUser(token);
  return await db.findOneBy('bank_details', 'user_id', me.id);
}

async function api_bank_save(token, info) {
  const me = await authUser(token);
  const payload = {
    bank_name: info.bank_name || '',
    account_holder: info.account_holder || '',
    account_number: info.account_number || '',
    ifsc: info.ifsc || '',
    branch: info.branch || '',
    upi_id: info.upi_id || '',
    notes: info.notes || '',
    updated_at: db.nowIso()
  };
  const existing = await db.findOneBy('bank_details', 'user_id', me.id);
  if (existing) {
    await db.update('bank_details', existing.id, payload);
    return { id: existing.id };
  }
  payload.user_id = me.id;
  const id = await db.insert('bank_details', payload);
  return { id };
}

async function api_bank_list(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const users = await db.getAll('users');
  const byId = {}; users.forEach(u => { byId[Number(u.id)] = u; });
  return (await db.getAll('bank_details'))
    .map(b => Object.assign({}, b, {
      user_name: byId[Number(b.user_id)]?.name || '',
      account_number: b.account_number
        ? '****' + String(b.account_number).slice(-4)
        : ''
    }));
}

// ---- Location pings (every 30 minutes while user is checked in) -----

/**
 * Save a single location ping. Called by the client every 30 minutes while
 * the user is checked in (no check_out yet for today). Tied to today's
 * attendance row so admin can see the trail per shift.
 */
async function api_location_ping(token, lat, lng, locationName, accuracyM) {
  const me = await authUser(token);
  if (lat == null || lng == null) throw new Error('lat/lng required');
  const date = todayIso();
  const att = (await db.getAll('attendance'))
    .find(a => Number(a.user_id) === Number(me.id) &&
               String(a.date).slice(0, 10) === date);
  // Only accept pings while the user is checked in but not yet checked out.
  // Clients shouldn't be calling this otherwise but be defensive.
  if (!att || !att.check_in) {
    throw new Error('Not checked in — pings only stored during a shift');
  }
  if (att.check_out) {
    throw new Error('Already checked out — pings not stored after shift end');
  }
  const id = await db.insert('location_pings', {
    user_id: me.id,
    attendance_id: att.id,
    lat: Number(lat) || null,
    lng: Number(lng) || null,
    location_name: locationName ? String(locationName).slice(0, 255) : null,
    accuracy_m: (accuracyM != null && !isNaN(accuracyM)) ? Number(accuracyM) : null,
    created_at: db.nowIso()
  });
  return { id, attendance_id: att.id };
}

/**
 * Admin / manager view: location trail for one user on one date.
 * Returns the day's attendance row + every ping in chronological order.
 */
async function api_location_trail(token, userId, date) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role) &&
      Number(userId) !== Number(me.id)) {
    throw new Error('Forbidden');
  }
  const visible = await getVisibleUserIds(me);
  if (me.role !== 'admin' && !visible.includes(Number(userId))) {
    throw new Error('Forbidden');
  }
  const day = String(date || todayIso()).slice(0, 10);
  const att = (await db.getAll('attendance'))
    .find(a => Number(a.user_id) === Number(userId) &&
               String(a.date).slice(0, 10) === day);
  if (!att) return { attendance: null, pings: [] };
  const pings = (await db.getAll('location_pings'))
    .filter(p => Number(p.attendance_id) === Number(att.id))
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return {
    attendance: {
      id: att.id, user_id: att.user_id, date: att.date,
      check_in: att.check_in, check_out: att.check_out,
      check_in_lat: att.check_in_lat, check_in_lng: att.check_in_lng,
      check_out_lat: att.check_out_lat, check_out_lng: att.check_out_lng,
      check_in_location_name: att.check_in_location_name,
      check_out_location_name: att.check_out_location_name,
      work_mode: att.work_mode, status: att.status
    },
    pings
  };
}

module.exports = {
  api_attendance_checkIn, api_attendance_checkOut,
  api_attendance_mine, api_attendance_team, api_attendance_report,
  api_leaves_mine, api_leaves_apply, api_leaves_pending, api_leaves_decide, api_leaves_all,
  api_tasks_list, api_tasks_save, api_tasks_complete, api_tasks_doneToday,
  api_salary_mine, api_salary_list, api_salary_save,
  api_salary_bulkSave, api_salary_report, api_salary_payslip,
  api_bank_mine, api_bank_save, api_bank_list,
  api_location_ping, api_location_trail
};
