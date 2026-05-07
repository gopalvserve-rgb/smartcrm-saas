/**
 * routes/roles.js â per-tenant custom roles
 *
 * Each tenant can define their own role keys in addition to the four
 * built-in "system" ones (admin, manager, team_leader, sales). System
 * roles are seeded on boot and cannot be deleted or renamed.
 *
 * Roles drive:
 *   - the User-edit form's "Role" dropdown
 *   - the Permissions matrix (rows in role_permissions are keyed by role name)
 *   - utils/auth.js getVisibleUserIds() hierarchy
 *
 * Custom-role visibility default:
 *   hierarchy_level 0 = admin-equivalent (sees everyone)
 *   1 = manager-equivalent (whole subtree under self)
 *   2 = team_leader-equivalent (2 levels of reports)
 *   3+ = sales-equivalent (self only)
 *
 * The `is_system` flag protects the four seed rows from being mutated.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const SYSTEM_ROLES = [
  { key: 'admin',       label: 'Admin',       hierarchy_level: 0 },
  { key: 'manager',     label: 'Manager',     hierarchy_level: 1 },
  { key: 'team_leader', label: 'Team Leader', hierarchy_level: 2 },
  { key: 'sales',       label: 'Sales',       hierarchy_level: 3 }
];

// Create the roles table and seed the four built-in rows if needed.
// Fully idempotent â safe to call on every request so fresh tenant DBs
// self-heal automatically without a manual migration step.
async function _ensureSystemRoles() {
  // Step 1: guarantee the table exists (CREATE TABLE IF NOT EXISTS is a no-op
  // when it already exists, so this is safe to run every time).
  await db.query(`
    CREATE TABLE IF NOT EXISTS roles (
      id              SERIAL PRIMARY KEY,
      key             TEXT UNIQUE NOT NULL,
      label           TEXT NOT NULL,
      hierarchy_level INTEGER NOT NULL DEFAULT 3,
      is_system       INTEGER NOT NULL DEFAULT 0,
      is_active       INTEGER NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_roles_key    ON roles(key)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active)`);

  // Step 2: seed the four system roles.
  for (const r of SYSTEM_ROLES) {
    await db.query(
      `INSERT INTO roles (key, label, hierarchy_level, is_system, is_active)
       VALUES ($1, $2, $3, 1, 1) ON CONFLICT (key) DO NOTHING`,
      [r.key, r.label, r.hierarchy_level]
    ).catch(() => {});
  }
}

async function api_roles_list(token) {
  await authUser(token);
  await _ensureSystemRoles();
  const rows = await db.getAll('roles').catch(() => []);
  // Stable ordering: hierarchy_level asc, then label.
  return rows
    .filter(r => Number(r.is_active) === 1)
    .sort((a, b) =>
      (Number(a.hierarchy_level) - Number(b.hierarchy_level)) ||
      String(a.label).localeCompare(String(b.label)));
}

// Admin-only create / update.
//   payload: { id?, key, label, hierarchy_level }
async function api_roles_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  const key   = String(p.key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const label = String(p.label || '').trim();
  const level = Math.max(0, Math.min(99, parseInt(p.hierarchy_level, 10) || 3));
  if (!key)   throw new Error('Role key required');
  if (!label) throw new Error('Role label required');

  if (p.id) {
    const existing = await db.findById('roles', p.id);
    if (!existing) throw new Error('Role not found');
    if (Number(existing.is_system) === 1 && existing.key !== key) {
      throw new Error('Cannot rename a system role');
    }
    await db.update('roles', p.id, {
      // Allow updating label + level on system roles, but not the key.
      key: Number(existing.is_system) === 1 ? existing.key : key,
      label, hierarchy_level: level
    });
    return { ok: true, id: p.id };
  }

  // Create â must not collide with existing key
  const dup = await db.findOneBy('roles', 'key', key);
  if (dup) throw new Error(`Role key "${key}" already exists`);
  const id = await db.insert('roles', {
    key, label, hierarchy_level: level, is_system: 0, is_active: 1
  });
  return { ok: true, id };
}

async function api_roles_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const r = await db.findById('roles', id);
  if (!r) throw new Error('Role not found');
  if (Number(r.is_system) === 1) throw new Error('Cannot delete a system role');

  // Don't orphan users â refuse if any user is currently on this role.
  const usingIt = await db.query(
    `SELECT COUNT(*)::int AS n FROM users WHERE role = $1 AND COALESCE(is_active,1) = 1`,
    [r.key]
  );
  const n = Number(usingIt.rows[0]?.n || 0);
  if (n > 0) {
    throw new Error(`Cannot delete: ${n} active user${n === 1 ? '' : 's'} still on role "${r.label}". Move them to another role first.`);
  }

  // Soft-delete: set is_active=0 so historical role_permissions rows
  // and any inactive-user references don't go dangling.
  await db.update('roles', id, { is_active: 0 });
  return { ok: true };
}

module.exports = {
  api_roles_list, api_roles_save, api_roles_delete,
  SYSTEM_ROLES, _ensureSystemRoles
};
