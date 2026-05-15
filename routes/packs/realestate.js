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

  const start = new Date(bookingDate);
  for (let i = 0; i < DEFAULT_MILESTONES.length; i++) {
    const m = DEFAULT_MILESTONES[i];
    const due = new Date(start.getTime());
    due.setDate(due.getDate() + (m.offset_days || 0));
    const amt = Math.round(total * (m.pct / 100) * 100) / 100;
    await db.query(
      `INSERT INTO re_demands (booking_id, seq, code, label, due_date, amount)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bookingId, i + 1, m.code, m.label, due.toISOString().slice(0, 10), amt]
    );
  }

  if (cpId && cpPct) {
    const commissionAmt = Math.round(total * (Number(cpPct) / 100) * 100) / 100;
    await db.query(
      `INSERT INTO re_commission_ledger (booking_id, partner_id, amount_due) VALUES ($1,$2,$3)`,
      [bookingId, Number(cpId), commissionAmt]
    );
  }

  return { ok: true, booking_id: bookingId, demands: DEFAULT_MILESTONES.length };
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

  // Statuses (additive)
  try {
    const stT = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name='statuses' LIMIT 1`);
    if (stT.rows.length) {
      const wanted = ['Site Visit Scheduled','Site Visit Done','Token Paid','Agreement Signed','Booked','Registered','Possession Given'];
      for (let i = 0; i < wanted.length; i++) {
        const name = wanted[i];
        const have = await db.query(`SELECT 1 FROM statuses WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]);
        if (!have.rows.length) {
          try {
            await db.query(
              `INSERT INTO statuses (name, display_order, color) VALUES ($1, $2, $3)`,
              [name, 200 + i, '#0ea5e9']
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
    { id: 'reinventory', label: '🏢 Inventory Board', icon: '🏢' }
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
  _ensureSchema,
  DEFAULT_MILESTONES
};
