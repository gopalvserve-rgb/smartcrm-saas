/**
 * Tenant provisioning — turn a paid signup into a working tenant.
 *
 *   1. CREATE DATABASE tenant_<slug>  (on the same Postgres cluster)
 *   2. Run the CRM schema (../../db/schema.sql) on the new DB
 *   3. Seed a default admin user with a one-time password
 *   4. Insert a row into the control-plane `tenants` table
 *   5. Generate the first invoice + mark payment paid
 *   6. Email credentials to the customer
 *
 * Idempotent: if called twice for the same signup, the second call sees
 * status='provisioned' and just returns the existing tenant slug.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const control = require('../../control/db');
const mailer = require('./saasMailer');
const { seedTenantKnowledgeBase } = require('./kbSeed');

function _adminPasswordFromEmail(email) {
  // Stable but unique-per-account starting password. The tenant admin
  // is shown this once + asked to change on first login (later phase).
  // Keep this readable — they need to type it on a phone keypad.
  const tail = require('crypto').randomBytes(4).toString('hex');
  return 'scrm-' + tail;
}

async function _provisionDb(dbName) {
  // Connect to the cluster on the postgres bookkeeping DB so we can
  // CREATE DATABASE — you can't CREATE DATABASE while connected to
  // the database you're creating.
  const baseUrl = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  const u = new URL(baseUrl);
  u.pathname = '/postgres';
  const sysPool = new Pool({
    connectionString: u.toString(),
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(baseUrl) ? { rejectUnauthorized: false } : false,
    max: 1
  });
  try {
    // CREATE DATABASE doesn't accept parameters — we must validate the
    // identifier ourselves to avoid SQL injection.
    if (!/^[a-z][a-z0-9_]{1,62}$/.test(dbName)) throw new Error('Invalid db name: ' + dbName);
    await sysPool.query(`CREATE DATABASE "${dbName}"`);
  } catch (e) {
    // If the DB already exists (e.g. retry after partial failure) we
    // tolerate it and continue to schema migration.
    if (!/already exists/i.test(e.message)) throw e;
  } finally {
    try { await sysPool.end(); } catch (_) {}
  }
}

async function _migrateTenantDb(dbName) {
  const baseUrl = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  const u = new URL(baseUrl);
  u.pathname = '/' + dbName;
  const tPool = new Pool({
    connectionString: u.toString(),
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(baseUrl) ? { rejectUnauthorized: false } : false,
    max: 1
  });
  try {
    const sqlPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await tPool.query(sql);
  } finally {
    try { await tPool.end(); } catch (_) {}
  }
}


// GENERIC_DEFAULTS_v1 (2026-05-21) — seed every NEW tenant with a
// sensible set of statuses + tags so the SPA isn't empty on day 1.
// Idempotent: skip if any rows already exist.
async function _seedTenantDefaults(dbName) {
  const baseUrl = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  const u = new URL(baseUrl);
  u.pathname = '/' + dbName;
  const tPool = new Pool({
    connectionString: u.toString(),
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(baseUrl) ? { rejectUnauthorized: false } : false,
    max: 1
  });
  try {
    // Statuses — only insert if statuses table is empty (don't override a
    // pack installer that ran first OR a tenant who's already configured).
    const st = await tPool.query('SELECT COUNT(*)::int AS c FROM statuses').catch(() => ({ rows: [{ c: 1 }] }));
    if (Number(st.rows[0].c) === 0) {
      const defaults = [
        { name: 'New',            color: '#3b82f6', sort_order: 10  },
        { name: 'Follow Up',      color: '#f59e0b', sort_order: 20  },
        { name: 'Not Pick',       color: '#a855f7', sort_order: 30  },
        { name: 'Not Interested', color: '#ef4444', sort_order: 40  },
        { name: 'Junk',           color: '#6b7280', sort_order: 50  }
      ];
      for (const s of defaults) {
        try {
          await tPool.query(
            'INSERT INTO statuses (name, color, sort_order, is_final) VALUES ($1, $2, $3, 0)',
            [s.name, s.color, s.sort_order]
          );
        } catch (e) { /* swallow individual insert failures */ }
      }
      console.log('[provisioning] seeded ' + defaults.length + ' default statuses for ' + dbName);
    }

    // Tags — only insert if tag_library is empty
    try {
      const tg = await tPool.query('SELECT COUNT(*)::int AS c FROM tag_library');
      if (Number(tg.rows[0].c) === 0) {
        const tags = [
          { name: 'hot',  color: '#ef4444' },
          { name: 'warm', color: '#f59e0b' },
          { name: 'cold', color: '#3b82f6' }
        ];
        for (const t of tags) {
          try {
            await tPool.query(
              'INSERT INTO tag_library (name, color, is_active) VALUES ($1, $2, 1) ON CONFLICT (name) DO NOTHING',
              [t.name, t.color]
            );
          } catch (e) { /* tag_library may not exist on very-old tenants */ }
        }
        console.log('[provisioning] seeded ' + tags.length + ' default tags for ' + dbName);
      }
    } catch (e) { console.warn('[provisioning] tag seed skipped for ' + dbName + ':', e.message); }
  } finally {
    try { await tPool.end(); } catch (_) {}
  }
}

