/**
 * routes/packs/realestate.js
 *
 * Industry Pack: Real Estate.
 *
 * Tables (all namespaced re_*):
 *   re_projects          — towers / phases / projects in inventory
 *   re_units             — individual flats / shops / plots
 *   re_bookings          — buyer × unit allotment
 *   re_demands           — auto-generated demand letters per booking
 *   re_payments          — money actually received
 *   re_channel_partners  — broker / agency master
 *   re_commission_ledger — payable commission tracking
 *
 *   APIs (api_re_*):
 *     api_re_projects_list / _save
 *     api_re_units_byProject / _save / _bulkCreate
 *     api_re_booking_create / _byLead
 *     api_re_demand_markPaid
 *     api_re_channelPartners_list / _save
 *     api_re_summary
 */

'use strict';

const db        = require('../../db/pg');
const framework = require('./_framework');

const PACK_ID = 'realestate';

// Demand-letter milestones (% of total) used on booking
const DEFAULT_MILESTONES = [
  { code: 'token',        label: 'Token',        pct: 1,  offset_days:  0 },
  { code: 'agreement',    label: 'Agreement',    pct: 9,  offset_days: 30 },
  { code: 'excavation',   label: 'Excavation',   pct: 30, offset_days: 90 },
  { code: 'slab',         label: 'Slab',         pct: 30, offset_days: 180 },
  { code: 'registration', label: 'Registration', pct: 30, offset_days: 365 }
];

// ── Installer ──────────────────────────────────────────────────────
async function _installer({ db: D }) {
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_projects (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      location    TEXT,
      tower_code  TEXT,
      total_floors INT,
      units_per_floor INT,
      is_active   INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS re_units (
      id          SERIAL PRIMARY KEY,
      project_id  INT NOT NULL,
      unit_no     TEXT NOT NULL,
      floor       INT,
      type        TEXT,          -- 1BHK, 2BHK, 3BHK, Shop, Plot…
      carpet_sqft NUMERIC(10,2),
      price       NUMERIC(14,2) NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'available',  -- available|blocked|booked|registered
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_units_project_idx ON re_units(project_id)`, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS re_channel_partners (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      contact     TEXT,
      phone       TEXT,
      email       TEXT,
      commission_pct NUMERIC(5,2) NOT NULL DEFAULT 2.0,
      is_active   INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS re_bookings (
      id           SERIAL PRIMARY KEY,
      lead_id      INT,
      unit_id      INT NOT NULL,
      project_id   INT NOT NULL,
      buyer_name   TEXT,
      total_price  NUMERIC(14,2) NOT NULL DEFAULT 0,
      booking_date DATE NOT NULL DEFAULT CURRENT_DATE,
      channel_partner_id INT,
      commission_pct NUMERIC(5,2),
      status       TEXT NOT NULL DEFAULT 'booked',  -- booked|cancelled|registered
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_bookings_lead_idx ON re_bookings(lead_id)`, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS re_demands (
      id           SERIAL PRIMARY KEY,
      booking_id   INT NOT NULL,
      seq          INT NOT NULL,
      code         TEXT NOT NULL,
      label        TEXT,
      due_date     DATE,
      amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
      paid_amount  NUMERIC(14,2) NOT NULL DEFAULT 0,
      status       TEXT NOT NULL DEFAULT 'pending',  -- pending|partial|paid
      paid_at      TIMESTAMPTZ
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_demands_booking_idx ON re_demands(booking_id)`, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS re_payments (
      id           SERIAL PRIMARY KEY,
      demand_id    INT NOT NULL,
      booking_id   INT NOT NULL,
      amount       NUMERIC(14,2) NOT NULL,
      method       TEXT,
      reference    TEXT,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      received_by  INT
    )
  `, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS re_commission_ledger (
      id          SERIAL PRIMARY KEY,
      booking_id  INT NOT NULL,
      partner_id  INT NOT NULL,
      amount_due  NUMERIC(14,2) NOT NULL DEFAULT 0,
      amount_paid NUMERIC(14,2) NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending|partial|paid
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at     TIMESTAMPTZ
    )
  `, []);

  // Seed sample project + 12 units (3 floors × 4 units)
  const existing = await D.query(`SELECT 1 FROM re_projects LIMIT 1`, []);
  if (!existing.rows.length) {
    const p = await D.query(
      `INSERT INTO re_projects (name, location, tower_code, total_floors, units_per_floor)
       VALUES ('Sample Heights', 'Sector 1', 'A', 3, 4) RETURNING id`,
      []
    );
    const pid = p.rows[0].id;

    for (let f = 1; f <= 3; f++) {
      for (let u = 1; u <= 4; u++) {
        const unitNo = `A-${f}0${u}`;
        const type = u <= 2 ? '2BHK' : '3BHK';
        const carpet = u <= 2 ? 850 : 1150;
        const price = u <= 2 ? 5500000 : 7500000;
        await D.query(
          `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [pid, unitNo, f, type, carpet, price]
        );
      }
    }
  }

  // Seed 2 default channel partners
  const cpExisting = await D.query(`SELECT 1 FROM re_channel_partners LIMIT 1`, []);
  if (!cpExisting.rows.length) {
    await D.query(
      `INSERT INTO re_channel_partners (name, commission_pct) VALUES
       ('Direct Sales', 0), ('SquareYards', 2.0)`, []
    );
  }

  // Seed RE-flavoured custom fields + statuses (additive)
  try {
    const cfT = await D.query(`SELECT 1 FROM information_schema.tables WHERE table_name='custom_fields' LIMIT 1`, []);
    if (cfT.rows.length) {
      for (const key of ['preferred_bhk','budget_max','possession_timeline','source_broker']) {
        const have = await D.query(`SELECT 1 FROM custom_fields WHERE LOWER(name)=LOWER($1) LIMIT 1`, [key]);
        if (!have.rows.length) {
          await D.query(`INSERT INTO custom_fields (name, label, type, is_active) VALUES ($1,$2,'text',1)`,
            [key, key.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase())]);
        }
      }
    }
  } catch (_) {}

  try {
    const stT = await D.query(`SELECT 1 FROM information_schema.tables WHERE table_name='statuses' LIMIT 1`, []);
    if (stT.rows.length) {
      for (const name of ['Site Visit Scheduled','Site Visit Done','Token Paid','Agreement Signed','Booked','Registered','Possession Given']) {
        const have = await D.query(`SELECT 1 FROM statuses WHERE LOWER(name)=LOWER($1) LIMIT 1`, [name]);
        if (!have.rows.length) {
          await D.query(`INSERT INTO statuses (name, is_active) VALUES ($1,1)`, [name]);
        }
      }
    }
  } catch (_) {}
}

// ── API: Projects ──────────────────────────────────────────────────
async function api_re_projects_list(/*token*/) {
  await framework.requireActive(PACK_ID);
  const r = await db.query(`SELECT * FROM re_projects ORDER BY id DESC`, []);
  return r.rows || [];
}

