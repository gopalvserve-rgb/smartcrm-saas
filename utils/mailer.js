/**
 * Unified email engine.
 *
 *  - reads SMTP creds from the config table (with env fallback)
 *  - per-event toggles (NOTIFY_NEW_LEAD, NOTIFY_LEAD_ASSIGNED, etc)
 *  - editable templates per event_type stored in the email_templates table
 *  - Mustache-style dynamic variables: {{name}}, {{phone}}, etc
 *  - branded header/footer auto-applied to every send (uses COMPANY_NAME +
 *    COMPANY_LOGO_URL from /config so emails carry your brand)
 *  - daily 9 AM cron: morning_followups
 *  - daily 7 PM cron: day_end summary
 *
 * Public API:
 *  await mailer.sendEvent(event_type, payload)   // generic dispatcher
 *  await mailer.testSmtp(toEmail)                 // admin "send test email" button
 *  mailer.startDailyCron()                        // wire up the schedules
 *  mailer.SUPPORTED_EVENTS                        // for the admin UI
 */

const db = require('../db/pg');
const nodemailer = require('nodemailer');

// ---------- supported notification events ----------
const SUPPORTED_EVENTS = [
  {
    id: 'new_lead',
    label: 'New Lead Notification',
    description: 'Email an admin every time a new lead is created.',
    config_key: 'NOTIFY_NEW_LEAD',
    default_subject: 'New lead: {{name}}',
    default_body: `<p>A new lead just came in:</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td><b>Name</b></td><td>{{name}}</td></tr>
<tr><td><b>Phone</b></td><td>{{phone}}</td></tr>
<tr><td><b>Email</b></td><td>{{email}}</td></tr>
<tr><td><b>Source</b></td><td>{{source}}</td></tr>
<tr><td><b>City</b></td><td>{{city}}</td></tr>
<tr><td><b>Tags</b></td><td>{{tags}}</td></tr>
</table>
<p><a href="{{lead_url}}" style="background:#6366f1;color:#fff;padding:10px 16px;text-decoration:none;border-radius:8px;display:inline-block">Open in CRM</a></p>`
  },
  {
    id: 'lead_assigned',
    label: 'Lead Assigned Notification',
    description: 'Email the salesperson when a lead is assigned to them.',
    config_key: 'NOTIFY_LEAD_ASSIGNED',
    default_subject: '{{assigned_name}}, you have a new lead: {{name}}',
    default_body: `<p>Hi <b>{{assigned_first_name}}</b>,</p>
<p>A new lead has been assigned to you:</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td><b>Name</b></td><td>{{name}}</td></tr>
<tr><td><b>Phone</b></td><td>{{phone}}</td></tr>
<tr><td><b>Source</b></td><td>{{source}}</td></tr>
<tr><td><b>Notes</b></td><td>{{notes}}</td></tr>
</table>
<p><a href="{{lead_url}}" style="background:#6366f1;color:#fff;padding:10px 16px;text-decoration:none;border-radius:8px;display:inline-block">Call now</a></p>`
  },
  {
    id: 'new_device_login',
    label: 'New Device Login Notification',
    description: 'Email a user when a sign-in comes from a device/IP combination they\'ve never used before.',
    config_key: 'NOTIFY_NEW_DEVICE_LOGIN',
    default_subject: 'New sign-in to your {{company_name}} account',
    default_body: `<p>Hi <b>{{user_first_name}}</b>,</p>
<p>We noticed a sign-in to your {{company_name}} account from a new device:</p>
<table style="border-collapse:collapse;font-size:14px">
<tr><td><b>Time</b></td><td>{{login_time}}</td></tr>
<tr><td><b>IP address</b></td><td>{{ip}}</td></tr>
<tr><td><b>Device</b></td><td>{{user_agent}}</td></tr>
</table>
<p>If this was you, no action needed. If not, please change your password immediately.</p>`
  },
  {
    id: 'morning_followups',
    label: "Today's Follow-up Notifications",
    description: 'Each morning at 9 AM IST, email every salesperson the list of leads they need to call today.',
    config_key: 'NOTIFY_MORNING_FOLLOWUPS',
    default_subject: '☀️ Your follow-ups for {{date}}',
    default_body: `<p>Hi <b>{{user_first_name}}</b>,</p>
<p>You have <b>{{count}}</b> follow-up(s) scheduled for today:</p>
{{followup_table}}
<p><a href="{{base_url}}/#/followups" style="background:#6366f1;color:#fff;padding:10px 16px;text-decoration:none;border-radius:8px;display:inline-block">Open follow-ups in CRM</a></p>
<p>Have a great day! 🚀</p>`
  },
  {
    id: 'day_end',
    label: 'Day-End Notification',
    description: 'Each evening at 7 PM, email admins a status-wise summary of leads created and worked on today.',
    config_key: 'NOTIFY_DAY_END',
    default_subject: '📊 Day-end report — {{date}}',
    default_body: `<p>Hi team,</p>
<p>Today's lead summary:</p>
{{status_table}}
<p><b>{{total_today}}</b> new leads · <b>{{total_won_today}}</b> won · <b>{{total_calls_today}}</b> calls logged</p>
<p><a href="{{base_url}}/#/dashboard" style="background:#6366f1;color:#fff;padding:10px 16px;text-decoration:none;border-radius:8px;display:inline-block">Open dashboard</a></p>`
  },
  {
    id: 'eod_per_rep',
    label: 'Per-Rep End-of-Day Summary',
    description: 'Each evening at 7:05 PM, email each rep their personal activity for the day (leads, status moves, calls, WhatsApp, follow-ups), with their manager on cc. Reps with zero activity are skipped.',
    config_key: 'NOTIFY_EOD_PER_REP',
    default_subject: '🌙 Your day at a glance — {{date}}',
    default_body: `<p>Hi {{user_first_name}},</p>
<p>Here's how your day went:</p>
<table style="border-collapse:collapse;width:100%;font-size:14px;margin:12px 0">
<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">🆕 New leads assigned</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:500">{{leads_today}}</td></tr>
<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">🔄 Status changes</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:500">{{status_moves_today}}</td></tr>
<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">📞 Calls logged</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:500">{{calls_today}}</td></tr>
<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">💬 WhatsApp messages sent</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:500">{{whatsapp_today}}</td></tr>
<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">✅ Follow-ups completed</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:500">{{followups_done_today}}</td></tr>
<tr><td style="padding:8px 12px">📅 Follow-ups due tomorrow</td><td style="padding:8px 12px;text-align:right;font-weight:500">{{followups_due_tomorrow}}</td></tr>
</table>
{{followups_tomorrow_table}}
<p style="margin-top:18px;color:#475569;font-size:13px">Have a good evening — see you tomorrow.</p>`
  }
];

