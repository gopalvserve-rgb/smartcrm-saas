/**
 * routes/tat.js — Turn-Around Time tracking, thresholds, violations,
 * and the per-user / per-manager / org reports.
 *
 * Concepts
 * --------
 * * Stage log — every status change writes a row in `lead_stage_log` with
 *   from_status, to_status, who changed it, and how many seconds the lead
 *   spent in the previous status. This is the source of truth for TAT.
 * * Action timeline — every meaningful event on a lead writes to
 *   `lead_actions` (created, status_change, remark, call, followup_set,
 *   assigned). The first action AFTER created_at is the "1st action",
 *   the next is the "2nd action", etc.
 * * Threshold — admin sets a max minutes-per-status in `tat_thresholds`.
 *   If a lead sits in that status longer without any action, a
 *   `tat_violations` row is created and the assignee is reminded.
 *   Escalation: at threshold (employee), threshold * 2 (manager),
 *   threshold * 3 (admin).
 *
 * The worker that detects breaches and fires escalations is started from
 * server.js boot via `startTatWorker()`.
 */
const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// ---------- Logging helpers (called from leads.js) ------------------

/** Log a status transition + write the matching action row. */
async function logStageChange(leadId, fromStatusId, toStatusId, userId) {
  if (!leadId) return;
  // Compute time spent in the previous stage by looking up the latest open stage log.
  let durationS = null;
  try {
    const { rows } = await db.query(
      `SELECT created_at FROM lead_stage_log WHERE lead_id = $1 ORDER BY id DESC LIMIT 1`,
      [Number(leadId)]
    );
    if (rows.length && rows[0].created_at) {
      const prev = new Date(rows[0].created_at);
      durationS = Math.max(0, Math.round((Date.now() - prev.getTime()) / 1000));
    }
  } catch (_) {}
  await db.query(
    `INSERT INTO lead_stage_log (lead_id, from_status_id, to_status_id, user_id, duration_s)
     VALUES ($1, $2, $3, $4, $5)`,
    [Number(leadId), fromStatusId || null, toStatusId || null, userId || null, durationS]
  );
  await logAction(leadId, 'status_change', userId, { from_status_id: fromStatusId, to_status_id: toStatusId });

  // Resolve any open TAT violation for this lead (we transitioned out of it)
  try {
    await db.query(
      `UPDATE tat_violations SET resolved_at = NOW() WHERE lead_id = $1 AND resolved_at IS NULL`,
      [Number(leadId)]
    );
  } catch (_) {}
}

/** Log any other type of action on a lead. */
async function logAction(leadId, actionType, userId, meta) {
  if (!leadId || !actionType) return;
  try {
    await db.query(
      `INSERT INTO lead_actions (lead_id, action_type, user_id, meta_json) VALUES ($1, $2, $3, $4)`,
      [Number(leadId), String(actionType), userId || null, meta ? JSON.stringify(meta) : null]
    );
    // Any action also resolves any open violation — the assignee responded.
    if (actionType !== 'created') {
      await db.query(
        `UPDATE tat_violations SET resolved_at = NOW() WHERE lead_id = $1 AND resolved_at IS NULL`,
        [Number(leadId)]
      );
    }
  } catch (_) {}
}

// ---------- Admin endpoints: thresholds -----------------------------

async function api_tat_thresholds_list(token) {
  await authUser(token);
  const rows = await db.getAll('tat_thresholds');
  const statuses = await db.getAll('statuses');
  const byStatus = {};
  rows.forEach(r => { byStatus[Number(r.status_id)] = r; });
  return statuses.map(s => {
    const cfg = byStatus[Number(s.id)];
    return {
      status_id: s.id,
      status_name: s.name,
      status_color: s.color,
      threshold_minutes: cfg ? Number(cfg.threshold_minutes) : null,
      is_active: cfg ? Number(cfg.is_active) === 1 : false
    };
  });
}

async function api_tat_thresholds_save(token, statusId, minutes, isActive) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const sid = Number(statusId);
  const m = Math.max(1, Number(minutes) || 60);
  const a = (isActive === 0 || isActive === false) ? 0 : 1;
  // Upsert
  const existing = (await db.getAll('tat_thresholds')).find(r => Number(r.status_id) === sid);
  if (existing) {
    await db.update('tat_thresholds', existing.id, { threshold_minutes: m, is_active: a, updated_at: db.nowIso() });
    return { ok: true, id: existing.id };
  }
  const id = await db.insert('tat_thresholds', { status_id: sid, threshold_minutes: m, is_active: a, updated_at: db.nowIso() });
  return { ok: true, id };
}

