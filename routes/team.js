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
const { authUser } = require('./auth');

async function _safe(fn, fallback) {
  try { return await fn(); } catch (_) { return fallback; }
}

/**
 * Walk every active user and compute their current state.
 * Optional payload: { only_active: true }.
 */
async function api_team_liveStatus(token, _payload) {
  await authUser(token);

  const users = (await db.getAll('users') || []).filter(u => Number(u.is_active) !== 0);
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
        `SELECT id, user_id, event_type, phone, created_at
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

  // Break flags from config table
  const breakFlags = {};
  configRows.forEach(c => {
    const m = String(c.key || '').match(/^user_break:(\d+)$/);
    if (m && String(c.value || '').trim() === '1') breakFlags[Number(m[1])] = true;
  });

  const now = Date.now();
  const STATE_ORDER = [
    'on_call', 'wrapping_up', 'on_break', 'idle',
    'checked_out', 'logged_out', 'never_logged_in'
  ];
  const summary = STATE_ORDER.reduce((m, k) => (m[k] = 0, m), {});

  const result = users.map(u => {
    const uid = Number(u.id);
    const att = attByUser[uid];
    const calls = callsByUser[uid] || [];
    const lastCall = calls[0];
    const lastLogin = u.last_login_at ? new Date(u.last_login_at).getTime() : 0;

    let state = 'idle';
    let since = lastLogin || null;
    let sub = '';

    // 1. On break wins over almost everything
    if (breakFlags[uid]) {
      state = 'on_break';
    }
    // 2. On-call detection
    else if (lastCall && /^(dial_requested|incoming_ringing|answered|dialing|ringing)$/.test(String(lastCall.event_type))) {
      // No newer end?
      const newerEnd = calls.find(e =>
        new Date(e.created_at).getTime() > new Date(lastCall.created_at).getTime()
        && /^(ended|missed|hangup|completed|disconnected)$/.test(String(e.event_type))
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
        /^(ended|missed|hangup|completed|disconnected)$/.test(String(e.event_type))
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
      // 5. No login today and no attendance → never / logged_out
      else if (!lastLogin) {
        state = 'never_logged_in';
        since = null;
      }
      else if (!att && (now - lastLogin) > 10 * 3600 * 1000) {
        state = 'logged_out';
        since = lastLogin;
      }
      // Otherwise stays idle
    }

    summary[state] = (summary[state] || 0) + 1;

    return {
      id: uid,
      name: u.name || u.email || ('User #' + uid),
      role: u.role || '',
      email: u.email || '',
      state,
      since_iso: since ? new Date(since).toISOString() : null,
      since_min: since ? Math.max(0, Math.round((now - since) / 60000)) : null,
      sub
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

module.exports = {
  api_team_liveStatus,
  api_team_setBreak
};
