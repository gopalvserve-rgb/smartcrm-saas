/**
 * Platform-level mailer for SaaS notifications (welcome emails, invoices,
 * password resets for the super-admin panel).
 *
 * Settings layout matches the Perfex-style UI in the admin panel:
 *   MAIL_PROTOCOL       SMTP | sendmail | mail | gmail_oauth | ms_oauth
 *   MAIL_ENCRYPTION     TLS | SSL | none
 *   SMTP_HOST           smtp.gmail.com
 *   SMTP_PORT           587
 *   MAIL_FROM_EMAIL     sales@smartcrmsolution.com
 *   MAIL_FROM_NAME      SmartCRM
 *   SMTP_USERNAME       sales@smartcrmsolution.com
 *   SMTP_PASSWORD       <gmail app password>
 *   MAIL_CHARSET        utf-8
 *   MAIL_BCC            (optional CSV of bcc recipients)
 *   MAIL_SIGNATURE      (optional HTML appended to every outgoing email)
 *
 * The transporter is cached and rebuilt on settings change via
 * invalidate(). Backwards-compatible — older keys (GMAIL_USER,
 * GMAIL_APP_PASSWORD, SENDGRID_API_KEY, MAIL_PROVIDER) still work as
 * fallbacks if the new ones are blank.
 */
const nodemailer = require('nodemailer');
const control = require('../../control/db');

let _transporter = null;
let _key = null;

async function _getCfg() {
  // New-style keys (preferred)
  const [
    protocol, encryption, host, port, fromEmail, fromName,
    user, pass, charset, bcc, signature,
    legacyProvider, legacyGmailUser, legacyGmailPass, legacySendgrid, legacyFrom
  ] = await Promise.all([
    control.getSetting('MAIL_PROTOCOL', 'SMTP'),
    control.getSetting('MAIL_ENCRYPTION', 'TLS'),
    control.getSetting('SMTP_HOST', ''),
    control.getSetting('SMTP_PORT', '587'),
    control.getSetting('MAIL_FROM_EMAIL', ''),
    control.getSetting('MAIL_FROM_NAME', 'SmartCRM'),
    control.getSetting('SMTP_USERNAME', ''),
    control.getSetting('SMTP_PASSWORD', ''),
    control.getSetting('MAIL_CHARSET', 'utf-8'),
    control.getSetting('MAIL_BCC', ''),
    control.getSetting('MAIL_SIGNATURE', ''),
    // Legacy fallbacks (set by Phase 1 seed)
    control.getSetting('MAIL_PROVIDER', ''),
    control.getSetting('GMAIL_USER', ''),
    control.getSetting('GMAIL_APP_PASSWORD', ''),
    control.getSetting('SENDGRID_API_KEY', ''),
    control.getSetting('MAIL_FROM', '')
  ]);

  // Resolve effective values, preferring new keys but falling back to legacy
  let effHost = host;
  let effPort = Number(port) || 587;
  let effUser = user;
  let effPass = pass;
  let effFrom = fromEmail || legacyFrom;
  let effEnc  = String(encryption || 'TLS').toUpperCase();

  // If no new-style host but legacy provider set, infer from legacy
  if (!effHost && String(legacyProvider).toLowerCase() === 'sendgrid') {
    effHost = 'smtp.sendgrid.net'; effUser = 'apikey'; effPass = legacySendgrid;
    if (!effFrom) effFrom = legacyGmailUser || 'no-reply@smartcrmsolution.com';
  }
  if (!effHost && String(legacyProvider).toLowerCase() === 'gmail') {
    effHost = 'smtp.gmail.com'; effUser = legacyGmailUser; effPass = legacyGmailPass;
    if (!effFrom) effFrom = legacyGmailUser;
  }

  if (!effHost || !effUser || !effPass) {
    throw new Error('Email is not configured. Settings → Email → fill SMTP host/username/password.');
  }

  return {
    protocol: String(protocol || 'SMTP').toUpperCase(),
    encryption: effEnc,
    host: effHost,
    port: effPort,
    secure: effEnc === 'SSL' || effPort === 465,   // SSL on 465; TLS uses STARTTLS on 587
    user: effUser,
    pass: effPass,
    from: effFrom ? `${(fromName || 'SmartCRM').replace(/[<>]/g, '')} <${effFrom}>` : effUser,
    charset: charset || 'utf-8',
    bcc: bcc || '',
    signature: signature || ''
  };
}

async function _getTransporter() {
  const c = await _getCfg();
  // Strip whitespace from password — Gmail's UI shows the App Password
  // with spaces ("mbfl bngn szfi kcgg") and users sometimes paste it in
  // that form. Nodemailer would then 535 "username and password not
  // accepted". Trim defensively before building the transporter.
  if (typeof c.pass === 'string') c.pass = c.pass.replace(/\s+/g, '');
  const key = JSON.stringify({ host: c.host, port: c.port, user: c.user, secure: c.secure });
  if (_transporter && _key === key) return { transporter: _transporter, cfg: c };
  // For smtp.gmail.com use the nodemailer "gmail" service preset which
  // picks the right host/port/TLS combination automatically — works
  // around an issue where Railway's egress can stall on direct
  // smtp.gmail.com:587 connections but works on the service-routed
  // alternative endpoints.
  const isGmail = /smtp\.gmail\.com/i.test(c.host);
  _transporter = nodemailer.createTransport(isGmail ? {
    service: 'gmail',
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 30000,
    greetingTimeout:   15000,
    socketTimeout:     30000
  } : {
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 30000,
    greetingTimeout:   15000,
    socketTimeout:     30000
  });
  _key = key;
  return { transporter: _transporter, cfg: c };
}

async function sendMail({ to, subject, html, text, bcc }) {
  const { transporter, cfg } = await _getTransporter();
  const finalBcc = (bcc || cfg.bcc || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const finalHtml = html
    ? (cfg.signature ? html + '<hr style="border:none;border-top:1px solid #e5e7eb;margin:1.5rem 0"/>' + cfg.signature : html)
    : undefined;
  return transporter.sendMail({
    from: cfg.from,
    to,
    subject,
    bcc: finalBcc.length ? finalBcc : undefined,
    html: finalHtml,
    text: text || (finalHtml ? finalHtml.replace(/<[^>]+>/g, '') : ''),
    encoding: cfg.charset
  });
}

function invalidate() { _transporter = null; _key = null; }

module.exports = { sendMail, invalidate };
