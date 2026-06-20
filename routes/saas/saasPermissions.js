'use strict';
/**
 * SUPER_ADMIN_PERMS_v1 (2026-06-20) — module-wise permission matrix
 * for super-admin roles. Mirrors the tenant CRM's routes/permissions.js.
 *
 * Built-in roles: admin / assistant / viewer  (see super_admins.role)
 *
 * Catalog format: <module>.<action> where action ∈ view, add, edit, delete.
 * 'view' is for single-record / detail; 'list' folds into 'view' to keep
 * the matrix manageable (tenant CRM does the same).
 *
 * Storage: super_admin_role_permissions table, one row per (role, perm).
 * If a row exists, it overrides DEFAULTS; otherwise DEFAULTS apply.
 */

const control = require('../../control/db');
const { requireSuperAdmin, requireFullAdmin } = require('./superAdminAuth');

const CATALOG = [
  // ─── Dashboard ────────────────────────────────────────────────
  { module: 'Dashboard',         key: 'dashboard.view',          label: 'View dashboard' },

  // ─── Packages ─────────────────────────────────────────────────
  { module: 'Packages',          key: 'packages.view',           label: 'View packages' },
  { module: 'Packages',          key: 'packages.add',            label: 'Add new package' },
  { module: 'Packages',          key: 'packages.edit',           label: 'Edit existing package' },
  { module: 'Packages',          key: 'packages.delete',         label: 'Delete package' },

  // ─── Tenants ──────────────────────────────────────────────────
  { module: 'Tenants',           key: 'tenants.view',            label: 'View tenant list + details' },
  { module: 'Tenants',           key: 'tenants.add',             label: 'Create tenant manually' },
  { module: 'Tenants',           key: 'tenants.edit',            label: 'Edit tenant (package, settings)' },
  { module: 'Tenants',           key: 'tenants.suspend',         label: 'Suspend / restore tenant' },
  { module: 'Tenants',           key: 'tenants.delete',          label: 'Delete tenant (pending delete)' },
  { module: 'Tenants',           key: 'tenants.login_as',        label: 'Login as tenant (sudo)' },

  // ─── Invoices ─────────────────────────────────────────────────
  { module: 'Invoices',          key: 'invoices.view',           label: 'View invoices' },
  { module: 'Invoices',          key: 'invoices.add',            label: 'Create invoice manually' },
  { module: 'Invoices',          key: 'invoices.mark_paid',      label: 'Mark invoice paid' },
  { module: 'Invoices',          key: 'invoices.void',           label: 'Void invoice' },

  // ─── Signup Requests ──────────────────────────────────────────
  { module: 'Signup Requests',   key: 'signup_req.view',         label: 'View pending requests' },
  { module: 'Signup Requests',   key: 'signup_req.edit',         label: 'Edit pending request' },
  { module: 'Signup Requests',   key: 'signup_req.approve',      label: 'Approve → provision tenant' },
  { module: 'Signup Requests',   key: 'signup_req.reject',       label: 'Reject signup request' },

  // ─── Webhooks / Errors / Crashes ──────────────────────────────
  { module: 'Logs',              key: 'webhooks.view',           label: 'View webhook logs' },
  { module: 'Logs',              key: 'errors.view',             label: 'View error logs' },
  { module: 'Logs',              key: 'errors.resolve',          label: 'Resolve / reopen errors' },
  { module: 'Logs',              key: 'crashes.view',            label: 'View crashes' },

  // ─── AI Costing / Finance / White-Label ───────────────────────
  { module: 'AI & Finance',      key: 'ai_costing.view',         label: 'View AI cost dashboard' },
  { module: 'AI & Finance',      key: 'finance.view',            label: 'View finance dashboard' },
  { module: 'AI & Finance',      key: 'wl_billing.view',         label: 'View white-label billing' },
  { module: 'AI & Finance',      key: 'wl_billing.edit',         label: 'Edit white-label billing' },

  // ─── Announcements / Custom requirements / Tickets ────────────
  { module: 'Operations',        key: 'announcements.view',      label: 'View announcements' },
  { module: 'Operations',        key: 'announcements.manage',    label: 'Create / edit announcements' },
  { module: 'Operations',        key: 'requirements.view',       label: 'View custom requirements' },
  { module: 'Operations',        key: 'requirements.manage',     label: 'Manage custom requirements' },
  { module: 'Operations',        key: 'tickets.view',            label: 'View support tickets' },
  { module: 'Operations',        key: 'tickets.respond',         label: 'Respond / close tickets' },
  { module: 'Operations',        key: 'tickets.assign',          label: 'Assign tickets to teammates' },

  // ─── Admins / Settings / Device Health ────────────────────────
  { module: 'Admin & Settings',  key: 'admins.view',             label: 'View super-admins' },
  { module: 'Admin & Settings',  key: 'admins.add',              label: 'Create teammate' },
  { module: 'Admin & Settings',  key: 'admins.edit',             label: 'Edit teammate / role' },
  { module: 'Admin & Settings',  key: 'admins.delete',           label: 'Remove teammate' },
  { module: 'Admin & Settings',  key: 'perms.manage',            label: 'Edit role permission matrix' },
  { module: 'Admin & Settings',  key: 'device_health.view',      label: 'View device health' },
  { module: 'Admin & Settings',  key: 'settings.edit',           label: 'Edit platform settings' }
];

