/*
 * ============================================================
 * 🔒 LOCKED FILE — Recording & Call Sync Pipeline
 * ============================================================
 * This entire file is part of the call/recording sync pipeline.
 * Functions here power: lead matching, call history, recording
 * playback, AI summary, and the /api/recordings upload flow.
 *
 * BEFORE editing — read docs/LOCKED_FILES.md and
 * RECORDING_ARCHITECTURE_AND_LOCKDOWN.md (workspace root), then
 * ASK THE USER explicitly. No silent refactors. Small targeted
 * patches only.
 * ============================================================
 */

// PROMISE_TRACK_v1
/**
 * routes/recordings.js — Call recordings + call event logging
 *
 * Recordings are stored as BYTEA in Postgres for simplicity (Railway disk
 * isn't persistent across deploys). For files >2MB this is fine; for heavier
 * use move to S3/R2.
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

/**
 * Find a lead by matching the last N digits of the phone.
 *
 * Default match is last 10 digits (covers Indian mobiles with or without
 * country code +91/91/0). Falls back to shorter tails for the rare case
 * the recorded phone is shorter than 10 digits (landlines, test data).
 *
 * Compares against phone, whatsapp, AND alt_phone columns, all
 * with all non-digit characters stripped on both sides.
 */
async function _findLeadByPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  // Try tails of decreasing length so we find a match for short test
  // numbers too (8 / 9 digits) without losing precision on real ones.
  const candidates = [];
  if (digits.length >= 10) candidates.push(digits.slice(-10));
  if (digits.length >= 9)  candidates.push(digits.slice(-9));
  if (digits.length >= 8)  candidates.push(digits.slice(-8));
  if (!candidates.length)  candidates.push(digits);
  for (const tail of candidates) {
    // Primary columns
    let { rows } = await db.query(
      `SELECT * FROM leads
        WHERE regexp_replace(COALESCE(phone, ''),     '[^0-9]', '', 'g') LIKE $1
           OR regexp_replace(COALESCE(whatsapp, ''),  '[^0-9]', '', 'g') LIKE $1
           OR regexp_replace(COALESCE(alt_phone, ''), '[^0-9]', '', 'g') LIKE $1
        ORDER BY (regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE $1) DESC,
                 id DESC
        LIMIT 1`,
      ['%' + tail]
    );
    if (rows[0]) return rows[0];
    // Fallback — match against extra_phones array stored as JSON in extra_json.
    // Strips non-digits from every element so we tolerate whatever the user pasted.
    try {
      const r2 = await db.query(
        `SELECT * FROM leads
           WHERE extra_json IS NOT NULL
             AND extra_json::text ~ '"extra_phones"'
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(
                 COALESCE((extra_json::jsonb)->'extra_phones', '[]'::jsonb)
               ) AS ep
               WHERE regexp_replace(ep, '[^0-9]', '', 'g') LIKE $1
             )
           ORDER BY id DESC LIMIT 1`,
        ['%' + tail]
      );
      if (r2.rows && r2.rows[0]) return r2.rows[0];
    } catch (_) { /* older tenants may have extra_json as TEXT — best-effort */ }
  }
  return null;
}

/**
 * Log a generic call event (no audio). Used by the native broadcast receiver
 * every time TelephonyManager fires an event, so the call history is complete
 * even for calls without recording.
 */
