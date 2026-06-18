/* AI_MGR_v1 — AI Manager (virtual CRM admin/supervisor) — Phase 0 scaffolding.
 *
 * Status: SCHEMA + EMPTY ENDPOINTS. No detection logic yet.
 *
 * Reuses existing modules: Compliance Rules (engine), Lead Activity Tracker
 * (data source), COPILOT_v4 (briefing channel), Heat Detection (focus list),
 * FU_REMINDER_v2 (push channel). See AI_MANAGER_v1_BUILD_PLAN.md.
 *
 * Schema (tenant DB):
 *   - ai_manager_rules        (NL rule text + parsed JSON conditions)
 *   - ai_manager_violations   (User/Time/Type/Lead/Expected/Actual/Reason/EscLvl)
 *   - ai_manager_escalations  (per-user-per-type counter + last_level)
 *   - ai_manager_reason_prompts (queued reason-prompts pending user response)
 *   - user_idle_state         (heartbeat + last_meaningful_activity)
 *   - user_scorecard_daily    (denormalized score per user per day)
 *
 * Also extends `users` with: working_hours_start, working_hours_end,
 *   eod_prompt_time, timezone.
 *
 * Gated by AI_MANAGER_ENABLED config (default '0'). Auto-flipped on vserve
 * by utils/aiManagerVserveAutoEnable.js at boot.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;
  /* ai_manager_rules — plain-English rule + parsed conditions */
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_rules (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      nl_text      TEXT,                     /* admin's plain-English input */
      conditions   JSONB,                    /* parsed by Gemini → engine format */
      action       JSONB,                    /* nudge / ask_reason / escalate */
      severity     TEXT DEFAULT 'medium',    /* low | medium | high */
      is_active    BOOLEAN DEFAULT TRUE,
      parsed_by    TEXT,                     /* 'gemini' | 'manual' */
      confidence   REAL,                     /* 0-1 from LLM parse */
      created_by   INTEGER,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`);

  /* ai_manager_violations — every detected violation */
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_violations (
      id              SERIAL PRIMARY KEY,
      rule_id         INTEGER,
      user_id         INTEGER NOT NULL,
      violation_type  TEXT NOT NULL,        /* idle | sla_miss | fu_miss | weak_remark | fake_activity | wa_ignored | stage_skip */
      lead_id         INTEGER,
      detected_at     TIMESTAMPTZ DEFAULT NOW(),
      expected_action TEXT,
      actual_status   TEXT,
      ai_action       TEXT,                  /* reminder_sent | reason_asked | escalated_l3 etc */
      user_reason     TEXT,                  /* captured from Ask-for-Reason flow */
      escalation_lvl  INTEGER DEFAULT 1,    /* 1..5 */
      reviewed_at     TIMESTAMPTZ,
      reviewed_by     INTEGER,
      metadata        JSONB
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_mgr_viol_user_time ON ai_manager_violations(user_id, detected_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_mgr_viol_type ON ai_manager_violations(violation_type, detected_at DESC)`);

  /* ai_manager_escalations — per-user-per-type repeat counter */
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_escalations (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL,
      violation_type   TEXT NOT NULL,
      current_level    INTEGER DEFAULT 1,
      repeat_count     INTEGER DEFAULT 0,
      last_violation_at TIMESTAMPTZ,
      reset_at         TIMESTAMPTZ,          /* counter resets daily */
      UNIQUE(user_id, violation_type)
    )`);

  /* ai_manager_reason_prompts — queue of pending "explain yourself" prompts */
  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_manager_reason_prompts (
      id            SERIAL PRIMARY KEY,
      violation_id  INTEGER NOT NULL,
      user_id       INTEGER NOT NULL,
      prompt_text   TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      responded_at  TIMESTAMPTZ,
      response_text TEXT,
      expired_at    TIMESTAMPTZ              /* auto-close after N hours */
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_mgr_prompt_user_open ON ai_manager_reason_prompts(user_id) WHERE responded_at IS NULL`);

  /* user_idle_state — heartbeat tracking for idle detection */
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_idle_state (
      user_id                  INTEGER PRIMARY KEY,
      last_heartbeat_at        TIMESTAMPTZ,
      last_meaningful_action_at TIMESTAMPTZ,  /* call/remark/status/quote — NOT page-view */
      last_action_type         TEXT,
      idle_since               TIMESTAMPTZ,
      last_nudge_at            TIMESTAMPTZ,
      nudge_count_today        INTEGER DEFAULT 0
    )`);

  /* user_scorecard_daily — denormalized productivity score per user per day */
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_scorecard_daily (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL,
      score_date         DATE NOT NULL,
      total_calls        INTEGER DEFAULT 0,
      connected_calls    INTEGER DEFAULT 0,
      fu_completed       INTEGER DEFAULT 0,
      fu_missed          INTEGER DEFAULT 0,
      avg_response_min   REAL,                /* avg new-lead first-call time */
      remark_quality_pct REAL,                /* % of remarks that passed quality check */
      idle_minutes       INTEGER DEFAULT 0,
      violation_count    INTEGER DEFAULT 0,
      score              INTEGER,             /* 0-100 weighted final */
      score_breakdown    JSONB,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, score_date)
    )`);

  /* users table additions — per-user working hours + EOD prompt time + tz */
  const userCols = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours_start TIME`,        /* e.g. '09:00:00' */
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS working_hours_end TIME`,          /* e.g. '19:00:00' */
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS eod_prompt_time TIME`,            /* e.g. '19:00:00' */
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Asia/Kolkata'`,
  ];
  for (const sql of userCols) {
    try { await db.query(sql); } catch (e) { console.error('[AI_MGR_SCHEMA]', sql.slice(0, 80), e.message); }
  }

  _schemaReady = true;
}

