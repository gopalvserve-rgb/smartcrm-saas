/**
 * Super-admin Tenants CRUD.
 *   - List tenants with package + last invoice
 *   - Suspend / restore
 *   - Change plan (upgrade / downgrade)
 *   - Trigger pending-deletion countdown (or restore from it)
 *   - Manage extra/blocked modules per tenant
 *   - Hard-delete (only after pending_delete window has elapsed)
 */
const jwt = require('jsonwebtoken');
const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const provisioning = require('./provisioning');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

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

/**
 * Manual tenant create — admin-side flow that bypasses Cashfree.
 *
 * Use cases:
 *   - You sold a deal offline and want to provision the workspace
 *     without sending the customer through the Cashfree payment page.
 *   - You're testing signup → tenant flow and don't want a live charge.
 *   - You're migrating a customer from another billing system.
 *
 * The flow reuses the same provisionFromSignup() pipeline used by the
 * Cashfree webhook (CREATE DATABASE, run schema, seed admin user, etc.)
 * by first creating a "pending" signup row, then immediately
 * provisioning it. The first invoice is created and — when
 * mark_paid=true — flipped to paid so the tenant lands in 'active'
 * straight away instead of 'pending_payment'.
 *
 * Required payload:
 *   { name, email, mobile, org_name, desired_slug, package_id }
 * Optional:
 *   { mark_paid: true,    // pretend payment already went through
 *     skip_email: false,  // don't email the welcome credentials
 *     notes: '…' }
 */
async function api_saas_tenants_createManual(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};

  // ---- Validation -----------------------------------------------
  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim().toLowerCase();
  const mobile = String(p.mobile || '').trim();
  const orgName = String(p.org_name || '').trim();
  const slug = String(p.desired_slug || '').trim().toLowerCase();
  const packageId = Number(p.package_id);

  if (!name)              throw new Error('Name is required');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Valid email is required');
  if (!mobile || !/^\+?\d{8,15}$/.test(mobile.replace(/\s/g, ''))) throw new Error('Valid mobile is required');
  if (!orgName)           throw new Error('Organisation name is required');
  if (!/^[a-z][-a-z0-9]{2,29}$/.test(slug)) {
    throw new Error('Slug must start with a letter and only contain letters, digits, dashes (3–30 chars)');
  }
  if (!packageId)         throw new Error('Pick a package');

  const pkg = await control.findById('packages', packageId);
  if (!pkg) throw new Error('Package not found');

  // Reject duplicate slug up front so we don't create a half-baked
  // signup row that fails downstream.
  const existingTenant = await control.findOneBy('tenants', 'slug', slug);
  if (existingTenant) throw new Error('Workspace URL "' + slug + '" is already taken');

  // ---- 1. Create a synthetic signup row -------------------------
  const signupId = await control.insert('signups', {
    name, email, mobile, org_name: orgName,
    package_id: packageId, desired_slug: slug,
    status: 'pending',
    metadata: JSON.stringify({
      manual_create: true,
      created_by: me.email,
      created_by_id: me.id,
      mark_paid: p.mark_paid !== false,   // default true for manual create
      notes: p.notes || null
    })
  });

  // ---- 2. Provision -------------------------------------------
  // Reuse the same pipeline used by the Cashfree webhook so the schema,
  // first-admin seed, invoice generation etc. all match what a paying
  // customer would get.
  let prov;
  try {
    prov = await provisioning.provisionFromSignup(signupId);
  } catch (e) {
    // Don't leave a half-state signup row behind on failure.
    try { await control.update('signups', signupId, { status: 'abandoned', metadata: JSON.stringify({ error: e.message }) }); } catch (_) {}
    throw new Error('Provisioning failed: ' + e.message);
  }

  // ---- 3. Mark the auto-generated first invoice paid ----------
  // (Free plans are already 'paid'; for paid plans we do it here so
  // the tenant immediately lands in 'active' state with no dangling
  // pending invoice from a fictional Cashfree payment.)
  if (p.mark_paid !== false) {
    try {
      await control.query(
        `UPDATE invoices SET status = 'paid', paid_at = NOW()
          WHERE tenant_id = $1 AND status = 'pending'`,
        [prov.tenant_id]
      );
    } catch (_) {}
  }

  // ---- 4. Audit trail -----------------------------------------
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: prov.tenant_id, event: 'tenant.created_manually',
    detail: JSON.stringify({
      slug: prov.slug, package: pkg.name, mark_paid: p.mark_paid !== false
    })
  });

  return {
    ok: true,
    tenant_id: prov.tenant_id,
    slug: prov.slug,
    login_url: prov.login_url,
    email: prov.email,
    password: prov.password,            // surface to admin so they can hand it off
    invoice_id: prov.invoice_id
  };
}

/**
 * Admin "Login as tenant" — mints a short-lived magic-link URL that
 * the operator can open in a new window to land inside the tenant
 * workspace as that tenant's primary admin.
 *
 * For Phase 1 the tenant CRM SPA isn't mounted yet, so the link
 * still resolves to the /t/<slug>/ placeholder; the placeholder is
 * smart enough to recognise the `?ssl=…` (super-sudo-login) token
 * and surface that context to the operator. When Phase 2 mounts
 * the real tenant CRM, the same token will be consumed by the
 * tenant auth layer to skip the password screen entirely.
 *
 * Token design:
 *   Signed JWT, ttl = 5 min, payload = {
 *     ssl: true,            // marker so tenant auth knows this is sudo
 *     tenant_id, slug,      // which workspace
 *     as_email,             // tenant user we're logging in as (defaults to contact_email)
 *     sa_id, sa_email,      // who minted it (recorded in audit_log)
 *     iat, exp              // standard
 *   }
 *
 * Every call writes an audit_log row tagged tenant.login_as so the
 * platform can trace every impersonation later.
 */
async function api_saas_tenants_loginAs(token, tenantId, asEmail) {
  const me = await requireSuperAdmin(token);
  const t = await control.findById('tenants', tenantId);
  if (!t) throw new Error('Tenant not found');
  if (t.status === 'deleted')   throw new Error('Tenant is deleted');
  if (t.status === 'suspended') throw new Error('Tenant is suspended — restore it first');

  const targetEmail = String(asEmail || t.contact_email || '').trim().toLowerCase();
  if (!targetEmail) throw new Error('Tenant has no contact email — pass asEmail explicitly');

  // 5-minute magic link is long enough to copy/paste into another
  // window but short enough that a leaked token can't be reused
  // hours later. Operator can always click the button again.
  const ssl = jwt.sign(
    {
      ssl: true,
      tenant_id: t.id,
      slug: t.slug,
      as_email: targetEmail,
      sa_id: me.id,
      sa_email: me.email
    },
    JWT_SECRET,
    { expiresIn: '5m' }
  );

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const url = `${baseUrl}/t/${encodeURIComponent(t.slug)}/?ssl=${encodeURIComponent(ssl)}`;

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.login_as',
    detail: JSON.stringify({ slug: t.slug, as_email: targetEmail, expires_in_s: 300 })
  });

  return { ok: true, url, slug: t.slug, as_email: targetEmail, expires_in_s: 300 };
}

module.exports = {
  api_saas_tenants_list,
  api_saas_tenants_get,
  api_saas_tenants_createManual,
  api_saas_tenants_changePackage,
  api_saas_tenants_suspend,
  api_saas_tenants_restore,
  api_saas_tenants_pendingDelete,
  api_saas_tenants_setModules,
  api_saas_tenants_loginAs
};
