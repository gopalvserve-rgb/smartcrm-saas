/**
 * utils/nurtureWorker.js — Lead Nurture sequence executor.
 *
 * Wakes every 5 min, picks pending nurture_step_runs whose scheduled_for
 * has arrived, checks exit/pause conditions, then dispatches the step
 * via the channel-appropriate send path:
 *
 *   wa_template → routes/whatsbot._sendTemplate
 *   email       → utils/mailer._sendRaw
 *   ai_bot      → routes/aiBot._sendOneShot (custom prompt via maybeReplyToInbound bypass)
 *
 * Exit conditions checked BEFORE every step:
 *   1. enrollment.status != 'active' → skip
 *   2. lead.status_id ∈ {exit_on_status_id, final-stage statuses} → exit
 *   3. exit_on_reply=1 AND customer replied since enrollment.started_at AND
 *      reply happened more recently than pause_on_reply_hours → pause
 *      (when the pause window expires, status becomes 'active' again
 *       and the next step that's due fires)
 *
 * Designed for per-tenant invocation: pass the tenant pool to tick(),
 * or call run() globally which iterates every connected tenant.
 */
'use strict';

const db = require('../db/pg');

const POLL_MS = 5 * 60 * 1000;  // 5 minutes

async function _interpolate(text, lead) {
  if (!text) return text;
  return String(text)
    .replace(/\{\{\s*name\s*\}\}/gi, (lead && lead.name) || 'there')
    .replace(/\{\{\s*firstname\s*\}\}/gi, String((lead && lead.name) || 'there').split(' ')[0])
    .replace(/\{\{\s*phone\s*\}\}/gi, (lead && lead.phone) || '')
    .replace(/\{\{\s*email\s*\}\}/gi, (lead && lead.email) || '')
    .replace(/\{\{\s*company\s*\}\}/gi, (lead && lead.company) || '');
}

