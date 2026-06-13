/**
 * routes/packs/student360.js — STU360_LIVE_v1
 *
 * The Student 360 view bolted on top of the Education pack. Adds 12 new
 * student_* tables for everything not already covered by the existing
 * edu_enrollments / edu_attendance / edu_test_scores / edu_parents tables.
 *
 * Tables (idempotent, FK to leads(id) via app code — no hard FK because
 * tenants can have older schemas):
 *   - student_profile_extras   1:1 — bio, photo, enrollment#, risk_score
 *   - student_skills, _mentors, _goals, _family, _achievements, _docs
 *   - student_schedule, _assignments, _scholarships, _engagement, _communications
 *
 * Public APIs (mounted only when industry pack === 'education'):
 *   api_student360_get(lead_id)
 *   api_student360_save({entity, row})
 *   api_student360_delete({entity, id})
 *   api_student360_riskCompute(lead_id)
 */
'use strict';

const db = require('../../db/pg');

const ENTITY = {
  profile_extras: {
    table: 'student_profile_extras', pk: 'lead_id',
    cols: ['lead_id','dob','gender','blood_group','photo_url','address',
           'emergency_contact','hostel_room','enrollment_no','batch_code',
           'academic_year','grade_level','language_pref','bio',
           'risk_score','risk_factors_json']
  },
  skills:        { table: 'student_skills',       pk: 'id',
                   cols: ['id','lead_id','name','level','category','color'] },
  mentors:       { table: 'student_mentors',      pk: 'id',
                   cols: ['id','lead_id','mentor_user_id','mentor_name','role','since'] },
  goals:         { table: 'student_goals',        pk: 'id',
                   cols: ['id','lead_id','goal_text','target_date','progress','status'] },
  family:        { table: 'student_family',       pk: 'id',
                   cols: ['id','lead_id','name','relation','phone','email','is_primary','is_emergency'] },
  achievements:  { table: 'student_achievements', pk: 'id',
                   cols: ['id','lead_id','title','awarded_on','icon','description','category'] },
  docs:          { table: 'student_docs',         pk: 'id',
                   cols: ['id','lead_id','name','url','category','verified'] },
  schedule:      { table: 'student_schedule',     pk: 'id',
                   cols: ['id','lead_id','day_of_week','time_start','time_end','course_id','course_name','room','type'] },
  assignments:   { table: 'student_assignments',  pk: 'id',
                   cols: ['id','lead_id','title','course_id','due_date','status','score','max_score','submitted_at','feedback'] },
  scholarships:  { table: 'student_scholarships', pk: 'id',
                   cols: ['id','lead_id','name','amount','status','awarded_at','valid_until'] },
  engagement:    { table: 'student_engagement',   pk: 'id',
                   cols: ['id','lead_id','day','hours_studied','sessions','source'] },
  communications:{ table: 'student_communications', pk: 'id',
                   cols: ['id','lead_id','channel','direction','summary','at','ref_id'] }
};

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS student_profile_extras (
    lead_id INTEGER PRIMARY KEY,
    dob DATE, gender TEXT NOT NULL DEFAULT '', blood_group TEXT NOT NULL DEFAULT '',
    photo_url TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
    emergency_contact TEXT NOT NULL DEFAULT '', hostel_room TEXT NOT NULL DEFAULT '',
    enrollment_no TEXT NOT NULL DEFAULT '', batch_code TEXT NOT NULL DEFAULT '',
    academic_year TEXT NOT NULL DEFAULT '', grade_level TEXT NOT NULL DEFAULT '',
    language_pref TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    risk_score INTEGER NOT NULL DEFAULT 0, risk_factors_json JSONB,
    last_recomputed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_skills (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, name TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 50, category TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '', added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_skills_lead ON student_skills(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_mentors (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, mentor_user_id INTEGER,
    mentor_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
    since DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_mentors_lead ON student_mentors(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_goals (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, goal_text TEXT NOT NULL,
    target_date DATE, progress INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_goals_lead ON student_goals(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_family (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, name TEXT NOT NULL,
    relation TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0, is_emergency INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_family_lead ON student_family(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_achievements (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, title TEXT NOT NULL,
    awarded_on DATE, icon TEXT NOT NULL DEFAULT '🏆',
    description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_ach_lead ON student_achievements(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_docs (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, name TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    verified INTEGER NOT NULL DEFAULT 0, uploaded_by INTEGER,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_docs_lead ON student_docs(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_schedule (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL,
    day_of_week INTEGER NOT NULL DEFAULT 1,
    time_start TEXT NOT NULL DEFAULT '', time_end TEXT NOT NULL DEFAULT '',
    course_id INTEGER, course_name TEXT NOT NULL DEFAULT '',
    room TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'class',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_sched_lead ON student_schedule(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_assignments (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, title TEXT NOT NULL,
    course_id INTEGER, due_date DATE,
    status TEXT NOT NULL DEFAULT 'pending',
    score NUMERIC(6,2), max_score NUMERIC(6,2),
    submitted_at TIMESTAMPTZ, feedback TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_asst_lead ON student_assignments(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_scholarships (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, name TEXT NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'applied',
    awarded_at DATE, valid_until DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_sch_lead ON student_scholarships(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_engagement (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL,
    day DATE NOT NULL DEFAULT CURRENT_DATE,
    hours_studied NUMERIC(5,2) NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_eng_lead ON student_engagement(lead_id, day)`);
  await db.query(`CREATE TABLE IF NOT EXISTS student_communications (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    direction TEXT NOT NULL DEFAULT 'out',
    summary TEXT NOT NULL DEFAULT '',
    at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ref_id INTEGER
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_student_comm_lead ON student_communications(lead_id, at DESC)`);
}

function _safeRow(entity, payload) {
  const def = ENTITY[entity];
  if (!def) throw new Error('Unknown student360 entity: ' + entity);
  const out = {};
  for (const k of def.cols) if (payload[k] !== undefined) out[k] = payload[k];
  return { def, row: out };
}

async function _all(sql, params) {
  try { const r = await db.query(sql, params || []); return r.rows || []; }
  catch (e) { console.warn('[student360]', sql.slice(0, 60), e.message); return []; }
}
async function _one(sql, params) {
  try { const r = await db.query(sql, params || []); return (r.rows || [])[0] || null; }
  catch (e) { console.warn('[student360]', sql.slice(0, 60), e.message); return null; }
}

async function api_student360_get(token, leadId) {
  await _ensureSchema();
  const id = parseInt(leadId, 10);
  if (!id) return { ok: false, error: 'lead_id required' };

  const lead = await _one(`SELECT * FROM leads WHERE id = $1`, [id]);
  if (!lead) return { ok: false, error: 'Lead not found' };

  let profile = await _one(`SELECT * FROM student_profile_extras WHERE lead_id = $1`, [id]);
  if (!profile) {
    await db.query(`INSERT INTO student_profile_extras (lead_id) VALUES ($1) ON CONFLICT (lead_id) DO NOTHING`, [id]);
    profile = await _one(`SELECT * FROM student_profile_extras WHERE lead_id = $1`, [id]);
  }

  const [skills, mentors, goals, family, achievements, docs,
         schedule, assignments, scholarships, engagement, communications]
    = await Promise.all([
        _all(`SELECT * FROM student_skills WHERE lead_id = $1 ORDER BY level DESC, name`, [id]),
        _all(`SELECT m.*, u.name AS user_name FROM student_mentors m
              LEFT JOIN users u ON u.id = m.mentor_user_id
              WHERE m.lead_id = $1 ORDER BY m.since DESC NULLS LAST`, [id]),
        _all(`SELECT * FROM student_goals WHERE lead_id = $1 ORDER BY status, target_date NULLS LAST`, [id]),
        _all(`SELECT * FROM student_family WHERE lead_id = $1 ORDER BY is_primary DESC, id`, [id]),
        _all(`SELECT * FROM student_achievements WHERE lead_id = $1 ORDER BY awarded_on DESC NULLS LAST`, [id]),
        _all(`SELECT * FROM student_docs WHERE lead_id = $1 ORDER BY uploaded_at DESC`, [id]),
        _all(`SELECT * FROM student_schedule WHERE lead_id = $1 ORDER BY day_of_week, time_start`, [id]),
        _all(`SELECT * FROM student_assignments WHERE lead_id = $1 ORDER BY due_date DESC NULLS LAST`, [id]),
        _all(`SELECT * FROM student_scholarships WHERE lead_id = $1 ORDER BY awarded_at DESC NULLS LAST`, [id]),
        _all(`SELECT * FROM student_engagement WHERE lead_id = $1
              AND day >= CURRENT_DATE - INTERVAL '90 days' ORDER BY day`, [id]),
        _all(`SELECT * FROM student_communications WHERE lead_id = $1
              ORDER BY at DESC LIMIT 100`, [id])
      ]);

  const [enrollments, installments, attendance, attendanceSummary, testScores, parents] = await Promise.all([
    _all(`SELECT e.*, fp.name AS plan_name FROM edu_enrollments e
          LEFT JOIN edu_fee_plans fp ON fp.id = e.fee_plan_id
          WHERE e.lead_id = $1 ORDER BY e.id DESC`, [id]),
    _all(`SELECT i.* FROM edu_installments i
          JOIN edu_enrollments e ON e.id = i.enrollment_id
          WHERE e.lead_id = $1 ORDER BY i.due_date`, [id]),
    _all(`SELECT * FROM edu_attendance WHERE lead_id = $1
          AND date >= CURRENT_DATE - INTERVAL '60 days' ORDER BY date DESC`, [id]),
    _one(`SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status IN ('present','late')) AS present,
                 COUNT(*) FILTER (WHERE status = 'absent') AS absent
          FROM edu_attendance WHERE lead_id = $1`, [id]),
    _all(`SELECT s.*, t.title AS test_title, t.max_marks, t.test_date
          FROM edu_test_scores s JOIN edu_tests t ON t.id = s.test_id
          WHERE s.lead_id = $1 ORDER BY t.test_date DESC`, [id]),
    _all(`SELECT * FROM edu_parents WHERE lead_id = $1 ORDER BY is_primary DESC, id`, [id])
  ]);

  const [activity, reassigns] = await Promise.all([
    _all(`SELECT * FROM lead_activity_log WHERE lead_id = $1 ORDER BY at DESC LIMIT 50`, [id]),
    _all(`SELECT lah.*, fu.name AS from_user_name, tu.name AS to_user_name
          FROM lead_assignments_history lah
          LEFT JOIN users fu ON fu.id = lah.from_user_id
          LEFT JOIN users tu ON tu.id = lah.to_user_id
          WHERE lah.lead_id = $1 ORDER BY lah.at DESC`, [id])
  ]);

  return {
    ok: true, lead, profile,
    skills, mentors, goals, family, achievements, docs,
    schedule, assignments, scholarships, engagement, communications,
    enrollments, installments,
    attendance, attendanceSummary,
    testScores, parents,
    activity, reassigns
  };
}

async function api_student360_save(token, payload) {
  await _ensureSchema();
  const entity = payload && payload.entity;
  const row = payload && payload.row;
  if (!entity || !row) return { ok: false, error: 'entity + row required' };
  const { def, row: safe } = _safeRow(entity, row);

  if (def.pk === 'lead_id') {
    if (!safe.lead_id) return { ok: false, error: 'lead_id required' };
    const cols = Object.keys(safe).filter(k => k !== 'lead_id');
    if (!cols.length) return { ok: true, id: safe.lead_id };
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const vals = cols.map(c => safe[c]);
    await db.query(`INSERT INTO ${def.table} (lead_id) VALUES ($1) ON CONFLICT (lead_id) DO NOTHING`, [safe.lead_id]);
    await db.query(`UPDATE ${def.table} SET ${sets}, updated_at = NOW() WHERE lead_id = $1`, [safe.lead_id, ...vals]);
    return { ok: true, id: safe.lead_id };
  }

  if (!safe.id) {
    const cols = Object.keys(safe).filter(k => k !== 'id');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = cols.map(c => safe[c]);
    const r = await db.query(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`, vals);
    return { ok: true, id: r.rows[0].id };
  } else {
    const id = safe.id;
    const cols = Object.keys(safe).filter(k => k !== 'id');
    if (!cols.length) return { ok: true, id };
    const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const vals = cols.map(c => safe[c]);
    await db.query(`UPDATE ${def.table} SET ${sets} WHERE id = $1`, [id, ...vals]);
    return { ok: true, id };
  }
}

async function api_student360_delete(token, payload) {
  await _ensureSchema();
  const entity = payload && payload.entity;
  const id = payload && payload.id;
  if (!entity || !id) return { ok: false, error: 'entity + id required' };
  const def = ENTITY[entity];
  if (!def) return { ok: false, error: 'Unknown entity' };
  if (def.pk === 'lead_id') return { ok: false, error: 'Cannot delete profile_extras row directly' };
  await db.query(`DELETE FROM ${def.table} WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_student360_riskCompute(token, leadId) {
  await _ensureSchema();
  const id = parseInt(leadId, 10);
  if (!id) return { ok: false, error: 'lead_id required' };

  const factors = {};
  let score = 0;

  const att = await _one(`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('present','late')) AS present
    FROM edu_attendance WHERE lead_id = $1
    AND date >= CURRENT_DATE - INTERVAL '60 days'`, [id]);
  if (att && Number(att.total) > 0) {
    const pct = Math.round((Number(att.present) / Number(att.total)) * 100);
    factors.attendance_pct = pct;
    if (pct < 75) score += Math.min(30, (75 - pct));
  } else {
    factors.attendance_pct = null;
  }

  const asst = await _one(`SELECT
      COUNT(*) FILTER (WHERE status = 'pending' AND due_date < CURRENT_DATE) AS overdue,
      COUNT(*) FILTER (WHERE status = 'late') AS late,
      COUNT(*) AS total
    FROM student_assignments WHERE lead_id = $1`, [id]);
  if (asst) {
    factors.assignments_overdue = Number(asst.overdue) || 0;
    if (Number(asst.overdue) > 0) score += Math.min(25, Number(asst.overdue) * 8);
    if (Number(asst.late) > 0) score += Math.min(15, Number(asst.late) * 5);
  }

  const fee = await _one(`SELECT
      COUNT(*) FILTER (WHERE i.status = 'due' AND i.due_date < CURRENT_DATE) AS overdue
    FROM edu_installments i
    JOIN edu_enrollments e ON e.id = i.enrollment_id
    WHERE e.lead_id = $1`, [id]);
  if (fee) {
    factors.fees_overdue = Number(fee.overdue) || 0;
    if (Number(fee.overdue) > 0) score += Math.min(20, Number(fee.overdue) * 10);
  }

  const eng = await _one(`SELECT COALESCE(SUM(hours_studied), 0) AS hrs
    FROM student_engagement WHERE lead_id = $1
    AND day >= CURRENT_DATE - INTERVAL '14 days'`, [id]);
  if (eng) {
    factors.engagement_hrs_14d = Number(eng.hrs) || 0;
    if (Number(eng.hrs) < 5) score += 10;
  }

  score = Math.min(100, Math.round(score));

  await db.query(`INSERT INTO student_profile_extras (lead_id, risk_score, risk_factors_json, last_recomputed_at)
                  VALUES ($1, $2, $3, NOW())
                  ON CONFLICT (lead_id) DO UPDATE SET
                    risk_score = EXCLUDED.risk_score,
                    risk_factors_json = EXCLUDED.risk_factors_json,
                    last_recomputed_at = NOW()`,
                [id, score, JSON.stringify(factors)]);

  return { ok: true, lead_id: id, risk_score: score, factors };
}

module.exports = {
  _ensureSchema,
  api_student360_get,
  api_student360_save,
  api_student360_delete,
  api_student360_riskCompute
};
