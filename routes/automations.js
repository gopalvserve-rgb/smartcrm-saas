const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_automations_list(token) {
  await authUser(token);
  const rows = await db.getAll('automations');
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function api_automations_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const a = payload || {};
  // AUTOMATION_REASSIGN_TPL_FIX (2026-06-06): only require template when
  // the channel actually sends a message. Channels like 'reassign_lead' /
  // 'reassign' / 'reassign_lead_to_users' don't need any template.
  const NO_TEMPLATE_CHANNELS = ['reassign', 'reassign_lead', 'reassign_lead_to_users', 'reassign_to_users', 'reassign_user'];
  const needsTemplate = !NO_TEMPLATE_CHANNELS.includes(String(a.channel || '').toLowerCase());
  if (!a.name || !a.event || !a.channel) {
    throw new Error('name, event, channel are required');
  }
  if (needsTemplate && !a.template) {
    throw new Error('template is required for ' + a.channel + ' channels');
  }
  const row = {
    name: a.name,
    event: a.event,
    condition: a.condition || '',
    channel: a.channel,
    recipient: a.recipient || 'lead',
    subject: a.subject || '',
    template: a.template || '',
    is_active: a.is_active == null ? 1 : (a.is_active ? 1 : 0)
  };
  if (a.id) { await db.update('automations', a.id, row); return { id: Number(a.id) }; }
  row.created_at = db.nowIso();
  const id = await db.insert('automations', row);
  return { id };
}

async function api_automations_toggle(token, id, active) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.update('automations', id, { is_active: active ? 1 : 0 });
  return { ok: true };
}

async function api_automations_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.removeRow('automations', id);
  return { ok: true };
}

async function api_automations_test(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const a = await db.findById('automations', id);
  if (!a) throw new Error('Automation not found');
  const lead = (await db.getAll('leads'))[0];
  if (!lead) throw new Error('Need at least one lead in the system to run a test');
  require('../utils/automations').fire(a.event, { lead, user: me, event: a.event });
  return { ok: true, note: 'Fired — check Automation log in a few seconds' };
}

async function api_automations_log(token, limit) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const rows = (await db.getAll('automation_log'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, Number(limit) || 50);
  const automations = await db.getAll('automations');
  const byId = {}; automations.forEach(a => { byId[Number(a.id)] = a; });
  return rows.map(r => Object.assign({}, r, { automation_name: byId[Number(r.automation_id)]?.name || '(deleted)' }));
}

module.exports = {
  api_automations_list,
  api_automations_save,
  api_automations_toggle,
  api_automations_delete,
  api_automations_test,
  api_automations_log
};
