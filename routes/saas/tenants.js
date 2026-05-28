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
let _bcrypt; try { _bcrypt = require('bcryptjs'); } catch (_) { try { _bcrypt = require('bcrypt'); } catch (_) { _bcrypt = null; } }
const _crypto = require('crypto');
const provisioning = require('./provisioning');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');
const { seedTenantKnowledgeBase } = require('./kbSeed');

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

  // Optional industry pack — installed AFTER provisioning, inside the tenant
  // DB scope. Empty string = Generic (no pack).
  const industryPack = String(p.industry_pack || '').trim().toLowerCase();
  const VALID_PACKS = ['', 'education', 'realestate'];
  if (!VALID_PACKS.includes(industryPack)) {
    throw new Error('Invalid industry pack — must be one of: education, realestate, or blank (Generic)');
  }

  // Reject duplicate slug up front so we don't create a half-baked
  // signup row that fails downstream.
  const existingTenant = await control.findOneBy('tenants', 'slug', slug);
  if (existingTenant) throw new Error('Workspace URL "' + slug + '" is already taken');

  // BILL_OVERRIDES_v1 (2026-05-23) - optional manual fields used to override
  // package defaults when super-admin needs a custom plan for a tenant:
  //   start_date          (YYYY-MM-DD)  - backdate the validity start
  //   override_end_date   (YYYY-MM-DD)  - set explicit end_date; else computed
  //   override_amount     (number)      - custom price (often a discount/upsell)
  // All three are optional; if blank we fall back to the package defaults.
  const _validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
  const startDateOverride = String(p.start_date || '').trim();
  const endDateOverride   = String(p.override_end_date || '').trim();
  const amountOverrideRaw = p.override_amount;
  if (startDateOverride && !_validDate(startDateOverride)) throw new Error('start_date must be YYYY-MM-DD');
  if (endDateOverride   && !_validDate(endDateOverride))   throw new Error('override_end_date must be YYYY-MM-DD');
  if (amountOverrideRaw != null && amountOverrideRaw !== '' && isNaN(Number(amountOverrideRaw))) {
    throw new Error('override_amount must be a number');
  }
  const amountOverride = (amountOverrideRaw != null && amountOverrideRaw !== '') ? Number(amountOverrideRaw) : null;

  // CREATE_TENANT_USERS_v1 (2026-05-28) — user cap + extra-user pricing.
  //   user_cap                  null/blank → backend uses package.quotas.users.limit
  //   user_extra_charge_inr     ₹ billed per user OVER the cap
  //   user_extra_charge_period  month | quarter | year
  // All three optional; if blank/zero we don't write to the tenants row at all.
  const _userCapRaw = p.user_cap;
  const userCapOverride = (_userCapRaw == null || _userCapRaw === '' || isNaN(Number(_userCapRaw)))
    ? null : Math.max(0, Math.floor(Number(_userCapRaw)));
  const userExtraInr = Math.max(0, Number(p.user_extra_charge_inr) || 0);
  const _VALID_PER = ['month', 'quarter', 'year'];
  const userExtraPeriod = _VALID_PER.includes(String(p.user_extra_charge_period)) ? String(p.user_extra_charge_period) : 'month';

  // ---- 1. Create a synthetic signup row -------------------------
  const signupId = await control.insert('signups', {
    name, email, mobile, org_name: orgName,
    package_id: packageId, desired_slug: slug,
    status: 'pending',
    metadata: JSON.stringify({
      manual_create: true,
      created_by: me.email,
      created_by_id: me.id,
      mark_paid: p.mark_paid !== false,
      notes: p.notes || null,
      start_date_override: startDateOverride || null,
      end_date_override:   endDateOverride   || null,
      amount_override:     amountOverride
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

  // CREATE_TENANT_USERS_v1 — apply user_cap + extra-user pricing if super-admin set any
  if (userCapOverride != null || userExtraInr > 0) {
    try {
      await _ensureUserCapColumns();
      await control.query(
        `UPDATE tenants
            SET user_cap = $1,
                user_extra_charge_inr = $2,
                user_extra_charge_period = $3,
                updated_at = NOW()
          WHERE id = $4`,
        [userCapOverride, userExtraInr, userExtraPeriod, prov.tenant_id]
      );
    } catch (e) {
      console.warn('[createManual] user-cap apply failed (non-fatal):', e.message);
    }
  }

  // ---- 4. Audit trail -----------------------------------------
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: prov.tenant_id, event: 'tenant.created_manually',
    detail: JSON.stringify({
      slug: prov.slug, package: pkg.name, mark_paid: p.mark_paid !== false,
      industry_pack: industryPack || 'generic',
      user_cap: userCapOverride,
      user_extra_charge_inr: userExtraInr,
      user_extra_charge_period: userExtraPeriod
    })
  });

  // ---- 5. Optional: install an industry pack inside the new tenant ----
  // Runs inside tenantStorage.run() so the framework's db.query() lands
  // in the tenant DB, not the control DB.
  let installedPack = null;
  if (industryPack) {
    try {
      const tenantDb = require('../../db/pg');
      const tenantPoolMod = require('../../utils/tenantPool');
      const t = await tenantPoolMod.findActiveTenant(prov.slug);
      const pool = t && tenantPoolMod.poolFor(t);
      if (pool) {
        await tenantDb.tenantStorage.run({ pool, tenant: t, slug: prov.slug }, async () => {
          const fw = require('../packs/_framework');
          const res = await fw.installPack(industryPack, { userId: me.id });
          installedPack = res && res.pack_id;
        });
      }
    } catch (e) {
      // Pack install failure should NOT roll back the tenant — log and surface in response.
      console.warn('[createManual] industry-pack install failed:', e.message);
      installedPack = { error: e.message };
    }
  }

  return {
    ok: true,
    tenant_id: prov.tenant_id,
    slug: prov.slug,
    login_url: prov.login_url,
    email: prov.email,
    password: prov.password,            // surface to admin so they can hand it off
    invoice_id: prov.invoice_id,
    industry_pack: installedPack
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
  // Random JTI so each minted SSO token is identifiable and trackable
  // for the one-time-use guard in tenantApi.js → api_auth_ssoLogin.
  const _crypto = require('crypto');
  const _jti = _crypto.randomBytes(16).toString('hex');
  const ssl = jwt.sign(
    {
      ssl: true,
      jti: _jti,
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

/**
 * Re-seed the help-articles knowledge base for an existing tenant.
 * Idempotent: drops only rows tagged 'system-seed' and re-inserts the
 * canonical set, leaving any admin-authored entries untouched.
 *
 * Useful for tenants provisioned before the KB seed shipped, or when we
 * update the default articles and want to roll them out without forcing
 * a re-provision.
 */
async function api_saas_tenants_reseedKb(token, tenantId) {
  await requireSuperAdmin(token);
  const t = await control.findById('tenants', tenantId);
  if (!t) throw new Error('Tenant not found');
  if (t.status === 'deleted') throw new Error('Tenant is deleted');

  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');
  const n = await seedTenantKnowledgeBase(pool, { adminUserId: 1 });

  await control.insert('audit_log', {
    actor_type: 'super_admin', tenant_id: t.id, event: 'tenant.kb_reseeded',
    detail: JSON.stringify({ slug: t.slug, articles: n })
  });

  return { ok: true, articles: n };
}

/**
 * Reset a tenant user's password to a freshly-generated one. Returns the
 * plaintext password to the super-admin caller for ONE-TIME display so they
 * can share it with the tenant. The password_hash column is updated using
 * the same bcrypt strength (cost 10) that the rest of the auth path uses.
 *
 * payload:
 *   tenantId (number, required)
 *   email    (string, optional — defaults to the tenant's contact_email)
 *   newPassword (string, optional — when omitted, generates a 12-char
 *               random password from a URL-safe alphabet)
 */
async function api_saas_tenants_resetUserPassword(token, payload) {
  const me = await requireSuperAdmin(token);
  const p = payload || {};
  const tenantId = Number(p.tenantId || p.tenant_id);
  const t = await control.findById('tenants', tenantId);
  if (!t) throw new Error('Tenant not found');
  if (t.status === 'deleted')   throw new Error('Tenant is deleted');
  if (t.status === 'suspended') throw new Error('Tenant is suspended — restore first');
  if (!_bcrypt) throw new Error('bcrypt library not installed on the server');

  const targetEmail = String(p.email || t.contact_email || '').trim().toLowerCase();
  if (!targetEmail) throw new Error('Email required (no contact_email on tenant)');

  // Generate a 12-char password from a friendly alphabet (no 0/O/1/l confusion).
  function _gen() {
    const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const buf = _crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i++) out += alpha[buf[i] % alpha.length];
    return out;
  }
  const newPassword = String(p.newPassword || '').trim() || _gen();
  if (newPassword.length < 8) throw new Error('Password must be at least 8 chars');
  const hash = _bcrypt.hashSync(newPassword, 10);

  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');

  // Find the user. Prefer exact email match. If no row, fallback to the
  // first admin/manager (so a super-admin can recover access even when
  // the contact_email row was deleted by mistake).
  let r = await pool.query(`SELECT id, name, email, role FROM users WHERE LOWER(email) = $1 LIMIT 1`, [targetEmail]);
  let user = r.rows[0];
  if (!user) {
    r = await pool.query(`SELECT id, name, email, role FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`);
    user = r.rows[0];
  }
  if (!user) throw new Error('No matching user found in tenant DB');

  // Defensive: some older tenant DBs don't have an updated_at column on users.
  try {
    await pool.query(`UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, user.id]);
  } catch (e) {
    if (/updated_at/.test(String(e.message))) {
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
    } else { throw e; }
  }

  // Log to control audit_log (no plaintext stored — only the fact of reset).
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.user_password_reset',
    detail: JSON.stringify({ slug: t.slug, target_user_id: user.id, target_email: user.email })
  });

  return {
    ok: true,
    slug: t.slug,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    new_password: newPassword,
    note: 'Save this password now — it is shown ONCE. The tenant user can change it after logging in via Account → Change password.'
  };
}

/**
 * Force-run the tenant bootstrap (schema migrations + config defaults)
 * on every active tenant. Idempotent — re-running is safe and cheap
 * after the first pass (the runner remembers what's applied).
 *
 * Super-admin only. Use after a deploy that added a new migration if
 * you want it applied immediately without waiting for organic traffic
 * to hit each tenant's pool.
 *
 * Returns per-tenant counts so you can see at a glance which tenants
 * had something to catch up on.
 */
async function api_saas_tenants_runBootstrap(token, payload) {
  const { requireSuperAdmin } = require('./superAdminAuth');
  await requireSuperAdmin(token);
  const tenantPoolMod = require('../../utils/tenantPool');
  const { ensureTenantReady } = require('../../utils/tenantBootstrap');
  const controlDb = require('../../db/pg');
  const r = await controlDb.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY slug ASC LIMIT 500`
  );
  const limitSlug = payload && payload.slug ? String(payload.slug) : null;
  const results = [];
  for (const row of r.rows) {
    if (limitSlug && row.slug !== limitSlug) continue;
    let t;
    try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) continue;
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) { results.push({ slug: row.slug, error: 'no pool' }); continue; }
    try {
      // Force run even if the pool's in-process memo says 'done' — this
      // is the explicit-admin path, useful when the migrations list has
      // grown since the pool was first opened in this Node process.
      const res = await ensureTenantReady(pool);
      results.push({ slug: row.slug, applied: res.applied, defaultsSet: res.defaultsSet, errors: res.errors });
    } catch (e) {
      results.push({ slug: row.slug, error: e.message });
    }
  }
  return { ok: true, count: results.length, results };
}

// PACK_RETROFIT_v1 (2026-05-21) — install or switch an industry pack on an
// EXISTING tenant (originally only available at tenant-create time). Runs the
// pack's installer inside tenantStorage so all schema seeding lands in the
// tenant DB. Updates tenant_config.industry_pack so brand endpoint reports it.
async function api_saas_tenants_installPack(token, payload) {
  const { requireSuperAdmin } = require('./superAdminAuth');
  await requireSuperAdmin(token);
  const slug = String((payload && payload.slug) || '').trim();
  const packId = String((payload && payload.pack_id) || '').trim();
  if (!slug)   throw new Error('slug required');
  if (!packId) throw new Error('pack_id required');
  if (!['education','realestate','generic'].includes(packId)) {
    throw new Error('Unknown pack: ' + packId);
  }

  const tenantPoolMod = require('../../utils/tenantPool');
  const t = await tenantPoolMod.findActiveTenant(slug);
  if (!t) throw new Error('Tenant not found or inactive: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('No tenant pool available for ' + slug);

  // For 'generic' we just clear the active pack record; no installer to run.
  const tenantDb = require('../../db/pg');
  let installResult = null;
  await tenantDb.tenantStorage.run({ pool, tenant: t, slug }, async () => {
    if (packId === 'generic') {
      // mark all installed_packs inactive (soft uninstall, data kept)
      try {
        await tenantDb.query(
          `UPDATE installed_packs SET is_active = 0, uninstalled_at = NOW() WHERE is_active = 1`
        );
      } catch (_) { /* table may not exist yet on a brand-new tenant */ }
      installResult = { ok: true, pack_id: 'generic' };
    } else {
      const fw = require('../packs/_framework');
      installResult = await fw.installPack(packId, { userId: 0 });
    }
  });

  // Surface industry_pack on the public brand endpoint so the tenant SPA picks
  // it up on next reload without waiting for a token refresh.
  try {
    const controlDb = require('../../db/pg');
    await controlDb.query(
      `UPDATE tenant_config SET industry_pack = $1, updated_at = NOW() WHERE tenant_id = $2`,
      [packId, t.id]
    );
  } catch (_) { /* tenant_config row may not exist; brand endpoint falls back to installed_packs */ }

  return {
    ok: true,
    slug,
    pack_id: packId,
    install: installResult
  };
}

// FB_REGISTRY_BACKFILL_v1 (2026-05-21) — iterate every active tenant, read
// META_PAGES_LIST, and POST every page to fb_leads_register.php so old
// tenants who connected FB before FB_CENTRAL_REGISTRY_v2 deploy show up in
// the central JSON registry. Idempotent — calling twice updates entries
// in place via upsert.
async function api_saas_fb_backfillRegistry(token, payload) {
  const { requireSuperAdmin } = require('./superAdminAuth');
  await requireSuperAdmin(token);
  const onlySlug = payload && payload.slug ? String(payload.slug) : null;
  const controlDb = require('../../db/pg');
  const tenantPoolMod = require('../../utils/tenantPool');
  const tenantDb = require('../../db/pg');

  const r = await controlDb.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC`
  );
  const results = [];
  let totalRegistered = 0, totalSkipped = 0, totalErrors = 0;

  for (const row of r.rows) {
    if (onlySlug && row.slug !== onlySlug) continue;
    let t;
    try { t = await tenantPoolMod.findActiveTenant(row.slug); } catch (_) { continue; }
    if (!t) { results.push({ slug: row.slug, error: 'tenant not found' }); totalErrors++; continue; }
    const pool = tenantPoolMod.poolFor(t);
    if (!pool) { results.push({ slug: row.slug, error: 'no pool' }); totalErrors++; continue; }

    try {
      const out = await tenantDb.tenantStorage.run({ pool, tenant: t, slug: row.slug }, async () => {
        const fb = require('../fb');
        const db = require('../../db/pg');
        // Read this tenant's META_PAGES_LIST and META_APP_ID
        const rawList = await db.getConfig('META_PAGES_LIST', '');
        let pages = [];
        try { pages = JSON.parse(rawList); } catch (_) {}
        if (!Array.isArray(pages) || !pages.length) {
          return { skipped: true, reason: 'no pages connected' };
        }
        const appId = await db.getConfig('META_APP_ID', '');
        const verifyToken = await db.getConfig('META_VERIFY_TOKEN', '');
        let registered = 0, skipped = 0, errors = 0;
        for (const pg of pages) {
          try {
            const res = await fb._centralRegistryCall(
              pg,
              pg.is_monitored ? 'upsert' : 'remove',
              { tenant_slug: row.slug, app_id: appId, is_subscribed: pg.is_monitored ? 1 : 0, verify_token: verifyToken }
            );
            if (res && res.ok !== false) registered++;
            else { skipped++; }
          } catch (e) { errors++; }
        }
        return { pages: pages.length, registered, skipped, errors };
      });
      results.push({ slug: row.slug, ...out });
      if (out.registered) totalRegistered += out.registered;
      if (out.skipped) totalSkipped += (typeof out.skipped === 'number' ? out.skipped : 0);
      if (out.errors) totalErrors += out.errors;
    } catch (e) {
      results.push({ slug: row.slug, error: e.message });
      totalErrors++;
    }
  }

  return {
    ok: true,
    summary: { tenants_scanned: results.length, totalRegistered, totalSkipped, totalErrors },
    results
  };
}



/* ADMIN_USER_CAP_v1 — defensive migration: per-tenant user-cap + extra-user billing. */
async function _ensureUserCapColumns() {
  try {
    await control.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS user_cap INTEGER`);
    await control.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS user_extra_charge_inr NUMERIC(10,2) NOT NULL DEFAULT 0`);
    await control.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS user_extra_charge_period TEXT NOT NULL DEFAULT 'month'`);
  } catch (e) { console.warn('[saas] ensureUserCapColumns:', e.message); }
}

/**
 * ADMIN_USER_CAP_v1 — read the user-plan info for the modal.
 * Returns base cap (from package.quotas.users.limit), override cap,
 * current users in tenant DB, extra count, and the charge config.
 */
async function api_saas_tenants_getUserPlan(token, slug) {
  await requireSuperAdmin(token);
  await _ensureUserCapColumns();
  const cleanSlug = String(slug || '').trim().toLowerCase();
  if (!cleanSlug) throw new Error('slug required');
  const t = await control.findOneBy('tenants', 'slug', cleanSlug);
  if (!t) throw new Error('Tenant not found');

  // Pull package to get the base cap from quotas.users.limit
  let baseCap = null;
  let packageName = '';
  if (t.package_id) {
    const pkg = await control.findById('packages', t.package_id);
    if (pkg) {
      packageName = pkg.name || '';
      const q = pkg.quotas;
      const quotas = (typeof q === 'string') ? JSON.parse(q || '{}') : (q || {});
      if (quotas.users && (quotas.users.limit != null)) baseCap = Number(quotas.users.limit);
    }
  }

  // Count current users in tenant DB
  let userCount = 0;
  const pool = tenantPool.poolFor(t);
  if (pool) {
    try {
      const r = await pool.query(`SELECT COUNT(*)::int AS c FROM users WHERE COALESCE(is_active, 1) = 1`);
      userCount = Number(r.rows[0].c) || 0;
    } catch (_) {}
  }

  const overrideCap = (t.user_cap != null && t.user_cap !== '') ? Number(t.user_cap) : null;
  const effectiveCap = (overrideCap != null) ? overrideCap : baseCap;
  const extra = (effectiveCap != null) ? Math.max(0, userCount - effectiveCap) : 0;
  const extraChargeInr = Number(t.user_extra_charge_inr || 0);
  const period = String(t.user_extra_charge_period || 'month');

  return {
    slug: t.slug, org_name: t.org_name, package_name: packageName,
    base_cap: baseCap,
    override_cap: overrideCap,
    effective_cap: effectiveCap,
    current_users: userCount,
    extra_users: extra,
    extra_charge_inr_per_user: extraChargeInr,
    period,
    pending_charge_inr: extra * extraChargeInr
  };
}

/** ADMIN_USER_CAP_v1 — update tenant cap + extra-user charge. */
async function api_saas_tenants_setUserPlan(token, payload) {
  const me = await requireFullAdmin(token);
  await _ensureUserCapColumns();
  const p = payload || {};
  const cleanSlug = String(p.slug || '').trim().toLowerCase();
  if (!cleanSlug) throw new Error('slug required');
  const t = await control.findOneBy('tenants', 'slug', cleanSlug);
  if (!t) throw new Error('Tenant not found');

  const capRaw = p.cap;
  const cap = (capRaw === '' || capRaw == null) ? null : Math.max(0, Math.floor(Number(capRaw)));
  const extraInr = Math.max(0, Number(p.extra_inr) || 0);
  const VALID_PERIODS = ['month', 'quarter', 'year'];
  const period = VALID_PERIODS.includes(String(p.period)) ? String(p.period) : 'month';

  await control.query(
    `UPDATE tenants SET user_cap = $1, user_extra_charge_inr = $2, user_extra_charge_period = $3, updated_at = NOW() WHERE id = $4`,
    [cap, extraInr, period, t.id]
  );

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.user_plan_updated',
    detail: JSON.stringify({ slug: t.slug, cap, extra_inr: extraInr, period })
  });

  return { ok: true, slug: t.slug, cap, extra_inr: extraInr, period };
}

