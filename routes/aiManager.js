/* AI_MGR_v1 — AI Manager (virtual CRM admin/supervisor).
 *
 * Phase 1 (this commit) — MVP:
 *   - NL rule parser (Gemini-powered: type plain English → compliance rule)
 *   - Idle user detection (server-side worker, nudges via in-app popup)
 *   - New lead SLA tracker (first-call clock)
 *   - Daily user plan (priority work)
 *   - Daily admin report
 *   - Violation list + ack flow + reason capture
 *
 * Reuses: Gemini client, Lead Activity Tracker, Compliance Rules engine,
 *         Heat Detection, Push notifications. See AI_MANAGER_v1_BUILD_PLAN.md.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const gemini = require('../utils/geminiClient');

/* ════════════════════════════ SCHEMA ════════════════════════════ */

let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_rules (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      nl_text      TEXT,
      conditions   JSONB,
      action       JSONB,
      severity     TEXT DEFAULT 'medium',
      is_active    BOOLEAN DEFAULT TRUE,
      parsed_by    TEXT,
      confidence   REAL,
      created_by   INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_violations (
      id              SERIAL PRIMARY KEY,
      rule_id         INTEGER,
      user_id         INTEGER NOT NULL,
      violation_type  TEXT NOT NULL,
      lead_id         INTEGER,
      detected_at     TIMESTAMPTZ DEFAULT NOW(),
      expected_action TEXT,
      actual_status   TEXT,
      ai_action       TEXT,
      user_reason     TEXT,
      escalation_lvl  INTEGER DEFAULT 1,
      reviewed_at     TIMESTAMPTZ,
      reviewed_by     INTEGER,
      metadata        JSONB
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_mgr_viol_user_time ON ai_manager_violations(user_id, detected_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_mgr_viol_type ON ai_manager_violations(violation_type, detected_at DESC)`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_escalations (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL,
      violation_type   TEXT NOT NULL,
      current_level    INTEGER DEFAULT 1,
      repeat_count     INTEGER DEFAULT 0,
      last_violation_at TIMESTAMPTZ,
      reset_at         TIMESTAMPTZ,
      UNIQUE(user_id, violation_type)
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_reason_prompts (
      id            SERIAL PRIMARY KEY,
      violation_id  INTEGER NOT NULL,
      user_id       INTEGER NOT NULL,
      prompt_text   TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      responded_at  TIMESTAMPTZ,
      response_text TEXT,
      expired_at    TIMESTAMPTZ
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_mgr_prompt_user_open ON ai_manager_reason_prompts(user_id) WHERE responded_at IS NULL`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_idle_state (
      user_id                  INTEGER PRIMARY KEY,
      last_heartbeat_at        TIMESTAMPTZ,
      last_meaningful_action_at TIMESTAMPTZ,
      last_action_type         TEXT,
      idle_since               TIMESTAMPTZ,
      last_nudge_at            TIMESTAMPTZ,
      nudge_count_today        INTEGER DEFAULT 0
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_scorecard_daily (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL,
      score_date         DATE NOT NULL,
      total_calls        INTEGER DEFAULT 0,
      connected_calls    INTEGER DEFAULT 0,
      fu_completed       INTEGER DEFAULT 0,
      fu_missed          INTEGER DEFAULT 0,
      avg_response_min   REAL,
      remark_quality_pct REAL,
      idle_minutes       INTEGER DEFAULT 0,
      violation_count    INTEGER DEFAULT 0,
      score              INTEGER,
      score_breakdown    JSONB,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, score_date)
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_coaching (
      id           SERIAL PRIMARY KEY,
      user_id      INTEGER NOT NULL,
      week_start_date DATE NOT NULL,
      summary      TEXT,
      recommendations JSONB,
      score_trend  JSONB,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, week_start_date)
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_aimgr_coach_user ON ai_manager_coaching(user_id)`);

  const userCols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours_start TIME`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours_end TIME`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS eod_prompt_time TIME`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Kolkata'`,
  ];
  for (const sql of userCols) {
    try { await db.query(sql); } catch (e) { console.error('[AI_MGR_SCHEMA]', sql.slice(0, 60), e.message); }
  }

  _schemaReady = true;
}

/* ════════════════════════════ HELPERS ════════════════════════════ */

function _nowIst() { return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }); }
function _today()  { return new Date().toISOString().slice(0, 10); }

async function _isEnabled() {
  const v = await db.getConfig('AI_MANAGER_ENABLED');
  return String(v) === '1';
}

/* Cap idle nudges per user per hour to avoid spam.  Max 3 nudges/user/hour. */
async function _canNudge(userId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM ai_manager_violations
     WHERE user_id = $1 AND violation_type = 'idle'
       AND detected_at >= NOW() - INTERVAL '60 minutes'`, [userId]);
  return (r.rows[0].c || 0) < 3;
}

/* ════════════════════════════ NL → RULE PARSER ════════════════════════════ */

/* Local fallback parser for the common patterns the doc lists.  Cheap and
 * works without Gemini for the most-common rule shapes. */
function _localParseRule(nl) {
  const t = String(nl || '').toLowerCase();
  const out = { conditions: null, action: null, severity: 'medium', confidence: 0.5 };

  /* Idle X minutes */
  let m = t.match(/idle\s+(?:for\s+)?(?:more than\s+|>\s*)?(\d+)\s*(?:min|minute)/);
  if (m) {
    out.conditions = { type: 'idle', threshold_minutes: Number(m[1]) };
    out.action = { type: 'nudge', message: 'You have been idle. Please start calling or share the reason.' };
    out.confidence = 0.85;
    return out;
  }

  /* New lead untouched X minutes */
  m = t.match(/(?:new lead|call new lead|first call).*?(?:within|in|after)\s+(\d+)\s*(?:min|minute)/);
  if (m) {
    out.conditions = { type: 'new_lead_sla', threshold_minutes: Number(m[1]) };
    out.action = { type: 'nudge', message: 'New lead has not been contacted within SLA.' };
    out.confidence = 0.85;
    return out;
  }

  /* Follow-up missed (overdue by X min) */
  m = t.match(/follow[- ]up.*?(?:overdue|missed|late).*?(\d+)\s*(?:min|minute)/);
  if (m) {
    out.conditions = { type: 'fu_missed', threshold_minutes: Number(m[1]) };
    out.action = { type: 'nudge', message: 'A follow-up is overdue. Please complete it now.' };
    out.confidence = 0.8;
    return out;
  }

  /* Minimum daily calls */
  m = t.match(/(?:minimum|at least|min)\s+(\d+)\s+(?:call|calls)\s+(?:per|a)\s+day/);
  if (m) {
    out.conditions = { type: 'min_daily_calls', threshold: Number(m[1]) };
    out.action = { type: 'nudge', message: 'Daily call target not met.' };
    out.confidence = 0.75;
    return out;
  }

  return null;
}

/* Gemini-powered parser. Falls back to local if Gemini unavailable. */
async function _parseRule(nl) {
  /* Try local first — zero cost, fast */
  const local = _localParseRule(nl);
  if (local) return Object.assign(local, { parsed_by: 'local' });

  /* Gemini */
  const system = `You convert a sales manager's plain-English monitoring rule into structured JSON for an AI supervisor system.

Output ONLY this JSON shape (no commentary):
{
  "conditions": {"type": "<one of: idle | new_lead_sla | fu_missed | min_daily_calls | hot_lead_inactive | wa_reply_ignored | remark_quality | custom>", "threshold_minutes": <int or null>, "threshold": <int or null>, "extra": "<optional notes>"},
  "action":     {"type": "<one of: nudge | ask_reason | escalate>", "message": "<one short sentence for the user>"},
  "severity":   "<low | medium | high>",
  "confidence": <0..1>
}`;

  let r;
  try {
    r = await gemini.generate({
      prompt: 'Rule: ' + nl,
      system,
      maxOutputTokens: 240,
      temperature: 0.1,
      featureKey: 'ai_manager_rule_parse'
    });
  } catch (e) {
    console.error('[AI_MGR_PARSE]', e.message);
    return { conditions: { type: 'custom' }, action: { type: 'nudge', message: 'Rule check' }, severity: 'medium', confidence: 0.2, parsed_by: 'fallback' };
  }
  if (!r || !r.ok || !r.text) {
    return { conditions: { type: 'custom' }, action: { type: 'nudge', message: 'Rule check' }, severity: 'medium', confidence: 0.2, parsed_by: 'fallback' };
  }
  /* Extract JSON */
  try {
    const t = r.text.replace(/```json|```/g, '').trim();
    const j = JSON.parse(t);
    j.parsed_by = 'gemini';
    j.confidence = Number(j.confidence) || 0.6;
    return j;
  } catch (e) {
    console.error('[AI_MGR_PARSE] bad JSON:', r.text.slice(0, 200));
    return { conditions: { type: 'custom' }, action: { type: 'nudge', message: 'Rule check' }, severity: 'medium', confidence: 0.2, parsed_by: 'fallback' };
  }
}

/* ════════════════════════════ DETECTION WORKERS ════════════════════════════ */

/* Detect idle users.  Called by the cron worker every 2 minutes. */
async function detectIdleUsers() {
  /* Active rules of type=idle */
  const rules = (await db.query(
    `SELECT id, conditions, action FROM ai_manager_rules
     WHERE is_active = TRUE AND conditions->>'type' = 'idle' LIMIT 20`
  )).rows;
  if (!rules.length) return { idle: 0 };

  /* Take strictest threshold */
  let threshold = 20; /* default fallback */
  for (const r of rules) {
    const t = Number(r.conditions && r.conditions.threshold_minutes);
    if (t && t < threshold) threshold = t;
  }
  const ruleId = rules[0].id;
  const action = rules[0].action || {};

  /* Find users whose last_meaningful_action_at is > threshold ago AND within working hours */
  const sql = `
    SELECT u.id AS user_id, u.name, u.working_hours_start, u.working_hours_end, u.timezone,
           uis.last_meaningful_action_at, uis.last_nudge_at, uis.nudge_count_today
    FROM users u
    LEFT JOIN user_idle_state uis ON uis.user_id = u.id
    WHERE COALESCE(u.is_active, 1) = 1
      AND u.role IN ('sales', 'team_leader')
      AND uis.last_heartbeat_at >= NOW() - INTERVAL '5 minutes'
      AND (uis.last_meaningful_action_at IS NULL
           OR uis.last_meaningful_action_at < NOW() - (INTERVAL '1 minute' * $1))
      AND (uis.last_nudge_at IS NULL
           OR uis.last_nudge_at < NOW() - INTERVAL '20 minutes')
  `;
  const r = await db.query(sql, [threshold]);
  let count = 0;
  for (const u of r.rows) {
    if (!await _canNudge(u.user_id)) continue;
    /* In working hours? */
    if (u.working_hours_start && u.working_hours_end) {
      const istNow = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(11, 19);
      const startStr = String(u.working_hours_start);
      const endStr = String(u.working_hours_end);
      if (istNow < startStr || istNow > endStr) continue;
    }
    /* Insert violation */
    const v = await db.query(
      `INSERT INTO ai_manager_violations
         (rule_id, user_id, violation_type, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, $2, 'idle', 'Make a call or update a lead', 'No action for >' || $3 || ' min', 'nudge_sent', 1)
       RETURNING id`,
      [ruleId, u.user_id, threshold]
    );
    /* Queue reason prompt */
    const promptText = (action.message || `You have been idle for ${threshold}+ minutes. Please start calling pending leads or share the reason.`);
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text)
       VALUES ($1, $2, $3)`,
      [v.rows[0].id, u.user_id, promptText]
    );
    /* Mark nudge sent */
    await db.query(
      `UPDATE user_idle_state SET last_nudge_at = NOW(), nudge_count_today = COALESCE(nudge_count_today,0) + 1
       WHERE user_id = $1`, [u.user_id]
    );
    count++;
  }
  return { idle: count };
}

