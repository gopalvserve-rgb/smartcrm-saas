/**
 * routes/setup.js — runs schema.sql + seeds defaults without shell access.
 * Called by server.js at POST /setup.
 *
 * Guard: only runs if ?key=$SETUP_KEY matches, or if no users exist yet
 * (first-run idempotence).
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../db/pg');

async function run(requestKey) {
  const setupKey = process.env.SETUP_KEY || '';
  const users = await _safeGetAll('users');
  const firstRun = !users || users.length === 0;

  if (!firstRun && setupKey && requestKey !== setupKey) {
    throw new Error('SETUP_KEY required once users exist');
  }

  // 1. Apply schema
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.query(sql);

  // 2. Seed admin + statuses + sources if tables empty
  const adminEmail = process.env.SEED_ADMIN_EMAIL    || 'admin@crm.local';
  const adminPass  = process.env.SEED_ADMIN_PASSWORD || 'admin123';
  const adminName  = process.env.SEED_ADMIN_NAME     || 'Admin';

  const existingAdmin = await db.findOneBy('users', 'email', adminEmail);
  if (!existingAdmin) {
    await db.insert('users', {
      name: adminName, email: adminEmail, role: 'admin',
      password_hash: bcrypt.hashSync(adminPass, 10),
      is_active: 1, created_at: db.nowIso()
    });
  }

  const statusCount = (await db.getAll('statuses')).length;
  if (statusCount === 0) {
    const defaults = [
      { name: 'New',         color: '#3b82f6', sort_order: 10,  is_final: 0 },
      { name: 'Contacted',   color: '#06b6d4', sort_order: 20,  is_final: 0 },
      { name: 'Qualified',   color: '#8b5cf6', sort_order: 30,  is_final: 0 },
      { name: 'Proposal',    color: '#f59e0b', sort_order: 40,  is_final: 0 },
      { name: 'Negotiation', color: '#ef4444', sort_order: 50,  is_final: 0 },
      { name: 'Won',         color: '#10b981', sort_order: 90,  is_final: 1 },
      { name: 'Lost',        color: '#6b7280', sort_order: 100, is_final: 1 }
    ];
    for (const s of defaults) await db.insert('statuses', s);
  }

  const sourceCount = (await db.getAll('sources')).length;
  if (sourceCount === 0) {
    const defaults = ['Website', 'Facebook Lead Ad', 'Instagram Lead Ad',
                      'WhatsApp', 'Referral', 'Cold Call', 'Walk-in', 'Other'];
    for (const n of defaults) await db.insert('sources', { name: n, is_active: 1 });
  }

  return {
    ok: true,
    first_run: firstRun,
    admin_email: adminEmail,
    admin_password: firstRun ? adminPass : '(unchanged)',
    message: firstRun
      ? 'First-time setup complete. Log in with the admin credentials above, then change the password.'
      : 'Schema refreshed. Existing data preserved.'
  };
}

async function _safeGetAll(table) {
  try { return await db.getAll(table); }
  catch (_) { return []; }
}

module.exports = { run };
