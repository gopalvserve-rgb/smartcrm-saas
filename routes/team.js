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

    // 1. On break wins over almost everything
    if (breakFlags[uid]) {
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
      last_action_type: la ? String(la.action_type || '') : ''
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