/* Detect new-lead SLA misses.  Reads rules of type=new_lead_sla, finds leads
 * assigned but not contacted (no call event) within threshold minutes. */
async function detectNewLeadSlaMiss() {
  const rules = (await db.query(
    `SELECT id, conditions, action FROM ai_manager_rules
     WHERE is_active = TRUE AND conditions->>'type' = 'new_lead_sla' LIMIT 20`
  )).rows;
  if (!rules.length) return { sla: 0 };
  let threshold = 15;
  for (const r of rules) {
    const t = Number(r.conditions && r.conditions.threshold_minutes);
    if (t && t < threshold) threshold = t;
  }
  const ruleId = rules[0].id;

  /* Leads created within last 24h, assigned, NO call event since assignment, age > threshold */
  const sql = `
    SELECT l.id AS lead_id, l.name, l.assigned_to AS user_id, l.created_at
    FROM leads l
    WHERE l.assigned_to IS NOT NULL
      AND l.created_at >= NOW() - INTERVAL '24 hours'
      AND l.created_at < NOW() - (INTERVAL '1 minute' * $1)
      AND NOT EXISTS (
        SELECT 1 FROM call_events ce
        WHERE ce.lead_id = l.id AND ce.created_at >= l.created_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = l.id AND v.violation_type = 'sla_miss'
      )
    LIMIT 50`;
  let rr;
  try { rr = await db.query(sql, [threshold]); }
  catch (e) { /* call_events may not exist on small tenants */ return { sla: 0, err: e.message }; }
  let count = 0;
  for (const row of rr.rows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
         (rule_id, user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, $2, 'sla_miss', $3, 'Call new lead within SLA', 'Not contacted within ' || $4 || ' min', 'reminder_sent', 1)
       RETURNING id`,
      [ruleId, row.user_id, row.lead_id, threshold]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text)
       VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, `New lead "${(row.name || '').slice(0, 40)}" was assigned ${threshold}+ minutes ago and not yet called.`]
    );
    count++;
  }
  return { sla: count };
}

/* The cron-callable entry point */
async function runDetectionCycle() {
  try {
    if (!await _isEnabled()) return { skipped: true };
    await _ensureSchema();
    const idle = await detectIdleUsers().catch(e => ({ err: e.message }));
    const sla  = await detectNewLeadSlaMiss().catch(e => ({ err: e.message }));
    return { ok: true, idle, sla };
  } catch (e) {
    console.error('[AI_MGR_CYCLE]', e.message);
    return { error: e.message };
  }
}

/* ════════════════════════════ ENDPOINTS ════════════════════════════ */

async function api_aiManager_status(token) {
  await _ensureSchema();
  await authUser(token);
  const enabled = await db.getConfig('AI_MANAGER_ENABLED');
  const rules = (await db.query(`SELECT COUNT(*)::int AS c FROM ai_manager_rules WHERE is_active`)).rows[0].c;
  const violationsToday = (await db.query(
    `SELECT COUNT(*)::int AS c FROM ai_manager_violations WHERE detected_at >= NOW() - INTERVAL '24 hours'`
  )).rows[0].c;
  const openPrompts = (await db.query(
    `SELECT COUNT(*)::int AS c FROM ai_manager_reason_prompts WHERE responded_at IS NULL`
  )).rows[0].c;
  return {
    enabled: String(enabled) === '1',
    ruleCount: rules,
    violationsToday,
    openPrompts,
    phase: 1
  };
}

async function api_aiManager_rules_list(token) {
  await _ensureSchema();
  await authUser(token);
  const r = await db.query(
    `SELECT id, name, nl_text, conditions, action, severity, is_active, parsed_by, confidence, created_at
     FROM ai_manager_rules ORDER BY id DESC LIMIT 200`
  );
  return { rules: r.rows };
}

/* api_aiManager_rules_parse — preview before save (returns parsed JSON) */
async function api_aiManager_rules_parse(token, payload) {
  await _ensureSchema();
  await authUser(token);
  payload = payload || {};
  const nl = String(payload.nl_text || '').slice(0, 1000);
  if (!nl.trim()) throw new Error('nl_text is required');
  const parsed = await _parseRule(nl);
  return { parsed };
}

async function api_aiManager_rules_save(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  payload = payload || {};
  const nl = String(payload.nl_text || '').slice(0, 1000);
  const name = String(payload.name || nl.slice(0, 60) || 'Untitled Rule').slice(0, 200);
  const parsed = payload.parsed || await _parseRule(nl);
  const row = {
    name,
    nl_text: nl,
    conditions: parsed.conditions || null,
    action: parsed.action || null,
    severity: String(parsed.severity || 'medium').slice(0, 20),
    is_active: payload.is_active !== false,
    parsed_by: String(parsed.parsed_by || 'manual').slice(0, 30),
    confidence: Number(parsed.confidence) || 0.5,
    created_by: me.id,
    created_at: new Date(),
    updated_at: new Date()
  };
  const id = await db.insert('ai_manager_rules', row);
  return { ok: true, id };
}

async function api_aiManager_rules_toggle(token, payload) {
  await _ensureSchema();
  await authUser(token);
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error('id required');
  await db.query(`UPDATE ai_manager_rules SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_aiManager_rules_delete(token, payload) {
  await _ensureSchema();
  await authUser(token);
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error('id required');
  await db.query(`DELETE FROM ai_manager_rules WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_aiManager_violations_list(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const where = [];
  const params = [];
  if (opts.user_id)        { params.push(Number(opts.user_id));    where.push(`v.user_id = $${params.length}`); }
  if (opts.violation_type) { params.push(String(opts.violation_type)); where.push(`v.violation_type = $${params.length}`); }
  if (opts.unreviewed)     { where.push(`v.reviewed_at IS NULL`); }
  const sql = `
    SELECT v.id, v.user_id, u.name AS user_name, v.violation_type, v.lead_id,
           l.name AS lead_name, v.detected_at, v.expected_action, v.actual_status,
           v.ai_action, v.user_reason, v.escalation_lvl, v.reviewed_at
    FROM ai_manager_violations v
    LEFT JOIN users u ON u.id = v.user_id
    LEFT JOIN leads l ON l.id = v.lead_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY v.detected_at DESC LIMIT ${limit}`;
  const r = await db.query(sql, params);
  return { violations: r.rows };
}

async function api_aiManager_violations_ack(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  payload = payload || {};
  const id = Number(payload.id);
  if (!id) throw new Error('id required');
  await db.query(
    `UPDATE ai_manager_violations SET reviewed_at = NOW(), reviewed_by = $1 WHERE id = $2`,
    [me.id, id]
  );
  return { ok: true };
}

/* ── ASK-FOR-REASON FLOW ──
 * SPA polls api_aiManager_prompts_open() periodically; if any rows returned,
 * shows a modal asking the user to type a reason; reason saved via
 * api_aiManager_prompts_respond().
 */
/* DIRECTIVE TEMPLATES — manager-style "you should do X next" copy per violation type.
 * Server-side so we can tune the language without an SPA deploy. */
const _DIRECTIVES = {
  idle:                 { severity: 'warning', icon: 'WARN', title: 'You have been idle',          headline: 'No activity logged in the last {actual}. Pick up a hot lead now — start with a call or send a WhatsApp.', action: 'Open a Hot lead and call.' },
  new_lead_sla:         { severity: 'urgent',  icon: 'URGENT', title: 'New lead waiting for you',  headline: 'Lead {lead} was assigned {actual} ago. SLA is {expected}. Call now before it goes cold.',                  action: 'Call this lead immediately.' },
  fake_activity:        { severity: 'urgent',  icon: 'URGENT', title: 'Status change without a call', headline: 'You moved {lead} to a new status, but no call event was recorded in the last 15 min. Update your records or actually make the call.', action: 'Add the call event or revert the status.' },
  wa_ignored:           { severity: 'urgent',  icon: 'URGENT', title: 'Customer is waiting',       headline: '{lead} replied {actual} ago. Respond now — every minute hurts conversion.',                                  action: 'Open the WhatsApp thread and reply.' },
  interested_no_action: { severity: 'warning', icon: 'WARN', title: 'Interested lead needs a quote', headline: '{lead} is at "Interested" for {actual} but no quotation sent yet. Send the quote today.',                action: 'Open the lead and create a quotation.' },
  fu_predue:            { severity: 'info',    icon: 'INFO', title: 'Follow-up coming up',          headline: 'Follow-up for {lead} is due in 30 min. Get ready — pull up notes and dial.',                                action: 'Review the lead before the call.' },
  fu_done_no_call:      { severity: 'warning', icon: 'WARN', title: 'Follow-up marked done — but no call', headline: 'You marked the FU for {lead} done, but there is no call event. Did you actually call? Update properly.', action: 'Confirm the call happened or undo the FU.' },
  short_calls:          { severity: 'warning', icon: 'WARN', title: 'Too many short calls',        headline: 'You made 3+ calls under 10 seconds in the last hour. That looks like dial-and-drop — talk to your team leader.', action: 'Slow down and have real conversations.' },
  copied_remarks:       { severity: 'warning', icon: 'WARN', title: 'Same remark across leads',    headline: 'You pasted the same remark on 3+ different leads in the last 24h. Write specific notes per lead.',           action: 'Edit each remark with real context.' },
  hot_to_cold:          { severity: 'warning', icon: 'WARN', title: 'Hot lead dropped to Cold',    headline: 'AI Rate of {lead} fell from Hot to Cold without a connect call. Reach out before you lose them.',            action: 'Call this lead today.' },
  lost_no_reason:       { severity: 'info',    icon: 'INFO', title: 'Lost lead missing reason',    headline: 'You marked {lead} as Lost but no reason was given. Add a lost reason so we can learn from it.',             action: 'Open the lead and fill in lost_reason.' },
  quoted_no_fu:         { severity: 'urgent',  icon: 'URGENT', title: 'Quote sent — no follow-up scheduled', headline: 'You sent a quote to {lead} {actual} ago. Set a follow-up date now or you will forget.',           action: 'Set next_followup_at on this lead.' },
  min_calls:            { severity: 'warning', icon: 'WARN', title: 'Daily call target behind',    headline: 'You are at {actual} calls today. Target is {expected}. Push 5-10 more before EOD.',                          action: 'Open Recent Calls and dial.' }
};

function _renderDirective(type, vrow) {
  const tmpl = _DIRECTIVES[type] || { severity: 'info', icon: 'INFO', title: 'AI Manager flagged this', headline: 'Check the violations tab for details.', action: '' };
  const lead = vrow.lead_name ? '"' + vrow.lead_name + '"' : 'a lead';
  const expected = vrow.expected || '';
  const actual = vrow.actual || '';
  const fill = (s) => String(s || '').replace(/{lead}/g, lead).replace(/{expected}/g, expected).replace(/{actual}/g, actual);
  return {
    severity: tmpl.severity,
    icon: tmpl.icon,
    title: fill(tmpl.title),
    headline: fill(tmpl.headline),
    action: fill(tmpl.action)
  };
}

async function api_aiManager_prompts_open(token) {
  await _ensureSchema();
  const me = await authUser(token);
  const r = await db.query(
    `SELECT p.id, p.violation_id, p.prompt_text, p.created_at,
            v.violation_type, v.lead_id, l.name AS lead_name,
            v.expected, v.actual, v.escalation_level
     FROM ai_manager_reason_prompts p
     JOIN ai_manager_violations v ON v.id = p.violation_id
     LEFT JOIN leads l ON l.id = v.lead_id
     WHERE p.user_id = $1 AND p.responded_at IS NULL
       AND (p.expired_at IS NULL OR p.expired_at > NOW())
     ORDER BY p.created_at DESC LIMIT 5`,
    [me.id]
  );
  /* Attach computed directive per prompt so SPA can render manager-style copy */
  const prompts = r.rows.map(row => ({ ...row, directive: _renderDirective(row.violation_type, row) }));
  return { prompts };
}

async function api_aiManager_prompts_respond(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  payload = payload || {};
  const id = Number(payload.id);
  const reason = String(payload.reason || '').slice(0, 500);
  if (!id || !reason.trim()) throw new Error('id and reason required');
  /* Update prompt */
  await db.query(
    `UPDATE ai_manager_reason_prompts SET responded_at = NOW(), response_text = $1
     WHERE id = $2 AND user_id = $3`,
    [reason, id, me.id]
  );
  /* Also save reason into the violation row */
  const p = (await db.query(`SELECT violation_id FROM ai_manager_reason_prompts WHERE id = $1`, [id])).rows[0];
  if (p) {
    await db.query(
      `UPDATE ai_manager_violations SET user_reason = $1 WHERE id = $2`,
      [reason, p.violation_id]
    );
  }
  return { ok: true };
}

/* ── HEARTBEAT (SPA pings every 30s while active) ── */
async function api_aiManager_heartbeat(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  payload = payload || {};
  await db.query(`
    INSERT INTO user_idle_state (user_id, last_heartbeat_at, last_meaningful_action_at, last_action_type)
    VALUES ($1, NOW(),
      CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
      $3)
    ON CONFLICT (user_id) DO UPDATE SET
      last_heartbeat_at = NOW(),
      last_meaningful_action_at = CASE WHEN $2::boolean THEN NOW() ELSE user_idle_state.last_meaningful_action_at END,
      last_action_type = CASE WHEN $2::boolean THEN $3 ELSE user_idle_state.last_action_type END
  `, [me.id, !!payload.meaningful, String(payload.action_type || '').slice(0, 50)]);
  return { ok: true };
}

/* ── USER SCHEDULE (per-user working hours) ── */
async function api_aiManager_userSchedule_get(token, opts) {
  await _ensureSchema();
  const me = await authUser(token);
  opts = opts || {};
  const uid = (opts.user_id && (me.role === 'admin' || me.role === 'manager')) ? Number(opts.user_id) : me.id;
  const r = await db.query(`SELECT id, name, working_hours_start, working_hours_end, eod_prompt_time, timezone FROM users WHERE id = $1`, [uid]);
  if (!r.rows.length) throw new Error('User not found');
  return r.rows[0];
}
async function api_aiManager_userSchedule_save(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  payload = payload || {};
  const uid = (payload.user_id && (me.role === 'admin' || me.role === 'manager')) ? Number(payload.user_id) : me.id;
  const patch = {};
  if (payload.working_hours_start !== undefined) patch.working_hours_start = String(payload.working_hours_start).trim() || null;
  if (payload.working_hours_end !== undefined)   patch.working_hours_end = String(payload.working_hours_end).trim() || null;
  if (payload.eod_prompt_time !== undefined)     patch.eod_prompt_time = String(payload.eod_prompt_time).trim() || null;
  if (payload.timezone !== undefined)            patch.timezone = String(payload.timezone).trim() || 'Asia/Kolkata';
  if (Object.keys(patch).length === 0) return { ok: true, changed: 0 };
  await db.update('users', uid, patch);
  return { ok: true, changed: Object.keys(patch).length };
}

/* ── DAILY PLAN (returns priority work for the calling user) ── */
async function api_aiManager_dailyPlan(token) {
  await _ensureSchema();
  const me = await authUser(token);

  /* Pending follow-ups due today/overdue */
  const fus = (await db.query(
    `SELECT COUNT(*)::int AS due FROM leads
     WHERE assigned_to = $1
       AND next_followup_at IS NOT NULL
       AND next_followup_at::date <= CURRENT_DATE
       AND COALESCE(is_followup_done, 0) = 0`,
    [me.id]
  ).catch(() => ({ rows: [{ due: 0 }] }))).rows[0];

  /* Hot leads (AI Rate ≥ 80) */
  const hot = (await db.query(
    `SELECT COUNT(*)::int AS c FROM leads WHERE assigned_to = $1 AND smart_category = 'Hot'`, [me.id]
  ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0];

  /* New leads untouched */
  const newL = (await db.query(
    `SELECT COUNT(*)::int AS c FROM leads
     WHERE assigned_to = $1 AND created_at >= CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM call_events ce WHERE ce.lead_id = leads.id)`,
    [me.id]
  ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0];

  return {
    user_id: me.id,
    date: _today(),
    today: {
      followups_due:    fus.due || 0,
      hot_leads:        hot.c   || 0,
      new_untouched:    newL.c  || 0
    },
    headline: `Today — call ${(hot.c || 0)} Hot lead(s), complete ${(fus.due || 0)} follow-up(s), contact ${(newL.c || 0)} new lead(s).`
  };
}

/* ── DAILY ADMIN REPORT ── */
async function api_aiManager_dailyReport(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const day = String(opts.date || _today());
  const sql = `
    SELECT u.id AS user_id, u.name,
           COALESCE(c.total_calls, 0) AS total_calls,
           COALESCE(c.connected_calls, 0) AS connected_calls,
           COALESCE(f.fu_due, 0)  AS fu_due,
           COALESCE(f.fu_done, 0) AS fu_done,
           COALESCE(v.violation_count, 0) AS violation_count,
           COALESCE(uis.last_nudge_at IS NOT NULL, false) AS got_nudge_today
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS total_calls,
             COUNT(*) FILTER (WHERE COALESCE(duration_seconds,0) > 0) AS connected_calls
      FROM call_events
      WHERE created_at::date = $1
      GROUP BY user_id
    ) c ON c.user_id = u.id
    LEFT JOIN (
      SELECT assigned_to AS user_id,
             COUNT(*) FILTER (WHERE next_followup_at::date = $1) AS fu_due,
             COUNT(*) FILTER (WHERE next_followup_at::date = $1 AND COALESCE(is_followup_done,0)=1) AS fu_done
      FROM leads GROUP BY assigned_to
    ) f ON f.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS violation_count
      FROM ai_manager_violations
      WHERE detected_at::date = $1
      GROUP BY user_id
    ) v ON v.user_id = u.id
    LEFT JOIN user_idle_state uis ON uis.user_id = u.id
    WHERE COALESCE(u.is_active, 1) = 1 AND u.role IN ('sales', 'team_leader', 'manager')
    ORDER BY violation_count DESC, total_calls DESC`;
  let r;
  try { r = await db.query(sql, [day]); }
  catch (e) { return { date: day, rows: [], err: e.message }; }
  return { date: day, rows: r.rows };
}


/* ════════════════════════════ PHASE 2 — ADVANCED DETECTION ════════════════════════════ */

/* 7.1 — Remark Quality.  Local heuristic (cheap), optional Gemini classify. */
function _classifyRemarkLocal(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return { quality: 'blank',  reason: 'empty' };
  if (t.length < 4) return { quality: 'weak', reason: 'too_short' };
  const weakSet = ['ok', 'done', 'call later', 'will call', 'noted', 'na', 'n/a', 'nothing', 'cool', 'yes', 'no'];
  if (weakSet.includes(t)) return { quality: 'weak', reason: 'generic_phrase' };
  if (/^(call|talk|spoke|will|follow)[\s\.,]{0,2}$/.test(t)) return { quality: 'weak', reason: 'truncated' };
  return { quality: 'valid', reason: 'ok' };
}

/* Hook (call from routes/leads.js api_leads_addRemark or QNote save).
 * Inserts a violation if remark is blank/weak. */
async function checkRemarkQuality({ userId, leadId, remarkText }) {
  if (!await _isEnabled()) return { skipped: true };
  await _ensureSchema();
  const c = _classifyRemarkLocal(remarkText);
  if (c.quality === 'valid') return c;
  /* Find a remark-quality rule (or use defaults) */
  const ru = (await db.query(
    `SELECT id FROM ai_manager_rules WHERE is_active = TRUE AND conditions->>'type' IN ('remark_quality','custom') LIMIT 1`
  )).rows[0];
  const v = await db.query(
    `INSERT INTO ai_manager_violations
      (rule_id, user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl, metadata)
     VALUES ($1, $2, 'weak_remark', $3, 'Add a substantive remark with client response + next step', $4, 'reminder_sent', 1, $5)
     RETURNING id`,
    [ru ? ru.id : null, userId, leadId, 'Remark classified ' + c.quality + ': "' + String(remarkText).slice(0, 40) + '"', JSON.stringify(c)]
  );
  await db.query(
    `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text)
     VALUES ($1, $2, $3)`,
    [v.rows[0].id, userId, 'Your last remark was flagged as "' + c.quality + '". Please update with the actual client response and next action.']
  );
  return c;
}

/* 7.2 — Fake activity detection. SQL pattern matches.
 * Runs as part of the cron cycle (called from runDetectionCycle below). */
async function detectFakeActivity() {
  if (!await _isEnabled()) return { fake: 0 };

  /* Pattern A: Status changed but no call event on that lead in last hour. */
  const sqlA = `
    SELECT l.id AS lead_id, l.assigned_to AS user_id
    FROM leads l
    WHERE l.last_status_change_at >= NOW() - INTERVAL '1 hour'
      AND l.assigned_to IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM call_events ce WHERE ce.lead_id = l.id AND ce.created_at >= l.last_status_change_at - INTERVAL '15 minutes'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v WHERE v.lead_id = l.id AND v.violation_type = 'fake_activity' AND v.detected_at >= NOW() - INTERVAL '6 hours'
      )
    LIMIT 30`;
  let aRows = [];
  try { aRows = (await db.query(sqlA)).rows; } catch (_) { /* tables may not exist */ }
  let count = 0;
  for (const row of aRows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'fake_activity', $2, 'Make a call before changing status', 'Status changed without call event', 'flagged', 2)
       RETURNING id`,
      [row.user_id, row.lead_id]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text)
       VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, 'You changed a lead status without a recorded call. Please explain or add the missing call.']
    );
    count++;
  }
  return { fake: count };
}