// ---------- Per-lead timeline (used by the lead modal) --------------

async function api_lead_actions(token, leadId) {
  await authUser(token);
  const { rows } = await db.query(
    `SELECT a.id, a.lead_id, a.action_type, a.user_id, a.meta_json, a.created_at,
            u.name AS user_name
       FROM lead_actions a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE a.lead_id = $1
       ORDER BY a.created_at ASC, a.id ASC`,
    [Number(leadId)]
  );
  return rows.map(r => ({
    id: r.id, lead_id: r.lead_id, action_type: r.action_type,
    user_id: r.user_id, user_name: r.user_name || '',
    meta: typeof r.meta_json === 'string' ? safeJson(r.meta_json) : (r.meta_json || {}),
    created_at: r.created_at
  }));
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

// ---------- Reports -------------------------------------------------

/**
 * TAT report. Three views:
 *   - by_user   : avg + count + violations per assignee
 *   - by_stage  : avg + count + violations per status
 *   - by_lead   : per-lead first-action / second-action / current-stage
 *
 * Filters: { from, to, user_id }
 */
async function api_tat_report(token, filters) {
  const me = await authUser(token);
  filters = filters || {};
  const visible = await getVisibleUserIds(me);
  const isAdmin = me.role === 'admin';

  const [leads, users, statuses, stageLog, actions, violations] = await Promise.all([
    db.getAll('leads'), db.getAll('users'), db.getAll('statuses'),
    db.getAll('lead_stage_log'), db.getAll('lead_actions'), db.getAll('tat_violations')
  ]);
  const userById = {}; users.forEach(u => { userById[Number(u.id)] = u; });
  const statusById = {}; statuses.forEach(s => { statusById[Number(s.id)] = s; });

  // Filter leads to visibility scope first
  let scopedLeads = leads.filter(l => isAdmin || (l.assigned_to && visible.includes(Number(l.assigned_to))));
  if (filters.from) scopedLeads = scopedLeads.filter(l => String(l.created_at).slice(0, 10) >= filters.from);
  if (filters.to)   scopedLeads = scopedLeads.filter(l => String(l.created_at).slice(0, 10) <= filters.to);
  if (filters.user_id) scopedLeads = scopedLeads.filter(l => Number(l.assigned_to) === Number(filters.user_id));
  const leadIdSet = new Set(scopedLeads.map(l => Number(l.id)));

  // Index actions per lead, sorted by time
  const actionsByLead = {};
  actions.forEach(a => {
    if (!leadIdSet.has(Number(a.lead_id))) return;
    if (!actionsByLead[a.lead_id]) actionsByLead[a.lead_id] = [];
    actionsByLead[a.lead_id].push(a);
  });
  Object.values(actionsByLead).forEach(arr => arr.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));

  // Per-lead summary — when did 1st, 2nd action happen vs lead created?
  const byLead = scopedLeads.map(l => {
    const acts = actionsByLead[Number(l.id)] || [];
    const post = acts.filter(a => a.action_type !== 'created');
    const first = post[0];
    const second = post[1];
    const created = new Date(l.created_at).getTime();
    const tat1 = first  ? Math.round((new Date(first.created_at).getTime() - created) / 1000) : null;
    const tat2 = second ? Math.round((new Date(second.created_at).getTime() - created) / 1000) : null;
    return {
      lead_id: l.id,
      lead_name: l.name,
      assigned_to: l.assigned_to,
      assigned_name: userById[Number(l.assigned_to)]?.name || '',
      status_id: l.status_id,
      status_name: statusById[Number(l.status_id)]?.name || '',
      created_at: l.created_at,
      first_action_at:  first ? first.created_at : null,
      first_action_type: first ? first.action_type : null,
      second_action_at: second ? second.created_at : null,
      second_action_type: second ? second.action_type : null,
      tat_to_first_s: tat1,
      tat_to_second_s: tat2,
      total_actions: post.length
    };
  });

  // Per-user aggregate
  const byUserMap = {};
  byLead.forEach(r => {
    const uid = Number(r.assigned_to) || 0;
    if (!byUserMap[uid]) byUserMap[uid] = {
      user_id: uid, user_name: r.assigned_name,
      leads: 0, actioned: 0,
      sum_first_s: 0, sum_second_s: 0,
      first_count: 0, second_count: 0
    };
    const b = byUserMap[uid];
    b.leads++;
    if (r.tat_to_first_s != null) { b.sum_first_s += r.tat_to_first_s; b.first_count++; b.actioned++; }
    if (r.tat_to_second_s != null) { b.sum_second_s += r.tat_to_second_s; b.second_count++; }
  });
  const byUser = Object.values(byUserMap).map(b => ({
    user_id: b.user_id, user_name: b.user_name,
    leads: b.leads, actioned: b.actioned,
    avg_first_min:  b.first_count  > 0 ? Math.round(b.sum_first_s  / b.first_count  / 60) : null,
    avg_second_min: b.second_count > 0 ? Math.round(b.sum_second_s / b.second_count / 60) : null
  })).sort((a, b) => (a.avg_first_min ?? 999999) - (b.avg_first_min ?? 999999));

  // Per-stage aggregate (using stage_log durations)
  const byStageMap = {};
  stageLog.forEach(s => {
    if (!leadIdSet.has(Number(s.lead_id))) return;
    if (!s.duration_s || s.duration_s < 0) return;
    const sid = Number(s.from_status_id) || 0;
    if (!sid) return;
    if (!byStageMap[sid]) byStageMap[sid] = { status_id: sid, status_name: statusById[sid]?.name || '', count: 0, sum_s: 0 };
    byStageMap[sid].count++;
    byStageMap[sid].sum_s += Number(s.duration_s);
  });
  const byStage = Object.values(byStageMap).map(b => ({
    status_id: b.status_id, status_name: b.status_name,
    transitions: b.count, avg_minutes: Math.round(b.sum_s / b.count / 60)
  })).sort((a, b) => b.avg_minutes - a.avg_minutes);

  // Active violations summary
  const openViolations = violations.filter(v => leadIdSet.has(Number(v.lead_id)) && !v.resolved_at);
  const recentResolved = violations.filter(v => leadIdSet.has(Number(v.lead_id)) && v.resolved_at)
    .sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)))
    .slice(0, 50);

  return {
    by_user: byUser, by_stage: byStage, by_lead: byLead,
    open_violations: openViolations.length,
    violations_recent: recentResolved.length,
    open_violation_rows: openViolations.slice(0, 100).map(v => ({
      id: v.id, lead_id: v.lead_id,
      lead_name: scopedLeads.find(l => Number(l.id) === Number(v.lead_id))?.name || '',
      status_name: statusById[Number(v.status_id)]?.name || '',
      user_name: userById[Number(v.user_id)]?.name || '',
      threshold_minutes: v.threshold_minutes,
      triggered_at: v.triggered_at,
      escalation_level: v.escalation_level,
      last_escalated_at: v.last_escalated_at
    })),
    totals: {
      leads: byLead.length,
      total_actions: byLead.reduce((s, r) => s + r.total_actions, 0),
      avg_first_min: byUser.length ? Math.round(byUser.reduce((s, u) => s + (u.avg_first_min || 0), 0) / byUser.length) : null
    }
  };
}

