/**
 * routes/modules.js
 *
 * Tenant-side endpoint: returns the list of module keys that are
 * currently active for the calling tenant. Used by the SPA on boot
 * (warmCache) to filter the sidebar + Settings rail in real time —
 * the super-admin can flip a module ON/OFF and the tenant's next
 * page load will reflect it.
 */

'use strict';

const control = require('../control/db');
const tenantDb = require('../db/pg');
const { authUser } = require('../utils/auth');
const { MODULE_CATALOG, resolveModules } = require('../utils/moduleCatalog');

async function api_modules_active(token) {
  await authUser(token);

  // Resolve current tenant slug from the AsyncLocalStorage context
  let slug = '';
  try {
    const store = tenantDb.tenantStorage && tenantDb.tenantStorage.getStore && tenantDb.tenantStorage.getStore();
    slug = (store && store.slug) || '';
  } catch (_) {}

  // Default fallback: if we can't resolve the tenant, return everything
  // default_on so single-tenant deployments keep working as before.
  if (!slug) {
    return {
      active: MODULE_CATALOG.filter(m => m.default_on || m.always_on).map(m => m.key),
      catalog: MODULE_CATALOG.map(m => ({
        key: m.key, label: m.label, nav_ids: m.nav_ids, settings_ids: m.settings_ids
      })),
      _fallback: true,
    };
  }

  let row = null;
  try {
    const r = await control.query(`SELECT id, slug, modules_json FROM tenants WHERE slug = $1`, [slug]);
    row = r.rows[0];
  } catch (_) { /* control DB unreachable — fall back below */ }

  const active = resolveModules(row || {});
  return {
    active,
    catalog: MODULE_CATALOG.map(m => ({
      key: m.key, label: m.label, nav_ids: m.nav_ids, settings_ids: m.settings_ids
    })),
  };
}

module.exports = { api_modules_active };
