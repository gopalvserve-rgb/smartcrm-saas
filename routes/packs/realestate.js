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
  api_re_booking_create, api_re_booking_byLead,
  api_re_demand_markPaid,
  api_re_channelPartners_list, api_re_channelPartners_save,
  api_re_summary,
  _ensureSchema,
  DEFAULT_MILESTONES
};