async function _seedTenantAdmin(dbName, signup) {
  const baseUrl = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  const u = new URL(baseUrl);
  u.pathname = '/' + dbName;
  const tPool = new Pool({
    connectionString: u.toString(),
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(baseUrl) ? { rejectUnauthorized: false } : false,
    max: 1
  });
  try {
    const password = _adminPasswordFromEmail(signup.email);
    const hash = bcrypt.hashSync(password, 10);
    const ins = await tPool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at)
       VALUES ($1, $2, $3, 'admin', 1, NOW())
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [signup.name, signup.email, hash]
    );
    const adminUserId = ins.rows && ins.rows[0] ? Number(ins.rows[0].id) : 1;

    // Seed the knowledge base with starter how-to articles. Best-effort
    // — a seed failure shouldn't block provisioning, the operator can
    // always re-run from /admin → "Re-seed help articles" later.
    try {
      const n = await seedTenantKnowledgeBase(tPool, { adminUserId });
      console.log('[provisioning] seeded ' + n + ' KB articles for ' + dbName);
    } catch (e) {
      console.warn('[provisioning] KB seed failed for ' + dbName + ':', e.message);
    }

    return password;
  } finally {
    try { await tPool.end(); } catch (_) {}
  }
}

async function _nextInvoiceNumber() {
  const r = await control.query(`SELECT COUNT(*) AS c FROM invoices`);
  const n = Number(r.rows[0].c) + 1;
  const yr = new Date().getFullYear();
  return `INV-${yr}-${String(n).padStart(6, '0')}`;
}

