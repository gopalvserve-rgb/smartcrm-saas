/**
 * utils/eduReminderWorker.js — Education-pack fee reminder ticker.
 *
 * Wakes hourly, picks installments due in 15/7/1/0 days (based on which
 * reminder flags are still unset), and sends a reminder WhatsApp + email
 * to the linked lead. Idempotent — flips `reminded_<bucket>=1` so the
 * same installment is never reminded twice for the same bucket.
 *
 * Runs only inside a tenant context (server.js wraps the call in
 * tenantStorage.run) AND only when the Education pack is active on
 * that tenant.
 */
'use strict';

const db = require('../db/pg');
const packs = require('../routes/packs/_framework');

async function _getLead(leadId) {
  try { return await db.findById('leads', leadId); } catch (_) { return null; }
}

async function _sendOnce(installment, lead, bucket) {
  // WhatsApp via Cloud API (use the bare WA send path if available, else
  // fall back to email). We don't require a pre-approved template — use
  // a text-mode send when the conversation is open, otherwise email.
  const due = Math.max(0,
    Number(installment.amount) + Number(installment.late_fee) - Number(installment.paid_amount)
  );
  const phone = String(lead && lead.phone || '').replace(/\D/g, '');
  const dueDate = String(installment.due_date).slice(0, 10);
  const msg =
    'Hi ' + (lead.name || 'there') + ',\n\n' +
    'Friendly reminder: installment #' + installment.seq +
    (bucket === 'due' ? ' is due today (' + dueDate + ').'
                      : ' is due on ' + dueDate + ' (in ' + bucket + ' day' + (bucket === '1' ? '' : 's') + ').') +
    '\nAmount: ₹' + due.toLocaleString('en-IN') +
    '\n\nIf already paid, please ignore. Thanks!';

  let sentSomething = false;
  if (phone) {
    try {
      const wb = require('../routes/whatsbot');
      if (wb && typeof wb._sendFreeform === 'function') {
        await wb._sendFreeform(phone, msg);
        sentSomething = true;
      } else if (wb && typeof wb._sendText === 'function') {
        await wb._sendText(phone, msg);
        sentSomething = true;
      }
    } catch (e) { /* WA may not be configured — fall through to email */ }
  }
  if (!sentSomething && lead && lead.email) {
    try {
      const mailer = require('./mailer');
      await mailer._sendRaw(lead.email, 'Fee reminder', '<pre>' + msg + '</pre>');
      sentSomething = true;
    } catch (_) {}
  }

  // ── ALSO send to parents/guardians who opted in (Phase 7.B) ──────
  // Reads edu_parent_contacts; for each row with receive_reminders=1
  // tries WhatsApp first then email. Best-effort: failures are logged
  // and do not affect the student-side send result.
  try {
    let parents = [];
    try {
      const r = await db.query(
        `SELECT id, name, phone, whatsapp, email, receive_reminders
           FROM edu_parent_contacts
          WHERE lead_id = $1 AND receive_reminders = 1`,
        [lead && lead.id]
      );
      parents = (r && r.rows) || [];
    } catch (_) { /* table may not exist on older tenants — skip silently */ }
    for (const p of parents) {
      const parentMsg =
        'Hi ' + (p.name || 'Parent') + ',\n\n' +
        'Reminder for ' + (lead.name || 'your ward') + ' — installment #' + installment.seq +
        (bucket === 'due' ? ' is due today (' + dueDate + ').'
                          : ' is due on ' + dueDate + ' (in ' + bucket + ' day' + (bucket === '1' ? '' : 's') + ').') +
        '\nAmount: ₹' + due.toLocaleString('en-IN') +
        '\n\nIf already paid, please ignore. Thanks!';
      const pPhone = String(p.whatsapp || p.phone || '').replace(/\D/g, '');
      if (pPhone) {
        try {
          const wb = require('../routes/whatsbot');
          if (wb && typeof wb._sendFreeform === 'function') await wb._sendFreeform(pPhone, parentMsg);
          else if (wb && typeof wb._sendText === 'function') await wb._sendText(pPhone, parentMsg);
        } catch (e) { console.warn('[eduReminder] parent WA failed:', e.message); }
      } else if (p.email) {
        try {
          const mailer = require('./mailer');
          await mailer._sendRaw(p.email, 'Fee reminder · ' + (lead.name || ''), '<pre>' + parentMsg + '</pre>');
        } catch (e) { console.warn('[eduReminder] parent email failed:', e.message); }
      }
    }
  } catch (e) { console.warn('[eduReminder] parent broadcast failed:', e.message); }

  return sentSomething;
}

async function tick() {
  // Education pack must be active in this tenant
  let active = false;
  try { active = await packs.isPackActive('education'); } catch (_) {}
  if (!active) return { ok: true, skipped: 'pack-not-active' };

  // Find candidate installments per bucket. Pick rows where the
  // corresponding reminded_* flag is still 0.
  const buckets = [
    { col: 'reminded_15d', label: '15', delta: 15 },
    { col: 'reminded_7d',  label: '7',  delta: 7  },
    { col: 'reminded_1d',  label: '1',  delta: 1  },
    { col: 'reminded_due', label: 'due', delta: 0 }
  ];

  let sent = 0, attempted = 0;
  for (const b of buckets) {
    const since = `CURRENT_DATE + INTERVAL '${b.delta} days'`;
    let rows;
    try {
      const r = await db.query(
        `SELECT i.*, e.lead_id, e.course_name, e.batch_name
           FROM edu_installments i
           JOIN edu_enrollments e ON e.id = i.enrollment_id
          WHERE i.status IN ('due', 'partial')
            AND i.${b.col} = 0
            AND i.due_date = ${since}
          LIMIT 100`
      );
      rows = r.rows || [];
    } catch (e) {
      console.warn('[eduReminder] bucket', b.label, 'query failed:', e.message);
      continue;
    }
    for (const inst of rows) {
      attempted++;
      const lead = await _getLead(inst.lead_id);
      if (!lead) continue;
      const ok = await _sendOnce(inst, lead, b.label);
      // Mark reminded regardless of send-success — if the send path is
      // broken we don't want to retry the same bucket every hour. The
      // admin can re-send manually from the lead's Fees panel.
      try {
        await db.query(`UPDATE edu_installments SET ${b.col} = 1 WHERE id = $1`, [inst.id]);
      } catch (_) {}
      if (ok) sent++;
    }
  }
  if (attempted) console.log('[eduReminder] sent', sent, 'of', attempted);
  return { ok: true, sent, attempted };
}

module.exports = { tick };
