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

// ATTENDANCE_SELFIE_METER_v1 (2026-05-29) — additive columns for the
// optional selfie + meter-reading capture on check-in/out. Self-heals
// the schema on first call so existing tenants don't need a manual
// migration. The flags are read from the `config` table:
//
//   ATTENDANCE_REQUIRE_SELFIE   '1' / '0'  (default '0' = off — ATTENDANCE_OPTIONAL_DEFAULT_v1)
//   ATTENDANCE_REQUIRE_METER    '1' / '0'  (default '0' = off)
//   ATTENDANCE_METER_LABEL      free text (default 'Meter reading')
//
// ATTENDANCE_OPTIONAL_DEFAULT_v1 (2026-06-06) — both flags now default
// OFF for ALL tenants. The earlier FIX_v1 made selfie compulsory by
// default which started blocking real check-ins on field-staff phones
// where the camera permission was flaky. Admin can re-enable from
// Settings → Attendance any time.
//
// Admin can toggle each independently from Settings → Attendance.
// Photo is sent as a base64 data URL from the SPA; we cap at 1MB to
// stop badly-compressed phone selfies from blowing up the row.
let _attSelfieIdxEnsured = false;
async function _ensureAttendanceSelfieCols() {
  if (_attSelfieIdxEnsured) return;
  _attSelfieIdxEnsured = true;
  try {
    await db.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in_selfie TEXT`);
    await db.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in_meter TEXT`);
    await db.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_selfie TEXT`);
    await db.query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_meter TEXT`);
  } catch (e) {
    console.warn('[attendance] selfie/meter column ensure failed:', e.message);
  }
}

async function _attRequirements() {
  // ATTENDANCE_OPTIONAL_DEFAULT_v1 — both flags default OFF. See header.
  const [reqSelfie, reqMeter, meterLabel] = await Promise.all([
    db.getConfig('ATTENDANCE_REQUIRE_SELFIE', '0'),
    db.getConfig('ATTENDANCE_REQUIRE_METER', '0'),
    db.getConfig('ATTENDANCE_METER_LABEL', 'Meter reading')
  ]);
  return {
    require_selfie: String(reqSelfie) === '1',
    require_meter: String(reqMeter) === '1',
    meter_label: String(meterLabel || 'Meter reading').slice(0, 80)
  };
}

// Expose the policy to the SPA so the UI can show/hide the capture
// widgets without guessing. Anyone authenticated can read it.
async function api_attendance_policy(token) {
  await authUser(token);
  return await _attRequirements();
}

// Admin save — toggle the requirements + label.
async function api_attendance_policy_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  await db.setConfig('ATTENDANCE_REQUIRE_SELFIE', p.require_selfie ? '1' : '0');
  await db.setConfig('ATTENDANCE_REQUIRE_METER', p.require_meter ? '1' : '0');
  if (typeof p.meter_label === 'string') {
    await db.setConfig('ATTENDANCE_METER_LABEL', p.meter_label.slice(0, 80) || 'Meter reading');
  }
  return { ok: true };
}

function _validSelfie(b64) {
  if (!b64) return null;
  const s = String(b64);
  if (!s.startsWith('data:image/')) return null;
  // Soft cap: 1.4 MB of base64 ≈ 1 MB of binary. Anything bigger is
  // either a full-res photo or an attack — reject.
  if (s.length > 1400000) throw new Error('Selfie too large — please retake');
  return s;
}
function _validMeter(v) {
  // ATTENDANCE_OPTIONAL_DEFAULT_v1 — accept any non-empty text up to 20
  // chars. The "Meter reading" label is generic; tenants use it for
  // odometer, vehicle ID, machine serial, counter value, anything. The
  // strict numeric check was rejecting valid inputs like "123 km" or
  // "ABC-1234" and there's no real downside to free text here.
  if (v == null || v === '') return null;
  const n = String(v).trim();
  if (!n) return null;
  return n.slice(0, 20);
}

