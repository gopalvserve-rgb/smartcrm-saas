/**
 * utils/reminderSweep.js  —  REMINDER_FLOWS_v1 (2026-07-05)
 *
 * Per-tenant sweep worker. Every 60s, picks up followup_reminders where
 * status = 'scheduled' AND fire_at <= NOW(), sends via WhatsApp or Email,
 * and updates status → 'sent' | 'failed' | 'skipped'.
 *
 * Logging: every mutation writes back to the followup_reminders row.
 * The row IS the audit trail — sent_at, error, wa_message_id,
 * email_message_id, attempts all captured.
 *
 * Runs inside tenantStorage.run() (see server.js), so db.query() targets
 * the correct tenant DB automatically.
 */
'use strict';

const db = require('../db/pg');

const MAX_ATTEMPTS = 3;
const BATCH        = 50;
const STALE_HOURS  = 24;   // reminders older than this get skipped, not sent

/** Merge tokens into a WhatsApp template body — simple {{1}} {{2}} substitution */
function _fillTemplate(tokens, str) {
  if (!str) return '';
  return String(str)
    .replace(/\{\{\s*name\s*\}\}/gi,           tokens.name || '')
    .replace(/\{\{\s*owner_name\s*\}\}/gi,     tokens.owner_name || '')
    .replace(/\{\{\s*followup_date\s*\}\}/gi,  tokens.followup_date || '')
    .replace(/\{\{\s*followup_time\s*\}\}/gi,  tokens.followup_time || '')
    .replace(/\{\{\s*minutes_before\s*\}\}/gi, tokens.minutes_before != null ? String(tokens.minutes_before) : '')
    .replace(/\{\{\s*company\s*\}\}/gi,        tokens.company || '')
    .replace(/\{\{\s*1\s*\}\}/g,               tokens.name || '')
    .replace(/\{\{\s*2\s*\}\}/g,               tokens.owner_name || '')
    .replace(/\{\{\s*3\s*\}\}/g,               tokens.followup_time || '');
}

async function _buildTokens(row) {
  const lead = row.lead_id ? await db.findById('leads', row.lead_id) : null;
  const followup = new Date(row.followup_at);
  const owner = lead && lead.assigned_to ? await db.findById('users', lead.assigned_to) : null;
  let company = '';
  try { company = (await db.getConfig('COMPANY_NAME', '')) || (await db.getConfig('BRAND_COMPANY_NAME', '')) || ''; } catch (_) {}
  return {
    name:            (lead && lead.name) || '',
    owner_name:      (owner && owner.name) || 'the team',
    followup_date:   followup.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    followup_time:   followup.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
    minutes_before:  Math.abs(Number(row.rung_offset_minutes || 0)),
    company:         company || 'SmartCRM'
  };
}

async function _sendWA(row, tokens) {
  const wb = require('../routes/whatsbot');
  const phone = String(row.recipient_phone || '').replace(/\D/g, '');
  if (!phone) throw new Error('no recipient phone');

  // Prefer approved template send. Fall back to freeform if template
  // isn't picked (e.g. custom flow that skipped a template).
  if (row.wa_template_name && typeof wb._sendTemplate === 'function') {
    const variables = [tokens.name, tokens.owner_name, tokens.followup_time];
    const r = await wb._sendTemplate({
      to: phone,
      templateName: row.wa_template_name,
      language: row.wa_language || 'en',
      variables,
      leadId: row.lead_id || null
    }, {});
    return { message_id: (r && (r.wa_message_id || r.id)) || null };
  }
  // Fallback — plain-text send if the WA session window is open
  if (typeof wb._sendFreeform === 'function' || typeof wb._sendText === 'function') {
    const sendFn = wb._sendFreeform || wb._sendText;
    const text =
      `Hi ${tokens.name || 'there'},\n` +
      `Just a reminder — your follow-up with ${tokens.owner_name} is at ${tokens.followup_time} on ${tokens.followup_date}.` +
      (tokens.minutes_before ? `\n(${tokens.minutes_before} min from now.)` : '');
    const r = await sendFn(phone, text, { leadId: row.lead_id });
    return { message_id: (r && (r.wa_message_id || r.id)) || null };
  }
  throw new Error('No WhatsApp send function available');
}

