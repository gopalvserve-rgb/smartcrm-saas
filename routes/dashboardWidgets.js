/**
 * routes/dashboardWidgets.js
 *
 * DASHBOARD_REDESIGN_v1 — Phase 1
 *
 * Backend APIs for the new dashboard structure (Gopal's 2-page sketch).
 * Each function honors a global date range (filters.from / filters.to in
 * 'YYYY-MM-DD'), the report timezone, and visibility scope (admin sees
 * all, manager sees self+tree, sales sees self).
 *
 * Why a new file (vs appending to routes/reports.js): the existing
 * reports.js is 2k+ lines and is already a hot spot. Adding 7 endpoints
 * for a single feature here keeps them grep-able and lets us reuse a
 * single _resolveRange / _scopeUsers helper across all widgets.
 *
 * Endpoints:
 *   1. api_dashboard_followupCountsByUser  -> tabbed widget (Due / Overdue / Upcoming)
 *   2. api_dashboard_callerWiseLeads       -> assignee-wise lead totals (page 2)
 *   3. api_dashboard_callerDialingReport   -> per-user call activity (page 2)
 *   4. api_dashboard_lastWaMessages        -> latest 5 inbound WA msgs (admin all / user mine)
 *   5. api_dashboard_lastRemarks           -> latest 5 remarks (admin all / user mine)
 *   6. api_dashboard_waReportMini          -> Sent / Delivered / Read / Failed for range
 *   7. api_dashboard_tatViolationMini      -> TAT breach count (today + open), split by user
 *
 * Date-range semantics:
 *   from / to are inclusive day boundaries in REPORT_TZ.
 *   If from is omitted we default to today.
 *   If to is omitted we default to from.
 */

'use strict';

const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

const REPORT_TZ = process.env.TIMEZONE || 'Asia/Kolkata';
const _tzFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
});

function _todayStr() { return _tzFmt.format(new Date()); }

/** Return the REPORT_TZ offset like "+05:30" for the given date. */
function _tzOffsetString(d) {
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const loc = new Date(d.toLocaleString('en-US', { timeZone: REPORT_TZ }));
  const mins = Math.round((loc - utc) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const a = Math.floor(Math.abs(mins) / 60);
  const b = Math.abs(mins) % 60;
  return sign + String(a).padStart(2, '0') + ':' + String(b).padStart(2, '0');
}

/** Normalize { from, to } -> { fromIso, toIso, fromDay, toDay } */
function _resolveRange(filters) {
  const f = filters || {};
  const fromDay = String(f.from || _todayStr()).slice(0, 10);
  const toDay   = String(f.to   || fromDay).slice(0, 10);
  const offset = _tzOffsetString(new Date(fromDay + 'T12:00:00Z'));
  const fromIso = fromDay + 'T00:00:00' + offset;
  const toIso   = toDay   + 'T23:59:59.999' + offset;
  return { fromIso, toIso, fromDay, toDay };
}

// ----------------------------------------------------------------
// 1. Follow-up counts by user (Due Today / Overdue / Upcoming)
// ----------------------------------------------------------------
async function api_dashboard_followupCountsByUser(token, filters) {
  const me = await authUser(token);
  const f = filters || {};
  const range = _resolveRange(f);
  const tab = String(f.tab || 'due_today');

  let scopeSql = '';
  const params = [range.fromIso, range.toIso];
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) return [];
    scopeSql = ' AND l.assigned_to = ANY($3::int[])';
    params.push(visible);
  }

  const sql = `
    WITH due AS (
      SELECT l.assigned_to AS user_id,
             COUNT(*) FILTER (
               WHERE COALESCE(f.due_at, l.next_followup_at) >= $1
                 AND COALESCE(f.due_at, l.next_followup_at) <= $2
             )::int AS due_today,
             COUNT(*) FILTER (
               WHERE COALESCE(f.due_at, l.next_followup_at) < $1
             )::int AS overdue,
             COUNT(*) FILTER (
               WHERE COALESCE(f.due_at, l.next_followup_at) > $2
                 AND COALESCE(f.due_at, l.next_followup_at) <= ($2::timestamptz + INTERVAL '14 days')
             )::int AS upcoming
        FROM leads l
        LEFT JOIN followups f
               ON f.lead_id = l.id
              AND COALESCE(f.is_done, 0) = 0
       WHERE l.assigned_to IS NOT NULL
         AND COALESCE(f.due_at, l.next_followup_at) IS NOT NULL
         ${scopeSql}
       GROUP BY l.assigned_to
    )
    SELECT u.id AS user_id, u.name, u.role,
           COALESCE(due.due_today, 0) AS due_today,
           COALESCE(due.overdue,   0) AS overdue,
           COALESCE(due.upcoming,  0) AS upcoming
      FROM users u
      LEFT JOIN due ON due.user_id = u.id
     WHERE COALESCE(u.is_active, 1) = 1
     ORDER BY ${tab === 'overdue' ? 'overdue' : tab === 'upcoming' ? 'upcoming' : 'due_today'} DESC, u.name ASC
  `;

  try {
    const r = await db.query(sql, params);
    return r.rows
      .map(row => ({
        user_id:   Number(row.user_id),
        name:      row.name || '',
        role:      row.role || '',
        due_today: Number(row.due_today) || 0,
        overdue:   Number(row.overdue)   || 0,
        upcoming:  Number(row.upcoming)  || 0
      }))
      .filter(r => (r.due_today + r.overdue + r.upcoming) > 0);
  } catch (e) {
    console.warn('[dashboard followupCountsByUser]', e.message);
    return [];
  }
}