// ---------- config helpers ----------
async function _config(key, fallback) {
  const row = await db.findOneBy('config', 'key', key).catch(() => null);
  return (row && row.value != null && row.value !== '') ? row.value : (process.env[key] || fallback || '');
}
async function _allConfig() {
  const rows = await db.getAll('config').catch(() => []);
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  return out;
}
async function _eventEnabled(eventType) {
  const ev = SUPPORTED_EVENTS.find(e => e.id === eventType);
  if (!ev) return false;
  const v = await _config(ev.config_key, '0');
  return String(v) === '1';
}

// ---------- transporter (cached) ----------
let _cachedTransporter = null;
let _cachedSig = '';
async function _transporter() {
  const cfg = await _allConfig();
  const sig = [cfg.SMTP_HOST, cfg.SMTP_PORT, cfg.SMTP_USER, cfg.SMTP_PASSWORD, cfg.SMTP_SECURE].join('|');
  if (_cachedTransporter && sig === _cachedSig) return _cachedTransporter;
  const host = cfg.SMTP_HOST || process.env.SMTP_HOST;
  if (!host) throw new Error('SMTP not configured — fill in Settings → SMTP first.');
  const port = Number(cfg.SMTP_PORT || process.env.SMTP_PORT || 587);
  const secure = String(cfg.SMTP_SECURE || process.env.SMTP_SECURE || '0') === '1' || port === 465;
  _cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS: !secure && port !== 25,
    auth: cfg.SMTP_USER ? {
      user: cfg.SMTP_USER || process.env.SMTP_USER,
      pass: cfg.SMTP_PASSWORD || process.env.SMTP_PASSWORD || ''
    } : undefined,
    tls: { rejectUnauthorized: false }, // Gmail/O365/AWS SES quirks
    pool: true
  });
  _cachedSig = sig;
  return _cachedTransporter;
}

