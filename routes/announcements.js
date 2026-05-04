/**
 * routes/announcements.js — top-of-screen banner posted by admin.
 *
 * Anyone logged in calls api_announcements_active to fetch the current
 * un-dismissed banner(s) on every page load. Admin uses
 * api_announcements_list / _save / _delete from the Settings →
 * Announcements tab.
 *
 * Severity: info | success | warning | danger — drives the banner colour.
 * is_dismissible=0 means the user can't close it (sticky important notice).
 * expires_at automatically takes the banner down after that timestamp.
 */

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const VALID_SEVERITY = ['info', 'success', 'warning', 'danger'];

function _hydrate(row, usersById) {
  return {
    id: row.id,
    title: row.title || '',
    body: row.body || '',
    severity: row.severity || 'info',
    is_active: Number(row.is_active) === 1,
    is_dismissible: Number(row.is_dismissible) !== 0,
    expires_at: row.expires_at,
    created_by: row.created_by,
    created_by_name: usersById[Number(row.created_by)]?.name || '',
    created_at: row.created_at
  };
}

/**
 * Returns currently-active announcements the calling user has NOT dismissed.
 * Filters out anything past expires_at. Used by the banner on every page.
 */
async function api_announcements_active(token) {
  const me = await authUser(token);
  const [rows, dismissals, users] = await Promise.all([
    db.getAll('announcements'),
    db.getAll('announcement_dismissals'),
    db.getAll('users')
  ]);
  const dismissedIds = new Set(
    dismissals
      .filter(d => Number(d.user_id) === Number(me.id))
      .map(d => Number(d.announcement_id))
  );
  const usersById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });
  const now = new Date();
  return rows
    .filter(r => Number(r.is_active) === 1)
    .filter(r => !dismissedIds.has(Number(r.id)))
    .filter(r => !r.expires_at || new Date(r.expires_at) > now)
    .map(r => _hydrate(r, usersById))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function api_announcements_dismiss(token, id) {
  const me = await authUser(token);
  // Only allow dismissing if the announcement is_dismissible
  const a = await db.findById('announcements', id);
  if (!a) throw new Error('Announcement not found');
  if (Number(a.is_dismissible) === 0) {
    throw new Error('This announcement cannot be dismissed');
  }
  // Idempotent: don't error if already dismissed
  const existing = (await db.getAll('announcement_dismissals'))
    .find(d => Number(d.user_id) === Number(me.id) &&
               Number(d.announcement_id) === Number(id));
  if (existing) return { ok: true, already: true };
  await db.insert('announcement_dismissals', {
    user_id: me.id, announcement_id: id, dismissed_at: db.nowIso()
  });
  return { ok: true };
}

/** Admin-only — list every announcement (active or not) for management UI */
async function api_announcements_list(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const [rows, users] = await Promise.all([
    db.getAll('announcements'), db.getAll('users')
  ]);
  const usersById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });
  return rows
    .map(r => _hydrate(r, usersById))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function api_announcements_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (!p.title || !String(p.title).trim()) throw new Error('Title is required');
  const sev = String(p.severity || 'info').toLowerCase();
  const fields = {
    title: String(p.title).trim().slice(0, 240),
    body: p.body ? String(p.body) : '',
    severity: VALID_SEVERITY.includes(sev) ? sev : 'info',
    is_active: p.is_active === 0 ? 0 : 1,
    is_dismissible: p.is_dismissible === 0 ? 0 : 1,
    expires_at: p.expires_at || null
  };
  if (p.id) {
    await db.update('announcements', p.id, fields);
    return { id: Number(p.id), ok: true };
  }
  const id = await db.insert('announcements', Object.assign({
    created_by: me.id, created_at: db.nowIso()
  }, fields));
  return { id, ok: true };
}

async function api_announcements_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.removeRow('announcements', id);
  return { ok: true };
}

/** Admin-only — clear all dismissals for a given announcement so everyone
 * sees it again (e.g. updated copy needs another round of attention). */
async function api_announcements_resetDismissals(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const all = await db.getAll('announcement_dismissals');
  const matches = all.filter(d => Number(d.announcement_id) === Number(id));
  for (const d of matches) await db.removeRow('announcement_dismissals', d.id);
  return { ok: true, cleared: matches.length };
}

module.exports = {
  api_announcements_active, api_announcements_dismiss,
  api_announcements_list, api_announcements_save,
  api_announcements_delete, api_announcements_resetDismissals
};