async function api_attendance_checkIn(token, lat, lng, deviceInfo, locationName, workMode, selfie, meter) {
  const me = await authUser(token);
  const date = todayIso();
  await _ensureAttendanceSelfieCols();
  // ATTENDANCE_SELFIE_METER_v1 — enforce the admin-configured requirements.
  const reqs = await _attRequirements();
  const cleanSelfie = _validSelfie(selfie);
  const cleanMeter  = _validMeter(meter);
  if (reqs.require_selfie && !cleanSelfie) throw new Error('Selfie is required to check in');
  if (reqs.require_meter  && !cleanMeter)  throw new Error(reqs.meter_label + ' is required to check in');

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
    check_in_selfie: cleanSelfie,
    check_in_meter: cleanMeter,
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

async function api_attendance_checkOut(token, lat, lng, deviceInfo, locationName, selfie, meter) {
  const me = await authUser(token);
  const date = todayIso();
  await _ensureAttendanceSelfieCols();
  // ATTENDANCE_SELFIE_METER_v1 — same admin requirements apply to checkout.
  const reqs = await _attRequirements();
  const cleanSelfie = _validSelfie(selfie);
  const cleanMeter  = _validMeter(meter);
  if (reqs.require_selfie && !cleanSelfie) throw new Error('Selfie is required to check out');
  if (reqs.require_meter  && !cleanMeter)  throw new Error(reqs.meter_label + ' is required to check out');
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
    check_out_selfie: cleanSelfie,
    check_out_meter: cleanMeter,
    device_info: d.summary || row.device_info,
    user_agent: d.user_agent || row.user_agent
  });
  return { id: row.id, check_out: now };
}

