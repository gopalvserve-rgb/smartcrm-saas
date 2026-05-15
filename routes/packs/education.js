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
    due_date DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    late_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'due',
    note TEXT NOT NULL DEFAULT '',
    reminded_15d INTEGER NOT NULL DEFAULT 0,
    reminded_7d  INTEGER NOT NULL DEFAULT 0,
    reminded_1d  INTEGER NOT NULL DEFAULT 0,
    reminded_due INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
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
    { id: 'edufees', label: '💰 Fee Collection', icon: '💰' }
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
  _ensureSchema
};