// ---------- Violation detection worker ------------------------------

let _workerStarted = false;
function startTatWorker() {
  if (_workerStarted) return;
  _workerStarted = true;
  const intervalMs = Number(process.env.TAT_WORKER_INTERVAL_MS || 5 * 60 * 1000);
  console.log(`[tat] worker starting, interval ${intervalMs}ms`);
  setInterval(() => { _tatTick().catch(e => console.warn('[tat] tick failed:', e.message)); }, intervalMs);
  // Kick off ~30s after boot
  setTimeout(() => _tatTick().catch(() => {}), 30_000);
}

async function _tatTick() {
  const [leads, statuses, thresholds, openViolations] = await Promise.all([
    db.getAll('leads'), db.getAll('statuses'), db.getAll('tat_thresholds'),
    db.query(`SELECT * FROM tat_violations WHERE resolved_at IS NULL`).then(r => r.rows)
  ]);
  const thresholdsByStatus = {};
  thresholds.forEach(t => {
    if (Number(t.is_active) === 1) thresholdsByStatus[Number(t.status_id)] = Number(t.threshold_minutes);
  });
  const openByLead = {};
  openViolations.forEach(v => { openByLead[Number(v.lead_id)] = v; });

  const now = Date.now();
  const finalStatusIds = new Set(statuses.filter(s => Number(s.is_final) === 1).map(s => Number(s.id)));

  for (const lead of leads) {
    const sid = Number(lead.status_id) || 0;
    if (!sid || finalStatusIds.has(sid)) continue;
    const minutes = thresholdsByStatus[sid];
    if (!minutes) continue; // no threshold configured for this stage

    // How long has this lead been in this stage?
    // Use last_status_change_at if set, otherwise created_at.
    const enteredAt = lead.last_status_change_at || lead.created_at;
    if (!enteredAt) continue;
    const ageMin = (now - new Date(enteredAt).getTime()) / 60_000;
    if (ageMin < minutes) continue; // still within TAT

    // Determine appropriate escalation level.
    // 1 = employee (>=  threshold)
    // 2 = manager  (>= 2× threshold)
    // 3 = admin    (>= 3× threshold)
    let level = 1;
    if (ageMin >= minutes * 3) level = 3;
    else if (ageMin >= minutes * 2) level = 2;

    let v = openByLead[Number(lead.id)];
    if (!v) {
      // Create the violation row
      const id = await db.insert('tat_violations', {
        lead_id: lead.id, status_id: sid, user_id: lead.assigned_to,
        threshold_minutes: minutes, escalation_level: level,
        last_escalated_at: db.nowIso(),
        notes: `Lead has been in "${statuses.find(s => Number(s.id) === sid)?.name || 'this stage'}" for ${Math.round(ageMin)} min, threshold ${minutes} min`
      });
      await _escalate(lead, statuses, level, minutes, ageMin);
      continue;
    }

    // Already-open violation — bump escalation level if needed.
    if (level > Number(v.escalation_level)) {
      await db.update('tat_violations', v.id, {
        escalation_level: level, last_escalated_at: db.nowIso()
      });
      await _escalate(lead, statuses, level, minutes, ageMin);
    }
  }
}