/* 7.3 — WhatsApp reply monitoring. */
async function detectWaIgnoredReplies() {
  if (!await _isEnabled()) return { wa: 0 };
  /* Inbound message from client without an outbound reply within X min,
   * lead owner gets notified. */
  const threshold = 30; /* minutes */
  const sql = `
    SELECT m.lead_id, l.assigned_to AS user_id, l.name AS lead_name
    FROM whatsapp_messages m
    JOIN leads l ON l.id = m.lead_id
    WHERE m.direction = 'in'
      AND m.created_at >= NOW() - INTERVAL '6 hours'
      AND m.created_at < NOW() - (INTERVAL '1 minute' * $1)
      AND l.assigned_to IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_messages m2
        WHERE m2.lead_id = m.lead_id AND m2.direction = 'out' AND m2.created_at > m.created_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = m.lead_id AND v.violation_type = 'wa_ignored'
          AND v.detected_at >= NOW() - INTERVAL '6 hours'
      )
    LIMIT 30`;
  let rows = [];
  try { rows = (await db.query(sql, [threshold])).rows; } catch (_) { return { wa: 0 }; }
  let count = 0;
  for (const row of rows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'wa_ignored', $2, 'Reply to WhatsApp message', 'Client replied ' || $3 || '+ min ago, no response', 'nudge_sent', 1)
       RETURNING id`,
      [row.user_id, row.lead_id, threshold]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text)
       VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, 'Client "' + (row.lead_name || '').slice(0, 30) + '" replied on WhatsApp ' + threshold + '+ minutes ago. Please reply now.']
    );
    count++;
  }
  return { wa: count };
}

/* 7.4 — Lead Risk Report endpoint */
async function api_aiManager_leadRisk(token) {
  await _ensureSchema();
  await authUser(token);
  const sql = `
    WITH risks AS (
      /* Interested but no follow-up */
      SELECT id, name, assigned_to, 'interested_no_fu' AS reason, 'high' AS severity
      FROM leads
      WHERE LOWER(COALESCE(status_id::text, '')) IN (SELECT id::text FROM statuses WHERE LOWER(name) LIKE '%interested%' OR LOWER(name) LIKE '%hot%')
        AND next_followup_at IS NULL
      UNION ALL
      /* Hot AI Rate but no recent action */
      SELECT id, name, assigned_to, 'hot_inactive' AS reason, 'high' AS severity
      FROM leads
      WHERE smart_category = 'Hot' AND updated_at < NOW() - INTERVAL '2 days'
      UNION ALL
      /* Ageing leads with no follow-up */
      SELECT id, name, assigned_to, 'ageing_no_fu' AS reason, 'medium' AS severity
      FROM leads
      WHERE updated_at < NOW() - INTERVAL '7 days'
        AND next_followup_at IS NULL
        AND (smart_category IS NULL OR smart_category NOT IN ('Cold','Invalid'))
    )
    SELECT r.id AS lead_id, r.name AS lead_name, r.reason, r.severity, u.name AS owner
    FROM risks r LEFT JOIN users u ON u.id = r.assigned_to
    LIMIT 200`;
  let r;
  try { r = await db.query(sql); }
  catch (e) { return { risks: [], err: e.message }; }
  return { risks: r.rows };
}

/* 7.5 — 5-Level Escalation Engine.
 * Called after every violation insert (above functions can call this
 * to bump escalation level if user repeats same violation type). */
async function _bumpEscalation(userId, violationType) {
  const r = await db.query(
    `INSERT INTO ai_manager_escalations (user_id, violation_type, current_level, repeat_count, last_violation_at)
     VALUES ($1, $2, 1, 1, NOW())
     ON CONFLICT (user_id, violation_type) DO UPDATE SET
       repeat_count = ai_manager_escalations.repeat_count + 1,
       last_violation_at = NOW(),
       current_level = LEAST(5, ai_manager_escalations.current_level + (CASE WHEN ai_manager_escalations.repeat_count >= 2 THEN 1 ELSE 0 END))
     RETURNING current_level`,
    [userId, violationType]
  );
  return r.rows[0].current_level;
}

/* 7.6 — Performance Scorecard.  Run nightly or on-demand. */
async function recomputeScorecard(scoreDate) {
  const day = scoreDate || _today();
  const sql = `
    INSERT INTO user_scorecard_daily
      (user_id, score_date, total_calls, connected_calls, fu_completed, fu_missed,
       avg_response_min, remark_quality_pct, idle_minutes, violation_count, score, score_breakdown)
    SELECT
      u.id,
      $1::date,
      COALESCE(c.total_calls, 0),
      COALESCE(c.connected_calls, 0),
      COALESCE(f.fu_done, 0),
      COALESCE(f.fu_due, 0) - COALESCE(f.fu_done, 0),
      NULL::real,
      NULL::real,
      0,
      COALESCE(v.cnt, 0),
      LEAST(100, GREATEST(0,
        (25 * LEAST(1.0, COALESCE(c.total_calls, 0)::real / 30))::int +
        (25 * LEAST(1.0, COALESCE(f.fu_done, 0)::real / GREATEST(1, COALESCE(f.fu_due, 1))))::int +
        (20 * LEAST(1.0, COALESCE(c.connected_calls, 0)::real / GREATEST(1, COALESCE(c.total_calls, 1))))::int +
        15 +
        (15 - LEAST(15, COALESCE(v.cnt, 0) * 3))
      )),
      jsonb_build_object('calls_pct', LEAST(100, COALESCE(c.total_calls, 0) * 3),
                         'fu_pct',    LEAST(100, COALESCE(f.fu_done, 0) * 10),
                         'violations', COALESCE(v.cnt, 0))
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS total_calls,
             COUNT(*) FILTER (WHERE COALESCE(duration_seconds, 0) > 0) AS connected_calls
      FROM call_events WHERE created_at::date = $1 GROUP BY user_id
    ) c ON c.user_id = u.id
    LEFT JOIN (
      SELECT assigned_to AS user_id,
             COUNT(*) FILTER (WHERE next_followup_at::date = $1) AS fu_due,
             COUNT(*) FILTER (WHERE next_followup_at::date = $1 AND COALESCE(is_followup_done, 0) = 1) AS fu_done
      FROM leads GROUP BY assigned_to
    ) f ON f.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) AS cnt FROM ai_manager_violations
      WHERE detected_at::date = $1 GROUP BY user_id
    ) v ON v.user_id = u.id
    WHERE COALESCE(u.is_active, 1) = 1 AND u.role IN ('sales', 'team_leader', 'manager')
    ON CONFLICT (user_id, score_date) DO UPDATE SET
      total_calls = EXCLUDED.total_calls,
      connected_calls = EXCLUDED.connected_calls,
      fu_completed = EXCLUDED.fu_completed,
      fu_missed = EXCLUDED.fu_missed,
      violation_count = EXCLUDED.violation_count,
      score = EXCLUDED.score,
      score_breakdown = EXCLUDED.score_breakdown`;
  try {
    await db.query(sql, [day]);
    return { ok: true, date: day };
  } catch (e) {
    return { error: e.message, date: day };
  }
}

async function api_aiManager_scorecard(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const day = String(opts.date || _today());
  /* Lazy refresh */
  await recomputeScorecard(day);
  const r = await db.query(
    `SELECT s.user_id, u.name, s.score, s.total_calls, s.connected_calls,
            s.fu_completed, s.fu_missed, s.violation_count, s.score_breakdown
     FROM user_scorecard_daily s
     JOIN users u ON u.id = s.user_id
     WHERE s.score_date = $1
     ORDER BY s.score DESC NULLS LAST`,
    [day]
  );
  return { date: day, scorecards: r.rows };
}

/* Override the original runDetectionCycle to add Phase 2 detectors */
const _runDetectionCycle_phase1 = runDetectionCycle;
async function runDetectionCycle() {
  try {
    if (!await _isEnabled()) return { skipped: true };
    await _ensureSchema();
    const idle = await detectIdleUsers().catch(e => ({ err: e.message }));
    const sla  = await detectNewLeadSlaMiss().catch(e => ({ err: e.message }));
    const fake = await detectFakeActivity().catch(e => ({ err: e.message }));
    const wa   = await detectWaIgnoredReplies().catch(e => ({ err: e.message }));
    return { ok: true, idle, sla, fake, wa };
  } catch (e) {
    console.error('[AI_MGR_CYCLE]', e.message);
    return { error: e.message };
  }
}


/* ════════════════════════════ PHASE 3 — AI COACHING ════════════════════════════ */

/* 8.1 — Weekly coaching digest per user.
 * Pulls last 7 days of scorecards + violations + top wins, asks Gemini
 * to write 3 bullet points of coaching feedback. */
async function generateCoachingDigest(userId) {
  if (!await _isEnabled()) return { skipped: true };
  await _ensureSchema();
  /* Pull last 7 scorecards */
  const sc = await db.query(
    `SELECT score_date, score, total_calls, connected_calls, fu_completed, fu_missed, violation_count
     FROM user_scorecard_daily WHERE user_id = $1 AND score_date >= CURRENT_DATE - INTERVAL '7 days'
     ORDER BY score_date DESC`, [userId]
  );
  const v = await db.query(
    `SELECT violation_type, COUNT(*) AS cnt FROM ai_manager_violations
     WHERE user_id = $1 AND detected_at >= NOW() - INTERVAL '7 days'
     GROUP BY violation_type ORDER BY cnt DESC LIMIT 5`, [userId]
  );
  const u = await db.query(`SELECT name FROM users WHERE id = $1`, [userId]);
  const userName = u.rows[0] ? u.rows[0].name : 'User';

  /* Fallback (no LLM): simple template */
  let summary = '';
  let recommendations = [];
  const last = sc.rows[0] || {};
  const avgScore = sc.rows.length ? Math.round(sc.rows.reduce((s, r) => s + (r.score || 0), 0) / sc.rows.length) : 0;
  const totalCalls = sc.rows.reduce((s, r) => s + (r.total_calls || 0), 0);
  const totalFu = sc.rows.reduce((s, r) => s + (r.fu_completed || 0), 0);
  const totalMiss = sc.rows.reduce((s, r) => s + (r.fu_missed || 0), 0);

  try {
    const gemini = require('../utils/geminiClient');
    if (gemini && gemini.generate) {
      const prompt = 'You are an AI sales coach. Write a SHORT (3 bullet points, < 60 words total) ' +
        'coaching message for ' + userName + ' based on their weekly performance:\n\n' +
        'Avg score: ' + avgScore + '/100\n' +
        'Total calls (7d): ' + totalCalls + '\n' +
        'Follow-ups completed: ' + totalFu + ' done, ' + totalMiss + ' missed\n' +
        'Top violations: ' + v.rows.map(r => r.violation_type + ' (' + r.cnt + ')').join(', ') + '\n\n' +
        'Return JSON: {"summary":"one-line praise/observation","tips":["tip1","tip2","tip3"]}';
      const r = await gemini.generate({ prompt, maxTokens: 200 });
      if (r && r.ok && r.text) {
        const m = r.text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            const j = JSON.parse(m[0]);
            summary = String(j.summary || '');
            recommendations = Array.isArray(j.tips) ? j.tips.slice(0, 5) : [];
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  if (!summary) {
    summary = avgScore >= 70 ? 'Strong week overall — keep the momentum.' : avgScore >= 50 ? 'Mixed week — opportunity to lift performance.' : 'Tough week — focus on the basics next week.';
    recommendations = [];
    if (totalMiss > totalFu) recommendations.push('Close out follow-ups before adding new ones — too many missed this week.');
    if (totalCalls < 50) recommendations.push('Increase outbound call volume; aim for 15+ calls per day.');
    if (v.rows.length) recommendations.push('Address recurring violations: ' + v.rows[0].violation_type + '.');
    if (!recommendations.length) recommendations.push('Keep building on consistent activity.');
  }

  await db.query(
    `INSERT INTO ai_manager_coaching (user_id, week_start_date, summary, recommendations, score_trend)
     VALUES ($1, DATE_TRUNC('week', CURRENT_DATE)::date, $2, $3, $4)
     ON CONFLICT (user_id, week_start_date) DO UPDATE SET
       summary = EXCLUDED.summary,
       recommendations = EXCLUDED.recommendations,
       score_trend = EXCLUDED.score_trend,
       generated_at = NOW()`,
    [userId, summary, JSON.stringify(recommendations), JSON.stringify(sc.rows)]
  );
  return { ok: true, summary, recommendations };
}

async function api_aiManager_coaching(token, opts) {
  await _ensureSchema();
  const me = await authUser(token);
  opts = opts || {};
  const userId = opts.user_id || me.id;
  /* Lazy refresh if missing or older than 6h */
  const ex = await db.query(
    `SELECT * FROM ai_manager_coaching WHERE user_id = $1
     AND week_start_date = DATE_TRUNC('week', CURRENT_DATE)::date`, [userId]
  );
  if (!ex.rows.length || (Date.now() - new Date(ex.rows[0].generated_at).getTime()) > 6 * 3600 * 1000) {
    await generateCoachingDigest(userId);
  }
  const r = await db.query(
    `SELECT c.*, u.name AS user_name FROM ai_manager_coaching c
     JOIN users u ON u.id = c.user_id
     WHERE c.user_id = $1 AND c.week_start_date = DATE_TRUNC('week', CURRENT_DATE)::date`, [userId]
  );
  if (!r.rows.length) return { coaching: null };
  const row = r.rows[0];
  return {
    coaching: {
      user_id: row.user_id,
      user_name: row.user_name,
      week_start: row.week_start_date,
      summary: row.summary,
      recommendations: typeof row.recommendations === 'string' ? JSON.parse(row.recommendations) : row.recommendations,
      score_trend: typeof row.score_trend === 'string' ? JSON.parse(row.score_trend) : row.score_trend,
      generated_at: row.generated_at
    }
  };
}

/* 8.2 — Conversion probability (rule-based, no LLM). 0-100 score per
 * lead derived from existing AI Rate + activity + status + ageing. */
async function api_aiManager_conversionProb(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit || 100), 500);
  const sql = `
    SELECT l.id, l.name, l.assigned_to, u.name AS owner,
      l.smart_score, l.smart_category,
      (
        COALESCE(l.smart_score, 30) * 0.5 +
        CASE WHEN l.next_followup_at IS NOT NULL THEN 15 ELSE 0 END +
        CASE WHEN l.updated_at >= NOW() - INTERVAL '3 days' THEN 15 ELSE 0 END +
        CASE WHEN l.smart_category = 'Hot' THEN 20 WHEN l.smart_category = 'Warm' THEN 10 ELSE 0 END
      ) AS conv_pct
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE COALESCE(l.is_won, 0) = 0
    ORDER BY conv_pct DESC NULLS LAST LIMIT $1`;
  let r;
  try { r = await db.query(sql, [limit]); }
  catch (e) { return { leads: [], err: e.message }; }
  const leads = r.rows.map(row => ({
    id: row.id, name: row.name, owner: row.owner,
    smart_score: row.smart_score, smart_category: row.smart_category,
    conversion_pct: Math.min(100, Math.round(row.conv_pct || 0))
  }));
  return { leads };
}

/* 8.3 — Revenue Leakage Report. Ageing high-value + stale interested. */
async function api_aiManager_revenueLeak(token) {
  await _ensureSchema();
  await authUser(token);
  const sql = `
    SELECT l.id AS lead_id, l.name AS lead_name, u.name AS owner,
      l.updated_at,
      COALESCE(EXTRACT(DAY FROM (NOW() - l.updated_at)), 0)::int AS days_stale,
      CASE
        WHEN COALESCE(l.smart_score, 0) >= 70 AND l.updated_at < NOW() - INTERVAL '5 days' THEN 'high_value_stale'
        WHEN l.smart_category = 'Hot' AND l.next_followup_at IS NULL THEN 'hot_no_fu'
        WHEN l.updated_at < NOW() - INTERVAL '14 days' AND COALESCE(l.is_won, 0) = 0 AND COALESCE(l.is_lost, 0) = 0 THEN 'ageing_open'
        ELSE NULL
      END AS leakage_reason
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
    WHERE COALESCE(l.is_won, 0) = 0 AND COALESCE(l.is_lost, 0) = 0
    LIMIT 500`;
  let r;
  try { r = await db.query(sql); }
  catch (e) { return { leaks: [], err: e.message }; }
  const leaks = r.rows.filter(x => x.leakage_reason);
  return { leaks };
}

/* 8.4 — Auto Task Suggestions (per lead, rule-based). */
async function api_aiManager_nextBestAction(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const leadId = Number(opts.lead_id);
  if (!leadId) return { error: 'lead_id required' };
  const l = await db.query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
  if (!l.rows.length) return { error: 'not_found' };
  const lead = l.rows[0];
  const suggestions = [];
  if (lead.smart_category === 'Hot') {
    if (!lead.next_followup_at) suggestions.push({ priority: 'high', action: 'Set a follow-up within 24h — this lead is Hot.' });
    suggestions.push({ priority: 'high', action: 'Call now — Hot leads convert when contacted within an hour.' });
  }
  if (!lead.next_followup_at) suggestions.push({ priority: 'medium', action: 'Add a next follow-up date.' });
  if (!lead.notes || String(lead.notes).length < 20) suggestions.push({ priority: 'medium', action: 'Add detailed remarks — current notes are sparse.' });
  if (lead.updated_at && (Date.now() - new Date(lead.updated_at).getTime()) > 7 * 24 * 3600 * 1000) {
    suggestions.push({ priority: 'high', action: 'Lead has been silent 7+ days — send a re-engagement message.' });
  }
  if (!suggestions.length) suggestions.push({ priority: 'low', action: 'Lead is on track — keep monitoring.' });
  return { lead_id: leadId, suggestions };
}

/* 8.5 — Manager weekly digest (admin view). */
async function api_aiManager_managerDigest(token) {
  await _ensureSchema();
  await authUser(token);
  /* Pull team averages */
  const sc = await db.query(
    `SELECT u.id, u.name,
       AVG(s.score) AS avg_score, SUM(s.total_calls) AS total_calls,
       SUM(s.fu_completed) AS fu_done, SUM(s.fu_missed) AS fu_miss,
       SUM(s.violation_count) AS violations
     FROM users u
     LEFT JOIN user_scorecard_daily s ON s.user_id = u.id
       AND s.score_date >= CURRENT_DATE - INTERVAL '7 days'
     WHERE COALESCE(u.is_active, 1) = 1 AND u.role IN ('sales', 'team_leader')
     GROUP BY u.id, u.name ORDER BY avg_score DESC NULLS LAST`
  );
  const overall = {
    team_size: sc.rows.length,
    total_calls: sc.rows.reduce((s, r) => s + Number(r.total_calls || 0), 0),
    fu_done: sc.rows.reduce((s, r) => s + Number(r.fu_done || 0), 0),
    fu_miss: sc.rows.reduce((s, r) => s + Number(r.fu_miss || 0), 0),
    violations: sc.rows.reduce((s, r) => s + Number(r.violations || 0), 0),
    avg_score: sc.rows.length ? Math.round(sc.rows.reduce((s, r) => s + Number(r.avg_score || 0), 0) / sc.rows.length) : 0
  };
  const top = sc.rows.slice(0, 3).map(r => ({ name: r.name, score: Math.round(Number(r.avg_score || 0)) }));
  const bottom = sc.rows.slice(-3).reverse().map(r => ({ name: r.name, score: Math.round(Number(r.avg_score || 0)) }));
  return { period: 'last_7_days', overall, top_performers: top, needs_attention: bottom, users: sc.rows };
}


/* ════════════════════════════ PHASE 4 — COMPLETE FEATURE SET ════════════════════════════ */
/* Closes every gap from the user's full spec. Adds: 10 new detectors,
 * 5-level escalation routing with team-leader + admin push, EOD prompt
 * collector, daily plan auto-push, admin NL Q&A, real-time alerts feed,
 * extended rule parser (12+ patterns), sales-process violations. */

const _pushModule = (() => { try { return require('./push'); } catch (_) { return null; } })();

async function _notifyUser(userId, title, body, url) {
  if (!_pushModule || !_pushModule.sendPushToUser) return false;
  try { await _pushModule.sendPushToUser(userId, { title, body, url, tag: 'aimgr-' + Date.now() }); return true; }
  catch (_) { return false; }
}

async function _findAdmins() {
  try {
    const r = await db.query(`SELECT id FROM users WHERE LOWER(role) IN ('admin','manager') AND COALESCE(is_active, 1) = 1`);
    return r.rows.map(x => x.id);
  } catch (_) { return []; }
}

async function _findTeamLeader(userId) {
  try {
    const u = await db.query(`SELECT manager_id, reports_to FROM users WHERE id = $1`, [userId]);
    if (!u.rows.length) return null;
    return u.rows[0].manager_id || u.rows[0].reports_to || null;
  } catch (_) { return null; }
}

/* Real-time alerts feed — shared inbox the admin SPA polls every 60s */
async function _ensureAlertsSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_manager_realtime_alerts (
        id            SERIAL PRIMARY KEY,
        alert_type    TEXT NOT NULL,
        severity      TEXT NOT NULL DEFAULT 'medium',
        user_id       INTEGER,
        lead_id       INTEGER,
        title         TEXT NOT NULL,
        body          TEXT,
        meta_json     JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        acked_at      TIMESTAMPTZ,
        acked_by      INTEGER
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aimgr_alerts_unack ON ai_manager_realtime_alerts(created_at DESC) WHERE acked_at IS NULL`);
  } catch (_) {}
}

