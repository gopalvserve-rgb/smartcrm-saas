/* ============================================================================
 * SaaS Signup Requests (SAAS_ADMIN_REPAIR_v1, 2026-06-28)
 *
 * Backs the super-admin "Signup Requests" page. Reads from the existing
 * `signups` table (created in control/schema.sql) + cross-joined with
 * packages for the requested-plan name.
 *
 * APIs (all super-admin gated):
 *   api_saas_sr_list(token, opts)             → filtered list (status + search)
 *   api_saas_sr_get(token, id)                → single row + audit
 *   api_saas_sr_approve(token, payload)       → mark paid + trigger provisioning
 *   api_saas_sr_reject(token, payload)        → mark abandoned
 *   api_saas_sr_resend(token, id)             → resend the welcome / payment link
 *   api_saas_sr_summary(token)                → count by status (sidebar badge)
 * ============================================================================ */
'use strict';
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');

async function api_saas_sr_list(token, opts) {
  await requireFullAdmin(token);
  const o = opts || {};
  const where = [];
  const args  = [];
  if (o.status && o.status !== 'all') { args.push(o.status); where.push(`s.status = $${args.length}`); }
  if (o.q) {
    args.push('%' + String(o.q).trim() + '%');
    where.push(`(s.name ILIKE $${args.length} OR s.email ILIKE $${args.length} OR s.mobile ILIKE $${args.length} OR s.org_name ILIKE $${args.length} OR COALESCE(s.desired_slug,'') ILIKE $${args.length})`);
  }
  const limit = Math.min(parseInt(o.limit || 200, 10) || 200, 1000);
  const sql = `
    SELECT s.id, s.name, s.email, s.mobile, s.org_name, s.desired_slug,
           s.cashfree_order_id, s.status, s.metadata, s.created_at, s.updated_at,
           s.package_id, p.name AS package_name, p.base_price_inr AS price_inr,
           t.id AS provisioned_tenant_id, t.slug AS provisioned_tenant_slug
      FROM signups s
      LEFT JOIN packages p ON p.id = s.package_id
      LEFT JOIN tenants  t ON t.contact_email = s.email AND t.status NOT IN ('deleted','pending_delete')
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY s.created_at DESC
     LIMIT ${limit}`;
  const r = await control.query(sql, args);
  return { items: r.rows };
}

async function api_saas_sr_get(token, id) {
  await requireFullAdmin(token);
  const r = await control.query(
    `SELECT s.*, p.name AS package_name, p.base_price_inr AS price_inr
       FROM signups s LEFT JOIN packages p ON p.id = s.package_id
      WHERE s.id = $1`, [Number(id)]
  );
  if (!r.rows.length) throw new Error('Signup request not found');
  return { item: r.rows[0] };
}

async function api_saas_sr_approve(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const ex = await control.query(`SELECT id, status, email, desired_slug FROM signups WHERE id=$1`, [p.id]);
  if (!ex.rows.length) throw new Error('Signup request not found');

  // Mark as paid (manual approval = skip Cashfree, treat as paid)
  await control.update('signups', p.id, { status: 'paid', updated_at: new Date() });

  // SAAS_ADMIN_REPAIR_v1.7 — call the REAL function provisionFromSignup
  // (not the non-existent provisionTenant). This actually creates the
  // tenant DB, runs the schema, seeds the admin user with bcrypt-hashed
  // password, and emails the credentials via saasMailer.
  let provisioned = null, provErr = null;
  try {
    const provisioning = require('./provisioning');
    if (typeof provisioning.provisionFromSignup === 'function') {
      provisioned = await provisioning.provisionFromSignup(p.id);
    } else {
      provErr = 'provisioning.provisionFromSignup is not a function';
    }
  } catch (e) {
    provErr = e.message;
    console.error('[sr.approve] provision error:', e);
  }

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'signup.approved',
    detail: JSON.stringify({ signup_id: p.id, provisioned: provisioned, prov_err: provErr })
  }).catch(() => {});

  if (provErr) throw new Error('Provisioning failed: ' + provErr);
  return { ok: true, provisioned };
}

/** Re-provision a signup that got stuck (e.g. earlier failed approve).
 *  Lets admin retry provisioning without re-marking status. */
async function api_saas_sr_provision(token, id) {
  const me = await requireFullAdmin(token);
  if (!id) throw new Error('id required');
  const provisioning = require('./provisioning');
  if (typeof provisioning.provisionFromSignup !== 'function') {
    throw new Error('provisioning.provisionFromSignup not available');
  }
  const result = await provisioning.provisionFromSignup(Number(id));
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'signup.reprovisioned',
    detail: JSON.stringify({ signup_id: Number(id), result })
  }).catch(() => {});
  return { ok: true, result };
}