// ---------- branded header + footer ----------
async function _wrap(subject, bodyHtml, ctx) {
  const cfg = await _allConfig();
  const company = ctx.company_name || cfg.COMPANY_NAME || 'Lead CRM';
  const logoUrl = cfg.COMPANY_LOGO_URL || '';
  const sigText = cfg.EMAIL_SIGNATURE || '';
  const baseUrl = ctx.base_url || cfg.BASE_URL || '';
  const supportText = cfg.EMAIL_SUPPORT_TEXT || `Sent by ${company}. If you weren't expecting this email, you can ignore it.`;

  const logoBlock = logoUrl
    ? `<img src="${logoUrl}" alt="${company}" style="max-height:40px;display:block">`
    : `<div style="font-size:18px;font-weight:700;color:#fff">🎯 ${company}</div>`;

  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,.08)">
      <tr><td style="background:linear-gradient(135deg,#6366f1,#8b5cf6,#ec4899);padding:20px 28px">
        ${logoBlock}
      </td></tr>
      <tr><td style="padding:28px 28px 4px;font-size:15px;line-height:1.6">
        ${bodyHtml}
      </td></tr>
      ${sigText ? `<tr><td style="padding:0 28px 20px;font-size:14px;color:#475569;border-top:1px solid #f1f5f9;margin-top:18px">
        <div style="margin-top:18px">${sigText}</div>
      </td></tr>` : ''}
      <tr><td style="padding:16px 28px;background:#f8fafc;font-size:12px;color:#94a3b8;text-align:center">
        ${supportText}<br>
        ${baseUrl ? `<a href="${baseUrl}" style="color:#6366f1;text-decoration:none">${baseUrl}</a>` : ''}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ---------- variable substitution ----------
function _render(template, ctx) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const path = key.split('.');
    let v = ctx;
    for (const p of path) v = v != null ? v[p] : undefined;
    return v == null ? '' : String(v);
  });
}

// ---------- template loader (DB → fallback) ----------
async function _loadTemplate(eventType) {
  const row = await db.findOneBy('email_templates', 'event_type', eventType).catch(() => null);
  if (row) return row;
  // Seed default if missing — first send self-heals
  const def = SUPPORTED_EVENTS.find(e => e.id === eventType);
  if (!def) return null;
  await db.insert('email_templates', {
    event_type: eventType,
    name: def.label,
    subject: def.default_subject,
    body_html: def.default_body,
    is_active: 1,
    updated_at: db.nowIso()
  });
  return await db.findOneBy('email_templates', 'event_type', eventType);
}

// ---------- send a single email ----------
async function _sendRaw(to, subject, html, opts) {
  if (!to) return { ok: false, error: 'No recipient' };
  const cfg = await _allConfig();
  const t = await _transporter();
  const fromEmail = cfg.SMTP_FROM || cfg.SMTP_USER || cfg.EMAIL_NOTIFY_FROM || 'no-reply@example.com';
  const fromName = cfg.COMPANY_NAME || 'Lead CRM';
  const bcc = cfg.EMAIL_BCC || '';
  const subjectPrefix = cfg.EMAIL_NOTIFY_SUBJECT_PREFIX || '';
  const subj = subjectPrefix ? subjectPrefix + ' ' + subject : subject;
  await t.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to,
    bcc: bcc || undefined,
    subject: subj,
    html,
    headers: { 'X-Mailer': 'LeadCRM' },
    ...(opts || {})
  });
  return { ok: true };
}

// ---------- public: dispatch by event ----------
async function sendEvent(eventType, payload) {
  if (!await _eventEnabled(eventType)) return { ok: false, skipped: 'disabled' };
  const tpl = await _loadTemplate(eventType);
  if (!tpl || !Number(tpl.is_active)) return { ok: false, skipped: 'template_inactive' };
  // Add base_url + company_name to every render context
  const cfg = await _allConfig();
  const ctx = Object.assign({}, payload, {
    company_name: cfg.COMPANY_NAME || 'Lead CRM',
    base_url: payload.base_url || cfg.BASE_URL || '',
    date: new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })
  });
  const subject = _render(tpl.subject, ctx);
  const inner = _render(tpl.body_html, ctx);
  const html = await _wrap(subject, inner, ctx);
  // Forward cc through if the caller passed it (used by eod_per_rep to
  // copy the rep's manager). Falls back to no cc when absent.
  const opts = payload.cc ? { cc: payload.cc } : undefined;
  return await _sendRaw(payload.to, subject, html, opts);
}

