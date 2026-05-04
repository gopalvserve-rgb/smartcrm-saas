/**
 * Platform-wide settings (key/value).
 *
 * Whitelist what's settable from the admin panel — never let arbitrary
 * keys through, since saas_settings is read by sensitive code (Cashfree
 * creds, JWT secret, etc.).
 *
 * Each key carries:
 *   - group : payments | email | lifecycle | brand
 *   - label : human-readable name shown in the UI
 *   - mask  : if true, the GET response replaces the value with "***"
 *             so secrets never leave the server (the UI shows an empty
 *             input with placeholder "Set new value to change")
 *   - kind  : text (default) | number | password | select | textarea
 *   - options : for select fields
 *   - hint  : small grey help text under the input
 */
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');
const saasMailer = require('./saasMailer');

const SETTING_KEYS = [
  // ---------- Payments (Cashfree) ----------
  { key: 'CASHFREE_APP_ID',    group: 'payments',  label: 'Cashfree App ID',          mask: false },
  { key: 'CASHFREE_SECRET',    group: 'payments',  label: 'Cashfree Secret Key',      mask: true  },
  { key: 'CASHFREE_MODE',      group: 'payments',  label: 'Mode',                      mask: false,
    kind: 'select', options: ['PROD', 'TEST'] },

  // ---------- Email (Perfex-style: Protocol → Encryption → Host → Port → From → Auth → Charset → BCC → Signature) ----------
  { key: 'MAIL_PROTOCOL',      group: 'email',     label: 'Email Protocol',            mask: false,
    kind: 'select', options: ['SMTP'], hint: 'SMTP only for now (OAuth + Sendmail variants planned).' },
  { key: 'MAIL_ENCRYPTION',    group: 'email',     label: 'Email Encryption',          mask: false,
    kind: 'select', options: ['TLS', 'SSL', 'none'] },
  { key: 'SMTP_HOST',          group: 'email',     label: 'SMTP Host',                 mask: false,
    hint: 'e.g. smtp.gmail.com / smtp.sendgrid.net / smtp-mail.outlook.com' },
  { key: 'SMTP_PORT',          group: 'email',     label: 'SMTP Port',                 mask: false,
    kind: 'number', hint: '587 for TLS · 465 for SSL · 25 for none' },
  { key: 'MAIL_FROM_EMAIL',    group: 'email',     label: 'Email (from address)',      mask: false },
  { key: 'MAIL_FROM_NAME',     group: 'email',     label: 'From name',                 mask: false,
    hint: 'Shown in the recipient\'s inbox, e.g. "SmartCRM"' },
  { key: 'SMTP_USERNAME',      group: 'email',     label: 'SMTP Username',             mask: false,
    hint: 'For Gmail, this is the same as your Google address.' },
  { key: 'SMTP_PASSWORD',      group: 'email',     label: 'SMTP Password',             mask: true,
    hint: 'For Gmail, generate an App Password at myaccount.google.com/apppasswords (16 chars).' },
  { key: 'MAIL_CHARSET',       group: 'email',     label: 'Email Charset',             mask: false },
  { key: 'MAIL_BCC',           group: 'email',     label: 'BCC All Emails To',         mask: false,
    hint: 'Comma-separated list of email addresses to silently copy on every outgoing email.' },
  { key: 'MAIL_SIGNATURE',     group: 'email',     label: 'Email Signature',           mask: false,
    kind: 'textarea', hint: 'HTML appended to the bottom of every outgoing email.' },

  // ---------- Lifecycle ----------
  { key: 'INSTANCE_PENDING_DELETION_DAYS', group: 'lifecycle', label: 'Pending-delete window (days)', mask: false, kind: 'number' },
  { key: 'TRIAL_DAYS_DEFAULT', group: 'lifecycle', label: 'Default trial days',        mask: false, kind: 'number' },

  // ---------- Brand ----------
  { key: 'PLATFORM_NAME',         group: 'brand',  label: 'Platform name',             mask: false },
  { key: 'PLATFORM_TAGLINE',      group: 'brand',  label: 'Tagline (1 line)',          mask: false },
  { key: 'PLATFORM_HERO_SUBHEAD', group: 'brand',  label: 'Hero subheading',           mask: false, kind: 'textarea' },
  { key: 'PLATFORM_LOGO_URL',     group: 'brand',  label: 'Logo URL',                  mask: false },
  { key: 'PLATFORM_PRIMARY_COLOR',group: 'brand',  label: 'Primary brand color',       mask: false },
  { key: 'SUPPORT_EMAIL',         group: 'brand',  label: 'Support email',             mask: false },
  { key: 'SUPPORT_PHONE',         group: 'brand',  label: 'Support phone',             mask: false }
];

async function api_saas_settings_get(token) {
  await requireFullAdmin(token);
  const r = await control.query(`SELECT key, value FROM saas_settings`);
  const stored = {};
  r.rows.forEach(x => { stored[x.key] = x.value; });
  return SETTING_KEYS.map(s => ({
    key: s.key, group: s.group, label: s.label, mask: !!s.mask,
    kind: s.kind || 'text',
    options: s.options || null,
    hint: s.hint || null,
    value: s.mask ? (stored[s.key] ? '***' : '') : (stored[s.key] || ''),
    is_set: !!stored[s.key]
  }));
}

async function api_saas_settings_save(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  const allowed = new Set(SETTING_KEYS.map(s => s.key));
  let changed = 0;
  for (const [key, val] of Object.entries(p)) {
    if (!allowed.has(key)) continue;
    const meta = SETTING_KEYS.find(s => s.key === key);
    // For masked fields, treat empty / "***" as "don't update"
    if (meta.mask && (!val || val === '***')) continue;
    await control.setSetting(key, val == null ? '' : String(val));
    changed++;
  }
  // Reset the mailer transporter so the next email picks up fresh creds
  if (Object.keys(p).some(k => k.startsWith('MAIL_') || k.startsWith('SMTP_'))) {
    try { saasMailer.invalidate(); } catch (_) {}
  }
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'settings.saved', detail: JSON.stringify({ keys: Object.keys(p) })
  });
  return { ok: true, changed };
}

/** Test the SMTP config by sending a one-off email to the requester. */
async function api_saas_settings_testEmail(token, payload) {
  const me = await requireFullAdmin(token);
  const to = (payload && payload.to) || me.email;
  await saasMailer.sendMail({
    to, subject: '✅ SmartCRM SaaS — SMTP test',
    html: `<p>Hi ${me.name},</p><p>This is a test email from your SmartCRM admin panel — your SMTP credentials are working correctly. 🎉</p><p style="font-size:.85rem;color:#64748b">If you're seeing this, signups will receive their welcome emails.</p>`
  });
  return { ok: true, sent_to: to };
}

module.exports = {
  api_saas_settings_get,
  api_saas_settings_save,
  api_saas_settings_testEmail
};
