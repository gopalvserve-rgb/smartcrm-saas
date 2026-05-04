/**
 * routes/permissions.js — role-based permission matrix
 *
 * Permissions catalog (string keys):
 *   leads.view           scope: self | team | global
 *   leads.create
 *   leads.edit           scope: self | team | global
 *   leads.delete         scope: self | team | global
 *   leads.bulk_edit
 *   leads.export
 *   users.view
 *   users.create
 *   users.edit
 *   users.delete
 *   reports.view
 *   settings.edit
 *   automations.manage
 *   rules.manage
 *   salary.view_team
 *   salary.edit
 *   attendance.view_team
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const CATALOG = [
  { key: 'leads.view',          label: 'View leads',       scoped: true },
  { key: 'leads.create',        label: 'Create leads' },
  { key: 'leads.edit',          label: 'Edit leads',       scoped: true },
  { key: 'leads.delete',        label: 'Delete leads',     scoped: true },
  { key: 'leads.bulk_edit',     label: 'Bulk edit leads' },
  { key: 'leads.export',        label: 'Export leads' },
  { key: 'users.view',          label: 'View users' },
  { key: 'users.create',        label: 'Create users' },
  { key: 'users.edit',          label: 'Edit users' },
  { key: 'users.delete',        label: 'Delete users' },
  { key: 'reports.view',        label: 'View reports' },
  { key: 'settings.edit',       label: 'Edit settings' },
  { key: 'automations.manage',  label: 'Manage automations' },
  { key: 'rules.manage',        label: 'Manage auto-assign rules' },
  { key: 'salary.view_team',    label: 'View team salary' },
  { key: 'salary.edit',         label: 'Edit salary' },
  { key: 'attendance.view_team',label: 'View team attendance' }
];

// Defaults used when no custom matrix is saved
const DEFAULTS = {
  admin: {
    'leads.view': 'global', 'leads.create': 1, 'leads.edit': 'global', 'leads.delete': 'global',
    'leads.bulk_edit': 1, 'leads.export': 1,
    'users.view': 1, 'users.create': 1, 'users.edit': 1, 'users.delete': 1,
    'reports.view': 1, 'settings.edit': 1, 'automations.manage': 1, 'rules.manage': 1,
    'salary.view_team': 1, 'salary.edit': 1, 'attendance.view_team': 1
  },
  manager: {
    'leads.view': 'team', 'leads.create': 1, 'leads.edit': 'team', 'leads.delete': 'team',
    'leads.bulk_edit': 1, 'leads.export': 1,
    'users.view': 1, 'users.create': 1, 'users.edit': 1, 'users.delete': 0,
    'reports.view': 1, 'settings.edit': 0, 'automations.manage': 0, 'rules.manage': 1,
    'salary.view_team': 1, 'salary.edit': 0, 'attendance.view_team': 1
  },
  team_leader: {
    'leads.view': 'team', 'leads.create': 1, 'leads.edit': 'team', 'leads.delete': 'self',
    'leads.bulk_edit': 1, 'leads.export': 1,
    'users.view': 1, 'users.create': 0, 'users.edit': 0, 'users.delete': 0,
    'reports.view': 1, 'settings.edit': 0, 'automations.manage': 0, 'rules.manage': 0,
    'salary.view_team': 0, 'salary.edit': 0, 'attendance.view_team': 1
  },
  sales: {
    'leads.view': 'self', 'leads.create': 1, 'leads.edit': 'self', 'leads.delete': 0,
    'leads.bulk_edit': 0, 'leads.export': 0,
    'users.view': 0, 'users.create': 0, 'users.edit': 0, 'users.delete': 0,
    'reports.view': 0, 'settings.edit': 0, 'automations.manage': 0, 'rules.manage': 0,
    'salary.view_team': 0, 'salary.edit': 0, 'attendance.view_team': 0
  }
};

async function _matrix() {
  const rows = await db.getAll('role_permissions').catch(() => []);
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  rows.forEach(r => {
    if (!out[r.role]) out[r.role] = {};
    if (Number(r.is_granted) === 0) out[r.role][r.permission] = 0;
    else                            out[r.role][r.permission] = r.scope || 1;
  });
  return out;
}

async function api_permissions_get(token) {
  await authUser(token);
  return { catalog: CATALOG, matrix: await _matrix() };
}

async function api_permissions_save(token, matrix) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Upsert each role+permission
  const existing = await db.getAll('role_permissions');
  const byKey = {};
  existing.forEach(r => { byKey[r.role + '|' + r.permission] = r; });
  for (const [role, perms] of Object.entries(matrix || {})) {
    for (const [perm, val] of Object.entries(perms)) {
      const row = byKey[role + '|' + perm];
      const payload = (val && val !== 0)
        ? { is_granted: 1, scope: typeof val === 'string' ? val : null }
        : { is_granted: 0, scope: null };
      if (row) await db.update('role_permissions', row.id, payload);
      else     await db.insert('role_permissions', Object.assign({ role, permission: perm }, payload));
    }
  }
  return { ok: true };
}

async function can(user, permission, opts) {
  if (!user) return false;
  const m = await _matrix();
  const v = m[user.role]?.[permission];
  if (!v) return false;
  if (v === 1) return true;
  // scoped: 'self' | 'team' | 'global' — the route should pass targetUserId+visible to decide
  if (typeof v === 'string' && opts?.scope) return _scopeAllows(v, opts);
  return v; // return the scope string for callers that want it
}

function _scopeAllows(grantedScope, opts) {
  const { targetUserId, actorId, visible } = opts;
  if (grantedScope === 'global') return true;
  if (grantedScope === 'team')   return (visible || []).includes(Number(targetUserId));
  if (grantedScope === 'self')   return Number(targetUserId) === Number(actorId);
  return false;
}

module.exports = { api_permissions_get, api_permissions_save, can, CATALOG, DEFAULTS };
