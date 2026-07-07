const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// INV_CUSTOM_FIELDS_v1 — ensure the entity column exists (self-heal for
// tenants provisioned before this feature). Idempotent, cheap.
async function _ensureEntityCol() {
  try { await db.query(`ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS entity TEXT NOT NULL DEFAULT 'lead'`); } catch (_) {}
}

async function api_customFields_list(token, entity) {
  await authUser(token);
  const ent = String(entity || 'lead').toLowerCase();   // INV_CUSTOM_FIELDS_v1
  return (await db.getAll('custom_fields'))
    .filter(f => Number(f.is_active) !== 0 && String(f.entity || 'lead').toLowerCase() === ent)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
    .map(f => ({
      id: f.id, key: f.key, label: f.label,
      entity: f.entity || 'lead',
      field_type: f.field_type || 'text',
      options: String(f.options || '').split('|').filter(x => x !== ''),
      sort_order: Number(f.sort_order) || 0,
      show_in_list: Number(f.show_in_list) === 1,
      is_required: Number(f.is_required) === 1
    }));
}

async function api_customFields_save(token, field) {
  const me = await authUser(token);
  await _ensureEntityCol();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const f = field || {};
  if (!f.key || !f.label) throw new Error('key and label required');
  const key = String(f.key).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!key) throw new Error('Invalid key');
  const ent = String(f.entity || 'lead').toLowerCase();   // INV_CUSTOM_FIELDS_v1
  const payload = {
    key, label: String(f.label).trim(),
    entity: ent,
    field_type: f.field_type || 'text',
    options: Array.isArray(f.options) ? f.options.join('|') : String(f.options || ''),
    sort_order: Number(f.sort_order) || 0,
    show_in_list: f.show_in_list ? 1 : 0,
    is_required: f.is_required ? 1 : 0,
    is_active: 1
  };
  if (f.id) { await db.update('custom_fields', f.id, payload); return { id: Number(f.id), ok: true }; }
  // dup key check scoped to the same entity (a key may exist for lead AND invoice)
  const existing = (await db.getAll('custom_fields')).find(
    x => Number(x.is_active) !== 0 && String(x.key) === key && String(x.entity || 'lead').toLowerCase() === ent);
  if (existing) throw new Error('Field key already exists: ' + key);
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
