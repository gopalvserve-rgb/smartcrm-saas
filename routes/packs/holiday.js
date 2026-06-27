/**
 * routes/packs/holiday.js
 *
 * Industry Pack: Holiday / Travel (travel agency).
 *
 *   Tables (all namespaced tour_*):
 *     tour_destinations         — destination master (Bali, Goa, Dubai, etc)
 *     tour_packages             — package templates (e.g. "Bali 5N Honeymoon")
 *     tour_bookings             — confirmed bookings
 *     tour_itineraries          — itinerary container (1 per booking)
 *     tour_itinerary_days       — day-by-day plan
 *     tour_itinerary_activities — activities per day
 *     tour_payments             — receipts + balance tracking
 *     tour_amc                  — post-trip re-engagement / repeat
 *
 *   APIs (api_tour_*):
 *     api_tour_summary
 *     api_tour_destinations_list / _save
 *     api_tour_packages_list / _save
 *     api_tour_booking_create / _list / _byLead / _setStatus
 *     api_tour_itinerary_byBooking / _upsertDay / _addActivity
 *     api_tour_payment_record / _list
 *     api_tour_report_upcoming / _collection / _itineraryStatus / _agentLeaderboard
 */

'use strict';

const db        = require('../../db/pg');
const framework = require('./_framework');

const PACK_ID = 'holiday';

// Curated destination seed (so showcase + new tenants get useful data day-1)
const SEED_DESTINATIONS = [
  ['Bali',         'Indonesia',  '🇮🇩', 'honeymoon',  4,  78000, 'IDR 14k/pp/day · best Apr-Oct'],
  ['Goa',          'India',      '🌴', 'leisure',    3,  18000, 'Domestic · winter peak'],
  ['Dubai',        'UAE',        '🇦🇪', 'leisure',    4,  85000, 'Sept-Apr best · visa on arrival'],
  ['Switzerland',  'Europe',     '🇨🇭', 'family',     9, 220000, 'Schengen visa needed · summer best'],
  ['Thailand',     'Thailand',   '🇹🇭', 'leisure',    5,  65000, 'VoA · Bangkok+Phuket combo'],
  ['Maldives',     'Maldives',   '🇲🇻', 'honeymoon',  5, 165000, 'Water villa premium'],
  ['Kashmir',      'India',      '🏔️', 'family',     6,  42000, 'Apr-Oct best · Mar-Apr cherry blossom'],
  ['Vietnam',      'Vietnam',    '🇻🇳', 'adventure',  7,  72000, 'eVisa · Ha Long + Sapa combo'],
  ['Singapore',    'Singapore',  '🇸🇬', 'family',     4,  92000, 'e-visa available'],
  ['Andaman',      'India',      '🏝️', 'honeymoon',  5,  58000, 'Domestic flight + ferry'],
  ['Japan',        'Japan',      '🇯🇵', 'adventure',  8, 285000, 'Cherry blossom Mar-Apr'],
  ['Europe (Multi)','Europe',    '🇪🇺', 'family',    12, 380000, 'Schengen · UK + Paris + Rome']
];

// Itinerary day template options (admin-extendable)
const ACTIVITY_TYPES = ['arrival', 'sightseeing', 'meal', 'transfer', 'leisure',
                        'adventure', 'shopping', 'departure'];

