/**
 * routes/saas/tenantModules.js
 *
 * Super-admin API for toggling modules on/off per tenant.
 * Module list is defined in utils/moduleCatalog.js.
 *
 * Endpoints (all require super-admin):
 *   api_saas_modules_catalog(token)
 *     → { modules: [{ key, label, description, default_on, always_on }] }
 *
 *   api_saas_tenant_modules_get(token, tenant_id)
 *     → { active: ['leads','calls',…], stored: <modules_json>, catalog: [...] }
 *
 *   api_saas_tenant_modules_set(token, tenant_id, module_keys)
 *     module_keys = ['leads','calls'] OR null/undefined to reset to defaults
 *     → { ok: true, active: [...] }
 */

'use strict';

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');
const { MODULE_CATALOG, resolveModules } = require('../../utils/moduleCatalog');

function _publicCatalog() {
  return MODULE_CATALOG.map(m => ({
    key: m.key, label: m.label, description: m.description,
    default_on: m.default_on, always_on: m.always_on,
    nav_ids: m.nav_ids, settings_ids: m.settings_ids,
  }));
}

async function api_saas_modules_catalog(token) {
  await requireSuperAdmin(token);
  return { modules: _publicCatalog() };
}

async function api_saas_tenant_modules_get(token, tenant_id) {
  await requireSuperAdmin(token);
  const id = Number(tenant_id);
  if (!id) throw new Error('tenant_id required');
  const r = await control.query(`SELECT id, slug, modules_json FROM tenants WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw new Error('Tenant not found');
  const active = resolveModules(row);
  return {
    tenant_id: row.id, tenant_slug: row.slug,
    active,
    stored: row.modules_json || null,
    catalog: _publicCatalog(),
  };
}

async function api_saas_tenant_modules_set(token, tenant_id, module_keys) {
  await requireSuperAdmin(token);
  const id = Number(tenant_id);
  if (!id) throw new Error('tenant_id required');
  let store = null;
  if (Array.isArray(module_keys)) {
    const validKeys = new Set(MODULE_CATALOG.map(m => m.key));
    store = module_keys
      .map(k => String(k))
      .filter(k => validKeys.has(k));
  }
  await control.query(
    `UPDATE tenants SET modules_json = $1, updated_at = NOW() WHERE id = $2`,
    [store ? JSON.stringify(store) : null, id]
  );
  const r = await control.query(`SELECT id, slug, modules_json FROM tenants WHERE id = $1`, [id]);
  return { ok: true, active: resolveModules(r.rows[0]) };
}

module.exports = {
  api_saas_modules_catalog,
  api_saas_tenant_modules_get,
  api_saas_tenant_modules_set,
};
