/**
 * utils/reReminderWorker.js — Real Estate pack: daily demand-letter reminder worker.
 *
 * Mirrors the Education pack's eduReminderWorker. Runs once a day and sends
 * WhatsApp + email reminders to buyers whose re_demands are due in 15 / 7 / 1
 * days or due today (and not yet fully paid).
 *
 * Idempotent: an `re_demands.last_reminder_sent_at` and `re_demands.last_reminder_offset`
 * column (auto-healed) prevents the same offset firing twice.
 *
 * Only runs if:
 *   - The 'realestate' pack is installed_packs row exists for the tenant
 *   - The lead has an outstanding amount (demand.amount > demand.paid_amount)
 */
'use strict';

const db = require('../db/pg');

const OFFSETS = [15, 7, 1, 0];   // days before due_date that we ping

async function _ensureReminderCols() {
  try {
    await db.query(`ALTER TABLE re_demands ADD COLUMN IF NOT EXISTS last_reminder_sent_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE re_demands ADD COLUMN IF NOT EXISTS last_reminder_offset INTEGER`);
    await db.query(`ALTER TABLE re_demands ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0`);
  } catch (_) {}
}

/** Run one sweep for the current tenant context (called per-tenant by scheduler). */
async function runSweep() {
  // Skip silently if pack not installed.
  try {
    const r = await db.query(`SELECT 1 FROM installed_packs WHERE pack_id = 'realestate' LIMIT 1`);
    if (!r.rows.length) return { ok: true, skipped: 'pack-not-installed', sent: 0 };
  } catch (_) { return { ok: true, skipped: 'no-installed-packs-table', sent: 0 }; }

  await _ensureReminderCols();

  let sent = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const off of OFFSETS) {
    const target = new Date(today.getTime() + off * 86400000);
    const targetIso = target.toISOString().slice(0, 10);

    const r = await db.query(
      `SELECT d.id, d.booking_id, d.code, d.label, d.amount, d.due_date,
              COALESCE(d.paid_amount, 0) AS paid_amount,
              d.last_reminder_offset,
              b.lead_id, b.unit_id,
              l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
              u.unit_no, p.name AS project_name
         FROM re_demands d
         JOIN re_bookings b ON b.id = d.booking_id
         LEFT JOIN leads l    ON l.id = b.lead_id
         LEFT JOIN re_units u ON u.id = b.unit_id
         LEFT JOIN re_projects p ON p.id = u.project_id
        WHERE DATE(d.due_date) = $1
          AND COALESCE(d.paid_amount, 0) < d.amount
          AND (d.last_reminder_offset IS NULL OR d.last_reminder_offset <> $2)`,
      [targetIso, off]
    );

    for (const row of r.rows) {
      const outstanding = Number(row.amount) - Number(row.paid_amount || 0);
      const phrase = off === 0 ? 'is due TODAY' :
                     off === 1 ? 'is due tomorrow' :
                     `is due in ${off} days`;
      const body =
        `Hi ${row.lead_name || 'there'},\n\n` +
        `Your ${row.label || row.code} demand of ₹${Number(outstanding).toLocaleString('en-IN')} ` +
        `for ${row.project_name || 'your unit'}${row.unit_no ? ' · ' + row.unit_no : ''} ${phrase} ` +
        `(${row.due_date}). Please make the payment to avoid penalties.\n\n` +
        `Reply to this message if you need a fresh demand letter.`;

      // WhatsApp send (best-effort)
      try {
        const wb = require('../routes/whatsbot');
        if (row.lead_phone) {
          await wb._sendText({ to: row.lead_phone, text: body, leadId: row.lead_id, userId: null }, await wb._cfg());
        }
      } catch (e) { console.warn('[reReminder] wa send failed:', e.message); }

      // Email (best-effort)
      try {
        if (row.lead_email) {
          const mailer = require('./mailer');
          await mailer.sendMail({
            to: row.lead_email,
            subject: `Payment reminder · ${row.label || row.code} · ${row.project_name || ''}${row.unit_no ? ' ' + row.unit_no : ''}`,
            text: body
          });
        }
      } catch (e) { console.warn('[reReminder] email send failed:', e.message); }

      await db.query(
        `UPDATE re_demands SET last_reminder_sent_at = NOW(), last_reminder_offset = $1 WHERE id = $2`,
        [off, row.id]
      );
      sent++;
    }
  }

  return { ok: true, sent };
}

// Alias for the per-tenant scheduler loop in server.js (mirr