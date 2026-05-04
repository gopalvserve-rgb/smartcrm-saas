const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_rules_list(token) {
  await authUser(token);
  const rules = (await db.getAll('assignment_rules'))
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  const users = await db.getAll('users');
  const userById = {}; users.forEach(u => { userById[Number(u.id)] = u; });
  return rules.map(r => {
    const ids = String(r.assigned_to || '').split(',').map(s => s.trim()).filter(Boolean);
    return Object.assign({}, r, {
      assigned_names: ids.map(id => userById[Number(id)]?.name || id).join(', ')
    });
  });
}
async function api_rules_save(token, rule) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const r = rule || {};
  if (!r.name || !r.field || !r.operator || r.value === undefined || !r.assigned_to) throw new Error('Missing required fields');
  const payload = {
    name: r.name, field: r.field, operator: r.operator, value: r.value,
    assigned_to: Array.isArray(r.assigned_to) ? r.assigned_to.join(',') : r.assigned_to,
    priority: Number(r.priority) || 100,
    is_active: r.is_active == null ? 1 : (r.is_active ? 1 : 0)
  };
  if (r.id) { await db.update('assignment_rules', r.id, payload); return { id: Number(r.id) }; }
  const id = await db.insert('assignment_rules', payload);
  return { id };
}
async function api_rules_toggle(token, id, active) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Forbidden');
  await db.update('assignment_rules', id, { is_active: active ? 1 : 0 });
  return { ok: true };
}
async function api_rules_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Forbidden');
  await db.removeRow('assignment_rules', id);
  return { ok: true };
}
module.exports = { api_rules_list, api_rules_save, api_rules_toggle, api_rules_delete };