async function api_call_logEvent(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  let lead = await _findLeadByPhone(p.phone);

  // Direction inference. The mobile WebView bridge can't tell us
  // whether a 'call_ended' was inbound or outbound (the native
  // broadcast doesn't carry direction). So:
  //   * explicit direction param wins
  //   * 'incoming_ringing' is obviously inbound
  //   * 'call_ended' / 'incoming_missed' → look at the last call_event
  //     for this phone in the past 5 min. If we saw RINGING from this
  //     number then this is an INBOUND call ending. Else default 'out'.
  let direction = p.direction;
  if (!direction) {
    if (p.event === 'incoming_ringing') direction = 'in';
    else if (p.phone) {
      try {
        const tail = String(p.phone).replace(/\D/g, '').slice(-10);
        const { rows } = await db.query(
          `SELECT direction, event FROM call_events
            WHERE created_at >= NOW() - INTERVAL '5 minutes'
              AND phone LIKE $1
              AND direction IN ('in','missed','out')
            ORDER BY created_at DESC LIMIT 1`,
          ['%' + tail]
        );
        if (rows[0]) {
          direction = (rows[0].direction === 'in' || rows[0].direction === 'missed') ? 'in' : 'out';
        } else {
          direction = 'out';
        }
      } catch (e) {
        direction = 'out';
      }
    } else {
      direction = 'out';
    }
  }
  // Missed-call detection — if the call_ended event came in but no
  // OFFHOOK happened (caller never picked up), the native side passes
  // missed=true and direction='missed'. Honour that.
  if (p.missed === true || p.missed === 'true' || String(p.missed) === '1') {
    direction = 'missed';
  }

  // ---- Auto-create-lead the MOMENT a call rings ----
  // Driven by the same tenant config the recording-upload handler uses,
  // so the policy stays consistent:
  //   CALLS_AUTOLEAD_INBOUND   '1' / '0'  (default '1')
  //   CALLS_AUTOLEAD_OUTBOUND  '1' / '0'  (default '0')
  //   CALLS_AUTOLEAD_STATUS_ID numeric id (defaults to 'New' status)
  // Previously this only ran on recording upload — minutes after the call
  // ends. Doing it on RING means the lead is in the CRM immediately, so
  // (a) WhatsApp messages on the same number land on the right lead,
  // (b) the rep can open the lead from notification before the call ends,
  // (c) bot/AI hooks for new leads fire in real time.
  let autoCreatedNow = false;
  if (!lead && p.phone) {
    try {
      // CALLS_AUTOLEAD_MODE = 'auto' (default) → create immediately
      //                       'manual' → log call_event only; admin reviews
      //                                    + bulk-converts from the UI.
      const cfgMode = String(await db.getConfig('CALLS_AUTOLEAD_MODE', 'auto') || 'auto').toLowerCase();
      const cfgIn  = await db.getConfig('CALLS_AUTOLEAD_INBOUND',  '1');
      const cfgOut = await db.getConfig('CALLS_AUTOLEAD_OUTBOUND', '0');
      const isInbound  = direction === 'in' || direction === 'missed';
      const isOutbound = direction === 'out' || direction === 'outgoing';
      const allowedByDirection = (isInbound  && String(cfgIn)  === '1') ||
                                 (isOutbound && String(cfgOut) === '1');
      // In manual mode, never auto-create — but DO still log the
      // call_event below so the admin's 'Pending calls' UI lists it.
      const allow = cfgMode === 'auto' && allowedByDirection;
      if (allow) {
        const cfgStId = Number(await db.getConfig('CALLS_AUTOLEAD_STATUS_ID', '0')) || 0;
        let statusId = null;
        if (cfgStId) {
          try { const f = await db.findById('statuses', cfgStId); if (f) statusId = f.id; } catch (_) {}
        }
        if (!statusId) {
          const newSt = await db.findOneBy('statuses', 'name', 'New');
          statusId = newSt ? newSt.id : null;
        }
        const phoneClean = String(p.phone).replace(/^'/, '').trim();
        const sourceLabel = isInbound ? 'Inbound Call' : 'Outbound Call';
        const newLeadId = await db.insert('leads', {
          name:        phoneClean,
          phone:       phoneClean,
          whatsapp:    phoneClean,
          source:      sourceLabel,
          source_ref:  'auto-created on call ring',
          status_id:   statusId,
          assigned_to: me.id,
          notes:       'Auto-created from ' + sourceLabel.toLowerCase() + ' at ' +
                       new Date().toLocaleString('en-IN'),
          created_by:  me.id,
          created_at:  db.nowIso(),
          updated_at:  db.nowIso(),
          last_status_change_at: db.nowIso()
        });
        try {
          await db.insert('remarks', {
            lead_id: newLeadId, user_id: me.id,
            remark: '\uD83D\uDCDE ' + sourceLabel + ' \u00B7 auto-created on call ring',
            status_id: statusId
          });
        } catch (_) {}
        lead = { id: newLeadId };
        autoCreatedNow = true;
        console.log('[call-event] auto-created lead', newLeadId, 'for', phoneClean, 'on', direction);
      }
    } catch (e) { console.warn('[call-event] auto-create failed:', e.message); }
  }

  await db.insert('call_events', {
    lead_id: lead ? lead.id : null,
    user_id: me.id,
    phone: p.phone || '',
    direction,
    event: p.event || 'unknown',
    duration_s: Number(p.duration_s) || 0,
    recording_id: p.recording_id || null,
    created_at: db.nowIso()
  });
  return { ok: true, lead_id: lead ? lead.id : null, auto_created: autoCreatedNow };
}

/**
 * List call_events without a linked lead (lead_id IS NULL).
 * Used by Manual mode — admin reviews + bulk-converts.
 * Honours role visibility (admin/manager sees team, others see own).
 */
async function api_call_events_pending(token, opts) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const ids = (visible && visible.length) ? visible : [me.id];
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  const limit = Math.max(1, Math.min(500, Number((opts && opts.limit) || 100)));
  const days  = Math.max(1, Math.min(90, Number((opts && opts.days)  || 30)));
  const params = [...ids, days, limit];
  const { rows } = await db.query(
    `SELECT ce.id, ce.user_id, ce.phone, ce.direction, ce.event,
            ce.duration_s, ce.created_at,
            u.name AS rep_name
       FROM call_events ce
       LEFT JOIN users u ON u.id = ce.user_id
      WHERE ce.lead_id IS NULL
        AND ce.user_id IN (${placeholders})
        AND ce.created_at >= NOW() - ($${ids.length + 1}::int || ' days')::interval
        AND COALESCE(ce.phone, '') <> ''
      ORDER BY ce.created_at DESC
      LIMIT $${ids.length + 2}`,
    params
  );
  return rows;
}