async function _pushAlert(opts) {
  await _ensureAlertsSchema();
  try {
    await db.query(
      `INSERT INTO ai_manager_realtime_alerts (alert_type, severity, user_id, lead_id, title, body, meta_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [opts.type, opts.severity || 'medium', opts.user_id || null, opts.lead_id || null,
       opts.title, opts.body || '', JSON.stringify(opts.meta || {})]
    );
  } catch (_) {}
}

/* ───── Enhanced 5-level escalation ───── */
async function _runEscalation(violation) {
  const level = await _bumpEscalation(violation.user_id, violation.violation_type);
  let actionTaken = 'reminder';
  try {
    if (level >= 3) {
      const tl = await _findTeamLeader(violation.user_id);
      if (tl) {
        await _notifyUser(tl, '⚠️ Team Member Violation',
          `${violation.violation_type} repeated by your team member. Review needed.`,
          '#/aimanager');
        actionTaken = 'team_leader_alerted';
      }
    }
    if (level >= 4) {
      const admins = await _findAdmins();
      for (const aid of admins) {
        await _notifyUser(aid, '🚨 Admin Alert',
          `Repeat violation: ${violation.violation_type}. Level ${level}/5.`,
          '#/aimanager');
      }
      actionTaken = 'admin_alerted';
    }
    if (level >= 5) {
      await _pushAlert({
        type: 'level5_repeat', severity: 'high',
        user_id: violation.user_id, lead_id: violation.lead_id || null,
        title: 'Level 5 repeat violation',
        body: `${violation.violation_type} flagged in weekly digest`,
        meta: { level }
      });
      actionTaken = 'weekly_flagged';
    }
  } catch (_) {}
  return { level, actionTaken };
}

/* ───── Extended rule parser (Section 2.1 — all 7 rule types) ───── */
const _localParseRule_v1 = _localParseRule;
function _localParseRuleExt(nl) {
  const t = String(nl || '').toLowerCase();

  /* Try v1 first */
  const v1 = _localParseRule_v1(nl);
  if (v1) return v1;

  /* Hot lead handling */
  let m = t.match(/hot lead.*?(?:no|without).*?(?:call|contact).*?(\d+)\s*(?:min|minute|hour|hr)/);
  if (m) {
    const mins = /hour|hr/.test(m[0]) ? Number(m[1]) * 60 : Number(m[1]);
    return { conditions: { type: 'hot_lead_inactive', threshold_minutes: mins },
      action: { type: 'nudge', message: 'Hot lead needs immediate attention.' },
      severity: 'high', confidence: 0.8 };
  }

  /* Remark quality + mandatory next FU */
  if (/(remark.*(?:quality|mandatory|valid|substantive)|next follow.?up.*(?:mandatory|required|must))/i.test(t)) {
    return { conditions: { type: 'remark_quality_required' },
      action: { type: 'nudge', message: 'Add a proper remark and set next follow-up.' },
      severity: 'medium', confidence: 0.75 };
  }

  /* Interested without quotation/demo */
  if (/interested.*(?:no|without|missing).*(?:quotation|quote|demo|proposal)/i.test(t)) {
    return { conditions: { type: 'interested_no_action' },
      action: { type: 'nudge', message: 'Interested lead has no quotation/demo. Send one.' },
      severity: 'high', confidence: 0.8 };
  }

  /* Escalation after N violations */
  m = t.match(/escalat[a-z]*.*?(\d+)\s*(?:violat|miss|fail)/);
  if (m) {
    return { conditions: { type: 'escalation_threshold', repeat_count: Number(m[1]) },
      action: { type: 'escalate', message: 'Repeated violations — escalate.' },
      severity: 'high', confidence: 0.75 };
  }

  /* WhatsApp reply within X min */
  m = t.match(/(?:whatsapp|wa).*?repl[a-z]+.*?(\d+)\s*(?:min|minute)/);
  if (m) {
    return { conditions: { type: 'wa_reply_sla', threshold_minutes: Number(m[1]) },
      action: { type: 'nudge', message: 'Customer WhatsApp reply pending too long.' },
      severity: 'high', confidence: 0.8 };
  }

  /* Lost lead must have reason */
  if (/lost lead.*?(?:reason|why|valid)/i.test(t)) {
    return { conditions: { type: 'lost_no_reason' },
      action: { type: 'nudge', message: 'Lost lead must have a reason.' },
      severity: 'medium', confidence: 0.7 };
  }

  return null;
}
/* Override */
function _localParseRule(nl) { return _localParseRuleExt(nl); }

/* ════════════ Detector: Interested-no-quotation/demo (Sales Process) ═════════════ */
async function detectInterestedNoAction() {
  if (!await _isEnabled()) return { interested_no_action: 0 };
  const sql = `
    SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name AS lead_name
    FROM leads l
    JOIN statuses s ON s.id = l.status_id
    WHERE LOWER(s.name) LIKE '%interested%'
      AND l.assigned_to IS NOT NULL
      AND l.updated_at < NOW() - INTERVAL '24 hours'
      AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.lead_id = l.id)
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = l.id AND v.violation_type = 'interested_no_action'
          AND v.detected_at >= NOW() - INTERVAL '24 hours'
      )
    LIMIT 30`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { interested_no_action: 0 }; }
  let n = 0;
  for (const row of rows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'interested_no_action', $2, 'Send quotation or schedule demo', 'Interested 24h+, no quotation', 'nudge_sent', 2) RETURNING id`,
      [row.user_id, row.lead_id]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text)
       VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id,
       `Lead "${(row.lead_name || '').slice(0, 30)}" is Interested 24h+ with no quotation. Send one now or explain.`]
    );
    await _pushAlert({ type: 'interested_no_action', severity: 'high', user_id: row.user_id, lead_id: row.lead_id,
      title: 'Interested lead waiting', body: `${row.lead_name || 'Lead'} — no quotation yet` });
    await _runEscalation({ user_id: row.user_id, violation_type: 'interested_no_action', lead_id: row.lead_id });
    n++;
  }
  return { interested_no_action: n };
}

