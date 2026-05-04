/**
 * Platform-wide settings (key/value).
 *
 * Whitelist what's settable from the admin panel — never let arbitrary
 * keys through, since saas_settings is read by sensitive code (Cashfree
 * creds, JWT secret, etc.). Read is also whitelisted: we never expose
 * secret values to the client (passwords/keys come back as "***").
 *
 * The keys group naturally:
 *   - PAYMENTS  : CASHFREE_*
 *   - EMAIL     : MAIL_PROVIDER, GMAIL_*, SENDGRID_API_KEY, MAIL_FROM
 *   - LIFECYCLE : INSTANCE_PENDING_DELETION_DAYS, TRIAL_DAYS_DEFAULT
 *   - BRAND     : PLATFORM_NAME, PLATFORM_TAGLINE, PLATFORM_LOGO_URL,
 *                 PLATFORM_PRIMARY_COLOR, SUPPORT_EMAIL, SUPPORT_PHONE
 *
 * Each key carries a `mask` flag so the GET response can either reveal
 * the value (e.g. PLATFORM_NAME) or replace it with "***" (e.g.
 * CASHFREE_SECRET) — the UI then shows a "Set new value" input that's
 * empty by default.
 */
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');
const saasMailer = require('./saasMailer');

const SETTING_KEYS = [
  // Payments
  { key: 'CASHFREE_APP_ID',    group: 'payments',  label: 'Cashfree App ID',         mask: false },
  { key: 'CASHFREE_SECRET',    group: 'payments',  label: 'Cashfree Secret Key',     mask: true  },
  { key: 'CASHFREE_MODE',      group: 'payments',  label: 'Mode (PROD or TEST)',     mask: false },
  // Email
  { key: 'MAIL_PROVIDER',      group: 'email',     label: 'Provider (gmail or sendgrid)', mask: false },
  { key: 'GMAIL_USER',         group: 'email',     label: 'Gmail address',           mask: false },
  { key: 'GMAIL_APP_PASSWORD', group: 'email',     label: 'Gmail App Password',      mask: true  },
  { key: 'SENDGRID_API_KEY',   group: 'email',     label: 'SendGrid API key',        mask: true  },
  { key: 'MAIL_FROM',          group: 'email',     label: 'From address',            mask: false },
  // Lifecycle
  { key: 'INSTANCE_PENDING_DELETION_DAYS', group: 'lifecycle', label: 'Pending-delete window (days)', mask: false },
  { key: 'TRIAL_DAYS_DEFAULT', group: 'lifecycle', label: 'Default trial days',      mask: false },
  // Brand
  { key: 'PLATFORM_NAME',         group: 'brand',  label: 'Platform name',           mask: false },
  { key: 'PLATFORM_TAGLINE',      group: 'brand',  label: 'Tagline (1 line)',        mask: false },
  { key: 'PLATFORM_HERO_SUBHEAD', group: 'brand',  label: 'Hero subheading (2-3 lines)', mask: false },
  { key: 'PLATFORM_LOGO_URL',     group: 'brand',  label: 'Logo URL',                mask: false },
  { key: 'PLATFORM_PRIMARY_COLOR',group: 'brand',  label: 'Primary brand color',     mask: false },
  { key: 'SUPPORT_EMAIL',         group: 'brand',  label: 'Support email',           mask: false },
  { key: 'SUPPORT_PHONE',         group: 'brand',  label: 'Support phone',           mask: false }
];

async function api_saas_settings_get(token) {
  await requireFullAdmin(token);
  const r = await control.query(`SELECT key, value FROM saas_settings`);
  const stored = {};
  r.rows.forEach(x => { stored[x.key] = x.value; });
  return SETTING_KEYS.map(s => ({
    key: s.key, group: s.group, label: s.label, mask: s.mask,
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
    // For masked fields, treat empty / "***" / unchanged as "don't update"
    const meta = SETTING_KEYS.find(s => s.key === key);
    if (meta.mask && (!val || val === '***')) continue;
    await control.setSetting(key, val == null ? '' : String(val));
    changed++;
  }
  // Mailer caches its transporter — invalidate so the next email picks up new creds
  if (Object.keys(p).some(k => k.startsWith('MAIL_') || k.startsWith('GMAIL_') || k === 'SENDGRID_API_KEY')) {
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
    to, subject: '✅ SmartCRM SaaS test email',
    html: `<p>Hi ${me.name},</p><p>This is a test from your SmartCRM admin panel — your SMTP credentials are working.</p>`
  });
  return { ok: true, sent_to: to };
}

module.exports = {
  api_saas_settings_get,
  api_saas_settings_save,
  api_saas_settings_testEmail
};