// Default matrix — what every freshly-created tenant of a given role
// can do until the matrix is customised.
const DEFAULTS = {
  admin: (() => {
    const all = {};
    CATALOG.forEach(c => { all[c.key] = 1; });
    return all;
  })(),
  assistant: {
    // View almost everything, edit operational stuff, can't delete tenants
    // and can't manage other admins / permissions / billing settings.
    'dashboard.view': 1,
    'packages.view': 1, 'packages.add': 0, 'packages.edit': 0, 'packages.delete': 0,
    'tenants.view': 1,  'tenants.add': 1,  'tenants.edit': 1,
    'tenants.suspend': 0, 'tenants.delete': 0, 'tenants.login_as': 0,
    'invoices.view': 1, 'invoices.add': 1, 'invoices.mark_paid': 1, 'invoices.void': 0,
    'signup_req.view': 1, 'signup_req.edit': 1, 'signup_req.approve': 1, 'signup_req.reject': 1,
    'webhooks.view': 1, 'errors.view': 1, 'errors.resolve': 1, 'crashes.view': 1,
    'ai_costing.view': 1, 'finance.view': 1, 'wl_billing.view': 1, 'wl_billing.edit': 0,
    'announcements.view': 1, 'announcements.manage': 1,
    'requirements.view': 1, 'requirements.manage': 1,
    'tickets.view': 1, 'tickets.respond': 1, 'tickets.assign': 1,
    'admins.view': 1, 'admins.add': 0, 'admins.edit': 0, 'admins.delete': 0,
    'perms.manage': 0,
    'device_health.view': 1, 'settings.edit': 0
  },
  viewer: (() => {
    // View-only on everything
    const v = {};
    CATALOG.forEach(c => {
      v[c.key] = c.key.endsWith('.view') ? 1 : 0;
    });
    v['dashboard.view'] = 1;
    return v;
  })()
};

let _matrixCache = null;
let _matrixCacheAt = 0;
const MATRIX_TTL = 30 * 1000; // 30s

async function _loadMatrix() {
  if (_matrixCache && (Date.now() - _matrixCacheAt) < MATRIX_TTL) return _matrixCache;
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const r = await control.query(`SELECT role, permission, is_granted FROM super_admin_role_permissions`);
    (r.rows || []).forEach(row => {
      if (!out[row.role]) out[row.role] = {};
      out[row.role][row.permission] = Number(row.is_granted) === 1 ? 1 : 0;
    });
  } catch (e) { console.warn('[saasPermissions] load failed:', e.message); }
  _matrixCache = out;
  _matrixCacheAt = Date.now();
  return out;
}

function _invalidateMatrix() { _matrixCache = null; _matrixCacheAt = 0; }

/**
 * Check whether a super-admin can perform an action. Use in any endpoint:
 *
 *   const me = await requireSuperAdmin(token);
 *   await require('./saasPermissions').requirePerm(me, 'tenants.delete');
 */
async function can(superAdmin, permission) {
  if (!superAdmin) return false;
  const matrix = await _loadMatrix();
  const role = String(superAdmin.role || '').toLowerCase();
  const grants = matrix[role] || {};
  return Number(grants[permission]) === 1;
}

async function requirePerm(superAdmin, permission) {
  if (await can(superAdmin, permission)) return true;
  const err = new Error('Permission denied: ' + permission);
  err.code = 'PERMISSION_DENIED';
  throw err;
}

/* ───────── ADMIN endpoints ───────── */
async function api_saas_perms_get(token) {
  await requireSuperAdmin(token);
  // Group catalog by module for the SPA matrix render
  const grouped = {};
  CATALOG.forEach(c => {
    if (!grouped[c.module]) grouped[c.module] = [];
    grouped[c.module].push({ key: c.key, label: c.label });
  });
  return {
    catalog: CATALOG,
    grouped,
    roles: ['admin', 'assistant', 'viewer'],
    matrix: await _loadMatrix(),
    defaults: DEFAULTS
  };
}

async function api_saas_perms_save(token, payload) {
  const me = await requireFullAdmin(token);
  const p = payload || {};
  const matrix = p.matrix || {};
  // Validate role + permission keys before writing
  const validKeys = new Set(CATALOG.map(c => c.key));
  const validRoles = new Set(['admin', 'assistant', 'viewer']);
  let saved = 0;
  for (const [role, perms] of Object.entries(matrix)) {
    if (!validRoles.has(role)) continue;
    for (const [perm, val] of Object.entries(perms)) {
      if (!validKeys.has(perm)) continue;
      const granted = Number(val) === 1 ? 1 : 0;
      try {
        await control.query(`
          INSERT INTO super_admin_role_permissions (role, permission, is_granted, updated_by, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (role, permission)
          DO UPDATE SET is_granted = EXCLUDED.is_granted, updated_by = EXCLUDED.updated_by, updated_at = NOW()
        `, [role, perm, granted, me.email || '']);
        saved++;
      } catch (e) { console.warn('[perms save]', role, perm, e.message); }
    }
  }
  _invalidateMatrix();
  try {
    await control.insert('audit_log', {
      actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
      event: 'super_admin_perms.saved',
      detail: JSON.stringify({ rows: saved })
    });
  } catch (_) {}
  return { ok: true, saved };
}

async function api_saas_perms_reset(token, payload) {
  const me = await requireFullAdmin(token);
  const role = String(payload && payload.role || '').toLowerCase();
  if (!['admin', 'assistant', 'viewer'].includes(role)) throw new Error('Invalid role');
  await control.query(`DELETE FROM super_admin_role_permissions WHERE role = $1`, [role]);
  _invalidateMatrix();
  try {
    await control.insert('audit_log', {
      actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
      event: 'super_admin_perms.reset',
      detail: JSON.stringify({ role })
    });
  } catch (_) {}
  return { ok: true, role, reset_to: 'defaults' };
}

module.exports = {
  CATALOG, DEFAULTS,
  can, requirePerm,
  api_saas_perms_get, api_saas_perms_save, api_saas_perms_reset
};
