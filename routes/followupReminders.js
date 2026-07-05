/**
 * routes/followupReminders.js  —  REMINDER_FLOWS_v1 (2026-07-05)
 *
 * Runtime / rep-side APIs:
 *   api_leads_setFollowup             — atomic set-followup + attach flow + schedule rungs
 *   api_followupReminders_forLead     — full history for one lead (log view)
 *   api_followupReminders_upcoming    — next N minutes of fires (manager dashboard)
 *   api_followupReminders_cancel      — cancel a scheduled reminder
 *   api_followupReminders_reschedule  — move a fire_at
 *   api_followupReminders_summary     — 24h health (sent / failed / scheduled)
 *
 * Log columns on `followup_reminders`:
 *   status, sent_at, error, attempts, wa_message_id, email_message_id
 *   → the row IS the audit trail. `_forLead` returns them ordered so the
 *      SPA can render a per-lead reminder timeline.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS followup_reminders (
    id                  SERIAL PRIMARY KEY,
    lead_id             INTEGER NOT NULL,
    followup_at         TIMESTAMPTZ NOT NULL,
    fire_at             TIMESTAMPTZ NOT NULL,
    flow_id             INTEGER,
    rung_offset_minutes INTEGER,
    channel             VARCHAR(20) NOT NULL,
    recipient_type      VARCHAR(20) NOT NULL,
    recipient_phone     VARCHAR(30),
    recipient_email     VARCHAR(200),
    wa_template_name    VARCHAR(120),
    wa_language         VARCHAR(20) DEFAULT 'en',
    email_subject       TEXT,
    email_body_html     TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    sent_at             TIMESTAMPTZ,
    error               TEXT,
    wa_message_id       VARCHAR(80),
    email_message_id    VARCHAR(200),
    attempts            SMALLINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS followup_reminders_fire_idx
                  ON followup_reminders(fire_at, status)`).catch(()=>{});
  await db.query(`CREATE INDEX IF NOT EXISTS followup_reminders_lead_idx
                  ON followup_reminders(lead_id)`).catch(()=>{});
  _schemaReady = true;
}

/* ── Helper: explode a flow into concrete followup_reminders rows ── */
async function _scheduleFromFlow(leadId, followupAt, flowId, meId) {
  // Read the flow + rungs + lead + owner (for recipient snapshot)
  const flow = (await db.query(`SELECT * FROM reminder_flows WHERE id=$1`, [flowId])).rows[0];
  if (!flow) return { scheduled: 0, skipped_past: 0, error: 'Flow not found' };
  const rungs = (await db.query(
    `SELECT offset_minutes FROM reminder_flow_rungs WHERE flow_id=$1 ORDER BY offset_minutes ASC`,
    [flowId]
  )).rows;
  const lead = await db.findById('leads', leadId);
  if (!lead) return { scheduled: 0, skipped_past: 0, error: 'Lead not found' };
  const owner = lead.assigned_to ? await db.findById('users', lead.assigned_to) : null;

  const targetMs = new Date(followupAt).getTime();
  const nowMs    = Date.now();
  let scheduled = 0, skippedPast = 0;

  for (const rung of rungs) {
    const fireMs = targetMs + Number(rung.offset_minutes) * 60000;
    if (fireMs <= nowMs) { skippedPast++; continue; }
    const fireAt = new Date(fireMs).toISOString();

    // For each recipient × channel combination, insert one row
    const recipients = [];
    if (flow.send_to_lead)  recipients.push({ type: 'lead',  phone: lead.phone,  email: lead.email });
    if (flow.send_to_owner && owner) recipients.push({ type: 'owner', phone: owner.phone, email: owner.email });
    const channels = [];
    if (flow.channel_wa)    channels.push('wa');
    if (flow.channel_email) channels.push('email');

    for (const r of recipients) {
      for (const ch of channels) {
        if (ch === 'wa'    && !r.phone) continue;
        if (ch === 'email' && !r.email) continue;
        await db.query(
          `INSERT INTO followup_reminders (
            lead_id, followup_at, fire_at, flow_id, rung_offset_minutes,
            channel, recipient_type, recipient_phone, recipient_email,
            wa_template_name, wa_language, email_subject, email_body_html
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [leadId, new Date(followupAt).toISOString(), fireAt, flowId, Number(rung.offset_minutes),
           ch, r.type, r.phone || null, r.email || null,
           flow.wa_template_name || null, flow.wa_language || 'en',
           flow.email_subject || null, flow.email_body_html || null]
        );
        scheduled++;
      }
    }
  }
  // Persist which flow is now attached (audit + re-schedule on edit)
  await db.query(`UPDATE leads SET reminder_flow_id=$1 WHERE id=$2`, [flowId, leadId]).catch(()=>{});

  return { scheduled, skipped_past: skippedPast };
}

/* ── 1. api_leads_setFollowup — atomic set followup + schedule reminders ── */
async function api_leads_setFollowup(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  const leadId = Number(p.lead_id);
  if (!leadId) throw new Error('lead_id required');
  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');

  // 1. Cancel any pending reminders for this lead — we're re-scheduling.
  await db.query(
    `UPDATE followup_reminders
        SET status = 'cancelled', error = 'Reminder cancelled — follow-up changed'
      WHERE lead_id = $1 AND status = 'scheduled'`,
    [leadId]
  );

  // 2. Persist the follow-up
  const patch = {};
  if (p.followup_at) patch.next_followup_at = new Date(p.followup_at).toISOString();
  else               patch.next_followup_at = null;
  patch.reminder_flow_id = p.reminder_flow_id ? Number(p.reminder_flow_id) : null;
  await db.query(
    `UPDATE leads SET next_followup_at=$1, reminder_flow_id=$2 WHERE id=$3`,
    [patch.next_followup_at, patch.reminder_flow_id, leadId]
  );

  // 3. Schedule reminders if a flow was picked and follow-up isn't null
  let out = { scheduled: 0, skipped_past: 0 };
  if (patch.next_followup_at && patch.reminder_flow_id) {
    out = await _scheduleFromFlow(leadId, patch.next_followup_at, patch.reminder_flow_id, me.id);
  }

  // 4. Add a remark for the audit trail (existing pattern)
  try {
    if (patch.next_followup_at) {
      const flowRow = patch.reminder_flow_id
        ? (await db.query(`SELECT name FROM reminder_flows WHERE id=$1`, [patch.reminder_flow_id])).rows[0]
        : null;
      const flowName = flowRow ? flowRow.name : null;
      const remark = flowName
        ? `🔔 Follow-up set for ${new Date(patch.next_followup_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} — reminder flow "${flowName}" attached (${out.scheduled} reminders queued${out.skipped_past ? `, ${out.skipped_past} in past` : ''})`
        : `Follow-up set for ${new Date(patch.next_followup_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
      await db.query(
        `INSERT INTO remarks (lead_id, user_id, remark, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [leadId, me.id, remark]
      ).catch(()=>{});
    }
  } catch (_) {}

  return { ok: true, ...out };
}

/* ── 2. Log view — every reminder ever queued/sent for a lead ── */
async function api_followupReminders_forLead(token, leadId) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(
    `SELECT r.*, f.name AS flow_name
       FROM followup_reminders r
       LEFT JOIN reminder_flows f ON f.id = r.flow_id
      WHERE r.lead_id = $1
      ORDER BY r.fire_at DESC, r.id DESC
      LIMIT 200`,
    [Number(leadId)]
  );
  return { items: r.rows };
}

/* ── 3. Upcoming (dashboard) ── */
async function api_followupReminders_upcoming(token, opts) {
  await authUser(token);
  await _ensureSchema();
  const o = opts || {};
  const windowMin = Math.min(Math.max(Number(o.window_minutes || 60), 5), 1440);
  const r = await db.query(
    `SELECT r.*, f.name AS flow_name, l.name AS lead_name, l.phone AS lead_phone
       FROM followup_reminders r
       LEFT JOIN reminder_flows f ON f.id = r.flow_id
       LEFT JOIN leads l ON l.id = r.lead_id
      WHERE r.status = 'scheduled'
        AND r.fire_at BETWEEN NOW() AND NOW() + ($1 || ' minutes')::interval
      ORDER BY r.fire_at ASC
      LIMIT 200`,
    [String(windowMin)]
  );
  return { items: r.rows, window_minutes: windowMin };
}

/* ── 4. Cancel one reminder ── */
async function api_followupReminders_cancel(token, id) {
  const me = await authUser(token);
  await _ensureSchema();
  await db.query(
    `UPDATE followup_reminders
        SET status='cancelled',
            error = COALESCE(error, '') || ' · Cancelled by user ' || $2
      WHERE id=$1 AND status='scheduled'`,
    [Number(id), me.id]
  );
  return { ok: true };
}

/* ── 5. Reschedule one reminder ── */
async function api_followupReminders_reschedule(token, payload) {
  await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  if (!p.id || !p.fire_at) throw new Error('id and fire_at required');
  await db.query(
    `UPDATE followup_reminders SET fire_at=$1 WHERE id=$2 AND status='scheduled'`,
    [new Date(p.fire_at).toISOString(), Number(p.id)]
  );
  return { ok: true };
}

/* ── 6. 24h summary for the manager dashboard ── */
async function api_followupReminders_summary(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='scheduled' AND fire_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours')::int AS scheduled_24h,
      COUNT(*) FILTER (WHERE status='sent'      AND sent_at >= NOW() - INTERVAL '24 hours')::int                  AS sent_24h,
      COUNT(*) FILTER (WHERE status='failed'    AND created_at >= NOW() - INTERVAL '24 hours')::int               AS failed_24h,
      COUNT(*) FILTER (WHERE status='cancelled' AND created_at >= NOW() - INTERVAL '24 hours')::int               AS cancelled_24h,
      COUNT(*) FILTER (WHERE status='sent'      AND channel='wa'    AND sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_wa_24h,
      COUNT(*) FILTER (WHERE status='sent'      AND channel='email' AND sent_at >= NOW() - INTERVAL '24 hours')::int AS sent_email_24h
    FROM followup_reminders`);
  const errs = await db.query(`
    SELECT COALESCE(SUBSTRING(error FROM 1 FOR 60), 'unknown') AS msg, COUNT(*)::int AS n
      FROM followup_reminders
     WHERE status='failed' AND created_at >= NOW() - INTERVAL '24 hours'
     GROUP BY msg ORDER BY n DESC LIMIT 10`);
  return { summary: r.rows[0] || {}, top_errors: errs.rows };
}

/* Exported so leads.js can auto-cancel when a lead is Won/Lost/Junk */
async function _cancelForLead(leadId, reason) {
  try {
    await _ensureSchema();
    await db.query(
      `UPDATE followup_reminders
          SET status='cancelled',
              error = COALESCE(error,'') || ' · auto-cancelled: ' || $2
        WHERE lead_id=$1 AND status='scheduled'`,
      [Number(leadId), String(reason || 'lead state changed').slice(0, 100)]
    );
  } catch (_) {}
}

module.exports = {
  api_leads_setFollowup,
  api_followupReminders_forLead,
  api_followupReminders_upcoming,
  api_followupReminders_cancel,
  api_followupReminders_reschedule,
  api_followupReminders_summary,
  _cancelForLead,
  _ensureSchema,
  _scheduleFromFlow
};