/** Reset the password for a provisioned tenant's admin user. Useful when
 *  the welcome email was missed or the original password got lost.
 *  Returns the new password in plain text (shown once to the admin). */
async function api_saas_sr_resetTenantAdminPassword(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  if (!p.signup_id && !p.tenant_id && !p.email) throw new Error('signup_id, tenant_id or email required');

  // Find the tenant DB name
  let tenant;
  if (p.tenant_id) {
    tenant = await control.findById('tenants', p.tenant_id);
  } else if (p.signup_id) {
    const s = await control.findById('signups', p.signup_id);
    if (s) tenant = await control.findOneBy('tenants', 'slug', s.desired_slug);
  } else if (p.email) {
    tenant = await control.findOneBy('tenants', 'contact_email', String(p.email).toLowerCase().trim());
  }
  if (!tenant) throw new Error('Tenant not found');

  const bcrypt = require('bcryptjs');
  const { Pool } = require('pg');
  const baseUrl = process.env.CONTROL_DATABASE_URL || process.env.DATABASE_URL;
  const u = new URL(baseUrl);
  u.pathname = '/' + tenant.db_name;
  const tPool = new Pool({
    connectionString: u.toString(),
    ssl: /sslmode=require|railway|neon|supabase|render/i.test(baseUrl) ? { rejectUnauthorized: false } : false,
    max: 1
  });
  try {
    const newPw = 'scrm-' + require('crypto').randomBytes(4).toString('hex');
    const hash = bcrypt.hashSync(newPw, 10);
    const r = await tPool.query(
      `UPDATE users SET password_hash=$1, is_active=1 WHERE email=$2 AND role='admin' RETURNING id, email`,
      [hash, tenant.contact_email]
    );
    if (!r.rows.length) {
      // No admin user yet — create one
      await tPool.query(
        `INSERT INTO users (name, email, password_hash, role, is_active, created_at)
         VALUES ($1, $2, $3, 'admin', 1, NOW())
         ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, is_active=1`,
        [tenant.contact_name || tenant.org_name || 'Admin', tenant.contact_email, hash]
      );
    }
    await control.insert('audit_log', {
      actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
      event: 'tenant.admin_password_reset',
      detail: JSON.stringify({ tenant_id: tenant.id, slug: tenant.slug, email: tenant.contact_email })
    }).catch(() => {});
    return {
      ok: true,
      tenant_slug: tenant.slug,
      login_url: 'https://' + ((await control.getSetting('PLATFORM_DOMAIN')) || 'crm.smartcrmsolution.com') + '/t/' + tenant.slug + '/',
      email: tenant.contact_email,
      password: newPw,
      message: 'Password reset. Share these credentials with the user (shown once).'
    };
  } finally {
    try { await tPool.end(); } catch (_) {}
  }
}

async function api_saas_sr_reject(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  await control.update('signups', p.id, {
    status: 'abandoned',
    metadata: JSON.stringify({ rejected_by: me.email, reason: p.reason || '', rejected_at: new Date().toISOString() }),
    updated_at: new Date()
  });
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'signup.rejected', detail: JSON.stringify({ signup_id: p.id, reason: p.reason })
  }).catch(() => {});
  return { ok: true };
}

async function api_saas_sr_delete(token, id) {
  const me = await requireFullAdmin(token);
  await control.query(`DELETE FROM signups WHERE id=$1`, [Number(id)]);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'signup.deleted', detail: JSON.stringify({ signup_id: Number(id) })
  }).catch(() => {});
  return { ok: true };
}

/** Resend welcome / payment link via email (uses saasMailer). */
async function api_saas_sr_resend(token, id) {
  await requireFullAdmin(token);
  const r = await control.query(`SELECT * FROM signups WHERE id=$1`, [Number(id)]);
  if (!r.rows.length) throw new Error('Signup request not found');
  const s = r.rows[0];
  if (!s.email) throw new Error('No email on this signup');
  const saasMailer = require('./saasMailer');
  const platform = (await control.getSetting('PLATFORM_NAME')) || 'SmartCRM';
  const url = (await control.getSetting('SIGNUP_PAYMENT_URL')) || ('https://' + (await control.getSetting('PLATFORM_DOMAIN') || 'crm.smartcrmsolution.com') + '/saas/signup-request.html');
  await saasMailer.sendMail({
    to: s.email,
    subject: `Complete your ${platform} signup — ${s.org_name || s.name}`,
    html: `<div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#1c1917">
      <h2>Hi ${s.name || 'there'},</h2>
      <p>This is a friendly reminder to complete your <b>${platform}</b> signup for <b>${s.org_name || ''}</b>.</p>
      <p><a href="${url}" style="display:inline-block;background:#7c3aed;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Resume signup →</a></p>
      <p style="color:#78716c;font-size:13px">If you've already completed it, please ignore this email.</p>
    </div>`
  });
  return { ok: true, sent_to: s.email };
}

