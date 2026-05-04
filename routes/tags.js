/**
 * routes/tags.js — admin-managed tag library.
 *
 * Tags are centrally managed by admins. Non-admin users can only LIST
 * (so the lead modal can show them as choices) but cannot CREATE new
 * tags freeform. This stops the tag list from sprawling into hundreds of
 * misspelled near-duplicates.
 *
 * The leads.tags column stays as a comma-separated string for back-compat;
 * the UI just enforces that picked values come from this library.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function _ensureSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS tag_library (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        color      TEXT NOT NULL DEFAULT '#6366f1',
        is_active  INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  } catch (e) { /* already exists */ }
}
_ensureSchema();

async function api_tags_list(token) {
  await authUser(token);
  const rows = await db.getAll('tag_library');
  return rows
    .filter(t => Number(t.is_active) === 1)
    .map(t => ({ id: t.id, name: t.name, color: t.color || '#6366f1' }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function api_tags_save(token, tag) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admins can manage tags');
  const t = tag || {};
  const name = String(t.name || '').trim();
  if (!name) throw new Error('Tag name required');
  const color = String(t.color || '#6366f1').trim();
  if (t.id) {
    await db.update('tag_library', t.id, { name, color, is_active: t.is_active === 0 ? 0 : 1 });
    return { ok: true, id: Number(t.id) };
  }
  // Case-insensitive duplicate check
  const existing = (await db.getAll('tag_library')).find(r =>
    String(r.name).toLowerCase() === name.toLowerCase()
  );
  if (existing) {
    if (Number(existing.is_active) === 0) {
      await db.update('tag_library', existing.id, { is_active: 1, color });
      return { ok: true, id: existing.id, reactivated: true };
    }
    throw new Error('Tag already exists: ' + name);
  }
  const id = await db.insert('tag_library', { name, color, is_active: 1 });
  return { ok: true, id };
}

async function api_tags_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Only admins can manage tags');
  // Soft-delete so existing leads tagged with this name still display correctly.
  await db.update('tag_library', id, { is_active: 0 });
  return { ok: true };
}

module.exports = { api_tags_list, api_tags_save, api_tags_delete };
