const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/**
 * Post-sale project stages — admin defines a delivery workflow once,
 * reps advance leads through it after the sale. Each transition logs a
 * remark on the lead so the team has a paper trail.
 *
 * Examples (Celeste — real estate):
 *   Token received → Agreement signed → Loan sanctioned →
 *   Demand letters → Registry → Possession → Handover
 */
async function api_projectStages_list(token) {
  await authUser(token);
  const rows = await db.getAll('project_stages');
  return rows
    .filter(r => Number(r.is_active) === 1)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
    .map(r => ({
      id: r.id,
      name: r.name,
      description: r.description || '',
      sort_order: Number(r.sort_order) || 10,
      expected_days: Number(r.expected_days) || 7,
      assignee_role: r.assignee_role || ''
    }));
}

async function api_projectStages_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (!p.name) throw new Error('Stage name is required');
  const data = {
    name:          String(p.name).trim(),
    description:   p.description || '',
    sort_order:    Number(p.sort_order) || 10,
    expected_days: Number(p.expected_days) || 7,
    assignee_role: p.assignee_role || '',
    is_active:     p.is_active === 0 ? 0 : 1
  };
  if (p.id) {
    await db.update('project_stages', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  const id = await db.insert('project_stages', data);
  return { id, ok: true };
}

async function api_projectStages_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  // Soft delete
  await db.update('project_stages', id, { is_active: 0 });
  return { ok: true };
}

/**
 * Set the lead's project stage (or start the tracker by setting the first
 * stage). Logs a remark "🚚 Project: <stage_name> · <notes>" so the
 * timeline shows every transition.
 */
async function api_projectStages_setForLead(token, leadId, stageId, notes) {
  const me = await authUser(token);
  const lead = await db.findOneBy('leads', 'id', leadId);
  if (!lead) throw new Error('Lead not found');
  const stage = await db.findOneBy('project_stages', 'id', stageId);
  if (!stage) throw new Error('Stage not found');
  await db.update('leads', leadId, {
    project_stage_id: Number(stageId),
    project_stage_started_at: db.nowIso(),
    updated_at: db.nowIso()
  });
  await db.insert('remarks', {
    lead_id: leadId, user_id: me.id,
    remark: '🚚 Project stage → ' + stage.name +
            (notes ? ' · ' + String(notes).slice(0, 200) : ''),
    status_id: ''
  });
  return { ok: true, stage_id: Number(stageId), stage_name: stage.name };
}

/**
 * Move the lead to the NEXT stage (by sort_order). If no current stage,
 * sets the first one. If already on the last stage, no-op with a clear
 * error so the rep doesn't get a silent failure.
 */
async function api_projectStages_advanceLead(token, leadId, notes) {
  await authUser(token);
  const lead = await db.findOneBy('leads', 'id', leadId);
  if (!lead) throw new Error('Lead not found');
  const all = (await db.getAll('project_stages'))
    .filter(s => Number(s.is_active) === 1)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  if (!all.length) throw new Error('No project stages defined yet — admin needs to create them under Settings → Project stages.');
  let nextStage;
  if (!lead.project_stage_id) {
    nextStage = all[0];
  } else {
    const idx = all.findIndex(s => Number(s.id) === Number(lead.project_stage_id));
    if (idx < 0) nextStage = all[0];
    else if (idx === all.length - 1) throw new Error('Lead is already on the final stage (' + all[idx].name + ').');
    else nextStage = all[idx + 1];
  }
  return api_projectStages_setForLead(token, leadId, nextStage.id, notes);
}

/**
 * Board: every lead currently mid-delivery, grouped by stage.
 * Surfaces stalled leads (sat at a stage longer than expected_days).
 */
async function api_projectStages_board(token, filters) {
  const me = await authUser(token);
  const visible = (await require('../utils/auth').getVisibleUserIds(me)) || [];
  filters = filters || {};
  const stages = (await db.getAll('project_stages'))
    .filter(s => Number(s.is_active) === 1)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
  const leads = (await db.getAll('leads')).filter(l => l.project_stage_id);
  const users = await db.getAll('users');
  const products = await db.getAll('products');
  const usersById = {};   users.forEach(u    => { usersById[Number(u.id)]    = u; });
  const prodById  = {};   products.forEach(p => { prodById[Number(p.id)] = p; });

  /* SALE_CLOSURE_FILTERS_v1 — server-side filter pass so user-supplied
   * date / assigned / source / product filters narrow the result before
   * we bucket by stage. Stages remain the same; only lead lists change.
   * 'stalled_only' surfaces stuck cards; useful for managers. */
  const filtered = leads.filter(l => {
    // DASHBOARD_SCOPE_v1 — admin visible=all IDs; manager visible=team IDs only.
    if (!(me.role === 'admin' || visible.includes(Number(l.assigned_to)))) return false;

    // Date — uses project_stage_started_at (when the lead entered closure).
    // Falls back to lead.created_at if started_at missing.
    if (filters.from || filters.to) {
      const ref = String(l.project_stage_started_at || l.created_at || '').slice(0, 10);
      if (filters.from && ref < filters.from) return false;
      if (filters.to   && ref > filters.to)   return false;
    }
    // Assigned-to (multi)
    if (Array.isArray(filters.assigned_tos) && filters.assigned_tos.length) {
      if (!filters.assigned_tos.map(Number).includes(Number(l.assigned_to))) return false;
    }
    // Source (multi). String compare — leads.source is a free-form string.
    if (Array.isArray(filters.sources) && filters.sources.length) {
      if (!filters.sources.map(String).includes(String(l.source || ''))) return false;
    }
    // Product (multi)
    if (Array.isArray(filters.product_ids) && filters.product_ids.length) {
      if (!filters.product_ids.map(Number).includes(Number(l.product_id))) return false;
    }
    // Stalled-only toggle (kept for completeness; client also filters).
    return true;
  });
  const now = Date.now();
  const byStage = {};
  stages.forEach(s => { byStage[s.id] = { stage: s, leads: [] }; });
  filtered.forEach(l => {
    const sid = Number(l.project_stage_id);
    if (!byStage[sid]) return;
    const startedAt = l.project_stage_started_at ? new Date(l.project_stage_started_at).getTime() : null;
    const days = startedAt ? Math.floor((now - startedAt) / (1000 * 60 * 60 * 24)) : null;
    const stalled = days != null && days > Number(byStage[sid].stage.expected_days || 7);
    if (filters.stalled_only && !stalled) return;
    byStage[sid].leads.push({
      id: l.id,
      name: l.name,
      phone: l.phone,
      assigned_to: l.assigned_to,
      assigned_name: l.assigned_to ? (usersById[Number(l.assigned_to)]?.name || '') : '',
      /* SALE_CLOSURE_FILTERS_v1 — extra fields needed by SPA filter UI */
      source: l.source || '',
      product_id: l.product_id || null,
      product_name: l.product_id ? (prodById[Number(l.product_id)]?.name || '') : '',
      created_at: l.created_at || null,
      value: Number(l.value) || 0,
      project_stage_started_at: l.project_stage_started_at,
      days_at_stage: days,
      stalled
    });
  });
  return { stages, board: stages.map(s => byStage[s.id]) };
}

module.exports = {
  api_projectStages_list,
  api_projectStages_save,
  api_projectStages_delete,
  api_projectStages_setForLead,
  api_projectStages_advanceLead,
  api_projectStages_board
};