/* ────────────────────────── ENDPOINTS ────────────────────────── */

/* api_aiManager_status — light probe: are we enabled? counts? */
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
    phase: 0,
    note: 'Phase 0: schema-only scaffold. Detection logic ships in Phase 1.'
  };
}

/* api_aiManager_rules_list — Phase 1 will populate; Phase 0 just returns shell */
async function api_aiManager_rules_list(token) {
  await _ensureSchema();
  await authUser(token);
  const r = await db.query(`SELECT id, name, nl_text, severity, is_active, parsed_by, created_at FROM ai_manager_rules ORDER BY id DESC LIMIT 200`);
  return { rules: r.rows };
}

/* api_aiManager_violations_list — Phase 1+ will populate */
async function api_aiManager_violations_list(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const where = [];
  const params = [];
  if (opts.user_id) { params.push(Number(opts.user_id)); where.push(`user_id = $${params.length}`); }
  if (opts.violation_type) { params.push(String(opts.violation_type)); where.push(`violation_type = $${params.length}`); }
  if (opts.from) { params.push(String(opts.from)); where.push(`detected_at >= $${params.length}`); }
  if (opts.to) { params.push(String(opts.to)); where.push(`detected_at <= $${params.length}`); }
  const sql = `SELECT * FROM ai_manager_violations
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY detected_at DESC
                LIMIT ${limit}`;
  const r = await db.query(sql, params);
  return { violations: r.rows };
}

/* api_aiManager_scorecard_get — Phase 2 populates; Phase 0 returns empty */
async function api_aiManager_scorecard_get(token, opts) {
  await _ensureSchema();
  await authUser(token);
  opts = opts || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const r = await db.query(`SELECT * FROM user_scorecard_daily WHERE score_date = $1 ORDER BY score DESC`, [date]);
  return { date, scorecards: r.rows };
}

/* api_aiManager_idle_heartbeat — SPA pings every 30s while user is active.
 * Phase 1's idle worker reads from here. Stored separately from
 * page-view tracking so we can distinguish "tab open" from "actually working". */
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

/* api_aiManager_userSchedule_get/save — per-user working hours + EOD time */
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

module.exports = {
  _ensureSchema,
  api_aiManager_status,
  api_aiManager_rules_list,
  api_aiManager_violations_list,
  api_aiManager_scorecard_get,
  api_aiManager_heartbeat,
  api_aiManager_userSchedule_get,
  api_aiManager_userSchedule_save,
};