/* ════════════ Detector: FU due — pre-due reminder (Section 2.4) ═════════════ */
async function detectFuPreDue() {
  if (!await _isEnabled()) return { fu_predue: 0 };
  /* FU due in next 30 min, not yet reminded today */
  const sql = `
    SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name AS lead_name, l.next_followup_at
    FROM leads l
    WHERE l.assigned_to IS NOT NULL
      AND l.next_followup_at IS NOT NULL
      AND l.next_followup_at BETWEEN NOW() AND NOW() + INTERVAL '30 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = l.id AND v.violation_type = 'fu_predue_reminder'
          AND v.detected_at >= NOW() - INTERVAL '1 hour'
      )
    LIMIT 20`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { fu_predue: 0 }; }
  let n = 0;
  for (const row of rows) {
    await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'fu_predue_reminder', $2, 'Follow up before due time', 'FU coming in <30min', 'reminder', 1)`,
      [row.user_id, row.lead_id]
    );
    await _notifyUser(row.user_id, '⏰ Follow-up coming up', `${row.lead_name || 'Lead'} in 30 min`, `#/leads/${row.lead_id}`);
    n++;
  }
  return { fu_predue: n };
}

/* ════════════ Detector: FU done but no call recorded (fake activity v2) ═════════════ */
async function detectFuDoneNoCall() {
  if (!await _isEnabled()) return { fu_done_no_call: 0 };
  const sql = `
    SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name AS lead_name
    FROM leads l
    WHERE COALESCE(l.is_followup_done, 0) = 1
      AND l.followup_done_at IS NOT NULL
      AND l.followup_done_at >= NOW() - INTERVAL '2 hours'
      AND l.assigned_to IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM call_events ce
        WHERE ce.lead_id = l.id AND ce.created_at >= l.followup_done_at - INTERVAL '30 minutes'
      )
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = l.id AND v.violation_type = 'fu_done_no_call'
          AND v.detected_at >= NOW() - INTERVAL '6 hours'
      )
    LIMIT 30`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { fu_done_no_call: 0 }; }
  let n = 0;
  for (const row of rows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'fu_done_no_call', $2, 'Call before marking FU done', 'FU marked done, no call event', 'flagged', 2) RETURNING id`,
      [row.user_id, row.lead_id]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text) VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, `You marked follow-up done for ${row.lead_name || 'a lead'} without a call event. Explain.`]
    );
    await _runEscalation({ user_id: row.user_id, violation_type: 'fu_done_no_call', lead_id: row.lead_id });
    n++;
  }
  return { fu_done_no_call: n };
}

/* ════════════ Detector: Repeated short calls (fake activity v2) ═════════════ */
async function detectRepeatedShortCalls() {
  if (!await _isEnabled()) return { short_calls: 0 };
  /* 3+ calls < 10 sec in last hour by same user */
  const sql = `
    SELECT user_id, COUNT(*) AS cnt
    FROM call_events
    WHERE created_at >= NOW() - INTERVAL '1 hour'
      AND COALESCE(duration_seconds, duration_s, 0) BETWEEN 1 AND 9
      AND user_id IS NOT NULL
    GROUP BY user_id HAVING COUNT(*) >= 3`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { short_calls: 0 }; }
  let n = 0;
  for (const row of rows) {
    const dup = await db.query(
      `SELECT id FROM ai_manager_violations WHERE user_id = $1 AND violation_type = 'short_call_pattern' AND detected_at >= NOW() - INTERVAL '2 hours' LIMIT 1`,
      [row.user_id]
    );
    if (dup.rows.length) continue;
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'short_call_pattern', 'Make real connect calls', $2, 'flagged', 2) RETURNING id`,
      [row.user_id, `${row.cnt} calls under 10 seconds in last hour`]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text) VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, `You made ${row.cnt} calls under 10 seconds in the last hour. Please explain.`]
    );
    await _runEscalation({ user_id: row.user_id, violation_type: 'short_call_pattern' });
    n++;
  }
  return { short_calls: n };
}

