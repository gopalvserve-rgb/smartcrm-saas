/**
 * utils/reminders.js — background worker that fires follow-up reminders.
 *
 * Every REMINDER_INTERVAL_MS (default 60s) it:
 *   1. Finds open follow-ups where due_at <= now + FOLLOWUP_REMIND_MIN.
 *   2. For each, writes a notification row (if not already written recently).
 *   3. If EMAIL_NOTIFY_ENABLED=1 and SMTP is configured, emails the user.
 *
 * Called once from server.js bootstrap.
 */
const db = require('../db/pg');
let transporter = null;
let lastRun = 0;
const REMIND_DEDUPE_MS = 25 * 60 * 1000; // don't re-notify same follow-up inside 25 min

function _getTransporter() {
  if (transporter) return transporter;
  if (String(process.env.EMAIL_NOTIFY_ENABLED || '') !== '1') return null;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
    return transporter;
  } catch (e) {
    console.error('[reminders] SMTP transporter init failed:', e.message);
    return null;
  }
}

async function _sendMail(to, subject, html) {
  const t = _getTransporter();
  if (!t) return { sent: false, reason: 'smtp not configured' };
  const prefix = process.env.EMAIL_NOTIFY_SUBJECT_PREFIX || '[Lead CRM]';
  try {
    await t.sendMail({
      from: process.env.EMAIL_NOTIFY_FROM || 'Lead CRM <noreply@localhost>',
      to, subject: `${prefix} ${subject}`, html
    });
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

async function _runOnce() {
  const now = Date.now();
  const remindMin = Number(process.env.FOLLOWUP_REMIND_MIN || 15);
  const horizon = new Date(now + remindMin * 60_000).toISOString();

  const [followups, leads, users, notifications] = await Promise.all([
    db.getAll('followups'), db.getAll('leads'),
    db.getAll('users'),     db.getAll('notifications')
  ]);

  const leadById = {};
  leads.forEach(l => { leadById[Number(l.id)] = l; });
  const userById = {};
  users.forEach(u => { userById[Number(u.id)] = u; });

  // Build a dedupe map: for each followup_id, the newest reminder notification
  const recentNotifByFollowup = {};
  notifications.forEach(n => {
    if (n.type === 'followup_due' && n.link) {
      const match = String(n.link).match(/followup=(\d+)/);
      if (match) {
        const fid = Number(match[1]);
        const ts = new Date(n.created_at).getTime();
        if (!recentNotifByFollowup[fid] || ts > recentNotifByFollowup[fid]) {
          recentNotifByFollowup[fid] = ts;
        }
      }
    }
  });

  let fired = 0;
  for (const f of followups) {
    if (Number(f.is_done) === 1) continue;
    if (!f.due_at) continue;
    if (String(f.due_at) > horizon) continue;

    const last = recentNotifByFollowup[Number(f.id)] || 0;
    if (now - last < REMIND_DEDUPE_MS) continue;

    const lead = leadById[Number(f.lead_id)];
    const user = userById[Number(f.user_id)];
    if (!user) continue;

    const title = `Follow-up due: ${lead?.name || 'unknown lead'}`;
    const body  = f.note
      ? `${f.note} — ${lead?.phone || ''}`
      : `${lead?.phone || ''} ${lead?.email || ''}`.trim();
    const link  = `#/leads/${lead?.id || ''}?followup=${f.id}`;

    await db.insert('notifications', {
      user_id: user.id,
      type: 'followup_due',
      title, body, link,
      is_read: 0,
      created_at: db.nowIso()
    });

    if (user.email) {
      await _sendMail(
        user.email,
        title,
        `<p>${title}</p><p>${body || ''}</p>`
        + `<p>Due: ${new Date(f.due_at).toLocaleString()}</p>`
      );
    }

    // Web Push — fires the user's phone with an SMS-style banner even if
    // the app is closed. Best-effort: silently skip if push isn't set up.
    try {
      const push = require('../routes/push');
      await push.sendPushToUser(user.id, {
        title: '⏰ Follow-up due',
        body:  `${lead?.name || 'Unknown'}${lead?.phone ? ' · ' + lead.phone : ''}${body ? '\n' + body : ''}`,
        url:   `/#/followups`,
        tag:   'fu-' + f.id,
        sticky: true
      });
    } catch (e) { console.warn('[push] reminder send failed:', e.message); }
    fired++;
  }

  lastRun = now;
  if (fired > 0) console.log(`[reminders] fired ${fired} follow-up reminders`);
}

function start() {
  const intervalMs = Number(process.env.REMINDER_INTERVAL_MS || 60_000);
  console.log(`[reminders] starting with ${intervalMs}ms interval`);
  setInterval(() => {
    _runOnce().catch(e => console.error('[reminders] run failed:', e.message));
  }, intervalMs);
  // Fire an initial run ~10s after boot so we see it early
  setTimeout(() => _runOnce().catch(() => {}), 10_000);
}

module.exports = { start };
