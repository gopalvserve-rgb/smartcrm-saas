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
};
