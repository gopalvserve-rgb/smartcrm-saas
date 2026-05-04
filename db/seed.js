#!/usr/bin/env node
// Seed initial data: admin user, default statuses, default sources.
// Idempotent: safe to run multiple times.
//   npm run seed
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./pg');

const DEFAULT_STATUSES = [
  { name: 'New',         color: '#3b82f6', sort_order: 10,  is_final: 0 },
  { name: 'Contacted',   color: '#06b6d4', sort_order: 20,  is_final: 0 },
  { name: 'Qualified',   color: '#8b5cf6', sort_order: 30,  is_final: 0 },
  { name: 'Proposal',    color: '#f59e0b', sort_order: 40,  is_final: 0 },
  { name: 'Negotiation', color: '#ef4444', sort_order: 50,  is_final: 0 },
  { name: 'Won',         color: '#10b981', sort_order: 90,  is_final: 1 },
  { name: 'Lost',        color: '#6b7280', sort_order: 100, is_final: 1 }
];

const DEFAULT_SOURCES = [
  'Website', 'Facebook Lead Ad', 'Instagram Lead Ad', 'WhatsApp',
  'Referral', 'Cold Call', 'Walk-in', 'Other'
];

(async () => {
  try {
    // ---- Admin user ----
    const email    = process.env.SEED_ADMIN_EMAIL    || 'admin@crm.local';
    const password = process.env.SEED_ADMIN_PASSWORD || 'admin123';
    const name     = process.env.SEED_ADMIN_NAME     || 'Admin';

    const existing = await db.findOneBy('users', 'email', email);
    if (!existing) {
      const hash = bcrypt.hashSync(password, 10);
      await db.insert('users', {
        name, email, role: 'admin',
        password_hash: hash,
        is_active: 1,
        created_at: db.nowIso()
      });
      console.log(`✓ Admin user created: ${email} / ${password}`);
    } else {
      console.log(`• Admin user already exists (${email}) — skipping.`);
    }

    // ---- Statuses ----
    const existingStatuses = await db.getAll('statuses');
    if (existingStatuses.length === 0) {
      for (const s of DEFAULT_STATUSES) await db.insert('statuses', s);
      console.log(`✓ Inserted ${DEFAULT_STATUSES.length} default statuses.`);
    } else {
      console.log(`• Statuses already present (${existingStatuses.length}) — skipping.`);
    }

    // ---- Sources ----
    const existingSources = await db.getAll('sources');
    if (existingSources.length === 0) {
      for (const n of DEFAULT_SOURCES) await db.insert('sources', { name: n, is_active: 1 });
      console.log(`✓ Inserted ${DEFAULT_SOURCES.length} default sources.`);
    } else {
      console.log(`• Sources already present (${existingSources.length}) — skipping.`);
    }

    console.log('\nSeed complete.\n');
  } catch (e) {
    console.error('✗ Seed failed:', e);
    process.exitCode = 1;
  } finally {
    // Fire-and-forget pool.end() — don't let it block process exit.
    db.pool.end().catch(() => {});
    setImmediate(() => process.exit(process.exitCode || 0));
  }
})();