async function _sendEmail(row, tokens) {
  let mailer;
  try { mailer = require('./mailer'); } catch (_) {}
  if (!mailer) throw new Error('Tenant mailer not available (utils/mailer.js missing)');

  const subject = _fillTemplate(tokens, row.email_subject || 'Reminder — your follow-up is coming up');
  const bodyHtml = _fillTemplate(tokens, row.email_body_html ||
    `<p>Hi {{name}},</p><p>Just a reminder that your follow-up with {{owner_name}} is scheduled for {{followup_time}} on {{followup_date}}.</p><p>Talk soon.</p>`);

  const sendFn = mailer.send || mailer.sendMail || mailer._sendRaw;
  if (!sendFn) throw new Error('Mailer has no send/sendMail function');

  const r = await sendFn.call(mailer, {
    to: row.recipient_email, subject, html: bodyHtml
  }).catch(async e => {
    // _sendRaw uses positional args (to, subject, html)
    if (mailer._sendRaw) return await mailer._sendRaw(row.recipient_email, subject, bodyHtml);
    throw e;
  });
  return { message_id: (r && (r.messageId || r.id)) || null };
}

/** Fire one row. Returns { ok } or { skipped } or { retry }. Updates the row. */
async function _fireOne(row) {
  // Bail conditions
  if (row.attempts >= MAX_ATTEMPTS) {
    await db.query(`UPDATE followup_reminders SET status='failed', error=COALESCE(error,'') || ' · max attempts' WHERE id=$1`, [row.id]);
    return { skipped: true };
  }
  const fireMs = new Date(row.fire_at).getTime();
  if (Date.now() - fireMs > STALE_HOURS * 3600_000) {
    await db.query(
      `UPDATE followup_reminders SET status='skipped', error=COALESCE(error,'') || ' · stale (server was down)' WHERE id=$1`,
      [row.id]
    );
    return { skipped: true };
  }
  // Guard: has the underlying follow-up changed?
  try {
    const lead = row.lead_id ? await db.findById('leads', row.lead_id) : null;
    if (!lead) {
      await db.query(`UPDATE followup_reminders SET status='skipped', error='Lead was deleted' WHERE id=$1`, [row.id]);
      return { skipped: true };
    }
    if (lead.next_followup_at && new Date(lead.next_followup_at).getTime() !== new Date(row.followup_at).getTime()) {
      await db.query(
        `UPDATE followup_reminders SET status='skipped', error='Follow-up time changed' WHERE id=$1`,
        [row.id]
      );
      return { skipped: true };
    }
  } catch (_) {}

  const tokens = await _buildTokens(row);
  try {
    let result;
    if (row.channel === 'wa')    result = await _sendWA(row, tokens);
    else if (row.channel === 'email') result = await _sendEmail(row, tokens);
    else throw new Error('Unknown channel: ' + row.channel);

    await db.query(
      `UPDATE followup_reminders
          SET status='sent', sent_at=NOW(),
              wa_message_id=$2, email_message_id=$3,
              attempts=attempts+1
        WHERE id=$1`,
      [row.id, result && result.message_id && row.channel === 'wa' ? result.message_id : null,
       result && result.message_id && row.channel === 'email' ? result.message_id : null]
    );
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 500);
    const finalAttempt = (row.attempts + 1) >= MAX_ATTEMPTS;
    await db.query(
      `UPDATE followup_reminders
          SET attempts=attempts+1,
              error=$2,
              status=CASE WHEN $3::boolean THEN 'failed' ELSE status END
        WHERE id=$1`,
      [row.id, msg, finalAttempt]
    );
    return { retry: !finalAttempt, err: msg };
  }
}

async function tick() {
  await require('../routes/followupReminders')._ensureSchema();
  const r = await db.query(
    `SELECT * FROM followup_reminders
      WHERE status='scheduled' AND fire_at <= NOW() AND attempts < $1
      ORDER BY fire_at ASC LIMIT $2`,
    [MAX_ATTEMPTS, BATCH]
  );
  const out = { picked: r.rows.length, sent: 0, failed: 0, retry: 0, skipped: 0 };
  for (const row of r.rows) {
    try {
      const res = await _fireOne(row);
      if (res.ok)      out.sent++;
      if (res.retry)   out.retry++;
      if (res.skipped) out.skipped++;
      if (res.err && !res.retry) out.failed++;
    } catch (e) {
      console.warn('[reminderSweep] row', row.id, 'fatal:', e.message);
      out.failed++;
    }
  }
  return out;
}

module.exports = { tick, _fireOne };
