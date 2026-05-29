/**
 * routes/packs/realestate.js — Real Estate industry pack
 *
 * Adds to a tenant DB (all idempotent, namespaced under re_*):
 *   - re_projects            — projects/towers (Sample Heights · Tower A …)
 *   - re_units               — individual units (status: available|blocked|booked|registered)
 *   - re_channel_partners    — broker / agency master with commission %
 *   - re_bookings            — buyer × unit allotment
 *   - re_demands             — 5 auto-generated demand letters per booking
 *   - re_payments            — money received against demands
 *   - re_commission_ledger   — partner commission payable, mark-paid flow
 *
 * Seed on install:
 *   - 1 sample project "Sample Heights" with 12 units (3 floors × 4 units)
 *   - 2 channel partners (Direct Sales 0%, SquareYards 2%)
 *   - 7 Real Estate statuses
 *   - 4 custom fields (preferred_bhk, budget_max, possession_timeline, source_broker)
 *
 * Public APIs (active only when pack installed):
 *   api_re_projects_list / _save
 *   api_re_units_byProject / _save / _bulkCreate
 *   api_re_booking_create / _byLead
 *   api_re_demand_markPaid
 *   api_re_channelPartners_list / _save
 *   api_re_summary  — inventory / demands / commission KPIs
 */
'use strict';

const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser } = require('../../utils/auth');

const PACK_ID = 'realestate';

// Demand-letter milestone defaults (% of total + offset days from booking).
const DEFAULT_MILESTONES = [
  { code: 'token',        label: 'Token',        pct: 1,  offset_days:  0 },
  { code: 'agreement',    label: 'Agreement',    pct: 9,  offset_days: 30 },
  { code: 'excavation',   label: 'Excavation',   pct: 30, offset_days: 90 },
  { code: 'slab',         label: 'Slab',         pct: 30, offset_days: 180 },
  { code: 'registration', label: 'Registration', pct: 30, offset_days: 365 }
];

