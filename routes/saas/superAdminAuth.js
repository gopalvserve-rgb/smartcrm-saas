/**
 * Super-admin auth — login + token verification.
 *
 * Super-admins are platform-level users (the SaaS owner + their staff).
 * Distinct from tenant admins, who only operate inside their own
 * tenant DB. Tokens are signed JWTs with an `sa: true` flag so they
 * can't accidentally be used to call tenant APIs.
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const control = require('../../control/db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const TOKEN_TTL = '30d';

function signToken(sa) {
  return jwt.sign({ id: sa.id, email: sa.email, role: sa.role, sa: true }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

async function authSuperAdmin(token) {
  if (!token) throw new Error('Not signed in');
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (_) { throw new Error('Invalid or expired token'); }
  if (!payload.sa) throw new Error('Not a super-admin token');
  const sa = await control.findById('super_admins', payload.id);
  if (!sa || Number(sa.is_active) === 0) throw new Error('Super-admin account is inactive');
  return sa;
}

async function requireSuperAdmin(token) {
  const sa = await authSuperAdmin(token);
  if (sa.role !== 'admin' && sa.role !== 'assistant') {
    throw new Error('Insufficient permissions');
  }
  return sa;
}

async function requireFullAdmin(token) {
  const sa = await authSuperAdmin(token);
  if (sa.role !== 'admin') throw new Error('Admin only');
  return sa;
}

// ---- API: login -------------------------------------------------
async function api_saas_admin_login(_token, payload) {
  const p = payload || {};
  const email = String(p.email || '').toLowerCase().trim();
  const password = String(p.password || '');
  if (!email || !password) throw new Error('Email and password required');
  const sa = await control.findOneBy('super_admins', 'email', email);
  if (!sa || Number(sa.is_active) === 0) throw new Error('Invalid credentials');
  const ok = bcrypt.compareSync(password, sa.password_hash);
  if (!ok) throw new Error('Invalid credentials');
  await control.update('super_admins', sa.id, { last_login_at: control.nowIso() });
  return {
    token: signToken(sa),
    user: { id: sa.id, name: sa.name, email: sa.email, role: sa.role }
  };
}

async function api_saas_admin_me(token) {
  const sa = await authSuperAdmin(token);
  return { id: sa.id, name: sa.name, email: sa.email, role: sa.role };
}

// ---- API: list super-admins (Super Assistants tab) -------------
async function api_saas_admin_list(token) {
  await requireFullAdmin(token);
  const r = await control.query(
    `SELECT id, name, email, role, is_active, last_login_at, created_at FROM super_admins ORDER BY id ASC`
  );
  return r.rows;
}

async function api_saas_admin_save(token, payload) {
  await requireFullAdmin(token);
  const p = payload || {};
  if (!p.name || !p.email) throw new Error('Name and email are required');
  const data = {
    name: String(p.name).trim(),
    email: String(p.email).toLowerCase().trim(),
    role: ['admin', 'assistant', 'viewer'].includes(p.role) ? p.role : 'assistant',
    is_active: Number(p.is_active) === 0 ? 0 : 1
  };
  if (p.password) {
    data.password_hash = bcrypt.hashSync(String(p.password), 10);
  }
  if (p.id) {
    await control.update('super_admins', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  if (!p.password) throw new Error('Password required for new super-admin');
  const id = await control.insert('super_admins', data);
  return { id, ok: true };
}

async function api_saas_admin_delete(token, id) {
  const me = await requireFullAdmin(token);
  if (Number(id) === Number(me.id)) throw new Error("You can't deactivate yourself");
  await control.update('super_admins', id, { is_active: 0 });
  return { ok: true };
}

module.exports = {
  authSuperAdmin, requireSuperAdmin, requireFullAdmin, signToken,
  api_saas_admin_login, api_saas_admin_me,
  api_saas_admin_list, api_saas_admin_save, api_saas_admin_delete
};