// ── Installer ─────────────────────────────────────────────────────
async function _installer({ db: D }) {
  // 1. Destinations
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_destinations (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      country     TEXT,
      flag        TEXT,
      kind        TEXT,                     -- honeymoon|family|leisure|adventure|business
      avg_days    INT,
      avg_price_inr NUMERIC(12,2),
      notes       TEXT,
      is_active   INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // Seed destinations if empty
  const dc = await D.query(`SELECT COUNT(*)::int AS n FROM tour_destinations`, []);
  if ((dc.rows[0] || {}).n === 0) {
    for (const d of SEED_DESTINATIONS) {
      await D.query(
        `INSERT INTO tour_destinations (name, country, flag, kind, avg_days, avg_price_inr, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, d
      );
    }
  }

  // 2. Packages (saved package templates)
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_packages (
      id              SERIAL PRIMARY KEY,
      destination_id  INT,
      name            TEXT NOT NULL,
      kind            TEXT,                 -- honeymoon|family|leisure|adventure
      pax             INT DEFAULT 2,
      duration_nights INT,
      price_inr       NUMERIC(12,2),
      inclusions      TEXT,                 -- pipe-separated list
      exclusions      TEXT,
      is_active       INT NOT NULL DEFAULT 1,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_packages_dest_idx ON tour_packages(destination_id)`, []);

  // 3. Bookings
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_bookings (
      id                SERIAL PRIMARY KEY,
      lead_id           INT,
      destination_id    INT,
      package_id        INT,
      booking_no        TEXT,
      travellers        INT DEFAULT 2,
      travel_start_date DATE,
      travel_end_date   DATE,
      total_inr         NUMERIC(14,2) DEFAULT 0,
      advance_inr       NUMERIC(14,2) DEFAULT 0,
      balance_inr       NUMERIC(14,2) DEFAULT 0,
      cost_inr          NUMERIC(14,2) DEFAULT 0,
      visa_status       TEXT,               -- na|pending|approved|rejected
      docs_status       TEXT,               -- pending|partial|complete
      voucher_status    TEXT,               -- pending|generated|sent
      assignee_user_id  INT,
      source            TEXT,
      status            TEXT NOT NULL DEFAULT 'enquiry',  -- enquiry|quoted|booked|confirmed|traveling|completed|cancelled
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_bookings_lead_idx ON tour_bookings(lead_id)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_bookings_travel_idx ON tour_bookings(travel_start_date)`, []);

  // 4. Itineraries
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_itineraries (
      id          SERIAL PRIMARY KEY,
      booking_id  INT NOT NULL,
      title       TEXT,
      status      TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|acknowledged
      pdf_url     TEXT,
      sent_at     TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_itineraries_booking_idx ON tour_itineraries(booking_id)`, []);

  // 5. Itinerary days
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_itinerary_days (
      id              SERIAL PRIMARY KEY,
      itinerary_id    INT NOT NULL,
      day_no          INT NOT NULL,
      day_date        DATE,
      city            TEXT,
      hotel_name      TEXT,
      room_type       TEXT,
      meal_plan       TEXT,                 -- bb | hb | fb | none
      notes           TEXT
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_itin_days_idx ON tour_itinerary_days(itinerary_id)`, []);

  // 6. Itinerary activities
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_itinerary_activities (
      id          SERIAL PRIMARY KEY,
      day_id      INT NOT NULL,
      seq         INT NOT NULL DEFAULT 1,
      time_str    TEXT,                     -- '09:00 AM'
      kind        TEXT,                     -- arrival|sightseeing|meal|transfer|leisure|adventure|shopping|departure
      title       TEXT,
      detail      TEXT
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_itin_act_idx ON tour_itinerary_activities(day_id)`, []);

  // 7. Payments
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_payments (
      id          SERIAL PRIMARY KEY,
      booking_id  INT NOT NULL,
      amount_inr  NUMERIC(14,2) NOT NULL,
      mode        TEXT,                     -- cash|upi|card|bank|cheque
      ref_no      TEXT,
      paid_at     DATE NOT NULL DEFAULT CURRENT_DATE,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS tour_payments_booking_idx ON tour_payments(booking_id)`, []);

  // 8. AMC / re-engagement
  await D.query(`
    CREATE TABLE IF NOT EXISTS tour_amc (
      id          SERIAL PRIMARY KEY,
      lead_id     INT,
      booking_id  INT,
      kind        TEXT,                     -- feedback|next_trip_pitch|referral_ask
      due_at      DATE,
      done_at     TIMESTAMPTZ,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
}

// ── Helpers ──────────────────────────────────────────────────────
function _money(n) { return Number(n || 0); }

// ── APIs ─────────────────────────────────────────────────────────

async function api_tour_summary(/*token*/) {
  await _ensureTables();
  const r1 = await db.query(`
    SELECT
      COUNT(*)::int                                                  AS bookings_total,
      COUNT(*) FILTER (WHERE status IN ('booked','confirmed','traveling'))::int AS bookings_active,
      COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int    AS bookings_month,
      COALESCE(SUM(CASE WHEN created_at >= date_trunc('month', now()) THEN total_inr ELSE 0 END),0)::numeric AS revenue_month,
      COUNT(*) FILTER (WHERE status='traveling')::int                          AS travelling_now,
      COUNT(*) FILTER (WHERE travel_start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days')::int AS upcoming_30d
    FROM tour_bookings
  `, []);
  const r2 = await db.query(`
    SELECT
      COALESCE(SUM(balance_inr) FILTER (WHERE status IN ('booked','confirmed','traveling')),0)::numeric AS outstanding,
      COALESCE(SUM(balance_inr) FILTER (WHERE status IN ('booked','confirmed','traveling')
                                          AND travel_start_date < CURRENT_DATE),0)::numeric AS overdue,
      COUNT(*) FILTER (WHERE visa_status='pending')::int                                   AS visa_pending
    FROM tour_bookings
  `, []);
  const r3 = await db.query(`
    SELECT COUNT(*)::int AS itin_no_plan
      FROM tour_bookings b
      LEFT JOIN tour_itineraries i ON i.booking_id = b.id
     WHERE i.id IS NULL AND b.status IN ('booked','confirmed','traveling')
  `, []);

  return {
    bookings: r1.rows[0] || {},
    money:    r2.rows[0] || {},
    itineraries: r3.rows[0] || {}
  };
}

async function api_tour_destinations_list(/*token*/) {
  await _ensureTables();
  const r = await db.query(
    `SELECT * FROM tour_destinations WHERE is_active=1 ORDER BY name ASC`, []);
  return { destinations: r.rows || [] };
}

async function api_tour_destinations_save(_token, args) {
  args = args || {};
  const id = Number(args.id || 0);
  const fields = {
    name: args.name || null,
    country: args.country || null,
    flag: args.flag || null,
    kind: args.kind || null,
    avg_days: Number(args.avg_days || 0) || null,
    avg_price_inr: Number(args.avg_price_inr || 0) || null,
    notes: args.notes || null,
    is_active: args.is_active === 0 ? 0 : 1
  };
  if (id > 0) {
    const cols = Object.keys(fields);
    const sets = cols.map((c,i)=>`${c}=$${i+1}`).join(', ');
    const vals = cols.map(c=>fields[c]); vals.push(id);
    await db.query(`UPDATE tour_destinations SET ${sets} WHERE id=$${cols.length+1}`, vals);
    return { ok: true, id };
  } else {
    const cols = Object.keys(fields);
    const ph = cols.map((_,i)=>`$${i+1}`).join(', ');
    const r = await db.query(
      `INSERT INTO tour_destinations (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
      cols.map(c=>fields[c]));
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_tour_packages_list(_token, args) {
  await _ensureTables();
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.destination_id) {
    params.push(Number(args.destination_id));
    where += ` AND p.destination_id = $${params.length}`;
  }
  const r = await db.query(
    `SELECT p.*, d.name AS destination_name, d.flag
       FROM tour_packages p
       LEFT JOIN tour_destinations d ON d.id = p.destination_id
      WHERE ${where} AND p.is_active=1
      ORDER BY p.id DESC`, params);
  return { packages: r.rows || [] };
}

async function api_tour_packages_save(_token, args) {
  args = args || {};
  const id = Number(args.id || 0);
  const fields = {
    destination_id: Number(args.destination_id || 0) || null,
    name: args.name || null,
    kind: args.kind || null,
    pax: Number(args.pax || 2),
    duration_nights: Number(args.duration_nights || 0) || null,
    price_inr: Number(args.price_inr || 0) || null,
    inclusions: args.inclusions || null,
    exclusions: args.exclusions || null,
    is_active: args.is_active === 0 ? 0 : 1
  };
  if (id > 0) {
    const cols = Object.keys(fields);
    const sets = cols.map((c,i)=>`${c}=$${i+1}`).join(', ');
    const vals = cols.map(c=>fields[c]); vals.push(id);
    await db.query(`UPDATE tour_packages SET ${sets} WHERE id=$${cols.length+1}`, vals);
    return { ok: true, id };
  } else {
    const cols = Object.keys(fields);
    const ph = cols.map((_,i)=>`$${i+1}`).join(', ');
    const r = await db.query(
      `INSERT INTO tour_packages (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
      cols.map(c=>fields[c]));
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_tour_booking_create(_token, args) {
  args = args || {};
  const lead_id   = Number(args.lead_id || 0) || null;
  const total     = Number(args.total_inr || 0);
  const advance   = Number(args.advance_inr || 0);
  const balance   = Math.max(0, total - advance);
  const r = await db.query(
    `INSERT INTO tour_bookings
       (lead_id, destination_id, package_id, booking_no, travellers,
        travel_start_date, travel_end_date, total_inr, advance_inr, balance_inr,
        cost_inr, visa_status, docs_status, voucher_status, assignee_user_id, source, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      lead_id,
      Number(args.destination_id || 0) || null,
      Number(args.package_id || 0) || null,
      'WW-' + Date.now().toString(36).toUpperCase(),
      Number(args.travellers || 2),
      args.travel_start_date || null,
      args.travel_end_date   || null,
      total, advance, balance,
      Number(args.cost_inr || total * 0.78),
      args.visa_status   || 'na',
      args.docs_status   || 'pending',
      args.voucher_status|| 'pending',
      Number(args.assignee_user_id || 0) || null,
      args.source || null,
      args.status || 'booked'
    ]
  );
  return { ok: true, booking: r.rows[0] || null };
}

async function api_tour_booking_list(_token, args) {
  await _ensureTables();
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.status) { params.push(args.status); where += ` AND b.status = $${params.length}`; }
  if (args.destination_id) { params.push(Number(args.destination_id)); where += ` AND b.destination_id = $${params.length}`; }
  if (args.from_date) { params.push(args.from_date); where += ` AND b.travel_start_date >= $${params.length}`; }
  if (args.to_date)   { params.push(args.to_date);   where += ` AND b.travel_start_date <= $${params.length}`; }

  const r = await db.query(
    `SELECT b.*, l.name AS lead_name, l.phone AS lead_phone,
            d.name AS destination_name, d.flag,
            u.name AS assignee_name
       FROM tour_bookings b
       LEFT JOIN leads l ON l.id = b.lead_id
       LEFT JOIN tour_destinations d ON d.id = b.destination_id
       LEFT JOIN users u ON u.id = b.assignee_user_id
      WHERE ${where}
      ORDER BY b.travel_start_date ASC NULLS LAST, b.id DESC`, params);
  return { bookings: r.rows || [] };
}

async function api_tour_booking_byLead(_token, args) {
  const leadId = Number((args && args.lead_id) || 0);
  if (!leadId) return { bookings: [] };
  const r = await db.query(
    `SELECT b.*, d.name AS destination_name, d.flag
       FROM tour_bookings b
       LEFT JOIN tour_destinations d ON d.id = b.destination_id
      WHERE b.lead_id=$1 ORDER BY b.id DESC`, [leadId]);
  return { bookings: r.rows || [] };
}

async function api_tour_booking_setStatus(_token, args) {
  const id = Number((args && args.booking_id) || 0);
  if (!id) throw new Error('booking_id required');
  await db.query(
    `UPDATE tour_bookings SET status = $1 WHERE id = $2`,
    [args.status || 'booked', id]);
  return { ok: true };
}

async function api_tour_itinerary_byBooking(_token, args) {
  const bid = Number((args && args.booking_id) || 0);
  if (!bid) return { itinerary: null, days: [], activities: [] };
  let it = (await db.query(
    `SELECT * FROM tour_itineraries WHERE booking_id=$1 ORDER BY id DESC LIMIT 1`,
    [bid])).rows[0] || null;
  if (!it) {
    // Auto-create empty itinerary
    const ins = await db.query(
      `INSERT INTO tour_itineraries (booking_id, title, status)
       VALUES ($1,$2,'draft') RETURNING *`,
      [bid, 'Itinerary for Booking #' + bid]);
    it = ins.rows[0];
  }
  const days = (await db.query(
    `SELECT * FROM tour_itinerary_days WHERE itinerary_id=$1 ORDER BY day_no ASC`,
    [it.id])).rows;
  const acts = days.length
    ? (await db.query(
        `SELECT * FROM tour_itinerary_activities WHERE day_id = ANY($1::int[]) ORDER BY day_id, seq`,
        [days.map(d => d.id)])).rows
    : [];
  return { itinerary: it, days: days, activities: acts };
}

async function api_tour_itinerary_upsertDay(_token, args) {
  args = args || {};
  const id = Number(args.id || 0);
  const fields = {
    itinerary_id: Number(args.itinerary_id || 0),
    day_no: Number(args.day_no || 1),
    day_date: args.day_date || null,
    city: args.city || null,
    hotel_name: args.hotel_name || null,
    room_type: args.room_type || null,
    meal_plan: args.meal_plan || null,
    notes: args.notes || null
  };
  if (id > 0) {
    const cols = Object.keys(fields);
    const sets = cols.map((c,i)=>`${c}=$${i+1}`).join(', ');
    const vals = cols.map(c=>fields[c]); vals.push(id);
    await db.query(`UPDATE tour_itinerary_days SET ${sets} WHERE id=$${cols.length+1}`, vals);
    return { ok: true, id };
  } else {
    const cols = Object.keys(fields);
    const ph = cols.map((_,i)=>`$${i+1}`).join(', ');
    const r = await db.query(
      `INSERT INTO tour_itinerary_days (${cols.join(', ')}) VALUES (${ph}) RETURNING id`,
      cols.map(c=>fields[c]));
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_tour_itinerary_addActivity(_token, args) {
  args = args || {};
  const r = await db.query(
    `INSERT INTO tour_itinerary_activities (day_id, seq, time_str, kind, title, detail)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [Number(args.day_id || 0), Number(args.seq || 1),
     args.time_str || null, args.kind || 'sightseeing',
     args.title || '', args.detail || null]);
  return { ok: true, id: r.rows[0].id };
}

async function api_tour_payment_record(_token, args) {
  args = args || {};
  const bid = Number(args.booking_id || 0);
  const amt = Number(args.amount_inr || 0);
  if (!bid || !amt) throw new Error('booking_id + amount_inr required');

  await db.query(
    `INSERT INTO tour_payments (booking_id, amount_inr, mode, ref_no, paid_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [bid, amt, args.mode || 'cash', args.ref_no || null,
     args.paid_at || null, args.notes || null]);

  await db.query(
    `UPDATE tour_bookings
        SET advance_inr = advance_inr + $1,
            balance_inr = GREATEST(0, balance_inr - $1)
      WHERE id = $2`, [amt, bid]);
  return { ok: true };
}

async function api_tour_payment_list(_token, args) {
  const bid = Number((args && args.booking_id) || 0);
  if (!bid) return { payments: [] };
  const r = await db.query(
    `SELECT * FROM tour_payments WHERE booking_id=$1 ORDER BY paid_at DESC, id DESC`,
    [bid]);
  return { payments: r.rows || [] };
}

// ── Reports ──────────────────────────────────────────────────────

async function api_tour_report_upcoming(_token, args) {
  args = args || {};
  const within = Number(args.days || 30);
  const r = await db.query(
    `SELECT b.*, l.name AS lead_name, l.phone AS lead_phone,
            d.name AS destination_name, d.flag,
            (b.travel_start_date - CURRENT_DATE)::int AS days_to_travel
       FROM tour_bookings b
       LEFT JOIN leads l ON l.id = b.lead_id
       LEFT JOIN tour_destinations d ON d.id = b.destination_id
      WHERE b.status IN ('booked','confirmed','traveling')
        AND b.travel_start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ($1 || ' days')::interval
      ORDER BY b.travel_start_date ASC`,
    [String(within)]);
  return { bookings: r.rows || [] };
}

async function api_tour_report_collection(/*token*/) {
  // KPIs + per-booking outstanding
  const k = await db.query(`
    SELECT
      COALESCE(SUM(balance_inr) FILTER (WHERE status IN ('booked','confirmed','traveling')),0)::numeric AS outstanding,
      COALESCE(SUM(balance_inr) FILTER (WHERE status IN ('booked','confirmed','traveling')
                                          AND travel_start_date < CURRENT_DATE),0)::numeric AS overdue,
      COALESCE(SUM(balance_inr) FILTER (WHERE status IN ('booked','confirmed','traveling')
                                          AND travel_start_date BETWEEN CURRENT_DATE
                                            AND CURRENT_DATE + INTERVAL '7 days'),0)::numeric AS due_7d,
      COALESCE(SUM(advance_inr) FILTER (WHERE created_at >= date_trunc('month', now())),0)::numeric AS collected_month
    FROM tour_bookings
  `, []);
  const rows = await db.query(`
    SELECT b.*, l.name AS lead_name, d.name AS destination_name, d.flag,
           (b.travel_start_date - CURRENT_DATE)::int AS days_to_travel
      FROM tour_bookings b
      LEFT JOIN leads l ON l.id = b.lead_id
      LEFT JOIN tour_destinations d ON d.id = b.destination_id
     WHERE b.status IN ('booked','confirmed','traveling') AND b.balance_inr > 0
     ORDER BY b.travel_start_date ASC NULLS LAST
  `, []);
  return { kpis: k.rows[0] || {}, bookings: rows.rows || [] };
}

async function api_tour_report_itineraryStatus(/*token*/) {
  const r = await db.query(`
    SELECT b.id AS booking_id, b.booking_no, b.travel_start_date,
           (b.travel_start_date - CURRENT_DATE)::int AS days_to_travel,
           l.name AS lead_name, d.name AS destination_name, d.flag,
           i.id AS itinerary_id, i.status AS itin_status,
           COALESCE((SELECT COUNT(*)::int FROM tour_itinerary_days WHERE itinerary_id = i.id), 0) AS days_planned,
           CASE
             WHEN b.travel_end_date IS NOT NULL AND b.travel_start_date IS NOT NULL
               THEN (b.travel_end_date - b.travel_start_date) + 1
             ELSE NULL
           END AS total_days
      FROM tour_bookings b
      LEFT JOIN leads l ON l.id = b.lead_id
      LEFT JOIN tour_destinations d ON d.id = b.destination_id
      LEFT JOIN tour_itineraries i ON i.booking_id = b.id
     WHERE b.status IN ('booked','confirmed','traveling')
     ORDER BY b.travel_start_date ASC NULLS LAST
  `, []);
  return { rows: r.rows || [] };
}

async function api_tour_report_agentLeaderboard(_token, args) {
  args = args || {};
  const within = Number(args.days || 30);
  const r = await db.query(
    `SELECT u.id, u.name,
            COUNT(b.id)::int                                                  AS bookings,
            COALESCE(SUM(b.total_inr),0)::numeric                             AS revenue,
            COALESCE(AVG(b.total_inr),0)::numeric                             AS avg_ticket
       FROM users u
       LEFT JOIN tour_bookings b ON b.assignee_user_id = u.id
            AND b.created_at >= now() - ($1 || ' days')::interval
       WHERE u.is_active = 1
       GROUP BY u.id, u.name
      HAVING COUNT(b.id) > 0
       ORDER BY revenue DESC`,
    [String(within)]);
  return { agents: r.rows || [] };
}


// Holiday lead pipeline (matches PACK_STAGES in tenantApi.js)
const HOLIDAY_LEAD_STAGES = [
  { name: 'New Enquiry',             color: '#3b82f6' },
  { name: 'Destination Shared',      color: '#06b6d4' },
  { name: 'Quote / Itinerary Sent',  color: '#8b5cf6' },
  { name: 'Quote Accepted',          color: '#f59e0b' },
  { name: 'Booked / Advance Paid',   color: '#ec4899' },
  { name: 'Visa In Progress',        color: '#f97316' },
  { name: 'Documents Ready',         color: '#84cc16' },
  { name: 'Travelling',              color: '#0d9488' },
  { name: 'Trip Completed',          color: '#16a34a', is_final: 1 },
  { name: 'Repeat Customer',         color: '#15803d' },
  { name: 'Cancelled',               color: '#6b7280', is_final: 1 }
];

async function _ensureTables() {
  try { await _installer({ db: db }); }
  catch (e) { console.warn('[holiday] _ensureTables:', e.message); }
}

async function _seedHolidayStages() {
  for (let i = 0; i < HOLIDAY_LEAD_STAGES.length; i++) {
    const s = HOLIDAY_LEAD_STAGES[i];
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
  const keep = HOLIDAY_LEAD_STAGES.map(s => s.name.toLowerCase());
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

async function api_tour_resetStages(/*token*/) {
  await _ensureTables();
  await _seedHolidayStages();
  return { ok: true, stages: HOLIDAY_LEAD_STAGES.map(s => s.name) };
}

async function api_tour_seedDemo(/*token*/) {
  await _ensureTables();
  await _seedHolidayStages();

  const existing = await db.query(`SELECT COUNT(*)::int AS n FROM tour_bookings`, []);
  if ((existing.rows[0] || {}).n >= 20) {
    return { ok: true, skipped: true, message: 'Demo data already present (Holiday stages still re-applied).' };
  }

  // Pre-load destination IDs
  const destRows = await db.query(`SELECT id, name FROM tour_destinations ORDER BY id ASC`, []);
  const destinations = destRows.rows;
  if (!destinations.length) {
    return { ok: false, error: 'No destinations found. Pack installer should have seeded these.' };
  }

  // Pre-load lead status_ids
  const stRows = await db.query(`SELECT id FROM statuses ORDER BY sort_order ASC LIMIT 11`, []);
  const STATUS_IDS = stRows.rows.map(r => r.id);

  // Create ~30 leads if we need them
  const leadCount = await db.query(`SELECT COUNT(*)::int AS n FROM leads`, []);
  const need = Math.max(0, 30 - (leadCount.rows[0] || {}).n);

  const FIRST = ['Anjali','Rohan','Mira','Vikram','Sneha','Pranav','Krishna','Sunita',
                 'Arjun','Pradeep','Rajeev','Geeta','Sanjay','Lalit','Kapil','Riya',
                 'Karan','Aman','Anita','Rahul','Tanya','Vinay','Pooja','Amit',
                 'Sahil','Neha','Akash','Divya','Manish','Ritu'];
  const LAST = ['Sharma','Verma','Iyer','Kapoor','Joshi','Patel','Singh','Khanna',
                'Mehta','Reddy','Nair','Roy','Gupta','Kumar','Devi'];
  const CITIES = [['Mumbai','MH'],['Delhi','DL'],['Bengaluru','KA'],['Pune','MH'],
                  ['Ahmedabad','GJ'],['Hyderabad','TS'],['Chennai','TN'],['Kolkata','WB']];
  const newLeadIds = [];
  for (let i = 0; i < need; i++) {
    const nm = FIRST[i % FIRST.length] + ' ' + LAST[(i * 3) % LAST.length];
    const city = CITIES[i % CITIES.length];
    const phone = '9' + String(700000000 + i * 11 + Math.floor(Math.random() * 1000)).slice(-9);
    const statusId = STATUS_IDS[i % STATUS_IDS.length] || 1;
    try {
      const r = await db.query(
        `INSERT INTO leads (name, phone, city, state, source, status_id, created_at)
         VALUES ($1,$2,$3,$4,'Holiday Demo', $5, now() - ($6 || ' days')::interval)
         RETURNING id`,
        [nm, phone, city[0], city[1], statusId, String(i % 60)]);
      newLeadIds.push(r.rows[0].id);
    } catch (_) {}
  }

  const allLeads = await db.query(`SELECT id, name FROM leads ORDER BY id DESC LIMIT 30`, []);
  const leads = allLeads.rows;
  if (leads.length < 12) {
    return { ok: false, error: 'Need at least 12 leads. Have ' + leads.length };
  }

  // Create 25 bookings spread across destinations, statuses, future + past travel dates
  const STATUSES = ['enquiry','quoted','quoted','booked','booked','booked','confirmed',
                    'confirmed','confirmed','traveling','completed','completed','cancelled'];
  const VISA = ['na','na','approved','pending','pending','rejected'];
  const DOCS = ['complete','pending','partial','complete'];
  const PAX_OPTS = [2, 2, 2, 3, 4, 2, 5];

  const created = [];
  for (let i = 0; i < 25; i++) {
    const L = leads[i % leads.length];
    const d = destinations[i % destinations.length];
    const status = STATUSES[i % STATUSES.length];
    const travelOffset = (i % 3 === 0) ? -10 - (i % 30)  // past travel (some completed)
                                       : 3 + (i % 60);   // future
    const pax = PAX_OPTS[i % PAX_OPTS.length];
    const total = Math.round((Number(d.avg_price_inr) * pax) * (0.9 + Math.random() * 0.4));
    const advancePct = status === 'enquiry' ? 0
                     : status === 'quoted' ? 0
                     : status === 'cancelled' ? 0.5
                     : 0.3 + Math.random() * 0.5;
    const advance = Math.round(total * advancePct);
    const balance = Math.max(0, total - advance);
    const days = (i % 6 === 0) ? 4 + (i % 5) : 5 + (i % 8);

    const r = await db.query(
      `INSERT INTO tour_bookings
         (lead_id, destination_id, booking_no, travellers,
          travel_start_date, travel_end_date,
          total_inr, advance_inr, balance_inr, cost_inr,
          visa_status, docs_status, voucher_status, source, status, created_at)
       VALUES ($1,$2,$3,$4,
               (CURRENT_DATE + ($5 || ' days')::interval)::date,
               (CURRENT_DATE + (($5::int + $6) || ' days')::interval)::date,
               $7,$8,$9,$10, $11,$12,$13, 'Solar Demo', $14,
               now() - ($15 || ' days')::interval)
       RETURNING id`,
      [L.id, d.id, 'WW-' + (3000 + i).toString(36).toUpperCase(), pax,
       String(travelOffset), days,
       total, advance, balance, Math.round(total * 0.72),
       VISA[i % VISA.length], DOCS[i % DOCS.length],
       i < 5 ? 'sent' : 'pending',
       status, String(15 + i * 2)]);

    created.push({ booking_id: r.rows[0].id, days, dest: d, status });

    // 4. Itinerary for booked/confirmed/traveling/completed
    if (['booked', 'confirmed', 'traveling', 'completed'].includes(status)) {
      const itinR = await db.query(
        `INSERT INTO tour_itineraries (booking_id, title, status, sent_at)
         VALUES ($1, $2, $3, CASE WHEN $3 IN ('sent','acknowledged') THEN now() ELSE NULL END)
         RETURNING id`,
        [r.rows[0].id, d.name + ' · ' + days + 'N for ' + L.name,
         ['draft','sent','sent','acknowledged'][i % 4]]);
      const itinId = itinR.rows[0].id;
      // Add days (3-7 days)
      const dayCount = Math.min(days + 1, 7);
      for (let dy = 1; dy <= dayCount; dy++) {
        const dayR = await db.query(
          `INSERT INTO tour_itinerary_days
             (itinerary_id, day_no, city, hotel_name, room_type, meal_plan, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [itinId, dy, d.name,
           ['Beach Resort','City Hotel','Boutique Hotel','Wellness Resort'][dy % 4],
           dy === 1 ? 'Deluxe' : 'Premium',
           'bb', dy === 1 ? 'Arrival day' : 'Sightseeing']);
        // Add 2-3 activities per day
        const acts = [
          ['09:00 AM', 'sightseeing', 'Morning local tour', 'Visit key landmarks'],
          ['01:00 PM', 'meal', 'Lunch at local cuisine', 'Try regional dishes'],
          ['04:00 PM', 'leisure', 'Free time', 'Beach / spa / shopping']
        ];
        for (let a = 0; a < acts.length; a++) {
          await db.query(
            `INSERT INTO tour_itinerary_activities (day_id, seq, time_str, kind, title, detail)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [dayR.rows[0].id, a + 1, acts[a][0], acts[a][1], acts[a][2], acts[a][3]]);
        }
      }
    }

    // 5. Payments — record advance receipt for booked+ statuses
    if (['booked', 'confirmed', 'traveling', 'completed'].includes(status) && advance > 0) {
      await db.query(
        `INSERT INTO tour_payments (booking_id, amount_inr, mode, ref_no, paid_at, notes)
         VALUES ($1,$2,$3,$4, CURRENT_DATE - ($5 || ' days')::interval, $6)`,
        [r.rows[0].id, advance,
         ['upi','bank','card','cash'][i % 4],
         'PMT-' + (50000 + i),
         String(15 + i * 2),
         'Advance receipt']);
      // Some completed get full balance too
      if (status === 'completed' && balance > 0) {
        await db.query(
          `INSERT INTO tour_payments (booking_id, amount_inr, mode, paid_at, notes)
           VALUES ($1,$2,$3, CURRENT_DATE - ($4 || ' days')::interval, $5)`,
          [r.rows[0].id, balance, 'bank',
           String(5 + i), 'Final settlement']);
        // Zero out balance after final payment
        await db.query(
          `UPDATE tour_bookings SET advance_inr = total_inr, balance_inr = 0 WHERE id=$1`,
          [r.rows[0].id]);
      }
    }
  }

  return {
    ok: true,
    seeded: {
      leads_created: newLeadIds.length,
      bookings: created.length,
      with_itinerary: created.filter(c => ['booked','confirmed','traveling','completed'].includes(c.status)).length,
      destinations_used: new Set(created.map(c => c.dest.id)).size
    }
  };
}

// ── Register the pack ─────────────────────────────────────────────
framework.register({
  id:          PACK_ID,
  name:        'Holiday / Travel',
  icon:        '✈️',
  description: 'Travel agency — destinations, packages, bookings, itinerary builder, collection, reports.',
  namespace:   'tour_',
  version:     '1.0.0',
  installer:   _installer,
  navItems: [
    { id: 'packholiday',      label: 'Travel Overview',     icon: '✈️', view: 'packholiday' },
    { id: 'tourbookings',     label: 'Bookings',            icon: '🎫', view: 'tourbookings' },
    { id: 'tourdestinations', label: 'Destinations',        icon: '🌍', view: 'tourdestinations' },
    { id: 'touritinerary',    label: 'Itinerary Builder',   icon: '🗺️', view: 'touritinerary' },
    { id: 'tourpayments',     label: 'Payments & Collection', icon: '💰', view: 'tourpayments' },
    { id: 'tourreports',      label: 'Travel Reports',      icon: '📊', view: 'tourreports' },
    { id: 'tourinsights',     label: 'AI Insights',         icon: '🤖', view: 'tourinsights' }
  ],
  leadPanels: ['tour_booking']
});

module.exports = {
  api_tour_summary,
  api_tour_destinations_list,
  api_tour_destinations_save,
  api_tour_packages_list,
  api_tour_packages_save,
  api_tour_booking_create,
  api_tour_booking_list,
  api_tour_booking_byLead,
  api_tour_booking_setStatus,
  api_tour_itinerary_byBooking,
  api_tour_itinerary_upsertDay,
  api_tour_itinerary_addActivity,
  api_tour_payment_record,
  api_tour_payment_list,
  api_tour_report_upcoming,
  api_tour_report_collection,
  api_tour_report_itineraryStatus,
  api_tour_report_agentLeaderboard,
  api_tour_resetStages,
  api_tour_seedDemo,
  SEED_DESTINATIONS,
  ACTIVITY_TYPES,
  HOLIDAY_LEAD_STAGES,
  _installer
};
