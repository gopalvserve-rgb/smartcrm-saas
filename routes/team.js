// TEAM_LIVE_STATUS_v1 (2026-05-28)
// ------------------------------------------------------------------
// Real-time "Team Live Status" panel. For every active user we infer
// one of these states using existing tables — no new schema needed:
//
//   on_call         — most recent call_event in last 5 min is one of
//                     dial_requested / incoming_ringing / answered AND
//                     no paired "ended" / "missed" newer than it.
//   wrapping_up     — last call_event ended in the last 2 minutes.
//   on_break        — user toggled an explicit Break via api_team_setBreak.
//                     Stored in config table as user_break:<id> = '1' until
//                     api_team_setBreak(off).
//   checked_out     — attendance has check_out today.
//   logged_out      — last_login_at older than ~10h AND no attendance today.
//   never_logged_in — no last_login_at row at all.
//   idle            — anything else (logged in today, no current call).
//
// The endpoint also returns a summary roll-up so the SPA can show
// chip counters like "Idle (6) · On call (11) · ...".
// ------------------------------------------------------------------

const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const _perms = require('./permissions');

async function _safe(fn, fallback) {
  try { return await fn(); } catch (_) { return fallback; }
}

/**
 * Walk every active user and compute their current state.
 * Optional payload: { only_active: true }.
 */
