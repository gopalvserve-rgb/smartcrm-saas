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
    // SIGNUP_FIX_v1 (2026-06-26) — normalise email to lowercase+trim so the
    // login lookup (routes/auth.js does .toLowerCase().trim()) actually finds
    // the user row. Without this, signups submitted with mixed-case emails
    // (e.g. 'Apna@Gmail.com') failed login forever.
    const cleanEmail = String(signup.email || '').toLowerCase().trim();
    const password = _adminPasswordFromEmail(signup.email);
    const hash = bcrypt.hashSync(password, 10);
    const ins = await tPool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, created_at)
       VALUES ($1, $2, $3, 'admin', 1, NOW())
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [signup.name, cleanEmail, hash]
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

  // SR_PKG_COERCE_v1 — guard empty/invalid package_id (integer col) so a
  // request approved without a package gives a clear message, not a raw
  // 'invalid input syntax for type integer' Postgres error.
  // SIGNUP_NOPACKAGE_v1 — package is OPTIONAL now (period from tenure, amount
  // from the custom total entered in the review form when no package chosen).
  const _pkgId = Number(signup.package_id);
  const pkg = _pkgId ? await control.findById('packages', _pkgId) : null;

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
  function _tenureEnd(start, tenure) {
    const d = new Date(start);
    const map = { month:1, quarter:3, half_year:6, year:12, '2year':24, '3year':36 };
    d.setMonth(d.getMonth() + (map[String(tenure||'').toLowerCase()] || 1));
    return d;
  }
  const _now = new Date();
  const now = (_meta.start_date_override && !isNaN(new Date(_meta.start_date_override).getTime()))
    ? new Date(_meta.start_date_override) : _now;
  const periodEnd = (_meta.end_date_override && !isNaN(new Date(_meta.end_date_override).getTime()))
    ? new Date(_meta.end_date_override)
    : (pkg ? _computePeriodEnd(now, pkg) : _tenureEnd(now, _meta.desired_tenure));
  // SIGNUP_TXN_v1 — amounts (GST-inclusive custom total preferred) + txn snapshot.
  const _bnum = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
  const _bMetaTotal = _bnum(_meta.total_amount_inr) != null ? _bnum(_meta.total_amount_inr) : _bnum(_meta.amount_override);
  let _bGrand, _bTax, _bSub;
  if (_bMetaTotal != null) { _bGrand=_bMetaTotal; _bTax=_bnum(_meta.gst_amount_inr)!=null?_bnum(_meta.gst_amount_inr):0; _bSub=_bnum(_meta.sale_amount_inr)!=null?_bnum(_meta.sale_amount_inr):Math.max(0,_bGrand-_bTax); }
  else if (pkg) { _bSub=Number(pkg.base_price_inr)||0; _bTax=Math.round((_bSub*Number(pkg.tax_percent||0)/100)*100)/100; _bGrand=Math.round((_bSub+_bTax)*100)/100; }
  else { _bSub=0; _bTax=0; _bGrand=0; }
  const _fullyPaid = String(_meta.payment_status||'').toLowerCase()==='fully_paid';
  const _invPaid = _fullyPaid || _bGrand <= 0;
  const _txnDate = (_meta.transaction_date && !isNaN(new Date(_meta.transaction_date).getTime())) ? new Date(_meta.transaction_date).toISOString() : null;
  const _tenantBilling = {
    total_amount_inr: _bGrand,
    amount_paid_inr: _fullyPaid ? _bGrand : (_bnum(_meta.amount_paid_inr)!=null?_bnum(_meta.amount_paid_inr):(_invPaid?_bGrand:0)),
    sale_amount_inr: _bSub, gst_amount_inr: _bTax,
    transaction_mode: _meta.transaction_mode || null,
    transaction_id: _meta.transaction_id || null,
    transaction_date: _txnDate,
    tenure: _meta.desired_tenure || null,
    admin_remarks: _meta.payment_remarks || null
  };
  let tenantId;
  const existing = await control.findOneBy('tenants', 'slug', slug);
  if (existing) {
    tenantId = existing.id;
    await control.update('tenants', tenantId, Object.assign({
      package_id: pkg ? pkg.id : null,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString()
    }, _tenantBilling));
  } else {
    tenantId = await control.insert('tenants', Object.assign({
      slug, org_name: signup.org_name || signup.name,
      contact_name: signup.name, contact_email: signup.email, contact_mobile: signup.mobile,
      db_name: dbName, package_id: pkg ? pkg.id : null,
      status: 'active',
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString()
    }, _tenantBilling));
  }

  // 5. First invoice + mark paid (amounts computed above as _bSub/_bTax/_bGrand).
  const invNumber = await _nextInvoiceNumber();
  const _planLabel = pkg ? (pkg.name + ' — ' + (pkg.recurring_period_count || 1) + ' ' + pkg.recurring_period)
                         : ('Custom plan — ' + (_meta.desired_tenure || 'custom tenure'));
  const invoiceId = await control.insert('invoices', {
    tenant_id: tenantId,
    number: invNumber,
    package_id: pkg ? pkg.id : null,
    description: _planLabel,
    subtotal_inr: _bSub, tax_inr: _bTax, total_inr: _bGrand,
    period_start: now.toISOString(), period_end: periodEnd.toISOString(),
    // SIGNUP_AUTOPAID_v1 — fully-paid signups auto-mark the invoice paid.
    status: _invPaid ? 'paid' : 'pending',
    paid_at: _invPaid ? now.toISOString() : null
  });

  // SAAS_TXN_v1 — auto-record this signup payment in the transactions ledger.
  try {
    const txn = require('./transactions');
    await txn.recordTransaction({
      tenant_id: tenantId, type: 'auto', source: 'signup',
      amount_inr: _bGrand, sale_amount_inr: _bSub, gst_amount_inr: _bTax,
      gst_mode: (_bTax > 0 ? 'gst' : 'no_gst'),
      transaction_mode: _meta.transaction_mode || null,
      transaction_id: _meta.transaction_id || null,
      txn_date: _txnDate ? String(_txnDate).slice(0, 10) : null,
      invoice_id: invoiceId, notes: 'Signup provision'
    });
  } catch (_) {}

  // 6. Mark signup provisioned
  await control.update('signups', signup.id, { status: 'provisioned' });

  // 7. Audit
  await control.insert('audit_log', {
    actor_type: 'system', tenant_id: tenantId, event: 'tenant.provisioned',
    detail: JSON.stringify({ slug, package: pkg ? pkg.name : 'Custom', invoice: invNumber })
  });

  // 8. Email credentials (best-effort)
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const loginUrl = baseUrl + '/t/' + slug;
  // WELCOME_EMAIL_v2 — branded template + per-tenant status tracking. Any
  // failure is logged with the [EMAIL_ISSUE] category and stamped on the tenant.
  await sendWelcomeEmail({
    tenantId,
    name: signup.name, orgName: signup.org_name || signup.name,
    packageName: pkg ? pkg.name : 'Custom plan', slug,
    email: String(signup.email || '').toLowerCase().trim(),
    password: oneTimePassword
  });

  // TENANT_BILLING_NOTIFY_v1 (2026-06-20) — also send the same creds via
  // WhatsApp using Vserve's WABA. APK link included in both channels.
  try {
    const wa = require('../../utils/saasWaSender');
    const apkUrl = (process.env.PUBLIC_BASE_URL || baseUrl || '') + '/LeadCRM.apk';
    const msg = '🎉 Welcome to SmartCRM, ' + (signup.name || '') + '!\n\n' +
      'Your ' + (pkg.name || 'workspace') + ' account is live.\n\n' +
      '🔗 Login: ' + loginUrl + '\n' +
      '📧 Email: ' + String(signup.email || '').toLowerCase().trim() + '\n' +
      '🔑 Password: ' + oneTimePassword + '\n\n' +
      '📱 Mobile app: ' + apkUrl + '\n\n' +
      'Please change your password on first login (Settings → Security).\n\n— Team SmartCRM';
    if (signup.mobile) {
      const r = await wa.sendText(signup.mobile, msg);
      if (!r.ok) console.warn('[provisioning] welcome WA failed:', r.error);
    }
  } catch (e) { console.warn('[provisioning] welcome WA error:', e.message); }

  return {
    tenant_id: tenantId, slug, db_name: dbName, invoice_id: invoiceId,
    login_url: loginUrl,
    email: String(signup.email || '').toLowerCase().trim(),
    password: oneTimePassword
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

let _welcomeTplCache = null;
function renderWelcomeEmailHtml({ name, orgName, packageName, loginUrl, apkUrl, email, password }) {
  if (_welcomeTplCache == null) {
    try {
      _welcomeTplCache = require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', 'templates', 'welcome_email.html'), 'utf8');
    } catch (e) { _welcomeTplCache = ''; }
  }
  let html = _welcomeTplCache || '';
  const map = {
    '__NAME__':      escape(name || 'there'),
    '__COMPANY__':   escape(orgName || ''),
    '__PLAN__':      escape(packageName || 'SmartCRM'),
    '__EMAIL__':     escape(email || ''),
    '__PASSWORD__':  escape(password || ''),
    '__LOGIN_URL__': String(loginUrl || ''),
    '__APK_URL__':   String(apkUrl || '')
  };
  Object.keys(map).forEach(k => { html = html.split(k).join(map[k]); });
  return html;
}

// WELCOME_EMAIL_v2 — render + send the branded welcome email and record the
// outcome on the tenant row. NEVER throws; returns { ok, error }. On failure it
// logs with the [EMAIL_ISSUE] tag so it stands out in the Railway logs.
async function sendWelcomeEmail({ tenantId, name, orgName, packageName, slug, email, password }) {
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const loginUrl = baseUrl + '/t/' + slug;
  const apkUrl   = baseUrl + '/LeadCRM.apk';
  const plan = packageName || 'SmartCRM';
  const to = String(email || '').toLowerCase().trim();
  const subject = 'Welcome to SmartCRM 🎉 — Your ' + plan + ' account' + (orgName ? ' for ' + orgName : '') + ' is live';
  if (!to) {
    console.error('[EMAIL_ISSUE] welcome email skipped for tenant ' + (slug || tenantId) + ': no recipient email');
    try { await control.update('tenants', tenantId, { welcome_email_status: 'failed', welcome_email_error: 'No recipient email' }); } catch (_) {}
    return { ok: false, error: 'No recipient email' };
  }
  const html = renderWelcomeEmailHtml({ name, orgName, packageName: plan, loginUrl, apkUrl, email: to, password });
  try {
    await mailer.sendMail({ to, subject, html });
    try {
      await control.update('tenants', tenantId, {
        welcome_email_sent_at: new Date().toISOString(),
        welcome_email_status: 'sent', welcome_email_error: null,
        welcome_temp_password: password || null   // WELCOME_EMAIL_v3 — enable resend w/o reset
      });
    } catch (_) {}
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 500);
    console.error('[EMAIL_ISSUE] welcome email FAILED for tenant ' + (slug || tenantId) + ' <' + to + '>: ' + msg);
    try {
      await control.update('tenants', tenantId, { welcome_email_status: 'failed', welcome_email_error: msg, welcome_temp_password: password || null });
    } catch (_) {}
    try {
      await control.insert('audit_log', {
        actor_type: 'system', tenant_id: tenantId, event: 'email.issue',
        detail: JSON.stringify({ category: 'email issue', kind: 'welcome_email', slug, to, error: msg })
      });
    } catch (_) {}
    return { ok: false, error: msg };
  }
}

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

module.exports = { provisionFromSignup, sendWelcomeEmail, renderWelcomeEmailHtml };