/**
 * ADMIN_USER_CAP_v1 — generate an invoice for the tenant's extra users.
 * Amount = extra_users × per-user rate. Tax = 18% GST. Creates a pending
 * invoice that the tenant can pay via the same Cashfree flow as their
 * regular subscription.
 */
async function api_saas_tenants_chargeExtraUsers(token, payload) {
  const me = await requireFullAdmin(token);
  const cleanSlug = String((payload || {}).slug || '').trim().toLowerCase();
  if (!cleanSlug) throw new Error('slug required');
  const plan = await api_saas_tenants_getUserPlan(token, cleanSlug);
  const tenant = await control.findOneBy('tenants', 'slug', cleanSlug);
  if (!tenant) throw new Error('Tenant not found');

  const extra = Number(plan.extra_users) || 0;
  const rate = Number(plan.extra_charge_inr_per_user) || 0;
  if (extra <= 0) throw new Error('No extra users — current count ' + plan.current_users + ' is at or below cap ' + plan.effective_cap);
  if (rate <= 0)  throw new Error('Per-extra-user charge is zero — set a rate first');

  const subtotal = Math.round(extra * rate * 100) / 100;
  const tax = Math.round(subtotal * 18 / 100 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;

  const yr = new Date().getFullYear();
  const cnt = await control.query(`SELECT COUNT(*) AS c FROM invoices`);
  const number = `INV-${yr}-${String(Number(cnt.rows[0].c) + 1).padStart(6, '0')}`;

  const description = extra + ' extra user' + (extra === 1 ? '' : 's') + ' × ₹' + rate.toLocaleString('en-IN') + ' / ' + plan.period + ' (over cap of ' + plan.effective_cap + ')';

  const invoiceId = await control.insert('invoices', {
    tenant_id: tenant.id, number, description,
    subtotal_inr: subtotal, tax_inr: tax, total_inr: total, status: 'pending'
  });

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: tenant.id, event: 'tenant.extra_user_invoice_created',
    detail: JSON.stringify({ slug: tenant.slug, invoice_id: invoiceId, number, extra, rate, period: plan.period, total })
  });

  return { ok: true, invoice_id: invoiceId, number, subtotal_inr: subtotal, tax_inr: tax, total_inr: total, description };
}