// ---------- admin "send test email" ----------
async function testSmtp(to) {
  const cfg = await _allConfig();
  const company = cfg.COMPANY_NAME || 'Lead CRM';
  const html = await _wrap('SMTP test', `<p>This is a test email from <b>${company}</b>.</p>
<p>If you can read this, your SMTP settings are working correctly. ✅</p>
<p style="color:#94a3b8;font-size:13px">Sent at ${new Date().toLocaleString('en-IN')}</p>`, { company_name: company, base_url: cfg.BASE_URL || '' });
  await _sendRaw(to, 'SMTP test from ' + company, html);
  return { ok: true };
}

// ---------- daily morning follow-ups (9 AM) ----------
async function sendMorningFollowups() {
  if (!await _eventEnabled('morning_followups')) return { ok: false, skipped: 'disabled' };
  const today = new Date().toISOString().slice(0, 10);
  const allUsers = await db.getAll('users');
  const allLeads = await db.getAll('leads');
  const allFollowups = (await db.getAll('followups')).filter(f => Number(f.is_done) === 0);
  let sent = 0;
  for (const u of allUsers) {
    if (!u.email || Number(u.is_active) !== 1) continue;
    const mine = allFollowups.filter(f =>
      Number(f.user_id) === Number(u.id) &&
      String(f.due_at || '').slice(0, 10) === today
    );
    if (mine.length === 0) continue;
    // Build the followup table
    const rows = mine.map(f => {
      const lead = allLeads.find(l => Number(l.id) === Number(f.lead_id)) || {};
      return `<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${lead.name || '-'}</td>
<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9"><a href="tel:${lead.phone || ''}" style="color:#6366f1;text-decoration:none">${lead.phone || ''}</a></td>
<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#475569">${(f.note || '').slice(0, 120)}</td></tr>`;
    }).join('');
    const followup_table = `<table style="border-collapse:collapse;width:100%;font-size:14px">
<thead><tr style="background:#eef2ff"><th style="text-align:left;padding:8px 10px">Lead</th><th style="text-align:left;padding:8px 10px">Phone</th><th style="text-align:left;padding:8px 10px">Notes</th></tr></thead>
<tbody>${rows}</tbody></table>`;
    await sendEvent('morning_followups', {
      to: u.email,
      user_first_name: (u.name || '').split(' ')[0],
      user_name: u.name,
      count: mine.length,
      followup_table
    });
    sent++;
  }
  return { ok: true, sent };
}

// ---------- daily day-end report (7 PM) ----------
async function sendDayEndReport() {
  if (!await _eventEnabled('day_end')) return { ok: false, skipped: 'disabled' };
  const today = new Date().toISOString().slice(0, 10);
  const allUsers = await db.getAll('users');
  const admins = allUsers.filter(u => u.email && (u.role === 'admin' || u.role === 'manager') && Number(u.is_active) === 1);
  if (admins.length === 0) return { ok: false, skipped: 'no_admins' };
  const allLeads = await db.getAll('leads');
  const todays = allLeads.filter(l => String(l.created_at).slice(0, 10) === today);
  const statuses = await db.getAll('statuses');
  const statusById = Object.fromEntries(statuses.map(s => [Number(s.id), s]));
  const counts = {};
  todays.forEach(l => {
    const s = statusById[Number(l.status_id)];
    const k = (s && s.name) || 'Unassigned';
    counts[k] = (counts[k] || 0) + 1;
  });
  const rows = Object.entries(counts).map(([name, n]) =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${name}</td>
<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-weight:700;text-align:right">${n}</td></tr>`
  ).join('') || '<tr><td colspan="2" style="padding:12px;color:#94a3b8;text-align:center">No new leads today</td></tr>';
  const status_table = `<table style="border-collapse:collapse;width:100%;font-size:14px">
<thead><tr style="background:#eef2ff"><th style="text-align:left;padding:8px 10px">Status</th><th style="text-align:right;padding:8px 10px">Count</th></tr></thead>
<tbody>${rows}</tbody></table>`;
  const total_today = todays.length;
  const wonStatus = statuses.find(s => /won/i.test(s.name || ''));
  const total_won_today = wonStatus ? todays.filter(l => Number(l.status_id) === Number(wonStatus.id)).length : 0;
  let total_calls_today = 0;
  try {
    const calls = await db.getAll('call_events');
    total_calls_today = calls.filter(c => String(c.created_at).slice(0, 10) === today).length;
  } catch (_) {}
  let sent = 0;
  for (const u of admins) {
    await sendEvent('day_end', {
      to: u.email,
      user_first_name: (u.name || '').split(' ')[0],
      total_today, total_won_today, total_calls_today,
      status_table
    });
    sent++;
  }
  return { ok: true, sent };
}

