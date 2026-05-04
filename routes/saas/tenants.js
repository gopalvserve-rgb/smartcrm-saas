/**
 * Super-admin Tenants CRUD.
 *   - List tenants with package + last invoice
 *   - Suspend / restore
 *   - Change plan (upgrade / downgrade)
 *   - Trigger pending-deletion countdown (or restore from it)
 *   - Manage extra/blocked modules per tenant
 *   - Hard-delete (only after pending_delete window has elapsed)
 */
const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

async function api_saas_tenants_list(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.q) {
    params.push('%' + String(f.q).toLowerCase() + '%');
    where.push(`(LOWER(t.org_name) LIKE $${params.length} OR LOWER(t.contact_email) LIKE $${params.length} OR t.slug LIKE $${params.length})`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`t.status = $${params.length}`);
  }
  const sql = `
    SELECT t.*, p.name AS package_name, p.base_price_inr,
           (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'paid') AS paid_invoice_count,
           (SELECT MAX(created_at) FROM invoices i WHERE i.tenant_id = t.id) AS last_invoice_at
      FROM tenants t
      LEFT JOIN packages p ON p.id = t.package_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.id DESC LIMIT 500`;
  const r = await control.query(sql, params);
  return r.rows;
}

async function api_saas_tenants_get(token, id) {
  await requireSuperAdmin(token);
  return control.findById('tenants', id);
}

async function api_saas_tenants_changePackage(token, payload) {
  const me = await requireSuperAdmin(token);
  const p = payload || {};
  const tenant = await control.findById('tenants', p.tenant_id);
  if (!tenant) throw new Error('Tenant not found');
  const pkg = await control.findById('packages', p.package_id);
  if (!pkg) throw new Error('Package not found');
  await control.update('tenants', tenant.id, { package_id: pkg.id });
  tenantPool.invalidateSlug(tenant.slug);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email, tenant_id: tenant.id,
    event: 'tenant.package_changed',
    detail: JSON.stringify({ from: tenant.package_id, to: pkg.id })
  });
  return { ok: true };
}

async function api_saas_tenants_suspend(token, id) {
  const me = await requireSuperAdmin(token);
  const t = await control.findById('tenants', id);
  if (!t) throw new Error('Tenant not found');
  await control.update('tenants', id, { status: 'suspended' });
  tenantPool.invalidateSlug(t.slug);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: id, event: 'tenant.suspended'
  });
  return { ok: true };
}

async function api_saas_tenants_restore(token, id) {
  const me = await requireSuperAdmin(token);
  const t = await control.findById('tenants', id);
  if (!t) throw new Error('Tenant not found');
  await control.update('tenants', id, { status: 'active', pending_delete_at: null });
  tenantPool.invalidateSlug(t.slug);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: id, event: 'tenant.restored'
  });
  return { ok: true };
}

async function api_saas_tenants_pendingDelete(token, id) {
  const me = await requireSuperAdmin(token);
  const t = await control.findById('tenants', id);
  if (!t) throw new Error('Tenant not found');
  await control.update('tenants', id, { status: 'pending_delete', pending_delete_at: control.nowIso() });
  tenantPool.invalidateSlug(t.slug);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: id, event: 'tenant.pending_delete'
  });
  return { ok: true };
}

async function api_saas_tenants_setModules(token, payload) {
  const me = await requireSuperAdmin(token);
  const t = await control.findById('tenants', payload.tenant_id);
  if (!t) throw new Error('Tenant not found');
  await control.update('tenants', t.id, {
    extra_modules: payload.extra_modules || null,
    blocked_modules: payload.blocked_modules || null
  });
  tenantPool.invalidateSlug(t.slug);
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.modules_changed',
    detail: JSON.stringify({ extra: payload.extra_modules, blocked: payload.blocked_modules })
  });
  return { ok: true };
}

module.exports = {
  api_saas_tenants_list,
  api_saas_tenants_get,
  api_saas_tenants_changePackage,
  api_saas_tenants_suspend,
  api_saas_tenants_restore,
  api_saas_tenants_pendingDelete,
  api_saas_tenants_setModules
};