/**
 * ADMIN_ADD_USER_v1 — list users in a specific tenant with their
 * per-user monthly cost. Used by the super-admin "👤 Users" modal.
 */
async function api_saas_tenants_listUsers(token, slug) {
  await requireSuperAdmin(token);
  const slugClean = String(slug || '').trim().toLowerCase();
  if (!slugClean) throw new Error('slug required');
  const t = await control.findOneBy('tenants', 'slug', slugClean);
  if (!t) throw new Error('Tenant not found');
  if (t.status === 'deleted') throw new Error('Tenant is deleted');

  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');

  // Defensive auto-migration: add the per-user cost column if missing.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_cost_inr NUMERIC(10,2) NOT NULL DEFAULT 0`).catch(() => {});

  const r = await pool.query(`
    SELECT id, name, email, phone, role, is_active, created_at,
           COALESCE(monthly_cost_inr, 0) AS monthly_cost_inr
    FROM users
    ORDER BY id ASC
  `);
  const users = r.rows.map(u => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    role: u.role, is_active: u.is_active,
    monthly_cost_inr: Number(u.monthly_cost_inr) || 0,
    created_at: u.created_at
  }));
  const totalActive = users.filter(u => Number(u.is_active) === 1).length;
  const totalCost = users
    .filter(u => Number(u.is_active) === 1)
    .reduce((s, u) => s + (Number(u.monthly_cost_inr) || 0), 0);
  return {
    slug: t.slug,
    org_name: t.org_name,
    users,
    counts: { total: users.length, active: totalActive },
    monthly_cost_total_inr: Math.round(totalCost * 100) / 100
  };
}