// ----------------------------------------------------------------
// 2. Caller-wise leads — assignee-wise totals over the date range
// ----------------------------------------------------------------
async function api_dashboard_callerWiseLeads(token, filters) {
  const me = await authUser(token);
  const range = _resolveRange(filters || {});

  let scopeSql = '';
  const params = [range.fromIso, range.toIso];
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) return [];
    scopeSql = ' AND l.assigned_to = ANY($3::int[])';
    params.push(visible);
  }

  const sql = `
    SELECT l.assigned_to AS user_id,
           COUNT(*)::int                                                                        AS total,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(s.name, '')) IN ('new'))::int                  AS new_count,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(s.name, '')) IN ('won', 'closed won'))::int    AS won_count,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(s.name, '')) IN ('lost', 'closed lost'))::int  AS lost_count
      FROM leads l
      LEFT JOIN statuses s ON s.id = l.status_id
     WHERE l.created_at >= $1 AND l.created_at <= $2
       AND l.assigned_to IS NOT NULL
       ${scopeSql}
     GROUP BY l.assigned_to
     ORDER BY total DESC
  `;

  try {
    const r = await db.query(sql, params);
    const users = await db.getAll('users');
    const byId = {};
    users.forEach(u => { byId[Number(u.id)] = u; });
    return r.rows.map(row => ({
      user_id:    Number(row.user_id),
      name:       (byId[Number(row.user_id)] && byId[Number(row.user_id)].name) || ('User #' + row.user_id),
      total:      Number(row.total)      || 0,
      new_count:  Number(row.new_count)  || 0,
      won_count:  Number(row.won_count)  || 0,
      lost_count: Number(row.lost_count) || 0,
      open_count: (Number(row.total) || 0) - (Number(row.won_count) || 0) - (Number(row.lost_count) || 0)
    }));
  } catch (e) {
    console.warn('[dashboard callerWiseLeads]', e.message);
    return [];
  }
}

