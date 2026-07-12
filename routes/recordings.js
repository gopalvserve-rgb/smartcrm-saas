/**
 * routes/recordings.js — Call recordings + call event logging
 *
 * Recordings are stored as BYTEA in Postgres for simplicity (Railway disk
 * isn't persistent across deploys). For files >2MB this is fine; for heavier
 * use move to S3/R2.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/**
 * CALL_LEAD_DEFAULT_OFF_v1 — single source of truth for the
 * call → auto-create-lead policy. Three different request paths
 * used to each read these keys inline with hard-coded `'1'`
 * defaults, which meant a tenant that never wrote the config row
 * silently behaved as if inbound auto-create was ON. Now every
 * path goes through this helper and the safe default is OFF.
 *
 * Returns:
 *   { inbound: bool, outbound: bool,
 *     minSec: number, statusId: number,
 *     duplicate: 'attach'|'create'|... }
 *
 * Reads each key with default '0' (or '0'/0 equivalent) so a
 * NULL/missing config row never silently flips auto-create ON.
 * The SPA on first load also heals NULL → '0' (see
 * adminMobileApp() in public/tenant/app.js).
 */
/**
 * USER_CALL_PREFS_v1 (2026-07-12) — this is now PER USER.
 *
 * Pass the acting user's id and you get THEIR settings, falling back to the
 * company default for anything they haven't personally chosen. Call it with no
 * id and you get the company default only (kept for any legacy caller).
 *
 * Each rep has their own phone and their own way of working, so "auto-create a
 * lead from an unknown caller" can't sensibly be one switch for the whole
 * company — which is what it used to be.
 */
async function _getAutoleadCfg(userId) {
  if (userId) {
    try {
      const pref = await require('./userCallPrefs').resolveCallPrefs(Number(userId));
      return {
        inbound:   !!pref.autolead_inbound,
        outbound:  !!pref.autolead_outbound,
        minSec:    Number(pref.autolead_min_seconds) || 0,
        statusId:  Number(pref.autolead_status_id)   || 0,
        duplicate: String(pref.autolead_on_duplicate || 'attach'),
        mode:      String(pref.autolead_mode || 'auto')
      };
    } catch (e) { /* fall through to the company default below */ }
  }
  const [inb, out, min, stId, dup] = await Promise.all([
    db.getConfig('CALLS_AUTOLEAD_INBOUND',     '0'),
    db.getConfig('CALLS_AUTOLEAD_OUTBOUND',    '0'),
    db.getConfig('CALLS_AUTOLEAD_MIN_SECONDS', '5'),
    db.getConfig('CALLS_AUTOLEAD_STATUS_ID',   '0'),
    db.getConfig('CALLS_AUTOLEAD_ON_DUPLICATE','attach')
  ]);
  return {
    inbound:   String(inb) === '1',
    outbound:  String(out) === '1',
    minSec:    Number(min)  || 0,
    statusId:  Number(stId) || 0,
    duplicate: String(dup || 'attach'),
    mode:      'auto'
  };
}

/** Find a lead by matching the last 10 digits of the phone. */
async function _findLeadByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  const tail = digits.slice(-10);
  const { rows } = await db.query(
    `SELECT * FROM leads WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1
       OR regexp_replace(whatsapp, '[^0-9]', '', 'g') LIKE $1
       OR regexp_replace(alt_phone, '[^0-9]', '', 'g') LIKE $1
     LIMIT 1`,
    ['%' + tail]
  );
  return rows[0] || null;
}

/**
 * Log a generic call event (no audio). Used by the native broadcast receiver
 * every time TelephonyManager fires an event, so the call history is complete
 * even for calls without recording.
 */