// ---------- per-rep day-end summary (7:05 PM) ----------
/**
 * Personalised end-of-day email to each active rep covering THEIR own
 * activity for the day:
 *   - Leads they were assigned today
 *   - Status moves they made
 *   - Calls they logged
 *   - WhatsApp messages they sent
 *   - Follow-ups they completed
 *   - Follow-ups due tomorrow
 *
 * Sends to the rep with their parent (manager) on cc so the manager
 * gets per-rep visibility without anyone having to ask.
 *
 * Intentionally safe-on-failure: a missing column or empty table just
 * shows "0" — the email always goes out as long as the rep has email.
 */
async function sendDayEndPerRep() {
  if (!await _eventEnabled('eod_per_rep')) return { ok: false, skipped: 'disabled' };
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const allUsers = await db.getAll('users');
  // Reps = anyone active with an email, EXCLUDING admins (they get the
  // aggregate report). Managers + team_leads + sales all get the per-rep
  // summary so they can self-track.
  const reps = allUsers.filter(u =>
    u.email && Number(u.is_active) === 1 && u.role !== 'admin'
  );
  if (reps.length === 0) return { ok: false, skipped: 'no_reps' };

  // Pre-load the activity tables once, then index per-user in JS to
  // avoid N round-trips to the DB.
  const allLeads      = await db.getAll('leads').catch(() => []);
  const allRemarks    = await db.getAll('remarks').catch(() => []);
  const allFollowups  = await db.getAll('followups').catch(() => []);
  const allCalls      = await db.getAll('call_events').catch(() => []);
  const allWaSent     = await db.query(
    `SELECT * FROM whatsapp_messages WHERE direction = 'out' AND created_at::date = $1`,
    [today]
  ).then(r => r.rows).catch(() => []);
  const allStageLog   = await db.query(
    `SELECT * FROM lead_stage_log WHERE created_at::date = $1`,
    [today]
  ).then(r => r.rows).catch(() => []);

  const usersById = Object.fromEntries(allUsers.map(u => [Number(u.id), u]));

  let sent = 0;
  for (const u of reps) {
    const uid = Number(u.id);
    const myLeadsToday = allLeads.filter(l =>
      Number(l.assigned_to) === uid && String(l.created_at).slice(0, 10) === today
    );
    const myStatusMoves = allStageLog.filter(s => Number(s.user_id) === uid).length;
    const myCalls = allCalls.filter(c =>
      Number(c.user_id) === uid && String(c.created_at).slice(0, 10) === today
    ).length;
    const myWa = allWaSent.filter(m => Number(m.user_id) === uid).length;
    const myFuDoneToday = allFollowups.filter(f =>
      Number(f.user_id) === uid && Number(f.is_done) === 1 &&
      String(f.done_at || '').slice(0, 10) === today
    ).length;
    const myFuDueTomorrow = allFollowups.filter(f =>
      Number(f.user_id) === uid && Number(f.is_done) === 0 &&
      String(f.due_at || '').slice(0, 10) === tomorrow
    );
    // If the rep had no activity at all, skip — don't spam empty digests.
    const hadAnyActivity =
      myLeadsToday.length || myStatusMoves || myCalls || myWa ||
      myFuDoneToday || myFuDueTomorrow.length;
    if (!hadAnyActivity) continue;

    // Render a compact follow-ups-tomorrow table so the rep wakes up to
    // their queue (or knows it's clear).
    let followups_tomorrow_table = '';
    if (myFuDueTomorrow.length) {
      const leadById = Object.fromEntries(allLeads.map(l => [Number(l.id), l]));
      const rows = myFuDueTomorrow.slice(0, 25).map(f => {
        const l = leadById[Number(f.lead_id)] || {};
        const tm = (f.due_at || '').slice(11, 16);
        return `<tr><td style="padding:6px 10px;border-bottom:1px solid #f1f5f9">${(l.name || '—')}</td>
<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#475569">${l.phone || ''}</td>
<td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;color:#475569">${tm}</td></tr>`;
      }).join('');
      followups_tomorrow_table = `<p style="margin:18px 0 6px;font-weight:500">Tomorrow's follow-ups (${myFuDueTomorrow.length}):</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="background:#eef2ff">
<th style="text-align:left;padding:8px 10px">Lead</th>
<th style="text-align:left;padding:8px 10px">Phone</th>
<th style="text-align:left;padding:8px 10px">Time</th>
</tr></thead><tbody>${rows}</tbody></table>`;
    } else {
      followups_tomorrow_table = '<p style="margin:18px 0 6px;color:#64748b;font-size:13px">No follow-ups scheduled for tomorrow.</p>';
    }

    // CC the rep's manager (parent_id) for visibility — but only on
    // their own report, not on every rep's individually.
    const manager = u.parent_id ? usersById[Number(u.parent_id)] : null;
    const cc = manager && manager.email ? manager.email : '';

    await sendEvent('eod_per_rep', {
      to: u.email,
      cc,
      user_first_name: (u.name || '').split(' ')[0],
      user_name: u.name,
      leads_today: myLeadsToday.length,
      status_moves_today: myStatusMoves,
      calls_today: myCalls,
      whatsapp_today: myWa,
      followups_done_today: myFuDoneToday,
      followups_due_tomorrow: myFuDueTomorrow.length,
      followups_tomorrow_table
    });
    sent++;
  }
  return { ok: true, sent, total_reps: reps.length };
}