// ----------------------------------------------------------------
// 3. Caller dialing report — per-user call activity totals
// ----------------------------------------------------------------
async function api_dashboard_callerDialingReport(token, filters) {
  const me = await authUser(token);
  const range = _resolveRange(filters || {});

  let scopeSql = '';
  const params = [range.fromIso, range.toIso];
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) return [];
    scopeSql = ' AND ce.user_id = ANY($3::int[])';
    params.push(visible);
  }

  const sql = `
    WITH base AS (
      SELECT ce.user_id, ce.phone, ce.direction, ce.event,
             ce.duration_s AS evt_duration,
             ce.recording_id, ce.created_at,
             lr.duration_s AS rec_duration
        FROM call_events ce
        LEFT JOIN lead_recordings lr ON lr.id = ce.recording_id
       WHERE ce.created_at >= $1 AND ce.created_at <= $2
         AND ce.user_id IS NOT NULL
         AND ce.event != 'autodial_requested'
         ${scopeSql}
    ),
    bucketed AS (
      SELECT user_id, phone,
             date_trunc('minute', created_at) -
               ((EXTRACT(MINUTE FROM created_at)::int % 5) * INTERVAL '1 minute') AS bucket,
             (ARRAY_AGG(direction ORDER BY
               CASE direction WHEN 'missed' THEN 1 WHEN 'out' THEN 2 WHEN 'in' THEN 3 ELSE 9 END
             ))[1] AS direction,
             GREATEST(COALESCE(MAX(rec_duration), 0), COALESCE(MAX(evt_duration), 0))::int AS duration_s
        FROM base
       GROUP BY user_id, phone, bucket
    )
    SELECT user_id,
           COUNT(*) FILTER (WHERE direction = 'in')::int     AS incoming,
           COUNT(*) FILTER (WHERE direction = 'out')::int    AS outgoing,
           COUNT(*) FILTER (WHERE direction = 'missed')::int AS missed,
           COUNT(*)::int                                     AS total_calls,
           COALESCE(SUM(duration_s) FILTER (WHERE duration_s > 0), 0)::int AS total_talk_s,
           COUNT(*) FILTER (WHERE duration_s > 0)::int       AS connected
      FROM bucketed
     GROUP BY user_id
     ORDER BY total_calls DESC
  `;

  try {
    const r = await db.query(sql, params);
    const users = await db.getAll('users');
    const byId = {};
    users.forEach(u => { byId[Number(u.id)] = u; });
    return r.rows.map(row => ({
      user_id:      Number(row.user_id),
      name:         (byId[Number(row.user_id)] && byId[Number(row.user_id)].name) || ('User #' + row.user_id),
      incoming:     Number(row.incoming)     || 0,
      outgoing:     Number(row.outgoing)     || 0,
      missed:       Number(row.missed)       || 0,
      total_calls:  Number(row.total_calls)  || 0,
      total_talk_s: Number(row.total_talk_s) || 0,
      connected:    Number(row.connected)    || 0
    }));
  } catch (e) {
    console.warn('[dashboard callerDialingReport]', e.message);
    return [];
  }
}

