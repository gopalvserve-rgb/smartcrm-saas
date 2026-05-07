/**
 * routes/roles.js — per-tenant custom roles
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const SYSTEM_ROLES = [
  { key: 'admin', label: 'Admin', hierarchy_level: 0 },
  { key: 'manager', label: 'Manager', hierarchy_level: 1 },
  { key: 'team_leader', label: 'Team Leader', hierarchy_level: 2 },
  { key: 'sales', label: 'Sales', hierarchy_level: 3 }
];

async function _ensureSystemRoles() {
  for (const r of SYSTEM_ROLES) {
    const existing = await db.findOneBy('roles', 'key', r.key).catch(() => null);
    if (!existing) {
      await db.insert('roles', { key: r.key, label: r.label, hierarchy_level: r.hierarchy_level, is_system: 1, is_active: 1 }).catch(() => {});
    }
  }
}

async function api_roles_list(token) {
  await authUser(token);
  await _ensureSystemRoles();
  const rows = await db.getAll('roles').catch(() => []);
  return rows.filter(r => Number(r.is_active) === 1).sort((a, b) => (Number(a.hierarchy_level) - Number(b.hierarchy_level)) || String(a.label).localeCompare(String(b.label)));
}

async function api_roles_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const key = String(p.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label = String(p.label || '').trim();
  const level = Math.max(0, Math.min(99, parseInt(p.hierarchy_level, 10) || 3));
  if (!key) throw new Error('Role key required');
  if (!label) throw new Error('Role label required');
  if (p.id) {
    const existing = await db.findById('roles', p.id);
    if (!existing) throw new Error('Role not found');
    if (Number(existing.is_system) === 1 && existing.key !== key) throw new Error('Cannot rename a system role');
    await db.update('roles', p.id, { key: Number(existing.is_system) === 1 ? existing.key : key, label, hierarchy_level: level });
    return { ok: true, id: p.id };
  }
  const dup = await db.findOneBy('roles', 'key', key);
  if (dup) throw new Error('Role key "' + key + '" already exists');
  const id = await db.insert('roles', { key, label, hierarchy_level: level, is_system: 0, is_active: 1 });
  return { ok: true, id };
}

async function api_roles_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const r = await db.findById('roles', id);
  if (!r) throw new Error('Role not found');
  if (Number(r.is_system) === 1) throw new Error('Cannot delete a system role');
  const usingIt = await db.query('SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND COALESCE(is_active,1) = 1', [r.key]);
  const n = Number(usingIt.rows[0]?.n || 0);
  if (n > 0) throw new Error('Cannot delete: ' + n + ' active user' + (n === 1 ? '' : 's') + ' still on role "' + r.label + '". Move them to another role first.');
  await db.update('roles', id, { is_active: 0 });
  return { ok: true };
}

module.exports = { api_roles_list, api_roles_save, api_roles_delete, SYSTEM_ROLES, _ensureSystemRoles };