/* ════════════ Detector: Copied remarks across leads ═════════════ */
async function detectCopiedRemarks() {
  if (!await _isEnabled()) return { copied: 0 };
  /* Same notes text used on 3+ leads by same user in last 24h */
  const sql = `
    SELECT l.assigned_to AS user_id, COUNT(DISTINCT l.id) AS lead_count, LEFT(l.notes, 80) AS sample
    FROM leads l
    WHERE l.notes IS NOT NULL
      AND LENGTH(l.notes) BETWEEN 5 AND 100
      AND l.updated_at >= NOW() - INTERVAL '24 hours'
      AND l.assigned_to IS NOT NULL
    GROUP BY l.assigned_to, LEFT(l.notes, 80)
    HAVING COUNT(DISTINCT l.id) >= 3
    LIMIT 20`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { copied: 0 }; }
  let n = 0;
  for (const row of rows) {
    const dup = await db.query(
      `SELECT id FROM ai_manager_violations WHERE user_id = $1 AND violation_type = 'copied_remark' AND detected_at >= NOW() - INTERVAL '12 hours' LIMIT 1`,
      [row.user_id]
    );
    if (dup.rows.length) continue;
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'copied_remark', 'Write unique remarks per lead', $2, 'flagged', 2) RETURNING id`,
      [row.user_id, `Same remark "${row.sample}" on ${row.lead_count} leads in 24h`]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text) VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, `You used the same remark on ${row.lead_count} different leads. Add specific notes per lead.`]
    );
    await _runEscalation({ user_id: row.user_id, violation_type: 'copied_remark' });
    n++;
  }
  return { copied: n };
}

/* ════════════ Detector: Hot → Cold demotion without call ═════════════ */
async function detectHotToColdDemotion() {
  if (!await _isEnabled()) return { hot_to_cold: 0 };
  /* Lead smart_category was Hot in last 24h, now Cold, no call between */
  const sql = `
    SELECT id AS lead_id, assigned_to AS user_id, name AS lead_name
    FROM leads
    WHERE smart_category = 'Cold'
      AND score_updated_at >= NOW() - INTERVAL '24 hours'
      AND assigned_to IS NOT NULL
      AND smart_score < 30
      AND NOT EXISTS (
        SELECT 1 FROM call_events ce
        WHERE ce.lead_id = leads.id AND ce.created_at >= NOW() - INTERVAL '24 hours'
          AND COALESCE(ce.duration_seconds, ce.duration_s, 0) > 20
      )
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = leads.id AND v.violation_type = 'hot_to_cold' AND v.detected_at >= NOW() - INTERVAL '48 hours'
      )
    LIMIT 20`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { hot_to_cold: 0 }; }
  let n = 0;
  for (const row of rows) {
    await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'hot_to_cold', $2, 'Re-engage before lead cools off', 'Lead cooled without contact', 'flagged', 2)`,
      [row.user_id, row.lead_id]
    );
    n++;
  }
  return { hot_to_cold: n };
}