/**
 * Bulk-convert a list of pending call_events to leads. One lead per
 * UNIQUE phone (so two missed calls from the same number share one
 * lead). Returns the per-row outcome so the SPA can render a summary.
 */
async function api_call_events_convertToLeads(token, callEventIds) {
  const me = await authUser(token);
  const visible = await getVisibleUserIds(me);
  const idsArr = Array.isArray(callEventIds) ? callEventIds.map(Number).filter(Boolean) : [];
  if (!idsArr.length) return { ok: false, error: 'no ids supplied' };

  // Pull the events the user has visibility on.
  const allowedUserIds = (visible && visible.length) ? visible : [me.id];
  const userPlaceholders = allowedUserIds.map((_, i) => '$' + (i + 2)).join(',');
  const { rows: events } = await db.query(
    `SELECT id, user_id, phone, direction, duration_s, created_at
       FROM call_events
      WHERE id = ANY($1::int[])
        AND user_id IN (${userPlaceholders})
        AND lead_id IS NULL
        AND COALESCE(phone, '') <> ''`,
    [idsArr, ...allowedUserIds]
  );

  // Resolve default new-lead status once.
  const cfgStId = Number(await db.getConfig('CALLS_AUTOLEAD_STATUS_ID', '0')) || 0;
  let defaultStatusId = null;
  if (cfgStId) {
    try { const f = await db.findById('statuses', cfgStId); if (f) defaultStatusId = f.id; } catch (_) {}
  }
  if (!defaultStatusId) {
    const newSt = await db.findOneBy('statuses', 'name', 'New');
    defaultStatusId = newSt ? newSt.id : null;
  }

  // Group events by phone so we create ONE lead per unique number.
  const byPhone = new Map();
  for (const e of events) {
    const tail = String(e.phone || '').replace(/\D/g, '').slice(-10);
    if (!tail) continue;
    if (!byPhone.has(tail)) byPhone.set(tail, []);
    byPhone.get(tail).push(e);
  }

  const created = [];
  const skipped = [];
  for (const [tail, group] of byPhone.entries()) {
    // Skip if a lead already exists for that phone (race-safe).
    const existing = await _findLeadByPhone(tail);
    if (existing) {
      // Link the events to the existing lead so they don't show as
      // pending anymore.
      const ids = group.map(g => g.id);
      try {
        await db.query('UPDATE call_events SET lead_id = $1 WHERE id = ANY($2::int[])', [existing.id, ids]);
      } catch (_) {}
      skipped.push({ phone: group[0].phone, reason: 'already a lead', existing_lead_id: existing.id, events: ids });
      continue;
    }
    try {
      const first = group[0];
      const phoneClean = String(first.phone).replace(/^'/, '').trim();
      const dir = first.direction || 'in';
      const sourceLabel = (dir === 'missed') ? 'Missed Call'
                       : (dir === 'in')     ? 'Inbound Call'
                       : 'Outbound Call';
      const newLeadId = await db.insert('leads', {
        name:        phoneClean,
        phone:       phoneClean,
        whatsapp:    phoneClean,
        source:      sourceLabel,
        source_ref:  'auto-created from manual call-event convert',
        status_id:   defaultStatusId,
        assigned_to: first.user_id || me.id,
        notes:       'Auto-created from ' + group.length + ' call event(s) on ' +
                     new Date(first.created_at).toLocaleString('en-IN'),
        created_by:  me.id,
        created_at:  db.nowIso(),
        updated_at:  db.nowIso(),
        last_status_change_at: db.nowIso()
      });
      try {
        await db.insert('remarks', {
          lead_id: newLeadId, user_id: me.id,
          remark: '\uD83D\uDCDE Bulk-converted ' + group.length + ' \u00D7 ' + sourceLabel.toLowerCase(),
          status_id: defaultStatusId
        });
      } catch (_) {}
      // Link all events in the group to the new lead.
      const evIds = group.map(g => g.id);
      try {
        await db.query('UPDATE call_events SET lead_id = $1 WHERE id = ANY($2::int[])', [newLeadId, evIds]);
      } catch (_) {}
      created.push({ phone: phoneClean, lead_id: newLeadId, events: evIds, source: sourceLabel });
    } catch (e) {
      skipped.push({ phone: group[0].phone, reason: e.message, events: group.map(g => g.id) });
    }
  }

  return {
    ok: true,
    requested: idsArr.length,
    matched_events: events.length,
    leads_created: created.length,
    skipped: skipped.length,
    created,
    skipped_detail: skipped
  };
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

/** Recent calls for the current user (call history list). */
async function api_call_history(token, limit) {
  const me = await authUser(token);
  const lim = Math.min(Number(limit) || 100, 500);
  const { rows } = await db.query(
    `SELECT ce.id, ce.lead_id, ce.user_id, ce.phone, ce.direction, ce.event,
            ce.duration_s, ce.recording_id, ce.created_at,
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

/** All recordings belonging to the current user, newest first. */
async function api_my_recordings(token, limit) {
  const me = await authUser(token);
  const lim = Math.min(Number(limit) || 100, 500);
  // Visibility rules — same pattern the rest of the app uses:
  //   admin/manager/team_leader → recordings of every user they can see
  //   sales/employee           → only their own
  // This means an admin logging in on desktop sees the whole team's
  // recordings (which is what they need for performance review),
  // while individual reps still see only their own.
  const visible = await getVisibleUserIds(me);
  const ids = (visible && visible.length) ? visible : [me.id];
  const placeholders = ids.map((_, i) => '$' + (i + 1)).join(',');
  const { rows } = await db.query(
    `SELECT r.id, r.lead_id, r.phone, r.direction, r.duration_s,
            r.mime_type, r.size_bytes, r.created_at, r.user_id,
            l.name AS lead_name,
            u.name AS rep_name
       FROM lead_recordings r
       LEFT JOIN leads l ON l.id = r.lead_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.user_id IN (${placeholders})
      ORDER BY r.created_at DESC
      LIMIT $${ids.length + 1}`,
    [...ids, lim]
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
 * Bulk-delete every recording in the tenant. Admin only. Returns the
 * number of rows removed. Also clears the diagnostic log so the new
 * empty state isn't polluted by old failure rows.
 */
async function api_recordings_resetAll(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Wipe recording rows AND call_event rows that referenced them. Without
  // this second DELETE, the Call History tab still shows entries with
  // broken/404 audio players (the call_event still has recording_id).
  const r = await db.query('DELETE FROM lead_recordings');
  // Also kill the call_events that pointed at recordings — keep the
  // pure-event rows (calls that never had a recording) untouched.
  let events = 0;
  try {
    const e = await db.query("DELETE FROM call_events WHERE event = 'recording_saved' OR recording_id IS NOT NULL");
    events = (e && e.rowCount) || 0;
  } catch (_) { /* table shape varies — best effort */ }
  let diag = 0;
  try {
    const d = await db.query('DELETE FROM recording_diag_log');
    diag = (d && d.rowCount) || 0;
  } catch (_) { /* table may not exist */ }
  return {
    ok: true,
    deleted: (r && r.rowCount) || 0,
    call_events_cleared: events,
    diag_cleared: diag
  };
}

/**
 * Relink orphan recordings to leads by phone. Walks every row where
 * lead_id IS NULL and tries _findLeadByPhone() again. Useful when a
 * recording was uploaded BEFORE the matching lead existed, or when the
 * phone-match logic was previously broken.
 */
async function api_recordings_relinkOrphans(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  const orphans = await db.query(
    'SELECT id, phone FROM lead_recordings WHERE (lead_id IS NULL OR lead_id = 0) AND phone IS NOT NULL AND phone != \'\''
  );
  let linked = 0;
  for (const r of orphans.rows) {
    try {
      const lead = await _findLeadByPhone(r.phone);
      if (lead && lead.id) {
        await db.query('UPDATE lead_recordings SET lead_id = $1 WHERE id = $2', [lead.id, r.id]);
        linked++;
      }
    } catch (_) {}
  }
  return { ok: true, scanned: orphans.rows.length, linked };
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
      const cfgIn  = await db.getConfig('CALLS_AUTOLEAD_INBOUND',  '1');
      const cfgOut = await db.getConfig('CALLS_AUTOLEAD_OUTBOUND', '0');
      // We don't know the call direction at lookup time (this is fired on ring),
      // so 'will auto-create' = either inbound OR outbound is enabled.
      willAutoCreate = String(cfgIn) === '1' || String(cfgOut) === '1';
    } catch (_) {}
    return { match: false, phone, will_auto_create: willAutoCreate };
  }

  // Hydrate lead with status + assignee names + last few remarks
  const status = lead.status_id ? await db.findById('statuses', lead.status_id).catch(() => null) : null;
  const owner  = lead.assigned_to ? await db.findById('users', lead.assigned_to).catch(() => null) : null;
  // Last call timing — pulled from call_events (covers missed/no-recording too)
  let lastCallAt = null, lastCallDur = null, lastCallDirection = null;
  try {
    const { rows } = await db.query(
      `SELECT created_at, duration_s, direction FROM call_events
        WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [lead.id]
    );
    if (rows[0]) {
      lastCallAt = rows[0].created_at;
      lastCallDur = rows[0].duration_s;
      lastCallDirection = rows[0].direction;
    }
  } catch (_) {}
  // Last remark/note for the headline
  let lastRemark = null;
  try {
    const { rows } = await db.query(
      `SELECT remark, created_at FROM remarks WHERE lead_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [lead.id]
    );
    if (rows[0]) {
      lastRemark = { remark: rows[0].remark, created_at: rows[0].created_at };
    }
  } catch (_) {}
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
    last_call_at: lastCallAt,
    last_call_duration_s: lastCallDur,
    last_call_direction: lastCallDirection,
    last_remark: lastRemark,
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
  //   CALLS_AUTOLEAD_INBOUND   '1' / '0'  (default '1' — inbound creates leads)
  //   CALLS_AUTOLEAD_OUTBOUND  '1' / '0'  (default '0' — outbound stays manual)
  //   CALLS_AUTOLEAD_MIN_SECONDS  number  (default 5; 0 = create even for missed)
  //   CALLS_AUTOLEAD_STATUS_ID  numeric id (defaults to the 'New' status)
  // The mobile app sends direction = 'in' | 'out' | 'missed'. We treat
  // 'missed' as inbound for the YES/NO setting so YES catches missed too.
  const cfgIn   = await db.getConfig('CALLS_AUTOLEAD_INBOUND', '1');
  const cfgOut  = await db.getConfig('CALLS_AUTOLEAD_OUTBOUND', '0');
  const cfgMin  = Number(await db.getConfig('CALLS_AUTOLEAD_MIN_SECONDS', '5')) || 0;
  const cfgStId = Number(await db.getConfig('CALLS_AUTOLEAD_STATUS_ID', '0')) || 0;

  const isInbound  = direction === 'in' || direction === 'missed';
  const isOutbound = direction === 'out' || direction === 'outgoing';
  const passesMinDur = duration >= cfgMin || direction === 'missed';
  const allow = !lead && passesMinDur && (
    (isInbound  && String(cfgIn)  === '1') ||
    (isOutbound && String(cfgOut) === '1')
  );

  if (allow) {
    try {
      let statusId = null;
      if (cfgStId) {
        try {
          const found = await db.findById('statuses', cfgStId);
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


/**
 * BULK_AUDIT_v1 — trigger AI audit on many recordings at once.
 *
 * Args:
 *   { scope: 'unprocessed' | 'failed' | 'all',  (default 'unprocessed')
 *     limit:     int,  (default 500, max 2000)
 *     user_id:   int,  (optional — restrict to one rep)
 *     from_date: ISO,  (optional)
 *     to_date:   ISO   (optional) }
 *
 * Returns { ok, queued, ids, scope }.
 */
async function api_recording_bulkAudit(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) {
    throw new Error('Admin/manager only');
  }
  const p = payload || {};
  const scope = String(p.scope || 'unprocessed').toLowerCase();
  const limit = Math.min(2000, Math.max(1, Number(p.limit) || 500));

  const where = [];
  const params = [];
  if (scope === 'unprocessed')      where.push('ai_processed_at IS NULL');
  else if (scope === 'failed')      where.push('ai_processed_at IS NULL AND ai_error IS NOT NULL');
  else if (scope === 'all')         where.push('1=1');
  else throw new Error('Invalid scope. Use unprocessed | failed | all');

  where.push('audio_bytes IS NOT NULL');
  where.push('COALESCE(size_bytes, 0) >= 4096');

  if (p.user_id) {
    params.push(Number(p.user_id));
    where.push('user_id = $' + params.length);
  }
  if (p.from_date) {
    params.push(p.from_date);
    where.push('created_at >= $' + params.length);
  }
  if (p.to_date) {
    params.push(p.to_date);
    where.push('created_at <= $' + params.length);
  }
  params.push(limit);
  const limitIdx = params.length;

  const sql = 'SELECT id FROM lead_recordings WHERE ' + where.join(' AND ')
            + ' ORDER BY id DESC LIMIT $' + limitIdx;
  const r = await db.query(sql, params);
  const ids = r.rows.map(x => x.id);

  if (ids.length === 0) {
    return { ok: true, queued: 0, ids: [], scope, message: 'Nothing to audit for that scope.' };
  }

  if (scope !== 'unprocessed') {
    await db.query(
      'UPDATE lead_recordings SET '
      + 'ai_processed_at = NULL, ai_error = NULL, summary = NULL, '
      + 'transcript = NULL, action_items = NULL, sentiment = NULL, '
      + 'suggested_status_id = NULL, key_insight = NULL, next_followup_days = NULL '
      + 'WHERE id = ANY($1::int[])',
      [ids]
    );
  }

  try {
    const { processRecording } = require('../utils/aiCallSummary');
    ids.forEach((id, i) => {
      setTimeout(() => {
        processRecording(id).catch(e => console.warn('[bulkAudit] id=' + id + ' failed:', e.message));
      }, i * 250);
    });
  } catch (e) {
    console.warn('[bulkAudit] aiCallSummary not available:', e.message);
  }

  return { ok: true, queued: ids.length, ids, scope };
}

async function api_recording_recentInsights(token, opts) {
  const me = await authUser(token);
  // PROMISE_SCHEMA_HEAL_v1 — ensure new cols exist before SELECT references them.
  try {
    await db.query(`ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS committed_callback_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS actual_followup_at  TIMESTAMPTZ`);
    await db.query(`ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS callback_gap_minutes INTEGER`);
  } catch (e) { console.warn('[recentInsights] heal:', e.message); }
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
           lr.committed_callback_at, lr.actual_followup_at, lr.callback_gap_minutes,
           -- PROMISE_TRACK_v1 — most recent activity timestamp on the lead, across remarks/call_events/wa
           (SELECT MAX(t) FROM (
              SELECT created_at AS t FROM remarks          WHERE lead_id = lr.lead_id
              UNION ALL SELECT created_at FROM call_events WHERE lead_id = lr.lead_id
              UNION ALL SELECT created_at FROM whatsapp_messages WHERE lead_id = lr.lead_id
           ) z) AS last_activity_at,
           l.name AS lead_name, l.status_id AS lead_status_id,
           /* NEXT_ACTIVITY_v1 */ l.next_followup_at AS lead_next_followup_at,
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
        rating: r.rating, ai_suggested_rating: r.ai_suggested_rating,
        committed_callback_at: r.committed_callback_at,
        actual_followup_at:    r.actual_followup_at,
        callback_gap_minutes:  r.callback_gap_minutes,
        last_activity_at:      r.last_activity_at,
        /* NEXT_ACTIVITY_v1 */ lead_next_followup_at: r.lead_next_followup_at
      };
    });
  } catch (e) {
    if (/column .* does not exist/i.test(e.message)) {
      return { error: 'AI columns not migrated yet — restart the service.', rows: [] };
    }
    throw e;
  }
}


/* REC_SELFTEST_v1 — server-side end-to-end self-test
 *
 * Inserts a synthetic recording row (with a tiny 8-byte buffer + an
 * obvious dedup_key like 'selftest:<userId>:<timestamp>'), confirms
 * the lead-match path ran, then deletes the row. Returns a structured
 * pass/fail report for each phase.
 */
async function api_recording_selftest(token) {
  const me = await authUser(token);
  const report = { phases: [], me_id: me.id };
  const _ok = (k, msg) => report.phases.push({ phase: k, status: 'ok', msg });
  const _fail = (k, msg) => report.phases.push({ phase: k, status: 'fail', msg });
  const _info = (k, msg) => report.phases.push({ phase: k, status: 'info', msg });

  _ok('auth', 'Token resolved to user #' + me.id + ' (' + (me.email || me.name) + ')');

  // Phase: insert a synthetic row to confirm DB write + dedup path.
  const dedupKey = 'selftest:' + me.id + ':' + Date.now();
  let insertedId = null;
  try {
    // Self-heal dedup column if missing.
    try { await db.query('ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS dedup_key TEXT'); } catch (_) {}

    const ins = await db.query(
      `INSERT INTO lead_recordings
         (user_id, phone, direction, duration_s, mime_type, size_bytes, audio_bytes, started_at, created_at, dedup_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [me.id, '9999999999', 'out', 1, 'audio/mpeg', 8, Buffer.from('SELFTEST'), new Date().toISOString(), new Date().toISOString(), dedupKey]
    );
    insertedId = ins.rows[0] && ins.rows[0].id;
    if (insertedId) _ok('db_insert', 'Synthetic recording row inserted (id=' + insertedId + ')');
    else _fail('db_insert', 'INSERT returned no id');
  } catch (e) {
    _fail('db_insert', 'INSERT failed: ' + e.message);
  }

  // Phase: confirm we can read it back.
  if (insertedId) {
    try {
      const r = await db.query('SELECT id, user_id, dedup_key, size_bytes FROM lead_recordings WHERE id = $1', [insertedId]);
      if (r.rows[0]) _ok('db_read', 'Row read-back OK: ' + JSON.stringify(r.rows[0]));
      else _fail('db_read', 'Inserted id ' + insertedId + ' not found on read-back');
    } catch (e) { _fail('db_read', e.message); }
  }

  // Phase: lead-match attempt — call _findLeadByPhone with a real phone.
  try {
    const recRoutes = require('./recordings');
    if (typeof recRoutes._findLeadByPhone === 'function') {
      const lead = await recRoutes._findLeadByPhone('9999999999');
      if (lead) _info('lead_match', 'Test phone 9999999999 matched lead #' + lead.id + ' (' + (lead.name || '—') + ')');
      else _info('lead_match', 'Test phone 9999999999 did NOT match any lead — auto-create-lead would fire if config allows');
    } else { _info('lead_match', '_findLeadByPhone not exported — skipping'); }
  } catch (e) { _fail('lead_match', e.message); }

  // Phase: check auto-create-lead policy config.
  try {
    const cfgIn  = await db.getConfig('CALLS_AUTOLEAD_INBOUND', '1');
    const cfgOut = await db.getConfig('CALLS_AUTOLEAD_OUTBOUND', '0');
    _info('autolead_config', 'CALLS_AUTOLEAD_INBOUND=' + cfgIn + ' · CALLS_AUTOLEAD_OUTBOUND=' + cfgOut + ' — unmatched recordings auto-create a lead when the matching flag is "1"');
  } catch (e) { _info('autolead_config', 'config read failed: ' + e.message); }

  // Phase: dedup index sanity check.
  try {
    const idx = await db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_lead_rec_user_dedup'`
    );
    if (idx.rows[0]) {
      const def = idx.rows[0].indexdef;
      const partial = def.includes('WHERE');
      if (partial) _fail('dedup_index', 'Partial unique index detected — ON CONFLICT will not match: ' + def);
      else _ok('dedup_index', 'Non-partial unique index OK: ' + def);
    } else _info('dedup_index', 'Index uniq_lead_rec_user_dedup not present yet (will self-heal on first /api/recordings hit)');
  } catch (e) { _fail('dedup_index', e.message); }

  // Cleanup: remove the synthetic row.
  if (insertedId) {
    try {
      await db.query('DELETE FROM lead_recordings WHERE id = $1', [insertedId]);
      _ok('cleanup', 'Synthetic row deleted');
    } catch (e) { _fail('cleanup', 'Cleanup failed: ' + e.message); }
  }

  report.summary = {
    ok:   report.phases.filter(p => p.status === 'ok').length,
    fail: report.phases.filter(p => p.status === 'fail').length,
    info: report.phases.filter(p => p.status === 'info').length
  };
  return report;
}



/* REC_FILENAME_DEDUP_v1 (2026-05-20)
 * Pre-flight check used by the recording-sync client. Given an array of
 * filenames the device wants to upload, returns the subset that are
 * ALREADY in lead_recordings for this tenant. The client then skips
 * those locally, avoiding redundant network round-trips for files that
 * are guaranteed to bounce as "already_synced".
 *
 * Replaces fragile local-watermark logic: even if localStorage is
 * cleared, the device is reinstalled, or a second device syncs to the
 * same tenant, this API correctly identifies what's already on the CRM.
 *
 * payload: { filenames: ['call_20260520_143215.m4a', ...] } (max 500)
 * returns: { present: ['call_20260520_143215.m4a', ...], asked: <n> }
 */
async function api_recordings_filenamesPresent(token, payload) {
  await authUser(token);
  const names = Array.isArray(payload && payload.filenames) ? payload.filenames : [];
  const list = names.map(s => String(s || '').trim()).filter(Boolean).slice(0, 500);
  if (!list.length) return { present: [], asked: 0 };
  // Self-heal column on first hit (idempotent).
  try { await db.query('ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS original_filename TEXT'); } catch (_) {}
  try {
    const { rows } = await db.query(
      'SELECT DISTINCT original_filename FROM lead_recordings WHERE original_filename = ANY($1::text[])',
      [list]
    );
    return { present: rows.map(r => r.original_filename), asked: list.length };
  } catch (e) {
    return { present: [], asked: list.length, error: e.message };
  }
}

module.exports = {
  api_call_logEvent, api_call_events_pending, api_call_events_convertToLeads,
  api_call_hasRecentEvent,
  api_call_lookup,
  api_call_handleEnded,
  api_leads_recordings,
  api_call_history,
  api_my_recordings,
  api_recordings_delete, api_recordings_resetAll, api_recordings_relinkOrphans,
  api_recordings_filenamesPresent, /* REC_FILENAME_DEDUP_v1 */
  api_recording_aiSummary,
  api_recording_aiReprocess,
  api_recording_applySuggestion,
  api_recording_rate,
  _findLeadByPhone,
  api_recording_recentInsights,
  api_recording_bulkAudit
};