// ----------------------------------------------------------------
// 4. Last WhatsApp messages (inbound feed)
//    Admin: latest 5 across tenant
//    User:  latest 5 on leads they own
// ----------------------------------------------------------------
async function api_dashboard_lastWaMessages(token, filters) {
  const me = await authUser(token);
  const f = filters || {};
  const limit = Math.min(Number(f.limit) || 5, 20);

  let fromIso, toIso;
  if (f.from || f.to) {
    const r = _resolveRange(f);
    fromIso = r.fromIso; toIso = r.toIso;
  } else {
    fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    toIso   = new Date().toISOString();
  }

  let leadScope = '';
  const params = [fromIso, toIso];
  let p = 3;
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) return [];
    leadScope = ` AND (l.assigned_to = ANY($${p}::int[]))`;
    params.push(visible);
    p += 1;
  }
  params.push(limit);

  const sql = `
    SELECT wm.id, wm.lead_id, wm.direction, wm.from_number, wm.to_number,
           wm.body, wm.message_type, wm.media_url, wm.created_at,
           l.name AS lead_name, l.assigned_to,
           u.name AS assignee_name
      FROM whatsapp_messages wm
      LEFT JOIN leads l ON l.id = wm.lead_id
      LEFT JOIN users u ON u.id = l.assigned_to
     WHERE wm.direction = 'in'
       AND wm.created_at >= $1 AND wm.created_at <= $2
       ${leadScope}
     ORDER BY wm.created_at DESC
     LIMIT $${p}
  `;

  try {
    const r = await db.query(sql, params);
    return r.rows.map(row => ({
      id:            Number(row.id),
      lead_id:       row.lead_id ? Number(row.lead_id) : null,
      lead_name:     row.lead_name || '',
      assignee_name: row.assignee_name || '',
      direction:     row.direction,
      from_number:   row.from_number || '',
      to_number:     row.to_number   || '',
      body:          (row.body || '').slice(0, 240),
      message_type:  row.message_type || 'text',
      media_url:     row.media_url || '',
      created_at:    row.created_at
    }));
  } catch (e) {
    console.warn('[dashboard lastWaMessages]', e.message);
    return [];
  }
}

// ----------------------------------------------------------------
// 5. Last remarks
// ----------------------------------------------------------------
async function api_dashboard_lastRemarks(token, filters) {
  const me = await authUser(token);
  const f = filters || {};
  const limit = Math.min(Number(f.limit) || 5, 20);

  let fromIso, toIso;
  if (f.from || f.to) {
    const r = _resolveRange(f);
    fromIso = r.fromIso; toIso = r.toIso;
  } else {
    fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    toIso   = new Date().toISOString();
  }

  let leadScope = '';
  const params = [fromIso, toIso];
  let p = 3;
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) return [];
    leadScope = ` AND l.assigned_to = ANY($${p}::int[])`;
    params.push(visible);
    p += 1;
  }
  params.push(limit);

  const sql = `
    SELECT r.id, r.lead_id, r.user_id, r.remark, r.status_id, r.created_at,
           l.name AS lead_name, l.assigned_to,
           u.name AS author_name,
           s.name AS status_name
      FROM remarks r
      LEFT JOIN leads    l ON l.id = r.lead_id
      LEFT JOIN users    u ON u.id = r.user_id
      LEFT JOIN statuses s ON s.id = r.status_id
     WHERE r.created_at >= $1 AND r.created_at <= $2
       ${leadScope}
     ORDER BY r.created_at DESC
     LIMIT $${p}
  `;

  try {
    const rr = await db.query(sql, params);
    return rr.rows.map(row => ({
      id:          Number(row.id),
      lead_id:     row.lead_id ? Number(row.lead_id) : null,
      lead_name:   row.lead_name || '',
      author_id:   row.user_id ? Number(row.user_id) : null,
      author_name: row.author_name || '',
      status_id:   row.status_id ? Number(row.status_id) : null,
      status_name: row.status_name || '',
      remark:      (row.remark || '').slice(0, 240),
      created_at:  row.created_at
    }));
  } catch (e) {
    console.warn('[dashboard lastRemarks]', e.message);
    return [];
  }
}

