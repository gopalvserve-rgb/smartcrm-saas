/**
 * Saved filter presets per user.
 *
 * Reps spend the same 30 seconds every morning re-building "my hot leads
 * due this week" or "Mumbai · qualified · negotiation". A saved filter
 * collapses that into one click.
 *
 * Scope:
 *   - Each filter belongs to one user (user_id).
 *   - is_shared = 1 lets admins save org-wide filters everyone can see.
 *   - `view` is which page the filter applies to (currently only 'leads',
 *     'kanban' planned).
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_filters_list(token, view) {
  const me = await authUser(token);
  const all = await db.getAll('saved_filters');
  return all
    .filter(f => (
      (Number(f.user_id) === Number(me.id) || Number(f.is_shared) === 1) &&
      (!view || String(f.view) === String(view))
    ))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function api_filters_save(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.name || !p.filter) throw new Error('name and filter required');
  if (typeof p.filter !== 'object') throw new Error('filter must be an object');
  // Admins can flag a filter as shared; everyone else's filters are private.
  const isShared = (me.role === 'admin') ? (Number(p.is_shared) === 1 ? 1 : 0) : 0;
  const view = String(p.view || 'leads');
  // Upsert: same user + same name + same view → overwrite
  const existing = (await db.getAll('saved_filters'))
    .find(f =>
      Number(f.user_id) === Number(me.id) &&
      String(f.name).toLowerCase() === String(p.name).toLowerCase() &&
      String(f.view) === view
    );
  if (existing) {
    await db.update('saved_filters', existing.id, {
      filter_json: JSON.stringify(p.filter),
      is_shared: isShared
    });
    return { ok: true, id: existing.id, replaced: true };
  }
  const id = await db.insert('saved_filters', {
    user_id: me.id, name: String(p.name).trim(), view,
    filter_json: JSON.stringify(p.filter), is_shared: isShared,
    created_at: db.nowIso()
  });
  return { ok: true, id, replaced: false };
}

async function api_filters_delete(token, id) {
  const me = await authUser(token);
  const f = await db.findById('saved_filters', id);
  if (!f) return { ok: true };
  // Only the owner can delete their own filter; admins can delete any.
  if (Number(f.user_id) !== Number(me.id) && me.role !== 'admin') {
    throw new Error('Not allowed to delete this filter');
  }
  await db.query(`DELETE FROM saved_filters WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

module.exports = { api_filters_list, api_filters_save, api_filters_delete };
