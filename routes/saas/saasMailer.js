/**
 * Platform-level mailer for SaaS notifications (welcome emails, invoices,
 * password resets for the super-admin panel). Pulls credentials from
 * `saas_settings` so the admin can change them without a redeploy.
 *
 * Two providers supported:
 *   - Gmail   (SMTP via App Password)
 *   - SendGrid (SMTP relay using their API Key)
 *
 * `MAIL_PROVIDER` setting picks which one. If neither is configured,
 * sendMail() throws — wrap callers in try/catch.
 *
 * The existing utils/mailer.js is the TENANT mailer (used inside each
 * tenant's CRM for their lead/customer emails). This one is purely for
 * the SaaS control plane. Keeping them separate means a tenant's SMTP
 * misconfiguration can't break our welcome emails and vice versa.
 */
const nodemailer = require('nodemailer');
const control = require('../../control/db');

let _transporter = null;
let _key = null;

async function _getTransporter() {
  const provider = (await control.getSetting('MAIL_PROVIDER', 'gmail')).toLowerCase();
  let cfg;
  if (provider === 'sendgrid') {
    cfg = {
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: false,
      auth: { user: 'apikey', pass: await control.getSetting('SENDGRID_API_KEY', '') },
      from: await control.getSetting('MAIL_FROM', 'no-reply@smartcrmsolution.com')
    };
    if (!cfg.auth.pass) throw new Error('SendGrid API key not configured (Settings → Email)');
  } else {
    cfg = {
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: await control.getSetting('GMAIL_USER', ''),
        pass: await control.getSetting('GMAIL_APP_PASSWORD', '')
      }
    };
    cfg.from = (await control.getSetting('MAIL_FROM', '')) || cfg.auth.user;
    if (!cfg.auth.user || !cfg.auth.pass) throw new Error('Gmail credentials not configured (Settings → Email)');
  }
  const key = JSON.stringify({ provider, host: cfg.host, user: cfg.auth.user, from: cfg.from });
  if (_transporter && _key === key) return { transporter: _transporter, from: cfg.from };
  _transporter = nodemailer.createTransport(cfg);
  _key = key;
  return { transporter: _transporter, from: cfg.from };
}

async function sendMail({ to, subject, html, text }) {
  const { transporter, from } = await _getTransporter();
  return transporter.sendMail({
    from, to, subject,
    html: html || undefined,
    text: text || (html ? html.replace(/<[^>]+>/g, '') : '')
  });
}

/** Force a fresh transporter on next call. */
function invalidate() { _transporter = null; _key = null; }

module.exports = { sendMail, invalidate };
