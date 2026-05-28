const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// PIPELINE_STAGE_v1 (2026-05-28) — universal pipeline stage every status
// can be linked to. Lets the admin map their tenant-specific status names
// (e.g. "Not Pick", "Hot", "Demo Done") to one of 7 cross-tenant stages
// so the new funnel pipeline view + dashboard widget can aggregate
// consistently across all tenants and packs.
const PIPE_STAGES = ['fresh', 'attempted', 'qualified', 'negotiation', 'proposal', 'won', 'lost'];

let _healed = false;
async function _heal() {
  if (_healed) return;
  try {
    await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS stage TEXT`);
    _healed = true;
  } catch (e) {
    console.warn('[statuses] stage column heal failed:', e.message);
  }
}

async function api_statuses_list(token) {
  await authUser(token);
  await _heal();
  return (await db.getAll('statuses')).sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
}
async function api_statuses_save(token, s) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!s.name) throw new Error('name required');
  await _heal();
  const payload = {
    name: s.name,
    color: s.color || '#6b7280',
    sort_order: Number(s.sort_order) || 10,
    is_final: Number(s.is_final) || 0,
    stage: PIPE_STAGES.includes(String(s.stage || '').toLowerCase()) ? String(s.stage).toLowerCase() : null
  };
  if (s.id) { await db.update('statuses', s.id, payload); return { id: Number(s.id) }; }
  const id = await db.insert('statuses', payload);
  return { id };
}
async function api_statuses_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Reassign any leads using this status to 'New' first (if exists), else null
  const leads = await db.getAll('leads');
  const news = await db.findOneBy('statuses', 'name', 'New');
  const replacement = news && Number(news.id) !== Number(id) ? news.id : null;
  for (const l of leads) {
    if (Number(l.status_id) === Number(id)) {
      await db.update('leads', l.id, { status_id: replacement });
    }
  }
  await db.removeRow('statuses', id);
  return { ok: true };
}

// PIPELINE_STAGE_v1 — expose the enum so the SPA can render the
// dropdown without hard-coding it on the client.
async function api_pipeline_stages(token) {
  await authUser(token);
  return [
    { id: 'fresh',       label: 'Fresh Lead',                hint: 'Just captured. Untouched.' },
    { id: 'attempted',   label: 'Attempted / Contacted',     hint: 'Reached out but no meaningful conversation yet.' },
    { id: 'qualified',   label: 'Connected & Qualified',     hint: 'Spoke with them, confirmed real fit.' },
    { id: 'negotiation', label: 'Negotiation',               hint: 'Discussing price, course details, objections.' },
    { id: 'proposal',    label: 'Proposal / Payment Link Sent', hint: 'Formal offer or payment link shared.' },
    { id: 'won',         label: 'Won',                       hint: 'Enrolled / paid.' },
    { id: 'lost',        label: 'Lost',                      hint: 'Closed lost.' }
  ];
}

module.exports = { api_statuses_list, api_statuses_save, api_statuses_delete, api_pipeline_stages };
