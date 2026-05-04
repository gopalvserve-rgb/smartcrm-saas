/**
 * routes/recordings.js — Call recordings + call event logging
 *
 * Recordings are stored as BYTEA in Postgres for simplicity (Railway disk
 * isn't persistent across deploys). For files >2MB this is fine; for heavier
 * use move to S3/R2.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

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
async function api_call_logEvent(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  const lead = await _findLeadByPhone(p.phone);
  await db.insert('call_events', {
    lead_id: lead ? lead.id : null,
    user_id: me.id,
    phone: p.phone || '',
    direction: p.direction || (p.event === 'incoming_ringing' ? 'in' : 'out'),
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
    // Bonus context for the rep: was there a previous call/lead from this
    // number that's been deleted, or a stale unassigned lead?
    return { match: false, phone };
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

  // Auto-create lead: answered inbound, ≥5s, no existing match
  if (direction === 'in' && duration >= 5 && !lead) {
    try {
      const _newStatusId = await (async () => {
        const s = await db.findOneBy('statuses', 'name', 'New');
        return s ? s.id : null;
      })();
      const phoneClean = String(p.phone).replace(/^'/, '').trim();
      createdLeadId = await db.insert('leads', {
        name:        phoneClean,                  // placeholder, rep edits
        phone:       phoneClean,
        whatsapp:    phoneClean,
        source:      'Inbound Call',
        source_ref:  'auto-created from caller-id',
        status_id:   _newStatusId,
        assigned_to: me.id,
        notes:       'Auto-created from inbound call · ' +
                     Math.round(duration) + 's · ' +
                     new Date(p.started_at || Date.now()).toLocaleString('en-IN'),
        created_by:  me.id,
        created_at:  db.nowIso(),
        updated_at:  db.nowIso(),
        last_status_change_at: db.nowIso()
      });
      // First remark for context
      await db.insert('remarks', {
        lead_id: createdLeadId, user_id: me.id,
        remark: '📞 Inbound call · ' + Math.round(duration) + 's · auto-created lead',
        status_id: _newStatusId
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
  api_recording_recentInsights
};
