const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/**
 * Personal WhatsApp templates — reusable messages for the 💬 button.
 *
 * SHARED LIBRARY: every authenticated user sees the full active list,
 * regardless of who created the template. Only the owner (or an admin)
 * can edit/delete a template — see api_personalWa_save / _delete.
 *
 * Body can use placeholders like {name}, {first_name}, {phone},
 * {company}, {value}, {my_name}, {calendly} — the frontend substitutes
 * them when opening wa.me, the rep just hits Send in WhatsApp.
 *
 * Truly silent / programmatic sending from a personal number is not
 * possible (WhatsApp ToS). For automated business sending see the
 * existing Cloud API templates (🟢 button).
 */
async function api_personalWa_list(token) {
  const me = await authUser(token);
  const rows = await db.getAll('personal_wa_templates');
  const users = await db.getAll('users');
  const usersById = {};
  users.forEach(u => { usersById[Number(u.id)] = u; });
  return rows
    .filter(r => Number(r.is_active) === 1)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map(r => ({
      id: r.id, name: r.name, body: r.body,
      owner_id: r.owner_id,
      owner_name: usersById[Number(r.owner_id)]?.name || '',
      mine: Number(r.owner_id) === Number(me.id),
      can_edit: Number(r.owner_id) === Number(me.id) || me.role === 'admin'
    }));
}

async function api_personalWa_save(token, payload) {
  const me = await authUser(token);
  const p = payload || {};
  if (!p.name) throw new Error('Template name is required');
  if (!p.body) throw new Error('Template body is required');
  const data = {
    name: String(p.name).trim().slice(0, 80),
    body: String(p.body).slice(0, 4000),
    is_active: 1
  };
  if (p.id) {
    // Verify ownership — owners + admins can edit any template.
    const existing = await db.findOneBy('personal_wa_templates', 'id', p.id);
    if (!existing) throw new Error('Not found');
    if (Number(existing.owner_id) !== Number(me.id) && me.role !== 'admin') {
      throw new Error('Only the owner or an admin can edit this template');
    }
    await db.update('personal_wa_templates', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  data.owner_id = me.id;
  data.created_at = db.nowIso();
  const id = await db.insert('personal_wa_templates', data);
  return { id, ok: true };
}

async function api_personalWa_delete(token, id) {
  const me = await authUser(token);
  const existing = await db.findOneBy('personal_wa_templates', 'id', id);
  if (!existing) throw new Error('Not found');
  if (Number(existing.owner_id) !== Number(me.id) && me.role !== 'admin') {
    throw new Error('Only the owner or an admin can delete this template');
  }
  await db.update('personal_wa_templates', id, { is_active: 0 });
  return { ok: true };
}

module.exports = {
  api_personalWa_list,
  api_personalWa_save,
  api_personalWa_delete
};
