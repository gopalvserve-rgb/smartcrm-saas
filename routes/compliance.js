/**
 * routes/compliance.js — COMPLIANCE_v1
 *
 * Tenant-customisable rule engine + violations log.
 *
 * Tenant admins design rules like:
 *   - "Status 'Not Picked' must be dialled at least once per 24 hours"
 *   - "Cannot set a follow-up without an outgoing call in the last 24 h"
 *   - "Leads in status X older than 7 days with no activity"
 *   - "Each rep must log >= 5 activities per day"
 *
 * Storage:
 *   compliance_rules        — admin-defined rule definitions (config_json)
 *   compliance_violations   — every violation the engine detects
 *
 * Detection:
 *   - Real-time hooks (api_compliance_evaluateRealtime) fire from lead-save /
 *     remark-add flows for the realtime check types.
 *   - Daily worker (runDailyScan) sweeps every 24 h for stale-condition types
 *     (idle leads, daily activity quota, NP min-dials).
 *
 * Check types currently implemented:
 *   np_min_dials               — status_ids[], min_dials, window_hours
 *   followup_requires_call     — call_window_hours (real-time hook)
 *   idle_in_stage              — status_ids[], max_idle_days
 *   min_daily_activity         — min_activities, target_roles[]
 *
 * Adding a new check type:
 *   1. Append to CHECK_TYPES catalogue below (label + config schema).
 *   2. Implement _evalXxx() that returns a list of violation rows.
 *   3. Wire into either runDailyScan() or api_compliance_evaluateRealtime().
 *   4. Surface its config form in the SPA rule-builder (public/tenant/app.js).
 */

const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');

// ----- check-type catalogue (for SPA dropdown + validation) -----
const CHECK_TYPES = {
  np_min_dials: {
    label: 'Status must be dialled at least N times per window',
    description: 'Flags leads where status is one of the chosen ones and the lead was dialled fewer than min_dials times in the last window_hours. Used for "NP dialled only once per day" and similar rules.',
    realtime: false,
    daily: true,
    config_keys: ['status_ids', 'min_dials', 'window_hours', 'direction']
  },
  followup_requires_call: {
    label: 'Follow-up cannot be set without a recent call',
    description: 'Real-time check: when an agent sets next_followup_at, refuse-log unless there is an outgoing call event for this lead within call_window_hours.',
    realtime: true,
    daily: false,
    config_keys: ['call_window_hours']
  },
  idle_in_stage: {
    label: 'Lead idle in stage for too long',
    description: 'Flags leads in status_ids that haven\'t had any rep activity (remark/status/call) for max_idle_days.',
    realtime: false,
    daily: true,
    config_keys: ['status_ids', 'max_idle_days']
  },
  min_daily_activity: {
    label: 'Rep daily activity quota',
    description: 'Flags reps whose total lead activities for the day fall below min_activities. Activities = status changes, remarks, follow-up edits, reassigns, WhatsApp sends, etc.',
    realtime: false,
    daily: true,
    config_keys: ['min_activities', 'target_roles']
  },
  /* COMPLIANCE_v2 — extra check types added based on tenant feedback */
  status_change_requires_remark: {
    label: 'Status change must include a remark (real-time)',
    description: 'When an agent changes a lead\'s status to one of the chosen statuses, refuse-log if no remark was logged in the same save or within the last few minutes.',
    realtime: true,
    daily: false,
    config_keys: ['status_ids']
  },
  status_change_requires_recent_call: {
    label: 'Status change must follow a recent call (real-time)',
    description: 'When an agent moves a lead into one of the chosen statuses (e.g. Demo Scheduled, Qualified, Won), refuse-log if there\'s no outgoing call in the last N hours.',
    realtime: true,
    daily: false,
    config_keys: ['status_ids', 'call_window_hours']
  },
  no_status_change_in_n_days: {
    label: 'No status change in N days',
    description: 'Flags leads that have been parked in the same status for longer than max_days, regardless of activity. Use for SLA enforcement.',
    realtime: false,
    daily: true,
    config_keys: ['status_ids', 'max_days']
  },
  call_outside_hours: {
    label: 'Calls outside business hours',
    description: 'Flags outgoing calls made before start_hour or after end_hour (in tenant timezone). Useful for compliance/regulator rules.',
    realtime: false,
    daily: true,
    config_keys: ['start_hour', 'end_hour', 'allow_weekends']
  },
  assigned_no_action_n_days: {
    label: 'Assigned but no rep action for N days',
    description: 'Lead has an assigned rep, but no rep activity (remark / call / status / WhatsApp) has happened on it for the last N days.',
    realtime: false,
    daily: true,
    config_keys: ['max_days']
  }
};

