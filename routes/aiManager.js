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
async function api_aiManager_prompts_open(token) {
  await _ensureSchema();
  const me = await authUser(token);
  const r = await db.query(
    `SELECT p.id, p.violation_id, p.prompt_text, p.created_at,
            v.violation_type, v.lead_id, l.name AS lead_name
     FROM ai_manager_reason_prompts p
     JOIN ai_manager_violations v ON v.id = p.violation_id
     LEFT JOIN leads l ON l.id = v.lead_id
     WHERE p.user_id = $1 AND p.responded_at IS NULL
       AND (p.expired_at IS NULL OR p.expired_at > NOW())
     ORDER BY p.created_at DESC LIMIT 5`,
    [me.id]
  );
  return { prompts: r.rows };
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
};