/**
 * ADMIN_ADD_USER_v1 — super-admin inserts a new user into a tenant DB
 * with a per-user monthly cost. Bypasses tenant-level role checks.
 */
async function api_saas_tenants_addUser(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  const slug = String(p.slug || '').trim().toLowerCase();
  if (!slug) throw new Error('slug required');

  const name = String(p.name || '').trim();
  const email = String(p.email || '').trim().toLowerCase();
  const phone = String(p.phone || '').trim();
  const role = String(p.role || 'sales').trim().toLowerCase();
  const password = String(p.password || '').trim();
  const monthlyCost = Math.max(0, Number(p.monthly_cost_inr) || 0);

  if (!name)  throw new Error('Name required');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Valid email required');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 chars');
  const VALID_ROLES = ['admin', 'manager', 'team_leader', 'sales', 'employee'];
  if (!VALID_ROLES.includes(role)) throw new Error('role must be one of: ' + VALID_ROLES.join(', '));
  if (!_bcrypt) throw new Error('bcrypt library not installed on the server');

  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('Tenant not found');
  if (t.status === 'deleted')   throw new Error('Tenant is deleted');
  if (t.status === 'suspended') throw new Error('Tenant is suspended — restore first');

  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');

  // Defensive migration: add monthly_cost_inr column if missing.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_cost_inr NUMERIC(10,2) NOT NULL DEFAULT 0`).catch(() => {});

  // Duplicate-email check inside the tenant DB.
  const dup = await pool.query(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
  if (dup.rows.length) throw new Error('A user with this email already exists in tenant ' + slug);

  const hash = _bcrypt.hashSync(password, 10);
  const ins = await pool.query(
    `INSERT INTO users (name, email, phone, password_hash, role, is_active, monthly_cost_inr, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, NOW()) RETURNING id`,
    [name, email, phone, hash, role, monthlyCost]
  );
  const userId = ins.rows[0]?.id;

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.user_added_manually',
    detail: JSON.stringify({ slug: t.slug, new_user_id: userId, email, role, monthly_cost_inr: monthlyCost })
  });

  return { ok: true, slug: t.slug, user_id: userId, email, role, monthly_cost_inr: monthlyCost };
}