// ----- schema bootstrap (self-healing) -----
let _ensured = false;
async function ensureSchema() {
  if (_ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS compliance_rules (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      check_type    TEXT NOT NULL,
      config_json   TEXT NOT NULL DEFAULT '{}',
      severity      TEXT NOT NULL DEFAULT 'warning',
      enabled       INT  NOT NULL DEFAULT 1,
      notify_agent  INT  NOT NULL DEFAULT 1,
      notify_manager INT NOT NULL DEFAULT 0,
      created_by    INT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS compliance_violations (
      id            SERIAL PRIMARY KEY,
      rule_id       INT NOT NULL,
      rule_name     TEXT,
      check_type    TEXT,
      severity      TEXT,
      lead_id       INT,
      user_id       INT,
      meta_json     TEXT,
      detected_at   TIMESTAMPTZ DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by INT
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cv_user_detected ON compliance_violations(user_id, detected_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cv_rule_detected ON compliance_violations(rule_id, detected_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_cv_lead          ON compliance_violations(lead_id)`);
  _ensured = true;
}

// ----- helpers -----
function _parseConfig(rule) {
  try { return rule && rule.config_json ? JSON.parse(rule.config_json) : {}; }
  catch (_) { return {}; }
}

async function _activeRules(checkType) {
  await ensureSchema();
  const where = checkType
    ? `WHERE enabled = 1 AND check_type = $1`
    : `WHERE enabled = 1`;
  const params = checkType ? [checkType] : [];
  const r = await db.query(`SELECT * FROM compliance_rules ${where} ORDER BY id`, params);
  return r.rows;
}

async function _logViolation(rule, leadId, userId, meta) {
  try {
    await db.query(
      `INSERT INTO compliance_violations (rule_id, rule_name, check_type, severity, lead_id, user_id, meta_json, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [rule.id, rule.name, rule.check_type, rule.severity || 'warning',
       leadId || null, userId || null, meta ? JSON.stringify(meta) : null]
    );
    // Push notify the agent if rule says so + we have a user
    if (Number(rule.notify_agent) === 1 && userId) {
      try {
        const push = require('./push');
        await push.sendPushToUser(Number(userId), {
          title: '⚠ Rule violation: ' + rule.name,
          body:  (rule.description || rule.name) + (leadId ? ' · Lead #' + leadId : ''),
          url:   '/#/compliance',
          tag:   'compliance-' + rule.id + '-' + (leadId || 0),
          sticky: rule.severity === 'critical'
        });
      } catch (_) {}
    }
  } catch (e) { console.warn('[compliance log]', e.message); }
}

// ============================================================
// EVAL FUNCTIONS — one per check_type
// ============================================================

/* np_min_dials — for each rule:
 *   For every lead in one of rule.status_ids:
 *     Count call_events for the lead in the last rule.window_hours hours
 *     where direction matches rule.direction (default 'out').
 *     If count < rule.min_dials → violation, attributed to lead.assigned_to.
 *
 * Skips leads with no assigned_to.
 */
async function _evalNpMinDials(rule) {
  const cfg = _parseConfig(rule);
  const statusIds = (cfg.status_ids || []).map(Number).filter(Boolean);
  const minDials  = Number(cfg.min_dials || 1);
  const windowHrs = Number(cfg.window_hours || 24);
  const direction = String(cfg.direction || 'out');
  if (!statusIds.length || !minDials) return;
  const q = await db.query(
    `SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name,
            COALESCE((
              SELECT COUNT(*) FROM call_events ce
               WHERE ce.lead_id = l.id
                 AND ce.direction = $1
                 AND ce.created_at >= NOW() - ($2 || ' hours')::interval
            ), 0)::int AS dial_count
       FROM leads l
      WHERE l.status_id = ANY($3::int[])
        AND l.assigned_to IS NOT NULL`,
    [direction, String(windowHrs), statusIds]
  );
  for (const row of q.rows) {
    if (Number(row.dial_count) < minDials) {
      await _logViolation(rule, row.lead_id, row.user_id, {
        dial_count: Number(row.dial_count),
        min_required: minDials,
        window_hours: windowHrs,
        direction
      });
    }
  }
}

/* followup_requires_call — REAL-TIME hook from api_leads_update / addRemark.
 * Caller passes { leadId, userId, newFollowupAt }. We check whether ANY
 * outgoing call_event for this lead exists in the last call_window_hours hours.
 * If none → log + (when block_action=1) throw, which the caller can catch
 * and propagate to the SPA toast.
 */
async function _evalFollowupRequiresCall(rule, ctx) {
  const cfg = _parseConfig(rule);
  const win = Number(cfg.call_window_hours || 24);
  if (!ctx.leadId) return null;
  const q = await db.query(
    `SELECT COUNT(*)::int AS c FROM call_events
      WHERE lead_id = $1 AND direction = 'out'
        AND created_at >= NOW() - ($2 || ' hours')::interval`,
    [Number(ctx.leadId), String(win)]
  );
  const calls = q.rows[0] ? Number(q.rows[0].c) : 0;
  if (calls === 0) {
    await _logViolation(rule, ctx.leadId, ctx.userId, {
      call_window_hours: win,
      reason: 'Follow-up set without an outgoing call in the last ' + win + 'h'
    });
    return { violated: true, message: rule.name + ' — ' + (rule.description || 'no outgoing call in the last ' + win + 'h before setting this follow-up') };
  }
  return null;
}

/* idle_in_stage — lead has been in one of rule.status_ids and has no
 * lead_actions newer than rule.max_idle_days. Uses last_status_change_at
 * as the "entered stage" reference when present, otherwise updated_at.
 */
async function _evalIdleInStage(rule) {
  const cfg = _parseConfig(rule);
  const statusIds = (cfg.status_ids || []).map(Number).filter(Boolean);
  const maxDays   = Number(cfg.max_idle_days || 7);
  if (!statusIds.length || !maxDays) return;
  const q = await db.query(
    `SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name,
            COALESCE(l.last_status_change_at, l.updated_at, l.created_at) AS stage_entered,
            (
              SELECT MAX(la.created_at) FROM lead_actions la
               WHERE la.lead_id = l.id AND la.action_type <> 'created'
            ) AS last_activity
       FROM leads l
      WHERE l.status_id = ANY($1::int[])
        AND l.assigned_to IS NOT NULL
        AND COALESCE(l.last_status_change_at, l.updated_at, l.created_at) < NOW() - ($2 || ' days')::interval
        AND (
          (SELECT MAX(la.created_at) FROM lead_actions la WHERE la.lead_id = l.id AND la.action_type <> 'created')
          IS NULL
          OR
          (SELECT MAX(la.created_at) FROM lead_actions la WHERE la.lead_id = l.id AND la.action_type <> 'created')
          < NOW() - ($2 || ' days')::interval
        )`,
    [statusIds, String(maxDays)]
  );
  for (const row of q.rows) {
    await _logViolation(rule, row.lead_id, row.user_id, {
      stage_entered: row.stage_entered,
      last_activity: row.last_activity,
      max_idle_days: maxDays
    });
  }
}

/* min_daily_activity — count today's lead_actions per user and flag any user
 * (matching target_roles) with total < min_activities.
 */
async function _evalMinDailyActivity(rule) {
  const cfg = _parseConfig(rule);
  const minN = Number(cfg.min_activities || 5);
  const roles = Array.isArray(cfg.target_roles) ? cfg.target_roles.map(String) : null;
  if (!minN) return;
  /* LEAD_ACTIVITY_v2 — exclude WhatsApp from rep activity quota so bot
   * replies / auto-template sends don't artificially boost a rep's count. */
  const q = await db.query(
    `SELECT u.id AS user_id, u.name, u.role,
            COALESCE((
              SELECT COUNT(*) FROM lead_actions la
               WHERE la.user_id = u.id
                 AND la.action_type NOT IN ('created', 'whatsapp_in', 'whatsapp_out')
                 AND la.created_at >= CURRENT_DATE
            ), 0)::int AS act_count
       FROM users u
      WHERE u.disabled = 0 OR u.disabled IS NULL`
  );
  for (const row of q.rows) {
    if (roles && !roles.includes(String(row.role))) continue;
    if (Number(row.act_count) < minN) {
      await _logViolation(rule, null, row.user_id, {
        activity_count: Number(row.act_count),
        min_required: minN,
        role: row.role
      });
    }
  }
}

// ============================================================
// COMPLIANCE_v2 — additional evaluators
// ============================================================

/* status_change_requires_remark — REAL-TIME hook. Caller passes
 *   { event:'status_change', leadId, userId, oldStatusId, newStatusId, hasRemarkInPatch }
 * If newStatusId is in rule.status_ids, check whether a remark was saved in
 * the same patch (hasRemarkInPatch) OR a remark was logged within last 60s. */
async function _evalStatusChangeRequiresRemark(rule, ctx) {
  const cfg = _parseConfig(rule);
  const statusIds = (cfg.status_ids || []).map(Number).filter(Boolean);
  if (!statusIds.length || !statusIds.includes(Number(ctx.newStatusId))) return null;
  if (ctx.hasRemarkInPatch) return null;
  const q = await db.query(
    `SELECT COUNT(*)::int AS c FROM remarks
      WHERE lead_id = $1 AND user_id = $2 AND created_at >= NOW() - INTERVAL '90 seconds'`,
    [Number(ctx.leadId), Number(ctx.userId)]
  );
  if (q.rows[0] && Number(q.rows[0].c) > 0) return null;
  await _logViolation(rule, ctx.leadId, ctx.userId, {
    new_status_id: ctx.newStatusId,
    old_status_id: ctx.oldStatusId,
    reason: 'Status changed to a watched status without a remark'
  });
  return { violated: true, message: rule.name + ' — please add a remark when changing to this status' };
}

/* status_change_requires_recent_call — REAL-TIME. Same as above but the
 * gate is an outgoing call within rule.call_window_hours. */
async function _evalStatusChangeRequiresRecentCall(rule, ctx) {
  const cfg = _parseConfig(rule);
  const statusIds = (cfg.status_ids || []).map(Number).filter(Boolean);
  if (!statusIds.length || !statusIds.includes(Number(ctx.newStatusId))) return null;
  const win = Number(cfg.call_window_hours || 24);
  const q = await db.query(
    `SELECT COUNT(*)::int AS c FROM call_events
      WHERE lead_id = $1 AND direction = 'out'
        AND created_at >= NOW() - ($2 || ' hours')::interval`,
    [Number(ctx.leadId), String(win)]
  );
  if (q.rows[0] && Number(q.rows[0].c) > 0) return null;
  await _logViolation(rule, ctx.leadId, ctx.userId, {
    new_status_id: ctx.newStatusId,
    call_window_hours: win,
    reason: 'Status changed without a call in the last ' + win + 'h'
  });
  return { violated: true, message: rule.name + ' — please call before changing to this status' };
}

/* no_status_change_in_n_days — daily. Flag leads where last_status_change_at
 * is older than rule.max_days AND the current status is in rule.status_ids. */
async function _evalNoStatusChangeInNDays(rule) {
  const cfg = _parseConfig(rule);
  const statusIds = (cfg.status_ids || []).map(Number).filter(Boolean);
  const maxDays   = Number(cfg.max_days || 7);
  if (!statusIds.length || !maxDays) return;
  const q = await db.query(
    `SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name,
            COALESCE(l.last_status_change_at, l.updated_at, l.created_at) AS last_change
       FROM leads l
      WHERE l.status_id = ANY($1::int[])
        AND l.assigned_to IS NOT NULL
        AND COALESCE(l.last_status_change_at, l.updated_at, l.created_at) < NOW() - ($2 || ' days')::interval`,
    [statusIds, String(maxDays)]
  );
  for (const row of q.rows) {
    await _logViolation(rule, row.lead_id, row.user_id, {
      last_change: row.last_change, max_days: maxDays,
      reason: 'No status change for over ' + maxDays + ' days'
    });
  }
}

/* call_outside_hours — daily. Find call_events from the last 24h whose
 * IST hour is < start_hour or >= end_hour. Optionally skip weekends. */
async function _evalCallOutsideHours(rule) {
  const cfg = _parseConfig(rule);
  const startH = Number(cfg.start_hour ?? 9);
  const endH   = Number(cfg.end_hour   ?? 19);
  const allowWeekends = !!cfg.allow_weekends;
  const q = await db.query(
    `SELECT id, lead_id, user_id, direction, created_at
       FROM call_events
      WHERE direction = 'out'
        AND created_at >= NOW() - INTERVAL '24 hours'`);
  for (const row of q.rows) {
    const d = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
    // Convert to Asia/Kolkata to get the user's local hour + weekday
    const tz = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', hour: '2-digit', weekday: 'short', hour12: false });
    const parts = tz.formatToParts(d);
    const hour = Number(parts.find(p => p.type === 'hour').value);
    const wk   = parts.find(p => p.type === 'weekday').value;
    const isWeekend = wk === 'Sat' || wk === 'Sun';
    if (isWeekend && !allowWeekends) {
      await _logViolation(rule, row.lead_id, row.user_id, { at: row.created_at, hour, weekday: wk, reason: 'Call on weekend' });
      continue;
    }
    if (hour < startH || hour >= endH) {
      await _logViolation(rule, row.lead_id, row.user_id, {
        at: row.created_at, hour, allowed: startH + '–' + endH,
        reason: 'Call outside ' + startH + ':00–' + endH + ':00 hours'
      });
    }
  }
}

/* assigned_no_action_n_days — daily. Lead has assigned_to but no
 * lead_actions newer than max_days. */
async function _evalAssignedNoActionNDays(rule) {
  const cfg = _parseConfig(rule);
  const maxDays = Number(cfg.max_days || 3);
  if (!maxDays) return;
  const q = await db.query(
    `SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name,
            COALESCE((SELECT MAX(la.created_at) FROM lead_actions la
                       WHERE la.lead_id = l.id AND la.action_type <> 'created'), l.created_at) AS last_act
       FROM leads l
      WHERE l.assigned_to IS NOT NULL
        AND COALESCE((SELECT MAX(la.created_at) FROM lead_actions la
                       WHERE la.lead_id = l.id AND la.action_type <> 'created'), l.created_at)
            < NOW() - ($1 || ' days')::interval`,
    [String(maxDays)]
  );
  for (const row of q.rows) {
    await _logViolation(rule, row.lead_id, row.user_id, {
      last_activity: row.last_act, max_days: maxDays,
      reason: 'No rep activity for over ' + maxDays + ' days'
    });
  }
}

// ============================================================
// PUBLIC ENTRY POINTS
// ============================================================

/* Real-time evaluator — called from routes/leads.js after a save.
 * Runs every realtime-flagged rule whose check matches the context.
 * Returns null if no violations or a single violation message (first hit).
 */
async function evaluateRealtime(ctx) {
  try {
    await ensureSchema();
    if (!ctx || !ctx.event) return null;
    if (ctx.event === 'followup_set') {
      const rules = await _activeRules('followup_requires_call');
      for (const r of rules) {
        const v = await _evalFollowupRequiresCall(r, ctx);
        if (v && v.violated) return v;
      }
    }
    /* COMPLIANCE_v2 — status-change realtime checks */
    if (ctx.event === 'status_change') {
      const remarkRules = await _activeRules('status_change_requires_remark');
      for (const r of remarkRules) {
        const v = await _evalStatusChangeRequiresRemark(r, ctx);
        if (v && v.violated) return v;
      }
      const callRules = await _activeRules('status_change_requires_recent_call');
      for (const r of callRules) {
        const v = await _evalStatusChangeRequiresRecentCall(r, ctx);
        if (v && v.violated) return v;
      }
    }
    return null;
  } catch (e) {
    console.warn('[compliance realtime]', e.message);
    return null;
  }
}

/* Daily worker — runs every rule that's flagged daily. Designed to be
 * idempotent enough that running it twice in a day just logs duplicate
 * rows (the SPA dedups in the by-rep view).
 */
async function runDailyScan() {
  await ensureSchema();
  const rules = await _activeRules(null);
  let logged = 0;
  const before = await db.query(`SELECT COUNT(*)::int AS c FROM compliance_violations WHERE detected_at >= NOW() - INTERVAL '5 minutes'`);
  for (const r of rules) {
    const meta = CHECK_TYPES[r.check_type];
    if (!meta || !meta.daily) continue;
    try {
      if (r.check_type === 'np_min_dials')                  await _evalNpMinDials(r);
      else if (r.check_type === 'idle_in_stage')            await _evalIdleInStage(r);
      else if (r.check_type === 'min_daily_activity')       await _evalMinDailyActivity(r);
      /* COMPLIANCE_v2 — new daily evaluators */
      else if (r.check_type === 'no_status_change_in_n_days') await _evalNoStatusChangeInNDays(r);
      else if (r.check_type === 'call_outside_hours')         await _evalCallOutsideHours(r);
      else if (r.check_type === 'assigned_no_action_n_days')  await _evalAssignedNoActionNDays(r);
    } catch (e) {
      console.warn('[compliance rule ' + r.id + ']', e.message);
    }
  }
  const after = await db.query(`SELECT COUNT(*)::int AS c FROM compliance_violations WHERE detected_at >= NOW() - INTERVAL '5 minutes'`);
  logged = Number(after.rows[0].c) - Number(before.rows[0].c);
  return { ok: true, rules_run: rules.length, violations_logged: logged };
}

// ============================================================
// CRUD APIs
// ============================================================

async function api_compliance_listCheckTypes(token) {
  await authUser(token);
  return Object.entries(CHECK_TYPES).map(([key, v]) => Object.assign({ key }, v));
}

async function api_compliance_rules_list(token) {
  const me = await authUser(token);
  await ensureSchema();
  const r = await db.query(`SELECT * FROM compliance_rules ORDER BY enabled DESC, id`);
  return r.rows.map(row => Object.assign({}, row, { config: _parseConfig(row) }));
}

async function api_compliance_rules_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  if (!CHECK_TYPES[p.check_type]) throw new Error('Unknown check_type: ' + p.check_type);
  const cfg = p.config && typeof p.config === 'object' ? p.config : {};
  const fields = [
    String(p.name).slice(0, 200),
    String(p.description || '').slice(0, 1000),
    String(p.check_type),
    JSON.stringify(cfg),
    String(p.severity || 'warning'),
    p.enabled === false || Number(p.enabled) === 0 ? 0 : 1,
    p.notify_agent === false || Number(p.notify_agent) === 0 ? 0 : 1,
    p.notify_manager === true  || Number(p.notify_manager) === 1 ? 1 : 0,
    me.id
  ];
  if (p.id) {
    await db.query(
      `UPDATE compliance_rules SET name=$1, description=$2, check_type=$3, config_json=$4,
            severity=$5, enabled=$6, notify_agent=$7, notify_manager=$8, updated_at=NOW()
        WHERE id=$9`,
      [...fields.slice(0, 8), Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  } else {
    const r = await db.query(
      `INSERT INTO compliance_rules (name, description, check_type, config_json,
          severity, enabled, notify_agent, notify_manager, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      fields
    );
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_compliance_rules_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await ensureSchema();
  await db.query(`DELETE FROM compliance_rules WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_compliance_rules_test(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await ensureSchema();
  const r = await db.query(`SELECT * FROM compliance_rules WHERE id = $1`, [Number(id)]);
  const rule = r.rows[0];
  if (!rule) throw new Error('Rule not found');
  const before = await db.query(`SELECT COUNT(*)::int AS c FROM compliance_violations`);
  const meta = CHECK_TYPES[rule.check_type];
  if (!meta || !meta.daily) return { ok: true, message: 'This rule is real-time only — fires on actual events.' };
  if (rule.check_type === 'np_min_dials')                  await _evalNpMinDials(rule);
  else if (rule.check_type === 'idle_in_stage')            await _evalIdleInStage(rule);
  else if (rule.check_type === 'min_daily_activity')       await _evalMinDailyActivity(rule);
  /* COMPLIANCE_v2 */
  else if (rule.check_type === 'no_status_change_in_n_days') await _evalNoStatusChangeInNDays(rule);
  else if (rule.check_type === 'call_outside_hours')         await _evalCallOutsideHours(rule);
  else if (rule.check_type === 'assigned_no_action_n_days')  await _evalAssignedNoActionNDays(rule);
  const after = await db.query(`SELECT COUNT(*)::int AS c FROM compliance_violations`);
  return { ok: true, new_violations: Number(after.rows[0].c) - Number(before.rows[0].c) };
}

async function api_compliance_violations_list(token, filters) {
  const me = await authUser(token);
  await ensureSchema();
  filters = filters || {};
  const visible = await getVisibleUserIds(me);
  const params = [visible];
  let where = 'cv.user_id = ANY($1::int[])';
  if (filters.rule_id)   { params.push(Number(filters.rule_id));     where += ' AND cv.rule_id = $' + params.length; }
  if (filters.user_id)   { params.push(Number(filters.user_id));     where += ' AND cv.user_id = $' + params.length; }
  if (filters.lead_id)   { params.push(Number(filters.lead_id));     where += ' AND cv.lead_id = $' + params.length; }
  if (filters.unack === '1' || filters.unack === 'only') where += ' AND cv.acknowledged_at IS NULL';
  if (filters.from)      { params.push(filters.from + 'T00:00:00');  where += ' AND cv.detected_at >= $' + params.length; }
  if (filters.to)        { params.push(filters.to   + 'T23:59:59');  where += ' AND cv.detected_at <= $' + params.length; }
  const r = await db.query(
    `SELECT cv.*, u.name AS user_name, l.name AS lead_name
       FROM compliance_violations cv
       LEFT JOIN users u ON u.id = cv.user_id
       LEFT JOIN leads l ON l.id = cv.lead_id
      WHERE ${where}
      ORDER BY cv.detected_at DESC
      LIMIT 1000`,
    params
  );
  return r.rows.map(row => Object.assign({}, row, {
    meta: (() => { try { return row.meta_json ? JSON.parse(row.meta_json) : {}; } catch (_) { return {}; } })()
  }));
}

async function api_compliance_violations_summary(token, opts) {
  const me = await authUser(token);
  await ensureSchema();
  opts = opts || {};
  const visible = await getVisibleUserIds(me);
  const params = [visible];
  let where = 'cv.user_id = ANY($1::int[])';
  if (opts.from) { params.push(opts.from + 'T00:00:00'); where += ' AND cv.detected_at >= $' + params.length; }
  if (opts.to)   { params.push(opts.to   + 'T23:59:59'); where += ' AND cv.detected_at <= $' + params.length; }

  const byRule = await db.query(
    `SELECT cv.rule_id, cv.rule_name, cv.check_type, cv.severity, COUNT(*)::int AS n
       FROM compliance_violations cv
      WHERE ${where}
      GROUP BY cv.rule_id, cv.rule_name, cv.check_type, cv.severity
      ORDER BY n DESC`,
    params
  );
  const byUser = await db.query(
    `SELECT cv.user_id, u.name AS user_name, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE cv.acknowledged_at IS NULL)::int AS open_n
       FROM compliance_violations cv
       LEFT JOIN users u ON u.id = cv.user_id
      WHERE ${where}
      GROUP BY cv.user_id, u.name
      ORDER BY n DESC`,
    params
  );
  const totals = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE acknowledged_at IS NULL)::int AS open,
            COUNT(*) FILTER (WHERE severity = 'critical')::int   AS critical,
            COUNT(*) FILTER (WHERE detected_at >= CURRENT_DATE)::int AS today
       FROM compliance_violations cv
      WHERE ${where}`,
    params
  );
  return {
    total:   totals.rows[0],
    by_rule: byRule.rows,
    by_user: byUser.rows
  };
}

async function api_compliance_violations_acknowledge(token, id) {
  const me = await authUser(token);
  await ensureSchema();
  await db.query(
    `UPDATE compliance_violations SET acknowledged_at = NOW(), acknowledged_by = $2 WHERE id = $1`,
    [Number(id), me.id]
  );
  return { ok: true };
}

async function api_compliance_runScanNow(token) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const out = await runDailyScan();
  return out;
}

module.exports = {
  // Internals exported for the lead-save hook + scheduler
  ensureSchema, evaluateRealtime, runDailyScan, CHECK_TYPES,
  // Tenant APIs
  api_compliance_listCheckTypes,
  api_compliance_rules_list,
  api_compliance_rules_save,
  api_compliance_rules_delete,
  api_compliance_rules_test,
  api_compliance_violations_list,
  api_compliance_violations_summary,
  api_compliance_violations_acknowledge,
  api_compliance_runScanNow
};