async function api_team_liveStatus(token, _payload) {
  // TEAM_LIVE_PERMS_v1 (2026-06-10) — Live Team Status visibility:
  //   - admin                         → sees every active user
  //   - custom role w/ hierarchy 0    → admin-equivalent, sees every user
  //   - every other role (managers,
  //     team leaders, sales,
  //     employees, custom levels 1+)  → sees ONLY their own row
  //
  // This is intentionally stricter than getVisibleUserIds (which
  // surfaces team hierarchies). The product decision is that the
  // dashboard widget should never reveal another caller's break /
  // on-call / on-task state to a non-admin teammate.
  const me = await authUser(token);

  // TEAM_LIVE_PERMS_v2 (2026-06-10) — read from the role permissions matrix
  // (Settings → Permissions → 'View Live Team Status (whole team)').
  //   - granted  → see all active users (team grid)
  //   - revoked  → see only their own row + summary counts only themselves
  // Admins always pass (the permissions module enforces that). Custom roles
  // with hierarchy_level=0 are admin-equivalent in getVisibleUserIds, but
  // here we always defer to the matrix so the admin's Permissions screen
  // is the single source of truth.
  // DASHBOARD_SCOPE_v1 — scope to users the requester may see per team hierarchy.
  // teamStatusUserIds returns: null=all (admin), [ids] for everyone else.
  const _allowedIds = await _perms.teamStatusUserIds(me);

  let users = (await db.getAll('users') || []).filter(u => Number(u.is_active) !== 0);
  if (_allowedIds !== null) {
    const _allow = new Set(_allowedIds.map(Number));
    users = users.filter(u => _allow.has(Number(u.id)));
  }
  // Today's date in IST so we don't bleed into yesterday on midnight rollover.
  const istNow = new Date(Date.now() + (5.5 * 3600 * 1000));
  const todayIso = istNow.toISOString().slice(0, 10);

  // ---- Pull lookup data in parallel ------------------------------
  const [attendance, callEvents, configRows] = await Promise.all([
    _safe(() => db.getAll('attendance'),  []),
    _safe(async () => {
      // Only the last 30 min is enough for on-call / wrapping detection.
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const r = await db.query(
        `SELECT id, user_id, event, phone, created_at
           FROM call_events
          WHERE created_at >= $1
          ORDER BY created_at DESC
          LIMIT 1000`,
        [cutoff]
      );
      return r.rows || [];
    }, []),
    _safe(() => db.getAll('config'), [])
  ]);

  // Index attendance by user_id for today
  const attByUser = {};
  attendance.forEach(a => {
    if (String(a.date).slice(0, 10) !== todayIso) return;
    attByUser[Number(a.user_id)] = a;
  });

  // Group call_events by user, newest first
  const callsByUser = {};
  callEvents.forEach(e => {
    const uid = Number(e.user_id);
    if (!uid) return;
    (callsByUser[uid] = callsByUser[uid] || []).push(e);
  });
  // TEAM_LIVE_API_FIX_v2 — also pull the most-recent call per user from a
  // wider window so 'Offline' / 'Idle' rows can say 'last call at <time>'.
  const lastCallByUser = await _safe(async () => {
    const r = await db.query(
      `SELECT DISTINCT ON (user_id) user_id, phone, event, created_at
         FROM call_events
        WHERE user_id IS NOT NULL
          AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY user_id, created_at DESC`,
      []
    );
    const out = {};
    (r.rows || []).forEach(row => { out[Number(row.user_id)] = row; });
    return out;
  }, {});

  // TEAM_LIVE_ACTIVITY_SOURCE_v1 — same lookup against the lead_actions
  // table (the table Activity Report reads). Gives us a wider signal for
  // 'last time this user did anything' — not just calls but remarks,
  // status changes, lead edits, WhatsApp sends, etc. Used as another
  // effective-login fallback and surfaced to the SPA as last_action_at.
  const lastActionByUser = await _safe(async () => {
    const r = await db.query(
      `SELECT DISTINCT ON (user_id) user_id, action_type, created_at
         FROM lead_actions
        WHERE user_id IS NOT NULL
          AND created_at >= NOW() - INTERVAL '7 days'
        ORDER BY user_id, created_at DESC`,
      []
    );
    const out = {};
    (r.rows || []).forEach(row => { out[Number(row.user_id)] = row; });
    return out;
  }, {});

  // Break flags from config table
  const breakFlags = {};
  const taskFlags  = {};  // TEAM_STATUS_TASKS_v1 — { user_id → { task_id, started_at } }
  configRows.forEach(c => {
    const m = String(c.key || '').match(/^user_break:(\d+)$/);
    if (m && String(c.value || '').trim() === '1') breakFlags[Number(m[1])] = true;
    const t = String(c.key || '').match(/^user_task:(\d+)$/);
    if (t && String(c.value || '').trim()) {
      const v = String(c.value).trim();
      const idx = v.indexOf(':');
      const taskId = idx > 0 ? v.slice(0, idx) : v;
      const startedAt = idx > 0 ? v.slice(idx + 1) : null;
      if (taskId) taskFlags[Number(t[1])] = { task_id: taskId, started_at: startedAt };
    }
  });
  // Load task catalogue once so we can hydrate labels.
  const _taskList = (await _loadTasks().catch(() => [])).concat(DEFAULT_TASKS);
  const _taskById = {};
  _taskList.forEach(t => { if (!_taskById[t.id]) _taskById[t.id] = t; });

  const now = Date.now();
  const STATE_ORDER = [
    'on_call', 'on_task', 'wrapping_up', 'on_break', 'idle',
    'checked_out', 'logged_out', 'never_logged_in'
  ];
  const summary = STATE_ORDER.reduce((m, k) => (m[k] = 0, m), {});

  const result = users.map(u => {
    const uid = Number(u.id);
    const att = attByUser[uid];
    const calls = callsByUser[uid] || [];
    const lastCall = calls[0];
    const lc = lastCallByUser[uid];
    const la = lastActionByUser[uid];
    const lastLogin = u.last_login_at ? new Date(u.last_login_at).getTime() : 0;

    // TEAM_LIVE_LASTLOGIN_FIX_v1 — derive an effective login signal:
    //   1) users.last_login_at (the column we now stamp on login)
    //   2) attendance.check_in today (mobile users may not POST login)
    //   3) any call_event for this user in the wider 7-day window
    //      (means they were active at some point)
    let effectiveLogin = lastLogin;
    if (!effectiveLogin && att && att.check_in) {
      effectiveLogin = new Date(att.check_in).getTime();
    }
    if (!effectiveLogin && la && la.created_at) {
      effectiveLogin = new Date(la.created_at).getTime();
    }
    if (!effectiveLogin && lc && lc.created_at) {
      effectiveLogin = new Date(lc.created_at).getTime();
    }

    let state = 'idle';
    let since = effectiveLogin || null;
    let sub = '';

    // TEAM_STATUS_TASKS_v1 — Custom task wins over break/idle/etc.
    // Only on-call beats it (we still want to know the rep is actually on
    // a phone call, even if they had set themselves "In Demo" earlier).
    if (taskFlags[uid]) {
      const tf = taskFlags[uid];
      const meta = _taskById[tf.task_id] || { label: tf.task_id, icon: '🟣', color: '#6366f1' };
      state = 'on_task';
      since = tf.started_at ? new Date(tf.started_at).getTime() : now;
      sub = meta.label;
    }
    // 1. On break wins over almost everything
    else if (breakFlags[uid]) {
      state = 'on_break';
    }
    // 2. On-call detection
    else if (lastCall && /^(outgoing_call|incoming_ringing|call_answered|dial_requested|answered|dialing|ringing)$/.test(String(lastCall.event))) {
      // No newer end?
      const newerEnd = calls.find(e =>
        new Date(e.created_at).getTime() > new Date(lastCall.created_at).getTime()
        && /^(call_ended|ended|missed|hangup|completed|disconnected)$/.test(String(e.event))
      );
      if (!newerEnd) {
        state = 'on_call';
        since = new Date(lastCall.created_at).getTime();
        sub = lastCall.phone || '';
      }
    }

    if (state === 'idle') {
      // 3. Wrapping up: just-ended call in last 120s
      const endedRecent = calls.find(e =>
        /^(call_ended|ended|missed|hangup|completed|disconnected)$/.test(String(e.event))
        && (now - new Date(e.created_at).getTime()) < 120 * 1000
      );
      if (endedRecent) {
        state = 'wrapping_up';
        since = new Date(endedRecent.created_at).getTime();
      }
    }

    if (state === 'idle') {
      // 4. Attendance check_out today → checked_out
      if (att && att.check_out) {
        state = 'checked_out';
        since = new Date(att.check_out).getTime();
      }
      // 5. No login signal at all → never_logged_in.
      //    Else stale login + no attendance → logged_out (Offline).
      else if (!effectiveLogin) {
        state = 'never_logged_in';
        since = null;
      }
      else if (!att && (now - effectiveLogin) > 10 * 3600 * 1000) {
        state = 'logged_out';
        since = effectiveLogin;
      }
      // Otherwise stays idle
    }

    summary[state] = (summary[state] || 0) + 1;

    const _tf = taskFlags[uid];
    const _tmeta = _tf ? (_taskById[_tf.task_id] || null) : null;
    return {
      id: uid,
      name: u.name || u.email || ('User #' + uid),
      role: u.role || '',
      email: u.email || '',
      state,
      since_iso: since ? new Date(since).toISOString() : null,
      since_min: since ? Math.max(0, Math.round((now - since) / 60000)) : null,
      sub,
      last_call_at: lc ? new Date(lc.created_at).toISOString() : null,
      last_call_phone: lc ? (lc.phone || '') : '',
      last_call_event: lc ? String(lc.event || '') : '',
      last_action_at: la ? new Date(la.created_at).toISOString() : null,
      last_action_type: la ? String(la.action_type || '') : '',
      task: _tf ? {
        id: _tf.task_id,
        label: _tmeta ? _tmeta.label : _tf.task_id,
        icon:  _tmeta ? _tmeta.icon  : '🟣',
        color: _tmeta ? _tmeta.color : '#6366f1',
        started_at: _tf.started_at
      } : null
    };
  });

  // Sort: on_call → wrapping → on_break → idle → checked_out → logged_out → never
  const order = Object.fromEntries(STATE_ORDER.map((s, i) => [s, i]));
  result.sort((a, b) => (order[a.state] - order[b.state]) || a.name.localeCompare(b.name));

  return {
    summary,
    users: result,
    server_now: new Date().toISOString()
  };
}