/* ════════════ Detector: Lost lead with no reason ═════════════ */
async function detectLostNoReason() {
  if (!await _isEnabled()) return { lost_no_reason: 0 };
  const sql = `
    SELECT l.id AS lead_id, l.assigned_to AS user_id, l.name AS lead_name
    FROM leads l
    WHERE COALESCE(l.is_lost, 0) = 1
      AND (l.lost_reason IS NULL OR TRIM(l.lost_reason) = '')
      AND l.updated_at >= NOW() - INTERVAL '24 hours'
      AND l.assigned_to IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = l.id AND v.violation_type = 'lost_no_reason'
      )
    LIMIT 30`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { lost_no_reason: 0 }; }
  let n = 0;
  for (const row of rows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'lost_no_reason', $2, 'Add lost reason', 'Marked lost, no reason given', 'nudge_sent', 1) RETURNING id`,
      [row.user_id, row.lead_id]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text) VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, `Lead "${(row.lead_name || '').slice(0, 30)}" marked Lost with no reason. Why?`]
    );
    n++;
  }
  return { lost_no_reason: n };
}

/* ════════════ Detector: Quoted but no follow-up (payment stage stale) ═════════════ */
async function detectQuotedNoFu() {
  if (!await _isEnabled()) return { quoted_no_fu: 0 };
  const sql = `
    SELECT DISTINCT l.id AS lead_id, l.assigned_to AS user_id, l.name AS lead_name
    FROM leads l
    JOIN quotations q ON q.lead_id = l.id
    WHERE q.created_at >= NOW() - INTERVAL '7 days'
      AND q.created_at < NOW() - INTERVAL '2 days'
      AND l.next_followup_at IS NULL
      AND l.assigned_to IS NOT NULL
      AND COALESCE(l.is_won, 0) = 0 AND COALESCE(l.is_lost, 0) = 0
      AND NOT EXISTS (
        SELECT 1 FROM ai_manager_violations v
        WHERE v.lead_id = l.id AND v.violation_type = 'quoted_no_fu' AND v.detected_at >= NOW() - INTERVAL '24 hours'
      )
    LIMIT 30`;
  let rows = [];
  try { rows = (await db.query(sql)).rows; } catch (_) { return { quoted_no_fu: 0 }; }
  let n = 0;
  for (const row of rows) {
    const v = await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, lead_id, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'quoted_no_fu', $2, 'Follow up on sent quotation', 'Quote sent 2-7d ago, no next FU', 'nudge_sent', 2) RETURNING id`,
      [row.user_id, row.lead_id]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text) VALUES ($1, $2, $3)`,
      [v.rows[0].id, row.user_id, `You sent a quotation to "${(row.lead_name || '').slice(0, 30)}" but no follow-up set. Schedule one.`]
    );
    await _runEscalation({ user_id: row.user_id, violation_type: 'quoted_no_fu', lead_id: row.lead_id });
    n++;
  }
  return { quoted_no_fu: n };
}

/* ════════════ Detector: Min daily calls not met (afternoon check) ═════════════ */
async function detectMinDailyCalls() {
  if (!await _isEnabled()) return { min_calls: 0 };
  /* Only fire after 3pm IST */
  const hr = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
  if (hr < 15) return { min_calls: 0 };
  /* Look for any active rule with min_daily_calls */
  const rules = (await db.query(
    `SELECT conditions FROM ai_manager_rules WHERE is_active = TRUE AND conditions->>'type' = 'min_daily_calls' LIMIT 1`
  )).rows;
  if (!rules.length) return { min_calls: 0 };
  const target = Number(rules[0].conditions.threshold || 20);
  const sql = `
    SELECT u.id AS user_id, u.name, COUNT(ce.id) AS calls_today
    FROM users u
    LEFT JOIN call_events ce ON ce.user_id = u.id AND ce.created_at::date = CURRENT_DATE AND ce.direction = 'out'
    WHERE COALESCE(u.is_active, 1) = 1 AND LOWER(u.role) IN ('sales','team_leader')
    GROUP BY u.id, u.name
    HAVING COUNT(ce.id) < $1`;
  let rows = [];
  try { rows = (await db.query(sql, [target])).rows; } catch (_) { return { min_calls: 0 }; }
  let n = 0;
  for (const row of rows) {
    const dup = await db.query(
      `SELECT id FROM ai_manager_violations WHERE user_id = $1 AND violation_type = 'min_calls_low' AND detected_at::date = CURRENT_DATE LIMIT 1`,
      [row.user_id]
    );
    if (dup.rows.length) continue;
    await db.query(
      `INSERT INTO ai_manager_violations
        (user_id, violation_type, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'min_calls_low', $2, $3, 'nudge_sent', 1)`,
      [row.user_id, `Make ${target} calls per day`, `Only ${row.calls_today}/${target} today`]
    );
    await _notifyUser(row.user_id, '📞 Call target', `You've made ${row.calls_today}/${target} calls today.`, '#/leads');
    n++;
  }
  return { min_calls: n };
}

