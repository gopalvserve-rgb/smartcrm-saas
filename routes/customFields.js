const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_customFields_list(token) {
  await authUser(token);
  return (await db.getAll('custom_fields'))
    .filter(f => Number(f.is_active) !== 0)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
    .map(f => ({
      id: f.id, key: f.key, label: f.label,
      field_type: f.field_type || 'text',
      options: String(f.options || '').split('|').filter(x => x !== ''),
      sort_order: Number(f.sort_order) || 0,
      show_in_list: Number(f.show_in_list) === 1,
      is_required: Number(f.is_required) === 1
    }));
}

async function api_customFields_save(token, field) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const f = field || {};
  if (!f.key || !f.label) throw new Error('key and label required');
  const key = String(f.key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!key) throw new Error('Invalid key');
  const payload = {
    key, label: String(f.label).trim(),
    field_type: f.field_type || 'text',
    options: Array.isArray(f.options) ? f.options.join('|') : String(f.options || ''),
    sort_order: Number(f.sort_order) || 0,
    show_in_list: f.show_in_list ? 1 : 0,
    is_required: f.is_required ? 1 : 0,
    is_active: 1
  };
  if (f.id) { await db.update('custom_fields', f.id, payload); return { id: Number(f.id), ok: true }; }
  if (await db.findOneBy('custom_fields', 'key', key)) throw new Error('Field key already exists: ' + key);
  const id = await db.insert('custom_fields', payload);
  return { id, ok: true };
}

async function api_customFields_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  await db.update('custom_fields', id, { is_active: 0 });
  return { ok: true };
}

module.exports = { api_customFields_list, api_customFields_save, api_customFields_delete };
