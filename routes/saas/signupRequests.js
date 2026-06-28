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
  const ex = await control.query(`SELECT id, status, email FROM signups WHERE id=$1`, [p.id]);
  if (!ex.rows.length) throw new Error('Signup request not found');
  // Mark as paid (manual approval = skip Cashfree, treat as paid)
  await control.update('signups', p.id, { status: 'paid', updated_at: new Date() });
  // Try to provision immediately
  let provisioned = null, provErr = null;
  try {
    const provisioning = require('./provisioning');
    if (typeof provisioning.provisionTenant === 'function') {
      provisioned = await provisioning.provisionTenant(p.id);
    }
  } catch (e) { provErr = e.message; }
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'signup.approved',
    detail: JSON.stringify({ signup_id: p.id, provisioned: !!provisioned, prov_err: provErr })
  }).catch(() => {});
  return { ok: true, provisioned, provisioning_error: provErr };
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

module.exports = {
  api_saas_sr_list,
  api_saas_sr_get,
  api_saas_sr_approve,
  api_saas_sr_reject,
  api_saas_sr_delete,
  api_saas_sr_resend,
  api_saas_sr_summary
};
