'use strict';
/**
 * TENANT_BILLING_NOTIFY_v1 (2026-06-20) — daily sweep that finds
 * tenants with an overdue balance and nudges them via email + WA.
 *
 * Rules (per user spec):
 *   - Trigger: NOW() >= payment_reminder_at + 7 days AND balance > 0
 *   - First nudge fires the day the +7 window passes.
 *   - Subsequent nudges fire weekly (last_reminder_sent_at <= NOW() - 7 days)
 *     until the balance is cleared or the admin clears the reminder.
 *
 * Wired in server.js — runs every 6 hours so timezone drift doesn't
 * delay the first reminder beyond half a day.
 */

const control = require('../../control/db');
const mailer  = require('./saasMailer');
const waSender = require('../../utils/saasWaSender');

async function runOverdueSweep() {
  try {
    const r = await control.query(`
      SELECT id, slug, org_name, contact_name, contact_email, contact_mobile,
             total_amount_inr, amount_paid_inr, payment_reminder_at,
             last_reminder_sent_at
        FROM tenants
       WHERE COALESCE(status, '') NOT IN ('deleted', 'pending_delete', 'suspended')
         AND total_amount_inr IS NOT NULL
         AND amount_paid_inr  IS NOT NULL
         AND total_amount_inr > amount_paid_inr
         AND payment_reminder_at IS NOT NULL
         AND NOW() >= payment_reminder_at + INTERVAL '7 days'
         AND (last_reminder_sent_at IS NULL
              OR last_reminder_sent_at <= NOW() - INTERVAL '7 days')
       ORDER BY id`);
    const overdue = r.rows || [];
    if (!overdue.length) {
      console.log('[billing_rem] no overdue tenants');
      return { ok: true, processed: 0 };
    }
    console.log('[billing_rem] processing', overdue.length, 'overdue tenants');
    let emailSent = 0, waSent = 0, failed = 0;
    for (const t of overdue) {
      const total = Number(t.total_amount_inr) || 0;
      const paid  = Number(t.amount_paid_inr)  || 0;
      const bal   = Math.max(0, total - paid);
      const dueOn = new Date(t.payment_reminder_at).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      // Email
      try {
        await mailer.sendMail({
          to: t.contact_email,
          subject: '💳 SmartCRM — balance amount ₹' + bal.toLocaleString('en-IN') + ' is pending',
          html: '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:1.5rem;color:#0f172a">' +
            '<h2 style="margin:0 0 1rem 0">Hi ' + _esc(t.contact_name || '') + ',</h2>' +
            '<p>Your SmartCRM workspace <b>' + _esc(t.org_name || '') + '</b> has an outstanding balance.</p>' +
            '<div style="background:#fef3c7;padding:1rem;border-radius:8px;margin:1.25rem 0">' +
              '<div style="font-size:.85rem;color:#92400e">Pending balance</div>' +
              '<div style="font-size:1.6rem;font-weight:800;color:#7c2d12;margin:.25rem 0">₹' + bal.toLocaleString('en-IN') + '</div>' +
              '<div style="font-size:.85rem;color:#92400e">Was due on ' + _esc(dueOn) + '</div>' +
            '</div>' +
            '<p style="font-size:.9rem">Please make the balance payment at your earliest convenience. Reply to this email or message us on WhatsApp if you need a fresh invoice or have any questions.</p>' +
            '<p style="font-size:.85rem;color:#94a3b8;margin-top:2rem">— The SmartCRM team</p>' +
          '</div>'
        });
        emailSent++;
      } catch (e) {
        console.warn('[billing_rem] email failed for tenant', t.id, e.message);
        failed++;
      }
      // WhatsApp via Vserve's WABA
      try {
        const msg = 'Hi ' + (t.contact_name || '') + ',\n\n' +
          'Your SmartCRM workspace *' + (t.org_name || '') + '* has an outstanding balance.\n\n' +
          '💳 *Pending balance: ₹' + bal.toLocaleString('en-IN') + '*\n' +
          '📅 Was due on ' + dueOn + '\n\n' +
          'Please clear the balance at your earliest convenience. Reply to this message or email us if you need a fresh invoice.\n\n— Team SmartCRM';
        const r2 = await waSender.sendText(t.contact_mobile, msg);
        if (r2.ok) waSent++;
        else console.warn('[billing_rem] WA failed for tenant', t.id, r2.error);
      } catch (e) {
        console.warn('[billing_rem] WA error for tenant', t.id, e.message);
      }
      // Stamp last_reminder_sent_at regardless — so we don't loop daily on
      // a tenant whose contact channels are broken; admin has to fix.
      try {
        await control.query(
          `UPDATE tenants SET last_reminder_sent_at = NOW() WHERE id = $1`,
          [t.id]);
      } catch (_) {}
    }
    console.log('[billing_rem] done — email=' + emailSent + ' wa=' + waSent + ' failed=' + failed);
    return { ok: true, processed: overdue.length, email_sent: emailSent, wa_sent: waSent, failed };
  } catch (e) {
    console.error('[billing_rem] sweep crashed:', e.message);
    return { ok: false, error: e.message };
  }
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

module.exports = { runOverdueSweep };
