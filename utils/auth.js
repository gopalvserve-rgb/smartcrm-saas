/**
 * utils/auth.js — JWT tokens + user lookup
 * Replaces GAS Auth.gs
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db/pg');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TOKEN_TTL = '30d';

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function verifyPassword(plain, hash) {
  if (!hash) return false;
  try { return bcrypt.compareSync(String(plain), hash); }
  catch(_) { return false; }
}

function signToken(user, tenantSlug) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role
  };
  // Bind the token to the issuing tenant — prevents cross-tenant token reuse.
  // Tokens issued in single-tenant deployments (no tenantStorage context) get
  // no slug claim; the API guard treats absence as "any" for backwards compat
  // on legacy single-tenant CRMs but blocks slug-mismatch on multi-tenant.
  if (tenantSlug) payload.t = String(tenantSlug);
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  if (!token) throw new Error('No token');
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { throw new Error('Invalid or expired token'); }
}

/**
 * Cross-tenant guard. Throws if the token's tenant_slug claim does not
 * match the active tenant. Single-tenant deployments (no tenantStorage
 * context, no slug on the token) pass through.
 */
function _activeTenantSlug() {
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    return store && store.slug ? String(store.slug) : null;
  } catch (_) { return null; }
}

async function authUser(token) {
  const decoded = verifyToken(token);
  // Cross-tenant guard
  const activeSlug = _activeTenantSlug();
  if (activeSlug && decoded.t && String(decoded.t) !== activeSlug) {
    throw new Error('Token does not belong to this workspace — please sign in.');
  }
  // Legacy tokens without tenant slug claim are still accepted to keep
  // existing users logged in after this deploy (they'll get a fresh
  // slug-bound token on next login). Log so we can monitor migration.
  if (activeSlug && !decoded.t) {
    console.warn('[auth] legacy token without tenant_slug for tenant=' + activeSlug + ' user=' + decoded.id);
  }
  const user = await db.findById('users', decoded.id);
  if (!user || !user.is_active) throw new Error('User inactive or not found');
  return user;
}

/**
 * Returns array of user IDs visible to `me`:
 *  - admin       : all users
 *  - manager     : self + everyone under them (recursively via parent_id)
 *  - team_leader : self + direct reports (depth 1) + their directs (depth 2)
 *  - sales       : just self
 */
async function getVisibleUserIds(me) {
  const all = await db.getAll('users');
  if (me.role === 'admin') return all.map(u => Number(u.id));

  const byParent = new Map();
  all.forEach(u => {
    const pid = Number(u.parent_id) || 0;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(Number(u.id));
  });

  const result = new Set([Number(me.id)]);
  if (me.role === 'sales' || me.role === 'employee') return [...result];

  function collect(id, depth) {
    if (depth <= 0) return;
    const kids = byParent.get(Number(id)) || [];
    kids.forEach(k => { result.add(k); collect(k, depth - 1); });
  }
  if (me.role === 'manager')      { collect(me.id, 10); return [...result]; }
  if (me.role === 'team_leader')  { collect(me.id, 2);  return [...result]; }

  // ----- Custom (non-system) role: look up hierarchy_level from the
  // roles table. 0 = admin-equivalent, 1+ = depth of subtree to expose.
  // Anything not in the table defaults to "self only" (sales-like) so
  // we fail closed when an unknown role string lands on a user. -----
  try {
    const r = await db.findOneBy('roles', 'key', me.role).catch(() => null);
    const lvl = r ? Number(r.hierarchy_level) : null;
    if (lvl === 0) return all.map(u => Number(u.id));      // admin-equivalent
    if (lvl != null && lvl > 0) {
      const depth = lvl === 1 ? 10 : (lvl === 2 ? 2 : 0);
      collect(me.id, depth);
      return [...result];
    }
  } catch (_) { /* fall through to self-only */ }
  return [...result];
}

module.exports = {
  hashPassword, verifyPassword,
  signToken, verifyToken, authUser, getVisibleUserIds
};
