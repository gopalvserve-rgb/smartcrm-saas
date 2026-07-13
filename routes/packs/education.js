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
  const payIns = await db.query(
    `INSERT INTO edu_payments (installment_id, enrollment_id, amount, mode, receipt_no, note, recorded_by, paid_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, NOW()) RETURNING id`,
    [inst.id, inst.enrollment_id, amount, String(p.mode || 'cash'), String(p.receipt_no || ''), String(p.note || ''), me.id]
  );
  /* FEE_DUES_RECEIPT_AUTO_v1 (2026-07-05) — auto-generate a receipt row on
   * every markPaid so the Fee Dues 🧾 Receipt modal can find + preview it. */
  let receiptId = null;
  try {
    await _ensureSchemaV2Fees();
    const enrol = (await db.query(`SELECT * FROM edu_enrollments WHERE id=$1`, [inst.enrollment_id])).rows[0];
    const lead = enrol && enrol.lead_id
      ? (await db.query(`SELECT name, phone FROM leads WHERE id=$1`, [enrol.lead_id])).rows[0] || {}
      : {};
    const rno = await _genReceiptNumber();
    const rc = await db.query(
      `INSERT INTO edu_receipts (receipt_no, enrollment_id, lead_id, amount, mode, reference,
                                  student_name, course, payment_id, issued_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [rno, inst.enrollment_id, enrol ? enrol.lead_id : null, amount, String(p.mode || 'cash'),
       String(p.receipt_no || ''), String(lead.name || ''),
       String(enrol ? enrol.course_name : ''), payIns.rows[0].id, me.id, String(p.note || '')]
    );
    receiptId = rc.rows[0].id;
    await db.query(`UPDATE edu_payments SET receipt_id=$1 WHERE id=$2`, [receiptId, payIns.rows[0].id]);
  } catch (e) { console.warn('[edu] auto-receipt failed:', e.message); }
  return { ok: true, status, paid_amount: newPaid, receipt_id: receiptId };
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

/* ====================================================================== */
/* EDU_PACK_v2 (2026-06-27) — Enrollment + Scholarships + Batches         */
/* ---------------------------------------------------------------------- */
/* Architecture notes (load-safe):                                        */
/*  - Zero boot-time queries. _ensureSchemaV2() runs only when a v2 API   */
/*    is invoked (idempotent CREATE TABLE IF NOT EXISTS + indexes).       */
/*  - No background sweeps, no cron jobs.                                 */
/*  - Aggregations server-side with LIMIT; never SELECT * over leads.     */
/*  - Indexes on hot columns (lead_id, status, stage, due_date).          */
/* ====================================================================== */

let _v2SchemaReady = false;
async function _ensureSchemaV2() {
  if (_v2SchemaReady) return;
  // edu_batches — Morning / Evening / Weekend cohorts
  await db.query(`CREATE TABLE IF NOT EXISTS edu_batches (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(120) NOT NULL,
    code          VARCHAR(60),
    course        VARCHAR(120),
    branch_id     INTEGER,
    start_time    VARCHAR(20),
    end_time      VARCHAR(20),
    days          VARCHAR(60),
    capacity      INTEGER DEFAULT 30,
    enrolled_ct   INTEGER DEFAULT 0,
    start_date    DATE,
    end_date      DATE,
    status        VARCHAR(20) DEFAULT 'open',
    created_at    TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_batches_status_idx ON edu_batches(status)`);

  // edu_scholarships — catalog
  await db.query(`CREATE TABLE IF NOT EXISTS edu_scholarships (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(160) NOT NULL,
    sch_type        VARCHAR(40) NOT NULL,
    discount_pct    NUMERIC(5,2) DEFAULT 0,
    discount_amt    NUMERIC(12,2) DEFAULT 0,
    auto_eligible   SMALLINT DEFAULT 0,
    eligibility     TEXT,
    notes           TEXT,
    active          SMALLINT DEFAULT 1,
    created_at      TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_scholarships_active_idx ON edu_scholarships(active)`);

  // edu_applications — multi-step admission record
  await db.query(`CREATE TABLE IF NOT EXISTS edu_applications (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER,
    student_name    VARCHAR(160),
    phone           VARCHAR(40),
    email           VARCHAR(160),
    parent_phone    VARCHAR(40),
    parent_email    VARCHAR(160),
    dob             DATE,
    address         TEXT,
    city            VARCHAR(120),
    state           VARCHAR(120),
    pincode         VARCHAR(20),
    course          VARCHAR(160),
    batch_id        INTEGER,
    branch_id       INTEGER,
    prev_board      VARCHAR(60),
    prev_pct        NUMERIC(5,2),
    prev_year       INTEGER,
    counselor_id    INTEGER,
    status          VARCHAR(40) DEFAULT 'draft',
    current_step    INTEGER DEFAULT 1,
    submitted_at    TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_applications_lead_idx ON edu_applications(lead_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_applications_status_idx ON edu_applications(status)`);

  // edu_application_documents — checklist per application
  await db.query(`CREATE TABLE IF NOT EXISTS edu_application_documents (
    id              SERIAL PRIMARY KEY,
    application_id  INTEGER NOT NULL,
    doc_name        VARCHAR(160) NOT NULL,
    doc_type        VARCHAR(60),
    mandatory       SMALLINT DEFAULT 1,
    file_url        TEXT,
    file_size       INTEGER,
    status          VARCHAR(20) DEFAULT 'pending',
    rejected_reason TEXT,
    verified_by     INTEGER,
    verified_at     TIMESTAMP,
    uploaded_at     TIMESTAMP,
    created_at      TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_appdocs_app_idx ON edu_application_documents(application_id)`);

  // edu_admission_letters — generated letters
  await db.query(`CREATE TABLE IF NOT EXISTS edu_admission_letters (
    id              SERIAL PRIMARY KEY,
    application_id  INTEGER,
    enrollment_id   INTEGER,
    lead_id         INTEGER,
    roll_number     VARCHAR(80),
    file_url        TEXT,
    sent_via        VARCHAR(40),
    issued_by       INTEGER,
    issued_at       TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_letters_app_idx ON edu_admission_letters(application_id)`);

  // edu_batch_shifts — audit of student batch changes
  await db.query(`CREATE TABLE IF NOT EXISTS edu_batch_shifts (
    id              SERIAL PRIMARY KEY,
    enrollment_id   INTEGER NOT NULL,
    lead_id         INTEGER,
    from_batch_id   INTEGER,
    to_batch_id     INTEGER,
    reason          TEXT,
    shifted_by      INTEGER,
    shifted_at      TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_shifts_enr_idx ON edu_batch_shifts(enrollment_id)`);

  // edu_withdrawals — withdrawal/refund
  await db.query(`CREATE TABLE IF NOT EXISTS edu_withdrawals (
    id              SERIAL PRIMARY KEY,
    enrollment_id   INTEGER NOT NULL,
    lead_id         INTEGER,
    reason          TEXT,
    refund_amount   NUMERIC(12,2) DEFAULT 0,
    refund_status   VARCHAR(20) DEFAULT 'pending',
    requested_by    INTEGER,
    approved_by     INTEGER,
    requested_at    TIMESTAMP DEFAULT NOW(),
    approved_at     TIMESTAMP
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_withdraw_enr_idx ON edu_withdrawals(enrollment_id)`);

  // edu_scholarship_applied — per-enrollment applied discounts
  await db.query(`CREATE TABLE IF NOT EXISTS edu_scholarship_applied (
    id              SERIAL PRIMARY KEY,
    enrollment_id   INTEGER NOT NULL,
    application_id  INTEGER,
    lead_id         INTEGER,
    scholarship_id  INTEGER NOT NULL,
    discount_pct    NUMERIC(5,2) DEFAULT 0,
    discount_amt    NUMERIC(12,2) DEFAULT 0,
    note            TEXT,
    approved_by     INTEGER,
    applied_at      TIMESTAMP DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_sch_applied_enr_idx ON edu_scholarship_applied(enrollment_id)`);

  _v2SchemaReady = true;
}

/* Default doc checklist for a course (mandatory) */
const DEFAULT_DOC_CHECKLIST = [
  { doc_name: '10th Marksheet',       doc_type: 'marksheet',  mandatory: 1 },
  { doc_name: '10th Pass Certificate',doc_type: 'certificate',mandatory: 1 },
  { doc_name: '12th Marksheet',       doc_type: 'marksheet',  mandatory: 0 },
  { doc_name: 'Aadhaar Card',         doc_type: 'id',         mandatory: 1 },
  { doc_name: 'Recent Photo (passport)', doc_type: 'photo',   mandatory: 1 },
  { doc_name: 'Address Proof',        doc_type: 'address',    mandatory: 1 }
];

/* Default scholarship seed when catalog empty */
const DEFAULT_SCHOLARSHIPS = [
  { name: 'Merit Scholarship',  sch_type: 'merit',   discount_pct: 10, auto_eligible: 1, eligibility: '10th >= 85%' },
  { name: 'Top Scorer',         sch_type: 'merit',   discount_pct: 25, auto_eligible: 1, eligibility: '10th >= 95%' },
  { name: 'Sports Quota',       sch_type: 'sports',  discount_pct: 15, auto_eligible: 0, eligibility: 'State / National player' },
  { name: 'Sibling Discount',   sch_type: 'sibling', discount_pct: 8,  auto_eligible: 0, eligibility: 'Sibling already enrolled' },
  { name: 'Financial Aid',      sch_type: 'need',    discount_pct: 20, auto_eligible: 0, eligibility: 'Family income < ₹3 L' },
  { name: 'Early Bird',         sch_type: 'early',   discount_pct: 5,  auto_eligible: 0, eligibility: 'Full payment by 30 Apr' }
];

/* ---------------- v2 SUMMARY ---------------- */
async function api_edu_v2_summary(token, opts) {
  await _ensureSchemaV2();
  await authUser(token); // any logged-in user can view
  const o = opts || {};
  const period = String(o.period || 'this_month');
  const now = new Date();
  let since = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  if (period === 'today')       since = now.toISOString().slice(0, 10);
  if (period === 'yesterday') { const d = new Date(now); d.setDate(d.getDate()-1); since = d.toISOString().slice(0,10); }
  if (period === 'last_7d')   { const d = new Date(now); d.setDate(d.getDate()-7); since = d.toISOString().slice(0,10); }
  if (period === 'last_30d')  { const d = new Date(now); d.setDate(d.getDate()-30); since = d.toISOString().slice(0,10); }

  const apps = await db.query(
    `SELECT status, COUNT(*)::int AS n FROM edu_applications WHERE created_at::date >= $1 GROUP BY status`,
    [since]
  );
  let appCnt = 0, submitted = 0, admitted = 0;
  for (const r of apps.rows) {
    appCnt += r.n;
    if (['submitted','documents_verified','fee_paid','admitted','class_started'].includes(String(r.status))) submitted += r.n;
    if (['admitted','class_started'].includes(String(r.status))) admitted += r.n;
  }
  const enrs = await db.query(
    `SELECT COUNT(*)::int AS n FROM edu_enrollments WHERE created_at::date >= $1`,
    [since]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return {
    period,
    since,
    applications: appCnt,
    submitted,
    admitted,
    enrollments: enrs.rows[0].n
  };
}

/* ---------------- BATCHES ---------------- */
async function api_edu_batches_list(token, filters) {
  await _ensureSchemaV2();
  await authUser(token);
  const f = filters || {};
  const rs = await db.query(
    `SELECT * FROM edu_batches ${f.active_only ? "WHERE status='open'" : ''} ORDER BY id DESC LIMIT 500`
  );
  return { items: rs.rows };
}
async function api_edu_batches_save(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  const p = payload || {};
  if (p.id) {
    await db.query(
      `UPDATE edu_batches SET name=$1,code=$2,course=$3,branch_id=$4,start_time=$5,end_time=$6,days=$7,capacity=$8,start_date=$9,end_date=$10,status=$11 WHERE id=$12`,
      [p.name, p.code||null, p.course||null, p.branch_id||null, p.start_time||null, p.end_time||null, p.days||null, p.capacity||30, p.start_date||null, p.end_date||null, p.status||'open', p.id]
    );
    return { ok: true, id: p.id };
  }
  const ins = await db.query(
    `INSERT INTO edu_batches (name,code,course,branch_id,start_time,end_time,days,capacity,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.name, p.code||null, p.course||null, p.branch_id||null, p.start_time||null, p.end_time||null, p.days||null, p.capacity||30, p.start_date||null, p.end_date||null, p.status||'open']
  );
  return { ok: true, id: ins.rows[0].id };
}
async function api_edu_batches_delete(token, id) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  await db.query(`DELETE FROM edu_batches WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* ---------------- SCHOLARSHIPS ---------------- */
async function api_edu_scholarships_list(token, filters) {
  await _ensureSchemaV2();
  await authUser(token);
  // Auto-seed defaults on first call
  const ct = await db.query(`SELECT COUNT(*)::int n FROM edu_scholarships`);
  if (ct.rows[0].n === 0) {
    for (const s of DEFAULT_SCHOLARSHIPS) {
      await db.query(
        `INSERT INTO edu_scholarships (name,sch_type,discount_pct,auto_eligible,eligibility,active) VALUES ($1,$2,$3,$4,$5,1)`,
        [s.name, s.sch_type, s.discount_pct, s.auto_eligible, s.eligibility]
      );
    }
  }
  const rs = await db.query(`SELECT * FROM edu_scholarships WHERE active=1 ORDER BY discount_pct DESC, id`);
  return { items: rs.rows };
}
async function api_edu_scholarships_save(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  const p = payload || {};
  if (p.id) {
    await db.query(
      `UPDATE edu_scholarships SET name=$1,sch_type=$2,discount_pct=$3,discount_amt=$4,auto_eligible=$5,eligibility=$6,notes=$7,active=$8 WHERE id=$9`,
      [p.name, p.sch_type||'merit', p.discount_pct||0, p.discount_amt||0, p.auto_eligible?1:0, p.eligibility||null, p.notes||null, p.active===0?0:1, p.id]
    );
    return { ok: true, id: p.id };
  }
  const ins = await db.query(
    `INSERT INTO edu_scholarships (name,sch_type,discount_pct,discount_amt,auto_eligible,eligibility,notes,active) VALUES ($1,$2,$3,$4,$5,$6,$7,1) RETURNING id`,
    [p.name, p.sch_type||'merit', p.discount_pct||0, p.discount_amt||0, p.auto_eligible?1:0, p.eligibility||null, p.notes||null]
  );
  return { ok: true, id: ins.rows[0].id };
}
async function api_edu_scholarships_delete(token, id) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  await db.query(`UPDATE edu_scholarships SET active=0 WHERE id=$1`, [Number(id)]);
  return { ok: true };
}
async function api_edu_scholarships_applied(token, enrollmentId) {
  await _ensureSchemaV2();
  await authUser(token);
  const rs = await db.query(
    `SELECT a.*, s.name AS scholarship_name, s.sch_type FROM edu_scholarship_applied a
     LEFT JOIN edu_scholarships s ON s.id=a.scholarship_id
     WHERE a.enrollment_id=$1 ORDER BY a.applied_at DESC LIMIT 50`,
    [Number(enrollmentId)]
  );
  return { items: rs.rows };
}
async function api_edu_scholarships_apply(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.enrollment_id || !p.scholarship_id) throw new Error('enrollment_id + scholarship_id required');
  const sch = await db.query(`SELECT * FROM edu_scholarships WHERE id=$1`, [p.scholarship_id]);
  if (!sch.rows.length) throw new Error('Scholarship not found');
  const s = sch.rows[0];
  const ins = await db.query(
    `INSERT INTO edu_scholarship_applied (enrollment_id, application_id, lead_id, scholarship_id, discount_pct, discount_amt, note, approved_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.enrollment_id, p.application_id||null, p.lead_id||null, p.scholarship_id, p.discount_pct ?? s.discount_pct, p.discount_amt ?? s.discount_amt, p.note||null, me.id]
  );
  return { ok: true, id: ins.rows[0].id };
}
async function api_edu_scholarships_unapply(token, id) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  await db.query(`DELETE FROM edu_scholarship_applied WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* ---------------- APPLICATIONS ---------------- */
async function api_edu_applications_list(token, filters) {
  await _ensureSchemaV2();
  await authUser(token);
  const f = filters || {};
  const where = [];
  const args = [];
  if (f.status)   { args.push(f.status);   where.push(`status = $${args.length}`); }
  if (f.lead_id)  { args.push(f.lead_id);  where.push(`lead_id = $${args.length}`); }
  if (f.q) {
    args.push('%' + f.q + '%');
    where.push(`(student_name ILIKE $${args.length} OR phone ILIKE $${args.length} OR email ILIKE $${args.length})`);
  }
  const limit = Math.min(parseInt(f.limit || 100, 10) || 100, 500);
  const sql = `SELECT id, lead_id, student_name, phone, email, course, batch_id, branch_id,
                      counselor_id, status, current_step, submitted_at, created_at, updated_at
               FROM edu_applications
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY updated_at DESC LIMIT ${limit}`;
  const rs = await db.query(sql, args);
  return { items: rs.rows };
}

async function api_edu_applications_get(token, id) {
  await _ensureSchemaV2();
  await authUser(token);
  const rs = await db.query(`SELECT * FROM edu_applications WHERE id=$1`, [Number(id)]);
  if (!rs.rows.length) throw new Error('Application not found');
  const docs = await db.query(
    `SELECT * FROM edu_application_documents WHERE application_id=$1 ORDER BY mandatory DESC, id`,
    [Number(id)]
  );
  return { item: rs.rows[0], documents: docs.rows };
}

async function api_edu_applications_create(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.student_name && !p.lead_id) throw new Error('student_name OR lead_id required');
  // Inherit name/phone from lead if lead_id provided
  let nm = p.student_name, ph = p.phone, em = p.email;
  if (p.lead_id && (!nm || !ph)) {
    const ld = await db.query(`SELECT name, phone, email FROM leads WHERE id=$1`, [p.lead_id]);
    if (ld.rows.length) {
      nm = nm || ld.rows[0].name;
      ph = ph || ld.rows[0].phone;
      em = em || ld.rows[0].email;
    }
  }
  const ins = await db.query(
    `INSERT INTO edu_applications
       (lead_id, student_name, phone, email, parent_phone, parent_email, dob, address, city, state, pincode,
        course, batch_id, branch_id, prev_board, prev_pct, prev_year, counselor_id, status, current_step)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'draft',1)
     RETURNING id`,
    [p.lead_id||null, nm, ph||null, em||null, p.parent_phone||null, p.parent_email||null,
     p.dob||null, p.address||null, p.city||null, p.state||null, p.pincode||null,
     p.course||null, p.batch_id||null, p.branch_id||null,
     p.prev_board||null, p.prev_pct||null, p.prev_year||null,
     p.counselor_id || me.id]
  );
  const appId = ins.rows[0].id;
  // Seed default doc checklist
  for (const d of DEFAULT_DOC_CHECKLIST) {
    await db.query(
      `INSERT INTO edu_application_documents (application_id, doc_name, doc_type, mandatory, status) VALUES ($1,$2,$3,$4,'pending')`,
      [appId, d.doc_name, d.doc_type, d.mandatory]
    );
  }
  return { ok: true, id: appId };
}

async function api_edu_applications_saveStep(token, payload) {
  await _ensureSchemaV2();
  await authUser(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const fields = ['student_name','phone','email','parent_phone','parent_email','dob','address','city','state','pincode',
                  'course','batch_id','branch_id','prev_board','prev_pct','prev_year','counselor_id'];
  const sets = []; const args = [];
  for (const f of fields) {
    if (p[f] !== undefined) {
      args.push(p[f]); sets.push(`${f}=$${args.length}`);
    }
  }
  if (p.step !== undefined) { args.push(p.step); sets.push(`current_step=$${args.length}`); }
  sets.push(`updated_at=NOW()`);
  args.push(p.id);
  await db.query(`UPDATE edu_applications SET ${sets.join(', ')} WHERE id=$${args.length}`, args);
  return { ok: true };
}

async function api_edu_applications_submit(token, id) {
  await _ensureSchemaV2();
  await authUser(token);
  // Check all mandatory docs verified
  const docs = await db.query(
    `SELECT COUNT(*)::int AS pending FROM edu_application_documents WHERE application_id=$1 AND mandatory=1 AND status != 'verified'`,
    [Number(id)]
  );
  if (docs.rows[0].pending > 0) {
    // Allow submit but mark status documents_pending
    await db.query(
      `UPDATE edu_applications SET status='documents_pending', submitted_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [Number(id)]
    );
    return { ok: true, status: 'documents_pending', pending_mandatory_docs: docs.rows[0].pending };
  }
  await db.query(
    `UPDATE edu_applications SET status='submitted', submitted_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [Number(id)]
  );
  return { ok: true, status: 'submitted' };
}

async function api_edu_applications_delete(token, id) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  await db.query(`DELETE FROM edu_application_documents WHERE application_id=$1`, [Number(id)]);
  await db.query(`DELETE FROM edu_applications WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* ---------------- APPLICATION DOCS ---------------- */
async function api_edu_appDocs_list(token, applicationId) {
  await _ensureSchemaV2();
  await authUser(token);
  const rs = await db.query(
    `SELECT * FROM edu_application_documents WHERE application_id=$1 ORDER BY mandatory DESC, id`,
    [Number(applicationId)]
  );
  return { items: rs.rows };
}
async function api_edu_appDocs_addCustom(token, payload) {
  await _ensureSchemaV2();
  await authUser(token);
  const p = payload || {};
  if (!p.application_id || !p.doc_name) throw new Error('application_id + doc_name required');
  const ins = await db.query(
    `INSERT INTO edu_application_documents (application_id, doc_name, doc_type, mandatory, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
    [p.application_id, p.doc_name, p.doc_type||'other', p.mandatory?1:0]
  );
  return { ok: true, id: ins.rows[0].id };
}
async function api_edu_appDocs_upload(token, payload) {
  await _ensureSchemaV2();
  await authUser(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  await db.query(
    `UPDATE edu_application_documents SET file_url=$1, file_size=$2, uploaded_at=NOW(), status='uploaded' WHERE id=$3`,
    [p.file_url||null, p.file_size||null, p.id]
  );
  return { ok: true };
}
async function api_edu_appDocs_verify(token, id) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  await db.query(
    `UPDATE edu_application_documents SET status='verified', verified_by=$1, verified_at=NOW(), rejected_reason=NULL WHERE id=$2`,
    [me.id, Number(id)]
  );
  return { ok: true };
}
async function api_edu_appDocs_reject(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  await db.query(
    `UPDATE edu_application_documents SET status='rejected', verified_by=$1, verified_at=NOW(), rejected_reason=$2 WHERE id=$3`,
    [me.id, p.reason||null, p.id]
  );
  return { ok: true };
}

/* ---------------- ENROLLMENTS v3 (with admission letter, batch shift, withdrawal) ---------------- */
function _genRollNumber(prefix, year, seq) {
  const yy = String(year || new Date().getFullYear()).slice(-2);
  return `${(prefix||'STD').toUpperCase().slice(0,6)}/${yy}/${String(seq).padStart(4,'0')}`;
}

async function api_edu_enrollment_issueAdmissionLetter(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager','team_leader'].includes(me.role)) throw new Error('Admin/manager only');
  const p = payload || {};
  if (!p.enrollment_id) throw new Error('enrollment_id required');
  // Get next roll seq from existing letters
  const seq = await db.query(`SELECT COALESCE(MAX(id),0)+247 AS n FROM edu_admission_letters`);
  const roll = p.roll_number || _genRollNumber(p.prefix||'STD', new Date().getFullYear(), seq.rows[0].n);
  const ins = await db.query(
    `INSERT INTO edu_admission_letters (application_id, enrollment_id, lead_id, roll_number, file_url, sent_via, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.application_id||null, p.enrollment_id, p.lead_id||null, roll, p.file_url||null, p.sent_via||'whatsapp', me.id]
  );
  return { ok: true, id: ins.rows[0].id, roll_number: roll };
}
async function api_edu_enrollment_letters(token, enrollmentId) {
  await _ensureSchemaV2();
  await authUser(token);
  const rs = await db.query(
    `SELECT * FROM edu_admission_letters WHERE enrollment_id=$1 ORDER BY issued_at DESC`,
    [Number(enrollmentId)]
  );
  return { items: rs.rows };
}
async function api_edu_enrollment_batchShift(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager','team_leader'].includes(me.role)) throw new Error('Admin/manager only');
  const p = payload || {};
  if (!p.enrollment_id || !p.to_batch_id) throw new Error('enrollment_id + to_batch_id required');
  const cur = await db.query(`SELECT batch_id, lead_id FROM edu_enrollments WHERE id=$1`, [p.enrollment_id]).catch(() => ({ rows: [] }));
  const from = cur.rows[0] ? cur.rows[0].batch_id : null;
  await db.query(
    `INSERT INTO edu_batch_shifts (enrollment_id, lead_id, from_batch_id, to_batch_id, reason, shifted_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.enrollment_id, p.lead_id||(cur.rows[0]?cur.rows[0].lead_id:null), from, p.to_batch_id, p.reason||null, me.id]
  );
  await db.query(`UPDATE edu_enrollments SET batch_id=$1 WHERE id=$2`, [p.to_batch_id, p.enrollment_id]).catch(() => {});
  return { ok: true };
}
async function api_edu_enrollment_withdraw(token, payload) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  const p = payload || {};
  if (!p.enrollment_id) throw new Error('enrollment_id required');
  const ins = await db.query(
    `INSERT INTO edu_withdrawals (enrollment_id, lead_id, reason, refund_amount, refund_status, requested_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [p.enrollment_id, p.lead_id||null, p.reason||null, p.refund_amount||0, p.refund_status||'pending', me.id]
  );
  await db.query(`UPDATE edu_enrollments SET status='withdrawn' WHERE id=$1`, [p.enrollment_id]).catch(() => {});
  return { ok: true, id: ins.rows[0].id };
}
async function api_edu_enrollment_history(token, enrollmentId) {
  await _ensureSchemaV2();
  await authUser(token);
  const shifts = await db.query(
    `SELECT 'batch_shift' AS event_type, id, shifted_at AS ts, reason AS note, to_batch_id AS detail
     FROM edu_batch_shifts WHERE enrollment_id=$1 ORDER BY shifted_at DESC LIMIT 50`,
    [Number(enrollmentId)]
  );
  const letters = await db.query(
    `SELECT 'admission_letter' AS event_type, id, issued_at AS ts, roll_number AS note, file_url AS detail
     FROM edu_admission_letters WHERE enrollment_id=$1 ORDER BY issued_at DESC LIMIT 50`,
    [Number(enrollmentId)]
  );
  const withdraws = await db.query(
    `SELECT 'withdrawal' AS event_type, id, requested_at AS ts, reason AS note, refund_status AS detail
     FROM edu_withdrawals WHERE enrollment_id=$1 ORDER BY requested_at DESC LIMIT 50`,
    [Number(enrollmentId)]
  );
  const merged = [...shifts.rows, ...letters.rows, ...withdraws.rows].sort((a,b) => new Date(b.ts) - new Date(a.ts));
  return { items: merged.slice(0, 50) };
}

/* ---------------- v2 SEED DEMO + RESET STAGES ---------------- */
async function api_edu_v2_resetStages(token) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  const STAGES = [
    { name: 'New Inquiry',           color: '#3b82f6' },
    { name: 'Counseling Scheduled',  color: '#06b6d4' },
    { name: 'Counseling Done',       color: '#a855f7' },
    { name: 'Information Sent',      color: '#22c55e' },
    { name: 'Application Started',   color: '#f59e0b' },
    { name: 'Application Submitted', color: '#ec4899' },
    { name: 'Documents Pending',     color: '#f97316' },
    { name: 'Documents Verified',    color: '#84cc16' },
    { name: 'Fee Plan Selected',     color: '#6366f1' },
    { name: 'Token / 1st Fee Paid',  color: '#16a34a' },
    { name: 'Admitted',              color: '#15803d', is_final: 1 },
    { name: 'Class Started',         color: '#0d9488', is_final: 1 },
    { name: 'Lost to Competitor',    color: '#6b7280', is_final: 1 },
    { name: 'Dropped',               color: '#6b7280', is_final: 1 }
  ];
  for (let i = 0; i < STAGES.length; i++) {
    const s = STAGES[i];
    const found = await db.query(`SELECT id FROM statuses WHERE LOWER(name)=LOWER($1) LIMIT 1`, [s.name]);
    if (found.rows.length) {
      await db.query(`UPDATE statuses SET sort_order=$1, color=$2, is_final=$3 WHERE id=$4`, [i+1, s.color, s.is_final?1:0, found.rows[0].id]);
    } else {
      await db.query(`INSERT INTO statuses (name, sort_order, color, is_final) VALUES ($1,$2,$3,$4)`, [s.name, i+1, s.color, s.is_final?1:0]);
    }
  }
  return { ok: true, stages: STAGES.length };
}

async function api_edu_v2_seedDemo(token) {
  await _ensureSchemaV2();
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin only');
  // Apply 14-stage pipeline first
  try { await api_edu_v2_resetStages(token); } catch (e) {}
  // Seed batches
  const batches = [
    { name: 'NEET 2026 Morning',  code: 'NEET-26-M01', course: 'NEET 2026 Foundation', start_time: '08:00', end_time: '10:00', days: 'Mon-Sat', capacity: 40 },
    { name: 'NEET 2026 Evening',  code: 'NEET-26-E01', course: 'NEET 2026 Foundation', start_time: '18:00', end_time: '20:00', days: 'Mon-Sat', capacity: 40 },
    { name: 'JEE 2027 Morning',   code: 'JEE-27-M01',  course: 'JEE 2027 Foundation',  start_time: '08:00', end_time: '10:00', days: 'Mon-Sat', capacity: 35 },
    { name: 'CBSE Foundation',    code: 'CBSE-FN-01',  course: 'CBSE Foundation',      start_time: '16:00', end_time: '18:00', days: 'Mon-Fri', capacity: 30 }
  ];
  for (const b of batches) {
    const exists = await db.query(`SELECT id FROM edu_batches WHERE code=$1 LIMIT 1`, [b.code]);
    if (!exists.rows.length) {
      await db.query(
        `INSERT INTO edu_batches (name,code,course,start_time,end_time,days,capacity,status) VALUES ($1,$2,$3,$4,$5,$6,$7,'open')`,
        [b.name, b.code, b.course, b.start_time, b.end_time, b.days, b.capacity]
      );
    }
  }
  // Ensure scholarships exist
  await api_edu_scholarships_list(token);
  // Seed 10 demo applications across various stages
  const demoApps = [
    { name: 'Pranav Kumar',  phone: '+919876543210', course: 'NEET 2026 Foundation', status: 'documents_pending', step: 3, prev_pct: 88.4 },
    { name: 'Riya Singh',    phone: '+919876543221', course: 'JEE 2027 Foundation',  status: 'documents_verified', step: 4, prev_pct: 92.1 },
    { name: 'Aditi Verma',   phone: '+919876543232', course: 'CBSE Foundation',      status: 'submitted',          step: 5, prev_pct: 79.0 },
    { name: 'Rohit Mehta',   phone: '+919876543243', course: 'NEET 2026 Foundation', status: 'draft',              step: 2, prev_pct: 81.5 },
    { name: 'Kapil Jha',     phone: '+919876543254', course: 'JEE 2027 Foundation',  status: 'admitted',           step: 6, prev_pct: 90.3 },
    { name: 'Suman Roy',     phone: '+919876543265', course: 'NEET 2026 Foundation', status: 'admitted',           step: 6, prev_pct: 86.7 },
    { name: 'Nikhil Sahu',   phone: '+919876543276', course: 'CBSE Foundation',      status: 'documents_pending', step: 3, prev_pct: 74.2 },
    { name: 'Priyanka Das',  phone: '+919876543287', course: 'NEET 2026 Foundation', status: 'submitted',          step: 5, prev_pct: 95.5 },
    { name: 'Sandeep Iyer',  phone: '+919876543298', course: 'JEE 2027 Foundation',  status: 'draft',              step: 1, prev_pct: 83.0 },
    { name: 'Meera Nair',    phone: '+919876543309', course: 'NEET 2026 Foundation', status: 'admitted',           step: 6, prev_pct: 91.0 }
  ];
  let inserted = 0;
  for (const a of demoApps) {
    const exists = await db.query(`SELECT id FROM edu_applications WHERE phone=$1 AND student_name=$2 LIMIT 1`, [a.phone, a.name]);
    if (exists.rows.length) continue;
    const ins = await db.query(
      `INSERT INTO edu_applications (student_name, phone, course, status, current_step, prev_pct, prev_board, prev_year, counselor_id)
       VALUES ($1,$2,$3,$4,$5,$6,'CBSE',2024,$7) RETURNING id`,
      [a.name, a.phone, a.course, a.status, a.step, a.prev_pct, me.id]
    );
    const appId = ins.rows[0].id;
    for (const d of DEFAULT_DOC_CHECKLIST) {
      const status = (a.status === 'documents_verified' || a.status === 'admitted') ? 'verified' :
                     (a.status === 'documents_pending' && d.doc_name.startsWith('10th')) ? 'verified' : 'pending';
      await db.query(
        `INSERT INTO edu_application_documents (application_id, doc_name, doc_type, mandatory, status, verified_by, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,${status==='verified'?'NOW()':'NULL'})`,
        [appId, d.doc_name, d.doc_type, d.mandatory, status, status==='verified'?me.id:null]
      );
    }
    inserted++;
  }
  return { ok: true, batches_seeded: batches.length, applications_inserted: inserted };
}


/* ============================================================================
 * EDU_PACK_v2 Commit 2 — Fee Tracking DEEP + Dunning Workflow (2026-07-03)
 * ============================================================================
 * Adds:
 *   edu_fee_categories       — split tuition/hostel/transport/exam/other
 *   edu_fee_concessions      — waivers/discounts per installment
 *   edu_fee_penalties        — auto-applied late fees
 *   edu_fee_reminders        — dunning schedule (T-3, T+0, T+3, T+7, T+14, T+30)
 *   edu_receipts             — official receipt numbers + PDF-ready payload
 *
 * Extends:
 *   edu_installments  += category_id, waiver_amount, penalty_amount, receipt_id
 *   edu_payments      += reference (bank ref / cheque #), receipt_id
 * ============================================================================ */

let _v2FeeSchemaReady = false;
async function _ensureSchemaV2Fees() {
  if (_v2FeeSchemaReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS edu_fee_categories (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL,
    code        VARCHAR(30),
    is_active   SMALLINT DEFAULT 1,
    sort_order  INTEGER DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_feecats_active_idx ON edu_fee_categories(is_active)`).catch(()=>{});

  await db.query(`CREATE TABLE IF NOT EXISTS edu_fee_concessions (
    id              SERIAL PRIMARY KEY,
    enrollment_id   INTEGER NOT NULL,
    installment_id  INTEGER,
    reason          VARCHAR(120) NOT NULL,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    pct             NUMERIC(5,2),
    approved_by     INTEGER,
    approved_at     TIMESTAMPTZ,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_concessions_enrol_idx ON edu_fee_concessions(enrollment_id)`).catch(()=>{});

  await db.query(`CREATE TABLE IF NOT EXISTS edu_fee_penalties (
    id              SERIAL PRIMARY KEY,
    installment_id  INTEGER NOT NULL,
    enrollment_id   INTEGER NOT NULL,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    days_overdue    INTEGER,
    waived          SMALLINT DEFAULT 0,
    waived_by       INTEGER,
    waived_at       TIMESTAMPTZ,
    waived_reason   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_penalties_inst_idx ON edu_fee_penalties(installment_id)`).catch(()=>{});

  await db.query(`CREATE TABLE IF NOT EXISTS edu_fee_reminders (
    id              SERIAL PRIMARY KEY,
    installment_id  INTEGER NOT NULL,
    enrollment_id   INTEGER NOT NULL,
    lead_id         INTEGER,
    stage           VARCHAR(40) NOT NULL,
    scheduled_for   DATE NOT NULL,
    sent_at         TIMESTAMPTZ,
    channel         VARCHAR(20),
    status          VARCHAR(20) DEFAULT 'scheduled',
    error           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_reminders_sched_idx ON edu_fee_reminders(scheduled_for, status)`).catch(()=>{});
  await db.query(`CREATE INDEX IF NOT EXISTS edu_reminders_inst_idx ON edu_fee_reminders(installment_id)`).catch(()=>{});

  await db.query(`CREATE TABLE IF NOT EXISTS edu_receipts (
    id              SERIAL PRIMARY KEY,
    receipt_no      VARCHAR(40) NOT NULL UNIQUE,
    enrollment_id   INTEGER NOT NULL,
    lead_id         INTEGER,
    amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
    mode            VARCHAR(30),
    reference       VARCHAR(80),
    student_name    VARCHAR(160),
    course          VARCHAR(160),
    payment_id      INTEGER,
    issued_by       INTEGER,
    issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes           TEXT
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS edu_receipts_enrol_idx ON edu_receipts(enrollment_id)`).catch(()=>{});

  // Extend edu_installments
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS category_id INTEGER`); } catch (_) {}
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS waiver_amount NUMERIC(12,2) DEFAULT 0`); } catch (_) {}
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS penalty_amount NUMERIC(12,2) DEFAULT 0`); } catch (_) {}
  try { await db.query(`ALTER TABLE edu_installments ADD COLUMN IF NOT EXISTS receipt_id INTEGER`); } catch (_) {}
  // Extend edu_payments
  try { await db.query(`ALTER TABLE edu_payments ADD COLUMN IF NOT EXISTS reference VARCHAR(80)`); } catch (_) {}
  try { await db.query(`ALTER TABLE edu_payments ADD COLUMN IF NOT EXISTS receipt_id INTEGER`); } catch (_) {}

  // Seed default fee categories if empty
  const c = (await db.query(`SELECT COUNT(*)::int AS n FROM edu_fee_categories`)).rows[0].n;
  if (c === 0) {
    const seeds = [
      { name: 'Tuition',   code: 'TUI', sort_order: 1 },
      { name: 'Admission', code: 'ADM', sort_order: 2 },
      { name: 'Exam',      code: 'EXM', sort_order: 3 },
      { name: 'Transport', code: 'TRN', sort_order: 4 },
      { name: 'Hostel',    code: 'HST', sort_order: 5 },
      { name: 'Books',     code: 'BOK', sort_order: 6 },
      { name: 'Other',     code: 'OTH', sort_order: 9 }
    ];
    for (const s of seeds) {
      await db.query(`INSERT INTO edu_fee_categories (name, code, sort_order) VALUES ($1,$2,$3)`,
        [s.name, s.code, s.sort_order]).catch(()=>{});
    }
  }
  _v2FeeSchemaReady = true;
}

/* ---------- Fee categories ---------- */
async function api_edu_feeCats_list(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const r = await db.query(`SELECT * FROM edu_fee_categories ORDER BY sort_order, name`);
  return { items: r.rows };
}
async function api_edu_feeCats_save(token, payload) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  if (p.id) {
    await db.query(
      `UPDATE edu_fee_categories SET name=$1, code=$2, is_active=$3, sort_order=$4 WHERE id=$5`,
      [String(p.name), String(p.code||''), p.is_active ? 1 : 0, Number(p.sort_order||0), Number(p.id)]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO edu_fee_categories (name, code, is_active, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
    [String(p.name), String(p.code||''), p.is_active !== 0 ? 1 : 0, Number(p.sort_order||0)]
  );
  return { ok: true, id: r.rows[0].id };
}
async function api_edu_feeCats_delete(token, id) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  await db.query(`DELETE FROM edu_fee_categories WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* ---------- Concessions / Waivers ---------- */
async function api_edu_concessions_list(token, enrollmentId) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const r = await db.query(
    `SELECT c.*, i.seq AS installment_seq, i.due_date, u.name AS approved_by_name
       FROM edu_fee_concessions c
       LEFT JOIN edu_installments i ON i.id = c.installment_id
       LEFT JOIN users u ON u.id = c.approved_by
      WHERE c.enrollment_id = $1
      ORDER BY c.created_at DESC`,
    [Number(enrollmentId)]
  );
  return { items: r.rows };
}
async function api_edu_concessions_apply(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const p = payload || {};
  if (!p.enrollment_id) throw new Error('enrollment_id required');
  if (!p.reason) throw new Error('reason required');
  let amount = Number(p.amount || 0);
  const pct = p.pct != null ? Number(p.pct) : null;
  // If pct given + installment_id, compute amount from installment.amount
  if (pct && p.installment_id) {
    const inst = (await db.query(`SELECT amount FROM edu_installments WHERE id=$1`, [Number(p.installment_id)])).rows[0];
    if (inst) amount = Math.round(Number(inst.amount) * pct) / 100;
  }
  const r = await db.query(
    `INSERT INTO edu_fee_concessions (enrollment_id, installment_id, reason, amount, pct, approved_by, approved_at, note)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7) RETURNING id`,
    [Number(p.enrollment_id), p.installment_id ? Number(p.installment_id) : null,
     String(p.reason), amount, pct, me.id, String(p.note || '')]
  );
  // If installment_id given — reflect in installment.waiver_amount + recompute status
  if (p.installment_id) {
    await db.query(
      `UPDATE edu_installments SET waiver_amount = COALESCE(waiver_amount,0) + $1 WHERE id = $2`,
      [amount, Number(p.installment_id)]
    );
    await _recomputeInstallmentStatus(Number(p.installment_id));
  }
  return { ok: true, id: r.rows[0].id, amount };
}
async function api_edu_concessions_remove(token, id) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const c = (await db.query(`SELECT * FROM edu_fee_concessions WHERE id=$1`, [Number(id)])).rows[0];
  if (!c) throw new Error('Concession not found');
  await db.query(`DELETE FROM edu_fee_concessions WHERE id=$1`, [Number(id)]);
  if (c.installment_id) {
    await db.query(
      `UPDATE edu_installments SET waiver_amount = GREATEST(COALESCE(waiver_amount,0) - $1, 0) WHERE id = $2`,
      [Number(c.amount), c.installment_id]
    );
    await _recomputeInstallmentStatus(c.installment_id);
  }
  return { ok: true };
}

/* ---------- Penalties (late fees) ---------- */
async function api_edu_penalties_apply(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const p = payload || {};
  if (!p.installment_id) throw new Error('installment_id required');
  const inst = (await db.query(`SELECT * FROM edu_installments WHERE id=$1`, [Number(p.installment_id)])).rows[0];
  if (!inst) throw new Error('Installment not found');
  let amount = Number(p.amount || 0);
  // Auto-compute if plan has late_fee_pct
  if (!amount && inst.enrollment_id) {
    const en = (await db.query(`SELECT plan_snapshot FROM edu_enrollments WHERE id=$1`, [inst.enrollment_id])).rows[0];
    try {
      const plan = JSON.parse(en.plan_snapshot || '{}');
      const pct = Number(plan.late_fee_pct || 0);
      if (pct) amount = Math.round(Number(inst.amount) * pct) / 100;
    } catch(_) {}
  }
  if (!amount) amount = 500; // fallback flat
  const daysOverdue = inst.due_date
    ? Math.floor((Date.now() - new Date(inst.due_date).getTime()) / 86400000)
    : 0;
  const r = await db.query(
    `INSERT INTO edu_fee_penalties (installment_id, enrollment_id, amount, days_overdue)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [inst.id, inst.enrollment_id, amount, daysOverdue]
  );
  await db.query(
    `UPDATE edu_installments SET penalty_amount = COALESCE(penalty_amount,0) + $1, late_fee = COALESCE(late_fee,0) + $1 WHERE id = $2`,
    [amount, inst.id]
  );
  await _recomputeInstallmentStatus(inst.id);
  return { ok: true, id: r.rows[0].id, amount, days_overdue: daysOverdue };
}
async function api_edu_penalties_waive(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const p = payload || {};
  if (!p.id) throw new Error('penalty id required');
  const pen = (await db.query(`SELECT * FROM edu_fee_penalties WHERE id=$1`, [Number(p.id)])).rows[0];
  if (!pen) throw new Error('Penalty not found');
  if (pen.waived) return { ok: true, already: true };
  await db.query(
    `UPDATE edu_fee_penalties SET waived=1, waived_by=$1, waived_at=NOW(), waived_reason=$2 WHERE id=$3`,
    [me.id, String(p.reason || ''), pen.id]
  );
  await db.query(
    `UPDATE edu_installments SET penalty_amount = GREATEST(COALESCE(penalty_amount,0) - $1, 0),
                                 late_fee       = GREATEST(COALESCE(late_fee,0) - $1, 0)
      WHERE id = $2`,
    [Number(pen.amount), pen.installment_id]
  );
  await _recomputeInstallmentStatus(pen.installment_id);
  return { ok: true };
}

/* ---------- Helper: recompute installment status considering waivers + penalties ---------- */
async function _recomputeInstallmentStatus(installmentId) {
  const inst = (await db.query(`SELECT * FROM edu_installments WHERE id=$1`, [Number(installmentId)])).rows[0];
  if (!inst) return;
  const due = Number(inst.amount) + Number(inst.penalty_amount || 0) - Number(inst.waiver_amount || 0);
  const paid = Number(inst.paid_amount || 0);
  let status;
  if (paid >= due && due > 0) status = 'paid';
  else if (paid > 0)          status = 'partial';
  else                        status = 'due';
  await db.query(`UPDATE edu_installments SET status=$1 WHERE id=$2`, [status, inst.id]);
  return status;
}

/* ---------- Dunning reminders ---------- */
const _REMINDER_STAGES = [
  { stage: 't_minus_3', offset_days: -3 },
  { stage: 't_zero',    offset_days: 0 },
  { stage: 't_plus_3',  offset_days: 3 },
  { stage: 't_plus_7',  offset_days: 7 },
  { stage: 't_plus_14', offset_days: 14 },
  { stage: 't_plus_30', offset_days: 30 }
];

async function api_edu_reminders_scheduleForInstallment(token, installmentId) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const inst = (await db.query(`SELECT * FROM edu_installments WHERE id=$1`, [Number(installmentId)])).rows[0];
  if (!inst) throw new Error('Installment not found');
  const enrol = (await db.query(`SELECT * FROM edu_enrollments WHERE id=$1`, [inst.enrollment_id])).rows[0];
  if (!enrol) throw new Error('Enrollment not found');
  if (!inst.due_date) return { ok: true, skipped: 'no_due_date' };
  const dueMs = new Date(inst.due_date).getTime();
  const inserted = [];
  for (const s of _REMINDER_STAGES) {
    const dt = new Date(dueMs + s.offset_days * 86400000).toISOString().slice(0, 10);
    // Skip duplicates
    const ex = await db.query(
      `SELECT 1 FROM edu_fee_reminders WHERE installment_id=$1 AND stage=$2 LIMIT 1`,
      [inst.id, s.stage]
    );
    if (ex.rows.length) continue;
    await db.query(
      `INSERT INTO edu_fee_reminders (installment_id, enrollment_id, lead_id, stage, scheduled_for, status)
       VALUES ($1,$2,$3,$4,$5,'scheduled')`,
      [inst.id, inst.enrollment_id, enrol.lead_id, s.stage, dt]
    );
    inserted.push(s.stage);
  }
  return { ok: true, inserted };
}

async function api_edu_reminders_dueList(token, opts) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const o = opts || {};
  const on = o.on ? String(o.on) : null;
  const limit = Math.min(Number(o.limit || 500), 2000);
  const args = [];
  let where = `r.status = 'scheduled' AND (i.status IN ('due','partial'))`;
  if (on) { args.push(on); where += ` AND r.scheduled_for = $${args.length}::date`; }
  else    { where += ` AND r.scheduled_for <= CURRENT_DATE`; }
  const sql = `SELECT r.*, i.seq AS installment_seq, i.due_date, i.amount, i.paid_amount, i.status AS inst_status,
                       e.course_name, e.batch_name, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
                  FROM edu_fee_reminders r
                  JOIN edu_installments i ON i.id = r.installment_id
                  JOIN edu_enrollments  e ON e.id = r.enrollment_id
                  LEFT JOIN leads l ON l.id = r.lead_id
                 WHERE ${where}
                 ORDER BY r.scheduled_for ASC, r.id ASC
                 LIMIT ${limit}`;
  const rows = (await db.query(sql, args)).rows;
  return { items: rows, count: rows.length };
}

async function api_edu_reminders_markSent(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const p = payload || {};
  if (!p.id) throw new Error('reminder id required');
  const chan = ['wa','email','sms','manual'].includes(p.channel) ? p.channel : 'manual';
  await db.query(
    `UPDATE edu_fee_reminders SET status='sent', sent_at=NOW(), channel=$1 WHERE id=$2`,
    [chan, Number(p.id)]
  );
  return { ok: true };
}

async function api_edu_reminders_skip(token, id) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  await db.query(`UPDATE edu_fee_reminders SET status='skipped' WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* ---------- Receipts ---------- */
async function _genReceiptNumber() {
  const yr = new Date().getFullYear();
  const prefix = `RCP-${yr}-`;
  const r = await db.query(
    `SELECT receipt_no FROM edu_receipts WHERE receipt_no LIKE $1 ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  let next = 1;
  if (r.rows.length) {
    const m = String(r.rows[0].receipt_no).match(/(\d+)$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }
  return prefix + String(next).padStart(6, '0');
}

async function api_edu_receipts_generate(token, payload) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const p = payload || {};
  /* EDU_RECEIPT_BYINST_v1 (2026-07-06) — accept installment_id as an
   * alternative to payment_id, so the SPA can generate a receipt for
   * a legacy paid installment even when the caller only knows the
   * installment id (e.g. Fee Dues 🧾 Receipt PDF button). Pick the
   * most-recent payment row for that installment. */
  let paymentId = p.payment_id ? Number(p.payment_id) : null;
  if (!paymentId && p.installment_id) {
    const pr = await db.query(
      `SELECT id FROM edu_payments WHERE installment_id=$1 ORDER BY id DESC LIMIT 1`,
      [Number(p.installment_id)]
    );
    if (pr.rows.length) paymentId = pr.rows[0].id;
    else throw new Error('No payment found for installment #' + p.installment_id + ' — mark it paid first, then generate the receipt');
  }
  if (!paymentId) throw new Error('payment_id or installment_id required');
  const pay = (await db.query(`SELECT * FROM edu_payments WHERE id=$1`, [paymentId])).rows[0];
  if (!pay) throw new Error('Payment not found');
  if (pay.receipt_id) {
    // Return existing
    const ex = (await db.query(`SELECT * FROM edu_receipts WHERE id=$1`, [pay.receipt_id])).rows[0];
    return { ok: true, item: ex, existing: true };
  }
  const enrol = (await db.query(`SELECT * FROM edu_enrollments WHERE id=$1`, [pay.enrollment_id])).rows[0];
  const lead  = enrol && enrol.lead_id
    ? (await db.query(`SELECT name, phone FROM leads WHERE id=$1`, [enrol.lead_id])).rows[0] || {}
    : {};
  const rno = await _genReceiptNumber();
  const ins = await db.query(
    `INSERT INTO edu_receipts (receipt_no, enrollment_id, lead_id, amount, mode, reference,
                                student_name, course, payment_id, issued_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [rno, pay.enrollment_id, enrol ? enrol.lead_id : null, Number(pay.amount), String(pay.mode || 'cash'),
     String(pay.reference || pay.receipt_no || ''), String(lead.name || ''),
     String(enrol ? enrol.course_name : ''), pay.id, me.id, String(p.notes || '')]
  );
  await db.query(`UPDATE edu_payments SET receipt_id=$1 WHERE id=$2`, [ins.rows[0].id, pay.id]);
  return { ok: true, item: ins.rows[0] };
}

async function api_edu_receipts_list(token, opts) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const o = opts || {};
  const args = [];
  const w = [];
  if (o.enrollment_id) { args.push(Number(o.enrollment_id)); w.push(`r.enrollment_id = $${args.length}`); }
  if (o.lead_id)       { args.push(Number(o.lead_id));       w.push(`r.lead_id = $${args.length}`); }
  if (o.from) { args.push(o.from); w.push(`r.issued_at >= $${args.length}::date`); }
  if (o.to)   { args.push(o.to);   w.push(`r.issued_at < ($${args.length}::date + INTERVAL '1 day')`); }
  /* EDU_RECEIPTS_UX_v1 — search + mode filter + pagination */
  if (o.q) {
    args.push('%' + String(o.q).toLowerCase() + '%');
    w.push(`(LOWER(COALESCE(r.receipt_no,'')) LIKE $${args.length} OR LOWER(COALESCE(r.student_name,'')) LIKE $${args.length} OR LOWER(COALESCE(r.course,'')) LIKE $${args.length} OR LOWER(COALESCE(r.reference,'')) LIKE $${args.length})`);
  }
  if (o.mode) { args.push(String(o.mode).toLowerCase()); w.push(`LOWER(r.mode) = $${args.length}`); }
  const whereSql = w.length ? 'WHERE ' + w.join(' AND ') : '';

  // total count for pagination
  const cSql = `SELECT COUNT(*)::int AS n FROM edu_receipts r ${whereSql}`;
  const cRes = await db.query(cSql, args);
  const total = (cRes.rows[0] && cRes.rows[0].n) || 0;

  const pageSize = Math.max(1, Math.min(Number(o.page_size || o.limit || 25), 200));
  const page = Math.max(1, Number(o.page || 1));
  const offset = (page - 1) * pageSize;
  const sql = `SELECT r.*, p.installment_id
                 FROM edu_receipts r
                 LEFT JOIN edu_payments p ON p.id = r.payment_id
                 ${whereSql}
                 ORDER BY r.id DESC
                 LIMIT ${pageSize} OFFSET ${offset}`;
  const r = await db.query(sql, args);
  return { items: r.rows, total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/* EDU_RECEIPTS_UX_v1 — edit an existing receipt (admin/manager only).
 * Editable: student_name, course, amount, mode, reference, notes, issued_at. */
async function api_edu_receipts_update(token, id, patch) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const rid = Number(id);
  if (!rid) throw new Error('Receipt id required');
  const p = patch || {};
  const sets = [];
  const args = [];
  const set = (k, v) => { args.push(v); sets.push(`${k} = $${args.length}`); };
  if ('student_name' in p) set('student_name', String(p.student_name || ''));
  if ('course'       in p) set('course',       String(p.course || ''));
  if ('amount'       in p) set('amount',       Number(p.amount) || 0);
  if ('mode'         in p) set('mode',         String(p.mode || 'cash'));
  if ('reference'    in p) set('reference',    String(p.reference || ''));
  if ('notes'        in p) set('notes',        String(p.notes || ''));
  if ('issued_at'    in p && p.issued_at)      set('issued_at',    p.issued_at);
  if (!sets.length) return { ok: true, updated: 0 };
  args.push(rid);
  await db.query(`UPDATE edu_receipts SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
  const row = (await db.query('SELECT * FROM edu_receipts WHERE id=$1', [rid])).rows[0];
  return { ok: true, updated: 1, item: row };
}

/* EDU_RECEIPT_REDESIGN_v1 — 2026-07-13
 * Professional fee receipt: institute letterhead (logo + name + address +
 * phone + email + GST), student block, enrollment block, payment table,
 * balance summary, amount in words, authorised-signatory footer.
 * Falls back gracefully when tenant hasn't set brand fields.               */
function _amountInWordsINR(n) {
  n = Math.round(Number(n) || 0);
  if (n === 0) return 'Zero Rupees Only';
  const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten',
             'Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen',
             'Eighteen','Nineteen'];
  const b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function inWords(num) {
    if (num < 20) return a[num];
    if (num < 100) return b[Math.floor(num/10)] + (num%10 ? ' ' + a[num%10] : '');
    if (num < 1000) return a[Math.floor(num/100)] + ' Hundred' + (num%100 ? ' ' + inWords(num%100) : '');
    return '';
  }
  function toWords(num) {
    if (num === 0) return '';
    let out = '';
    const cr = Math.floor(num / 10000000); num %= 10000000;
    const lk = Math.floor(num / 100000);   num %= 100000;
    const th = Math.floor(num / 1000);     num %= 1000;
    if (cr) out += inWords(cr) + ' Crore ';
    if (lk) out += inWords(lk) + ' Lakh ';
    if (th) out += inWords(th) + ' Thousand ';
    if (num) out += inWords(num);
    return out.replace(/\s+/g,' ').trim();
  }
  return toWords(n) + ' Rupees Only';
}

async function api_edu_receipts_html(token, id) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();

  const rc = (await db.query(`SELECT * FROM edu_receipts WHERE id=$1`, [Number(id)])).rows[0];
  if (!rc) throw new Error('Receipt not found');

  /* Enrich — pull lead (phone/email/parent), enrollment (course/batch/total),
   * installment totals + issuer name. Every join is LEFT so missing rows on
   * legacy installs do NOT break the receipt. */
  let lead = {}, enrol = {}, totals = {}, issuer = '';
  try {
    if (rc.lead_id) {
      const lr = await db.query(`SELECT id, name, phone, email, address, city, state, notes FROM leads WHERE id=$1`, [rc.lead_id]);
      lead = lr.rows[0] || {};
    }
  } catch(_) {}
  try {
    if (rc.enrollment_id) {
      const er = await db.query(`SELECT id, course_name, batch_name, total_amount, start_date, branch_id FROM edu_enrollments WHERE id=$1`, [rc.enrollment_id]);
      enrol = er.rows[0] || {};
      const tr = await db.query(`
        SELECT COALESCE(SUM(amount),0) AS billed,
               COALESCE(SUM(paid_amount),0) AS collected,
               COALESCE(SUM(amount - paid_amount),0) AS balance,
               COUNT(*) AS installments_total,
               COUNT(*) FILTER (WHERE status='paid') AS installments_paid
          FROM edu_installments WHERE enrollment_id=$1`, [rc.enrollment_id]);
      totals = tr.rows[0] || {};
    }
  } catch(_) {}
  try {
    if (rc.issued_by) {
      const ur = await db.query(`SELECT name FROM users WHERE id=$1`, [rc.issued_by]);
      issuer = (ur.rows[0] && ur.rows[0].name) || '';
    }
  } catch(_) {}

  /* Institute brand — pull config keys directly (edu.js has no admin.js dep). */
  const inst = { name:'Lead CRM', logo:'', address:'', phone:'', email:'', gst:'' };
  try {
    const [name, logo, addr, phone, email, gst] = await Promise.all([
      db.getConfig('COMPANY_NAME','').catch(()=> ''),
      db.getConfig('COMPANY_LOGO_URL','').catch(()=> ''),
      db.getConfig('COMPANY_ADDRESS','').catch(()=> ''),
      db.getConfig('COMPANY_PHONE','').catch(()=> ''),
      db.getConfig('COMPANY_EMAIL','').catch(()=> ''),
      db.getConfig('COMPANY_GST','').catch(()=> '')
    ]);
    inst.name    = name  || 'Lead CRM';
    inst.logo    = logo  || '';
    inst.address = addr  || '';
    inst.phone   = phone || '';
    inst.email   = email || '';
    inst.gst     = gst   || '';
  } catch (_) {}

  const dt = new Date(rc.issued_at || Date.now());
  const dtFmt = dt.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })
              + '  ' + dt.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  const amt = Number(rc.amount) || 0;
  const balance = Math.max(0, Number(totals.balance || 0));
  const collected = Number(totals.collected || 0);
  const billed = Number(totals.billed || enrol.total_amount || 0);
  const amtWords = _amountInWordsINR(amt);

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Receipt ${_esc(rc.receipt_no)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Inter,-apple-system,system-ui,'Segoe UI',sans-serif;max-width:800px;margin:0 auto;padding:0;color:#111827;background:#f3f4f6}
  .doc{background:#fff;margin:16px auto;box-shadow:0 6px 30px rgba(0,0,0,.08);border-radius:12px;overflow:hidden;position:relative}
  .head{display:flex;align-items:center;justify-content:space-between;padding:22px 28px;border-bottom:4px solid #7c3aed}
  .head-l{display:flex;align-items:center;gap:14px}
  .logo{width:70px;height:70px;object-fit:contain;border-radius:8px}
  .logo-fb{width:70px;height:70px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800}
  .inst-name{font-size:22px;font-weight:800;color:#111;line-height:1.15;margin:0}
  .inst-meta{font-size:11px;color:#6b7280;margin-top:4px;line-height:1.5}
  .head-r{text-align:right}
  .rc-title{display:inline-block;padding:5px 14px;background:#7c3aed;color:#fff;font-size:11px;font-weight:800;letter-spacing:2px;border-radius:4px}
  .rc-no{font-size:15px;font-weight:800;margin-top:8px}
  .rc-date{font-size:11px;color:#6b7280;margin-top:2px}
  .body{padding:24px 28px}
  .row{display:flex;gap:20px;margin-bottom:18px}
  .card{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;background:#fafafa}
  .lbl{font-size:10px;color:#6b7280;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:4px}
  .val{font-size:14px;color:#111;font-weight:600}
  .val-sm{font-size:12px;color:#374151;margin-top:3px}
  .sec-h{font-size:11px;color:#7c3aed;font-weight:800;letter-spacing:2px;text-transform:uppercase;border-bottom:1px solid #ede9fe;padding-bottom:6px;margin:16px 0 10px}
  table{width:100%;border-collapse:collapse}
  th{background:#f9fafb;text-align:left;padding:10px 12px;font-size:11px;color:#374151;font-weight:700;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid #e5e7eb}
  td{padding:12px;font-size:14px;color:#111;border-bottom:1px solid #f3f4f6}
  .right{text-align:right}
  .amt{font-weight:800;color:#7c3aed;font-size:16px}
  .grand{background:#faf5ff;border:2px solid #7c3aed;border-radius:10px;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;margin-top:14px}
  .grand-lbl{font-size:12px;font-weight:700;color:#6b21a8;text-transform:uppercase;letter-spacing:1px}
  .grand-val{font-size:26px;font-weight:800;color:#7c3aed}
  .words{margin-top:10px;padding:10px 14px;background:#fefce8;border-left:3px solid #eab308;border-radius:4px;font-size:12px;color:#713f12}
  .words b{font-weight:700}
  .sum{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:13px}
  .sum:last-child{border-bottom:0;font-weight:700;color:#111}
  .foot{padding:18px 28px;background:#fafafa;border-top:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:flex-end;font-size:11px;color:#6b7280}
  .sig{text-align:right}
  .sig-line{border-top:1px solid #9ca3af;width:180px;margin-bottom:4px;padding-top:24px}
  .stamp{display:inline-block;padding:6px 14px;border:2px dashed #16a34a;color:#16a34a;font-weight:800;letter-spacing:1.5px;border-radius:6px;font-size:11px;margin-bottom:6px}
  @media print{body{background:#fff}.doc{margin:0;box-shadow:none;border-radius:0}}
</style></head>
<body>
<div class="doc">
  <div class="head">
    <div class="head-l">
      ${inst.logo ? `<img class="logo" src="${_esc(inst.logo)}" alt="logo" onerror="this.outerHTML='<div class=logo-fb>${_esc((inst.name||'?').charAt(0).toUpperCase())}</div>'">` : `<div class="logo-fb">${_esc((inst.name||'?').charAt(0).toUpperCase())}</div>`}
      <div>
        <h1 class="inst-name">${_esc(inst.name)}</h1>
        <div class="inst-meta">
          ${inst.address ? _esc(inst.address) + '<br>' : ''}
          ${inst.phone ? '☎ ' + _esc(inst.phone) : ''}
          ${inst.phone && inst.email ? ' · ' : ''}
          ${inst.email ? '✉ ' + _esc(inst.email) : ''}
          ${inst.gst ? '<br>GSTIN: ' + _esc(inst.gst) : ''}
        </div>
      </div>
    </div>
    <div class="head-r">
      <div class="rc-title">FEE RECEIPT</div>
      <div class="rc-no">No. ${_esc(rc.receipt_no)}</div>
      <div class="rc-date">${_esc(dtFmt)}</div>
    </div>
  </div>

  <div class="body">
    <div class="row">
      <div class="card">
        <div class="lbl">Student</div>
        <div class="val">${_esc(rc.student_name || lead.name || '—')}</div>
        ${lead.phone ? `<div class="val-sm">📞 ${_esc(lead.phone)}</div>` : ''}
        ${lead.email ? `<div class="val-sm">✉ ${_esc(lead.email)}</div>` : ''}
        ${lead.city  ? `<div class="val-sm">📍 ${_esc([lead.city, lead.state].filter(Boolean).join(', '))}</div>` : ''}
      </div>
      <div class="card">
        <div class="lbl">Course / Enrollment</div>
        <div class="val">${_esc(rc.course || enrol.course_name || '—')}</div>
        ${enrol.batch_name ? `<div class="val-sm">Batch: ${_esc(enrol.batch_name)}</div>` : ''}
        ${enrol.start_date ? `<div class="val-sm">Started: ${_esc(new Date(enrol.start_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}))}</div>` : ''}
        ${enrol.id ? `<div class="val-sm">Enrol #: ${_esc(String(enrol.id))}</div>` : ''}
      </div>
    </div>

    <div class="sec-h">Payment Details</div>
    <table>
      <thead><tr>
        <th>Description</th><th>Payment Mode</th><th>Reference</th><th class="right">Amount</th>
      </tr></thead>
      <tbody><tr>
        <td>Fee payment${enrol.course_name ? ' — ' + _esc(enrol.course_name) : ''}${rc.notes ? '<br><small style="color:#6b7280">'+_esc(rc.notes)+'</small>' : ''}</td>
        <td>${_esc((rc.mode || 'CASH').toString().toUpperCase())}</td>
        <td>${_esc(rc.reference || '—')}</td>
        <td class="right amt">₹${amt.toLocaleString('en-IN',{minimumFractionDigits:2})}</td>
      </tr></tbody>
    </table>

    <div class="grand">
      <div>
        <div class="grand-lbl">Amount Received</div>
        <div style="font-size:11px;color:#6b21a8;margin-top:2px">${_esc(amtWords)}</div>
      </div>
      <div class="grand-val">₹${amt.toLocaleString('en-IN',{minimumFractionDigits:2})}</div>
    </div>

    ${(billed || collected || balance) ? `
    <div class="sec-h">Fee Summary</div>
    <div>
      ${billed ? `<div class="sum"><span>Total Course Fee</span><span>₹${Number(billed).toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>` : ''}
      ${collected ? `<div class="sum"><span>Paid to Date (incl. this receipt)</span><span>₹${Number(collected).toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>` : ''}
      ${totals.installments_total ? `<div class="sum"><span>Installments</span><span>${totals.installments_paid || 0} of ${totals.installments_total} paid</span></div>` : ''}
      ${balance > 0 ? `<div class="sum" style="color:#dc2626"><span>Balance Due</span><span>₹${balance.toLocaleString('en-IN',{minimumFractionDigits:2})}</span></div>` : (billed ? `<div class="sum" style="color:#16a34a"><span>Balance Due</span><span>Fully Paid ✓</span></div>` : '')}
    </div>` : ''}

    <div class="words"><b>In words:</b> ${_esc(amtWords)}</div>
  </div>

  <div class="foot">
    <div>
      <div class="stamp">✓ RECEIVED WITH THANKS</div>
      <div>This is a computer-generated receipt and does not require a physical signature.</div>
      <div style="margin-top:4px;color:#9ca3af">Received via ${_esc((rc.mode || 'CASH').toString().toUpperCase())}${rc.reference ? ' · Ref: ' + _esc(rc.reference) : ''}</div>
    </div>
    <div class="sig">
      <div class="sig-line"></div>
      <div style="font-weight:700;color:#111">${_esc(issuer || 'Authorised Signatory')}</div>
      <div style="color:#9ca3af">For ${_esc(inst.name)}</div>
    </div>
  </div>
</div>
</body></html>`;
  return { html, receipt_no: rc.receipt_no };
}

function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ---------- Dunning summary — aging receivables ---------- */
async function api_edu_dunning_summary(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const r = await db.query(`
    WITH overdue AS (
      SELECT i.id, i.due_date, e.lead_id,
             (i.amount + COALESCE(i.penalty_amount,0) - COALESCE(i.waiver_amount,0) - i.paid_amount) AS balance,
             (CURRENT_DATE - i.due_date) AS d
        FROM edu_installments i
        JOIN edu_enrollments e ON e.id = i.enrollment_id
       WHERE i.status IN ('due','partial')
         AND i.due_date < CURRENT_DATE
    )
    SELECT
      SUM(CASE WHEN d BETWEEN 1  AND 30  THEN balance ELSE 0 END)::numeric AS b_0_30,
      SUM(CASE WHEN d BETWEEN 31 AND 60  THEN balance ELSE 0 END)::numeric AS b_31_60,
      SUM(CASE WHEN d BETWEEN 61 AND 90  THEN balance ELSE 0 END)::numeric AS b_61_90,
      SUM(CASE WHEN d > 90               THEN balance ELSE 0 END)::numeric AS b_90p,
      COUNT(*)::int AS overdue_count,
      SUM(balance)::numeric AS total_overdue
    FROM overdue`);
  const row = r.rows[0] || {};
  return {
    aging: {
      '0-30':  Number(row.b_0_30) || 0,
      '31-60': Number(row.b_31_60) || 0,
      '61-90': Number(row.b_61_90) || 0,
      '90+':   Number(row.b_90p)   || 0
    },
    overdue_count: row.overdue_count || 0,
    total_overdue: Number(row.total_overdue) || 0
  };
}

/* ============================================================================
 * EDU_PACK_v2 Commit 3 — Reports + AI Insights + Demo Seed extension
 * ============================================================================ */

/* ---------- Admission funnel — how leads flow through the 14-stage pipeline ---------- */
async function api_edu_reports_admissionFunnel(token, opts) {
  await authUser(token);
  await _requireEducation();
  const o = opts || {};
  const args = [];
  let dw = '';
  if (o.from) { args.push(o.from); dw += ` AND l.created_at >= $${args.length}::date`; }
  if (o.to)   { args.push(o.to);   dw += ` AND l.created_at < ($${args.length}::date + INTERVAL '1 day')`; }
  const r = await db.query(
    `SELECT s.name AS stage, s.stage AS bucket, COUNT(l.id)::int AS count
       FROM statuses s
       LEFT JOIN leads l ON l.status_id = s.id ${dw}
      GROUP BY s.name, s.stage, s.sort_order
      ORDER BY COALESCE(s.sort_order, 0), s.id`,
    args
  );
  return { stages: r.rows };
}

/* ---------- Batch fill-rate ---------- */
async function api_edu_reports_batchFillRate(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2();
  const r = await db.query(`
    SELECT b.id, b.name, b.course, b.capacity, b.enrolled_ct, b.start_date, b.end_date, b.status,
           CASE WHEN b.capacity > 0 THEN ROUND((b.enrolled_ct::numeric / b.capacity::numeric) * 100, 1) ELSE 0 END AS fill_pct
      FROM edu_batches b
     ORDER BY fill_pct DESC, b.name ASC`);
  return { batches: r.rows };
}

/* ---------- Scholarship impact ---------- */
async function api_edu_reports_scholarshipImpact(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2();
  await _ensureSchemaV2Fees();
  const r = await db.query(`
    SELECT COALESCE(SUM(c.amount), 0)::numeric AS total_waived,
           COUNT(DISTINCT c.enrollment_id)::int AS enrollments_touched,
           COUNT(*)::int AS waiver_events
      FROM edu_fee_concessions c`);
  const byReason = await db.query(`
    SELECT c.reason, COUNT(*)::int AS n, COALESCE(SUM(c.amount),0)::numeric AS amount
      FROM edu_fee_concessions c
     GROUP BY c.reason
     ORDER BY amount DESC
     LIMIT 20`);
  return {
    total_waived:        Number(r.rows[0].total_waived) || 0,
    enrollments_touched: r.rows[0].enrollments_touched  || 0,
    waiver_events:       r.rows[0].waiver_events        || 0,
    by_reason:           byReason.rows
  };
}

/* ---------- Aging receivables (deeper than dunning_summary) ---------- */
async function api_edu_reports_agingReceivables(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2Fees();
  const r = await db.query(`
    SELECT e.id AS enrollment_id, e.lead_id, e.course_name, e.batch_name, l.name AS student_name, l.phone AS phone,
           SUM(i.amount + COALESCE(i.penalty_amount,0) - COALESCE(i.waiver_amount,0) - i.paid_amount)::numeric AS balance,
           MAX(CURRENT_DATE - i.due_date)::int AS max_days_overdue,
           COUNT(*)::int AS overdue_installments
      FROM edu_installments i
      JOIN edu_enrollments e ON e.id = i.enrollment_id
      LEFT JOIN leads l ON l.id = e.lead_id
     WHERE i.status IN ('due','partial') AND i.due_date < CURRENT_DATE
     GROUP BY e.id, e.lead_id, e.course_name, e.batch_name, l.name, l.phone
     HAVING SUM(i.amount + COALESCE(i.penalty_amount,0) - COALESCE(i.waiver_amount,0) - i.paid_amount) > 0
     ORDER BY balance DESC
     LIMIT 200`);
  return { rows: r.rows };
}

/* ---------- Admission drop-off — where prospects churn ---------- */
async function api_edu_reports_admissionDropOff(token, opts) {
  await authUser(token);
  await _requireEducation();
  const o = opts || {};
  const args = [];
  let dw = '';
  if (o.from) { args.push(o.from); dw += ` AND l.created_at >= $${args.length}::date`; }
  if (o.to)   { args.push(o.to);   dw += ` AND l.created_at < ($${args.length}::date + INTERVAL '1 day')`; }
  const funnel = await db.query(
    `SELECT s.name AS stage, s.sort_order, COUNT(l.id)::int AS count
       FROM statuses s LEFT JOIN leads l ON l.status_id = s.id ${dw}
      GROUP BY s.name, s.sort_order ORDER BY COALESCE(s.sort_order,0)`,
    args
  );
  const rows = funnel.rows;
  // Compute drop-off between adjacent stages
  const dropOff = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const from = rows[i], to = rows[i + 1];
    const dropped = Math.max(0, from.count - to.count);
    const rate = from.count > 0 ? Math.round((dropped / from.count) * 100) : 0;
    dropOff.push({
      from_stage: from.stage, to_stage: to.stage,
      from_count: from.count, to_count: to.count,
      dropped, drop_rate_pct: rate
    });
  }
  return { funnel: rows, drop_off: dropOff };
}

/* ---------- AI Insights (Gemini) ---------- */
async function api_edu_ai_insights(token) {
  await authUser(token);
  await _requireEducation();
  await _ensureSchemaV2();
  await _ensureSchemaV2Fees();

  // Gather signals
  const funnel = (await db.query(
    `SELECT s.name, COUNT(l.id)::int AS n FROM statuses s
       LEFT JOIN leads l ON l.status_id = s.id
      GROUP BY s.name, s.sort_order ORDER BY COALESCE(s.sort_order,0) LIMIT 20`)).rows;
  const batches = (await db.query(
    `SELECT name, capacity, enrolled_ct FROM edu_batches WHERE status='open' LIMIT 20`)).rows;
  const aging = (await db.query(`
    SELECT
      SUM(CASE WHEN (CURRENT_DATE - i.due_date) > 30 THEN (i.amount - i.paid_amount) ELSE 0 END)::numeric AS deep,
      SUM(CASE WHEN (CURRENT_DATE - i.due_date) BETWEEN 1 AND 30 THEN (i.amount - i.paid_amount) ELSE 0 END)::numeric AS recent,
      COUNT(*)::int AS overdue_n
     FROM edu_installments i WHERE i.status IN ('due','partial') AND i.due_date < CURRENT_DATE`)).rows[0] || {};
  const collected = (await db.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS n FROM edu_payments WHERE paid_at >= CURRENT_DATE - INTERVAL '30 days'`)).rows[0].n;

  // Try to use tenant's Gemini utility if present, else return rule-based narrative
  let narrative = null;
  try {
    const aiSum = require('../../utils/aiSummary');
    if (aiSum && typeof aiSum.gemini === 'function') {
      const prompt = `You are the head of admissions at a coaching institute. Based on the following data give 5 bullet-point actionable insights (mix wins + risks + specific next action). Be concise; each bullet <= 22 words.\n\nFunnel: ${JSON.stringify(funnel)}\nBatches (open): ${JSON.stringify(batches)}\nOverdue >30d: ₹${Number(aging.deep||0).toLocaleString('en-IN')} · 1-30d: ₹${Number(aging.recent||0).toLocaleString('en-IN')} · total overdue receipts: ${aging.overdue_n||0}\nCollected last 30d: ₹${Number(collected||0).toLocaleString('en-IN')}`;
      narrative = await aiSum.gemini(prompt);
    }
  } catch (_) { /* fall back below */ }

  if (!narrative) {
    // Rule-based fallback
    const bullets = [];
    const openBatch = batches.find(b => b.enrolled_ct < b.capacity * 0.5);
    if (openBatch) bullets.push(`▲ Batch "${openBatch.name}" is only ${Math.round((openBatch.enrolled_ct / (openBatch.capacity||1))*100)}% full — push counselors to fill before start.`);
    const bigDrop = funnel.length > 2 ? funnel.reduce((max, s, i, arr) => {
      if (i === 0) return max;
      const drop = (arr[i-1].n || 0) - (s.n || 0);
      return drop > max.drop ? { from: arr[i-1].name, to: s.name, drop } : max;
    }, { drop: 0 }) : null;
    if (bigDrop && bigDrop.drop > 0) bullets.push(`▼ Biggest drop-off: ${bigDrop.from} → ${bigDrop.to} (${bigDrop.drop} leads lost). Investigate scripts / TAT.`);
    if (Number(aging.deep) > 50000) bullets.push(`⚠ ₹${Number(aging.deep).toLocaleString('en-IN')} stuck >30 days overdue. Escalate to accounts team + consider late-fee waivers to unlock collection.`);
    if (Number(collected) > 0) bullets.push(`✓ Collected ₹${Number(collected).toLocaleString('en-IN')} in last 30 days — highlight top-performing counselor.`);
    bullets.push(`→ Send this week's dunning reminders via WhatsApp (check Fees → Reminders tab).`);
    narrative = bullets.join('\n');
  }

  return {
    generated_at: new Date().toISOString(),
    signals: { funnel, batches_open: batches.length, aging, collected_30d: Number(collected) || 0 },
    insights: narrative
  };
}

/* ---------- Extended Demo Seed — add fees + payments + receipts ---------- */
async function api_edu_v2_seedDemoFull(token) {
  const me = await authUser(token);
  await _requireEducation();
  await _ensureSchema();
  await _ensureSchemaV2();
  await _ensureSchemaV2Fees();

  // Run the base seed first (applications + batches)
  let base;
  try { base = await api_edu_v2_seedDemo(token); } catch(e) { base = { error: e.message }; }

  // Pick 10 recent applications-with-leads, create enrollments + fee plans + installments + partial payments
  const plans = (await db.query(`SELECT * FROM edu_fee_plans WHERE is_active=1 LIMIT 3`)).rows;
  if (!plans.length) {
    // Bootstrap a plan
    await db.query(
      `INSERT INTO edu_fee_plans (name, total_amount, mode, num_installments, interval_days, grace_days, late_fee_pct)
       VALUES ('Quarterly Demo (4 × 15k)', 60000, 'quarterly', 4, 90, 5, 2)`);
  }
  const planRows = (await db.query(`SELECT * FROM edu_fee_plans WHERE is_active=1 ORDER BY id ASC LIMIT 3`)).rows;

  const leads = (await db.query(
    `SELECT id, name FROM leads
      WHERE COALESCE(name,'') <> ''
      ORDER BY id DESC LIMIT 12`
  )).rows;

  let enrolCt = 0, payCt = 0, receiptCt = 0, waiverCt = 0, penCt = 0;
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const plan = planRows[i % planRows.length];
    // skip if already enrolled
    const ex = await db.query(`SELECT id FROM edu_enrollments WHERE lead_id=$1 LIMIT 1`, [lead.id]);
    if (ex.rows.length) continue;
    const startDate = new Date(Date.now() - (60 + i * 15) * 86400000).toISOString().slice(0, 10);
    const en = await db.query(
      `INSERT INTO edu_enrollments (lead_id, fee_plan_id, plan_snapshot, course_name, batch_name, total_amount, start_date, status, created_by)
       VALUES ($1,$2,$3,'Foundation Course','Morning Batch',$4,$5,'active',$6) RETURNING id`,
      [lead.id, plan.id, JSON.stringify(plan), Number(plan.total_amount), startDate, me.id]
    );
    const enrollmentId = en.rows[0].id;
    await _generateSchedule(enrollmentId, startDate, Number(plan.total_amount), plan);
    enrolCt++;

    // Pay off the first 1-2 installments
    const insts = (await db.query(
      `SELECT * FROM edu_installments WHERE enrollment_id=$1 ORDER BY seq ASC`, [enrollmentId]
    )).rows;
    const payN = Math.min(insts.length, 1 + (i % 2));
    for (let k = 0; k < payN; k++) {
      const inst = insts[k];
      await db.query(
        `UPDATE edu_installments SET paid_amount=$1, status='paid' WHERE id=$2`,
        [Number(inst.amount), inst.id]
      );
      const payIns = await db.query(
        `INSERT INTO edu_payments (installment_id, enrollment_id, amount, mode, receipt_no, note, recorded_by, paid_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [inst.id, enrollmentId, Number(inst.amount),
         ['upi','card','cash','neft','cheque'][k % 5],
         'DEMO-' + inst.id, 'Demo seeded payment', me.id,
         new Date(Date.now() - (30 + k * 7) * 86400000).toISOString()]
      );
      payCt++;
      // Auto-generate receipt for some
      if (k === 0) {
        const rno = await _genReceiptNumber();
        const rc = await db.query(
          `INSERT INTO edu_receipts (receipt_no, enrollment_id, lead_id, amount, mode, reference, student_name, course, payment_id, issued_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [rno, enrollmentId, lead.id, Number(inst.amount),
           ['upi','card','cash','neft','cheque'][k % 5], 'REF-' + payIns.rows[0].id,
           lead.name, 'Foundation Course', payIns.rows[0].id, me.id]
        );
        await db.query(`UPDATE edu_payments SET receipt_id=$1 WHERE id=$2`, [rc.rows[0].id, payIns.rows[0].id]);
        receiptCt++;
      }
    }

    // Apply a waiver to some enrollments
    if (i % 3 === 0 && insts[payN]) {
      const targetInst = insts[payN];
      const wamt = Math.round(Number(targetInst.amount) * 0.1);
      await db.query(
        `INSERT INTO edu_fee_concessions (enrollment_id, installment_id, reason, amount, approved_by, approved_at)
         VALUES ($1,$2,'Merit scholarship',$3,$4,NOW())`,
        [enrollmentId, targetInst.id, wamt, me.id]
      );
      await db.query(
        `UPDATE edu_installments SET waiver_amount=$1 WHERE id=$2`,
        [wamt, targetInst.id]
      );
      waiverCt++;
    }

    // Add a penalty to some overdue installments
    if (i % 4 === 0 && insts[payN]) {
      const targetInst = insts[payN];
      // Backdate its due_date to make it overdue
      await db.query(
        `UPDATE edu_installments SET due_date = CURRENT_DATE - INTERVAL '45 days' WHERE id=$1`,
        [targetInst.id]
      );
      await db.query(
        `INSERT INTO edu_fee_penalties (installment_id, enrollment_id, amount, days_overdue)
         VALUES ($1,$2,$3,$4)`,
        [targetInst.id, enrollmentId, 500, 45]
      );
      await db.query(
        `UPDATE edu_installments SET penalty_amount=500, late_fee=500 WHERE id=$1`,
        [targetInst.id]
      );
      penCt++;
    }

    // Schedule reminders for the next unpaid installment
    if (insts[payN]) {
      try {
        const nxt = insts[payN];
        for (const s of _REMINDER_STAGES) {
          const dueMs = nxt.due_date ? new Date(nxt.due_date).getTime() : Date.now();
          const dt = new Date(dueMs + s.offset_days * 86400000).toISOString().slice(0, 10);
          await db.query(
            `INSERT INTO edu_fee_reminders (installment_id, enrollment_id, lead_id, stage, scheduled_for, status)
             VALUES ($1,$2,$3,$4,$5,'scheduled')`,
            [nxt.id, enrollmentId, lead.id, s.stage, dt]
          ).catch(()=>{});
        }
      } catch(_) {}
    }
  }

  return {
    ok: true,
    base,
    enrollments_created: enrolCt,
    payments_recorded:   payCt,
    receipts_generated:  receiptCt,
    waivers_applied:     waiverCt,
    penalties_applied:   penCt
  };
}

module.exports = {
  /* EDU_PACK_v2 Commit 2 — Fee Tracking Deep + Dunning */
  api_edu_feeCats_list, api_edu_feeCats_save, api_edu_feeCats_delete,
  api_edu_concessions_list, api_edu_concessions_apply, api_edu_concessions_remove,
  api_edu_penalties_apply, api_edu_penalties_waive,
  api_edu_reminders_scheduleForInstallment,
  api_edu_reminders_dueList, api_edu_reminders_markSent, api_edu_reminders_skip,
  api_edu_receipts_generate, api_edu_receipts_list, api_edu_receipts_html, api_edu_receipts_update,
  api_edu_dunning_summary,
  /* EDU_PACK_v2 Commit 3 — Reports + AI + Demo Seed */
  api_edu_reports_admissionFunnel, api_edu_reports_batchFillRate,
  api_edu_reports_scholarshipImpact, api_edu_reports_agingReceivables,
  api_edu_reports_admissionDropOff,
  api_edu_ai_insights,
  api_edu_v2_seedDemoFull,
  _ensureSchemaV2Fees,

  install, uninstall,
  /* EDU_PACK_v2 — Enrollment + Scholarships + Batches (2026-06-27) */
  api_edu_v2_summary,
  api_edu_batches_list, api_edu_batches_save, api_edu_batches_delete,
  api_edu_scholarships_list, api_edu_scholarships_save, api_edu_scholarships_delete,
  api_edu_scholarships_applied, api_edu_scholarships_apply, api_edu_scholarships_unapply,
  api_edu_applications_list, api_edu_applications_get, api_edu_applications_create,
  api_edu_applications_saveStep, api_edu_applications_submit, api_edu_applications_delete,
  api_edu_appDocs_list, api_edu_appDocs_addCustom, api_edu_appDocs_upload,
  api_edu_appDocs_verify, api_edu_appDocs_reject,
  api_edu_enrollment_issueAdmissionLetter, api_edu_enrollment_letters,
  api_edu_enrollment_batchShift, api_edu_enrollment_withdraw, api_edu_enrollment_history,
  api_edu_v2_resetStages, api_edu_v2_seedDemo,

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