async function api_re_projects_save(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  if (!p.name) throw new Error('Project name required');

  if (p.id) {
    await db.query(
      `UPDATE re_projects SET name=$1, location=$2, tower_code=$3, total_floors=$4, units_per_floor=$5, is_active=$6 WHERE id=$7`,
      [p.name, p.location || null, p.tower_code || null,
       Number(p.total_floors||0), Number(p.units_per_floor||0),
       p.is_active==null ? 1 : Number(!!p.is_active), p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO re_projects (name, location, tower_code, total_floors, units_per_floor) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.name, p.location || null, p.tower_code || null,
     Number(p.total_floors||0), Number(p.units_per_floor||0)]
  );
  return { ok: true, id: r.rows[0].id };
}

// ── API: Units ─────────────────────────────────────────────────────
async function api_re_units_byProject(token, projectId) {
  await framework.requireActive(PACK_ID);
  if (!projectId) throw new Error('projectId required');
  const r = await db.query(`SELECT * FROM re_units WHERE project_id=$1 ORDER BY floor, unit_no`, [projectId]);
  return r.rows || [];
}

async function api_re_units_save(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  if (!p.unit_no || !p.project_id) throw new Error('unit_no + project_id required');
  if (p.id) {
    await db.query(
      `UPDATE re_units SET unit_no=$1, floor=$2, type=$3, carpet_sqft=$4, price=$5, status=$6 WHERE id=$7`,
      [p.unit_no, Number(p.floor||0), p.type||null, Number(p.carpet_sqft||0),
       Number(p.price||0), p.status||'available', p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [p.project_id, p.unit_no, Number(p.floor||0), p.type||null,
     Number(p.carpet_sqft||0), Number(p.price||0), p.status||'available']
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_re_units_bulkCreate(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  if (!p.project_id) throw new Error('project_id required');
  const floors = Number(p.floors || 0);
  const perFloor = Number(p.units_per_floor || 0);
  const type = p.type || '2BHK';
  const price = Number(p.price || 0);
  const carpet = Number(p.carpet_sqft || 0);
  const towerCode = p.tower_code || 'A';

  if (!floors || !perFloor) throw new Error('floors and units_per_floor required');

  let n = 0;
  for (let f = 1; f <= floors; f++) {
    for (let u = 1; u <= perFloor; u++) {
      const unitNo = `${towerCode}-${f}${String(u).padStart(2,'0')}`;
      await db.query(
        `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price) VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.project_id, unitNo, f, type, carpet, price]
      );
      n++;
    }
  }
  return { ok: true, created: n };
}

// ── API: Bulk IMPORT units from Excel/CSV (varied per-unit values) ──
// RE_BULK_IMPORT_v1 — unlike api_re_units_bulkCreate (uniform grid), this
// accepts an array of already-parsed rows so each unit can have its own
// unit_no / floor / type / carpet_sqft / price / status. Optional dedupe
// skips unit_no values that already exist in the project.
async function api_re_units_bulkImport(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  const projectId = Number(p.project_id);
  if (!projectId) throw new Error('project_id required');
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if (!rows.length) throw new Error('No rows to import');
  if (rows.length > 5000) throw new Error('Too many rows (max 5000 per import)');

  const okStatus = { available: 1, blocked: 1, booked: 1, registered: 1 };

  let existing = new Set();
  if (p.dedupe) {
    const ex = await db.query(`SELECT unit_no FROM re_units WHERE project_id=$1`, [projectId]);
    existing = new Set(ex.rows.map(r => String(r.unit_no || '').trim().toLowerCase()));
  }

  let created = 0, skipped = 0;
  const seen = new Set();
  for (const r of rows) {
    const unitNo = String(r.unit_no || r.unit || r.unitno || '').trim();
    if (!unitNo) { skipped++; continue; }
    const key = unitNo.toLowerCase();
    if (p.dedupe && (existing.has(key) || seen.has(key))) { skipped++; continue; }
    seen.add(key);
    const floor  = (r.floor === '' || r.floor == null) ? null : Number(r.floor);
    const type   = String(r.type || r.unit_type || '').trim() || null;
    const carpet = (r.carpet_sqft === '' || r.carpet_sqft == null) ? null : Number(r.carpet_sqft);
    const price  = Number(r.price || 0) || 0;
    let status   = String(r.status || 'available').trim().toLowerCase();
    if (!okStatus[status]) status = 'available';
    await db.query(
      `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [projectId, unitNo, Number.isFinite(floor) ? floor : null, type,
       Number.isFinite(carpet) ? carpet : null, price, status]
    );
    created++;
  }
  return { ok: true, created, skipped };
}

// ── API: Booking + auto-generated demands + commission ─────────────
async function api_re_booking_create(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  if (!p.unit_id) throw new Error('unit_id required');

  // Pull unit + project
  const uR = await db.query(`SELECT * FROM re_units WHERE id=$1`, [p.unit_id]);
  const unit = uR.rows && uR.rows[0];
  if (!unit) throw new Error('Unit not found');
  if (unit.status === 'booked' || unit.status === 'registered') {
    throw new Error(`Unit ${unit.unit_no} is already ${unit.status}`);
  }

  const total = Number(p.total_price || unit.price || 0);
  const bookingDate = p.booking_date || new Date().toISOString().slice(0,10);

  // Channel partner commission lookup
  let cpId = p.channel_partner_id || null;
  let cpPct = p.commission_pct;
  if (cpId && cpPct == null) {
    const cpR = await db.query(`SELECT commission_pct FROM re_channel_partners WHERE id=$1`, [cpId]);
    cpPct = cpR.rows[0]?.commission_pct;
  }

  // Insert booking
  const bR = await db.query(
    `INSERT INTO re_bookings (lead_id, unit_id, project_id, buyer_name, total_price, booking_date, channel_partner_id, commission_pct, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'booked') RETURNING id`,
    [p.lead_id, p.unit_id, unit.project_id, p.buyer_name || null, total, bookingDate, cpId, cpPct || null]
  );
  const bookingId = bR.rows[0].id;

  // Mark unit booked
  await db.query(`UPDATE re_units SET status='booked' WHERE id=$1`, [p.unit_id]);

  // Generate demand schedule
  const start = new Date(bookingDate);
  for (const m of DEFAULT_MILESTONES) {
    const due = new Date(start.getTime());
    due.setDate(due.getDate() + (m.offset_days || 0));
    const amt = Math.round(total * (m.pct / 100) * 100) / 100;
    await db.query(
      `INSERT INTO re_demands (booking_id, seq, code, label, due_date, amount)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bookingId, DEFAULT_MILESTONES.indexOf(m)+1, m.code, m.label,
       due.toISOString().slice(0,10), amt]
    );
  }

  // Accrue channel-partner commission (payable, not yet paid)
  if (cpId && cpPct) {
    const commissionAmt = Math.round(total * (Number(cpPct) / 100) * 100) / 100;
    await db.query(
      `INSERT INTO re_commission_ledger (booking_id, partner_id, amount_due) VALUES ($1,$2,$3)`,
      [bookingId, cpId, commissionAmt]
    );
  }

  return { ok: true, booking_id: bookingId, demands: DEFAULT_MILESTONES.length };
}

async function api_re_booking_byLead(token, leadId) {
  await framework.requireActive(PACK_ID);
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
  `, [leadId]);
  const bookings = bR.rows || [];
  if (!bookings.length) return { bookings: [], demands: [] };

  const ids = bookings.map(b => b.id);
  const dR = await db.query(
    `SELECT * FROM re_demands WHERE booking_id = ANY($1::int[]) ORDER BY booking_id, seq`,
    [ids]
  );
  return { bookings, demands: dR.rows || [] };
}

// ── API: Mark demand paid ──────────────────────────────────────────
async function api_re_demand_markPaid(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  if (!p.id) throw new Error('id required');

  const cur = await db.query(`SELECT * FROM re_demands WHERE id=$1`, [p.id]);
  const dem = cur.rows && cur.rows[0];
  if (!dem) throw new Error('Demand not found');

  const amt = Number(p.amount || dem.amount);
  const newPaid = Math.round((Number(dem.paid_amount || 0) + amt) * 100) / 100;
  const status = newPaid >= Number(dem.amount) - 0.005 ? 'paid' : 'partial';

  await db.query(
    `UPDATE re_demands
        SET paid_amount=$1, status=$2,
            paid_at = CASE WHEN $2='paid' THEN now() ELSE paid_at END
      WHERE id=$3`,
    [newPaid, status, p.id]
  );

  await db.query(
    `INSERT INTO re_payments (demand_id, booking_id, amount, method, reference) VALUES ($1,$2,$3,$4,$5)`,
    [p.id, dem.booking_id, amt, p.method || 'manual', p.reference || null]
  );

  // If this was the registration milestone and fully paid, mark unit registered
  if (status === 'paid' && dem.code === 'registration') {
    const bR = await db.query(`SELECT unit_id FROM re_bookings WHERE id=$1`, [dem.booking_id]);
    const unitId = bR.rows[0]?.unit_id;
    if (unitId) {
      await db.query(`UPDATE re_units SET status='registered' WHERE id=$1`, [unitId]);
      await db.query(`UPDATE re_bookings SET status='registered' WHERE id=$1`, [dem.booking_id]);
    }
  }

  return { ok: true, status, paid_amount: newPaid };
}

// ── API: Channel Partners ──────────────────────────────────────────
async function api_re_channelPartners_list(/*token*/) {
  await framework.requireActive(PACK_ID);
  const r = await db.query(`SELECT * FROM re_channel_partners ORDER BY name`, []);
  return r.rows || [];
}

async function api_re_channelPartners_save(token, payload) {
  await framework.requireActive(PACK_ID);
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  if (p.id) {
    await db.query(
      `UPDATE re_channel_partners SET name=$1, contact=$2, phone=$3, email=$4, commission_pct=$5, is_active=$6 WHERE id=$7`,
      [p.name, p.contact||null, p.phone||null, p.email||null,
       Number(p.commission_pct||0), p.is_active==null?1:Number(!!p.is_active), p.id]
    );
    return { ok: true, id: p.id };
  }
  const r = await db.query(
    `INSERT INTO re_channel_partners (name, contact, phone, email, commission_pct) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [p.name, p.contact||null, p.phone||null, p.email||null, Number(p.commission_pct||0)]
  );
  return { ok: true, id: r.rows[0].id };
}

// ── API: Summary KPIs ──────────────────────────────────────────────
async function api_re_summary(/*token*/) {
  await framework.requireActive(PACK_ID);

  const r1 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='available')::int  AS available,
      COUNT(*) FILTER (WHERE status='blocked')::int    AS blocked,
      COUNT(*) FILTER (WHERE status='booked')::int     AS booked,
      COUNT(*) FILTER (WHERE status='registered')::int AS registered,
      COUNT(*)::int                                    AS total
    FROM re_units
  `, []);

  const r2 = await db.query(`
    SELECT
      COALESCE(SUM(amount),0)::numeric      AS billed,
      COALESCE(SUM(paid_amount),0)::numeric AS collected,
      COALESCE(SUM(CASE WHEN status<>'paid' THEN amount - paid_amount ELSE 0 END),0)::numeric AS outstanding,
      COALESCE(SUM(CASE WHEN status<>'paid' AND due_date < CURRENT_DATE THEN amount - paid_amount ELSE 0 END),0)::numeric AS overdue
    FROM re_demands
  `, []);

  const r3 = await db.query(`
    SELECT
      COALESCE(SUM(amount_due),0)::numeric  AS commission_due,
      COALESCE(SUM(amount_paid),0)::numeric AS commission_paid
    FROM re_commission_ledger
  `, []);

  return {
    inventory:  r1.rows[0] || {},
    demands:    r2.rows[0] || {},
    commission: r3.rows[0] || {}
  };
}


// ── RE_PACK_v2 (2026-06-27) — 15 new tables for Listings, Tours, Analytics, Deals, Documents, Market Insights ──

// RE-specific lead pipeline (replaces generic stages on showcase-re via reset button or seed)
const RE_LEAD_STAGES = [
  { name: 'New Enquiry',              color: '#3b82f6' },
  { name: 'Qualified',                color: '#06b6d4' },
  { name: 'Assigned',                 color: '#a855f7' },
  { name: 'In Follow-up',             color: '#22c55e' },
  { name: 'Presentation Done',        color: '#f59e0b' },
  { name: 'Site Visit Scheduled',     color: '#ec4899' },
  { name: 'Site Visit Done',          color: '#f97316' },
  { name: 'Negotiation',              color: '#a16207' },
  { name: 'Offer Made',               color: '#dc2626' },
  { name: 'Token Received',           color: '#6366f1' },
  { name: 'Booked',                   color: '#84cc16' },
  { name: 'Documents Collected',      color: '#a855f7' },
  { name: 'Sale Deed Done',           color: '#16a34a', is_final: 1 },
  { name: 'Commission Pending',       color: '#0ea5e9' },
  { name: 'Commission Paid',          color: '#15803d', is_final: 1 },
  { name: 'Lost to Competitor',       color: '#6b7280', is_final: 1 },
  { name: 'Dropped',                  color: '#6b7280', is_final: 1 }
];

const DEAL_STAGES = [
  { seq: 1, code: 'enquired',          label: 'Enquired',           color: '#6b7280' },
  { seq: 2, code: 'visit_scheduled',   label: 'Site Visit Scheduled',color: '#06b6d4' },
  { seq: 3, code: 'visit_done',        label: 'Site Visit Done',    color: '#3b82f6' },
  { seq: 4, code: 'interested',        label: 'Interested',         color: '#a855f7' },
  { seq: 5, code: 'negotiation',       label: 'Negotiation',        color: '#f59e0b' },
  { seq: 6, code: 'offer_made',        label: 'Offer Made',         color: '#f97316' },
  { seq: 7, code: 'token_received',    label: 'Token Received',     color: '#dc2626' },
  { seq: 8, code: 'sale_deed_done',    label: 'Sale Deed Done',     color: '#16a34a' }
];

async function _installerV2({ db: D }) {
  // 1. Open listings (separate from re_units which are project bookings)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_listings (
      id              SERIAL PRIMARY KEY,
      title           TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'residential',  -- residential|commercial|plot|villa|farmhouse|industrial
      transaction     TEXT NOT NULL DEFAULT 'sale',         -- sale|rent|lease
      bhk             TEXT,                                  -- 1BHK, 2BHK, 3BHK, etc
      carpet_sqft     NUMERIC(10,2),
      super_sqft      NUMERIC(10,2),
      floor           INT,
      total_floors    INT,
      facing          TEXT,
      locality        TEXT,
      city            TEXT,
      pincode         TEXT,
      landmark        TEXT,
      price_inr       NUMERIC(14,2) NOT NULL DEFAULT 0,
      maintenance_inr NUMERIC(10,2),
      furnished       TEXT,                                  -- unfurnished|semi|fully
      available_from  DATE,
      amenities       TEXT,                                  -- comma-separated codes
      description     TEXT,
      cover_photo_url TEXT,                                  -- denormalized first photo
      virtual_tour_url TEXT,                                  -- Matterport/Kuula/YouTube URL
      video_tour_url  TEXT,
      drone_url       TEXT,
      rera_number     TEXT,
      owner_name      TEXT,
      owner_phone     TEXT,
      posted_by_user_id INT,
      status          TEXT NOT NULL DEFAULT 'available',     -- available|under_offer|booked|sold|rented|withdrawn
      view_count      INT NOT NULL DEFAULT 0,
      enquiry_count   INT NOT NULL DEFAULT 0,
      listed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_listings_locality_idx ON re_listings(locality)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_listings_status_idx ON re_listings(status)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_listings_txn_idx ON re_listings(transaction, type)`, []);

  // 2. Listing photos
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_listing_photos (
      id          SERIAL PRIMARY KEY,
      listing_id  INT NOT NULL,
      url         TEXT NOT NULL,
      caption     TEXT,
      sort_order  INT DEFAULT 1,
      click_count INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_listing_photos_idx ON re_listing_photos(listing_id)`, []);

  // 3. Virtual tours (per listing — multiple tours of different types)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_listing_tours (
      id           SERIAL PRIMARY KEY,
      listing_id   INT NOT NULL,
      kind         TEXT NOT NULL,  -- video|360|drone|live|matterport|kuula|youtube|vimeo
      url          TEXT,            -- external URL OR R2 URL
      thumbnail    TEXT,
      duration_sec INT,
      view_count   INT NOT NULL DEFAULT 0,
      avg_watch_sec INT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_listing_tours_idx ON re_listing_tours(listing_id)`, []);

  // 4. Per-listing analytics events (each view / share / enquiry)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_listing_analytics (
      id           SERIAL PRIMARY KEY,
      listing_id   INT NOT NULL,
      event_kind   TEXT NOT NULL,  -- view|tour_play|tour_complete|photo_click|enquiry|share|brochure_dl
      source       TEXT,            -- wa|website|99acres|magicbricks|direct|referral|fb|google
      referrer     TEXT,
      meta_json    TEXT,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_listing_analytics_idx ON re_listing_analytics(listing_id, occurred_at)`, []);

  // 5. Deals — separate from project bookings (handles resale + rental)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_deals (
      id              SERIAL PRIMARY KEY,
      deal_no         TEXT,
      lead_id         INT,
      listing_id      INT,
      asking_price    NUMERIC(14,2) DEFAULT 0,
      offer_price     NUMERIC(14,2),
      agreed_price    NUMERIC(14,2),
      token_amount    NUMERIC(14,2),
      token_paid_at   DATE,
      expected_close  DATE,
      current_stage   INT NOT NULL DEFAULT 1,   -- 1..8 from DEAL_STAGES
      stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      owner_user_id   INT,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'active',  -- active|closed|cancelled|onhold
      booked_at       TIMESTAMPTZ,
      closed_at       TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_deals_lead_idx ON re_deals(lead_id)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_deals_listing_idx ON re_deals(listing_id)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_deals_stage_idx ON re_deals(current_stage)`, []);

  // 6. RE Documents (categorized)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_documents (
      id           SERIAL PRIMARY KEY,
      category     TEXT NOT NULL,                 -- sale_deed|token_receipt|booking_form|possession|rera|oc|noc|encumbrance|pan|aadhaar|loan_sanction|misc
      title        TEXT NOT NULL,
      url          TEXT NOT NULL,
      mime_type    TEXT,
      size_kb      INT,
      listing_id   INT,
      deal_id      INT,
      lead_id      INT,
      uploaded_by_user_id INT,
      notes        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_documents_cat_idx ON re_documents(category)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_documents_listing_idx ON re_documents(listing_id)`, []);

  // 7. Public enquiries (form submissions from public listing pages)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_enquiries (
      id           SERIAL PRIMARY KEY,
      listing_id   INT,
      name         TEXT,
      phone        TEXT,
      email        TEXT,
      message      TEXT,
      source       TEXT,                            -- wa|website|99acres|magicbricks|direct
      lead_id      INT,                             -- linked when converted to lead
      status       TEXT NOT NULL DEFAULT 'new',     -- new|contacted|qualified|lost
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_enquiries_listing_idx ON re_enquiries(listing_id)`, []);

  // 8. Amenity master
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_amenities (
      id      SERIAL PRIMARY KEY,
      code    TEXT NOT NULL UNIQUE,
      label   TEXT NOT NULL,
      icon    TEXT,
      sort_order INT DEFAULT 1
    )
  `, []);

  // Seed amenity catalog if empty
  const ac = await D.query(`SELECT COUNT(*)::int AS n FROM re_amenities`, []);
  if ((ac.rows[0] || {}).n === 0) {
    const AMENITIES = [
      ['parking', 'Parking', '🚗'], ['gym', 'Gym', '💪'],
      ['pool', 'Swimming Pool', '🏊'], ['security', '24×7 Security', '🛡️'],
      ['power_backup', 'Power Backup', '⚡'], ['clubhouse', 'Clubhouse', '🏛️'],
      ['lift', 'Lift', '🛗'], ['garden', 'Garden', '🌳'],
      ['playground', "Children's Play Area", '🎠'], ['intercom', 'Intercom', '📞'],
      ['wifi', 'High-speed WiFi', '📶'], ['ac', 'Air-conditioned', '❄️'],
      ['cctv', 'CCTV Surveillance', '📹'], ['gas', 'Gas Pipeline', '🔥'],
      ['water', '24×7 Water', '💧'], ['terrace', 'Terrace Access', '🌇']
    ];
    for (let i = 0; i < AMENITIES.length; i++) {
      const a = AMENITIES[i];
      await D.query(
        `INSERT INTO re_amenities (code, label, icon, sort_order) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code) DO NOTHING`,
        [a[0], a[1], a[2], i + 1]);
    }
  }

  // 9. Sharable links — tracked URLs for analytics
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_sharable_links (
      id           SERIAL PRIMARY KEY,
      listing_id   INT NOT NULL,
      slug         TEXT NOT NULL,
      shared_with  TEXT,                          -- phone or email
      shared_via   TEXT,                          -- wa|email|sms
      click_count  INT NOT NULL DEFAULT 0,
      first_clicked_at TIMESTAMPTZ,
      last_clicked_at  TIMESTAMPTZ,
      created_by_user_id INT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // 10. Market snapshot (avg ₹/sqft per locality — pre-computed daily)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_market_snapshot (
      id              SERIAL PRIMARY KEY,
      snapshot_date   DATE NOT NULL,
      locality        TEXT NOT NULL,
      listings_count  INT NOT NULL DEFAULT 0,
      avg_price_per_sqft NUMERIC(12,2),
      median_price_per_sqft NUMERIC(12,2),
      enquiries_count INT NOT NULL DEFAULT 0,
      deals_closed    INT NOT NULL DEFAULT 0,
      avg_days_to_close INT
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS re_market_snapshot_idx ON re_market_snapshot(locality, snapshot_date)`, []);

  // 11. Remote bookings (public site-visit / live-tour bookings)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_remote_bookings (
      id           SERIAL PRIMARY KEY,
      listing_id   INT NOT NULL,
      lead_id      INT,
      kind         TEXT NOT NULL,                  -- site_visit|live_tour|in_person
      visitor_name TEXT,
      visitor_phone TEXT,
      visitor_email TEXT,
      slot_at      TIMESTAMPTZ NOT NULL,
      assigned_user_id INT,
      status       TEXT NOT NULL DEFAULT 'booked', -- booked|confirmed|done|no_show|cancelled
      meet_url     TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // 12. e-Sign envelopes (DocuSign / Zoho Sign tracking)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_esign_envelopes (
      id           SERIAL PRIMARY KEY,
      deal_id      INT,
      provider     TEXT,                            -- docusign|zoho_sign|manual
      external_id  TEXT,
      doc_title    TEXT,
      doc_url      TEXT,
      signer_email TEXT,
      signer_phone TEXT,
      status       TEXT DEFAULT 'sent',             -- sent|viewed|signed|declined|expired
      sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      signed_at    TIMESTAMPTZ
    )
  `, []);

  // 13. Token payments (Razorpay / Cashfree link tracking)
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_token_payments (
      id           SERIAL PRIMARY KEY,
      deal_id      INT NOT NULL,
      amount_inr   NUMERIC(14,2) NOT NULL,
      gateway      TEXT,                            -- razorpay|cashfree|manual
      payment_link TEXT,
      gateway_payment_id TEXT,
      status       TEXT DEFAULT 'pending',          -- pending|paid|failed|refunded
      paid_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // 14. RE-specific WA templates
  await D.query(`
    CREATE TABLE IF NOT EXISTS re_wa_templates (
      id          SERIAL PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      label       TEXT NOT NULL,
      body        TEXT NOT NULL,
      vars        TEXT,                             -- comma-separated var names
      is_active   INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // Seed 12 default RE WA templates if empty
  const wt = await D.query(`SELECT COUNT(*)::int AS n FROM re_wa_templates`, []);
  if ((wt.rows[0] || {}).n === 0) {
    const TEMPLATES = [
      ['re_listing_share',  'Listing Share',          'Hi {name}! Here is the property you asked about — {listing}. {link}\nLet me know if you would like a site visit.'],
      ['re_visit_confirm',  'Site Visit Confirmation','Confirmed: Site visit for {listing} on {date} at {time}. Address: {address}. See you there!'],
      ['re_visit_reminder', 'Visit Reminder',         'Reminder: Your site visit for {listing} is tomorrow at {time}. Address: {address}.'],
      ['re_post_visit',     'Post-Visit Follow-up',   'Hi {name}, hope you liked {listing}. What did you think? Happy to discuss next steps.'],
      ['re_offer_received', 'Offer Acknowledgement',  'Thank you {name}! We received your offer of {offer_price} for {listing}. We will respond within 24 hrs.'],
      ['re_token_link',     'Token Payment Link',     'Hi {name}! Please pay token of {amount} for {listing} via this secure link: {payment_link}'],
      ['re_token_received', 'Token Receipt',          'Token of {amount} received for {listing}. Booking is now confirmed. Documents to follow.'],
      ['re_docs_request',   'Document Request',       'Hi {name}, please share: PAN, Aadhaar, and cancelled cheque for booking of {listing}.'],
      ['re_booking_confirm','Booking Confirmation',   'Congratulations {name}! Your booking for {listing} is confirmed. Sale deed registration on {date}.'],
      ['re_brochure_share', 'Brochure Share',         'Hi {name}! Here is the brochure for {listing}: {pdf_link}'],
      ['re_tour_link',      'Virtual Tour Link',      'Hi {name}! Take a virtual tour of {listing}: {tour_link}'],
      ['re_rent_enquiry',   'Rent Enquiry Response',  'Hi {name}! {listing} is available for rent at {price}/month. Available from {available_from}.']
    ];
    for (const t of TEMPLATES) {
      await D.query(
        `INSERT INTO re_wa_templates (code, label, body) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO NOTHING`, t);
    }
  }
}

// Wrapper that ensures both v1 and v2 tables exist
async function _ensureTables() {
  try { await _installer({ db: db }); }
  catch (e) { console.warn('[re v1 _ensureTables]:', e.message); }
  try { await _installerV2({ db: db }); }
  catch (e) { console.warn('[re v2 _ensureTables]:', e.message); }
}

async function _seedREStages() {
  for (let i = 0; i < RE_LEAD_STAGES.length; i++) {
    const s = RE_LEAD_STAGES[i];
    const found = await db.query(`SELECT id FROM statuses WHERE LOWER(name)=LOWER($1) LIMIT 1`, [s.name]);
    if (found.rows.length) {
      await db.query(
        `UPDATE statuses SET sort_order=$1, color=$2, is_final=$3 WHERE id=$4`,
        [i + 1, s.color, s.is_final ? 1 : 0, found.rows[0].id]);
    } else {
      await db.query(
        `INSERT INTO statuses (name, sort_order, color, is_final) VALUES ($1,$2,$3,$4)`,
        [s.name, i + 1, s.color, s.is_final ? 1 : 0]);
    }
  }
  const keep = RE_LEAD_STAGES.map(s => s.name.toLowerCase());
  const all = await db.query(`SELECT id, name FROM statuses`, []);
  let bottom = 100;
  for (const row of all.rows) {
    if (keep.includes(String(row.name).toLowerCase())) continue;
    const useCnt = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE status_id=$1`, [row.id]);
    if (Number(useCnt.rows[0].c) === 0) {
      try { await db.query(`DELETE FROM statuses WHERE id=$1`, [row.id]); }
      catch (_) { await db.query(`UPDATE statuses SET sort_order=$1 WHERE id=$2`, [bottom++, row.id]); }
    } else {
      await db.query(`UPDATE statuses SET sort_order=$1 WHERE id=$2`, [bottom++, row.id]);
    }
  }
}

// ── v2 APIs ────────────────────────────────────────────────────────

async function api_re_summary_v2(/*token*/) {
  await _ensureTables();
  const r1 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='available')::int  AS active_listings,
      COUNT(*) FILTER (WHERE status='available' AND transaction='sale')::int  AS for_sale,
      COUNT(*) FILTER (WHERE status='available' AND transaction='rent')::int  AS for_rent,
      COUNT(*) FILTER (WHERE virtual_tour_url IS NOT NULL OR video_tour_url IS NOT NULL)::int AS with_tours,
      COALESCE(SUM(view_count),0)::int                   AS total_views,
      COALESCE(SUM(enquiry_count),0)::int                AS total_enquiries
    FROM re_listings
  `, []);
  const r2 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='active')::int       AS active_deals,
      COUNT(*) FILTER (WHERE current_stage = 5)::int    AS in_negotiation,
      COUNT(*) FILTER (WHERE status='closed'
                       AND closed_at >= date_trunc('month', now()))::int AS closed_month,
      COALESCE(SUM(CASE WHEN status='closed' AND closed_at >= date_trunc('month', now())
                        THEN agreed_price ELSE 0 END), 0)::numeric AS revenue_month,
      COALESCE(AVG(EXTRACT(epoch FROM (closed_at - created_at))/86400)
               FILTER (WHERE status='closed'), 0)::numeric AS avg_time_to_close
    FROM re_deals
  `, []);
  const r3 = await db.query(`
    SELECT COUNT(*)::int AS n FROM re_enquiries
    WHERE created_at >= date_trunc('week', now())
  `, []);
  return {
    listings: r1.rows[0] || {},
    deals: r2.rows[0] || {},
    enquiries_this_week: (r3.rows[0] || {}).n || 0
  };
}

async function api_re_listing_list(_token, args) {
  await _ensureTables();
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.search) { params.push('%' + args.search + '%');
    where += ` AND (title ILIKE $${params.length} OR locality ILIKE $${params.length} OR landmark ILIKE $${params.length} OR rera_number ILIKE $${params.length})`; }
  if (args.transaction) { params.push(args.transaction); where += ` AND transaction=$${params.length}`; }
  if (args.type) { params.push(args.type); where += ` AND type=$${params.length}`; }
  if (args.status) { params.push(args.status); where += ` AND status=$${params.length}`; }
  if (args.bhk) { params.push(args.bhk); where += ` AND bhk=$${params.length}`; }
  if (args.locality) { params.push(args.locality); where += ` AND locality=$${params.length}`; }
  if (args.min_price) { params.push(Number(args.min_price)); where += ` AND price_inr >= $${params.length}`; }
  if (args.max_price) { params.push(Number(args.max_price)); where += ` AND price_inr <= $${params.length}`; }
  const r = await db.query(
    `SELECT l.*, (SELECT COUNT(*)::int FROM re_listing_photos WHERE listing_id=l.id) AS photo_count,
            (SELECT COUNT(*)::int FROM re_listing_tours WHERE listing_id=l.id) AS tour_count
       FROM re_listings l
       WHERE ${where}
       ORDER BY l.id DESC
       LIMIT 200`, params);
  return { listings: r.rows || [] };
}

