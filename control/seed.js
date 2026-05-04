/**
 * One-shot seed for the SaaS control plane.
 *   - Creates a default super-admin if none exists
 *   - Inserts the four published packages from smartcrmsolution.com
 *   - Sets sensible default saas_settings
 *
 * Idempotent: running this twice is safe — UPSERT-style behaviour
 * via "ON CONFLICT DO NOTHING" + presence checks.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const control = require('./db');

async function seedSuperAdmin() {
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@smartcrmsolution.com').toLowerCase();
  const exists = await control.findOneBy('super_admins', 'email', email);
  if (exists) { console.log('[seed] super_admin already exists:', email); return; }
  const password = process.env.SEED_ADMIN_PASSWORD || 'changeme-' + Math.random().toString(36).slice(2, 8);
  await control.insert('super_admins', {
    name: 'Super Admin',
    email,
    password_hash: bcrypt.hashSync(password, 10),
    role: 'admin',
    is_active: 1
  });
  console.log('[seed] created super_admin', email, '/ password:', password);
}

// All-modules CSV — every module the tenant CRM ships with.
// Plans on smartcrmsolution.com say "All 12 features included" so every
// plan gets the full module list. Differentiator is user count.
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

async function seedPackages() {
  for (const pkg of SEED_PACKAGES) {
    const existing = await control.findOneBy('packages', 'name', pkg.name);
    if (existing) { console.log('[seed] package exists:', pkg.name); continue; }
    await control.insert('packages', pkg);
    console.log('[seed] inserted package:', pkg.name, '₹' + pkg.base_price_inr);
  }
}

async function seedSettings() {
  const defaults = {
    INSTANCE_PENDING_DELETION_DAYS: '30',
    TRIAL_DAYS_DEFAULT: '7',
    PLATFORM_NAME: 'SmartCRM',
    PLATFORM_TAGLINE: 'The CRM your sales team will actually use',
    PLATFORM_HERO_SUBHEAD: 'Capture leads from Facebook, IndiaMart, Google Ads & your website. Auto-dial, AI call summaries, WhatsApp at scale, and follow-up reminders that never let a deal slip — all in one place.',
    PLATFORM_PRIMARY_COLOR: '#10b981',
    SUPPORT_EMAIL: 'support@smartcrmsolution.com',
    MAIL_PROVIDER: 'gmail',
    CASHFREE_MODE: 'PROD'
  };
  for (const [k, v] of Object.entries(defaults)) {
    const existing = await control.query('SELECT 1 FROM saas_settings WHERE key = $1', [k]);
    if (existing.rows.length) continue;
    await control.setSetting(k, v);
    console.log('[seed] set:', k, '=', v);
  }
}

(async () => {
  try {
    console.log('[seed] migrating control schema…');
    await control.migrate();
    await seedSuperAdmin();
    await seedPackages();
    await seedSettings();
    console.log('[seed] done.');
    process.exit(0);
  } catch (e) {
    console.error('[seed] failed:', e.message, e.stack);
    process.exit(1);
  }
})();