// ─────────────────────────────────────────────────────────────────
// Schema (CREATE IF NOT EXISTS — safe to re-run)
// ─────────────────────────────────────────────────────────────────
async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS re_projects (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    tower_code TEXT NOT NULL DEFAULT '',
    total_floors INTEGER NOT NULL DEFAULT 0,
    units_per_floor INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_units (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    unit_no TEXT NOT NULL,
    floor INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT '',
    carpet_sqft NUMERIC(10,2) NOT NULL DEFAULT 0,
    price NUMERIC(14,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'available',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_units_project_idx ON re_units(project_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_channel_partners (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    commission_pct NUMERIC(5,2) NOT NULL DEFAULT 2.0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_bookings (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    unit_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    buyer_name TEXT NOT NULL DEFAULT '',
    total_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    booking_date DATE NOT NULL DEFAULT CURRENT_DATE,
    channel_partner_id INTEGER,
    commission_pct NUMERIC(5,2),
    status TEXT NOT NULL DEFAULT 'booked',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_bookings_lead_idx ON re_bookings(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_demands (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    code TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    due_date DATE,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    paid_at TIMESTAMPTZ
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_demands_booking_idx ON re_demands(booking_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_payments (
    id SERIAL PRIMARY KEY,
    demand_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    method TEXT NOT NULL DEFAULT 'manual',
    reference TEXT NOT NULL DEFAULT '',
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_by INTEGER
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_commission_ledger (
    id SERIAL PRIMARY KEY,
    booking_id INTEGER NOT NULL,
    partner_id INTEGER NOT NULL,
    amount_due NUMERIC(14,2) NOT NULL DEFAULT 0,
    amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ
  )`);

  /* RE_PAYMENT_PLANS_v1 — tenant-configurable payment plans.
   * milestones_json holds an array of { code, label, offset_days, pct }
   * — same shape as DEFAULT_MILESTONES. project_id is optional: NULL =
   * the plan can be used for any project. */
  await db.query(`CREATE TABLE IF NOT EXISTS re_payment_plans (
    id SERIAL PRIMARY KEY,
    project_id INTEGER,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    milestones_json TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_payment_plans_project_idx ON re_payment_plans(project_id)`);

  /* Add payment_plan_id to existing bookings so we can recall which plan
   * was used to generate the demand schedule. */
  await db.query(`ALTER TABLE re_bookings ADD COLUMN IF NOT EXISTS payment_plan_id INTEGER`);
}

// ─────────────────────────────────────────────────────────────────
// APIs — gated by isPackActive('realestate')
// ─────────────────────────────────────────────────────────────────
async function _requireRealEstate() {
  if (!(await framework.isPackActive(PACK_ID))) {
    throw new Error('Real Estate pack is not active for this workspace');
  }
}

async function api_re_projects_list(token) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM re_projects ORDER BY is_active DESC, id DESC`);
  return r.rows;
}

async function api_re_projects_save(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('Project name required');
  if (p.id) {
    await db.query(
      `UPDATE re_projects SET name=$1, location=$2, tower_code=$3, total_floors=$4, units_per_floor=$5, is_active=$6 WHERE id=$7`,
      [p.name, p.location || '', p.tower_code || '',
       Number(p.total_floors || 0), Number(p.units_per_floor || 0),
       p.is_active == null ? 1 : Number(!!p.is_active), p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO re_projects (name, location, tower_code, total_floors, units_per_floor)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.name, p.location || '', p.tower_code || '',
     Number(p.total_floors || 0), Number(p.units_per_floor || 0)]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_re_units_byProject(token, projectId) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!projectId) throw new Error('projectId required');
  const r = await db.query(
    `SELECT * FROM re_units WHERE project_id=$1 ORDER BY floor, unit_no`,
    [Number(projectId)]
  );
  return r.rows;
}

async function api_re_units_save(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.unit_no || !p.project_id) throw new Error('unit_no + project_id required');
  if (p.id) {
    await db.query(
      `UPDATE re_units SET unit_no=$1, floor=$2, type=$3, carpet_sqft=$4, price=$5, status=$6 WHERE id=$7`,
      [p.unit_no, Number(p.floor || 0), p.type || '', Number(p.carpet_sqft || 0),
       Number(p.price || 0), p.status || 'available', p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [Number(p.project_id), p.unit_no, Number(p.floor || 0), p.type || '',
     Number(p.carpet_sqft || 0), Number(p.price || 0), p.status || 'available']
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_re_units_bulkCreate(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.project_id) throw new Error('project_id required');
  const floors = Number(p.floors || 0);
  const perFloor = Number(p.units_per_floor || 0);
  if (!floors || !perFloor) throw new Error('floors and units_per_floor required');
  const type = p.type || '2BHK';
  const price = Number(p.price || 0);
  const carpet = Number(p.carpet_sqft || 0);
  const towerCode = p.tower_code || 'A';
  let n = 0;
  for (let f = 1; f <= floors; f++) {
    for (let u = 1; u <= perFloor; u++) {
      const unitNo = `${towerCode}-${f}${String(u).padStart(2, '0')}`;
      await db.query(
        `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price) VALUES ($1,$2,$3,$4,$5,$6)`,
        [Number(p.project_id), unitNo, f, type, carpet, price]
      );
      n++;
    }
  }
  return { ok: true, created: n };
}

async function api_re_booking_create(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.unit_id) throw new Error('unit_id required');

  const uR = await db.query(`SELECT * FROM re_units WHERE id=$1`, [Number(p.unit_id)]);
  const unit = uR.rows && uR.rows[0];
  if (!unit) throw new Error('Unit not found');
  if (unit.status === 'booked' || unit.status === 'registered') {
    throw new Error(`Unit ${unit.unit_no} is already ${unit.status}`);
  }

  const total = Number(p.total_price || unit.price || 0);
  const bookingDate = p.booking_date || new Date().toISOString().slice(0, 10);

  let cpId = p.channel_partner_id || null;
  let cpPct = p.commission_pct;
  if (cpId && cpPct == null) {
    const cpR = await db.query(`SELECT commission_pct FROM re_channel_partners WHERE id=$1`, [Number(cpId)]);
    cpPct = cpR.rows[0] ? cpR.rows[0].commission_pct : null;
  }

  const bR = await db.query(
    `INSERT INTO re_bookings (lead_id, unit_id, project_id, buyer_name, total_price, booking_date, channel_partner_id, commission_pct, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'booked') RETURNING id`,
    [Number(p.lead_id), Number(p.unit_id), unit.project_id, p.buyer_name || '',
     total, bookingDate, cpId, cpPct || null]
  );
  const bookingId = bR.rows[0].id;

  await db.query(`UPDATE re_units SET status='booked' WHERE id=$1`, [Number(p.unit_id)]);

  /* RE_PAYMENT_PLANS_v1 — pick milestones from the chosen payment plan.
   * Resolution order:
   *   1. p.payment_plan_id explicitly passed by the caller
   *   2. The project's default plan (is_default = 1)
   *   3. DEFAULT_MILESTONES constant (back-compat)
   * If the plan exists but milestones_json is empty/invalid, fall back. */
  let milestones = DEFAULT_MILESTONES;
  let usedPlanId = null;
  try {
    let planRow = null;
    if (p.payment_plan_id) {
      const r = await db.query(`SELECT * FROM re_payment_plans WHERE id=$1`, [Number(p.payment_plan_id)]);
      planRow = r.rows[0] || null;
    }
    if (!planRow) {
      const r = await db.query(
        `SELECT * FROM re_payment_plans
          WHERE is_active=1 AND is_default=1 AND (project_id IS NULL OR project_id=$1)
          ORDER BY (project_id IS NULL) ASC LIMIT 1`,
        [Number(unit.project_id)]
      );
      planRow = r.rows[0] || null;
    }
    if (planRow) {
      let parsed = [];
      try { parsed = JSON.parse(planRow.milestones_json || '[]'); } catch (_) {}
      if (Array.isArray(parsed) && parsed.length) {
        milestones = parsed;
        usedPlanId = planRow.id;
      }
    }
  } catch (_) {}

  const start = new Date(bookingDate);
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    const due = new Date(start.getTime());
    due.setDate(due.getDate() + (Number(m.offset_days) || 0));
    const amt = Math.round(total * (Number(m.pct) / 100) * 100) / 100;
    await db.query(
      `INSERT INTO re_demands (booking_id, seq, code, label, due_date, amount)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bookingId, i + 1, String(m.code || ('m' + (i+1))).slice(0, 60),
       String(m.label || ('Milestone ' + (i+1))).slice(0, 200),
       due.toISOString().slice(0, 10), amt]
    );
  }

  // Persist which plan was actually used for this booking.
  if (usedPlanId) {
    try { await db.query(`UPDATE re_bookings SET payment_plan_id=$1 WHERE id=$2`, [usedPlanId, bookingId]); } catch (_) {}
  }

  if (cpId && cpPct) {
    const commissionAmt = Math.round(total * (Number(cpPct) / 100) * 100) / 100;
    await db.query(
      `INSERT INTO re_commission_ledger (booking_id, partner_id, amount_due) VALUES ($1,$2,$3)`,
      [bookingId, Number(cpId), commissionAmt]
    );
  }

  /* LEAD_ACTIVITY_v1 — count booking creation as a lead activity */
  try {
    const _me = await authUser(token);
    require('../tat').logAction(Number(p.lead_id), 're_booking_created', _me.id, { booking_id: bookingId, unit_id: Number(p.unit_id), total_price: total, channel_partner_id: cpId || null });
  } catch (_) {}
  return { ok: true, booking_id: bookingId, payment_plan_id: usedPlanId, demands: milestones.length };
}

async function api_re_booking_byLead(token, leadId) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!leadId) throw new Error('leadId required');

  const bR = await db.query(`
    SELECT b.*, u.unit_no, u.floor, u.type AS unit_type, u.carpet_sqft,
           pr.name AS project_name, pr.tower_code,
           cp.name AS partner_name
      FROM re_bookings b
      LEFT JOIN re_units u ON u.id = b.unit_id
      LEFT JOIN re_projects pr ON pr.id = b.project_id
      LEFT JOIN re_channel_partners cp ON cp.id = b.channel_partner_id
     WHERE b.lead_id=$1
     ORDER BY b.id DESC
  `, [Number(leadId)]);
  const bookings = bR.rows || [];
  if (!bookings.length) return { bookings: [], demands: [] };

  const ids = bookings.map(b => b.id);
  const dR = await db.query(
    `SELECT * FROM re_demands WHERE booking_id = ANY($1::int[]) ORDER BY booking_id, seq`,
    [ids]
  );
  return { bookings, demands: dR.rows || [] };
}

async function api_re_demand_markPaid(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.id) throw new Error('id required');

  const cur = await db.query(`SELECT * FROM re_demands WHERE id=$1`, [Number(p.id)]);
  const dem = cur.rows && cur.rows[0];
  if (!dem) throw new Error('Demand not found');

  const amt = Number(p.amount || dem.amount);
  const newPaid = Math.round((Number(dem.paid_amount || 0) + amt) * 100) / 100;
  const status = newPaid >= Number(dem.amount) - 0.005 ? 'paid' : 'partial';

  await db.query(
    `UPDATE re_demands SET paid_amount=$1, status=$2,
        paid_at = CASE WHEN $2='paid' THEN NOW() ELSE paid_at END
      WHERE id=$3`,
    [newPaid, status, Number(p.id)]
  );

  await db.query(
    `INSERT INTO re_payments (demand_id, booking_id, amount, method, reference) VALUES ($1,$2,$3,$4,$5)`,
    [Number(p.id), dem.booking_id, amt, p.method || 'manual', p.reference || '']
  );

  if (status === 'paid' && dem.code === 'registration') {
    const bR = await db.query(`SELECT unit_id FROM re_bookings WHERE id=$1`, [dem.booking_id]);
    const unitId = bR.rows[0] && bR.rows[0].unit_id;
    if (unitId) {
      await db.query(`UPDATE re_units SET status='registered' WHERE id=$1`, [unitId]);
      await db.query(`UPDATE re_bookings SET status='registered' WHERE id=$1`, [dem.booking_id]);
    }
  }

  /* LEAD_ACTIVITY_v1 — count demand payment as a lead activity */
  try {
    const _me = await authUser(token);
    const lr = await db.query('SELECT lead_id FROM re_bookings WHERE id = $1', [dem.booking_id]);
    const leadId = lr.rows[0] && lr.rows[0].lead_id;
    if (leadId) require('../tat').logAction(leadId, 're_demand_paid', _me.id, { demand_id: Number(p.id), amount: amt, status, code: dem.code });
  } catch (_) {}

  return { ok: true, status, paid_amount: newPaid };
}

async function api_re_channelPartners_list(token) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM re_channel_partners ORDER BY name`);
  return r.rows;
}

async function api_re_channelPartners_save(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  if (p.id) {
    await db.query(
      `UPDATE re_channel_partners SET name=$1, contact=$2, phone=$3, email=$4, commission_pct=$5, is_active=$6 WHERE id=$7`,
      [p.name, p.contact || '', p.phone || '', p.email || '',
       Number(p.commission_pct || 0), p.is_active == null ? 1 : Number(!!p.is_active), p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO re_channel_partners (name, contact, phone, email, commission_pct) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.name, p.contact || '', p.phone || '', p.email || '', Number(p.commission_pct || 0)]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_re_summary(token) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();

  const r1 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='available')::int  AS available,
      COUNT(*) FILTER (WHERE status='blocked')::int    AS blocked,
      COUNT(*) FILTER (WHERE status='booked')::int     AS booked,
      COUNT(*) FILTER (WHERE status='registered')::int AS registered,
      COUNT(*)::int                                    AS total
    FROM re_units
  `);

  const r2 = await db.query(`
    SELECT
      COALESCE(SUM(amount),0)::numeric      AS billed,
      COALESCE(SUM(paid_amount),0)::numeric AS collected,
      COALESCE(SUM(CASE WHEN status<>'paid' THEN amount - paid_amount ELSE 0 END),0)::numeric AS outstanding,
      COALESCE(SUM(CASE WHEN status<>'paid' AND due_date < CURRENT_DATE THEN amount - paid_amount ELSE 0 END),0)::numeric AS overdue
    FROM re_demands
  `);

  const r3 = await db.query(`
    SELECT
      COALESCE(SUM(amount_due),0)::numeric  AS commission_due,
      COALESCE(SUM(amount_paid),0)::numeric AS commission_paid
    FROM re_commission_ledger
  `);

  return {
    inventory:  r1.rows[0] || {},
    demands:    r2.rows[0] || {},
    commission: r3.rows[0] || {}
  };
}


// ═════════════════════════════════════════════════════════════════
// Phase 2 — PDF demands, manual reminders, commission payable, cancel booking
// ═════════════════════════════════════════════════════════════════

/**
 * api_re_demand_renderHtml — returns a printable HTML demand letter.
 * The SPA opens this in a new window so the user can "Print → Save as PDF".
 * This avoids a server-side PDF dependency (puppeteer / pdfkit) — keeps the
 * pack lightweight and Railway-friendly.
 */
async function api_re_demand_renderHtml(token, demandId) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!demandId) throw new Error('demandId required');

  const dR = await db.query(`
    SELECT d.*, b.lead_id, b.buyer_name, b.total_price, b.booking_date,
           u.unit_no, u.floor, u.type AS unit_type, u.carpet_sqft, u.price AS unit_price,
           pr.name AS project_name, pr.location AS project_location, pr.tower_code
      FROM re_demands d
      LEFT JOIN re_bookings b ON b.id = d.booking_id
      LEFT JOIN re_units u    ON u.id = b.unit_id
      LEFT JOIN re_projects pr ON pr.id = b.project_id
     WHERE d.id = $1
  `, [Number(demandId)]);
  const row = dR.rows && dR.rows[0];
  if (!row) throw new Error('Demand not found');

  // Pull tenant company info if available (best-effort).
  let companyName = 'Your Company', companyAddress = '', companyPhone = '', companyEmail = '';
  try {
    const c = await db.query(`SELECT key, value FROM config WHERE key = ANY($1::text[])`,
      [['company_name','company_address','company_phone','company_email']]);
    const m = {};
    (c.rows || []).forEach(r => { m[r.key] = r.value; });
    companyName    = m.company_name    || companyName;
    companyAddress = m.company_address || '';
    companyPhone   = m.company_phone   || '';
    companyEmail   = m.company_email   || '';
  } catch (_) {}

  // Lead contact (buyer) — fall back to buyer_name on the booking
  let buyerEmail = '', buyerPhone = '';
  if (row.lead_id) {
    try {
      const l = await db.query(`SELECT name, email, phone FROM leads WHERE id=$1`, [row.lead_id]);
      const lead = l.rows && l.rows[0];
      if (lead) {
        buyerEmail = lead.email || '';
        buyerPhone = lead.phone || '';
      }
    } catch (_) {}
  }

  const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN');
  const dueDate = row.due_date ? String(row.due_date).slice(0,10) : '—';
  const balance = Number(row.amount) - Number(row.paid_amount || 0);

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Demand Letter — ${row.label || row.code} · ${row.unit_no || ''}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 760px; margin: 24px auto; padding: 24px; color: #111; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0ea5e9; padding-bottom: 16px; margin-bottom: 24px; }
  .head h1 { margin: 0 0 4px 0; font-size: 20px; }
  .head .muted { color: #555; font-size: 12px; }
  h2 { color: #0c4a6e; font-size: 16px; margin: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
  td.l { color: #555; padding: 6px 12px 6px 0; vertical-align: top; width: 40%; }
  td.v { font-weight: 600; padding: 6px 0; }
  .total { background: #f0f9ff; border-left: 4px solid #0ea5e9; padding: 12px 16px; margin: 16px 0; }
  .total .amt { font-size: 24px; font-weight: 700; color: #0c4a6e; }
  .footer { margin-top: 40px; font-size: 12px; color: #555; border-top: 1px solid #ddd; padding-top: 16px; }
  .stamp { margin-top: 32px; font-size: 12px; color: #999; }
  @media print { body { margin: 0; } .noprint { display: none; } }
  .noprint { position: fixed; top: 12px; right: 12px; background: #0ea5e9; color: white; padding: 8px 16px; border-radius: 6px; cursor: pointer; border: 0; font-weight: 600; }
</style>
</head><body>
<button class="noprint" onclick="window.print()">🖨️ Print / Save as PDF</button>

<div class="head">
  <div>
    <h1>${companyName}</h1>
    <div class="muted">${companyAddress || ''}</div>
    <div class="muted">${companyPhone ? '📞 ' + companyPhone : ''}${companyEmail ? '  ·  ' + companyEmail : ''}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:20px;font-weight:700;color:#0ea5e9">DEMAND LETTER</div>
    <div class="muted">Ref #RE-${row.booking_id}-${String(row.seq).padStart(2,'0')}</div>
    <div class="muted">Date: ${new Date().toISOString().slice(0,10)}</div>
  </div>
</div>

<h2>Buyer details</h2>
<table>
  <tr><td class="l">Name</td><td class="v">${row.buyer_name || (row.lead_id ? 'Lead #' + row.lead_id : '—')}</td></tr>
  ${buyerPhone ? `<tr><td class="l">Phone</td><td class="v">${buyerPhone}</td></tr>` : ''}
  ${buyerEmail ? `<tr><td class="l">Email</td><td class="v">${buyerEmail}</td></tr>` : ''}
</table>

<h2>Unit details</h2>
<table>
  <tr><td class="l">Project</td><td class="v">${row.project_name || ''}${row.tower_code ? ' · Tower ' + row.tower_code : ''}</td></tr>
  <tr><td class="l">Unit</td><td class="v">${row.unit_no || ''}${row.unit_type ? ' · ' + row.unit_type : ''}${row.carpet_sqft ? ' · ' + row.carpet_sqft + ' sqft' : ''}</td></tr>
  <tr><td class="l">Total agreement value</td><td class="v">${inr(row.total_price)}</td></tr>
  <tr><td class="l">Booking date</td><td class="v">${row.booking_date ? String(row.booking_date).slice(0,10) : '—'}</td></tr>
</table>

<h2>This demand</h2>
<table>
  <tr><td class="l">Milestone</td><td class="v">${row.label || row.code} (#${row.seq})</td></tr>
  <tr><td class="l">Demand amount</td><td class="v">${inr(row.amount)}</td></tr>
  <tr><td class="l">Already paid</td><td class="v">${inr(row.paid_amount)}</td></tr>
  <tr><td class="l">Due date</td><td class="v">${dueDate}</td></tr>
</table>

<div class="total">
  <div style="font-size:12px;color:#555">Balance payable</div>
  <div class="amt">${inr(balance)}</div>
</div>

<div class="footer">
  <p>Kindly remit the above amount on or before the due date. Please mention the reference number above on the payment instrument.</p>
  <p>For any clarification, contact us at ${companyPhone || companyEmail || 'the address above'}.</p>
</div>

<div class="stamp">
  Generated by ${companyName} CRM · ${new Date().toISOString().slice(0,16).replace('T',' ')} UTC
</div>
</body></html>`;

  return { html, demand: row };
}

/**
 * api_re_demand_sendReminder — manual "Send reminder now" for a demand letter.
 * Tries WhatsApp first via whatsbot._sendFreeform, falls back to email via utils/mailer.
 * Always best-effort; surfaces a structured result so the SPA can toast.
 */
async function api_re_demand_sendReminder(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.id) throw new Error('id required');

  const dR = await db.query(`
    SELECT d.*, b.lead_id, b.buyer_name, b.total_price,
           u.unit_no, pr.name AS project_name
      FROM re_demands d
      LEFT JOIN re_bookings b ON b.id = d.booking_id
      LEFT JOIN re_units u    ON u.id = b.unit_id
      LEFT JOIN re_projects pr ON pr.id = b.project_id
     WHERE d.id = $1
  `, [Number(p.id)]);
  const row = dR.rows && dR.rows[0];
  if (!row) throw new Error('Demand not found');
  if (!row.lead_id) throw new Error('No lead linked to this booking');

  const lead = await db.findById('leads', row.lead_id);
  if (!lead) throw new Error('Lead not found');

  const balance = Number(row.amount) - Number(row.paid_amount || 0);
  const due = row.due_date ? String(row.due_date).slice(0, 10) : '—';
  const msg = `Hi ${row.buyer_name || lead.name || ''}! This is a reminder for the "${row.label || row.code}" demand of ₹${Number(balance).toLocaleString('en-IN')} for unit ${row.unit_no || ''} (${row.project_name || ''}). Due date: ${due}. Kindly process the payment. Reply here if you have any questions.`;

  const result = { wa: null, email: null };

  // 1) WhatsApp (best-effort)
  try {
    const whatsbot = require('../whatsbot');
    const phone = (lead.whatsapp || lead.phone || '').replace(/\D/g, '');
    if (whatsbot && typeof whatsbot._sendFreeform === 'function' && phone) {
      await whatsbot._sendFreeform(phone, msg);
      result.wa = { ok: true, phone };
    } else {
      result.wa = { ok: false, reason: 'no phone or whatsbot unavailable' };
    }
  } catch (e) {
    result.wa = { ok: false, reason: e.message };
  }

  // 2) Email (best-effort)
  try {
    const mailer = require('../../utils/mailer');
    if (mailer && typeof mailer._sendRaw === 'function' && lead.email) {
      await mailer._sendRaw({
        to: lead.email,
        subject: `Demand letter reminder — ${row.label || row.code} · ${row.unit_no || ''}`,
        text: msg
      });
      result.email = { ok: true, to: lead.email };
    } else {
      result.email = { ok: false, reason: 'no email or mailer unavailable' };
    }
  } catch (e) {
    result.email = { ok: false, reason: e.message };
  }

  return result;
}

/**
 * api_re_booking_cancel — cancel a booking (admin/manager only).
 * Frees the unit back to 'available', marks booking 'cancelled', reverses
 * commission accrual on re_commission_ledger (if commission not yet paid).
 * Demands are left in place for audit but flagged 'cancelled' status.
 */
async function api_re_booking_cancel(token, payload) {
  const me = await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or manager role required to cancel bookings');

  const p = payload || {};
  if (!p.id) throw new Error('booking id required');

  const bR = await db.query(`SELECT * FROM re_bookings WHERE id=$1`, [Number(p.id)]);
  const booking = bR.rows && bR.rows[0];
  if (!booking) throw new Error('Booking not found');
  if (booking.status === 'cancelled') throw new Error('Booking already cancelled');
  if (booking.status === 'registered') throw new Error('Cannot cancel a registered booking — refund flow required');

  // Free unit back to available
  await db.query(`UPDATE re_units SET status='available' WHERE id=$1`, [booking.unit_id]);
  // Mark booking cancelled
  await db.query(`UPDATE re_bookings SET status='cancelled' WHERE id=$1`, [booking.id]);
  // Flag pending demands as cancelled (paid demands stay paid for audit)
  await db.query(`UPDATE re_demands SET status='cancelled' WHERE booking_id=$1 AND status NOT IN ('paid','partial')`, [booking.id]);

  // Reverse unpaid commission accrual
  let reversedCommission = 0;
  try {
    const cR = await db.query(`SELECT id, amount_due, amount_paid FROM re_commission_ledger WHERE booking_id=$1 AND status<>'paid'`, [booking.id]);
    for (const row of (cR.rows || [])) {
      const remaining = Number(row.amount_due) - Number(row.amount_paid || 0);
      reversedCommission += remaining;
      await db.query(`UPDATE re_commission_ledger SET status='cancelled' WHERE id=$1`, [row.id]);
    }
  } catch (_) {}
  /* LEAD_ACTIVITY_v1 — count booking cancellation as a lead activity */
  try {
    const _me = await authUser(token);
    const lr = await db.query('SELECT lead_id FROM re_bookings WHERE id = $1', [Number(payload && payload.id)]);
    const _leadId = lr.rows[0] && lr.rows[0].lead_id;
    if (_leadId) require('../tat').logAction(_leadId, 're_booking_cancelled', _me.id, { booking_id: Number(payload.id) });
  } catch (_) {}


  return {
    ok: true,
    unit_freed: booking.unit_id,
    booking_id: booking.id,
    commission_reversed: reversedCommission,
    reason: p.reason || ''
  };
}

/**
 * api_re_commission_list — channel partner payable view.
 * Returns ledger rows grouped by partner with totals for the payable view.
 */
async function api_re_commission_list(token) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const r = await db.query(`
    SELECT l.id, l.booking_id, l.amount_due, l.amount_paid, l.status, l.created_at, l.paid_at,
           cp.id AS partner_id, cp.name AS partner_name, cp.phone AS partner_phone, cp.email AS partner_email,
           b.buyer_name, b.total_price, b.booking_date,
           u.unit_no, pr.name AS project_name
      FROM re_commission_ledger l
      LEFT JOIN re_channel_partners cp ON cp.id = l.partner_id
      LEFT JOIN re_bookings b ON b.id = l.booking_id
      LEFT JOIN re_units u    ON u.id = b.unit_id
      LEFT JOIN re_projects pr ON pr.id = b.project_id
     ORDER BY l.status ASC, l.created_at DESC
  `);
  const rows = r.rows || [];

  // Group by partner for the summary header
  const byPartner = {};
  for (const row of rows) {
    const pid = row.partner_id || 0;
    if (!byPartner[pid]) byPartner[pid] = {
      partner_id: pid, partner_name: row.partner_name || 'Unknown',
      partner_phone: row.partner_phone || '', partner_email: row.partner_email || '',
      total_due: 0, total_paid: 0, pending_rows: 0, paid_rows: 0
    };
    if (row.status !== 'cancelled') {
      byPartner[pid].total_due  += Number(row.amount_due  || 0);
      byPartner[pid].total_paid += Number(row.amount_paid || 0);
      if (row.status === 'paid') byPartner[pid].paid_rows++;
      else byPartner[pid].pending_rows++;
    }
  }
  return {
    rows,
    by_partner: Object.values(byPartner)
  };
}

/**
 * api_re_commission_markPaid — record a commission payout to a partner.
 */
async function api_re_commission_markPaid(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const p = payload || {};
  if (!p.id) throw new Error('id required');

  const cur = await db.query(`SELECT * FROM re_commission_ledger WHERE id=$1`, [Number(p.id)]);
  const row = cur.rows && cur.rows[0];
  if (!row) throw new Error('Commission ledger entry not found');
  if (row.status === 'cancelled') throw new Error('This commission entry is cancelled — cannot mark paid');

  const amt = Number(p.amount || row.amount_due);
  const newPaid = Math.round((Number(row.amount_paid || 0) + amt) * 100) / 100;
  const status = newPaid >= Number(row.amount_due) - 0.005 ? 'paid' : 'partial';

  await db.query(
    `UPDATE re_commission_ledger
        SET amount_paid=$1, status=$2,
            paid_at = CASE WHEN $2='paid' THEN NOW() ELSE paid_at END
      WHERE id=$3`,
    [newPaid, status, Number(p.id)]
  );

  return { ok: true, status, amount_paid: newPaid };
}

// ─────────────────────────────────────────────────────────────────
// Installer — schema + seed
// ─────────────────────────────────────────────────────────────────
async function install(opts) {
  await _ensureSchema();

  // Sample project + 12 units (3 floors × 4 units, Tower A)
  const existing = await db.query(`SELECT 1 FROM re_projects LIMIT 1`);
  if (!existing.rows.length) {
    const p = await db.query(
      `INSERT INTO re_projects (name, location, tower_code, total_floors, units_per_floor)
       VALUES ('Sample Heights', 'Sector 1', 'A', 3, 4) RETURNING id`
    );
    const pid = p.rows[0].id;
    for (let f = 1; f <= 3; f++) {
      for (let u = 1; u <= 4; u++) {
        const unitNo = `A-${f}0${u}`;
        const type   = u <= 2 ? '2BHK' : '3BHK';
        const carpet = u <= 2 ? 850 : 1150;
        const price  = u <= 2 ? 5500000 : 7500000;
        await db.query(
          `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price) VALUES ($1,$2,$3,$4,$5,$6)`,
          [pid, unitNo, f, type, carpet, price]
        );
      }
    }
  }

  // Channel partners
  const cpExisting = await db.query(`SELECT 1 FROM re_channel_partners LIMIT 1`);
  if (!cpExisting.rows.length) {
    await db.query(
      `INSERT INTO re_channel_partners (name, commission_pct) VALUES ('Direct Sales', 0), ('SquareYards', 2.0)`
    );
  }

  // Custom fields (additive — skip if statuses/custom_fields tables don't exist)
  try {
    const cfT = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name='custom_fields' LIMIT 1`);
    if (cfT.rows.length) {
      for (const key of ['preferred_bhk','budget_max','possession_timeline','source_broker']) {
        const have = await db.query(`SELECT 1 FROM custom_fields WHERE LOWER(name)=LOWER($1) LIMIT 1`, [key]);
        if (!have.rows.length) {
          const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          await db.query(
            `INSERT INTO custom_fields (name, label, type, is_active) VALUES ($1,$2,'text',1)`,
            [key, label]
          );
        }
      }
    }
  } catch (e) {
    console.warn('[packs/realestate] custom_fields seed skipped:', e.message);
  }

  // RE_STAGE_RENAME_v1 (2026-05-29) — rename the three generic statuses
  // ('Negotiation' / 'Proposal / Payment Link Sent' / 'Won') to the
  // Real-Estate-specific labels the admin requested. Runs FIRST so the
  // 12-stage seed below doesn't double-up. UPDATE … WHERE LOWER(name) =
  // matches the exact legacy label only; if a tenant already renamed
  // their status, this is a no-op. Idempotent — safe to re-run on
  // every install.
  try {
    const RENAMES = [
      { from: 'Negotiation',                  to: 'Site Visit Schedule', color: '#ec4899' },
      { from: 'Proposal / Payment Link Sent', to: 'Site Visit done',     color: '#0ea5e9' },
      { from: 'Proposal/Payment Link Sent',   to: 'Site Visit done',     color: '#0ea5e9' },
      { from: 'Proposal Sent',                to: 'Site Visit done',     color: '#0ea5e9' },
      { from: 'Won',                          to: 'Token Received',      color: '#16a34a' }
    ];
    for (const r of RENAMES) {
      try {
        await db.query(
          `UPDATE statuses SET name = $1, color = COALESCE($2, color)
            WHERE LOWER(name) = LOWER($3)
              AND NOT EXISTS (SELECT 1 FROM statuses WHERE LOWER(name) = LOWER($1))`,
          [r.to, r.color, r.from]
        );
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[packs/realestate] stage rename skipped:', e.message);
  }

  // RE_CP_PIPELINE_v1 (2026-05-21) — Statuses (additive, 12-stage CP flow)
  // Mirrors the canonical 'CP CRM Process' diagram: Lead Received -> Payout.
  // Editable by tenants after install (they can rename/delete/reorder).
  try {
    const stT = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name='statuses' LIMIT 1`);
    if (stT.rows.length) {
      const RE_STAGES = [
        { name: 'New Lead',             color: '#a855f7' },  // 1 violet
        { name: 'Lead Captured',        color: '#3b82f6' },  // 2 blue
        { name: 'Assigned',             color: '#06b6d4' },  // 3 cyan
        { name: 'In Follow-up',         color: '#22c55e' },  // 4 green
        { name: 'Presentation Done',    color: '#f59e0b' },  // 5 amber
        { name: 'Site Visit Fixed',     color: '#ec4899' },  // 6 pink
        { name: 'Site Visit Done',      color: '#0ea5e9' },  // 7 sky
        { name: 'Offer Given',          color: '#f97316' },  // 8 orange
        { name: 'Booked',               color: '#16a34a' },  // 9 green-dark
        { name: 'Documents Collected',  color: '#8b5cf6' },  // 10 indigo
        { name: 'Commission In Progress', color: '#0284c7' },// 11 blue-dark
        { name: 'Paid',                 color: '#15803d' }   // 12 green-paid
      ];
      for (let i = 0; i < RE_STAGES.length; i++) {
        const { name, color } = RE_STAGES[i];
        const have = await db.query(`SELECT 1 FROM statuses WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]);
        if (!have.rows.length) {
          try {
            await db.query(
              `INSERT INTO statuses (name, sort_order, color) VALUES ($1, $2, $3)`,
              [name, 200 + i, color]
            );
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    console.warn('[packs/realestate] statuses seed skipped:', e.message);
  }

  return { ok: true };
}

async function uninstall(opts) {
  // Soft uninstall — preserve all data so re-install is instant.
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────
// Register
// ─────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════
// Phase 3 — Buyer requirements, Site visits, CP performance, Discount
// ═════════════════════════════════════════════════════════════════

async function _ensureSchemaPhase3() {
  await db.query(`CREATE TABLE IF NOT EXISTS re_buyer_requirements (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    budget_min NUMERIC(14,2) NOT NULL DEFAULT 0,
    budget_max NUMERIC(14,2) NOT NULL DEFAULT 0,
    preferred_bhk TEXT NOT NULL DEFAULT '',
    preferred_locations TEXT NOT NULL DEFAULT '',
    preferred_projects TEXT NOT NULL DEFAULT '',
    possession_timeline TEXT NOT NULL DEFAULT '',
    intent TEXT NOT NULL DEFAULT 'self_use',
    notes TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_req_lead_idx ON re_buyer_requirements(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS re_site_visits (
    id SERIAL PRIMARY KEY,
    lead_id INTEGER NOT NULL,
    project_id INTEGER,
    unit_id INTEGER,
    scheduled_at TIMESTAMPTZ NOT NULL,
    assigned_to INTEGER,
    status TEXT NOT NULL DEFAULT 'scheduled',
    pickup_location TEXT NOT NULL DEFAULT '',
    pickup_time TIMESTAMPTZ,
    drop_location TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    feedback TEXT NOT NULL DEFAULT '',
    visit_outcome TEXT NOT NULL DEFAULT '',
    visited_at TIMESTAMPTZ,
    reminded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by INTEGER
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_visit_lead_idx ON re_site_visits(lead_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS re_visit_sched_idx ON re_site_visits(scheduled_at)`);

  // Discount column on bookings — additive
  try { await db.query(`ALTER TABLE re_bookings ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0`); } catch (_) {}
  try { await db.query(`ALTER TABLE re_bookings ADD COLUMN IF NOT EXISTS discount_reason TEXT NOT NULL DEFAULT ''`); } catch (_) {}
  try { await db.query(`ALTER TABLE re_bookings ADD COLUMN IF NOT EXISTS salesperson_id INTEGER`); } catch (_) {}
  try { await db.query(`ALTER TABLE re_bookings ADD COLUMN IF NOT EXISTS salesperson_commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0`); } catch (_) {}
}

// ───── Buyer Requirements ─────
async function api_re_requirements_save(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  await _ensureSchemaPhase3();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (p.id) {
    await db.query(`UPDATE re_buyer_requirements SET
      budget_min=$1, budget_max=$2, preferred_bhk=$3, preferred_locations=$4,
      preferred_projects=$5, possession_timeline=$6, intent=$7, notes=$8,
      is_active=$9, updated_at=NOW() WHERE id=$10`,
      [Number(p.budget_min||0), Number(p.budget_max||0), p.preferred_bhk||'',
       p.preferred_locations||'', p.preferred_projects||'', p.possession_timeline||'',
       p.intent||'self_use', p.notes||'', p.is_active==null?1:Number(!!p.is_active), p.id]);
  /* LEAD_ACTIVITY_v1 — count buyer-req save as a lead activity */
  try { const _me = await authUser(token); if (payload && payload.lead_id) require('../tat').logAction(Number(payload.lead_id), 're_requirement_saved', _me.id, { type: String(payload.requirement_type || ''), budget_max: Number(payload.budget_max || 0) }); } catch (_) {}

    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO re_buyer_requirements
    (lead_id, budget_min, budget_max, preferred_bhk, preferred_locations,
     preferred_projects, possession_timeline, intent, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [Number(p.lead_id), Number(p.budget_min||0), Number(p.budget_max||0),
     p.preferred_bhk||'', p.preferred_locations||'', p.preferred_projects||'',
     p.possession_timeline||'', p.intent||'self_use', p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}

async function api_re_requirements_byLead(token, leadId) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  if (!leadId) throw new Error('leadId required');
  const r = await db.query(`SELECT * FROM re_buyer_requirements WHERE lead_id=$1 ORDER BY id DESC`, [Number(leadId)]);
  return r.rows;
}

/**
 * api_re_requirements_match — finds available units that match a buyer's
 * requirement. Scoring: budget (40), BHK (30), location (20), project (10).
 * Returns top 20 matches with a score 0..100.
 */
async function api_re_requirements_recent(token, opts) {
  await _requireRealEstate();
  await authUser(token);
  // BUYER_REQS_TABLE_FIX_v1 (2026-05-21): table is re_buyer_requirements,
  // not re_requirements. Also ensure schema is applied for tenants
  // installed before Phase 3 — the table won't exist until then.
  await _ensureSchemaPhase3();
  const limit = Math.min(200, Math.max(1, Number((opts && opts.limit) || 100)));
  const r = await db.query(
    `SELECT rq.id, rq.lead_id, rq.budget_min, rq.budget_max, rq.preferred_bhk, rq.preferred_locations, rq.preferred_projects, rq.possession_timeline, rq.intent, rq.notes, rq.created_at,
            l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email,
            u.name AS rep_name
       FROM re_buyer_requirements rq
       LEFT JOIN leads l ON l.id = rq.lead_id
       LEFT JOIN users u ON u.id = l.assigned_to
      ORDER BY rq.created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows || [];
}

async function api_re_requirements_match(token, requirementId) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  if (!requirementId) throw new Error('requirementId required');
  const rqR = await db.query(`SELECT * FROM re_buyer_requirements WHERE id=$1`, [Number(requirementId)]);
  const rq = rqR.rows && rqR.rows[0];
  if (!rq) throw new Error('Requirement not found');

  const unitsR = await db.query(`
    SELECT u.id, u.unit_no, u.floor, u.type, u.carpet_sqft, u.price, u.status,
           p.id AS project_id, p.name AS project_name, p.location AS project_location, p.tower_code
      FROM re_units u
      JOIN re_projects p ON p.id = u.project_id
     WHERE u.status = 'available'
  `);
  const units = unitsR.rows || [];

  const bhkPref = String(rq.preferred_bhk || '').toLowerCase();
  const locPref = String(rq.preferred_locations || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
  const projPref = String(rq.preferred_projects || '').toLowerCase().split(',').map(s=>s.trim()).filter(Boolean);
  const bMin = Number(rq.budget_min || 0);
  const bMax = Number(rq.budget_max || 0) || Infinity;

  const scored = units.map(u => {
    let score = 0, reasons = [];
    const p = Number(u.price || 0);

    // Budget (40 pts)
    if (bMax === Infinity && bMin === 0) {
      score += 20; reasons.push('No budget set');
    } else if (p >= bMin && p <= bMax) {
      score += 40; reasons.push('Budget match');
    } else if (p < bMin) {
      score += 15; reasons.push('Below budget (₹' + p.toLocaleString('en-IN') + ')');
    } else if (p <= bMax * 1.1) {
      score += 25; reasons.push('Slightly over budget (10%)');
    }

    // BHK (30 pts)
    if (bhkPref) {
      if ((u.type || '').toLowerCase().includes(bhkPref)) {
        score += 30; reasons.push('BHK match');
      }
    } else { score += 15; }

    // Location (20 pts)
    if (locPref.length) {
      const locTxt = (u.project_location || '').toLowerCase();
      if (locPref.some(l => locTxt.includes(l))) { score += 20; reasons.push('Location match'); }
    } else { score += 10; }

    // Project (10 pts)
    if (projPref.length) {
      const projTxt = (u.project_name || '').toLowerCase();
      if (projPref.some(pr => projTxt.includes(pr))) { score += 10; reasons.push('Preferred project'); }
    } else { score += 5; }

    return { ...u, _score: Math.min(100, score), _reasons: reasons };
  });

  scored.sort((a, b) => b._score - a._score);
  return { requirement: rq, matches: scored.slice(0, 20) };
}

// ───── Site Visit Management ─────
async function api_re_visits_schedule(token, payload) {
  const me = await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.scheduled_at) throw new Error('scheduled_at required');
  if (p.id) {
    await db.query(`UPDATE re_site_visits SET
      scheduled_at=$1, project_id=$2, unit_id=$3, assigned_to=$4,
      pickup_location=$5, pickup_time=$6, drop_location=$7,
      notes=$8 WHERE id=$9`,
      [p.scheduled_at, p.project_id || null, p.unit_id || null, p.assigned_to || null,
       p.pickup_location || '', p.pickup_time || null, p.drop_location || '',
       p.notes || '', p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO re_site_visits
    (lead_id, project_id, unit_id, scheduled_at, assigned_to,
     pickup_location, pickup_time, drop_location, notes, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [Number(p.lead_id), p.project_id || null, p.unit_id || null, p.scheduled_at,
     p.assigned_to || null, p.pickup_location || '', p.pickup_time || null,
     p.drop_location || '', p.notes || '', me.id]);
  return { ok: true, id: r.rows[0].id };
}

async function api_re_visits_byLead(token, leadId) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  if (!leadId) throw new Error('leadId required');
  const r = await db.query(`
    SELECT v.*, p.name AS project_name, u.unit_no, ag.name AS assigned_to_name
      FROM re_site_visits v
      LEFT JOIN re_projects p ON p.id = v.project_id
      LEFT JOIN re_units u    ON u.id = v.unit_id
      LEFT JOIN users ag      ON ag.id = v.assigned_to
     WHERE v.lead_id = $1
     ORDER BY v.scheduled_at DESC
  `, [Number(leadId)]);
  return r.rows;
}

async function api_re_visits_upcoming(token, filters) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  const f = filters || {};
  const days = Math.max(1, Math.min(60, Number(f.days || 7)));
  const r = await db.query(`
    SELECT v.*, p.name AS project_name, u.unit_no,
           l.name AS lead_name, l.phone AS lead_phone,
           ag.name AS assigned_to_name
      FROM re_site_visits v
      LEFT JOIN re_projects p ON p.id = v.project_id
      LEFT JOIN re_units u    ON u.id = v.unit_id
      LEFT JOIN leads l       ON l.id = v.lead_id
      LEFT JOIN users ag      ON ag.id = v.assigned_to
     WHERE v.status NOT IN ('done','no_show','cancelled')
       AND v.scheduled_at BETWEEN NOW() AND NOW() + ($1::int || ' days')::interval
     ORDER BY v.scheduled_at ASC
     LIMIT 100
  `, [days]);
  return r.rows;
}

async function api_re_visits_markDone(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const outcome = p.outcome || 'done';  // done / no_show / cancelled / interested / not_interested
  await db.query(`UPDATE re_site_visits SET
    status='done', visit_outcome=$1, feedback=$2,
    visited_at=NOW() WHERE id=$3`,
    [outcome, p.feedback || '', Number(p.id)]);
  return { ok: true };
}

async function api_re_visits_reschedule(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  if (!p.scheduled_at) throw new Error('new scheduled_at required');
  await db.query(`UPDATE re_site_visits SET
    scheduled_at=$1, status='scheduled', notes = COALESCE(notes,'') || E'\\n[Rescheduled: ' || $2 || ']' WHERE id=$3`,
    [p.scheduled_at, p.reason || 'no reason given', Number(p.id)]);
  return { ok: true };
}

async function api_re_visits_sendReminder(token, payload) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchemaPhase3();
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const r = await db.query(`
    SELECT v.*, l.name, l.phone, l.email, l.whatsapp,
           p.name AS project_name, u.unit_no
      FROM re_site_visits v
      LEFT JOIN leads l ON l.id = v.lead_id
      LEFT JOIN re_projects p ON p.id = v.project_id
      LEFT JOIN re_units u ON u.id = v.unit_id
     WHERE v.id = $1
  `, [Number(p.id)]);
  const v = r.rows && r.rows[0];
  if (!v) throw new Error('Visit not found');
  const msg = `Hi ${v.name || ''}! Reminder: your site visit is scheduled for ${String(v.scheduled_at).slice(0,16).replace('T',' ')} at ${v.project_name || ''}${v.unit_no ? ' · Unit ' + v.unit_no : ''}.${v.pickup_location ? ' Pickup: ' + v.pickup_location : ''} See you there!`;
  const result = { wa: null, email: null };
  try {
    const whatsbot = require('../whatsbot');
    const phone = (v.whatsapp || v.phone || '').replace(/\D/g, '');
    if (whatsbot && whatsbot._sendFreeform && phone) {
      await whatsbot._sendFreeform(phone, msg);
      result.wa = { ok: true };
    }
  } catch (e) { result.wa = { ok: false, reason: e.message }; }
  try {
    const mailer = require('../../utils/mailer');
    if (mailer && mailer._sendRaw && v.email) {
      await mailer._sendRaw({ to: v.email, subject: 'Site visit reminder', text: msg });
      result.email = { ok: true };
    }
  } catch (e) { result.email = { ok: false, reason: e.message }; }
  await db.query(`UPDATE re_site_visits SET reminded_at=NOW() WHERE id=$1`, [Number(p.id)]);
  return result;
}

// ───── CP performance report ─────
async function api_re_cp_performance(token, filters) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  const f = filters || {};
  const start = f.start_date || new Date(Date.now() - 180*24*60*60*1000).toISOString().slice(0,10);
  const end   = f.end_date   || new Date().toISOString().slice(0,10);

  const r = await db.query(`
    SELECT cp.id, cp.name, cp.phone, cp.email, cp.commission_pct,
           COUNT(b.id)::int                                        AS bookings,
           COUNT(b.id) FILTER (WHERE b.status='cancelled')::int    AS cancelled,
           COUNT(b.id) FILTER (WHERE b.status='registered')::int   AS registered,
           COALESCE(SUM(b.total_price), 0)::numeric                 AS gmv,
           COALESCE(SUM(cl.amount_due), 0)::numeric                 AS commission_due,
           COALESCE(SUM(cl.amount_paid), 0)::numeric                AS commission_paid,
           MAX(b.booking_date) AS last_booking_date
      FROM re_channel_partners cp
      LEFT JOIN re_bookings b
             ON b.channel_partner_id = cp.id
            AND b.booking_date BETWEEN $1::date AND $2::date
      LEFT JOIN re_commission_ledger cl ON cl.booking_id = b.id
     GROUP BY cp.id
     ORDER BY gmv DESC
  `, [start, end]);
  return { rows: r.rows || [], start_date: start, end_date: end };
}


/* ==========================================================================
 * RE_PAYMENT_PLANS_v1 — Payment Plan CRUD
 * ========================================================================== */

/* List plans, optionally filtered by project_id. NULL project_id = global. */
async function api_re_paymentPlans_list(token, opts) {
  await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  opts = opts || {};
  let where = '1=1';
  const params = [];
  if (opts.project_id != null && opts.project_id !== '') {
    params.push(Number(opts.project_id));
    where += ' AND (project_id = $' + params.length + ' OR project_id IS NULL)';
  }
  const r = await db.query(
    `SELECT pp.*, pr.name AS project_name
       FROM re_payment_plans pp
       LEFT JOIN re_projects pr ON pr.id = pp.project_id
      WHERE ${where}
      ORDER BY pp.is_default DESC, pp.is_active DESC, pp.id DESC`,
    params
  );
  return r.rows.map(row => Object.assign({}, row, {
    milestones: (() => { try { return JSON.parse(row.milestones_json || '[]'); } catch (_) { return []; } })()
  }));
}

async function api_re_paymentPlans_save(token, payload) {
  const me = await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const p = payload || {};
  if (!p.name) throw new Error('Plan name required');
  const milestones = Array.isArray(p.milestones) ? p.milestones : [];
  if (!milestones.length) throw new Error('At least one milestone required');

  // Normalise + validate
  const cleaned = milestones.map((m, i) => ({
    code: String(m.code || ('m' + (i+1))).slice(0, 60).toLowerCase().replace(/[^a-z0-9_]/g, ''),
    label: String(m.label || ('Milestone ' + (i+1))).slice(0, 200),
    offset_days: Math.max(0, Number(m.offset_days || 0)),
    pct: Math.max(0, Math.min(100, Number(m.pct || 0)))
  }));
  const sum = cleaned.reduce((a, m) => a + Number(m.pct), 0);
  if (Math.abs(sum - 100) > 0.5) throw new Error('Milestone percentages must sum to 100 (got ' + sum.toFixed(2) + ')');

  const isActive  = p.is_active  === false || Number(p.is_active)  === 0 ? 0 : 1;
  const isDefault = p.is_default === true  || Number(p.is_default) === 1 ? 1 : 0;
  const projectId = p.project_id ? Number(p.project_id) : null;

  // When marking as default, unflag siblings (per project_id scope).
  if (isDefault) {
    await db.query(
      `UPDATE re_payment_plans SET is_default = 0
        WHERE COALESCE(project_id, 0) = COALESCE($1, 0)`,
      [projectId]
    );
  }

  if (p.id) {
    await db.query(
      `UPDATE re_payment_plans SET project_id=$1, name=$2, description=$3,
            milestones_json=$4, is_active=$5, is_default=$6, updated_at=NOW()
        WHERE id=$7`,
      [projectId, String(p.name).slice(0, 200), String(p.description || '').slice(0, 1000),
       JSON.stringify(cleaned), isActive, isDefault, Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  } else {
    const r = await db.query(
      `INSERT INTO re_payment_plans (project_id, name, description, milestones_json, is_active, is_default, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [projectId, String(p.name).slice(0, 200), String(p.description || '').slice(0, 1000),
       JSON.stringify(cleaned), isActive, isDefault, me.id]
    );
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_re_paymentPlans_delete(token, id) {
  const me = await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  // Detach from any bookings that referenced it so demand letters
  // remain intact (the demands themselves are not affected).
  await db.query(`UPDATE re_bookings SET payment_plan_id = NULL WHERE payment_plan_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM re_payment_plans WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

/* Seed the DEFAULT_MILESTONES as a "Standard 1-9-30-30-30" plan once,
 * so brand-new tenants see something to start from. Idempotent. */
async function api_re_paymentPlans_seedDefaults(token) {
  const me = await authUser(token);
  await _requireRealEstate();
  await _ensureSchema();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const existing = await db.query(`SELECT COUNT(*)::int AS c FROM re_payment_plans`);
  if (Number(existing.rows[0].c) > 0) return { ok: true, message: 'Already seeded — skipped' };
  await db.query(
    `INSERT INTO re_payment_plans (project_id, name, description, milestones_json, is_active, is_default, created_by)
     VALUES (NULL, 'Standard 1-9-30-30-30', 'Token 1% · Agreement 9% · Excavation 30% · Slab 30% · Registration 30%', $1, 1, 1, $2)`,
    [JSON.stringify(DEFAULT_MILESTONES), me.id]
  );
  return { ok: true, message: 'Seeded the default Standard 1-9-30-30-30 plan' };
}

framework.register({
  id: PACK_ID,
  name: 'Real Estate',
  industry: 'realestate',
  summary: 'Inventory board, bookings, auto-generated demand letters, channel-partner commissions.',
  version: '1.0.0',
  features: [
    'Project / Tower / Unit inventory with status (available / blocked / booked / registered)',
    'Color-coded unit grid view',
    '5 auto-generated demand letters per booking (token/agreement/excavation/slab/registration)',
    'Channel partner commission auto-accrued on booking',
    'Registration milestone auto-marks unit as registered',
    'Real Estate statuses + custom fields seeded'
  ],
  nav_items: [
    { id: 'reinventory',    label: '🏢 Inventory Board', icon: '🏢' },
    { id: 'rerequirements', label: '🎯 Buyer Requirements', icon: '🎯' },
    { id: 'revisits',       label: '📅 Site Visits',     icon: '📅' },
    { id: 'recpperf',       label: '👥 Broker Performance', icon: '👥' }
  ],
  install,
  uninstall
});

module.exports = {
  install, uninstall,
  api_re_projects_list, api_re_projects_save,
  api_re_units_byProject, api_re_units_save, api_re_units_bulkCreate,
  api_re_booking_create, api_re_booking_byLead, api_re_booking_cancel,
  api_re_demand_markPaid, api_re_demand_renderHtml, api_re_demand_sendReminder,
  api_re_channelPartners_list, api_re_channelPartners_save,
  api_re_commission_list, api_re_commission_markPaid,
  api_re_summary,
  api_re_requirements_save, api_re_requirements_byLead, api_re_requirements_match, api_re_requirements_recent,
  api_re_visits_schedule, api_re_visits_byLead, api_re_visits_upcoming,
  api_re_visits_markDone, api_re_visits_reschedule, api_re_visits_sendReminder,
  api_re_cp_performance,
  /* RE_PAYMENT_PLANS_v1 */
  api_re_paymentPlans_list, api_re_paymentPlans_save,
  api_re_paymentPlans_delete, api_re_paymentPlans_seedDefaults,
  _ensureSchema, _ensureSchemaPhase3,
  DEFAULT_MILESTONES
};