// ---------- daily cron ----------
let _cronTimer = null;
function startDailyCron() {
  if (_cronTimer) clearInterval(_cronTimer);
  // Check every 60s for the trigger windows. Cheap, simple, no extra deps.
  let lastFired = '';
  _cronTimer = setInterval(async () => {
    try {
      const now = new Date();
      const istHour = (now.getUTCHours() + 5) % 24;  // server is UTC; IST = UTC+5:30
      const istMin = now.getUTCMinutes() + 30;
      const adjustedHour = istMin >= 60 ? (istHour + 1) % 24 : istHour;
      const adjustedMin = istMin % 60;
      const stamp = now.toISOString().slice(0, 10);
      // 9:00 IST → morning followups
      if (adjustedHour === 9 && adjustedMin === 0 && lastFired !== stamp + ':9') {
        lastFired = stamp + ':9';
        const r = await sendMorningFollowups();
        console.log('[mailer-cron] morning_followups:', JSON.stringify(r));
      }
      // 19:00 IST → aggregate day-end report (admins/managers)
      if (adjustedHour === 19 && adjustedMin === 0 && lastFired !== stamp + ':19') {
        lastFired = stamp + ':19';
        const r = await sendDayEndReport();
        console.log('[mailer-cron] day_end:', JSON.stringify(r));
      }
      // 19:05 IST → per-rep day-end summary (each non-admin user)
      // Five minutes after the aggregate so they don't queue at the same
      // SMTP burst window.
      if (adjustedHour === 19 && adjustedMin === 5 && lastFired !== stamp + ':19:05') {
        lastFired = stamp + ':19:05';
        const r = await sendDayEndPerRep();
        console.log('[mailer-cron] eod_per_rep:', JSON.stringify(r));
      }
    } catch (e) { console.error('[mailer-cron] error:', e.message); }
  }, 60_000);
}

// ---------- new-device login detection ----------
const crypto = require('crypto');
async function recordLogin(userId, req) {
  const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 250);
  const ip = String((req && (req.headers['x-forwarded-for'] || req.connection?.remoteAddress)) || 'unknown').split(',')[0].trim();
  const fingerprint = crypto.createHash('sha256').update(ua + '|' + ip).digest('hex').slice(0, 32);
  const existing = (await db.findBy('user_devices', 'user_id', userId).catch(() => []))
    .find(d => d.fingerprint === fingerprint);
  if (existing) {
    await db.update('user_devices', existing.id, { last_seen_at: db.nowIso() });
    return { isNew: false };
  }
  await db.insert('user_devices', {
    user_id: userId, fingerprint,
    user_agent: ua, ip,
    first_seen_at: db.nowIso(), last_seen_at: db.nowIso()
  });
  // Don't fire the email on the very first login of a brand-new user
  // (they wouldn't expect it). Only fire when it's the 2nd-or-later device.
  const count = (await db.findBy('user_devices', 'user_id', userId).catch(() => [])).length;
  return { isNew: count >= 2, ua, ip };
}

module.exports = {
  SUPPORTED_EVENTS,
  sendEvent, testSmtp,
  sendMorningFollowups, sendDayEndReport, sendDayEndPerRep,
  startDailyCron,
  recordLogin
};