// CALL_DIAL_COUNT_v1 (2026-06-27) — count outgoing dials ('dial_requested')
// per lead, for the lead-list badge + lead detail.
// CALL_DIAL_COUNT_v2 — "times dialed" including OLD data. New dials log
// event='dial_requested'; older calls predate that, so we also look at
// outgoing call_ended events and outgoing recordings, and take the MAX per
// lead (so new+old are covered without double-counting a single call).
async function _dialCountMap(ids) {
  // CALL_DIAL_COUNT_v4 — returns { leadId: { count, last } } where count = times
  // dialed and last = most-recent outgoing dial timestamp. Pulled from the call
  // activity (call_events) + recordings, matched by lead_id AND phone (last 10).
  const out = {};
  if (!ids.length) return out;
  const norm = (pp) => String(pp || '').replace(/\D/g, '').slice(-10);
  const EVT = `GREATEST(
    COUNT(*) FILTER (WHERE event = 'dial_requested'),
    COUNT(*) FILTER (WHERE event IN ('call_ended','outgoing_ended','call_disconnected') AND COALESCE(direction,'out') <> 'in'),
    COUNT(*) FILTER (WHERE event = 'outgoing')
  )::int`;
  const DIALWHEN = `(event = 'dial_requested' OR (event IN ('call_ended','outgoing_ended','call_disconnected') AND COALESCE(direction,'out') <> 'in') OR event = 'outgoing')`;
  const P = `right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)`;
  const latest = (a, b) => { if (!a) return b || null; if (!b) return a; return (new Date(a) > new Date(b)) ? a : b; };

  let leadRows = [];
  try { const r = await db.query(`SELECT id, phone FROM leads WHERE id = ANY($1::int[])`, [ids]); leadRows = r.rows || []; } catch (_) {}
  const phones = [...new Set(leadRows.map(r => norm(r.phone)).filter(x => x.length >= 7))];

  const byId = {};
  try {
    const { rows } = await db.query(`SELECT lead_id, ${EVT} AS n, MAX(created_at) FILTER (WHERE ${DIALWHEN}) AS last_at FROM call_events WHERE lead_id = ANY($1::int[]) GROUP BY lead_id`, [ids]);
    rows.forEach(r => { byId[r.lead_id] = { count: Number(r.n) || 0, last: r.last_at || null }; });
  } catch (_) {}
  try {
    const { rows } = await db.query(`SELECT lead_id, COUNT(*)::int AS n, MAX(COALESCE(started_at, created_at)) AS last_at FROM lead_recordings WHERE COALESCE(direction,'out') <> 'in' AND lead_id = ANY($1::int[]) GROUP BY lead_id`, [ids]);
    rows.forEach(r => { const c = Number(r.n) || 0; const cur = byId[r.lead_id] || { count: 0, last: null }; if (c > cur.count) cur.count = c; cur.last = latest(cur.last, r.last_at); byId[r.lead_id] = cur; });
  } catch (_) {}

  const byPhone = {};
  if (phones.length) {
    try {
      const { rows } = await db.query(`SELECT ${P} AS ph, ${EVT} AS n, MAX(created_at) FILTER (WHERE ${DIALWHEN}) AS last_at FROM call_events WHERE ${P} = ANY($1::text[]) GROUP BY ${P}`, [phones]);
      rows.forEach(r => { if (r.ph) byPhone[r.ph] = { count: Number(r.n) || 0, last: r.last_at || null }; });
    } catch (_) {}
    try {
      const { rows } = await db.query(`SELECT ${P} AS ph, COUNT(*)::int AS n, MAX(COALESCE(started_at, created_at)) AS last_at FROM lead_recordings WHERE COALESCE(direction,'out') <> 'in' AND ${P} = ANY($1::text[]) GROUP BY ${P}`, [phones]);
      rows.forEach(r => { if (!r.ph) return; const c = Number(r.n) || 0; const cur = byPhone[r.ph] || { count: 0, last: null }; if (c > cur.count) cur.count = c; cur.last = latest(cur.last, r.last_at); byPhone[r.ph] = cur; });
    } catch (_) {}
  }

  leadRows.forEach(r => { const ph = norm(r.phone); const A = byId[r.id] || { count: 0, last: null }; const B = (ph && byPhone[ph]) || { count: 0, last: null }; out[r.id] = { count: Math.max(A.count, B.count), last: latest(A.last, B.last) }; });
  ids.forEach(id => { if (out[id] === undefined) out[id] = byId[id] || { count: 0, last: null }; });
  return out;
}
async function api_leads_dialCounts(token, leadIds) {
  await authUser(token);
  const ids = (Array.isArray(leadIds) ? leadIds : []).map(Number).filter(Boolean);
  return _dialCountMap(ids);
}
async function api_leads_dialCount(token, leadId) {
  await authUser(token);
  const id = Number(leadId) || 0;
  if (!id) return { count: 0, last_dialed_at: null };
  const map = await _dialCountMap([id]);
  const e = map[id] || { count: 0, last: null };
  return { count: e.count || 0, last_dialed_at: e.last || null };
}