/**
 * ADMIN_ADD_USER_v1 — update the per-user monthly cost OR active state
 * of an existing user in a tenant.
 */
async function api_saas_tenants_updateUserCost(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  const slug = String(p.slug || '').trim().toLowerCase();
  const userId = Number(p.user_id);
  if (!slug || !userId) throw new Error('slug + user_id required');
  const newCost = Math.max(0, Number(p.monthly_cost_inr) || 0);

  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('Tenant not found');
  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_cost_inr NUMERIC(10,2) NOT NULL DEFAULT 0`).catch(() => {});
  const u = await pool.query(`UPDATE users SET monthly_cost_inr = $1 WHERE id = $2 RETURNING id, email`, [newCost, userId]);
  if (!u.rows.length) throw new Error('User not found in tenant');

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.user_cost_updated',
    detail: JSON.stringify({ slug: t.slug, user_id: userId, monthly_cost_inr: newCost })
  });

  return { ok: true, user_id: userId, monthly_cost_inr: newCost };
}


/**
 * ADMIN_AI_RECORDING_TOGGLE_v1 — super-admin reads & writes the
 * AI_TRANSCRIPTION_ENABLED config inside a specific tenant's DB.
 * '1' = on (default), '0' = off (worker will skip every recording).
 */
async function api_saas_tenants_getAiRecording(token, slug) {
  await requireSuperAdmin(token);
  const cleanSlug = String(slug || '').trim().toLowerCase();
  if (!cleanSlug) throw new Error('slug required');
  const t = await control.findOneBy('tenants', 'slug', cleanSlug);
  if (!t) throw new Error('Tenant not found');
  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');
  let val = '1';
  try {
    const r = await pool.query(`SELECT value FROM config WHERE key = $1 LIMIT 1`, ['AI_TRANSCRIPTION_ENABLED']);
    if (r.rows.length) val = String(r.rows[0].value || '');
  } catch (_) {}
  return { slug: t.slug, enabled: val === '1' };
}

async function api_saas_tenants_setAiRecording(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  const cleanSlug = String(p.slug || '').trim().toLowerCase();
  if (!cleanSlug) throw new Error('slug required');
  const enabled = p.enabled ? '1' : '0';
  const t = await control.findOneBy('tenants', 'slug', cleanSlug);
  if (!t) throw new Error('Tenant not found');
  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('Could not connect to tenant DB');
  try { await pool.query(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`); } catch (_) {}
  await pool.query(
    `INSERT INTO config (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    ['AI_TRANSCRIPTION_ENABLED', enabled]
  );
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: t.id, event: 'tenant.ai_recording_toggled',
    detail: JSON.stringify({ slug: t.slug, enabled: enabled === '1' })
  });
  return { ok: true, slug: t.slug, enabled: enabled === '1' };
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
  api_saas_tenants_loginAs,
  api_saas_tenants_reseedKb,
  api_saas_tenants_resetUserPassword,
  api_saas_tenants_runBootstrap,
  api_saas_tenants_installPack,
  api_saas_fb_backfillRegistry,
  api_saas_tenants_listUsers,
  api_saas_tenants_addUser,
  api_saas_tenants_updateUserCost,
  api_saas_tenants_getUserPlan,
  api_saas_tenants_setUserPlan,
  api_saas_tenants_chargeExtraUsers,
  api_saas_tenants_getAiRecording,
  api_saas_tenants_setAiRecording
};