async function provisionFromSignup(signupId) {
  const signup = await control.findById('signups', signupId);
  if (!signup) throw new Error('Signup not found: ' + signupId);

  // Idempotency
  if (signup.status === 'provisioned') {
    const existing = await control.findOneBy('tenants', 'slug', signup.desired_slug);
    if (existing) {
      return { tenant_id: existing.id, slug: existing.slug, db_name: existing.db_name, alreadyProvisioned: true };
    }
  }

  const pkg = await control.findById('packages', signup.package_id);
  if (!pkg) throw new Error('Package missing: ' + signup.package_id);

  const slug = signup.desired_slug;
  const dbName = 'tenant_' + slug.replace(/-/g, '_');

  // 1. DB
  await _provisionDb(dbName);
  // 2. Schema
  await _migrateTenantDb(dbName);
  // 2a. Default statuses + tags (GENERIC_DEFAULTS_v1)
  try { await _seedTenantDefaults(dbName); } catch (e) { console.warn('[provisioning] defaults seed failed:', e.message); }
  // 3. Admin user
  const oneTimePassword = await _seedTenantAdmin(dbName, signup);

  // 4. Tenants row
  // BILL_OVERRIDES_v1 (2026-05-23) - honour optional start_date / end_date /
  // amount overrides stashed in signups.metadata by super-admin createManual.
  // This lets the operator backdate a tenant ("start = last Monday"), set a
  // bespoke amount different from the package list price, or extend validity
  // beyond the default cycle (e.g. promotional 14-month yearly plan).
  let _meta = {};
  try { _meta = typeof signup.metadata === 'string' ? JSON.parse(signup.metadata) : (signup.metadata || {}); } catch (_) { _meta = {}; }
  const _now = new Date();
  const now = (_meta.start_date_override && !isNaN(new Date(_meta.start_date_override).getTime()))
    ? new Date(_meta.start_date_override) : _now;
  const periodEnd = (_meta.end_date_override && !isNaN(new Date(_meta.end_date_override).getTime()))
    ? new Date(_meta.end_date_override) : _computePeriodEnd(now, pkg);
  let tenantId;
  const existing = await control.findOneBy('tenants', 'slug', slug);
  if (existing) {
    tenantId = existing.id;
    await control.update('tenants', tenantId, {
      package_id: pkg.id,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString()
    });
  } else {
    tenantId = await control.insert('tenants', {
      slug, org_name: signup.org_name || signup.name,
      contact_name: signup.name, contact_email: signup.email, contact_mobile: signup.mobile,
      db_name: dbName, package_id: pkg.id,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString()
    });
  }

  // 5. First invoice + mark paid
  // BILL_OVERRIDES_v1 - use amount_override when super-admin entered a custom price.
  const total = (_meta.amount_override != null && !isNaN(Number(_meta.amount_override)))
    ? Number(_meta.amount_override)
    : (Number(pkg.base_price_inr) || 0);
  const tax = Math.round((total * Number(pkg.tax_percent || 0) / 100) * 100) / 100;
  const grand = Math.round((total + tax) * 100) / 100;
  const invNumber = await _nextInvoiceNumber();
  const invoiceId = await control.insert('invoices', {
    tenant_id: tenantId,
    number: invNumber,
    package_id: pkg.id,
    description: pkg.name + ' — ' + (pkg.recurring_period_count || 1) + ' ' + pkg.recurring_period,
    subtotal_inr: total, tax_inr: tax, total_inr: grand,
    period_start: now.toISOString(), period_end: periodEnd.toISOString(),
    status: grand <= 0 ? 'paid' : 'pending',  // free plans auto-paid
    paid_at: grand <= 0 ? now.toISOString() : null
  });

  // 6. Mark signup provisioned
  await control.update('signups', signup.id, { status: 'provisioned' });

  // 7. Audit
  await control.insert('audit_log', {
    actor_type: 'system', tenant_id: tenantId, event: 'tenant.provisioned',
    detail: JSON.stringify({ slug, package: pkg.name, invoice: invNumber })
  });

  // 8. Email credentials (best-effort)
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const loginUrl = baseUrl + '/t/' + slug;
  try {
    await mailer.sendMail({
      to: signup.email,
      subject: '🎉 Your SmartCRM is ready — login details inside',
      html: _welcomeEmailHtml({
        name: signup.name, orgName: signup.org_name || signup.name,
        loginUrl, email: signup.email, password: oneTimePassword,
        packageName: pkg.name
      })
    });
  } catch (e) { console.warn('[provisioning] welcome email failed:', e.message); }

  return {
    tenant_id: tenantId, slug, db_name: dbName, invoice_id: invoiceId,
    login_url: loginUrl, email: signup.email, password: oneTimePassword
  };
}

function _computePeriodEnd(start, pkg) {
  const d = new Date(start);
  if (Number(pkg.is_lifetime) === 1) {
    d.setFullYear(d.getFullYear() + 99);
    return d;
  }
  const count = Number(pkg.recurring_period_count) || 1;
  const period = String(pkg.recurring_period || 'month').toLowerCase();
  if (period === 'year')      d.setFullYear(d.getFullYear() + count);
  else if (period === 'quarter') d.setMonth(d.getMonth() + (3 * count));
  else if (period === 'week')    d.setDate(d.getDate() + (7 * count));
  else                        d.setMonth(d.getMonth() + count);   // month default
  return d;
}

function _welcomeEmailHtml({ name, orgName, loginUrl, email, password, packageName }) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:1.5rem;color:#0f172a">
    <h2 style="margin:0 0 1rem 0">Welcome to SmartCRM, ${escape(name)} 🎉</h2>
    <p>Your <b>${escape(packageName)}</b> account for <b>${escape(orgName)}</b> is live and ready.</p>
    <div style="background:#f1f5f9;padding:1rem;border-radius:8px;margin:1.25rem 0">
      <div style="font-size:.85rem;color:#475569;margin-bottom:.4rem">Login URL</div>
      <a href="${loginUrl}" style="color:#4338ca;font-weight:600">${loginUrl}</a>
      <div style="font-size:.85rem;color:#475569;margin-top:1rem;margin-bottom:.4rem">Email</div>
      <code style="background:#fff;padding:.3rem .6rem;border-radius:4px">${escape(email)}</code>
      <div style="font-size:.85rem;color:#475569;margin-top:1rem;margin-bottom:.4rem">Temporary password</div>
      <code style="background:#fff;padding:.3rem .6rem;border-radius:4px">${escape(password)}</code>
    </div>
    <p style="font-size:.9rem;color:#475569">For your security, please change this password the first time you log in (Settings → Security).</p>
    <p style="font-size:.85rem;color:#94a3b8;margin-top:2rem">— The SmartCRM team</p>
  </div>`;
}

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

module.exports = { provisionFromSignup };