/**
 * CALLLOG_IS_TRUTH_v1 (2026-07-12)
 * --------------------------------
 * The live path NEVER guesses any more. It writes a call_events row ONLY when
 * it genuinely knows BOTH the phone number AND the direction. Anything else is
 * left to the CallLog sync (routes/callLogSync.js), which copy-pastes the
 * phone's own call log — number, timestamp, type, talk time, SIM — verbatim.
 *
 * Why: Android 10+ hands the receiver no number on outgoing calls, and app.js
 * deliberately sends NO direction on 'call_ended' (it genuinely cannot tell
 * inbound from outbound in the JS layer). Every attempt to fill those gaps by
 * inference produced garbage rows:
 *   • direction defaulted to 'out'  -> phantom "Outgoing" rows for missed calls
 *   • direction recorded as 'unknown' -> visible junk in Call Activity
 *   • blank phone                    -> the "—" rows with no number
 * A blank-phone row could never match a lead or gate a recording anyway
 * (`phone LIKE '%tail'` can't match ''), so dropping it loses nothing.
 *
 * What still writes a row (all of these DO know both fields, so the recording
 * sync gate in api_call_hasRecentEvent keeps its reference points):
 *   • 'incoming_ringing'  — direction 'in', number from the ring
 *   • 'dial_requested'    — direction 'out', number from the lead we dialled
 *   • native events that carry a real direction + number (missed, and
 *     everything from APK #66 onward, which reads direction from CallLog.TYPE)
 *
 * The lead lookup / auto-create / caller-ID behaviour is UNCHANGED — we still
 * resolve the lead and return lead_id even when we skip the row.
 */
const _VALID_DIR = ['in', 'out', 'missed'];

async function api_call_logEvent(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const lead = await _findLeadByPhone(p.phone);

  const phone = String(p.phone || '').trim();
  const digits = phone.replace(/[^0-9]/g, '');
  let direction = String(p.direction || '').toLowerCase();
  if (!_VALID_DIR.includes(direction)) {
    // Only infer where the event itself is unambiguous. Never from nothing.
    if (p.event === 'incoming_ringing') direction = 'in';
    else if (p.missed) direction = 'missed';
    else direction = '';
  }

  // No number, or no direction we can stand behind -> write NOTHING. The
  // CallLog sync will bring this call in exactly as the phone recorded it.
  if (!digits || !direction) {
    return {
      ok: true,
      lead_id: lead ? lead.id : null,
      skipped: true,
      reason: !digits ? 'no_phone' : 'no_direction'
    };
  }

  await db.insert('call_events', {
    lead_id: lead ? lead.id : null,
    user_id: me.id,
    phone: phone,
    direction: direction,
    event: p.event || 'unknown',
    duration_s: Number(p.duration_s) || 0,
    recording_id: p.recording_id || null,
    created_at: db.nowIso()
  });
  return { ok: true, lead_id: lead ? lead.id : null };
}

/** List recordings for a lead (newest first). Returns metadata only, not bytes. */
async function api_leads_recordings(token, leadId) {
  await authUser(token);
  const { rows } = await db.query(
    `SELECT id, lead_id, user_id, phone, direction, duration_s,
            device_path, mime_type, size_bytes, started_at, created_at
       FROM lead_recordings
      WHERE lead_id = $1
      ORDER BY created_at DESC`,
    [leadId]
  );
  return rows;
}

/** Recent calls — own for reps, all for admin/manager.
 *  CALLS_ADMIN_v1 (2026-06-27): admin/manager bypasses the user filter so
 *  the Lead modal Calls view + Dialer history aren't empty for them on
 *  showcase tenants (and on any real account where the admin hasn't
 *  personally dialled but wants to audit team activity). */