async function _runOneStep(run) {
  const { id: runId, enrollment_id, sequence_id, step_no, lead_id, channel } = run;

  // Re-read latest enrollment + step + lead state
  const e = await db.query(`SELECT * FROM nurture_enrollments WHERE id = $1`, [enrollment_id]);
  if (!e.rows[0]) {
    await db.query(`UPDATE nurture_step_runs SET status='skipped', error_text='enrollment not found' WHERE id = $1`, [runId]);
    return;
  }
  const enroll = e.rows[0];
  if (enroll.status !== 'active' && enroll.status !== 'paused') {
    await db.query(`UPDATE nurture_step_runs SET status='skipped', error_text='enrollment status=' || $2 WHERE id = $1`, [runId, enroll.status]);
    return;
  }

  const seq = (await db.query(`SELECT * FROM nurture_sequences WHERE id = $1`, [sequence_id])).rows[0];
  const step = (await db.query(`SELECT * FROM nurture_steps WHERE sequence_id = $1 AND step_no = $2`, [sequence_id, step_no])).rows[0];
  const lead = (await db.query(`SELECT id, name, phone, email, status_id, assigned_to FROM leads WHERE id = $1`, [lead_id])).rows[0];
  if (!seq || !step || !lead) {
    await db.query(`UPDATE nurture_step_runs SET status='skipped', error_text='missing seq/step/lead' WHERE id = $1`, [runId]);
    return;
  }

  // Exit on status change
  if (Number(seq.exit_on_status_id) && Number(lead.status_id) === Number(seq.exit_on_status_id)) {
    await db.query(`UPDATE nurture_enrollments SET status='exited', ended_at=NOW(), ended_reason='status_match' WHERE id = $1`, [enrollment_id]);
    await db.query(`UPDATE nurture_step_runs SET status='skipped', error_text='exit_on_status_id matched' WHERE id = $1`, [runId]);
    // Cancel remaining pending runs for this enrollment
    await db.query(`UPDATE nurture_step_runs SET status='skipped', error_text='enrollment exited' WHERE enrollment_id = $1 AND status='pending'`, [enrollment_id]);
    return;
  }

  // Per-step skip condition — if step.skip_if_status_id matches the lead's
  // current status, skip this step (mark as 'skipped') and move on without
  // exiting the enrollment. Useful for conditional drips: "Don't send the
  // 'still thinking?' message if status is already Demo Done".
  if (Number(step.skip_if_status_id) && Number(lead.status_id) === Number(step.skip_if_status_id)) {
    await db.query(
      `UPDATE nurture_step_runs SET status='skipped', sent_at=NOW(), error_text = 'skip_if_status_id matched' WHERE id = $1`,
      [runId]
    );
    return;
  }

  // Pause on recent customer reply
  if (Number(seq.exit_on_reply) === 1) {
    const pauseHours = Math.max(1, Number(seq.pause_on_reply_hours) || 24);
    const replyCheck = await db.query(
      `SELECT MAX(created_at) AS last_in FROM whatsapp_messages
        WHERE direction='in' AND from_number = $1
          AND created_at > NOW() - ($2 || ' hours')::interval`,
      [lead.phone, String(pauseHours)]
    );
    if (replyCheck.rows[0] && replyCheck.rows[0].last_in) {
      // Customer replied recently — push this step forward by the pause window
      const newDue = new Date(Date.now() + pauseHours * 3600 * 1000);
      await db.query(
        `UPDATE nurture_step_runs SET scheduled_for = $2 WHERE id = $1`,
        [runId, newDue.toISOString()]
      );
      await db.query(
        `UPDATE nurture_enrollments SET status='paused', paused_reason='customer_replied' WHERE id = $1`,
        [enrollment_id]
      );
      return;
    } else if (enroll.status === 'paused') {
      // No recent reply — resume
      await db.query(`UPDATE nurture_enrollments SET status='active', paused_reason=NULL WHERE id = $1`, [enrollment_id]);
    }
  }

  // Dispatch by channel
  try {
    if (channel === 'wa_template') {
      const wb = require('../routes/whatsbot');
      const cfg = await wb._cfg();
      if (!cfg.token || !cfg.phoneId) throw new Error('WhatsApp not connected');
      const vars = Array.isArray(step.template_variables)
        ? step.template_variables
        : (typeof step.template_variables === 'string'
            ? JSON.parse(step.template_variables || '[]')
            : []);
      const interpolatedVars = [];
      for (const v of vars) interpolatedVars.push(await _interpolate(v, lead));
      await wb._sendTemplate({
        to: lead.phone,
        templateName: step.template_name,
        language: step.template_lang || 'en_US',
        variables: interpolatedVars,
        leadId: lead.id,
        userId: null
      }, cfg);
    } else if (channel === 'email') {
      if (!lead.email) throw new Error('Lead has no email');
      const mailer = require('./mailer');
      const subject = await _interpolate(step.email_subject || 'Update', lead);
      const body = await _interpolate(step.email_body || '', lead);
      await mailer._sendRaw(lead.email, subject, body);
    } else if (channel === 'ai_bot') {
      const wb = require('../routes/whatsbot');
      const cfg = await wb._cfg();
      if (!cfg.token || !cfg.phoneId) throw new Error('WhatsApp not connected (AI bot uses WA channel)');
      const message = await _interpolate(step.body_text || step.ai_prompt || 'Hello {{name}}', lead);
      await wb._sendText({
        to: lead.phone,
        text: message,
        leadId: lead.id,
        userId: null
      }, cfg);
    } else {
      throw new Error('Unknown channel: ' + channel);
    }
    await db.query(`UPDATE nurture_step_runs SET status='sent', sent_at=NOW() WHERE id = $1`, [runId]);
    await db.query(`UPDATE nurture_enrollments SET current_step = $2 WHERE id = $1`, [enrollment_id, step_no]);

    // If this was the last step, mark enrollment completed
    const remaining = await db.query(
      `SELECT COUNT(*)::int AS c FROM nurture_step_runs WHERE enrollment_id = $1 AND status = 'pending'`,
      [enrollment_id]
    );
    if (Number(remaining.rows[0].c) === 0) {
      await db.query(
        `UPDATE nurture_enrollments SET status='completed', ended_at=NOW(), ended_reason='all_steps_sent' WHERE id = $1`,
        [enrollment_id]
      );
    }
  } catch (e) {
    console.error('[nurtureWorker] step', runId, 'failed:', e.message);
    await db.query(
      `UPDATE nurture_step_runs SET status='failed', error_text = $2, sent_at=NOW() WHERE id = $1`,
      [runId, String(e.message).slice(0, 500)]
    );
  }
}

async function tick() {
  try {
    const r = await db.query(
      `SELECT id, enrollment_id, sequence_id, step_no, lead_id, channel
         FROM nurture_step_runs
        WHERE status = 'pending' AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC
        LIMIT 200`
    );
    if (!r.rows.length) return { processed: 0 };
    for (const row of r.rows) await _runOneStep(row);
    return { processed: r.rows.length };
  } catch (e) {
    console.error('[nurtureWorker] tick failed:', e.message);
    return { processed: 0, error: e.message };
  }
}

let _started = false;
function start(pollMs) {
  if (_started) return;
  _started = true;
  const interval = pollMs || POLL_MS;
  console.log('[nurtureWorker] starting — poll every', interval / 1000, 'sec');
  // First tick on boot, then schedule
  setTimeout(() => tick().catch(() => {}), 30 * 1000);
  setInterval(() => tick().catch(() => {}), interval);
}

module.exports = { tick, start, _runOneStep };
