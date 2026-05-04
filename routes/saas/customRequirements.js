/**
 * Custom Requirements — tenants submit "I want X feature for ₹Y",
 * admin replies + quotes + charges, ticket moves through a workflow.
 *
 * Statuses: open → quoted → approved → in_progress → done | rejected
 *
 * Submission can come from inside any tenant CRM (a button on their
 * Settings → Custom Requirements page) — we pass in the tenant slug
 * and the user's email. Admin lists every ticket platform-wide and
 * can quote, approve, attach an invoice, mark done.
 */
const control = require('../../control/db');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

/** Tenant-side: list MY tickets (called from inside the tenant CRM). */
async function api_saas_cr_tenantList(_token, payload) {
  const tenantId = Number(payload && payload.tenant_id);
  if (!tenantId) throw new Error('tenant_id required');
  const r = await control.query(
    `SELECT * FROM custom_requirements WHERE tenant_id = $1 ORDER BY id DESC`,
    [tenantId]
  );
  return r.rows;
}

/** Tenant-side: submit a new ticket. */
async function api_saas_cr_submit(_token, payload) {
  const p = payload || {};
  const tenantId = Number(p.tenant_id);
  if (!tenantId) throw new Error('tenant_id required');
  if (!p.title || !p.description) throw new Error('Title and description are required');
  const id = await control.insert('custom_requirements', {
    tenant_id: tenantId, submitted_by: p.submitted_by || '',
    title: String(p.title).slice(0, 200),
    description: String(p.description).slice(0, 5000),
    status: 'open'
  });
  await control.insert('audit_log', {
    actor_type: 'tenant', tenant_id: tenantId, event: 'custom_req.submitted',
    detail: JSON.stringify({ id, title: p.title })
  });
  return { id, ok: true };
}

/** Admin: list every ticket. */
async function api_saas_cr_listAll(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  const where = []; const params = [];
  if (f.status) { params.push(f.status); where.push(`cr.status = $${params.length}`); }
  if (f.tenant_id) { params.push(f.tenant_id); where.push(`cr.tenant_id = $${params.length}`); }
  const sql = `
    SELECT cr.*, t.org_name, t.slug
      FROM custom_requirements cr
      LEFT JOIN tenants t ON t.id = cr.tenant_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY cr.id DESC LIMIT 1000`;
  const r = await control.query(sql, params);
  return r.rows;
}

/** Admin: respond, quote, change status. */
async function api_saas_cr_update(token, payload) {
  const me = await requireSuperAdmin(token);
  const p = payload || {};
  const cr = await control.findById('custom_requirements', p.id);
  if (!cr) throw new Error('Ticket not found');
  const data = {};
  if (p.admin_reply !== undefined) data.admin_reply = p.admin_reply;
  if (p.quote_inr !== undefined)   data.quote_inr   = p.quote_inr ? Number(p.quote_inr) : null;
  if (p.status && ['open', 'quoted', 'approved', 'in_progress', 'done', 'rejected'].includes(p.status)) {
    data.status = p.status;
  }
  await control.update('custom_requirements', cr.id, data);

  // If admin marks 'approved' AND we have a quote, auto-create an invoice
  if (data.status === 'approved' && cr.tenant_id && (data.quote_inr || cr.quote_inr)) {
    const total = Number(data.quote_inr || cr.quote_inr) || 0;
    const tax = Math.round(total * 18 / 100 * 100) / 100;
    const grand = Math.round((total + tax) * 100) / 100;
    const yr = new Date().getFullYear();
    const cnt = await control.query(`SELECT COUNT(*) AS c FROM invoices`);
    const number = `INV-${yr}-${String(Number(cnt.rows[0].c) + 1).padStart(6, '0')}`;
    const invoiceId = await control.insert('invoices', {
      tenant_id: cr.tenant_id, number, description: 'Custom: ' + cr.title,
      subtotal_inr: total, tax_inr: tax, total_inr: grand, status: 'pending'
    });
    await control.update('custom_requirements', cr.id, { invoice_id: invoiceId });
  }

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: cr.tenant_id, event: 'custom_req.updated',
    detail: JSON.stringify({ id: cr.id, status: data.status })
  });
  return { ok: true };
}

module.exports = {
  api_saas_cr_tenantList,
  api_saas_cr_submit,
  api_saas_cr_listAll,
  api_saas_cr_update
};