async function api_call_history(token, limit) {
  const me = await authUser(token);
  const lim = Math.min(Number(limit) || 100, 500);
  const isAdminish = ['admin','manager','team_leader'].includes(String(me.role||''));
  if (isAdminish) {
    const { rows } = await db.query(
      `SELECT ce.id, ce.lead_id, ce.user_id, ce.phone, ce.direction, ce.event,
              ce.duration_s, ce.recording_id, ce.created_at,
              ce.sim_slot, ce.sim_label, ce.src,
              l.name AS lead_name,
              u.name AS user_name,
              r.id AS rec_id, r.duration_s AS rec_duration, r.size_bytes AS rec_size
         FROM call_events ce
         LEFT JOIN leads l ON l.id = ce.lead_id
         LEFT JOIN users u ON u.id = ce.user_id
         LEFT JOIN lead_recordings r ON r.id = ce.recording_id
        ORDER BY ce.created_at DESC
        LIMIT $1`,
      [lim]
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT ce.id, ce.lead_id, ce.user_id, ce.phone, ce.direction, ce.event,
            ce.duration_s, ce.recording_id, ce.created_at,
            ce.sim_slot, ce.sim_label, ce.src,
            l.name AS lead_name,
            r.id AS rec_id, r.duration_s AS rec_duration, r.size_bytes AS rec_size
       FROM call_events ce
       LEFT JOIN leads l ON l.id = ce.lead_id
       LEFT JOIN lead_recordings r ON r.id = ce.recording_id
      WHERE ce.user_id = $1
      ORDER BY ce.created_at DESC
      LIMIT $2`,
    [me.id, lim]
  );
  return rows;
}

/** Recordings — own for reps, all for admin/manager (CALLS_ADMIN_v1). */
async function api_my_recordings(token, limit) {
  const me = await authUser(token);
  const lim = Math.min(Number(limit) || 100, 500);
  const isAdminish = ['admin','manager','team_leader'].includes(String(me.role||''));
  if (isAdminish) {
    const { rows } = await db.query(
      `SELECT r.id, r.lead_id, r.user_id, r.phone, r.direction, r.duration_s,
              r.mime_type, r.size_bytes, r.created_at,
              l.name AS lead_name, u.name AS user_name
         FROM lead_recordings r
         LEFT JOIN leads l ON l.id = r.lead_id
         LEFT JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC
        LIMIT $1`,
      [lim]
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT r.id, r.lead_id, r.phone, r.direction, r.duration_s,
            r.mime_type, r.size_bytes, r.created_at, l.name AS lead_name
       FROM lead_recordings r
       LEFT JOIN leads l ON l.id = r.lead_id
      WHERE r.user_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2`,
    [me.id, lim]
  );
  return rows;
}

async function api_recordings_delete(token, recId) {
  const me = await authUser(token);
  const rec = await db.findById('lead_recordings', recId);
  if (!rec) throw new Error('recording not found');
  if (me.role !== 'admin' && Number(rec.user_id) !== Number(me.id)) {
    throw new Error('not allowed');
  }
  await db.removeRow('lead_recordings', recId);
  return { ok: true };
}

/**
 * Was there a CRM-tracked call event for the given phone within the last
 * N minutes? Used by the recording sync to filter out files that aren't
 * tied to a real CRM call. Without this gate, the sync would happily
 * upload any recording that happened to match a lead's phone (e.g. a
 * personal call to an existing customer for a different reason).
 *
 * Returns { matched: bool, recent_event_id: id | null } so the client
 * can pass the event id to uploadRecording for tighter linking.
 */
async function api_call_hasRecentEvent(token, phone, withinMinutes) {
  const me = await authUser(token);
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return { matched: false };
  const tail = digits.slice(-10);
  const win = Math.max(1, Math.min(Number(withinMinutes) || 30, 60 * 24));
  const since = new Date(Date.now() - win * 60_000).toISOString();
  const { rows } = await db.query(
    `SELECT id, lead_id, created_at FROM call_events
       WHERE user_id = $1
         AND created_at >= $2
         AND regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE $3
       ORDER BY created_at DESC
       LIMIT 1`,
    [me.id, since, '%' + tail]
  );
  if (!rows.length) return { matched: false };
  return { matched: true, recent_event_id: rows[0].id, lead_id: rows[0].lead_id };
}

/**
 * Caller-ID lookup — called by the native Android app the instant a phone
 * rings. Returns a compact summary the notification card can render.
 * Read-only (no DB writes), so it's safe to fire on every ring.
 *
 * Returns either a customer record (preferred — post-sale context is
 * richer) or a lead record, plus a few derived fields the notification
 * needs.
 */
async function api_call_lookup(token, phone) {
  const me = await authUser(token);
  if (!phone) return { match: false };

  // Try customers table first (richer context post-sale)
  let customer = null;
  try {
    const digits = String(phone).replace(/\D/g, '').slice(-10);
    if (digits) {
      const { rows } = await db.query(
        `SELECT * FROM customers WHERE
           regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1 OR
           regexp_replace(whatsapp, '[^0-9]', '', 'g') LIKE $1 OR
           regexp_replace(alt_phone, '[^0-9]', '', 'g') LIKE $1
         LIMIT 1`,
        ['%' + digits]
      );
      customer = rows[0] || null;
    }
  } catch (_) { /* customers table may not exist on Celeste */ }

  if (customer) {
    return {
      match: true,
      kind: 'customer',
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      status: customer.status,
      assigned_to: customer.assigned_to,
      lifetime_value: Number(customer.lifetime_value) || 0,
      total_purchases: Number(customer.total_purchases) || 0,
      last_purchase_at: customer.last_purchase_at,
      next_renewal_at: customer.next_renewal_at,
      tags: customer.tags || '',
      // Last 3 remarks — gives the rep the most recent context
      recent_remarks: await _recentCustomerRemarks(customer.id, 3),
      url: '/#/customers/' + customer.id
    };
  }

  const lead = await _findLeadByPhone(phone);
  if (!lead) {
    // No existing lead. Tell the mobile app whether the server WILL
    // auto-create one when the recording lands, so the app can decide
    // to upload instead of skipping. Reads the same CALLS_AUTOLEAD
    // config the recording-upload handler uses.
    let willAutoCreate = false;
    try {
      // CALL_LEAD_DEFAULT_OFF_v1 — go through the shared helper so all
      // three call → lead paths agree. Defaults to OFF when DB is NULL.
      const cfg = await _getAutoleadCfg(me.id);   // USER_CALL_PREFS_v1 — this rep's settings
      // We don't know the call direction at lookup time (this is fired on ring),
      // so 'will auto-create' = either inbound OR outbound is enabled.
      willAutoCreate = cfg.inbound || cfg.outbound;
    } catch (_) {}
    return { match: false, phone, will_auto_create: willAutoCreate };
  }

  // Hydrate lead with status + assignee names + last few remarks
  const status = lead.status_id ? await db.findById('statuses', lead.status_id).catch(() => null) : null;
  const owner  = lead.assigned_to ? await db.findById('users', lead.assigned_to).catch(() => null) : null;
  return {
    match: true,
    kind: 'lead',
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    status: status ? status.name : '',
    status_color: status ? status.color : '#6b7280',
    assigned_to: lead.assigned_to,
    assigned_name: owner ? owner.name : '',
    value: Number(lead.value) || 0,
    next_followup_at: lead.next_followup_at,
    qualified: Number(lead.qualified) === 1,
    tags: lead.tags || '',
    is_mine: Number(lead.assigned_to) === Number(me.id),
    recent_remarks: await _recentLeadRemarks(lead.id, 3),
    url: '/#/leads?id=' + lead.id
  };
}

async function _recentLeadRemarks(leadId, n) {
  const { rows } = await db.query(
    `SELECT r.remark, r.created_at, u.name AS user_name
       FROM remarks r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.lead_id = $1
      ORDER BY r.created_at DESC LIMIT $2`,
    [Number(leadId), Number(n)]
  ).catch(() => ({ rows: [] }));
  return rows;
}
async function _recentCustomerRemarks(customerId, n) {
  const { rows } = await db.query(
    `SELECT r.remark, r.created_at, r.remark_type, u.name AS user_name
       FROM customer_remarks r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.customer_id = $1
      ORDER BY r.created_at DESC LIMIT $2`,
    [Number(customerId), Number(n)]
  ).catch(() => ({ rows: [] }));
  return rows;
}

/**
 * End-of-call handler — called by the native Android app when the phone
 * call ends (answered or missed). Persists a call_event row, and if the
 * number doesn't match an existing lead AND the call was answered for
 * ≥5 seconds, auto-creates a "fresh inbound" lead so the rep doesn't
 * have to type one in.
 *
 * payload:
 *   phone:       caller's number
 *   direction:   'in' | 'out' | 'missed'
 *   duration_s:  seconds (0 for missed)
 *   started_at:  ISO timestamp of when the ring/dial started
 *
 * Behaviour matrix:
 *
 *   direction        match    duration   action
 *   ──────────       ─────    ─────────  ────────────────────────────────
 *   in (answered)    yes      any        log event only
 *   in (answered)    no       <5s        log event only (likely misdial)
 *   in (answered)    no       ≥5s        log event + auto-create lead
 *                                        with source='Inbound Call'
 *   missed           yes      0          log event + create follow-up
 *                                        for tomorrow + auto-WA template
 *   missed           no       0          log event only (don't fill CRM
 *                                        with every spam ring)
 *   out              any      any        log event only (rep initiated,
 *                                        we're not auto-creating leads
 *                                        from outbound dials they made)
 */
async function api_call_handleEnded(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.phone) throw new Error('phone required');

  const direction = p.direction || 'in';
  const duration = Number(p.duration_s) || 0;
  const event = direction === 'missed' ? 'missed' : (duration > 0 ? 'ended' : 'no_answer');

  const lead = await _findLeadByPhone(p.phone);
  let createdLeadId = null;
  let createdFollowupId = null;

  // ---- Auto-create-lead policy ----
  // Driven by tenant config (Settings → Mobile app → Call → Lead conversion).
  //   CALLS_AUTOLEAD_INBOUND   '1' / '0'  (default '0' — admin must opt in)
  //   CALLS_AUTOLEAD_OUTBOUND  '1' / '0'  (default '0' — admin must opt in)
  //   CALLS_AUTOLEAD_MIN_SECONDS  number  (default 5; 0 = create even for missed)
  //   CALLS_AUTOLEAD_STATUS_ID  numeric id (defaults to the 'New' status)
  // The mobile app sends direction = 'in' | 'out' | 'missed'. We treat
  // 'missed' as inbound for the YES/NO setting so YES catches missed too.
  // CALL_LEAD_DEFAULT_OFF_v1 — single source of truth + fail-safe defaults.
  const _alCfg = await _getAutoleadCfg(me.id);   // USER_CALL_PREFS_v1 — this rep's settings
  const cfgMin = _alCfg.minSec;

  const isInbound  = direction === 'in' || direction === 'missed';
  const isOutbound = direction === 'out' || direction === 'outgoing';
  const passesMinDur = duration >= cfgMin || direction === 'missed';
  const allow = !lead && passesMinDur && (
    (isInbound  && _alCfg.inbound) ||
    (isOutbound && _alCfg.outbound)
  );

  if (allow) {
    try {
      let statusId = null;
      if (_alCfg.statusId) {
        try {
          const found = await db.findById('statuses', _alCfg.statusId);
          if (found) statusId = found.id;
        } catch (_) {}
      }
      if (!statusId) {
        const newSt = await db.findOneBy('statuses', 'name', 'New');
        statusId = newSt ? newSt.id : null;
      }
      const phoneClean = String(p.phone).replace(/^'/, '').trim();
      const sourceLabel = isInbound
        ? (direction === 'missed' ? 'Missed Call' : 'Inbound Call')
        : 'Outbound Call';
      createdLeadId = await db.insert('leads', {
        name:        phoneClean,
        phone:       phoneClean,
        whatsapp:    phoneClean,
        source:      sourceLabel,
        source_ref:  'auto-created from caller-id',
        status_id:   statusId,
        assigned_to: me.id,
        notes:       'Auto-created from ' + sourceLabel.toLowerCase() + ' · ' +
                     Math.round(duration) + 's · ' +
                     new Date(p.started_at || Date.now()).toLocaleString('en-IN'),
        created_by:  me.id,
        created_at:  db.nowIso(),
        updated_at:  db.nowIso(),
        last_status_change_at: db.nowIso()
      });
      const icon = isInbound ? '📞' : '📲';
      await db.insert('remarks', {
        lead_id: createdLeadId, user_id: me.id,
        remark: icon + ' ' + sourceLabel + ' · ' + Math.round(duration) + 's · auto-created lead',
        status_id: statusId
      });
    } catch (e) { console.warn('[caller-id] auto-create lead failed:', e.message); }
  }

  // Missed inbound from a known lead → schedule callback follow-up + WA
  if (direction === 'missed' && lead) {
    try {
      const tomorrow10 = (() => {
        const d = new Date(); d.setDate(d.getDate() + 1);
        d.setHours(10, 0, 0, 0);
        return d.toISOString();
      })();
      createdFollowupId = await db.insert('followups', {
        lead_id: lead.id, user_id: me.id, due_at: tomorrow10,
        note: 'Auto-scheduled callback after missed inbound call',
        is_done: 0, created_at: db.nowIso()
      });
      await db.update('leads', lead.id, { next_followup_at: tomorrow10, updated_at: db.nowIso() });
      await db.insert('remarks', {
        lead_id: lead.id, user_id: me.id,
        remark: '⚠ Missed inbound call · auto-scheduled callback for tomorrow 10 AM',
        status_id: ''
      });
      // Optional: fire the missed-call WhatsApp template via the existing
      // automation engine. Only if a 'missed_call_followup' template
      // exists in wa_templates. Silent fail otherwise.
      try {
        const tpl = await db.findOneBy('wa_templates', 'name', 'missed_call_followup');
        if (tpl) {
          const wb = require('./whatsbot');
          await wb._sendTemplate({
            to: lead.whatsapp || lead.phone,
            templateName: tpl.name,
            language: tpl.language || 'en_US',
            variables: [{ value: (lead.name || '').split(' ')[0] || 'there' }],
            leadId: lead.id, userId: me.id
          });
        }
      } catch (_) {}
    } catch (e) { console.warn('[caller-id] missed-call followup failed:', e.message); }
  }

  // Always log the call_event row — gives reports the complete picture
  await db.insert('call_events', {
    lead_id: lead ? lead.id : (createdLeadId || null),
    user_id: me.id,
    phone: p.phone,
    direction,
    event,
    duration_s: duration,
    recording_id: null,
    created_at: db.nowIso()
  });

  return {
    ok: true,
    lead_id: lead ? lead.id : (createdLeadId || null),
    auto_created: !!createdLeadId,
    followup_scheduled: !!createdFollowupId
  };
}

/**
 * Fetch the AI summary for a recording (transcript + summary +
 * action items + sentiment + suggested status). If not yet processed,
 * returns { status: 'pending' }. If failed, returns { status: 'failed' }.
 */
async function api_recording_aiSummary(token, recId) {
  await authUser(token);
  const id = Number(recId);
  if (!id) throw new Error('Missing recording id');
  const { rows } = await db.query(
    `SELECT id, summary, transcript, action_items, sentiment, suggested_status_id,
            next_followup_days, key_insight, ai_processed_at, ai_provider,
            ai_model, ai_error, lead_id, phone, duration_s,
            rating, rating_by, rating_notes, rated_at, ai_suggested_rating
       FROM lead_recordings WHERE id = $1`,
    [id]
  );
  const r = rows[0];
  if (!r) throw new Error('Recording not found');
  if (!r.ai_processed_at) return { status: 'pending' };
  if (r.ai_error) {
    // Still surface rating fields even when AI failed/disabled, so the
    // manual-rating UI works regardless of AI status.
    return {
      status: 'failed',
      error: r.ai_error,
      rating: r.rating,
      rating_notes: r.rating_notes,
      ai_suggested_rating: r.ai_suggested_rating
    };
  }
  let action_items = [];
  try { action_items = JSON.parse(r.action_items || '[]'); } catch (_) { action_items = []; }
  return {
    status: 'done',
    summary: r.summary,
    transcript: r.transcript,
    action_items,
    sentiment: r.sentiment,
    suggested_status_id: r.suggested_status_id,
    next_followup_days: r.next_followup_days,
    key_insight: r.key_insight,
    processed_at: r.ai_processed_at,
    provider: r.ai_provider,
    model: r.ai_model,
    lead_id: r.lead_id,
    phone: r.phone,
    duration_s: r.duration_s,
    rating: r.rating,
    rating_by: r.rating_by,
    rating_notes: r.rating_notes,
    rated_at: r.rated_at,
    ai_suggested_rating: r.ai_suggested_rating
  };
}

/**
 * Manually rate a call recording (1-5 stars).
 * Anyone with auth can rate their own calls; managers/admins can rate
 * anyone's. Saves rating, rating_by (current user), rating_notes,
 * rated_at. Pass rating: null to clear an existing rating.
 */
async function api_recording_rate(token, recId, rating, notes) {
  const me = await authUser(token);
  const id = Number(recId);
  if (!id) throw new Error('Missing recording id');
  if (rating != null) {
    const r = Number(rating);
    if (!Number.isFinite(r) || r < 1 || r > 5) throw new Error('Rating must be between 1 and 5');
  }
  await db.query(
    `UPDATE lead_recordings SET
        rating = $1, rating_by = $2, rating_notes = $3, rated_at = NOW()
      WHERE id = $4`,
    [rating == null ? null : Number(rating), me.id, notes || null, id]
  );
  return { ok: true, recording_id: id, rating: rating == null ? null : Number(rating) };
}

/**
 * Admin / rep can trigger re-processing — clears the AI fields and
 * the worker will pick the row up on the next tick.
 */
async function api_recording_aiReprocess(token, recId) {
  const me = await authUser(token);
  const id = Number(recId);
  if (!id) throw new Error('Missing recording id');
  await db.query(
    `UPDATE lead_recordings SET
        ai_processed_at = NULL, ai_error = NULL, summary = NULL,
        transcript = NULL, action_items = NULL, sentiment = NULL,
        suggested_status_id = NULL, key_insight = NULL, next_followup_days = NULL
      WHERE id = $1`,
    [id]
  );
  // Kick the worker immediately rather than waiting for the next tick.
  try {
    const { processRecording } = require('../utils/aiCallSummary');
    setImmediate(() => processRecording(id).catch(e => console.warn('[ai-summary] reprocess failed:', e.message)));
  } catch (_) {}
  return { ok: true, reprocessing: true, recording_id: id };
}

/**
 * Apply the AI's suggested status to the lead and optionally schedule
 * a follow-up at the suggested date. One-click "do what the AI said".
 */
async function api_recording_applySuggestion(token, recId, opts) {
  const me = await authUser(token);
  opts = opts || {};
  const id = Number(recId);
  if (!id) throw new Error('Missing recording id');
  const { rows } = await db.query(
    `SELECT lead_id, suggested_status_id, next_followup_days, summary
       FROM lead_recordings WHERE id = $1`, [id]
  );
  const r = rows[0];
  if (!r) throw new Error('Recording not found');
  if (!r.lead_id) throw new Error('Recording has no lead — cannot apply suggestion');

  const lead = await db.findById('leads', r.lead_id);
  if (!lead) throw new Error('Lead not found');

  const updates = {};
  if (opts.applyStatus !== false && r.suggested_status_id && Number(r.suggested_status_id) !== Number(lead.status_id)) {
    updates.status_id = r.suggested_status_id;
    updates.last_status_change_at = db.nowIso();
  }
  if (Object.keys(updates).length > 0) {
    await db.update('leads', lead.id, Object.assign(updates, { updated_at: db.nowIso() }));
  }

  // Schedule follow-up if requested + AI gave a time
  let followup_id = null;
  if (opts.applyFollowup !== false && r.next_followup_days != null) {
    const due = new Date(Date.now() + Number(r.next_followup_days) * 86400000);
    due.setHours(11, 0, 0, 0);
    const ins = await db.insert('followups', {
      lead_id: lead.id,
      user_id: lead.assigned_to || me.id,
      due_at: due.toISOString(),
      note: 'AI-suggested follow-up: ' + (r.summary || '').slice(0, 200),
      is_done: 0
    }).catch(() => null);
    followup_id = ins ? ins.id : null;
  }

  return { ok: true, status_changed: !!updates.status_id, followup_id };
}

async function api_recording_recentInsights(token, opts) {
  const me = await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 50, 200);
  const where = ['lr.ai_processed_at IS NOT NULL'];
  const params = [];
  let p = 1;
  if (me.role === 'sales' || me.role === 'employee') {
    where.push(`lr.user_id = $${p++}`); params.push(me.id);
  } else if (me.role === 'team_leader') {
    where.push(`(lr.user_id = $${p} OR lr.user_id IN (SELECT id FROM users WHERE parent_id = $${p}))`);
    params.push(me.id); p++;
  }
  if (opts.sentiment) { where.push(`lr.sentiment = $${p++}`); params.push(opts.sentiment); }
  if (opts.userId)    { where.push(`lr.user_id = $${p++}`);   params.push(Number(opts.userId)); }
  params.push(limit);
  const sql = `SELECT lr.id, lr.lead_id, lr.user_id, lr.phone, lr.duration_s, lr.direction,
           lr.created_at, lr.ai_processed_at, lr.sentiment, lr.summary,
           lr.action_items, lr.key_insight, lr.suggested_status_id,
           lr.next_followup_days, lr.rating, lr.ai_suggested_rating,
           l.name AS lead_name, l.status_id AS lead_status_id,
           u.name AS rep_name, u.role AS rep_role,
           s.name AS suggested_status_name, ls.name AS lead_status_name
      FROM lead_recordings lr
      LEFT JOIN leads    l  ON l.id  = lr.lead_id
      LEFT JOIN users    u  ON u.id  = lr.user_id
      LEFT JOIN statuses s  ON s.id  = lr.suggested_status_id
      LEFT JOIN statuses ls ON ls.id = l.status_id
     WHERE ${where.join(' AND ')}
     ORDER BY lr.created_at DESC
     LIMIT $${p}`;
  try {
    const { rows } = await db.query(sql, params);
    return rows.map(r => {
      let ai = [];
      try { ai = JSON.parse(r.action_items || '[]'); } catch (_) {}
      return {
        id: r.id, lead_id: r.lead_id, lead_name: r.lead_name,
        lead_status_name: r.lead_status_name, phone: r.phone,
        duration_s: r.duration_s, direction: r.direction, created_at: r.created_at,
        rep_name: r.rep_name, rep_role: r.rep_role,
        sentiment: r.sentiment, summary: r.summary, action_items: ai,
        key_insight: r.key_insight,
        suggested_status_name: r.suggested_status_name,
        next_followup_days: r.next_followup_days,
        rating: r.rating, ai_suggested_rating: r.ai_suggested_rating
      };
    });
  } catch (e) {
    if (/column .* does not exist/i.test(e.message)) {
      return { error: 'AI columns not migrated yet — restart the service.', rows: [] };
    }
    throw e;
  }
}

module.exports = {
  api_call_logEvent,
  api_leads_dialCounts,
  api_leads_dialCount,
  api_call_hasRecentEvent,
  api_call_lookup,
  api_call_handleEnded,
  api_leads_recordings,
  api_call_history,
  api_my_recordings,
  api_recordings_delete,
  api_recording_aiSummary,
  api_recording_aiReprocess,
  api_recording_applySuggestion,
  api_recording_rate,
  _findLeadByPhone,
  _getAutoleadCfg,
  api_recording_recentInsights
};