/**
 * Explicit on/off Break toggle. The CALLER's user_id is the one toggled —
 * we don't allow flipping someone else's state from this endpoint.
 */
async function api_team_setBreak(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const on = p.on === true || p.on === 1 || p.on === '1';
  const key = 'user_break:' + me.id;
  try {
    if (on) {
      await db.query(
        `INSERT INTO config (key, value) VALUES ($1, '1')
         ON CONFLICT (key) DO UPDATE SET value = '1'`,
        [key]
      );
    } else {
      await db.query(`DELETE FROM config WHERE key = $1`, [key]);
    }
  } catch (e) {
    // Last-resort: try the helper APIs
    try {
      if (on) await db.setConfig(key, '1');
      else    await db.setConfig(key, '');
    } catch (_) { throw e; }
  }
  return { ok: true, on, user_id: me.id };
}

/* ====================================================================
 * TEAM_STATUS_TASKS_v1 — admin-defined "Offline tasks" (Demo, Meeting,
 * Lunch, Training, etc.) that any user can flag themselves as currently
 * doing. The task is stored in the existing `config` table:
 *   - team_status_tasks               → JSON list of tasks
 *   - user_task:<user_id>             → "<task_id>:<started_iso>"
 * Live status surfaces a new state 'on_task' with the task's label /
 * icon / colour and a summary chip per custom task.
 * ==================================================================== */

