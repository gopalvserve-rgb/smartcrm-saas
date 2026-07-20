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
    header_media_url: a.header_media_url || '',   // AUTOMATION_MEDIA_HEADER_v1
    // AUTOMATION_REASSIGN_ANY_v1 — optional reassign target ('users:1,2,3'),
    // independent of channel, so an email/whatsapp rule can ALSO auto-assign.
    reassign_to: String(a.reassign_to || '').trim(),
    is_active: a.is_active == null ? 1 : (a.is_active ? 1 : 0)
  };
  try { await db.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS header_media_url TEXT`); } catch (_) {}
  try { await db.query(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS reassign_to TEXT`); } catch (_) {}
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
  const auto = require('../utils/automations');
  // AUTOMATION_TEST_PICK_v1 — the old code always fired against leads[0] (the
  // OLDEST lead), which almost never matches the rule's condition, so every
  // test looked like a failure. Pick the most RECENT lead that actually
  // matches the condition so the test exercises the real send path.
  const all = (await db.getAll('leads')).sort((x, y) => Number(y.id) - Number(x.id));
  if (!all.length) throw new Error('Need at least one lead in the system to run a test');
  let lead = null;
  if (a.condition && typeof auto._matchesCondition === 'function') {
    for (const cand of all.slice(0, 300)) {
      let enriched = cand;
      try { enriched = await auto._enrichLead(cand); } catch (_) {}
      try {
        if (auto._matchesCondition(a.condition, { lead: enriched, user: me, event: a.event })) { lead = enriched; break; }
      } catch (_) {}
    }
  }
  const matched = !!lead;
  if (!lead) lead = all[0];
  // _isTest → fire() sends the message so delivery can be verified, but skips
  // the reassign so a Test click never rewrites a live lead's owner.
  auto.fire(a.event, { lead, user: me, event: a.event, _isTest: true });
  return {
    ok: true,
    matched,
    lead_id: lead.id,
    note: matched
      ? ('Fired against lead #' + lead.id + ' — it matches this rule\'s condition. NOTE: this sends a REAL ' + (a.channel === 'email' ? 'email' : a.channel) + '. Lead ownership is NOT changed by a test. Check the Automation log for the result.')
      : ('No existing lead matches this rule\'s condition, so the log will show "condition did not match" (that is expected, not an error). Fired against your newest lead #' + lead.id + '.')
  };
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
