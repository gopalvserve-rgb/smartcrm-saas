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

// SECURITY: This file ships PUBLIC defaults only. NEVER put secrets
// (SMTP passwords, API keys, access tokens, etc.) here — anything in
// this object lands in the public GitHub repo. Secrets must be entered
// once via the admin panel's Settings → Email / Payments page; they
// then persist in the saas_settings table inside the control DB.
//
// As an additional bootstrap path you can pre-load secrets via Railway
// env vars: any `process.env.<KEY>` set on the platform will be picked
// up the FIRST time saas_settings is empty for that key (see the
// fallback section below). This lets ops rotate secrets without
// committing them anywhere.
const DEFAULT_SETTINGS = {
  // Lifecycle
  INSTANCE_PENDING_DELETION_DAYS: '30',
  TRIAL_DAYS_DEFAULT: '7',
  // Brand / public copy
  PLATFORM_NAME: 'SmartCRM',
  PLATFORM_TAGLINE: 'The CRM your sales team will actually use',
  PLATFORM_HERO_SUBHEAD: 'Capture leads from Facebook, IndiaMart, Google Ads & your website. Auto-dial, AI call summaries, WhatsApp at scale, and follow-up reminders that never let a deal slip — all in one place.',
  PLATFORM_PRIMARY_COLOR: '#10b981',
  SUPPORT_EMAIL: 'support@smartcrmsolution.com',
  CASHFREE_MODE: process.env.CASHFREE_MODE || 'PROD',
  // Email — non-secret defaults only. Host/port/charset/protocol are
  // safe to ship publicly. SMTP_PASSWORD + SMTP_USERNAME + the from
  // address are loaded from env vars below if present, otherwise
  // admin enters them once via the Settings → Email panel.
  MAIL_PROTOCOL: 'SMTP',
  MAIL_ENCRYPTION: 'TLS',
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  MAIL_FROM_NAME: 'SmartCRM',
  MAIL_CHARSET: 'utf-8'
};

// Optional env-driven secrets — only seeded if the row is missing AND
// the env var is set, so we never accidentally overwrite a value the
// admin just typed in the panel.
const ENV_DRIVEN_SECRETS = [
  'SMTP_USERNAME', 'SMTP_PASSWORD', 'MAIL_FROM_EMAIL',
  'CASHFREE_APP_ID', 'CASHFREE_SECRET',
  'SENDGRID_API_KEY', 'RESEND_API_KEY'
];

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

  // Env-driven secrets — never logged, never committed. Only ever
  // sourced from process.env (Railway env vars) or the admin panel.
  for (const k of ENV_DRIVEN_SECRETS) {
    const v = process.env[k];
    if (!v) continue;
    const r = await control.query('SELECT 1 FROM saas_settings WHERE key = $1', [k]);
    if (r.rows.length) continue;   // never overwrite admin-entered values
    await control.setSetting(k, v);
    console.log('[seed-once] seeded ' + k + ' from env (value not logged)');
  }
  // CHANGELOG_v1 — ensure the changelog table exists AND backfill the
  // initial set of entries. Idempotent: we INSERT only when no row with
  // the same title exists, so adding more entries here in future deploys
  // just appends, never duplicates.
  try {
    await control.query(`
      CREATE TABLE IF NOT EXISTS changelog (
        id          SERIAL PRIMARY KEY,
        category    TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        link        TEXT,
        icon        TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_changelog_created  ON changelog(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_changelog_category ON changelog(category);
    `);
    const fs = require('fs');
    const path = require('path');
    const sqlPath = path.join(__dirname, '..', 'scripts', 'seed_changelog.sql');
    if (fs.existsSync(sqlPath)) {
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await control.query(sql);
      console.log('[seed-once] changelog backfill applied');
    }
  } catch (e) {
    console.warn('[seed-once] changelog seed skipped:', e.message);
  }
  console.log('[seed-once] done.');
};