async function api_re_listing_get(_token, args) {
  await _ensureTables();
  const id = Number((args && args.listing_id) || 0);
  if (!id) throw new Error('listing_id required');
  const lst = (await db.query(`SELECT * FROM re_listings WHERE id=$1`, [id])).rows[0];
  if (!lst) throw new Error('Listing not found');
  const ph = (await db.query(`SELECT * FROM re_listing_photos WHERE listing_id=$1 ORDER BY sort_order`, [id])).rows;
  const tr = (await db.query(`SELECT * FROM re_listing_tours WHERE listing_id=$1 ORDER BY created_at DESC`, [id])).rows;
  return { listing: lst, photos: ph, tours: tr };
}

async function api_re_listing_save(_token, args) {
  await _ensureTables();
  args = args || {};
  const id = Number(args.id || 0);
  const fields = {
    title: args.title || null,
    type: args.type || 'residential',
    transaction: args.transaction || 'sale',
    bhk: args.bhk || null,
    carpet_sqft: Number(args.carpet_sqft || 0) || null,
    super_sqft: Number(args.super_sqft || 0) || null,
    floor: Number(args.floor || 0) || null,
    total_floors: Number(args.total_floors || 0) || null,
    facing: args.facing || null,
    locality: args.locality || null,
    city: args.city || null,
    pincode: args.pincode || null,
    landmark: args.landmark || null,
    price_inr: Number(args.price_inr || 0),
    maintenance_inr: Number(args.maintenance_inr || 0) || null,
    furnished: args.furnished || null,
    available_from: args.available_from || null,
    amenities: args.amenities || null,
    description: args.description || null,
    virtual_tour_url: args.virtual_tour_url || null,
    video_tour_url: args.video_tour_url || null,
    drone_url: args.drone_url || null,
    rera_number: args.rera_number || null,
    owner_name: args.owner_name || null,
    owner_phone: args.owner_phone || null,
    status: args.status || 'available',
    updated_at: new Date()
  };
  if (id > 0) {
    const cols = Object.keys(fields);
    const sets = cols.map((c,i)=>`${c}=$${i+1}`).join(', ');
    const vals = cols.map(c=>fields[c]); vals.push(id);
    await db.query(`UPDATE re_listings SET ${sets} WHERE id=$${cols.length+1}`, vals);
    return { ok: true, id };
  } else {
    const cols = Object.keys(fields);
    const ph = cols.map((_,i)=>`$${i+1}`).join(', ');
    const r = await db.query(
      `INSERT INTO re_listings (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
      cols.map(c=>fields[c]));
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_re_listing_setStatus(_token, args) {
  await _ensureTables();
  const id = Number((args && args.listing_id) || 0);
  if (!id) throw new Error('listing_id required');
  await db.query(`UPDATE re_listings SET status=$1, updated_at=now() WHERE id=$2`,
    [args.status || 'available', id]);
  return { ok: true };
}

async function api_re_amenities_list(/*token*/) {
  await _ensureTables();
  const r = await db.query(`SELECT * FROM re_amenities ORDER BY sort_order`, []);
  return { amenities: r.rows || [] };
}

async function api_re_deal_list(_token, args) {
  await _ensureTables();
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.stage) { params.push(Number(args.stage)); where += ` AND d.current_stage=$${params.length}`; }
  if (args.status) { params.push(args.status); where += ` AND d.status=$${params.length}`; }
  const r = await db.query(
    `SELECT d.*, l.title AS listing_title, l.locality AS listing_locality,
            ld.name AS lead_name, ld.phone AS lead_phone,
            u.name AS owner_name
       FROM re_deals d
       LEFT JOIN re_listings l ON l.id=d.listing_id
       LEFT JOIN leads ld ON ld.id=d.lead_id
       LEFT JOIN users u ON u.id=d.owner_user_id
      WHERE ${where}
      ORDER BY d.id DESC`, params);
  return { deals: r.rows || [] };
}

async function api_re_deal_create(_token, args) {
  await _ensureTables();
  args = args || {};
  const r = await db.query(
    `INSERT INTO re_deals (deal_no, lead_id, listing_id, asking_price, current_stage, owner_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    ['D-' + Date.now().toString(36).toUpperCase(),
     Number(args.lead_id || 0) || null,
     Number(args.listing_id || 0) || null,
     Number(args.asking_price || 0),
     Number(args.current_stage || 1),
     Number(args.owner_user_id || 0) || null]);
  return { ok: true, deal: r.rows[0] };
}

async function api_re_deal_advance(_token, args) {
  await _ensureTables();
  const id = Number((args && args.deal_id) || 0);
  if (!id) throw new Error('deal_id required');
  const cur = (await db.query(`SELECT current_stage FROM re_deals WHERE id=$1`, [id])).rows[0];
  if (!cur) throw new Error('not found');
  const next = Math.min(8, Number(cur.current_stage) + 1);
  await db.query(
    `UPDATE re_deals SET current_stage=$1, stage_entered_at=now(),
       status = CASE WHEN $1=8 THEN 'closed' ELSE status END,
       closed_at = CASE WHEN $1=8 AND closed_at IS NULL THEN now() ELSE closed_at END
     WHERE id=$2`, [next, id]);
  return { ok: true, advanced_to: next };
}

async function api_re_match_listings(_token, args) {
  await _ensureTables();
  const reqId = Number((args && args.requirement_id) || 0);
  if (!reqId) throw new Error('requirement_id required');
  // Fetch the requirement
  const req = (await db.query(`SELECT * FROM re_requirements WHERE id=$1`, [reqId])).rows[0];
  if (!req) return { matches: [], requirement: null };

  const params = [];
  let where = "status='available'";
  if (req.transaction) { params.push(req.transaction); where += ` AND transaction=$${params.length}`; }
  if (req.bhk) { params.push(req.bhk); where += ` AND bhk=$${params.length}`; }
  if (req.min_budget) { params.push(Number(req.min_budget)); where += ` AND price_inr >= $${params.length}`; }
  if (req.max_budget) { params.push(Number(req.max_budget)); where += ` AND price_inr <= $${params.length}`; }
  if (req.locality) { params.push('%'+req.locality+'%'); where += ` AND locality ILIKE $${params.length}`; }

  const r = await db.query(
    `SELECT * FROM re_listings WHERE ${where} ORDER BY listed_at DESC LIMIT 10`, params);
  return { matches: r.rows || [], requirement: req };
}

async function api_re_market_insights(/*token*/) {
  await _ensureTables();
  // Avg price per sqft per locality (last 90 days listings)
  const r1 = await db.query(`
    SELECT locality, COUNT(*)::int AS listings,
           AVG(price_inr / NULLIF(super_sqft, 0))::numeric(12,2) AS avg_psqft
      FROM re_listings
     WHERE status IN ('available','under_offer','sold')
       AND locality IS NOT NULL AND super_sqft > 0
       AND listed_at >= now() - INTERVAL '90 days'
     GROUP BY locality
     HAVING COUNT(*) >= 3
     ORDER BY avg_psqft DESC LIMIT 12
  `, []);
  // Hot localities — most enquiries last 7 days
  const r2 = await db.query(`
    SELECT l.locality, COUNT(e.id)::int AS enquiries
      FROM re_enquiries e
      JOIN re_listings l ON l.id = e.listing_id
     WHERE e.created_at >= now() - INTERVAL '7 days'
     GROUP BY l.locality ORDER BY enquiries DESC LIMIT 10
  `, []);
  // Time-to-close by type
  const r3 = await db.query(`
    SELECT l.type, AVG(EXTRACT(epoch FROM (d.closed_at - d.created_at))/86400)::int AS avg_days
      FROM re_deals d JOIN re_listings l ON l.id = d.listing_id
     WHERE d.status='closed' GROUP BY l.type
  `, []);
  return {
    avg_per_sqft: r1.rows || [],
    hot_localities: r2.rows || [],
    time_to_close: r3.rows || []
  };
}

async function api_re_listing_analytics_track(_token, args) {
  await _ensureTables();
  args = args || {};
  await db.query(
    `INSERT INTO re_listing_analytics (listing_id, event_kind, source, referrer, meta_json)
     VALUES ($1,$2,$3,$4,$5)`,
    [Number(args.listing_id || 0), args.event_kind || 'view',
     args.source || 'direct', args.referrer || null,
     args.meta ? JSON.stringify(args.meta) : null]);
  if (args.event_kind === 'view' || !args.event_kind) {
    await db.query(`UPDATE re_listings SET view_count = view_count + 1 WHERE id=$1`, [Number(args.listing_id || 0)]);
  }
  if (args.event_kind === 'enquiry') {
    await db.query(`UPDATE re_listings SET enquiry_count = enquiry_count + 1 WHERE id=$1`, [Number(args.listing_id || 0)]);
  }
  return { ok: true };
}

async function api_re_listing_analytics(_token, args) {
  await _ensureTables();
  const id = Number((args && args.listing_id) || 0);
  if (!id) throw new Error('listing_id required');
  const k = (await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_kind='view')::int        AS views,
      COUNT(*) FILTER (WHERE event_kind='enquiry')::int     AS enquiries,
      COUNT(*) FILTER (WHERE event_kind='tour_play')::int   AS tour_plays,
      COUNT(*) FILTER (WHERE event_kind='tour_complete')::int AS tour_completes,
      COUNT(*) FILTER (WHERE event_kind='share')::int       AS shares,
      COUNT(*) FILTER (WHERE event_kind='brochure_dl')::int AS brochures
    FROM re_listing_analytics WHERE listing_id=$1
  `, [id])).rows[0] || {};
  const src = (await db.query(`
    SELECT source, COUNT(*)::int AS n FROM re_listing_analytics
     WHERE listing_id=$1 AND event_kind='enquiry' GROUP BY source
  `, [id])).rows;
  const lst = (await db.query(`SELECT * FROM re_listings WHERE id=$1`, [id])).rows[0];
  return { kpis: k, sources: src, listing: lst };
}

async function api_re_documents_list(_token, args) {
  await _ensureTables();
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.category) { params.push(args.category); where += ` AND category=$${params.length}`; }
  if (args.deal_id) { params.push(Number(args.deal_id)); where += ` AND deal_id=$${params.length}`; }
  if (args.listing_id) { params.push(Number(args.listing_id)); where += ` AND listing_id=$${params.length}`; }
  const r = await db.query(
    `SELECT * FROM re_documents WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  return { documents: r.rows || [] };
}

async function api_re_wa_templates_list(/*token*/) {
  await _ensureTables();
  const r = await db.query(`SELECT * FROM re_wa_templates WHERE is_active=1 ORDER BY id`, []);
  return { templates: r.rows || [] };
}

async function api_re_resetStages(/*token*/) {
  await _ensureTables();
  await _seedREStages();
  return { ok: true, stages: RE_LEAD_STAGES.map(s => s.name) };
}

async function api_re_seedDemoV2(/*token*/) {
  await _ensureTables();
  await _seedREStages();

  const existingL = await db.query(`SELECT COUNT(*)::int AS n FROM re_listings`, []);
  const existingD = await db.query(`SELECT COUNT(*)::int AS n FROM re_deals`, []).catch(() => ({ rows: [{ n: 0 }] }));
  const haveListings = (existingL.rows[0] || {}).n >= 15;
  const haveDeals    = (existingD.rows[0] || {}).n >= 5;
  if (haveListings && haveDeals) {
    return { ok: true, skipped: true, message: 'RE demo already present.' };
  }
  // RE_SEED_FIX_v2 — if listings exist but deals don't, skip the leads+listings block
  // and jump straight to seeding deals + analytics on existing listings.
  const skipLeadsAndListings = haveListings && !haveDeals;
  if (skipLeadsAndListings) {
    const existingListingsRows = await db.query(`SELECT id FROM re_listings ORDER BY id LIMIT 25`, []);
    var _existingListingIds = existingListingsRows.rows.map(r => r.id);
  }

  // Seed leads if too few
  const leadCount = await db.query(`SELECT COUNT(*)::int AS n FROM leads`, []);
  const need = Math.max(0, 30 - (leadCount.rows[0] || {}).n);

  const FIRST = ['Anjali','Vikram','Mehta','Krishna','Pranav','Sunita','Rohit','Priya',
                 'Aman','Karan','Riya','Rajat','Sneha','Divya','Manish','Tanya','Akash'];
  const LAST = ['Sharma','Iyer','Family','Reddy','Kapoor','Joshi','Mehta','Verma','Singh'];
  const stRows = await db.query(`SELECT id FROM statuses ORDER BY sort_order ASC LIMIT 17`, []);
  const STATUS_IDS = stRows.rows.map(r => r.id);

  const newLeadIds = [];
  for (let i = 0; i < need; i++) {
    const nm = FIRST[i % FIRST.length] + ' ' + LAST[(i*3) % LAST.length];
    const phone = '9' + String(900000000 + i * 13 + Math.floor(Math.random() * 1000)).slice(-9);
    const statusId = STATUS_IDS[i % STATUS_IDS.length] || 1;
    try {
      const r = await db.query(
        `INSERT INTO leads (name, phone, city, state, source, status_id, created_at)
         VALUES ($1,$2,'Mumbai','MH','RE Demo',$3, now() - ($4||' days')::interval)
         RETURNING id`, [nm, phone, statusId, String(i % 60)]);
      newLeadIds.push(r.rows[0].id);
    } catch (_) {}
  }

  // 25 listings across localities
  const LISTINGS = [
    ['3 BHK · 1850 sqft · Sea-facing',          'residential','sale', '3 BHK', 1850, 14, 'Bandra W', 68000000, 'Carter Road'],
    ['2 BHK · 1100 sqft · Park view',           'residential','sale', '2 BHK', 1100,  8, 'Andheri W', 32000000, '4 Bungalows'],
    ['4 BHK Villa · 4200 sqft',                  'villa',      'sale', '4 BHK', 4200,  0, 'Lonavla',   45000000, 'Khopoli Road'],
    ['Office Space · 2400 sqft',                 'commercial', 'rent', '',      2400, 12, 'Lower Parel',280000, 'Phoenix Hub'],
    ['3 BHK · 1400 sqft',                        'residential','sale', '3 BHK', 1400, 21, 'Powai',     29500000, 'Hiranandani'],
    ['Plot · 1500 sqft',                         'plot',       'sale', '',      1500,  0, 'Karjat',     6500000, 'NH-66'],
    ['3 BHK · 1620 sqft · Pali Hill',            'residential','sale', '3 BHK', 1620, 11, 'Bandra W',  54000000, 'Pali Hill'],
    ['3 BHK · 1450 sqft',                        'residential','sale', '3 BHK', 1450,  7, 'Khar W',    32000000, 'Linking Road'],
    ['2 BHK · 950 sqft',                         'residential','rent', '2 BHK',  950,  4, 'Powai',       65000, 'Hiranandani'],
    ['Office · 1800 sqft',                       'commercial', 'sale', '',      1800,  9, 'Worli',     34000000, 'Sea Link'],
    ['Studio · 450 sqft',                        'residential','rent', '1 BHK',  450,  6, 'Lower Parel', 35000, 'Phoenix'],
    ['5 BHK Sea View',                           'residential','sale', '5 BHK', 3200, 24, 'Worli',    140000000, 'Doshi Sea View'],
    ['4 BHK · 2800 sqft',                        'residential','sale', '4 BHK', 2800, 18, 'Bandra W',  92000000, 'Bandstand'],
    ['Plot · 3000 sqft',                         'plot',       'sale', '',      3000,  0, 'Lonavla',    9500000, 'Tungarli'],
    ['Farmhouse · 6000 sqft',                    'farmhouse',  'sale', '',      6000,  0, 'Karjat',    18000000, 'Karjat Hills'],
    ['2 BHK · 1050 sqft',                        'residential','sale', '2 BHK', 1050,  5, 'Andheri W', 28000000, 'JP Road'],
    ['3 BHK · 1750 sqft',                        'residential','sale', '3 BHK', 1750, 12, 'Powai',     42000000, 'Hiranandani'],
    ['Showroom · 1200 sqft',                     'commercial', 'rent', '',      1200,  0, 'Bandra W',   180000, 'Linking Road'],
    ['2 BHK · 1180 sqft',                        'residential','rent', '2 BHK', 1180,  9, 'Andheri W',   85000, 'Lokhandwala'],
    ['1 BHK · 650 sqft',                         'residential','rent', '1 BHK',  650,  3, 'Powai',       40000, 'IIT area'],
    ['4 BHK Penthouse',                          'residential','sale', '4 BHK', 3500, 28, 'Lower Parel',125000000, 'Lodha World'],
    ['Plot · 2200 sqft · Corner',                'plot',       'sale', '',      2200,  0, 'Karjat',     8200000, 'NH-66'],
    ['3 BHK · 1500 sqft',                        'residential','rent', '3 BHK', 1500, 14, 'Worli',      155000, 'Worli Sea Face'],
    ['Office · 950 sqft',                        'commercial', 'rent', '',       950,  6, 'Andheri E',   95000, 'SEEPZ'],
    ['Villa · 5500 sqft · Pool',                 'villa',      'sale', '5 BHK', 5500,  0, 'Lonavla',   62000000, 'Tungarli Lake']
  ];

  const STATUSES = ['available','available','available','available','available',
                    'under_offer','under_offer','booked','sold','rented'];

  let listingIds = skipLeadsAndListings ? _existingListingIds.slice() : [];
  if (!skipLeadsAndListings) for (let i = 0; i < LISTINGS.length; i++) {
    const L = LISTINGS[i];
    const r = await db.query(
      `INSERT INTO re_listings
         (title, type, transaction, bhk, carpet_sqft, super_sqft, floor, total_floors,
          locality, city, price_inr, landmark, status, view_count, enquiry_count,
          virtual_tour_url, video_tour_url, rera_number, owner_name, owner_phone,
          listed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Mumbai',$10,$11,$12,$13,$14,
               $15,$16,$17,$18,$19,
               now() - ($20||' days')::interval)
       RETURNING id`,
      [L[0], L[1], L[2], L[3], L[4], Math.round(L[4]*1.15), L[5], L[5]+5,
       L[6], L[7], L[8], STATUSES[i % STATUSES.length],
       Math.floor(20 + Math.random() * 280),
       Math.floor(2 + Math.random() * 20),
       i % 3 === 0 ? 'https://kuula.co/share/collection/7lFY1' : null,
       i % 5 === 0 ? 'https://www.youtube.com/embed/dQw4w9WgXcQ' : null,
       'MAH/RERA/2024/' + (10000 + i),
       'Owner ' + (i + 1),
       '98' + String(70000000 + i * 13).slice(-8),
       String(2 + (i % 90))]);
    listingIds.push(r.rows[0].id);
  }

  // 18 deals across all 8 stages
  const STAGE_DIST = [1,1,2,2,3,3,4,4,5,5,5,6,6,7,7,8,8,8];
  const allLeads = (await db.query(`SELECT id FROM leads ORDER BY id DESC LIMIT 30`, [])).rows.map(r => r.id);
  for (let i = 0; i < STAGE_DIST.length; i++) {
    const stage = STAGE_DIST[i];
    const lid = allLeads[i % allLeads.length];
    const listId = listingIds[i % listingIds.length];
    const ask = Number(LISTINGS[i % LISTINGS.length][7]) || 5000000;  // [7]=price_inr, NOT [8]=landmark text
    const isDone = stage === 8;
    await db.query(
      `INSERT INTO re_deals
         (deal_no, lead_id, listing_id, asking_price, offer_price, agreed_price,
          token_amount, current_stage, status, booked_at, closed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
               CASE WHEN $8 >= 7 THEN now() - ($10||' days')::interval ELSE NULL END,
               CASE WHEN $8 = 8 THEN now() - ($11||' days')::interval ELSE NULL END,
               now() - ($12||' days')::interval)`,
      ['D-' + (1000 + i).toString(36).toUpperCase(),
       lid, listId, ask,
       stage >= 5 ? Math.round(ask * 0.93) : null,
       isDone ? Math.round(ask * 0.95) : null,
       stage >= 7 ? Math.round(ask * 0.05) : null,
       stage, isDone ? 'closed' : 'active',
       String(7 + (i*2)), String(2 + i), String(15 + i*3)]);
  }

  // Some analytics events
  for (const lid of listingIds.slice(0, 15)) {
    const views = Math.floor(20 + Math.random() * 100);
    for (let v = 0; v < views; v++) {
      const eventKind = Math.random() < 0.85 ? 'view' : (Math.random() < 0.5 ? 'tour_play' : 'enquiry');
      const source = ['wa','website','99acres','magicbricks','referral','direct'][Math.floor(Math.random() * 6)];
      await db.query(
        `INSERT INTO re_listing_analytics (listing_id, event_kind, source, occurred_at)
         VALUES ($1,$2,$3, now() - ($4||' hours')::interval)`,
        [lid, eventKind, source, String(Math.floor(Math.random() * 720))]);
    }
  }

  return {
    ok: true,
    seeded: {
      listings: listingIds.length,
      deals: STAGE_DIST.length,
      leads_created: newLeadIds.length,
      analytics_events: '~1500'
    }
  };
}

// ── Register the pack ──────────────────────────────────────────────
framework.register({
  id:          PACK_ID,
  name:        'Real Estate',
  icon:        '🏢',
  description: 'Inventory board, bookings, demand letters, channel-partner commissions.',
  namespace:   're_',
  version:     '1.0.0',
  installer:   _installer,
  navItems: [
    { id: 'reinventory', label: 'Inventory',    icon: '🏢', view: 'reinventory' },
    { id: 'redashboard', label: 'RE Dashboard', icon: '📊', view: 'redashboard' }
  ],
  leadPanels: ['re_booking']
});

module.exports = {
  // v1 (existing)
  api_re_projects_list,
  api_re_projects_save,
  api_re_units_byProject,
  api_re_units_save,
  api_re_units_bulkCreate,
  api_re_units_bulkImport,
  api_re_booking_create,
  api_re_booking_byLead,
  api_re_demand_markPaid,
  api_re_channelPartners_list,
  api_re_channelPartners_save,
  api_re_summary,
  // v2 (new — Listings/Deals/Analytics/Docs/Insights)
  api_re_summary_v2,
  api_re_listing_list,
  api_re_listing_get,
  api_re_listing_save,
  api_re_listing_setStatus,
  api_re_amenities_list,
  api_re_deal_list,
  api_re_deal_create,
  api_re_deal_advance,
  api_re_match_listings,
  api_re_market_insights,
  api_re_listing_analytics_track,
  api_re_listing_analytics,
  api_re_documents_list,
  api_re_wa_templates_list,
  api_re_resetStages,
  api_re_seedDemoV2,
  // Constants
  RE_LEAD_STAGES,
  DEAL_STAGES,
  DEFAULT_MILESTONES
};