const DEFAULT_TASKS = [
  { id: 'demo',     label: 'In Demo',     icon: '🎤', color: '#8b5cf6' },
  { id: 'meeting',  label: 'In Meeting',  icon: '👥', color: '#0ea5e9' },
  { id: 'lunch',    label: 'On Lunch',    icon: '🍽', color: '#f59e0b' },
  { id: 'training', label: 'In Training', icon: '📚', color: '#10b981' }
];

async function _loadTasks() {
  try {
    const raw = await db.getConfig('team_status_tasks', '');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch (_) {}
  return [];
}

async function api_team_tasks_list(token) {
  await authUser(token);
  const tasks = await _loadTasks();
  return tasks.length ? tasks : DEFAULT_TASKS;
}

async function api_team_tasks_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const tasks = Array.isArray(payload) ? payload : (payload && payload.tasks) || [];
  // Sanitize + dedupe by id, generate id if missing.
  const seen = new Set();
  const clean = [];
  for (const t of tasks) {
    const id = String(t.id || '').trim() || String(t.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 32);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    clean.push({
      id,
      label: String(t.label || id).slice(0, 60),
      icon:  String(t.icon  || '🟣').slice(0, 8),
      color: String(t.color || '#6366f1').slice(0, 16)
    });
    if (clean.length >= 30) break;
  }
  await db.setConfig('team_status_tasks', JSON.stringify(clean));
  return { ok: true, count: clean.length };
}

async function api_team_setMyTask(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const taskId = p.task_id ? String(p.task_id) : '';
  const key = 'user_task:' + me.id;
  if (!taskId) {
    try { await db.query(`DELETE FROM config WHERE key = $1`, [key]); } catch (_) {
      try { await db.setConfig(key, ''); } catch (_) {}
    }
    return { ok: true, task_id: null };
  }
  // Verify the task exists (so we don't store garbage)
  const all = (await _loadTasks().catch(() => [])).concat(DEFAULT_TASKS);
  const exists = all.some(t => String(t.id) === taskId);
  if (!exists) throw new Error('Unknown task');
  const value = taskId + ':' + new Date().toISOString();
  try {
    await db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, value]
    );
  } catch (e) {
    try { await db.setConfig(key, value); } catch (_) { throw e; }
  }
  return { ok: true, task_id: taskId, started_at: value.split(':').slice(1).join(':') };
}

module.exports = {
  api_team_liveStatus,
  api_team_setBreak,
  api_team_tasks_list,    /* TEAM_STATUS_TASKS_v1 */
  api_team_tasks_save,    /* TEAM_STATUS_TASKS_v1 */
  api_team_setMyTask      /* TEAM_STATUS_TASKS_v1 */
};
