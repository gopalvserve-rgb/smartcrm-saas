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

function signToken(user) {
  const payload = {
    id: user.id,
    email: user.email,
    role: user.role
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  if (!token) throw new Error('No token');
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { throw new Error('Invalid or expired token'); }
}

async function authUser(token) {
  const decoded = verifyToken(token);
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
  if (me.role === 'manager') collect(me.id, 10);
  if (me.role === 'team_leader') collect(me.id, 2);
  return [...result];
}

module.exports = {
  hashPassword, verifyPassword,
  signToken, verifyToken, authUser, getVisibleUserIds
};