async function api_attendance_mine(token, from, to) {
  // Background pollers occasionally fire mid-bootstrap with an empty
  // token. Returning [] keeps the rendering code happy and prevents
  // the 'No token' error surface that historically tripped the SPA's
  // auto-logout regex.
  if (!token) return [];
  let me;
  try { me = await authUser(token); }
  catch (e) {
    // Don't kill the session on a transient/expired token check from
    // a poller. The next real authed call will re-detect expiry and
    // logout cleanly.
    return [];
  }
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

const _VALID_LEAVE_TYPES = new Set(['casual', 'sick', 'earned', 'unpaid']);
async function api_leaves_apply(token, leave) {
  const me = await authUser(token);
  if (!leave.from_date || !leave.to_date) throw new Error('Dates required');
  const leave_type = _VALID_LEAVE_TYPES.has(leave.leave_type) ? leave.leave_type : 'casual';
  const half_day   = leave.half_day === true || leave.half_day === 'true';
  const id = await db.insert('leaves', {
    user_id: me.id,
    from_date: leave.from_date,
    to_date:   half_day ? leave.from_date : leave.to_date,
    reason:    leave.reason || '',
    leave_type,
    half_day,
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

/** Generate an HTML payslip for a single salary record. Returns a blob-ready HTML.
 *
 *  Layout matches the Celeste Abode reference template:
 *    - Centered company logo + name with a gold underline
 *    - Title row: "Salary Slip" + month-year label
 *    - 5-row × 4-col employee details grid (ID, Bank, DOJ, Designation, PAN
 *      on the left; Name, A/C No., LOP, STD, Worked on the right)
 *    - Earnings + Deductions table with Actual + Earned columns
 *    - Gross Earnings, Gross Deductions, Net Salary footer rows
 *    - "computer generated payslip" footer line
 */
async function api_salary_payslip(token, salaryId) {
  const me = await authUser(token);
  const s = await db.findById('salaries', salaryId);
  if (!s) throw new Error('Salary record not found');
  if (me.role !== 'admin' && Number(s.user_id) !== Number(me.id)) throw new Error('Forbidden');
  const u = await db.findById('users', s.user_id);
  const bank = await db.findOneBy('bank_details', 'user_id', s.user_id);
  const company = (await db.getConfig('COMPANY_NAME', process.env.COMPANY_NAME)) || 'Lead CRM';
  const logoUrl = (await db.getConfig('COMPANY_LOGO_URL', '')) || '';

  // Period parsing: month is stored as 'YYYY-MM'
  const [yearStr, mmStr] = String(s.month || '').split('-');
  const year  = Number(yearStr) || new Date().getFullYear();
  const month = Number(mmStr) || (new Date().getMonth() + 1);
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthShort = MONTH_SHORT[month - 1];
  const yyShort    = String(year).slice(-2);
  // "Feb ~ Mar' 26" style header — show current → next month for the slip period
  const nextMonthShort = MONTH_SHORT[month % 12];
  const periodLabel = `${monthShort} ~ ${nextMonthShort}' ${yyShort}`;

  // Standard / worked / LOP days. We don't store LOP separately, so:
  //   - STD = days in the salary month (calendar days, capped at 30 for
  //     consistency with Indian payroll convention)
  //   - LOP = parsed out of salary.notes if it contains "LOP: N" or "LOP=N"
  //     pattern; otherwise 0
  //   - Worked = STD - LOP (clamped ≥ 0)
  const calendarDays = new Date(year, month, 0).getDate();
  const stdDays = calendarDays;
  let lopDays = 0;
  const lopMatch = String(s.notes || '').match(/LOP[:= ]+(\d+)/i);
  if (lopMatch) lopDays = Math.max(0, Math.min(stdDays, Number(lopMatch[1]) || 0));
  const workedDays = Math.max(0, stdDays - lopDays);

  // Earned = Actual × (worked/std) — what the employee actually earned
  // after accounting for unpaid leave. Stored numbers in `salaries` table
  // are the FULL monthly amounts (Actual); we compute Earned on the fly.
  const earnedFactor = stdDays ? (workedDays / stdDays) : 1;
  const baseActual   = Number(s.base || 0);
  const allowActual  = Number(s.allowances || 0);
  // Allowance split — convention: 50% HRA, 50% Special. If you ever need
  // exact figures, store them in the notes as "HRA: x, Special: y" and we
  // can parse here.
  const hraActual    = allowActual / 2;
  const specActual   = allowActual / 2;
  const baseEarned   = baseActual  * earnedFactor;
  const hraEarned    = hraActual   * earnedFactor;
  const specEarned   = specActual  * earnedFactor;
  const grossActual  = baseActual + allowActual;
  const grossEarned  = baseEarned + hraEarned + specEarned;
  const totalDeduct  = Number(s.deductions || 0);
  const netSalary    = Math.max(0, grossEarned - totalDeduct);

  // Employee ID — combine joining year+month with zero-padded user id.
  // Falls back to "EMP" + padded id when no joining date is set.
  let empId;
  if (u?.joining_date) {
    const dj = new Date(u.joining_date);
    if (!isNaN(dj)) {
      const jy = String(dj.getFullYear()).slice(-2);
      const jm = String(dj.getMonth() + 1).padStart(2, '0');
      empId = `${jy}${jm}${String(u.id).padStart(3, '0')}`;
    } else { empId = 'EMP' + String(u?.id || 0).padStart(4, '0'); }
  } else { empId = 'EMP' + String(u?.id || 0).padStart(4, '0'); }

  // DOJ formatted as "25-Feb-26"
  let dojLabel = '—';
  if (u?.joining_date) {
    const dj = new Date(u.joining_date);
    if (!isNaN(dj)) {
      const dd = String(dj.getDate()).padStart(2, '0');
      const mm2 = MONTH_SHORT[dj.getMonth()];
      const yy2 = String(dj.getFullYear()).slice(-2);
      dojLabel = `${dd}-${mm2}-${yy2}`;
    }
  }

  const fmt = n => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (str) => String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>Payslip — ${esc(u?.name || '')} — ${esc(s.month)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:780px;margin:2rem auto;padding:1.5rem;color:#0f172a;background:#fff}
  .header{text-align:center;margin-bottom:1.5rem}
  .header img{max-width:90px;max-height:90px;display:block;margin:0 auto .4rem}
  .header h1{font-size:1.15rem;margin:.2rem 0 0;font-weight:600;letter-spacing:.02em}
  .header .rule{height:3px;background:linear-gradient(90deg,transparent 0,#0f172a 8%,#0f172a 35%,#c89b4b 50%,#0f172a 65%,#0f172a 92%,transparent 100%);margin:.75rem auto 0;max-width:780px;border-radius:1px}
  table{width:100%;border-collapse:collapse;font-size:.88rem}
  th,td{border:1px solid #1f2937;padding:.45rem .65rem;vertical-align:middle}
  .title-row td,.title-row th{text-align:center;font-weight:600}
  .label{font-weight:600;background:#fff}
  .col-head{font-weight:600;text-align:center;background:#fff}
  .right{text-align:right}
  .gross{font-weight:700}
  .net td{font-weight:700;text-align:right}
  .net td.lbl{text-align:right;padding-right:.65rem}
  .net td.amt{text-align:right;width:9rem}
  .footer{margin-top:1.25rem;text-align:center;color:#475569;font-size:.82rem}
  @media print{body{margin:0;padding:1rem;max-width:none}.no-print{display:none}}
</style>
</head><body>
  <div class="header">
    ${logoUrl ? `<img src="${esc(logoUrl)}" alt="${esc(company)}" />` : ''}
    <h1>${esc(company.toUpperCase())}</h1>
    <div class="rule"></div>
  </div>

  <table>
    <tr class="title-row">
      <td colspan="3" style="font-weight:600">Salary Slip</td>
      <td style="font-weight:600;text-align:center">${esc(periodLabel)}</td>
    </tr>
    <tr>
      <td class="label" style="width:18%">Employee ID</td>
      <td style="width:32%">${esc(empId)}</td>
      <td class="label" style="width:18%">Employee Name</td>
      <td style="width:32%">${esc(u?.name || '')}</td>
    </tr>
    <tr>
      <td class="label">Bank</td>
      <td>${esc(bank?.bank_name || '—')}</td>
      <td class="label">Bank A/C No.</td>
      <td>${esc(bank?.account_number || '—')}</td>
    </tr>
    <tr>
      <td class="label">Date of Joining</td>
      <td>${esc(dojLabel)}</td>
      <td class="label">LOP Days</td>
      <td>${lopDays}</td>
    </tr>
    <tr>
      <td class="label">Designation</td>
      <td>${esc(u?.designation || '—')}</td>
      <td class="label">STD Days</td>
      <td>${stdDays}</td>
    </tr>
    <tr>
      <td class="label">PAN No.</td>
      <td>${esc(u?.pan_number || '—')}</td>
      <td class="label">Worked Days</td>
      <td>${workedDays}</td>
    </tr>
  </table>

  <table style="margin-top:.65rem">
    <tr>
      <th class="col-head">Earnings</th>
      <th class="col-head">Actual</th>
      <th class="col-head">Earned</th>
      <th class="col-head">Deductions</th>
      <th class="col-head">Amount (Rs.)</th>
    </tr>
    <tr>
      <td>BASIC SALARY</td>
      <td class="right">${fmt(baseActual)}</td>
      <td class="right">${fmt(baseEarned)}</td>
      <td>Professional Tax</td>
      <td class="right">${fmt(totalDeduct)}</td>
    </tr>
    <tr>
      <td>House Rent Allowances</td>
      <td class="right">${fmt(hraActual)}</td>
      <td class="right">${fmt(hraEarned)}</td>
      <td></td>
      <td></td>
    </tr>
    <tr>
      <td>Special Allowances</td>
      <td class="right">${fmt(specActual)}</td>
      <td class="right">${fmt(specEarned)}</td>
      <td></td>
      <td></td>
    </tr>
    <tr class="gross">
      <td>Gross Earnings</td>
      <td class="right">${fmt(grossActual)}</td>
      <td class="right">${fmt(grossEarned)}</td>
      <td>Gross Deductions</td>
      <td class="right">${fmt(totalDeduct)}</td>
    </tr>
    <tr class="net">
      <td colspan="3" style="border:1px solid transparent"></td>
      <td class="lbl">Net Salary</td>
      <td class="amt">${fmt(netSalary)}</td>
    </tr>
  </table>

  <p class="footer">**This is computer generated payslip &amp; does required signature and stamp</p>
</body></html>`;
  return { html, filename: `payslip-${(u?.name || 'user').replace(/\s+/g, '_')}-${s.month}.html` };
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



// ============================================================
// LOCATION_TRACK_v1 (2026-05-29) — Day Trail + Live Team Map
// ============================================================
// Builds on api_location_ping / api_location_trail. Computes:
//   - total km (haversine sum across consecutive pings)
//   - halts: consecutive pings within HALT_RADIUS_M (default 100m)
//     that span >= HALT_MIN_MINUTES (default 5)
//   - status for live team map (driving / stopped / idle / offline)
//
// Designed to scale on the SQL side too: per-user-per-day queries are
// indexed on (user_id, created_at) which the location_pings table
// already supports through (attendance_id) and chronological order.

const _TRK_HALT_RADIUS_M = 100;
const _TRK_HALT_MIN_MIN = 5;
const _TRK_DRIVE_MIN_DIST_M = 200;        // moved this much since prev ping → driving
const _TRK_STATUS_DRIVING_MAX_MIN = 7;    // recency threshold for "driving"
const _TRK_STATUS_STOPPED_MAX_MIN = 15;   // recency threshold for "stopped (now)"
const _TRK_STATUS_IDLE_MAX_MIN = 60;      // beyond this we call them offline

function _trkDistanceM(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lat2 == null) return 0;
  const R = 6371000; // metres
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function _trkMinutesBetween(a, b) {
  try { return Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000); }
  catch (_) { return 0; }
}
function _trkComputeHaltsAndKm(pings, checkInAt, checkInLat, checkInLng) {
  if (!pings || !pings.length) return { halts: [], metrics: { total_km: 0, drive_km: 0,
    halt_count: 0, halt_minutes: 0, max_speed_kmh: 0, avg_speed_kmh: 0,
    first_ping_at: null, last_ping_at: null, drive_minutes: 0 } };

  // Insert a virtual "ping" at the check-in point so the trail starts there
  // rather than at the first periodic ping (which can be 10+ min after CI).
  const seq = [];
  if (checkInLat != null && checkInLng != null && checkInAt) {
    seq.push({ lat: Number(checkInLat), lng: Number(checkInLng),
      created_at: checkInAt, accuracy_m: null, _synthetic: true });
  }
  pings.forEach(p => seq.push(p));

  // First pass: distance + speed segments
  let total_km = 0, drive_km = 0, max_speed_kmh = 0, drive_minutes = 0;
  for (let i = 1; i < seq.length; i++) {
    const a = seq[i-1], b = seq[i];
    const dM = _trkDistanceM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
    const mins = _trkMinutesBetween(a.created_at, b.created_at);
    total_km += dM / 1000;
    if (dM >= _TRK_DRIVE_MIN_DIST_M && mins > 0) {
      drive_km += dM / 1000;
      drive_minutes += mins;
      const kmh = (dM / 1000) / (mins / 60);
      if (kmh > max_speed_kmh && kmh < 200 /* cap GPS jitter */) max_speed_kmh = kmh;
    }
  }
  const avg_speed_kmh = drive_minutes > 0 ? (drive_km / (drive_minutes / 60)) : 0;

  // Second pass: cluster consecutive pings into halts
  const halts = [];
  let i = 0;
  while (i < seq.length) {
    let j = i;
    // Extend cluster while we stay within HALT_RADIUS_M of the seed point
    while (j + 1 < seq.length &&
           _trkDistanceM(Number(seq[i].lat), Number(seq[i].lng),
                         Number(seq[j+1].lat), Number(seq[j+1].lng)) <= _TRK_HALT_RADIUS_M) {
      j++;
    }
    const durMin = _trkMinutesBetween(seq[i].created_at, seq[j].created_at);
    if (durMin >= _TRK_HALT_MIN_MIN && (j - i) >= 1) {
      halts.push({
        from: seq[i].created_at,
        to: seq[j].created_at,
        lat: Number(seq[i].lat),
        lng: Number(seq[i].lng),
        duration_min: Math.round(durMin),
        location_name: seq[i].location_name || seq[j].location_name || null
      });
    }
    i = j + 1;
  }
  const halt_minutes = halts.reduce((a, h) => a + h.duration_min, 0);

  return {
    halts,
    metrics: {
      total_km: Number(total_km.toFixed(2)),
      drive_km: Number(drive_km.toFixed(2)),
      drive_minutes: Math.round(drive_minutes),
      halt_count: halts.length,
      halt_minutes,
      max_speed_kmh: Math.round(max_speed_kmh),
      avg_speed_kmh: Math.round(avg_speed_kmh),
      first_ping_at: seq[0] ? seq[0].created_at : null,
      last_ping_at: seq[seq.length-1] ? seq[seq.length-1].created_at : null
    }
  };
}

/**
 * LOCATION_TRACK_v1 — full day trail for one user, ready to render.
 * Includes attendance row, every ping, computed halts, and metrics.
 */
async function api_tracking_dayTrail(token, userId, date) {
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
  // Fast SQL — index on (user_id, date) on attendance, and (attendance_id) on pings.
  const att = (await db.query(
    `SELECT * FROM attendance WHERE user_id = $1 AND date::text = $2 LIMIT 1`,
    [userId, day]
  )).rows[0] || null;
  if (!att) return { attendance: null, pings: [], halts: [], metrics: null };
  const pingsRes = await db.query(
    `SELECT id, lat, lng, location_name, accuracy_m, created_at
       FROM location_pings WHERE attendance_id = $1 ORDER BY created_at ASC`,
    [att.id]
  );
  const pings = pingsRes.rows;
  const { halts, metrics } = _trkComputeHaltsAndKm(
    pings, att.check_in, att.check_in_lat, att.check_in_lng
  );
  return {
    attendance: att,
    pings,
    halts,
    metrics
  };
}

/**
 * LOCATION_TRACK_v1 — live snapshot of every user currently checked in,
 * with status badges for the team map.
 */
async function api_tracking_teamLive(token) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) {
    throw new Error('Admin / manager / team lead only');
  }
  const day = todayIso();
  const visible = await getVisibleUserIds(me);
  const userIdFilter = visible && visible.length ? visible : [me.id];

  // Today's checked-in attendance rows for the users I can see
  const attRes = await db.query(
    `SELECT a.id AS att_id, a.user_id, a.check_in, a.check_out, a.work_mode,
            a.check_in_lat, a.check_in_lng, a.check_in_location_name,
            u.name AS user_name, u.role AS user_role
       FROM attendance a
       JOIN users u ON u.id = a.user_id
      WHERE a.date::text = $1
        AND a.user_id = ANY($2::int[])`,
    [day, userIdFilter]
  );
  const rows = attRes.rows;
  if (!rows.length) return [];

  // Latest ping per attendance_id, plus the previous one so we can tell
  // if the user is moving.
  const attIds = rows.map(r => r.att_id);
  const lastPingRes = await db.query(
    `SELECT DISTINCT ON (attendance_id) attendance_id, lat, lng,
            location_name, accuracy_m, created_at
       FROM location_pings
      WHERE attendance_id = ANY($1::int[])
      ORDER BY attendance_id, created_at DESC`,
    [attIds]
  );
  const lastByAtt = {};
  lastPingRes.rows.forEach(r => { lastByAtt[Number(r.attendance_id)] = r; });

  // Previous ping (one before last) — used to detect "is moving"
  const prevPingRes = await db.query(
    `SELECT attendance_id, lat, lng, created_at FROM (
       SELECT attendance_id, lat, lng, created_at,
              ROW_NUMBER() OVER (PARTITION BY attendance_id ORDER BY created_at DESC) rn
         FROM location_pings WHERE attendance_id = ANY($1::int[])
     ) t WHERE t.rn = 2`,
    [attIds]
  );
  const prevByAtt = {};
  prevPingRes.rows.forEach(r => { prevByAtt[Number(r.attendance_id)] = r; });

  // Today's km per user (lightweight — sum of consecutive distances)
  const allTodayRes = await db.query(
    `SELECT attendance_id, lat, lng, created_at
       FROM location_pings WHERE attendance_id = ANY($1::int[])
       ORDER BY attendance_id, created_at ASC`,
    [attIds]
  );
  const kmByAtt = {};
  const groupedByAtt = {};
  allTodayRes.rows.forEach(r => {
    const aid = Number(r.attendance_id);
    if (!groupedByAtt[aid]) groupedByAtt[aid] = [];
    groupedByAtt[aid].push(r);
  });
  Object.entries(groupedByAtt).forEach(([aid, arr]) => {
    let m = 0;
    for (let i = 1; i < arr.length; i++) {
      m += _trkDistanceM(arr[i-1].lat, arr[i-1].lng, arr[i].lat, arr[i].lng);
    }
    kmByAtt[Number(aid)] = Number((m / 1000).toFixed(1));
  });

  const now = Date.now();
  return rows.map(r => {
    const last = lastByAtt[Number(r.att_id)] || null;
    const prev = prevByAtt[Number(r.att_id)] || null;
    // If no ping yet, fall back to check-in coords
    const lat = last ? Number(last.lat) : Number(r.check_in_lat);
    const lng = last ? Number(last.lng) : Number(r.check_in_lng);
    const lastAt = last ? last.created_at : r.check_in;
    const ageMin = lastAt ? Math.max(0, (now - new Date(lastAt).getTime()) / 60000) : null;
    const movedM = (last && prev) ? _trkDistanceM(last.lat, last.lng, prev.lat, prev.lng) : 0;

    let status = 'offline';
    let stopped_since_min = null;
    if (ageMin == null) status = 'offline';
    else if (r.check_out) status = 'checked_out';
    else if (ageMin <= _TRK_STATUS_DRIVING_MAX_MIN && movedM >= _TRK_DRIVE_MIN_DIST_M) status = 'driving';
    else if (ageMin <= _TRK_STATUS_STOPPED_MAX_MIN) {
      status = 'stopped';
      // How long have they been at this spot? Walk backwards through pings
      // while we stay within the halt radius.
      const arr = (groupedByAtt[Number(r.att_id)] || []).slice().reverse();
      if (arr.length >= 2) {
        const seed = arr[0];
        let earliestSameSpot = seed.created_at;
        for (let i = 1; i < arr.length; i++) {
          if (_trkDistanceM(seed.lat, seed.lng, arr[i].lat, arr[i].lng) <= _TRK_HALT_RADIUS_M) {
            earliestSameSpot = arr[i].created_at;
          } else break;
        }
        stopped_since_min = Math.round(_trkMinutesBetween(earliestSameSpot, new Date().toISOString()));
      }
    }
    else if (ageMin <= _TRK_STATUS_IDLE_MAX_MIN) status = 'idle';
    else status = 'offline';

    return {
      user_id: r.user_id,
      user_name: r.user_name,
      user_role: r.user_role,
      attendance_id: r.att_id,
      lat, lng,
      location_name: last ? (last.location_name || null) : (r.check_in_location_name || null),
      last_ping_at: lastAt,
      last_ping_age_min: ageMin != null ? Math.round(ageMin) : null,
      status,
      stopped_since_min,
      work_mode: r.work_mode,
      check_in_at: r.check_in,
      check_out_at: r.check_out,
      today_km: kmByAtt[Number(r.att_id)] || 0
    };
  });
}


// ============================================================
// REIMBURSE_v1 (2026-05-29) — per-km travel reimbursement
// ============================================================
// Admin configures REIMBURSEMENT_PER_KM (e.g. '1.5'); the system
// converts the existing location-ping data into a monthly cash amount.
// Employee can see their own monthly reimbursement under Salary →
// Travel reimbursement; admin sees the whole team. No double-dip — the
// computation is purely derived from location_pings + attendance, so
// once an employee checks in and uses the app, the amount accumulates
// automatically. Admin marks the row 'paid' to track payouts (stored
// in a tiny key/value config so we don't need yet another table).

async function api_reimburse_policy(token) {
  await authUser(token);
  const [perKm, enabled] = await Promise.all([
    db.getConfig('REIMBURSEMENT_PER_KM', '0'),
    db.getConfig('REIMBURSEMENT_ENABLED', '0')
  ]);
  return {
    per_km: Number(perKm) || 0,
    enabled: String(enabled) === '1'
  };
}

async function api_reimburse_policy_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const rate = Number(p.per_km);
  if (!Number.isFinite(rate) || rate < 0 || rate > 9999) throw new Error('Rate must be between 0 and 9999');
  await db.setConfig('REIMBURSEMENT_PER_KM', String(rate));
  await db.setConfig('REIMBURSEMENT_ENABLED', p.enabled ? '1' : '0');
  return { ok: true };
}

// Returns the per-day km breakdown for one user + month, the running
// total, and the cash reimbursement at the configured rate.
async function api_reimburse_monthly(token, userId, month) {
  const me = await authUser(token);
  const uid = Number(userId) || me.id;
  if (uid !== Number(me.id)) {
    if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Forbidden');
    const visible = await getVisibleUserIds(me);
    if (me.role !== 'admin' && !visible.includes(uid)) throw new Error('Forbidden');
  }
  const ym = String(month || (new Date().toISOString().slice(0, 7))).slice(0, 7);
  const [perKmStr, enabledStr] = await Promise.all([
    db.getConfig('REIMBURSEMENT_PER_KM', '0'),
    db.getConfig('REIMBURSEMENT_ENABLED', '0')
  ]);
  const rate = Number(perKmStr) || 0;
  const enabled = String(enabledStr) === '1';

  // Attendance + pings for this user in this month
  const attRes = await db.query(
    `SELECT id, date, check_in, check_out, check_in_lat, check_in_lng
       FROM attendance
      WHERE user_id = $1
        AND TO_CHAR(date, 'YYYY-MM') = $2
      ORDER BY date ASC`,
    [uid, ym]
  );
  const atts = attRes.rows;
  if (!atts.length) {
    const userRow = (await db.query('SELECT id, name FROM users WHERE id = $1', [uid])).rows[0] || null;
    return {
      enabled, per_km: rate, user: userRow, month: ym,
      days: [], total_km: 0, total_amount: 0, paid: false
    };
  }
  const attIds = atts.map(a => a.id);
  const pingsRes = await db.query(
    `SELECT attendance_id, lat, lng, created_at, location_name
       FROM location_pings WHERE attendance_id = ANY($1::int[])
       ORDER BY attendance_id, created_at ASC`,
    [attIds]
  );
  const groupedByAtt = {};
  pingsRes.rows.forEach(r => {
    const aid = Number(r.attendance_id);
    if (!groupedByAtt[aid]) groupedByAtt[aid] = [];
    groupedByAtt[aid].push(r);
  });

  const days = atts.map(a => {
    const pings = groupedByAtt[Number(a.id)] || [];
    const { metrics } = _trkComputeHaltsAndKm(pings, a.check_in, a.check_in_lat, a.check_in_lng);
    return {
      date: String(a.date).slice(0, 10),
      km: metrics.total_km,
      drive_km: metrics.drive_km,
      amount: Number((metrics.total_km * rate).toFixed(2))
    };
  });
  const total_km = Number(days.reduce((s, d) => s + d.km, 0).toFixed(2));
  const total_amount = Number(days.reduce((s, d) => s + d.amount, 0).toFixed(2));

  // Paid marker (stored as config key, idempotent)
  const paidKey = 'REIMBURSEMENT_PAID:' + uid + ':' + ym;
  const paid = String(await db.getConfig(paidKey, '0')) === '1';

  const userRow = (await db.query('SELECT id, name FROM users WHERE id = $1', [uid])).rows[0] || null;
  return { enabled, per_km: rate, user: userRow, month: ym, days, total_km, total_amount, paid };
}

// Admin / manager view — every user in scope for the month
async function api_reimburse_teamMonth(token, month) {
  // REIMBURSE_PERF_v1.1 (2026-05-29) — batched. The v1 loop fired
  // api_reimburse_monthly per user, each doing its own attendance +
  // pings round-trip + auth check. On a 30-person team that was 60+
  // queries per page load. Now: 3 queries total (attendance, pings,
  // users) + in-memory aggregation.
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Admin / manager only');
  const visible = await getVisibleUserIds(me);
  const userIds = visible && visible.length ? visible : [me.id];
  const ym = String(month || (new Date().toISOString().slice(0, 7))).slice(0, 7);
  const [perKmStr, enabledStr] = await Promise.all([
    db.getConfig('REIMBURSEMENT_PER_KM', '0'),
    db.getConfig('REIMBURSEMENT_ENABLED', '0')
  ]);
  const rate = Number(perKmStr) || 0;
  const enabled = String(enabledStr) === '1';

  if (!enabled || !userIds.length) {
    return { enabled, per_km: rate, month: ym, rows: [] };
  }

  // 1 query for all attendance rows in scope for the month
  const attRes = await db.query(
    `SELECT id, user_id, date, check_in, check_in_lat, check_in_lng
       FROM attendance
      WHERE user_id = ANY($1::int[])
        AND TO_CHAR(date, 'YYYY-MM') = $2`,
    [userIds, ym]
  );
  const atts = attRes.rows;
  if (!atts.length) {
    const usersRes = await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[])', [userIds]);
    return { enabled, per_km: rate, month: ym, rows: usersRes.rows.map(u => ({
      user_id: u.id, user_name: u.name, total_km: 0, total_amount: 0, paid: false
    })).sort((a, b) => a.user_name.localeCompare(b.user_name)) };
  }
  const attIds = atts.map(a => a.id);

  // 1 query for ALL pings in the month across the whole team
  const pingsRes = await db.query(
    `SELECT attendance_id, lat, lng, created_at, location_name
       FROM location_pings WHERE attendance_id = ANY($1::int[])
       ORDER BY attendance_id, created_at ASC`,
    [attIds]
  );
  const pingsByAtt = {};
  pingsRes.rows.forEach(r => {
    const aid = Number(r.attendance_id);
    if (!pingsByAtt[aid]) pingsByAtt[aid] = [];
    pingsByAtt[aid].push(r);
  });

  // 1 query for user names
  const usersRes = await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[])', [userIds]);
  const userById = {};
  usersRes.rows.forEach(u => { userById[Number(u.id)] = u; });

  // 1 query for paid flags (config keys), batched
  const paidKeys = userIds.map(uid => 'REIMBURSEMENT_PAID:' + uid + ':' + ym);
  let paidByUser = {};
  try {
    const paidRes = await db.query(
      'SELECT key, value FROM config WHERE key = ANY($1::text[])',
      [paidKeys]
    );
    paidRes.rows.forEach(r => {
      const m = String(r.key).match(/^REIMBURSEMENT_PAID:(\d+):/);
      if (m) paidByUser[Number(m[1])] = String(r.value) === '1';
    });
  } catch (_) { /* config table shape may vary; fall back to false */ }

  // Aggregate per user in memory
  const totalsByUser = {};
  userIds.forEach(uid => { totalsByUser[uid] = { km: 0 }; });
  atts.forEach(a => {
    const pings = pingsByAtt[Number(a.id)] || [];
    const { metrics } = _trkComputeHaltsAndKm(pings, a.check_in, a.check_in_lat, a.check_in_lng);
    totalsByUser[Number(a.user_id)].km += metrics.total_km;
  });

  const rows = userIds.map(uid => {
    const u = userById[uid];
    if (!u) return null;
    const km = Number((totalsByUser[uid].km || 0).toFixed(2));
    return {
      user_id: u.id,
      user_name: u.name,
      total_km: km,
      total_amount: Number((km * rate).toFixed(2)),
      paid: !!paidByUser[uid]
    };
  }).filter(Boolean);
  rows.sort((a, b) => (b.total_amount || 0) - (a.total_amount || 0));
  return { enabled, per_km: rate, month: ym, rows };
}

// Admin marks a (user, month) row as paid — toggle.
async function api_reimburse_markPaid(token, userId, month, paid) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const ym = String(month || '').slice(0, 7);
  if (!ym || !userId) throw new Error('userId + month required');
  await db.setConfig('REIMBURSEMENT_PAID:' + Number(userId) + ':' + ym, paid ? '1' : '0');
  return { ok: true };
}

module.exports = {
  api_attendance_checkIn, api_attendance_checkOut,
  api_attendance_policy, api_attendance_policy_save,
  api_attendance_mine, api_attendance_team, api_attendance_report,
  api_leaves_mine, api_leaves_apply, api_leaves_pending, api_leaves_decide, api_leaves_all,
  api_tasks_list, api_tasks_save, api_tasks_complete, api_tasks_doneToday,
  api_salary_mine, api_salary_list, api_salary_save,
  api_salary_bulkSave, api_salary_report, api_salary_payslip,
  api_bank_mine, api_bank_save, api_bank_list,
  api_location_ping, api_location_trail,
  api_tracking_dayTrail, api_tracking_teamLive,
  api_reimburse_policy, api_reimburse_policy_save,
  api_reimburse_monthly, api_reimburse_teamMonth, api_reimburse_markPaid
};
