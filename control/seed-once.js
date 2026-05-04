/**
 * In-process variant of seed.js — exported as a function so server.js
 * can call it on first boot when no super_admin exists. Idempotent.
 *
 * The standalone `npm run seed:control` (control/seed.js) calls
 * process.exit() at the end, which we don't want in-process; this file
 * does the same work but returns a Promise.
 */
const bcrypt = require('bcryptjs');
const control = require('./db');

const ALL_MODULES = [
  'leads', 'pipeline', 'kanban', 'followups', 'calendar', 'targets',
  'newleads', 'overdue', 'duetoday', 'upcoming',
  'dialer', 'callinsights', 'callratings', 'aiusage',
  'inventory', 'projects',
  'reports', 'reportbuilder', 'tatreport',
  'whatsbot', 'knowledge', 'teamchat',
  'tasks', 'attendance', 'leaves', 'salary', 'bank',
  'customers', 'custreports'
].join(',');

const SEED_PACKAGES = [
  {
    name: 'Starter',
    description: '<p>3 users · all 12 features · auto dialer · 15+ lead integrations · email support</p>',
    base_price_inr: 7999,
    recurring_period: 'quarter', recurring_period_count: 1,
    tax_percent: 18, modules: ALL_MODULES,
    quotas: JSON.stringify({ users: { limit: 3, extra_inr: 0 } }),
    sort_order: 1, is_enabled: 1
  },
  {
    name: 'Growth',
    description: '<p>5 users · everything in Starter · bulk WhatsApp engine · priority chat support</p>',
    base_price_inr: 11999,
    recurring_period: 'quarter', recurring_period_count: 1,
    tax_percent: 18, modules: ALL_MODULES,
    quotas: JSON.stringify({ users: { limit: 5, extra_inr: 0 } }),
    is_most_popular: 1, sort_order: 2, is_enabled: 1
  },
  {
    name: 'Pro',
    description: '<p>7 users · everything in Growth · advanced automations · dedicated success manager · custom pipeline setup</p>',
    base_price_inr: 15999,
    recurring_period: 'quarter', recurring_period_count: 1,
    tax_percent: 18, modules: ALL_MODULES,
    quotas: JSON.stringify({ users: { limit: 7, extra_inr: 0 } }),
    sort_order: 3, is_enabled: 1
  },
  {
    name: 'Business',
    description: '<p>10 users · everything in Pro · custom integrations · API access &amp; webhooks · quarterly reviews</p>',
    base_price_inr: 22999,
    recurring_period: 'quarter', recurring_period_count: 1,
    tax_percent: 18, modules: ALL_MODULES,
    quotas: JSON.stringify({ users: { limit: 10, extra_inr: 0 } }),
    sort_order: 4, is_enabled: 1
  }
];

const DEFAULT_SETTINGS = {
  INSTANCE_PENDING_DELETION_DAYS: '30',
  TRIAL_DAYS_DEFAULT: '7',
  PLATFORM_NAME: 'SmartCRM',
  PLATFORM_TAGLINE: 'The CRM your sales team will actually use',
  PLATFORM_HERO_SUBHEAD: 'Capture leads from Facebook, IndiaMart, Google Ads & your website. Auto-dial, AI call summaries, WhatsApp at scale, and follow-up reminders that never let a deal slip — all in one place.',
  PLATFORM_PRIMARY_COLOR: '#10b981',
  SUPPORT_EMAIL: 'support@smartcrmsolution.com',
  MAIL_PROVIDER: 'gmail',
  CASHFREE_MODE: process.env.CASHFREE_MODE || 'PROD'
};

module.exports = async function seedOnce() {
  // Super-admin (only if none exists)
  const cnt = await control.query('SELECT COUNT(*)::int AS c FROM super_admins');
  if (cnt.rows[0].c === 0) {
    const email = (process.env.SEED_ADMIN_EMAIL || 'admin@smartcrmsolution.com').toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD || 'changeme-' + Math.random().toString(36).slice(2, 10);
    await control.insert('super_admins', {
      name: 'Super Admin', email,
      password_hash: bcrypt.hashSync(password, 10),
      role: 'admin', is_active: 1
    });
    console.log('[seed-once] created super_admin', email);
    if (!process.env.SEED_ADMIN_PASSWORD) {
      console.log('[seed-once] generated password (set SEED_ADMIN_PASSWORD env to control):', password);
    }
  }

  // Packages (skip ones that already exist by name)
  for (const pkg of SEED_PACKAGES) {
    const existing = await control.findOneBy('packages', 'name', pkg.name);
    if (existing) continue;
    await control.insert('packages', pkg);
    console.log('[seed-once] inserted package', pkg.name);
  }

  // Default settings (only if not yet set)
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    const r = await control.query('SELECT 1 FROM saas_settings WHERE key = $1', [k]);
    if (r.rows.length) continue;
    await control.setSetting(k, v);
  }
  console.log('[seed-once] done.');
};