// ----------------------------------------------------------------
// 6. WhatsApp report mini — Sent / Delivered / Read / Failed
// ----------------------------------------------------------------
async function api_dashboard_waReportMini(token, filters) {
  const me = await authUser(token);
  const range = _resolveRange(filters || {});

  let userScope = '';
  const params = [range.fromIso, range.toIso];
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) {
      return { sent: 0, delivered: 0, read: 0, failed: 0, inbound: 0, from: range.fromDay, to: range.toDay };
    }
    userScope = ' AND user_id = ANY($3::int[])';
    params.push(visible);
  }

  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE direction = 'out')::int                          AS sent,
      COUNT(*) FILTER (WHERE direction = 'out' AND status = 'delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE direction = 'out' AND status = 'read')::int      AS read,
      COUNT(*) FILTER (WHERE direction = 'out' AND status = 'failed')::int    AS failed,
      COUNT(*) FILTER (WHERE direction = 'in')::int                           AS inbound
    FROM whatsapp_messages
    WHERE created_at >= $1 AND created_at <= $2
      ${userScope}
  `;
  try {
    const r = await db.query(sql, params);
    const row = r.rows[0] || {};
    return {
      sent:      Number(row.sent)      || 0,
      delivered: Number(row.delivered) || 0,
      read:      Number(row.read)      || 0,
      failed:    Number(row.failed)    || 0,
      inbound:   Number(row.inbound)   || 0,
      from:      range.fromDay,
      to:        range.toDay
    };
  } catch (e) {
    console.warn('[dashboard waReportMini]', e.message);
    return { sent: 0, delivered: 0, read: 0, failed: 0, inbound: 0, from: range.fromDay, to: range.toDay };
  }
}

// ----------------------------------------------------------------
// 7. TAT violation mini
// ----------------------------------------------------------------
async function api_dashboard_tatViolationMini(token, filters) {
  const me = await authUser(token);
  const range = _resolveRange(filters || {});

  let userScope = '';
  const params = [range.fromIso, range.toIso];
  let scopeParams = [];
  if (!(me.role === 'admin' || me.role === 'super_admin')) {
    const visible = await getVisibleUserIds(me);
    if (!visible || !visible.length) {
      return { open_total: 0, triggered_in_range: 0, by_user: [], from: range.fromDay, to: range.toDay };
    }
    userScope = ' AND tv.user_id = ANY($3::int[])';
    params.push(visible);
    scopeParams = [visible];
  }

  const sql = `
    SELECT
      COUNT(*) FILTER (WHERE tv.resolved_at IS NULL)::int                AS open_total,
      COUNT(*) FILTER (
        WHERE tv.triggered_at >= $1 AND tv.triggered_at <= $2
      )::int                                                             AS triggered_in_range
    FROM tat_violations tv
    WHERE 1=1
      ${userScope}
  `;
  let totalRow = { open_total: 0, triggered_in_range: 0 };
  try {
    const r = await db.query(sql, params);
    totalRow = r.rows[0] || totalRow;
  } catch (e) {
    console.warn('[dashboard tatViolationMini totals]', e.message);
  }

  // Top-5 by user (open only)
  let byUser = [];
  try {
    const byUserSql = `
      SELECT tv.user_id, COUNT(*)::int AS open_count, u.name
        FROM tat_violations tv
        LEFT JOIN users u ON u.id = tv.user_id
       WHERE tv.resolved_at IS NULL
         AND tv.user_id IS NOT NULL
         ${scopeParams.length ? 'AND tv.user_id = ANY($1::int[])' : ''}
       GROUP BY tv.user_id, u.name
       ORDER BY open_count DESC
       LIMIT 5
    `;
    const r = await db.query(byUserSql, scopeParams);
    byUser = r.rows.map(row => ({
      user_id:    Number(row.user_id),
      name:       row.name || ('User #' + row.user_id),
      open_count: Number(row.open_count) || 0
    }));
  } catch (e) {
    console.warn('[dashboard tatViolationMini byUser]', e.message);
  }

  return {
    open_total:         Number(totalRow.open_total)         || 0,
    triggered_in_range: Number(totalRow.triggered_in_range) || 0,
    by_user:            byUser,
    from:               range.fromDay,
    to:                 range.toDay
  };
}

module.exports = {
  api_dashboard_followupCountsByUser,
  api_dashboard_callerWiseLeads,
  api_dashboard_callerDialingReport,
  api_dashboard_lastWaMessages,
  api_dashboard_lastRemarks,
  api_dashboard_waReportMini,
  api_dashboard_tatViolationMini,
  // Helpers exported for unit tests
  _resolveRange,
  _tzOffsetString
};
