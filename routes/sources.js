const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_sources_list(token) {
  // REPORT_SOURCE_DIM_v1 (2026-05-30): vserve and other tenants commonly have
  // leads with source = 'Meta' / 'WhatsApp' / 'IndiaMart' coming in from
  // webhooks that never registered the source name in the 'sources' table.
  // The filter dropdown was therefore showing 'No matches' even when leads
  // visibly had those source values. Fix: return admin-defined sources UNION
  // distinct lead.source values, so the dropdown lists every source that
  // actually exists on any lead.
  await authUser(token);
  const admin = (await db.getAll('sources'))
    .filter(s => Number(s.is_active) !== 0);
  const seen = new Set(admin.map(s => String(s.name || '').toLowerCase()));
  let usedOnLeads = [];
  try {
    const r = await db.query(
      "SELECT DISTINCT source AS name FROM leads WHERE source IS NOT NULL AND TRIM(source) <> '' ORDER BY name ASC"
    );
    usedOnLeads = (r.rows || []).filter(row => !seen.has(String(row.name || '').toLowerCase()));
  } catch (_) {}
  const merged = admin.concat(usedOnLeads.map((row, i) => ({
    id: 'lead:' + row.name,
    name: row.name,
    color: '#94a3b8',
    sort_order: 9000 + i,
    is_active: 1,
    _origin: 'leads'   // hint for SPA; ignored if unused
  })));
  return merged.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
}

async function api_sources_save(token, src) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const s = src || {};
  if (!s.name) throw new Error('name required');
  const payload = {
    name: String(s.name).trim(),
    color: s.color || '#6b7280',
    sort_order: Number(s.sort_order) || 0,
    is_active: s.is_active == null ? 1 : (s.is_active ? 1 : 0)
  };
  if (s.id) { await db.update('sources', s.id, payload); return { id: Number(s.id) }; }
  if (await db.findOneBy('sources', 'name', payload.name)) throw new Error('Source name exists');
  const id = await db.insert('sources', payload);
  return { id };
}

async function api_sources_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.update('sources', id, { is_active: 0 });
  return { ok: true };
}

module.exports = { api_sources_list, api_sources_save, api_sources_delete };