/* ════════════ EOD prompt collector ═════════════ */
async function _ensureEodSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ai_manager_eod_responses (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        for_date      DATE NOT NULL,
        wins_text     TEXT,
        blockers_text TEXT,
        tomorrow_plan TEXT,
        submitted_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, for_date)
      )`);
  } catch (_) {}
}

async function runEodPromptDispatch() {
  if (!await _isEnabled()) return { skipped: true };
  await _ensureEodSchema();
  /* Find users whose eod_prompt_time matches current hour:min (IST). Default 7pm. */
  const now = new Date(Date.now() + 5.5 * 3600e3);
  const hh = now.getUTCHours(), mm = now.getUTCMinutes();
  let users = [];
  try {
    users = (await db.query(
      `SELECT id FROM users
       WHERE COALESCE(is_active, 1) = 1
         AND LOWER(role) IN ('sales','team_leader','manager')
         AND (
           (eod_prompt_time IS NOT NULL AND EXTRACT(HOUR FROM eod_prompt_time) = $1 AND EXTRACT(MINUTE FROM eod_prompt_time) BETWEEN $2 - 2 AND $2 + 2)
           OR
           (eod_prompt_time IS NULL AND $1 = 19 AND $2 BETWEEN 0 AND 4)
         )`,
      [hh, mm]
    )).rows;
  } catch (_) { return { eod: 0 }; }
  let n = 0;
  for (const u of users) {
    const dup = await db.query(
      `SELECT id FROM ai_manager_reason_prompts WHERE user_id = $1 AND prompt_text LIKE 'EOD:%' AND created_at::date = CURRENT_DATE LIMIT 1`,
      [u.id]
    );
    if (dup.rows.length) continue;
    /* Use prompt queue for the EOD ask */
    const v = await db.query(
      `INSERT INTO ai_manager_violations (user_id, violation_type, expected_action, actual_status, ai_action, escalation_lvl)
       VALUES ($1, 'eod_summary', 'End-of-day summary', 'EOD prompt sent', 'prompt', 1) RETURNING id`,
      [u.id]
    );
    await db.query(
      `INSERT INTO ai_manager_reason_prompts (violation_id, user_id, prompt_text) VALUES ($1, $2, $3)`,
      [v.rows[0].id, u.id, `EOD: How was your day? Share wins, blockers, and plan for tomorrow.`]
    );
    await _notifyUser(u.id, '🌙 End of day update', 'Please share today\'s wins, blockers, and tomorrow plan.', '#/aimanager');
    n++;
  }
  return { eod: n };
}

/* ════════════ Daily plan auto-push (SOD) ═════════════ */
async function runDailyPlanDispatch() {
  if (!await _isEnabled()) return { skipped: true };
  /* 9am IST default */
  const now = new Date(Date.now() + 5.5 * 3600e3);
  const hh = now.getUTCHours(), mm = now.getUTCMinutes();
  if (!(hh === 9 && mm < 4)) return { skipped: true };
  let users = [];
  try {
    users = (await db.query(
      `SELECT id, name FROM users WHERE COALESCE(is_active, 1) = 1 AND LOWER(role) IN ('sales','team_leader','manager')`
    )).rows;
  } catch (_) { return { dispatched: 0 }; }
  let n = 0;
  for (const u of users) {
    /* Build their plan: FU due today + hot leads */
    const planSql = `
      SELECT
        (SELECT COUNT(*) FROM leads WHERE assigned_to = $1 AND next_followup_at::date = CURRENT_DATE) AS fu_today,
        (SELECT COUNT(*) FROM leads WHERE assigned_to = $1 AND smart_category = 'Hot' AND COALESCE(is_won,0)=0 AND COALESCE(is_lost,0)=0) AS hot_leads,
        (SELECT COUNT(*) FROM leads WHERE assigned_to = $1 AND smart_category = 'Warm' AND COALESCE(is_won,0)=0 AND COALESCE(is_lost,0)=0) AS warm_leads`;
    let plan = {};
    try { plan = (await db.query(planSql, [u.id])).rows[0] || {}; } catch (_) {}
    const total = (Number(plan.fu_today) || 0) + (Number(plan.hot_leads) || 0);
    if (total === 0) continue;
    await _notifyUser(u.id, '☀️ Good morning, ' + (u.name || '').split(' ')[0],
      `Today: ${plan.fu_today || 0} FU + ${plan.hot_leads || 0} Hot + ${plan.warm_leads || 0} Warm`,
      '#/leads');
    n++;
  }
  return { dispatched: n };
}

/* ════════════ Admin NL Q&A ═════════════ */
async function api_aiManager_ask(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  if (!['admin','manager'].includes((me.role || '').toLowerCase()) && !me.is_admin) {
    return { error: 'admin only' };
  }
  const q = String(payload && payload.question || '').trim();
  if (!q) return { error: 'question required' };
  const ql = q.toLowerCase();
  /* Cheap pattern routing — no LLM cost for common asks */
  if (/idle|who.*idle/.test(ql)) {
    const r = await db.query(
      `SELECT u.name, EXTRACT(EPOCH FROM (NOW() - i.last_heartbeat_at))/60 AS idle_min
       FROM user_idle_state i JOIN users u ON u.id = i.user_id
       WHERE i.last_heartbeat_at >= NOW() - INTERVAL '4 hours'
         AND (i.last_meaningful_activity_at IS NULL OR i.last_meaningful_activity_at < NOW() - INTERVAL '15 minutes')
       ORDER BY idle_min DESC LIMIT 20`
    );
    return { answer_type: 'idle_users', rows: r.rows.map(x => ({ name: x.name, idle_minutes: Math.round(x.idle_min || 0) })) };
  }
  if (/overdue.*follow|fu.*overdue|missed.*follow/.test(ql)) {
    const r = await db.query(
      `SELECT u.name AS owner, COUNT(*) AS count FROM leads l JOIN users u ON u.id = l.assigned_to
       WHERE l.next_followup_at < NOW() AND COALESCE(l.is_followup_done, 0) = 0
       GROUP BY u.name ORDER BY count DESC LIMIT 20`
    );
    return { answer_type: 'overdue_followups', rows: r.rows };
  }
  if (/hot lead.*pending|which hot|pending hot/.test(ql)) {
    const r = await db.query(
      `SELECT l.id, l.name, u.name AS owner, l.smart_score FROM leads l LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.smart_category = 'Hot' AND l.updated_at < NOW() - INTERVAL '1 day'
       ORDER BY l.smart_score DESC NULLS LAST LIMIT 20`
    );
    return { answer_type: 'pending_hot', rows: r.rows };
  }
  if (/today.*summary|team.*today|activity today/.test(ql)) {
    const r = await db.query(
      `SELECT u.name,
        COUNT(DISTINCT ce.id) FILTER (WHERE ce.created_at::date = CURRENT_DATE) AS calls,
        COUNT(DISTINCT v.id) FILTER (WHERE v.detected_at::date = CURRENT_DATE) AS violations
       FROM users u
       LEFT JOIN call_events ce ON ce.user_id = u.id
       LEFT JOIN ai_manager_violations v ON v.user_id = u.id
       WHERE COALESCE(u.is_active, 1) = 1 GROUP BY u.id, u.name ORDER BY calls DESC`
    );
    return { answer_type: 'team_today', rows: r.rows };
  }
  if (/who.*not.*call|new lead.*not contact|sla miss/.test(ql)) {
    const r = await db.query(
      `SELECT u.name AS owner, COUNT(*) AS count
       FROM leads l JOIN users u ON u.id = l.assigned_to
       WHERE l.created_at >= NOW() - INTERVAL '1 day'
         AND NOT EXISTS (SELECT 1 FROM call_events ce WHERE ce.lead_id = l.id)
       GROUP BY u.name ORDER BY count DESC`
    );
    return { answer_type: 'new_no_call', rows: r.rows };
  }
  /* Fallback: try Gemini */
  try {
    const gemini = require('../utils/geminiClient');
    if (gemini && gemini.generate) {
      const prompt = `You are an AI sales admin. Answer this admin question in 1-2 short lines, no SQL: "${q}". If you need data, say what.`;
      const r = await gemini.generate({ prompt, maxTokens: 120 });
      if (r && r.ok) return { answer_type: 'llm', text: r.text };
    }
  } catch (_) {}
  return { answer_type: 'unrecognized', text: 'Try: "who is idle", "overdue follow-ups", "pending hot leads", "today\'s summary", "who has not called new leads".' };
}

/* ════════════ Real-time alerts feed ═════════════ */
async function api_aiManager_alerts(token, opts) {
  await _ensureSchema();
  await _ensureAlertsSchema();
  await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit || 50), 200);
  const r = await db.query(
    `SELECT a.*, u.name AS user_name, l.name AS lead_name
     FROM ai_manager_realtime_alerts a
     LEFT JOIN users u ON u.id = a.user_id
     LEFT JOIN leads l ON l.id = a.lead_id
     ORDER BY a.created_at DESC LIMIT $1`, [limit]
  );
  return { alerts: r.rows };
}

async function api_aiManager_alert_ack(token, payload) {
  await _ensureSchema();
  await _ensureAlertsSchema();
  const me = await authUser(token);
  const id = Number(payload && payload.id);
  if (!id) return { error: 'id required' };
  await db.query(`UPDATE ai_manager_realtime_alerts SET acked_at = NOW(), acked_by = $1 WHERE id = $2`, [me.id, id]);
  return { ok: true };
}

/* ════════════ EOD response submit ═════════════ */
async function api_aiManager_eod_submit(token, payload) {
  await _ensureSchema();
  await _ensureEodSchema();
  const me = await authUser(token);
  payload = payload || {};
  const today = _today();
  await db.query(
    `INSERT INTO ai_manager_eod_responses (user_id, for_date, wins_text, blockers_text, tomorrow_plan)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, for_date) DO UPDATE SET
       wins_text = EXCLUDED.wins_text, blockers_text = EXCLUDED.blockers_text,
       tomorrow_plan = EXCLUDED.tomorrow_plan, submitted_at = NOW()`,
    [me.id, today, payload.wins || '', payload.blockers || '', payload.tomorrow || '']
  );
  /* Mark any open EOD prompts as responded */
  try {
    await db.query(
      `UPDATE ai_manager_reason_prompts SET responded_at = NOW(),
         response_text = $2
       WHERE user_id = $1 AND prompt_text LIKE 'EOD:%' AND responded_at IS NULL`,
      [me.id, `Wins: ${payload.wins || ''} | Blockers: ${payload.blockers || ''} | Tomorrow: ${payload.tomorrow || ''}`]
    );
  } catch (_) {}
  return { ok: true };
}

async function api_aiManager_eod_summary(token, opts) {
  await _ensureSchema(); await _ensureEodSchema();
  await authUser(token);
  opts = opts || {};
  const day = String(opts.date || _today());
  const r = await db.query(
    `SELECT e.*, u.name AS user_name
     FROM ai_manager_eod_responses e JOIN users u ON u.id = e.user_id
     WHERE e.for_date = $1 ORDER BY e.submitted_at DESC`, [day]
  );
  return { date: day, responses: r.rows };
}


/* ════════════ BUILT-IN MONITOR REGISTRY ═════════════
 * 13 hard-coded detectors. Admin can toggle each ON/OFF via SPA.
 * State lives in `config` table with key AI_MGR_MON_<id>; default
 * = ON for everything when row is absent. */
const _MONITORS = [
  { id: 'idle',                title: 'Idle User Detection',           desc: 'Nudges users who are logged in but inactive during working hours.', severity: 'medium' },
  { id: 'new_lead_sla',        title: 'New Lead Response SLA',         desc: 'Flags leads not contacted within N minutes of assignment.',          severity: 'high' },
  { id: 'fake_activity',       title: 'Fake Activity (status no call)', desc: 'Catches status changes with no call event in the prior 15 min.',    severity: 'high' },
  { id: 'wa_ignored',          title: 'WhatsApp Ignored Reply',        desc: 'Customer replied 30+ min ago, no outbound reply from the user.',     severity: 'high' },
  { id: 'interested_no_action',title: 'Interested → No Quotation',     desc: 'Lead in Interested status 24h+ with no quotation sent.',             severity: 'high' },
  { id: 'fu_predue',           title: 'Follow-up Pre-due Reminder',    desc: 'Pings the user 30 min before each follow-up due time.',              severity: 'low' },
  { id: 'fu_done_no_call',     title: 'Follow-up Done But No Call',    desc: 'FU marked done without a call event — possible fake activity.',      severity: 'medium' },
  { id: 'short_calls',         title: 'Repeated Short Calls',          desc: '3+ calls under 10 seconds in the last hour — pattern flag.',         severity: 'medium' },
  { id: 'copied_remarks',      title: 'Copied Remarks Across Leads',   desc: 'Same remark text on 3+ different leads in 24h.',                     severity: 'medium' },
  { id: 'hot_to_cold',         title: 'Hot → Cold Demotion No Contact',desc: 'AI Rate fell from Hot to Cold without a connect call.',              severity: 'medium' },
  { id: 'lost_no_reason',      title: 'Lost Lead Without Reason',      desc: 'Lead marked Lost but lost_reason is empty.',                         severity: 'low' },
  { id: 'quoted_no_fu',        title: 'Quoted But No Follow-up',       desc: 'Quotation sent 2-7 days ago, next_followup_at not set.',             severity: 'high' },
  { id: 'min_calls',           title: 'Min Daily Calls Not Met',       desc: 'After 3pm IST, flags users below the daily call target rule.',       severity: 'medium' }
];

async function _isMonitorEnabled(id) {
  try {
    const v = await db.getConfig('AI_MGR_MON_' + id, '');
    if (v === '' || v === null || v === undefined) return true;  /* default ON */
    return String(v) === '1';
  } catch (_) { return true; }
}

async function api_aiManager_monitors_list(token) {
  await _ensureSchema();
  await authUser(token);
  const out = [];
  for (const m of _MONITORS) {
    const enabled = await _isMonitorEnabled(m.id);
    out.push({ ...m, enabled });
  }
  return { monitors: out };
}

async function api_aiManager_monitors_toggle(token, payload) {
  await _ensureSchema();
  await authUser(token);
  payload = payload || {};
  const id = String(payload.id || '');
  if (!id || !_MONITORS.find(m => m.id === id)) return { error: 'unknown monitor id' };
  const enabled = payload.enabled === true || String(payload.enabled) === '1';
  await db.setConfig('AI_MGR_MON_' + id, enabled ? '1' : '0');
  return { ok: true, id, enabled };
}

/* ════════════ Override runDetectionCycle to include Phase 4 detectors ═════════════ */
async function runDetectionCycle() {
  try {
    if (!await _isEnabled()) return { skipped: true };
    await _ensureSchema();
    const results = {};
    const runIf = async (id, fn) => (await _isMonitorEnabled(id)) ? fn().catch(e => ({ err: e.message })) : { skipped: 'disabled' };
    results.idle                 = await runIf('idle',                 detectIdleUsers);
    results.new_lead_sla         = await runIf('new_lead_sla',         detectNewLeadSlaMiss);
    results.fake_activity        = await runIf('fake_activity',        detectFakeActivity);
    results.wa_ignored           = await runIf('wa_ignored',           detectWaIgnoredReplies);
    results.interested_no_action = await runIf('interested_no_action', detectInterestedNoAction);
    results.fu_predue            = await runIf('fu_predue',            detectFuPreDue);
    results.fu_done_no_call      = await runIf('fu_done_no_call',      detectFuDoneNoCall);
    results.short_calls          = await runIf('short_calls',          detectRepeatedShortCalls);
    results.copied_remarks       = await runIf('copied_remarks',       detectCopiedRemarks);
    results.hot_to_cold          = await runIf('hot_to_cold',          detectHotToColdDemotion);
    results.lost_no_reason       = await runIf('lost_no_reason',       detectLostNoReason);
    results.quoted_no_fu         = await runIf('quoted_no_fu',         detectQuotedNoFu);
    results.min_calls            = await runIf('min_calls',            detectMinDailyCalls);
    /* Time-based dispatches (not gated by monitor toggles) */
    results.daily_plan = await runDailyPlanDispatch().catch(e => ({ err: e.message }));
    results.eod = await runEodPromptDispatch().catch(e => ({ err: e.message }));
    return { ok: true, ...results };
  } catch (e) {
    console.error('[AI_MGR_CYCLE_v4]', e.message);
    return { error: e.message };
  }
}

module.exports = {
  _ensureSchema,
  runDetectionCycle,
  api_aiManager_status,
  api_aiManager_rules_list,
  api_aiManager_rules_parse,
  api_aiManager_rules_save,
  api_aiManager_rules_toggle,
  api_aiManager_rules_delete,
  api_aiManager_violations_list,
  api_aiManager_violations_ack,
  api_aiManager_prompts_open,
  api_aiManager_prompts_respond,
  api_aiManager_heartbeat,
  api_aiManager_userSchedule_get,
  api_aiManager_userSchedule_save,
  api_aiManager_dailyPlan,
  api_aiManager_dailyReport,
  api_aiManager_leadRisk,
  api_aiManager_scorecard,
  api_aiManager_coaching,
  api_aiManager_conversionProb,
  api_aiManager_revenueLeak,
  api_aiManager_nextBestAction,
  api_aiManager_managerDigest,
  checkRemarkQuality,
  recomputeScorecard,
  generateCoachingDigest,
  api_aiManager_ask,
  api_aiManager_alerts,
  api_aiManager_alert_ack,
  api_aiManager_eod_submit,
  api_aiManager_eod_summary,
  api_aiManager_monitors_list,
  api_aiManager_monitors_toggle,
  detectInterestedNoAction,
  detectFuPreDue,
  detectFuDoneNoCall,
  detectRepeatedShortCalls,
  detectCopiedRemarks,
  detectHotToColdDemotion,
  detectLostNoReason,
  detectQuotedNoFu,
  runEodPromptDispatch,
  runDailyPlanDispatch,
};