async function api_saas_sr_summary(token) {
  await requireFullAdmin(token);
  const r = await control.query(`SELECT status, COUNT(*)::int AS n FROM signups GROUP BY status`);
  const by = {};
  for (const x of r.rows) by[x.status] = x.n;
  return {
    by_status: by,
    pending:     by.pending     || 0,
    paid:        by.paid        || 0,
    provisioned: by.provisioned || 0,
    abandoned:   by.abandoned   || 0,
    total: Object.values(by).reduce((a, b) => a + b, 0)
  };
}

async function api_saas_sr_update(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const ex = await control.query(`SELECT id FROM signups WHERE id=$1`, [p.id]);
  if (!ex.rows.length) throw new Error('Signup request not found');
  const allowed = ['name','email','mobile','org_name','desired_slug','package_id','status','metadata'];
  // SIGNUP_META_MERGE_v1 — the review modal sends metadata fields flat (e.g.
  // total_amount_inr, desired_tenure, transaction_id). Merge them into the
  // signups.metadata JSON so they actually persist (previously dropped).
  const META_FIELDS = ['submitted_by','desired_tenure','desired_users','payment_status',
    'amount_paid_inr','total_amount_inr','next_payment_at','notes','transaction_mode',
    'transaction_id','transaction_date','payment_remarks','gst_mode','industry_pack'];
  let _metaChanged = false, _meta = {};
  try { _meta = (typeof ex.rows[0]?.metadata === 'string') ? JSON.parse(ex.rows[0].metadata) : {}; } catch (_) { _meta = {}; }
  if (!p.metadata) {
    // reload current metadata to merge onto
    try { const mr = await control.query('SELECT metadata FROM signups WHERE id=$1',[p.id]); _meta = (typeof mr.rows[0].metadata==='string')?JSON.parse(mr.rows[0].metadata||'{}'):(mr.rows[0].metadata||{}); } catch(_) { _meta = {}; }
    for (const k of META_FIELDS) {
      if (p[k] !== undefined) { _meta[k] = (p[k]===''||p[k]==null) ? '' : String(p[k]); _metaChanged = true; }
    }
    // GST split: total is GST-inclusive when gst_mode=with_gst.
    const _tot = Number(_meta.total_amount_inr);
    if (isFinite(_tot) && _tot > 0) {
      if (String(_meta.gst_mode||'no_gst').toLowerCase() === 'with_gst') {
        const sale = Math.round((_tot/1.18)*100)/100;
        _meta.gst_mode='with_gst'; _meta.gst_percent=18; _meta.sale_amount_inr=sale; _meta.gst_amount_inr=Math.round((_tot-sale)*100)/100;
      } else {
        _meta.gst_mode='no_gst'; _meta.gst_percent=0; _meta.sale_amount_inr=_tot; _meta.gst_amount_inr=0;
      }
      _metaChanged = true;
    }
    if (_metaChanged) { p.metadata = _meta; }
  }
  const sets = []; const args = [];
  for (const k of allowed) {
    if (p[k] !== undefined) {
      let _v = p[k];
      if (k === 'package_id') _v = (_v === '' || _v == null) ? null : Number(_v);
      if (k === 'metadata')   _v = (typeof _v === 'string') ? _v : JSON.stringify(_v);
      args.push(_v); sets.push(`${k}=$${args.length}`);
    }
  }
  if (!sets.length) return { ok: true, changed: 0 };
  sets.push('updated_at=NOW()');
  args.push(p.id);
  await control.query(`UPDATE signups SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'signup.updated', detail: JSON.stringify({ signup_id: p.id, fields: Object.keys(p).filter(k => allowed.includes(k)) })
  }).catch(() => {});
  return { ok: true, changed: sets.length - 1 };
}

/* PUBLIC_SIGNUP_SUBMIT_v2 — public form (/saas/signup-request.html) POSTs here.
 * Inserts a 'pending' row into control.signups. No auth (public).
 * Re-added after a server.js rewrite dropped it (route still referenced it). */
async function expressPublicSubmit(req, res) {
  try {
    const b = req.body || {};
    const name   = String(b.name || '').trim();
    const email  = String(b.email || '').trim().toLowerCase();
    const mobile = String(b.mobile || '').trim();
    if (!name || !email || !mobile) return res.status(400).json({ error: 'Name, email and mobile are required.' });
    const org  = String(b.org_name || '').trim();
    const slug = String(b.desired_slug || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
    const meta = {};
    ['submitted_by','desired_tenure','desired_users','payment_status','amount_paid_inr','total_amount_inr','next_payment_at','notes','transaction_mode','transaction_id','transaction_date','payment_remarks','gst_mode'].forEach(k => {
      if (b[k] != null && String(b[k]).trim() !== '') meta[k] = String(b[k]).trim();
    });
    // GST_SPLIT_v1 — split the entered Total into sale amount + GST so the
    // super-admin can account for sale value and GST separately.
    // No GST  → the total IS the sale amount (gst 0).
    // With GST → the total is GST-inclusive; extract 18% (sale = total / 1.18).
    const _gstMode = String(b.gst_mode || 'no_gst').toLowerCase() === 'with_gst' ? 'with_gst' : 'no_gst';
    const _total   = Number(b.total_amount_inr);
    if (isFinite(_total) && _total > 0) {
      if (_gstMode === 'with_gst') {
        const sale = Math.round((_total / 1.18) * 100) / 100;
        meta.gst_mode       = 'with_gst';
        meta.gst_percent    = 18;
        meta.sale_amount_inr = sale;
        meta.gst_amount_inr = Math.round((_total - sale) * 100) / 100;
      } else {
        meta.gst_mode       = 'no_gst';
        meta.gst_percent    = 0;
        meta.sale_amount_inr = _total;
        meta.gst_amount_inr = 0;
      }
    }
    const r = await control.query(
      `INSERT INTO signups (name, email, mobile, org_name, desired_slug, status, metadata)
       VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING id`,
      [name.slice(0,160), email.slice(0,200), mobile.slice(0,40),
       org ? org.slice(0,200) : null, slug ? slug.slice(0,80) : null, JSON.stringify(meta)]);
    return res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error('[saas-public-signup-request]', e.message);
    return res.status(400).json({ error: e.message });
  }
}

/**
 * SR_SUBMITTEDBY_SUMMARY_v1 — month-wise sales summary grouped by the
 * "Submitted by" salesperson on each signup request. Count, total amount,
 * amount paid, and outstanding balance per (salesperson, month).
 *
 * The amount fields live inside signups.metadata as strings (e.g. "7670"),
 * so we strip any non-numeric characters before casting. Salesperson names
 * are grouped case-insensitively (e.g. "lalit" and "Lalit" merge) and shown
 * in Title Case.
 */
async function api_saas_sr_submittedby_summary(token, filters) {
  await requireFullAdmin(token);
  const f = filters || {};
  const where = []; const args = [];
  if (f.status && f.status !== 'all') { args.push(f.status); where.push(`status = $${args.length}`); }
  if (f.from) { args.push(f.from); where.push(`created_at >= $${args.length}`); }
  if (f.to)   { args.push(f.to);   where.push(`created_at <= $${args.length}`); }
  const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const NUM = (k) => `NULLIF(regexp_replace(COALESCE(metadata->>'${k}',''),'[^0-9.]','','g'),'')::numeric`;
  const sql = `
    SELECT lower(trim(COALESCE(NULLIF(TRIM(metadata->>'submitted_by'),''),'(unassigned)'))) AS rep_key,
           INITCAP(COALESCE(NULLIF(TRIM(metadata->>'submitted_by'),''),'(unassigned)'))      AS rep,
           to_char(date_trunc('month', created_at),'YYYY-MM')                                 AS ym,
           COUNT(*)::int                                                                      AS cnt,
           COALESCE(SUM(${NUM('total_amount_inr')}),0)::numeric                               AS amount,
           COALESCE(SUM(${NUM('amount_paid_inr')}),0)::numeric                                AS paid
      FROM signups
      ${wsql}
      GROUP BY rep_key, rep, ym
      ORDER BY rep, ym`;
  const r = await control.query(sql, args);
  const rows = r.rows.map(x => {
    const amount = Number(x.amount) || 0;
    const paid   = Number(x.paid)   || 0;
    return {
      rep: x.rep, month: x.ym, count: Number(x.cnt) || 0,
      amount, paid, balance: Math.round((amount - paid) * 100) / 100
    };
  });
  const totals = rows.reduce((a, x) => {
    a.count += x.count; a.amount += x.amount; a.paid += x.paid; a.balance += x.balance; return a;
  }, { count: 0, amount: 0, paid: 0, balance: 0 });
  return { rows, totals };
}

module.exports = {
  expressPublicSubmit,
  api_saas_sr_list,
  api_saas_sr_update,
  api_saas_sr_provision,
  api_saas_sr_resetTenantAdminPassword,
  api_saas_sr_get,
  api_saas_sr_approve,
  api_saas_sr_reject,
  api_saas_sr_delete,
  api_saas_sr_resend,
  api_saas_sr_summary,
  api_saas_sr_submittedby_summary
};
