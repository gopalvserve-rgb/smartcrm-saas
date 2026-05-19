/**
 * routes/packs/education.js — Education / Coaching industry pack
 *
 * Adds to a tenant DB (all idempotent, namespaced under edu_*):
 *   - edu_fee_plans          — plan definitions (one-shot / quarterly / monthly EMI / custom)
 *   - edu_enrollments        — links lead → fee_plan with start_date + amount
 *   - edu_installments       — exploded schedule, one row per due date
 *   - edu_payments           — payments recorded against installments
 *
 * Seed data on install:
 *   - Status seed (Inquiry → Demo Booked → Enrolled → Paid → Lapsed)
 *   - Custom field seed (course_name, batch_name, parent_name, parent_phone)
 *
 * Public APIs (added to tenant API dispatcher only when pack is active):
 *   api_edu_feePlans_list / _get / _save / _delete
 *   api_edu_enrollment_create / _get / _list / _cancel
 *   api_edu_installments_list / _markPaid
 *   api_edu_summary  — forecast + defaulters
 */
'use strict';

const db = require('../../db/pg');
const framework = require('./_framework');

const PACK_ID = 'education';

// ─────────────────────────────────────────────────────────────────
// Schema (all CREATE IF NOT EXISTS — safe to re-run)
// ─────────────────────────────────────────────────────────────────
async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS edu_fee_plans (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'one-shot',
    num_installments INTEGER NOT NULL DEFAULT 1,
    interval_days INTEGER NOT NULL DEFAULT 30,
    grace_days INTEGER NOT NULL DEFAULT 5,
    late_fee_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS edu_enrollments (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    fee_plan_id INTEGER,
    plan_snapshot TEXT NOT NULL DEFAULT '',
    course_name TEXT NOT NULL DEFAULT '',
    batch_name TEXT NOT NULL DEFAULT '',
    total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_enrol_lead ON edu_enrollments(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS edu_installments (
    id SERIAL PRIMARY KEY,
    enrollment_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    due_date DATE,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    late_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'due',
    note TEXT NOT NULL DEFAULT '',
    reminded_15d INTEGER NOT NULL DEFAULT 0,
    reminded_7d  INTEGER NOT NULL DEFAULT 0,
    reminded_1d  INTEGER NOT NULL DEFAULT 0,
    reminded_due INTEGER NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  // Defensive — for legacy installs that pre-date the paid_at column
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`); } catch (_) {}
  try { await db.query(`ALTER TABLE edu_installments ALTER COLUMN due_date DROP NOT NULL`); } catch (_) {}
  await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_inst_enrol ON edu_installments(enrollment_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_inst_due   ON edu_installments(due_date, status)`);

  await db.query(`CREATE TABLE IF NOT EXISTS edu_payments (
    id SERIAL PRIMARY KEY,
    installment_id INTEGER NOT NULL,
    enrollment_id INTEGER NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    mode TEXT NOT NULL DEFAULT 'cash',
    receipt_no TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    recorded_by INTEGER
  )`);
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function _addDaysISO(dateStr, days) {
  const d = new Date(dateStr); d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

async function _generateSchedule(enrollmentId, startDate, totalAmount, plan) {
  const n = Math.max(1, Number(plan.num_installments) || 1);
  const interval = Math.max(0, Number(plan.interval_days) || 0);
  const each = Math.round((Number(totalAmount) / n) * 100) / 100;
  let running = 0;
  for (let i = 0; i < n; i++) {
    const due = _addDaysISO(startDate, interval * i);
    const amt = (i === n - 1) ? (Number(totalAmount) - running) : each;
    running += amt;
    await db.query(
      `INSERT INTO edu_installments (enrollment_id, seq, due_date, amount, status)
       VALUES ($1, $2, $3, $4, 'due')`,
      [enrollmentId, i + 1, due, amt]
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// APIs — all gated by isPackActive('education')
// ─────────────────────────────────────────────────────────────────
const { authUser } = require('../../utils/auth');

async function _requireEducation() {
  if (!(await framework.isPackActive(PACK_ID))) {
    throw new Error('Education pack is not active for this workspace');
  }
}

async function api_edu_feePlans_list(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM edu_fee_plans ORDER BY is_active DESC, id DESC`);
  return r.rows;
}

async function api_edu_feePlans_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _requireEducation();
  await _ensureSchema();
  const p = payload || {};
  const base = {
    name: String(p.name || '').trim() || 'Fee plan',
    total_amount: Number(p.total_amount) || 0,
    mode: String(p.mode || 'one-shot'),
    num_installments: Math.max(1, Number(p.num_installments) || 1),
    interval_days: Math.max(0, Number(p.interval_days) || 30),
    grace_days: Math.max(0, Number(p.grace_days) || 5),
    late_fee_pct: Number(p.late_fee_pct) || 0,
    notes: String(p.notes || ''),
    is_active: p.is_active === 0 ? 0 : 1
  };
  if (p.id) {
    await db.query(
      `UPDATE edu_fee_plans SET name=$2, total_amount=$3, mode=$4, num_installments=$5,
         interval_days=$6, grace_days=$7, late_fee_pct=$8, notes=$9, is_active=$10
       WHERE id=$1`,
      [Number(p.id), base.name, base.total_amount, base.mode, base.num_installments,
       base.interval_days, base.grace_days, base.late_fee_pct, base.notes, base.is_active]
    );
    return { ok: true, id: Number(p.id) };
  }
  const r = await db.query(
    `INSERT INTO edu_fee_plans (name, total_amount, mode, num_installments, interval_days, grace_days, late_fee_pct, notes, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [base.name, base.total_amount, base.mode, base.num_installments,
     base.interval_days, base.grace_days, base.late_fee_pct, base.notes, base.is_active]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_edu_feePlans_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _requireEducation();
  await db.query(`UPDATE edu_fee_plans SET is_active = 0 WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_edu_enrollment_create(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  const p = payload || {};
  const leadId = Number(p.lead_id);
  if (!leadId) throw new Error('lead_id required');
  const plan = (await db.query(`SELECT * FROM edu_fee_plans WHERE id = $1`, [Number(p.fee_plan_id)])).rows[0];
  if (!plan) throw new Error('fee_plan_id missing or invalid');

  const totalAmount = Number(p.total_amount || plan.total_amount);
  const startDate = p.start_date || new Date().toISOString().slice(0, 10);

  const r = await db.query(
    `INSERT INTO edu_enrollments (lead_id, fee_plan_id, plan_snapshot, course_name, batch_name, total_amount, start_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING id`,
    [leadId, plan.id, JSON.stringify(plan), String(p.course_name || ''), String(p.batch_name || ''), totalAmount, startDate, me.id]
  );
  const enrollmentId = r.rows[0].id;
  await _generateSchedule(enrollmentId, startDate, totalAmount, plan);
  /* LEAD_ACTIVITY_v1 — count enrollment as a lead activity */
  try { require('../tat').logAction(leadId, 'edu_enrollment_created', me.id, { enrollment_id: enrollmentId, course: String(p.course_name || ''), amount: totalAmount }); } catch (_) {}
  return { ok: true, enrollment_id: enrollmentId };
}

async function api_edu_enrollment_byLead(token, leadId) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  const enrolls = (await db.query(`SELECT * FROM edu_enrollments WHERE lead_id = $1 ORDER BY id DESC`, [Number(leadId)])).rows;
  for (const e of enrolls) {
    const ins = (await db.query(`SELECT * FROM edu_installments WHERE enrollment_id = $1 ORDER BY seq ASC`, [e.id])).rows;
    e.installments = ins;
  }
  return enrolls;
}

async function api_edu_installment_markPaid(token, payload) {
  // Defensive — ensure paid_at column exists before any UPDATE that references it
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`); } catch (_) {}
  const me = await authUser(token);
  await _requireEducation();
  const p = payload || {};
  const inst = (await db.query(`SELECT * FROM edu_installments WHERE id = $1`, [Number(p.installment_id)])).rows[0];
  if (!inst) throw new Error('Installment not found');
  const amount = Number(p.amount || inst.amount);
  const newPaid = Number(inst.paid_amount) + amount;
  const due = Number(inst.amount) + Number(inst.late_fee);
  const status = newPaid >= due ? 'paid' : 'partial';
  await db.query(
    `UPDATE edu_installments SET paid_amount = $1, status = $2 WHERE id = $3`,
    [newPaid, status, inst.id]
  );
  await db.query(
    `INSERT INTO edu_payments (installment_id, enrollment_id, amount, mode, receipt_no, note, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [inst.id, inst.enrollment_id, amount, String(p.mode || 'cash'), String(p.receipt_no || ''), String(p.note || ''), me.id]
  );
  /* LEAD_ACTIVITY_v1 — count fee payment as a lead activity */
  try {
    const er = await db.query('SELECT lead_id FROM edu_enrollments WHERE id = $1', [inst.enrollment_id]);
    const leadId = er.rows[0] && er.rows[0].lead_id;
    if (leadId) require('../tat').logAction(leadId, 'edu_payment', me.id, { installment_id: inst.id, amount, status, mode: String(p.mode || 'cash') });
  } catch (_) {}
  return { ok: true, status, paid_amount: newPaid };
}

async function api_edu_summary(token, opts) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  // Forecast — sum of unpaid + partial grouped by month
  const r1 = await db.query(`
    SELECT to_char(due_date, 'YYYY-MM') AS month,
           SUM(amount - paid_amount + late_fee) AS expected,
           COUNT(*) AS count
      FROM edu_installments
     WHERE status IN ('due', 'partial')
       AND due_date BETWEEN CURRENT_DATE - INTERVAL '12 months' AND CURRENT_DATE + INTERVAL '12 months'
     GROUP BY month
     ORDER BY month ASC`);
  // Defaulters — overdue installments
  const r2 = await db.query(`
    SELECT i.id AS installment_id, i.due_date, i.amount, i.paid_amount, i.late_fee,
           e.id AS enrollment_id, e.lead_id, e.course_name, e.batch_name,
           CURRENT_DATE - i.due_date AS days_overdue
      FROM edu_installments i
      JOIN edu_enrollments e ON e.id = i.enrollment_id
     WHERE i.status IN ('due', 'partial')
       AND i.due_date < CURRENT_DATE
     ORDER BY i.due_date ASC LIMIT 200`);
  // Total collected this FY (April–March)
  const today = new Date();
  const fyStart = today.getMonth() >= 3
    ? `${today.getFullYear()}-04-01`
    : `${today.getFullYear() - 1}-04-01`;
  const r3 = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS collected FROM edu_payments WHERE paid_at >= $1`,
    [fyStart]
  );
  return {
    forecast: r1.rows,
    defaulters: r2.rows,
    collected_this_fy: Number(r3.rows[0].collected || 0)
  };
}

// ─────────────────────────────────────────────────────────────────
// Installer — runs once when super-admin clicks Install on this tenant.
// Pure seeding, never overwrites existing user data.
// ─────────────────────────────────────────────────────────────────
async function install(opts) {
  await _ensureSchemaV3();
  await _ensureSchema();

  // 1. Seed sample fee plans (only if none exist)
  const existing = (await db.query(`SELECT COUNT(*)::int AS n FROM edu_fee_plans`)).rows[0].n;
  if (existing === 0) {
    const samples = [
      { name: 'One-shot (annual)', total_amount: 60000, mode: 'one-shot', num_installments: 1, interval_days: 0 },
      { name: 'Quarterly (4 × 15,000)', total_amount: 60000, mode: 'quarterly', num_installments: 4, interval_days: 90 },
      { name: 'Monthly EMI (12 × 5,000)', total_amount: 60000, mode: 'monthly', num_installments: 12, interval_days: 30 }
    ];
    for (const s of samples) {
      await db.query(
        `INSERT INTO edu_fee_plans (name, total_amount, mode, num_installments, interval_days, late_fee_pct)
         VALUES ($1,$2,$3,$4,$5,2)`,
        [s.name, s.total_amount, s.mode, s.num_installments, s.interval_days]
      );
    }
  }

  // 2. Seed education-specific custom fields (only if not already present)
  try {
    const existingCfs = (await db.query(`SELECT key FROM custom_fields`)).rows.map(r => r.key);
    const wanted = [
      { key: 'course_name',  label: 'Course',       field_type: 'text' },
      { key: 'batch_name',   label: 'Batch',        field_type: 'text' },
      { key: 'parent_name',  label: 'Parent name',  field_type: 'text' },
      { key: 'parent_phone', label: 'Parent phone', field_type: 'text' }
    ];
    for (const cf of wanted) {
      if (existingCfs.includes(cf.key)) continue;
      try {
        await db.query(
          `INSERT INTO custom_fields (key, label, field_type, is_required, display_order)
           VALUES ($1, $2, $3, 0, 100)`,
          [cf.key, cf.label, cf.field_type]
        );
      } catch (_) { /* table shape may differ across tenants */ }
    }
  } catch (e) {
    console.warn('[packs/education] custom_fields seed skipped:', e.message);
  }

  // 3. Seed statuses if a sensible education pipeline isn't there yet
  try {
    const wantStatuses = ['Inquiry', 'Demo Booked', 'Demo Done', 'Enrolled', 'Fee Paid', 'Lapsed'];
    const existingStatuses = (await db.query(`SELECT name FROM statuses`)).rows.map(r => String(r.name).toLowerCase());
    for (let i = 0; i < wantStatuses.length; i++) {
      const name = wantStatuses[i];
      if (existingStatuses.includes(name.toLowerCase())) continue;
      try {
        await db.query(
          `INSERT INTO statuses (name, display_order, color) VALUES ($1, $2, $3)`,
          [name, 100 + i, '#4f46e5']
        );
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[packs/education] statuses seed skipped:', e.message);
  }
  return { ok: true };
}

async function uninstall(opts) {
  // Soft uninstall — keep tables + data so re-install is instant.
  // The pack's APIs all throw 'pack not active' when isPackActive flips
  // to 0 in the framework's installed_packs table.
  return { ok: true };
}



// ═════════════════════════════════════════════════════════════════
// Phase 3 — Branches, Student documents, Student-centric view
// ═════════════════════════════════════════════════════════════════

/**
 * Phase 3 schema — additive only. Called by each new API + by the
 * installer. Idempotent.
 */
async function _ensureSchemaV3() {
  await db.query(`CREATE TABLE IF NOT EXISTS edu_branches (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    manager_user_id INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Add branch_id to existing enrollments table (defensive — checks for column)
  try {
    await db.query(`ALTER TABLE edu_enrollments ADD COLUMN IF NOT EXISTS branch_id INTEGER`);
    await db.query(`CREATE INDEX IF NOT EXISTS edu_enrollments_branch_idx ON edu_enrollments(branch_id)`);
  } catch (_) {}

  await db.query(`CREATE TABLE IF NOT EXISTS edu_documents (
    id SERIAL PRIMARY KEY,
    enrollment_id INTEGER NOT NULL,
    lead_id INTEGER,
    doc_type TEXT NOT NULL DEFAULT 'other',
    label TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT '',
    file_size INTEGER NOT NULL DEFAULT 0,
    storage_url TEXT NOT NULL DEFAULT '',
    uploaded_by INTEGER,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_verified INTEGER NOT NULL DEFAULT 0
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_documents_enrollment_idx ON edu_documents(enrollment_id)`);
}

// ───── Branches ─────────────────────────────────────────────────
async function api_edu_branches_list(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  const r = await db.query(`SELECT * FROM edu_branches ORDER BY is_active DESC, name`);
  return r.rows;
}

async function api_edu_branches_save(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  const p = payload || {};
  if (!p.name) throw new Error('Branch name required');
  if (p.id) {
    await db.query(
      `UPDATE edu_branches SET name=$1, code=$2, address=$3, phone=$4, manager_user_id=$5, is_active=$6 WHERE id=$7`,
      [p.name, p.code || '', p.address || '', p.phone || '',
       p.manager_user_id || null, p.is_active == null ? 1 : Number(!!p.is_active), p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO edu_branches (name, code, address, phone, manager_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.name, p.code || '', p.address || '', p.phone || '', p.manager_user_id || null]
  );
  return { ok: true, id: r.rows[0].id };
}

// ───── Student documents ────────────────────────────────────────
async function api_edu_documents_byEnrollment(token, enrollmentId) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  if (!enrollmentId) throw new Error('enrollmentId required');
  const r = await db.query(
    `SELECT id, enrollment_id, lead_id, doc_type, label, filename, mime_type, file_size,
            storage_url, uploaded_by, uploaded_at, is_verified
       FROM edu_documents WHERE enrollment_id=$1 ORDER BY uploaded_at DESC`,
    [Number(enrollmentId)]
  );
  return r.rows;
}

/**
 * api_edu_documents_register — records a document metadata row.
 * The actual file is uploaded by the SPA to /api/files/upload (existing
 * tenant endpoint); this API just stores the resulting URL + metadata.
 * Falls back to data URL if no file storage configured.
 */
async function api_edu_documents_register(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  const p = payload || {};
  if (!p.enrollment_id) throw new Error('enrollment_id required');
  if (!p.storage_url && !p.filename) throw new Error('storage_url or filename required');

  // Pull lead_id from the enrollment so the doc shows up under the lead too
  const eR = await db.query(`SELECT lead_id FROM edu_enrollments WHERE id=$1`, [Number(p.enrollment_id)]);
  const leadId = eR.rows[0] && eR.rows[0].lead_id;

  const r = await db.query(
    `INSERT INTO edu_documents (enrollment_id, lead_id, doc_type, label, filename, mime_type, file_size, storage_url, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [Number(p.enrollment_id), leadId || null,
     p.doc_type || 'other', p.label || p.filename || '',
     p.filename || '', p.mime_type || '', Number(p.file_size || 0),
     p.storage_url || '', me.id]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_edu_documents_delete(token, id) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  if (!id) throw new Error('id required');
  await db.query(`DELETE FROM edu_documents WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

async function api_edu_documents_verify(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  await db.query(
    `UPDATE edu_documents SET is_verified=$1 WHERE id=$2`,
    [Number(p.is_verified ? 1 : 0), Number(p.id)]
  );
  return { ok: true };
}

// ───── Student-centric view — every enrolled student with payment status
async function api_edu_students_list(token, filters) {
  await authUser(token);
  await _requireEducation();
  // ── Defensive schema migration ──
  // Make doubly sure branch_id column + edu_branches table exist before
  // the JOIN below, so tenants that installed Education before Phase 3
  // don't see a "column branch_id does not exist" error.
  try { await _ensureSchemaV3(); } catch (_) {}
  try { await db.query(`ALTER TABLE edu_enrollments ADD COLUMN IF NOT EXISTS branch_id INTEGER`); } catch (_) {}
  try { await db.query(`CREATE TABLE IF NOT EXISTS edu_branches (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    manager_user_id INTEGER, is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`); } catch (_) {}

  const f = filters || {};
  const where = [];
  const params = [];
  if (f.branch_id) { where.push(`e.branch_id = $${params.length + 1}`); params.push(Number(f.branch_id)); }
  if (f.search)    {
    const k = '%' + String(f.search).toLowerCase() + '%';
    where.push(`(LOWER(COALESCE(l.name,'')) LIKE $${params.length + 1} OR LOWER(COALESCE(e.course_name,'')) LIKE $${params.length + 1} OR LOWER(COALESCE(e.batch_name,'')) LIKE $${params.length + 1})`);
    params.push(k);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Try the rich query first; if any column is missing on a legacy install,
  // fall back to a leaner query that still works.
  try {
    const r = await db.query(`
      SELECT e.id AS enrollment_id, e.lead_id, e.course_name, e.batch_name,
             e.total_amount, e.start_date, e.status AS enrollment_status, e.branch_id,
             b.name AS branch_name,
             l.name AS student_name, l.phone, l.email,
             COALESCE(SUM(i.amount), 0)                                 AS billed,
             COALESCE(SUM(i.paid_amount), 0)                             AS collected,
             COALESCE(SUM(i.amount - i.paid_amount), 0)                  AS outstanding,
             COALESCE(SUM(CASE WHEN i.due_date < CURRENT_DATE AND i.status<>'paid'
                               THEN i.amount - i.paid_amount ELSE 0 END), 0) AS overdue,
             MAX(p.paid_at) AS last_payment_at,
             COUNT(i.id)                                                 AS installments_total,
             COUNT(*) FILTER (WHERE i.status='paid')                     AS installments_paid
        FROM edu_enrollments e
        LEFT JOIN leads l            ON l.id = e.lead_id
        LEFT JOIN edu_branches b     ON b.id = e.branch_id
        LEFT JOIN edu_installments i ON i.enrollment_id = e.id
        LEFT JOIN edu_payments p     ON p.enrollment_id = e.id
        ${w}
       GROUP BY e.id, l.name, l.phone, l.email, b.name
       ORDER BY overdue DESC, e.id DESC
       LIMIT 200
    `, params);
    return { students: r.rows };
  } catch (richErr) {
    console.warn('[edu_students_list] rich query failed, falling back:', richErr.message);
    try {
      const r2 = await db.query(`
        SELECT e.id AS enrollment_id, e.lead_id, e.course_name, e.batch_name,
               e.total_amount, e.start_date, e.status AS enrollment_status,
               NULL::int AS branch_id, NULL::text AS branch_name,
               l.name AS student_name, l.phone, l.email,
               COALESCE(SUM(i.amount), 0)                                 AS billed,
               COALESCE(SUM(i.paid_amount), 0)                             AS collected,
               COALESCE(SUM(i.amount - i.paid_amount), 0)                  AS outstanding,
               COALESCE(SUM(CASE WHEN i.due_date < CURRENT_DATE AND i.status<>'paid'
                                 THEN i.amount - i.paid_amount ELSE 0 END), 0) AS overdue,
               NULL::timestamptz AS last_payment_at,
               COUNT(i.id)                                                 AS installments_total,
               COUNT(*) FILTER (WHERE i.status='paid')                     AS installments_paid
          FROM edu_enrollments e
          LEFT JOIN leads l            ON l.id = e.lead_id
          LEFT JOIN edu_installments i ON i.enrollment_id = e.id
         ${f.search ? `WHERE LOWER(COALESCE(l.name,'')) LIKE $1` : ''}
         GROUP BY e.id, l.name, l.phone, l.email
         ORDER BY e.id DESC LIMIT 200
      `, f.search ? ['%' + String(f.search).toLowerCase() + '%'] : []);
      return { students: r2.rows, _fallback: true };
    } catch (fallbackErr) {
      throw new Error('Students list failed: ' + fallbackErr.message);
    }
  }
}

// Override enrollment_create to accept branch_id (back-compat: still works without)
async function api_edu_enrollment_create_v2(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  await _ensureSchemaV3();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.fee_plan_id) throw new Error('fee_plan_id required');

  const plan = (await db.query(`SELECT * FROM edu_fee_plans WHERE id=$1`, [Number(p.fee_plan_id)])).rows[0];
  if (!plan) throw new Error('Fee plan not found');

  const total = Number(p.total_amount || plan.total_amount || 0);
  const start = p.start_date || new Date().toISOString().slice(0, 10);

  const eR = await db.query(
    `INSERT INTO edu_enrollments (lead_id, fee_plan_id, plan_snapshot, course_name, batch_name, start_date, total_amount, status, branch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8) RETURNING id`,
    [Number(p.lead_id), plan.id, JSON.stringify(plan),
     p.course_name || '', p.batch_name || '', start, total,
     p.branch_id ? Number(p.branch_id) : null]
  );
  const enrollmentId = eR.rows[0].id;
  await _generateSchedule(enrollmentId, start, total, plan);
  return { ok: true, enrollment_id: enrollmentId };
}



/**
 * api_edu_enrollment_createCustom — sale-closure API.
 * Used when the rep is closing the sale and entering a CUSTOM schedule
 * (token + variable installments with their own amounts + due dates).
 *
 * payload:
 *   lead_id          : INT  (required)
 *   course_name      : TEXT
 *   batch_name       : TEXT
 *   branch_id        : INT  (optional)
 *   token_amount     : NUMERIC (required)
 *   token_due_date   : DATE     (defaults to today)
 *   token_paid       : 0|1      (defaults to 1 — at sale closure token is usually paid)
 *   token_method     : TEXT     (cash/upi/bank/card/cheque — defaults to upi)
 *   token_reference  : TEXT
 *   installments     : [{ amount, due_date, label? }, …]
 *
 * Creates the enrollment, inserts each row into edu_installments. Token is
 * stored as seq=0 with status='paid' (or 'pending'). Each subsequent
 * installment is stored as seq=1..N with status='pending'.
 *
 * total_amount is computed as the sum of all rows so the Students view
 * Billed/Collected/Outstanding columns stay correct.
 */
async function api_edu_enrollment_createCustom(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  await _ensureSchemaV3();
  // HARD-FORCE the paid_at column — some legacy tenants had this column
  // missing AND the _ensureSchema ALTER was silently swallowed. Run it
  // explicitly here and log if it fails so we can debug.
  try {
    await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
  } catch (alterErr) {
    console.warn('[edu_enrollment_createCustom] ALTER paid_at failed:', alterErr.message);
  }
  try { await db.query(`ALTER TABLE edu_installments ALTER COLUMN due_date DROP NOT NULL`); } catch (_) {}
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!Number(p.token_amount)) throw new Error('Token amount required');
  const installments = Array.isArray(p.installments) ? p.installments : [];

  const tokenAmt = Number(p.token_amount);
  const tokenDue = p.token_due_date || new Date().toISOString().slice(0, 10);
  const tokenPaid = p.token_paid == null ? 1 : Number(!!p.token_paid);

  const totalAmount = tokenAmt + installments.reduce((s, r) => s + Number(r.amount || 0), 0);

  // 1) Insert enrollment
  const eR = await db.query(
    `INSERT INTO edu_enrollments (lead_id, fee_plan_id, plan_snapshot, course_name, batch_name, start_date, total_amount, status, branch_id)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, 'active', $7) RETURNING id`,
    [Number(p.lead_id),
     JSON.stringify({ mode: 'custom', token_amount: tokenAmt, installment_count: installments.length }),
     p.course_name || '', p.batch_name || '',
     tokenDue, totalAmount,
     p.branch_id ? Number(p.branch_id) : null]
  );
  const enrollmentId = eR.rows[0].id;

  // 2) Token row — seq=0, may already be paid
  const tokR = await db.query(
    `INSERT INTO edu_installments (enrollment_id, seq, due_date, amount, paid_amount, status, paid_at)
     VALUES ($1, 0, $2, $3, $4, $5, ${tokenPaid ? 'NOW()' : 'NULL'}) RETURNING id`,
    [enrollmentId, tokenDue, tokenAmt, tokenPaid ? tokenAmt : 0, tokenPaid ? 'paid' : 'pending']
  );
  if (tokenPaid) {
    await db.query(
      `INSERT INTO edu_payments (installment_id, enrollment_id, amount, mode, receipt_no, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokR.rows[0].id, enrollmentId, tokenAmt,
       p.token_method || 'upi', p.token_reference || 'TOKEN', me.id]
    );
  }

  // 3) Installments — seq=1..N
  for (let i = 0; i < installments.length; i++) {
    const row = installments[i];
    if (!row || !row.amount || !row.due_date) continue;
    await db.query(
      `INSERT INTO edu_installments (enrollment_id, seq, due_date, amount, paid_amount, status)
       VALUES ($1, $2, $3, $4, 0, 'pending')`,
      [enrollmentId, i + 1, row.due_date, Number(row.amount)]
    );
  }

  return {
    ok: true,
    enrollment_id: enrollmentId,
    total_amount: totalAmount,
    token_paid: !!tokenPaid,
    installments_added: installments.length
  };
}


// ───── Branch ↔ User assignments (multi-user per branch) ────────────
async function _ensureBranchUsersSchema() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS edu_branch_users (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role_in_branch TEXT NOT NULL DEFAULT 'agent',
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (branch_id, user_id)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS edu_branch_users_branch_idx ON edu_branch_users(branch_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS edu_branch_users_user_idx   ON edu_branch_users(user_id)`);
  } catch (_) {}
}

async function api_edu_branch_users_list(token, branchId) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  await _ensureBranchUsersSchema();
  if (!branchId) throw new Error('branchId required');
  const r = await db.query(`
    SELECT bu.user_id, bu.role_in_branch, bu.assigned_at,
           u.name, u.email, u.role AS user_role, u.is_active
      FROM edu_branch_users bu
      LEFT JOIN users u ON u.id = bu.user_id
     WHERE bu.branch_id = $1
     ORDER BY u.role ASC, u.name ASC
  `, [Number(branchId)]);
  return r.rows;
}

async function api_edu_branch_users_assign(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  await _ensureBranchUsersSchema();
  const p = payload || {};
  if (!p.branch_id) throw new Error('branch_id required');
  if (!Array.isArray(p.user_ids)) throw new Error('user_ids array required');

  // Wipe existing assignments and re-insert (simpler than diff)
  await db.query(`DELETE FROM edu_branch_users WHERE branch_id=$1`, [Number(p.branch_id)]);

  let inserted = 0;
  for (const uid of p.user_ids) {
    if (!uid) continue;
    try {
      // Look up the user's CRM role to default role_in_branch
      const uR = await db.query(`SELECT role FROM users WHERE id=$1`, [Number(uid)]);
      const role = (uR.rows[0] && uR.rows[0].role) || 'agent';
      await db.query(
        `INSERT INTO edu_branch_users (branch_id, user_id, role_in_branch) VALUES ($1, $2, $3)
         ON CONFLICT (branch_id, user_id) DO NOTHING`,
        [Number(p.branch_id), Number(uid), role]
      );
      inserted++;
    } catch (_) {}
  }
  return { ok: true, branch_id: Number(p.branch_id), assigned: inserted };
}

async function api_edu_branch_users_remove(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  await _ensureBranchUsersSchema();
  const p = payload || {};
  if (!p.branch_id || !p.user_id) throw new Error('branch_id and user_id required');
  await db.query(`DELETE FROM edu_branch_users WHERE branch_id=$1 AND user_id=$2`,
    [Number(p.branch_id), Number(p.user_id)]);
  return { ok: true };
}

// List all branches a given user is assigned to (handy for "my branches" filter)
async function api_edu_branches_byUser(token, userId) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  await _ensureBranchUsersSchema();
  if (!userId) throw new Error('userId required');
  const r = await db.query(`
    SELECT b.*, bu.role_in_branch
      FROM edu_branches b
      JOIN edu_branch_users bu ON bu.branch_id = b.id
     WHERE bu.user_id = $1 AND b.is_active = 1
     ORDER BY b.name
  `, [Number(userId)]);
  return r.rows;
}

// Extend branches list to include user counts
async function api_edu_branches_listWithCounts(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV3();
  await _ensureBranchUsersSchema();
  const r = await db.query(`
    SELECT b.*,
           COUNT(bu.id) FILTER (WHERE u.role='admin')       ::int AS admin_count,
           COUNT(bu.id) FILTER (WHERE u.role='manager')     ::int AS manager_count,
           COUNT(bu.id) FILTER (WHERE u.role='team_leader') ::int AS lead_count,
           COUNT(bu.id) FILTER (WHERE u.role='agent' OR u.role IS NULL OR u.role NOT IN ('admin','manager','team_leader')) ::int AS agent_count,
           COUNT(bu.id)                                     ::int AS total_users
      FROM edu_branches b
      LEFT JOIN edu_branch_users bu ON bu.branch_id = b.id
      LEFT JOIN users u             ON u.id = bu.user_id
     GROUP BY b.id
     ORDER BY b.is_active DESC, b.name
  `);
  return r.rows;
}


// ───── Lead-level documents — works for both LEADS (pre-sale) and ENROLLMENTS (post-sale)
// Customizable doc-type catalog stored in config.edu_doc_types.
async function _ensureLeadDocsSchema() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS edu_lead_documents (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      enrollment_id INTEGER,
      doc_type TEXT NOT NULL DEFAULT 'other',
      label TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      file_size INTEGER NOT NULL DEFAULT 0,
      storage_url TEXT NOT NULL DEFAULT '',
      uploaded_by INTEGER,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_verified INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'lead'  -- 'lead' = pre-sale, 'enrollment' = post-sale
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS edu_lead_docs_lead_idx ON edu_lead_documents(lead_id)`);
  } catch (_) {}
}

// Doc-type catalog — admin-customizable list of allowed doc types
async function api_edu_docTypes_list(token) {
  await authUser(token);
  await _requireEducation();
  try {
    const r = await db.query(`SELECT value FROM config WHERE key='edu_doc_types' LIMIT 1`);
    if (r.rows && r.rows[0] && r.rows[0].value) {
      return JSON.parse(r.rows[0].value);
    }
  } catch (_) {}
  // Default catalog if nothing saved
  return [
    { code:'aadhar',      label:'Aadhar Card',       required_before_sale: false },
    { code:'pan',         label:'PAN Card',          required_before_sale: false },
    { code:'photo',       label:'Passport Photo',    required_before_sale: false },
    { code:'marksheet10', label:'10th Marksheet',    required_before_sale: false },
    { code:'marksheet12', label:'12th Marksheet',    required_before_sale: false },
    { code:'addr_proof',  label:'Address Proof',     required_before_sale: false },
    { code:'parent_id',   label:'Parent ID Proof',   required_before_sale: false },
    { code:'agreement',   label:'Signed Agreement',  required_before_sale: false },
    { code:'other',       label:'Other',             required_before_sale: false }
  ];
}

async function api_edu_docTypes_save(token, payload) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin or manager role required');
  await _requireEducation();
  const types = Array.isArray(payload && payload.types) ? payload.types : [];
  const clean = types
    .filter(t => t && t.code && t.label)
    .map(t => ({
      code: String(t.code).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40),
      label: String(t.label).trim().slice(0, 80),
      required_before_sale: !!t.required_before_sale
    }));
  // Use the framework setConfig (defined in db/pg.js) — handles both INSERT and UPDATE
  // and doesn't depend on UNIQUE constraint on config.key.
  try {
    await db.setConfig('edu_doc_types', JSON.stringify(clean));
  } catch (e) {
    // Last-resort fallback if setConfig isn't available
    try { await db.query(`DELETE FROM config WHERE key='edu_doc_types'`); } catch (_) {}
    try { await db.query(`INSERT INTO config (key, value) VALUES ('edu_doc_types', $1)`, [JSON.stringify(clean)]); } catch (_) {}
  }
  return { ok: true, count: clean.length };
}

// List documents for a lead (pre-sale + post-sale combined)
async function api_edu_leadDocs_list(token, leadId) {
  await authUser(token);
  await _requireEducation();
  await _ensureLeadDocsSchema();
  if (!leadId) throw new Error('leadId required');
  const r = await db.query(
    `SELECT id, lead_id, enrollment_id, doc_type, label, filename, mime_type,
            file_size, storage_url, uploaded_by, uploaded_at, is_verified, stage
       FROM edu_lead_documents WHERE lead_id=$1 ORDER BY uploaded_at DESC`,
    [Number(leadId)]
  );
  return r.rows;
}

async function api_edu_leadDocs_register(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureLeadDocsSchema();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.storage_url && !p.filename) throw new Error('storage_url or filename required');
  const r = await db.query(
    `INSERT INTO edu_lead_documents (lead_id, enrollment_id, doc_type, label, filename, mime_type, file_size, storage_url, uploaded_by, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [Number(p.lead_id), p.enrollment_id ? Number(p.enrollment_id) : null,
     p.doc_type || 'other', p.label || p.filename || '',
     p.filename || '', p.mime_type || '', Number(p.file_size || 0),
     p.storage_url || '', me.id, p.stage || 'lead']
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_edu_leadDocs_delete(token, id) {
  await authUser(token);
  await _requireEducation();
  await _ensureLeadDocsSchema();
  if (!id) throw new Error('id required');
  await db.query(`DELETE FROM edu_lead_documents WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

async function api_edu_leadDocs_verify(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureLeadDocsSchema();
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  await db.query(
    `UPDATE edu_lead_documents SET is_verified=$1 WHERE id=$2`,
    [Number(p.is_verified ? 1 : 0), Number(p.id)]
  );
  return { ok: true };
}


// ═════════════════════════════════════════════════════════════════
// Phase 5 — Revenue forecast + per-course margin
// ═════════════════════════════════════════════════════════════════
//
// Margin storage: piggy-backs on the existing edu_course_extras config
// which we already use for course Token/EMI/count. We add two more
// fields per course_id: margin_type ('percent' | 'fixed') and margin_value.
// Net revenue per installment is computed at query time, so a tenant
// can edit margin live and see the forecast update without backfills.

async function _loadCourseExtras() {
  try {
    const r = await db.query(`SELECT value FROM config WHERE key='edu_course_extras' LIMIT 1`);
    if (r.rows && r.rows[0] && r.rows[0].value) {
      return JSON.parse(r.rows[0].value);
    }
  } catch (_) {}
  return {};
}

// Helper — applies margin to a gross amount given the course's margin config
function _applyMargin(gross, marginConf) {
  if (!gross || !marginConf) return Number(gross || 0);
  const t = marginConf.margin_type;
  const v = Number(marginConf.margin_value || 0);
  if (!v) return Number(gross);
  if (t === 'percent') return Math.round(Number(gross) * (v / 100) * 100) / 100;
  if (t === 'fixed')   return Math.max(0, Number(gross) - v);
  return Number(gross);
}

/**
 * api_edu_revenue_forecast
 *
 * Returns:
 *   summary           — billed / collected / outstanding / overdue / upcoming_30d
 *   net_revenue       — same totals AFTER margin applied per course
 *   monthly_forecast  — [{ month, expected_gross, expected_net, billed_count }]
 *   by_course         — [{ course_name, count, billed, collected, outstanding, net_revenue, margin_type, margin_value }]
 *   by_branch         — same shape but grouped by branch
 *   upcoming          — installments due in next 30 days (student-wise)
 *   overdue           — overdue installments (student-wise)
 */
async function api_edu_revenue_forecast(token, filters) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  await _ensureSchemaV3();
  // Defensive — for tenants that pre-date paid_at
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`); } catch (_) {}

  const f = filters || {};
  // Optional branch filter
  const params = [];
  let branchClause = '';
  if (f.branch_id) {
    params.push(Number(f.branch_id));
    branchClause = `AND e.branch_id = $${params.length}`;
  }

  const extras = await _loadCourseExtras();

  // 1) Summary totals
  const sumQ = await db.query(`
    SELECT
      COALESCE(SUM(i.amount),0)::numeric                                              AS billed,
      COALESCE(SUM(i.paid_amount),0)::numeric                                         AS collected,
      COALESCE(SUM(i.amount - i.paid_amount),0)::numeric                              AS outstanding,
      COALESCE(SUM(CASE WHEN i.due_date < CURRENT_DATE AND i.status<>'paid'
                        THEN i.amount - i.paid_amount ELSE 0 END),0)::numeric         AS overdue,
      COALESCE(SUM(CASE WHEN i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' AND i.status<>'paid'
                        THEN i.amount - i.paid_amount ELSE 0 END),0)::numeric         AS upcoming_30d,
      COUNT(DISTINCT e.id)::int                                                       AS enrollments,
      COUNT(i.id)::int                                                                AS installments
    FROM edu_enrollments e
    LEFT JOIN edu_installments i ON i.enrollment_id = e.id
    WHERE 1=1 ${branchClause}
  `, params);

  // 2) Per-course aggregation (so we can apply margin per course)
  const courseQ = await db.query(`
    SELECT e.fee_plan_id,
           e.course_name,
           e.fee_plan_id AS course_id_fallback,
           COUNT(DISTINCT e.id)::int                            AS enrollments,
           COALESCE(SUM(i.amount),0)::numeric                    AS billed,
           COALESCE(SUM(i.paid_amount),0)::numeric               AS collected,
           COALESCE(SUM(i.amount - i.paid_amount),0)::numeric    AS outstanding
      FROM edu_enrollments e
      LEFT JOIN edu_installments i ON i.enrollment_id = e.id
     WHERE 1=1 ${branchClause}
     GROUP BY e.fee_plan_id, e.course_name
     ORDER BY billed DESC
  `, params);

  const by_course = [];
  let totalNetRevenue = 0;
  let totalCollectedNet = 0;
  let totalOutstandingNet = 0;
  for (const r of (courseQ.rows || [])) {
    // Pick margin: course-extras keyed by product id is not directly available
    // here (we stored by product id). Best-effort: look for any extras entry
    // whose name resembles the course_name — fall back to no margin.
    let marginConf = null;
    for (const [pid, ex] of Object.entries(extras || {})) {
      if (ex && ex.course_name && r.course_name &&
          ex.course_name.toLowerCase() === r.course_name.toLowerCase()) {
        marginConf = ex; break;
      }
    }
    const netBilled       = _applyMargin(r.billed, marginConf);
    const netCollected    = _applyMargin(r.collected, marginConf);
    const netOutstanding  = _applyMargin(r.outstanding, marginConf);
    totalNetRevenue       += Number(netBilled);
    totalCollectedNet     += Number(netCollected);
    totalOutstandingNet   += Number(netOutstanding);
    by_course.push({
      course_name:   r.course_name || '— Unnamed —',
      enrollments:   Number(r.enrollments),
      billed:        Number(r.billed),
      collected:     Number(r.collected),
      outstanding:   Number(r.outstanding),
      net_revenue:   Number(netBilled),
      net_collected: Number(netCollected),
      margin_type:   marginConf ? marginConf.margin_type : null,
      margin_value:  marginConf ? Number(marginConf.margin_value || 0) : 0
    });
  }

  // 3) Monthly forecast (next 12 months — gross + net)
  const monthQ = await db.query(`
    SELECT to_char(date_trunc('month', i.due_date), 'YYYY-MM') AS month,
           e.course_name,
           COALESCE(SUM(i.amount - i.paid_amount),0)::numeric    AS expected_gross,
           COUNT(*)::int                                          AS rows
      FROM edu_installments i
      JOIN edu_enrollments e ON e.id = i.enrollment_id
     WHERE i.status<>'paid' AND i.due_date IS NOT NULL
       AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '12 months'
       ${branchClause}
     GROUP BY 1, e.course_name
     ORDER BY 1
  `, params);

  // Roll up per month, applying per-course margin
  const monthMap = {};
  for (const r of (monthQ.rows || [])) {
    let marginConf = null;
    for (const [pid, ex] of Object.entries(extras || {})) {
      if (ex && ex.course_name && r.course_name &&
          ex.course_name.toLowerCase() === r.course_name.toLowerCase()) { marginConf = ex; break; }
    }
    const net = _applyMargin(r.expected_gross, marginConf);
    if (!monthMap[r.month]) monthMap[r.month] = { month: r.month, expected_gross: 0, expected_net: 0, rows: 0 };
    monthMap[r.month].expected_gross += Number(r.expected_gross);
    monthMap[r.month].expected_net   += Number(net);
    monthMap[r.month].rows += Number(r.rows);
  }
  const monthly_forecast = Object.values(monthMap).sort((a, b) => a.month.localeCompare(b.month));

  // 4) Upcoming installments (next 30 days) — student-wise
  const upR = await db.query(`
    SELECT i.id, i.due_date, i.amount, i.paid_amount, i.status, i.seq,
           e.id AS enrollment_id, e.course_name, e.batch_name,
           l.id AS lead_id, l.name AS student_name, l.phone
      FROM edu_installments i
      JOIN edu_enrollments e ON e.id = i.enrollment_id
      LEFT JOIN leads l ON l.id = e.lead_id
     WHERE i.status<>'paid' AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
     ${branchClause}
     ORDER BY i.due_date ASC LIMIT 100
  `, params);

  // 5) Overdue (oldest first, capped)
  const ovR = await db.query(`
    SELECT i.id, i.due_date, i.amount, i.paid_amount, i.status, i.seq,
           e.id AS enrollment_id, e.course_name, e.batch_name,
           l.id AS lead_id, l.name AS student_name, l.phone,
           (CURRENT_DATE - i.due_date) AS days_overdue
      FROM edu_installments i
      JOIN edu_enrollments e ON e.id = i.enrollment_id
      LEFT JOIN leads l ON l.id = e.lead_id
     WHERE i.status<>'paid' AND i.due_date < CURRENT_DATE
     ${branchClause}
     ORDER BY i.due_date ASC LIMIT 100
  `, params);

  return {
    summary: sumQ.rows[0] || {},
    net_revenue: {
      total_net_billed:      totalNetRevenue,
      total_net_collected:   totalCollectedNet,
      total_net_outstanding: totalOutstandingNet
    },
    by_course,
    monthly_forecast,
    upcoming: upR.rows || [],
    overdue:  ovR.rows || []
  };
}

// Save/Update margin for a course inside edu_course_extras
async function api_edu_course_margin_save(token, payload) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin or manager role required');
  await _requireEducation();
  const p = payload || {};
  if (!p.course_id && !p.course_name) throw new Error('course_id or course_name required');

  let extras = {};
  try {
    const r = await db.query(`SELECT value FROM config WHERE key='edu_course_extras' LIMIT 1`);
    if (r.rows && r.rows[0] && r.rows[0].value) extras = JSON.parse(r.rows[0].value);
  } catch (_) {}

  const key = String(p.course_id || p.course_name);
  extras[key] = Object.assign({}, extras[key] || {}, {
    course_name: p.course_name || (extras[key] && extras[key].course_name) || '',
    margin_type: p.margin_type === 'fixed' ? 'fixed' : 'percent',
    margin_value: Number(p.margin_value || 0)
  });

  try {
    await db.query(
      `INSERT INTO config (key, value) VALUES ('edu_course_extras', $1)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [JSON.stringify(extras)]
    );
  } catch (_) {
    try { await db.query(`UPDATE config SET value=$1 WHERE key='edu_course_extras'`, [JSON.stringify(extras)]); } catch (_) {}
  }
  return { ok: true, course: key, saved: extras[key] };
}


// ═════════════════════════════════════════════════════════════════
// Phase 6 — Role-based collection reports + Back-office Fee Dues view
// ═════════════════════════════════════════════════════════════════

/**
 * api_edu_collection_report(filters)
 *
 * Aggregates fee collection + net revenue grouped by a dimension:
 *   filters.group_by: 'user' | 'manager' | 'branch' | 'role' | 'agent'
 *   filters.start_date / filters.end_date — optional (defaults to last 365d)
 *
 * For each group returns:
 *   group_id, group_label, enrollments, fee_collected, fee_outstanding,
 *   net_revenue, last_payment_at
 *
 * Definitions:
 *   user/agent  → lead.assigned_to (the counsellor who handled the lead)
 *   manager     → user whose CRM role is 'manager' — aggregated across
 *                 their team (their assigned leads + their team's leads)
 *   role        → admin / manager / team_leader / agent
 *   branch      → enrollment.branch_id
 */
async function api_edu_collection_report(token, filters) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  await _ensureSchemaV3();
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`); } catch (_) {}

  const f = filters || {};
  const groupBy = ['user','manager','branch','role','agent'].includes(f.group_by) ? f.group_by : 'user';

  // Date range (defaults to last 365 days)
  const startDate = f.start_date || new Date(Date.now() - 365*24*60*60*1000).toISOString().slice(0,10);
  const endDate   = f.end_date   || new Date().toISOString().slice(0,10);

  // Optional branch filter (applies on top of group_by)
  const params = [startDate, endDate];
  let branchClause = '';
  if (f.branch_id) {
    params.push(Number(f.branch_id));
    branchClause = `AND e.branch_id = $${params.length}`;
  }

  let groupSelect, groupKeyExpr, joinClause;
  if (groupBy === 'branch') {
    groupSelect = `b.id AS group_id, COALESCE(b.name, '— No branch —') AS group_label`;
    groupKeyExpr = `b.id, b.name`;
    joinClause = `LEFT JOIN edu_branches b ON b.id = e.branch_id`;
  } else if (groupBy === 'role') {
    groupSelect = `COALESCE(u.role, 'unassigned') AS group_id, COALESCE(u.role, 'Unassigned') AS group_label`;
    groupKeyExpr = `u.role`;
    joinClause = `LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN users u ON u.id = l.assigned_to`;
  } else {
    // user / agent / manager — all key on lead.assigned_to
    groupSelect = `u.id AS group_id, COALESCE(u.name, 'Unassigned') AS group_label`;
    groupKeyExpr = `u.id, u.name`;
    joinClause = `LEFT JOIN leads l ON l.id = e.lead_id LEFT JOIN users u ON u.id = l.assigned_to`;
  }

  const rolesFilter = groupBy === 'manager' ? `AND u.role = 'manager'`
                     : groupBy === 'agent'   ? `AND (u.role = 'agent' OR u.role IS NULL)`
                     : '';

  // Load course margins for net revenue calculation
  const extras = await _loadCourseExtras();

  // Pull rows with course names so we can apply margin per course at JS level
  // (cheaper than building margin into SQL).
  const sql = `
    SELECT ${groupSelect},
           e.course_name,
           COUNT(DISTINCT e.id)::int                       AS enrollments,
           COALESCE(SUM(p.amount), 0)::numeric              AS fee_collected,
           COALESCE(SUM(i.amount - i.paid_amount), 0)::numeric AS fee_outstanding,
           MAX(p.paid_at)                                AS last_payment_at
      FROM edu_enrollments e
      ${joinClause}
      LEFT JOIN edu_installments i ON i.enrollment_id = e.id
      LEFT JOIN edu_payments p     ON p.enrollment_id = e.id
        AND p.paid_at BETWEEN $1::date AND ($2::date + INTERVAL '1 day')
     WHERE 1=1 ${rolesFilter} ${branchClause}
     GROUP BY ${groupKeyExpr}, e.course_name
     ORDER BY ${groupKeyExpr}
  `;
  const r = await db.query(sql, params);

  // Roll up per-group, applying course margin
  const groupMap = {};
  for (const row of (r.rows || [])) {
    const key = String(row.group_id || 'null');
    if (!groupMap[key]) groupMap[key] = {
      group_id: row.group_id,
      group_label: row.group_label,
      enrollments: 0,
      fee_collected: 0,
      fee_outstanding: 0,
      net_revenue: 0,
      last_payment_at: null
    };
    const g = groupMap[key];
    g.enrollments    += Number(row.enrollments);
    g.fee_collected  += Number(row.fee_collected);
    g.fee_outstanding += Number(row.fee_outstanding);

    // Apply per-course margin
    let marginConf = null;
    for (const [pid, ex] of Object.entries(extras || {})) {
      if (ex && ex.course_name && row.course_name &&
          ex.course_name.toLowerCase() === row.course_name.toLowerCase()) { marginConf = ex; break; }
    }
    g.net_revenue += _applyMargin(row.fee_collected, marginConf);

    if (row.last_payment_at && (!g.last_payment_at || row.last_payment_at > g.last_payment_at)) {
      g.last_payment_at = row.last_payment_at;
    }
  }

  // Totals
  const totals = Object.values(groupMap).reduce((acc, g) => {
    acc.enrollments    += g.enrollments;
    acc.fee_collected  += g.fee_collected;
    acc.fee_outstanding += g.fee_outstanding;
    acc.net_revenue    += g.net_revenue;
    return acc;
  }, { enrollments: 0, fee_collected: 0, fee_outstanding: 0, net_revenue: 0 });

  return {
    group_by: groupBy,
    start_date: startDate,
    end_date: endDate,
    rows: Object.values(groupMap).sort((a,b) => Number(b.fee_collected) - Number(a.fee_collected)),
    totals
  };
}


// ═════════════════════════════════════════════════════════════════
// PHASE 7 — Parent contacts · Attendance · Test scores · Cross-sell
// ═════════════════════════════════════════════════════════════════
// All tables strictly namespaced under edu_*; non-Education tenants
// never see these because (a) the install hook creates them only on
// install, (b) every API below guards with _assertEducationActive
// which throws 'Education pack not installed' for any tenant that
// lacks the active pack row. Generic + Real-Estate tenants stay
// untouched.

async function _assertEducationActive() {
  try {
    const r = await db.query(
      `SELECT 1 FROM installed_packs WHERE pack_id='education' AND is_active=1 LIMIT 1`
    );
    if (!r.rows || !r.rows[0]) throw new Error('Education pack not installed on this workspace');
  } catch (e) {
    if (String(e.message || '').includes('relation "installed_packs"')) {
      throw new Error('Education pack not installed on this workspace');
    }
    throw e;
  }
}

async function _ensureSchemaPhase7() {
  // --- Parent contacts: 0..N parents/guardians per student lead ----
  await db.query(`
    CREATE TABLE IF NOT EXISTS edu_parent_contacts (
      id           SERIAL PRIMARY KEY,
      lead_id      INTEGER NOT NULL,
      name         TEXT NOT NULL,
      relation     TEXT,                    -- father | mother | guardian | other
      phone        TEXT,
      whatsapp     TEXT,
      email        TEXT,
      receive_reminders INTEGER NOT NULL DEFAULT 1,
      receive_announcements INTEGER NOT NULL DEFAULT 1,
      notes        TEXT,
      created_by   INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_parent_lead ON edu_parent_contacts(lead_id)`); } catch (_) {}

  // --- Attendance: daily roster per student (optionally per enrollment) ---
  await db.query(`
    CREATE TABLE IF NOT EXISTS edu_attendance (
      id             SERIAL PRIMARY KEY,
      lead_id        INTEGER NOT NULL,
      enrollment_id  INTEGER,                 -- optional FK to edu_enrollments
      date           DATE NOT NULL,
      status         TEXT NOT NULL DEFAULT 'present',  -- present | absent | late | excused
      check_in_at    TIMESTAMPTZ,
      check_out_at   TIMESTAMPTZ,
      notes          TEXT,
      marked_by      INTEGER,
      marked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // One attendance row per (lead, enrollment, date) — using a partial unique
  // index that tolerates NULL enrollment_id (a lead may be in multiple courses).
  try {
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_att_lead_enr_date
      ON edu_attendance(lead_id, COALESCE(enrollment_id, 0), date)
    `);
  } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_att_lead_date ON edu_attendance(lead_id, date DESC)`); } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_att_enr_date ON edu_attendance(enrollment_id, date DESC)`); } catch (_) {}

  // --- Test catalog ------------------------------------------------
  await db.query(`
    CREATE TABLE IF NOT EXISTS edu_tests (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      course_id    INTEGER,                 -- references products(id) loosely
      test_date    DATE,
      max_marks    NUMERIC(8,2) NOT NULL DEFAULT 100,
      pass_marks   NUMERIC(8,2),
      notes        TEXT,
      created_by   INTEGER,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_tests_course ON edu_tests(course_id)`); } catch (_) {}

  // --- Test scores -------------------------------------------------
  await db.query(`
    CREATE TABLE IF NOT EXISTS edu_test_scores (
      id           SERIAL PRIMARY KEY,
      test_id      INTEGER NOT NULL,
      lead_id      INTEGER NOT NULL,
      score        NUMERIC(8,2),
      percentile   NUMERIC(5,2),
      rank_in_batch INTEGER,
      notes        TEXT,
      recorded_by  INTEGER,
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try {
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_score_test_lead ON edu_test_scores(test_id, lead_id)`);
  } catch (_) {}
  try { await db.query(`CREATE INDEX IF NOT EXISTS idx_edu_score_lead ON edu_test_scores(lead_id)`); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────
// Parent contacts CRUD
// ─────────────────────────────────────────────────────────────────
async function api_edu_parents_byLead(token, leadId) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const lid = Number(leadId || 0);
  if (!lid) return [];
  const r = await db.query(
    `SELECT id, lead_id, name, relation, phone, whatsapp, email,
            receive_reminders, receive_announcements, notes, updated_at
       FROM edu_parent_contacts WHERE lead_id = $1 ORDER BY id ASC`, [lid]
  );
  return r.rows || [];
}

async function api_edu_parents_save(token, payload) {
  const me = await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.name) throw new Error('name required');
  const lid = Number(p.lead_id);
  const fields = {
    name: String(p.name).trim(),
    relation: p.relation ? String(p.relation).trim().toLowerCase() : null,
    phone: p.phone ? String(p.phone).trim() : null,
    whatsapp: p.whatsapp ? String(p.whatsapp).trim() : (p.phone ? String(p.phone).trim() : null),
    email: p.email ? String(p.email).trim() : null,
    receive_reminders: p.receive_reminders === false || p.receive_reminders === 0 ? 0 : 1,
    receive_announcements: p.receive_announcements === false || p.receive_announcements === 0 ? 0 : 1,
    notes: p.notes ? String(p.notes) : null
  };
  if (p.id) {
    await db.query(
      `UPDATE edu_parent_contacts SET
         name=$1, relation=$2, phone=$3, whatsapp=$4, email=$5,
         receive_reminders=$6, receive_announcements=$7, notes=$8,
         updated_at=NOW()
       WHERE id=$9 AND lead_id=$10`,
      [fields.name, fields.relation, fields.phone, fields.whatsapp, fields.email,
       fields.receive_reminders, fields.receive_announcements, fields.notes,
       Number(p.id), lid]
    );
    return { ok: true, id: Number(p.id) };
  }
  const ins = await db.query(
    `INSERT INTO edu_parent_contacts
       (lead_id, name, relation, phone, whatsapp, email, receive_reminders,
        receive_announcements, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [lid, fields.name, fields.relation, fields.phone, fields.whatsapp,
     fields.email, fields.receive_reminders, fields.receive_announcements,
     fields.notes, me.id]
  );
  return { ok: true, id: ins.rows[0].id };
}

async function api_edu_parents_delete(token, id) {
  await authUser(token); await _assertEducationActive();
  await db.query(`DELETE FROM edu_parent_contacts WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Attendance
// ─────────────────────────────────────────────────────────────────
async function api_edu_attendance_mark(token, payload) {
  const me = await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const p = payload || {};
  if (!p.lead_id || !p.date) throw new Error('lead_id + date required');
  const status = String(p.status || 'present').toLowerCase();
  if (!['present','absent','late','excused'].includes(status)) {
    throw new Error('status must be present|absent|late|excused');
  }
  const lid = Number(p.lead_id);
  const eid = p.enrollment_id ? Number(p.enrollment_id) : null;
  const date = String(p.date).slice(0, 10);
  // UPSERT by (lead, enrollment, date) — uses COALESCE-on-NULL unique index
  await db.query(
    `INSERT INTO edu_attendance (lead_id, enrollment_id, date, status, check_in_at, check_out_at, notes, marked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (lead_id, COALESCE(enrollment_id, 0), date) DO UPDATE SET
       status = EXCLUDED.status,
       check_in_at = EXCLUDED.check_in_at,
       check_out_at = EXCLUDED.check_out_at,
       notes = EXCLUDED.notes,
       marked_by = EXCLUDED.marked_by,
       marked_at = NOW()`,
    [lid, eid, date, status, p.check_in_at || null, p.check_out_at || null, p.notes || null, me.id]
  );
  return { ok: true };
}

async function api_edu_attendance_bulkMark(token, payload) {
  const me = await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const p = payload || {};
  const date = String(p.date || '').slice(0, 10);
  if (!date) throw new Error('date required');
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) return { ok: true, saved: 0 };
  let saved = 0;
  for (const r of rows) {
    if (!r.lead_id) continue;
    const status = String(r.status || 'present').toLowerCase();
    const eid = r.enrollment_id ? Number(r.enrollment_id) : null;
    try {
      await db.query(
        `INSERT INTO edu_attendance (lead_id, enrollment_id, date, status, notes, marked_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (lead_id, COALESCE(enrollment_id, 0), date) DO UPDATE SET
           status=EXCLUDED.status, notes=EXCLUDED.notes,
           marked_by=EXCLUDED.marked_by, marked_at=NOW()`,
        [Number(r.lead_id), eid, date, status, r.notes || null, me.id]
      );
      saved++;
    } catch (e) {
      console.warn('[edu_attendance_bulkMark]', e.message);
    }
  }
  return { ok: true, saved };
}

async function api_edu_attendance_byLead(token, leadId, filters) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const lid = Number(leadId || 0);
  if (!lid) return { rows: [], summary: {} };
  const f = filters || {};
  const params = [lid];
  let q = `SELECT id, date, status, enrollment_id, check_in_at, check_out_at,
                  notes, marked_by, marked_at
             FROM edu_attendance WHERE lead_id = $1`;
  if (f.from) { params.push(String(f.from).slice(0,10)); q += ` AND date >= ${params.length}`; }
  if (f.to)   { params.push(String(f.to).slice(0,10));   q += ` AND date <= ${params.length}`; }
  q += ' ORDER BY date DESC LIMIT 1000';
  const r = await db.query(q, params);
  const rows = r.rows || [];
  const total = rows.length;
  const present = rows.filter(x => x.status === 'present').length;
  const absent  = rows.filter(x => x.status === 'absent').length;
  const late    = rows.filter(x => x.status === 'late').length;
  const excused = rows.filter(x => x.status === 'excused').length;
  return {
    rows,
    summary: {
      total, present, absent, late, excused,
      percent: total ? Math.round(((present + late) / total) * 100) : 0
    }
  };
}

async function api_edu_attendance_summary(token, filters) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const f = filters || {};
  const params = [];
  let where = '1=1';
  if (f.from) { params.push(String(f.from).slice(0,10)); where += ` AND a.date >= ${params.length}`; }
  if (f.to)   { params.push(String(f.to).slice(0,10));   where += ` AND a.date <= ${params.length}`; }
  if (f.enrollment_id) { params.push(Number(f.enrollment_id)); where += ` AND a.enrollment_id = ${params.length}`; }
  const r = await db.query(
    `SELECT a.lead_id,
            l.name AS student_name,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE a.status='present') AS present,
            COUNT(*) FILTER (WHERE a.status='absent')  AS absent,
            COUNT(*) FILTER (WHERE a.status='late')    AS late,
            COUNT(*) FILTER (WHERE a.status='excused') AS excused
       FROM edu_attendance a
       LEFT JOIN leads l ON l.id = a.lead_id
      WHERE ${where}
      GROUP BY a.lead_id, l.name
      ORDER BY l.name ASC NULLS LAST
      LIMIT 1000`, params);
  return (r.rows || []).map(row => Object.assign({}, row, {
    percent: Number(row.total) ? Math.round(((Number(row.present) + Number(row.late)) / Number(row.total)) * 100) : 0
  }));
}

// ─────────────────────────────────────────────────────────────────
// Tests + Scores
// ─────────────────────────────────────────────────────────────────
async function api_edu_tests_list(token, filters) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const f = filters || {};
  const params = [];
  let where = '1=1';
  if (f.course_id) { params.push(Number(f.course_id)); where += ` AND course_id = ${params.length}`; }
  if (f.from)      { params.push(String(f.from).slice(0,10)); where += ` AND test_date >= ${params.length}`; }
  if (f.to)        { params.push(String(f.to).slice(0,10));   where += ` AND test_date <= ${params.length}`; }
  const r = await db.query(
    `SELECT id, name, course_id, test_date, max_marks, pass_marks, notes, created_at
       FROM edu_tests WHERE ${where} ORDER BY test_date DESC NULLS LAST, id DESC LIMIT 200`,
    params
  );
  return r.rows || [];
}

async function api_edu_tests_save(token, payload) {
  const me = await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  const f = {
    name: String(p.name).trim(),
    course_id: p.course_id ? Number(p.course_id) : null,
    test_date: p.test_date ? String(p.test_date).slice(0,10) : null,
    max_marks: p.max_marks != null ? Number(p.max_marks) : 100,
    pass_marks: p.pass_marks != null && p.pass_marks !== '' ? Number(p.pass_marks) : null,
    notes: p.notes || null
  };
  if (p.id) {
    await db.query(
      `UPDATE edu_tests SET name=$1, course_id=$2, test_date=$3, max_marks=$4, pass_marks=$5, notes=$6
        WHERE id=$7`,
      [f.name, f.course_id, f.test_date, f.max_marks, f.pass_marks, f.notes, Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  }
  const r = await db.query(
    `INSERT INTO edu_tests (name, course_id, test_date, max_marks, pass_marks, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [f.name, f.course_id, f.test_date, f.max_marks, f.pass_marks, f.notes, me.id]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_edu_tests_delete(token, id) {
  await authUser(token); await _assertEducationActive();
  await db.query(`DELETE FROM edu_test_scores WHERE test_id=$1`, [Number(id)]);
  await db.query(`DELETE FROM edu_tests WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

async function api_edu_testScores_byTest(token, testId) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const r = await db.query(
    `SELECT s.id, s.test_id, s.lead_id, s.score, s.percentile, s.rank_in_batch,
            s.notes, s.recorded_at,
            l.name AS student_name, l.phone AS student_phone
       FROM edu_test_scores s
       LEFT JOIN leads l ON l.id = s.lead_id
      WHERE s.test_id = $1
      ORDER BY (s.score IS NULL) ASC, s.score DESC NULLS LAST`,
    [Number(testId)]
  );
  return r.rows || [];
}

async function api_edu_testScores_byLead(token, leadId) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const r = await db.query(
    `SELECT s.id, s.test_id, s.score, s.percentile, s.rank_in_batch, s.notes, s.recorded_at,
            t.name AS test_name, t.test_date, t.max_marks, t.course_id
       FROM edu_test_scores s
       JOIN edu_tests t ON t.id = s.test_id
      WHERE s.lead_id = $1
      ORDER BY t.test_date DESC NULLS LAST, s.id DESC LIMIT 200`,
    [Number(leadId)]
  );
  return r.rows || [];
}

async function api_edu_testScores_save(token, payload) {
  const me = await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const p = payload || {};
  if (!p.test_id || !p.lead_id) throw new Error('test_id + lead_id required');
  const score = p.score != null && p.score !== '' ? Number(p.score) : null;
  const pct   = p.percentile != null && p.percentile !== '' ? Number(p.percentile) : null;
  const rk    = p.rank_in_batch ? Number(p.rank_in_batch) : null;
  await db.query(
    `INSERT INTO edu_test_scores (test_id, lead_id, score, percentile, rank_in_batch, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (test_id, lead_id) DO UPDATE SET
       score = EXCLUDED.score,
       percentile = EXCLUDED.percentile,
       rank_in_batch = EXCLUDED.rank_in_batch,
       notes = EXCLUDED.notes,
       recorded_by = EXCLUDED.recorded_by,
       recorded_at = NOW()`,
    [Number(p.test_id), Number(p.lead_id), score, pct, rk, p.notes || null, me.id]
  );
  return { ok: true };
}

async function api_edu_testScores_bulkSave(token, payload) {
  const me = await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const p = payload || {};
  if (!p.test_id || !Array.isArray(p.rows)) throw new Error('test_id + rows[] required');
  let saved = 0;
  for (const r of p.rows) {
    if (!r.lead_id) continue;
    const score = r.score != null && r.score !== '' ? Number(r.score) : null;
    const pct   = r.percentile != null && r.percentile !== '' ? Number(r.percentile) : null;
    try {
      await db.query(
        `INSERT INTO edu_test_scores (test_id, lead_id, score, percentile, rank_in_batch, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (test_id, lead_id) DO UPDATE SET
           score=EXCLUDED.score, percentile=EXCLUDED.percentile,
           rank_in_batch=EXCLUDED.rank_in_batch, notes=EXCLUDED.notes,
           recorded_by=EXCLUDED.recorded_by, recorded_at=NOW()`,
        [Number(p.test_id), Number(r.lead_id), score, pct,
         r.rank_in_batch ? Number(r.rank_in_batch) : null, r.notes || null, me.id]
      );
      saved++;
    } catch (e) { console.warn('[testScores_bulkSave]', e.message); }
  }
  return { ok: true, saved };
}

// ─────────────────────────────────────────────────────────────────
// Cross-sell / upsell candidate signals
// ─────────────────────────────────────────────────────────────────
// Heuristic: a student is a cross-sell candidate if they have at least one
// enrollment and AT LEAST ONE of the following triggers fires:
//   1. They've fully paid their current course (no pending installments)
//   2. Their average test score is >= 75%
//   3. Their attendance percentage is >= 80% (engaged students)
// We return students with reason flags so the counsellor can prioritise.
async function api_edu_crossSell_candidates(token, filters) {
  await authUser(token); await _assertEducationActive(); await _ensureSchemaPhase7();
  const f = filters || {};
  const limit = Math.min(Number(f.limit) || 100, 500);

  // Active enrollments and their fee/test/attendance summaries.
  const r = await db.query(`
    SELECT
      e.id AS enrollment_id,
      e.lead_id,
      l.name AS student_name,
      l.phone AS student_phone,
      e.course_name,
      e.amount AS course_amount,
      COALESCE((SELECT COUNT(*) FROM edu_installments i WHERE i.enrollment_id = e.id AND i.status <> 'paid'), 0) AS pending_installments,
      COALESCE((SELECT AVG(CASE WHEN t.max_marks > 0 THEN (s.score / t.max_marks) * 100 ELSE NULL END)
                  FROM edu_test_scores s JOIN edu_tests t ON t.id = s.test_id
                 WHERE s.lead_id = e.lead_id), NULL) AS avg_test_pct,
      COALESCE((SELECT
                  CASE WHEN COUNT(*) = 0 THEN NULL
                       ELSE ROUND((COUNT(*) FILTER (WHERE a.status IN ('present','late'))) * 100.0 / COUNT(*), 0)
                  END
                  FROM edu_attendance a WHERE a.lead_id = e.lead_id), NULL) AS attendance_pct
      FROM edu_enrollments e
      JOIN leads l ON l.id = e.lead_id
     ORDER BY e.id DESC
     LIMIT $1
  `, [limit]).catch(e => { console.warn('[edu_crossSell]', e.message); return { rows: [] }; });

  const out = [];
  for (const row of (r.rows || [])) {
    const triggers = [];
    if (Number(row.pending_installments) === 0) triggers.push('course_paid_off');
    if (row.avg_test_pct != null && Number(row.avg_test_pct) >= 75) triggers.push('strong_scores');
    if (row.attendance_pct != null && Number(row.attendance_pct) >= 80) triggers.push('engaged');
    if (!triggers.length) continue;
    out.push({
      lead_id: row.lead_id,
      student_name: row.student_name,
      student_phone: row.student_phone,
      current_course: row.course_name,
      avg_test_pct: row.avg_test_pct != null ? Number(row.avg_test_pct).toFixed(1) : null,
      attendance_pct: row.attendance_pct != null ? Number(row.attendance_pct) : null,
      pending_installments: Number(row.pending_installments),
      triggers
    });
  }
  return out;
}

// authUser is already required at top of file via the existing APIs

// ─────────────────────────────────────────────────────────────────
// Register
// ─────────────────────────────────────────────────────────────────
framework.register({
  id: PACK_ID,
  name: 'Education / Coaching',
  industry: 'education',
  summary: 'Multi-installment fees, installment schedule, fee reminders, defaulter reports, parent fields.',
  version: '1.0.0',
  features: [
    'Multi-installment fee plans (one-shot / quarterly / monthly EMI / custom)',
    'Auto-generated installment schedule per enrollment',
    'Fee collection forecast (month-wise)',
    'Defaulter list with ageing',
    'Education statuses + parent custom fields seeded'
  ],
  nav_items: [
    { id: 'edudues',     label: '📋 Fee Dues',       icon: '📋' },
    { id: 'edufees',     label: '💰 Fee Collection', icon: '💰' },
    { id: 'edustudents', label: '👥 Students',       icon: '👥' },
    { id: 'edurevenue',  label: '💎 Revenue',        icon: '💎' },
    { id: 'edureports',  label: '📊 Collection Report', icon: '📊' }
  ],
  install,
  uninstall
});

module.exports = {
  install, uninstall,
  api_edu_feePlans_list, api_edu_feePlans_save, api_edu_feePlans_delete,
  api_edu_enrollment_create, api_edu_enrollment_byLead,
  api_edu_installment_markPaid,
  api_edu_summary,
  // Phase 3:
  api_edu_branches_list, api_edu_branches_save,
  api_edu_documents_byEnrollment, api_edu_documents_register,
  api_edu_documents_delete, api_edu_documents_verify,
  api_edu_students_list,
  api_edu_enrollment_create_v2,
  api_edu_enrollment_createCustom,
  api_edu_branch_users_list, api_edu_branch_users_assign, api_edu_branch_users_remove,
  api_edu_branches_byUser, api_edu_branches_listWithCounts,
  api_edu_docTypes_list, api_edu_docTypes_save,
  api_edu_leadDocs_list, api_edu_leadDocs_register, api_edu_leadDocs_delete, api_edu_leadDocs_verify,
  api_edu_revenue_forecast, api_edu_course_margin_save,
  api_edu_collection_report,
  // Phase 7 — Parent contacts, Attendance, Tests, Cross-sell
  api_edu_parents_byLead, api_edu_parents_save, api_edu_parents_delete,
  api_edu_attendance_mark, api_edu_attendance_bulkMark,
  api_edu_attendance_byLead, api_edu_attendance_summary,
  api_edu_tests_list, api_edu_tests_save, api_edu_tests_delete,
  api_edu_testScores_byTest, api_edu_testScores_byLead,
  api_edu_testScores_save, api_edu_testScores_bulkSave,
  api_edu_crossSell_candidates,
  _ensureSchemaPhase7,
  _ensureSchema, _ensureSchemaV3
};