/**
 * Send a push notification to the right person at this escalation level.
 * Level 1 → assignee. Level 2 → assignee's parent (manager). Level 3 → all admins.
 */
async function _escalate(lead, statuses, level, minutes, ageMin) {
  let push;
  try { push = require('./push'); } catch (_) { return; }
  const statusName = statuses.find(s => Number(s.id) === Number(lead.status_id))?.name || 'this stage';
  const title = level === 3
    ? '🚨 TAT VIOLATION (admin escalation)'
    : level === 2
      ? '⚠️ TAT escalation — manager review needed'
      : '⏱️ TAT breach — please action this lead';
  const body = `${lead.name || 'Lead #' + lead.id} stuck in "${statusName}" for ${Math.round(ageMin)} min (limit ${minutes} min)`;
  const url = `/#/leads`;
  const tag = `tat-${lead.id}-L${level}`;

  // Recipients
  const targets = [];
  if (level === 1 && lead.assigned_to) targets.push(Number(lead.assigned_to));
  if (level === 2) {
    // Manager = the assignee's parent_id, or any user with role=manager visible to the assignee
    const u = await db.findById('users', lead.assigned_to);
    if (u && u.parent_id) targets.push(Number(u.parent_id));
    // Also still notify the assignee
    if (lead.assigned_to) targets.push(Number(lead.assigned_to));
  }
  if (level === 3) {
    const admins = (await db.getAll('users')).filter(u => u.role === 'admin' && Number(u.is_active) === 1);
    admins.forEach(a => targets.push(Number(a.id)));
    if (lead.assigned_to) targets.push(Number(lead.assigned_to));
  }
  // Dedupe
  const uniq = [...new Set(targets.filter(Boolean))];
  await Promise.all(uniq.map(uid =>
    push.sendPushToUser(uid, { title, body, url, tag, sticky: true })
        .catch(e => console.warn('[tat] escalation push failed:', e.message))
  ));
}

module.exports = {
  api_tat_thresholds_list, api_tat_thresholds_save,
  api_tat_report, api_lead_actions,
  // exposed so leads.js can call them on create/update/remark
  logStageChange, logAction,
  startTatWorker
};
