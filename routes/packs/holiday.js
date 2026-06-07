/**
 * routes/packs/holiday.js — Holiday / Travel industry pack (travel agencies)
 *
 * Tables (idempotent, namespaced tour_*):
 *   tour_packages tour_bookings tour_itineraries tour_payments tour_vouchers
 * Seeds: 9 statuses, 7 custom fields, 4 sample packages.
 */
'use strict';
const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser } = require('../../utils/auth');
const PACK_ID = 'holiday';

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS tour_packages (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, destination TEXT NOT NULL DEFAULT '',
    package_type TEXT NOT NULL DEFAULT 'leisure',
    duration_days INTEGER NOT NULL DEFAULT 0, duration_nights INTEGER NOT NULL DEFAULT 0,
    base_price_per_adult NUMERIC(12,2) NOT NULL DEFAULT 0,
    base_price_per_child NUMERIC(12,2) NOT NULL DEFAULT 0,
    inclusions TEXT NOT NULL DEFAULT '', exclusions TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  await db.query(`CREATE TABLE IF NOT EXISTS tour_bookings (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, package_id INTEGER,
    booking_no TEXT NOT NULL DEFAULT '', destination TEXT NOT NULL DEFAULT '',
    travel_start_date DATE, travel_end_date DATE,
    pax_adults INTEGER NOT NULL DEFAULT 1, pax_children INTEGER NOT NULL DEFAULT 0,
    pax_infants INTEGER NOT NULL DEFAULT 0,
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    advance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    balance_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    visa_status TEXT NOT NULL DEFAULT 'not_required',
    docs_status TEXT NOT NULL DEFAULT 'pending',
    status TEXT NOT NULL DEFAULT 'confirmed',
    notes TEXT NOT NULL DEFAULT '', created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS tour_bookings_lead_idx ON tour_bookings(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS tour_itineraries (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL, day_no INTEGER NOT NULL DEFAULT 1,
    date DATE, title TEXT NOT NULL DEFAULT '', activities TEXT NOT NULL DEFAULT '',
    hotel_name TEXT NOT NULL DEFAULT '', meals TEXT NOT NULL DEFAULT '',
    transport TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS tour_itin_booking_idx ON tour_itineraries(booking_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS tour_payments (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL,
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    payment_mode TEXT NOT NULL DEFAULT '', payment_ref TEXT NOT NULL DEFAULT '',
    payment_type TEXT NOT NULL DEFAULT 'advance', notes TEXT NOT NULL DEFAULT '',
    created_by INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  await db.query(`CREATE TABLE IF NOT EXISTS tour_vouchers (
    id SERIAL PRIMARY KEY, booking_id INTEGER NOT NULL,
    voucher_type TEXT NOT NULL DEFAULT 'hotel',
    voucher_no TEXT NOT NULL DEFAULT '', vendor TEXT NOT NULL DEFAULT '',
    valid_from DATE, valid_till DATE, amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    pdf_url TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function install(opts) {
  await _ensureSchema();
  const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM tour_packages`);
  if (cnt.rows[0].n === 0) {
    const packages = [
      ['Goa Beach 4N5D','Goa, India','leisure',5,4,12000,7000,'Hotel + breakfast + airport transfers + sightseeing','Lunch / dinner / flights / personal expenses'],
      ['Dubai Family 5N6D','Dubai, UAE','family',6,5,38000,22000,'4-star hotel + flights + Burj Khalifa + Desert safari','Lunch / personal expenses / shopping'],
      ['Kerala Honeymoon 6N7D','Kerala, India','honeymoon',7,6,28000,0,'Premium houseboat + resort + breakfast + private cab','Lunch / dinner / flights'],
      ['Bali Adventure 5N6D','Bali, Indonesia','adventure',6,5,45000,28000,'Flights + 4-star hotel + breakfast + day tours','Lunch / dinner / visa']
    ];
    for (const p of packages) {
      await db.query(`INSERT INTO tour_packages (name,destination,package_type,duration_days,duration_nights,base_price_per_adult,base_price_per_child,inclusions,exclusions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, p);
    }
  }
  const STATUSES = [
    ['Inquiry','#3b82f6',1],['Itinerary Shared','#06b6d4',2],['Quote Sent','#f59e0b',3],
    ['Booking Confirmed','#10b981',4],['Advance Paid','#22c55e',5],['Docs Collected','#84cc16',6],
    ['Visa Applied','#a855f7',7],['Travel Date Approaching','#f97316',8],['In-Trip','#eab308',9],
    ['Completed','#059669',10]
  ];
  // PACK_STAGE_TAG_v1 — tag statuses with pack_id for clean industry isolation
  try { await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  try { await db.query(`ALTER TABLE lead_custom_fields ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  // Deactivate any older non-generic pack statuses to keep pipeline clean
  try { await db.query(`UPDATE statuses SET is_active=0 WHERE pack_id IS NOT NULL AND pack_id <> $1`, ['holiday']); } catch(_){}
  for (const s of STATUSES) {
    try { await db.query(`INSERT INTO statuses (name,color,sort_order,is_active,pack_id) VALUES ($1,$2,$3,1,'holiday') ON CONFLICT (name) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, s); } catch(_){}
  }
  const CFS = [
    ['destination','Destination','text'],
    ['travel_start_date','Travel Start Date','date'],
    ['travel_end_date','Travel End Date','date'],
    ['pax_adults','Adults','number'],
    ['pax_children','Children','number'],
    ['package_type','Package Type','text'],
    ['visa_status','Visa Status','text']
  ];
  for (const cf of CFS) {
    try { await db.query(`INSERT INTO lead_custom_fields (field_key,label,field_type,is_active,pack_id) VALUES ($1,$2,$3,1,'holiday') ON CONFLICT (field_key) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, cf); } catch(_){}
  }
}
async function uninstall() {}

async function api_tour_packages_list(token) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM tour_packages WHERE is_active=1 ORDER BY name`);
  return { packages: r.rows };
}
async function api_tour_packages_save(token, payload) {
  const me = await authUser(token);
  if (me.role!=='admin'&&me.role!=='manager') throw new Error('Admin / manager only');
  await _ensureSchema(); const p = payload || {};
  if (p.id) {
    await db.query(`UPDATE tour_packages SET name=$1, destination=$2, package_type=$3, duration_days=$4, duration_nights=$5, base_price_per_adult=$6, base_price_per_child=$7, inclusions=$8, exclusions=$9, is_active=$10 WHERE id=$11`,
      [p.name,p.destination||'',p.package_type||'leisure',p.duration_days||0,p.duration_nights||0,p.base_price_per_adult||0,p.base_price_per_child||0,p.inclusions||'',p.exclusions||'',p.is_active!==0?1:0,p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO tour_packages (name,destination,package_type,duration_days,duration_nights,base_price_per_adult,base_price_per_child,inclusions,exclusions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.name,p.destination||'',p.package_type||'leisure',p.duration_days||0,p.duration_nights||0,p.base_price_per_adult||0,p.base_price_per_child||0,p.inclusions||'',p.exclusions||'']);
  return { ok: true, id: r.rows[0].id };
}

async function api_tour_booking_create(token, payload) {
  const me = await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const balance = Number(p.total_amount||0) - Number(p.advance_amount||0);
  const r = await db.query(`INSERT INTO tour_bookings (lead_id,package_id,booking_no,destination,travel_start_date,travel_end_date,pax_adults,pax_children,pax_infants,total_amount,advance_amount,balance_amount,visa_status,docs_status,status,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [p.lead_id,p.package_id||null,p.booking_no||'',p.destination||'',p.travel_start_date||null,p.travel_end_date||null,p.pax_adults||1,p.pax_children||0,p.pax_infants||0,p.total_amount||0,p.advance_amount||0,balance,p.visa_status||'not_required',p.docs_status||'pending',p.status||'confirmed',p.notes||'',me.id]);
  return { ok: true, id: r.rows[0].id, balance };
}
async function api_tour_booking_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const bookings = await db.query(`SELECT b.*, p.name AS package_name FROM tour_bookings b LEFT JOIN tour_packages p ON p.id=b.package_id WHERE b.lead_id=$1 ORDER BY b.created_at DESC`, [(payload&&payload.lead_id)||0]);
  const out = [];
  for (const b of bookings.rows) {
    const itin = await db.query(`SELECT * FROM tour_itineraries WHERE booking_id=$1 ORDER BY day_no`, [b.id]);
    const pmts = await db.query(`SELECT * FROM tour_payments WHERE booking_id=$1 ORDER BY paid_at DESC`, [b.id]);
    out.push({ ...b, itinerary: itin.rows, payments: pmts.rows });
  }
  return { bookings: out };
}
async function api_tour_booking_update(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('id required');
  const balance = Number(p.total_amount||0) - Number(p.advance_amount||0);
  await db.query(`UPDATE tour_bookings SET booking_no=$1, destination=$2, travel_start_date=$3, travel_end_date=$4, pax_adults=$5, pax_children=$6, pax_infants=$7, total_amount=$8, advance_amount=$9, balance_amount=$10, visa_status=$11, docs_status=$12, status=$13, notes=$14 WHERE id=$15`,
    [p.booking_no||'',p.destination||'',p.travel_start_date||null,p.travel_end_date||null,p.pax_adults||1,p.pax_children||0,p.pax_infants||0,p.total_amount||0,p.advance_amount||0,balance,p.visa_status||'not_required',p.docs_status||'pending',p.status||'confirmed',p.notes||'',p.id]);
  return { ok: true };
}

async function api_tour_itinerary_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.booking_id) throw new Error('booking_id required');
  if (p.id) {
    await db.query(`UPDATE tour_itineraries SET day_no=$1, date=$2, title=$3, activities=$4, hotel_name=$5, meals=$6, transport=$7, notes=$8 WHERE id=$9`,
      [p.day_no||1,p.date||null,p.title||'',p.activities||'',p.hotel_name||'',p.meals||'',p.transport||'',p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO tour_itineraries (booking_id,day_no,date,title,activities,hotel_name,meals,transport,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.booking_id,p.day_no||1,p.date||null,p.title||'',p.activities||'',p.hotel_name||'',p.meals||'',p.transport||'',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}

async function api_tour_payment_add(token, payload) {
  const me = await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.booking_id) throw new Error('booking_id required');
  await db.query(`INSERT INTO tour_payments (booking_id,amount,payment_mode,payment_ref,payment_type,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [p.booking_id,p.amount||0,p.payment_mode||'',p.payment_ref||'',p.payment_type||'advance',p.notes||'',me.id]);
  // Update advance + balance
  const tot = await db.query(`SELECT COALESCE(SUM(amount),0) AS sum FROM tour_payments WHERE booking_id=$1`, [p.booking_id]);
  const totPaid = Number(tot.rows[0].sum);
  await db.query(`UPDATE tour_bookings SET advance_amount=$1, balance_amount = total_amount - $1 WHERE id=$2`, [totPaid, p.booking_id]);
  return { ok: true, total_paid: totPaid };
}

async function api_tour_voucher_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.booking_id) throw new Error('booking_id required');
  if (p.id) {
    await db.query(`UPDATE tour_vouchers SET voucher_type=$1, voucher_no=$2, vendor=$3, valid_from=$4, valid_till=$5, amount=$6, pdf_url=$7, notes=$8 WHERE id=$9`,
      [p.voucher_type||'hotel',p.voucher_no||'',p.vendor||'',p.valid_from||null,p.valid_till||null,p.amount||0,p.pdf_url||'',p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO tour_vouchers (booking_id,voucher_type,voucher_no,vendor,valid_from,valid_till,amount,pdf_url,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.booking_id,p.voucher_type||'hotel',p.voucher_no||'',p.vendor||'',p.valid_from||null,p.valid_till||null,p.amount||0,p.pdf_url||'',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_tour_voucher_byBooking(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM tour_vouchers WHERE booking_id=$1 ORDER BY created_at DESC`, [(payload&&payload.booking_id)||0]);
  return { vouchers: r.rows };
}

async function api_tour_upcomingTravel(token, payload) {
  await authUser(token); await _ensureSchema();
  const days = parseInt(((payload&&payload.days)||30), 10);
  const r = await db.query(`SELECT b.*, l.name AS lead_name, l.phone AS lead_phone FROM tour_bookings b LEFT JOIN leads l ON l.id=b.lead_id WHERE b.status NOT IN ('cancelled','completed') AND b.travel_start_date IS NOT NULL AND b.travel_start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${days} days' ORDER BY b.travel_start_date ASC LIMIT 200`);
  return { trips: r.rows };
}

async function api_tour_summary(token) {
  await authUser(token); await _ensureSchema();
  const confirmed = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total_amount),0) AS amt FROM tour_bookings WHERE status NOT IN ('cancelled','completed')`);
  const upcoming = await db.query(`SELECT COUNT(*)::int AS cnt FROM tour_bookings WHERE status NOT IN ('cancelled','completed') AND travel_start_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'`);
  const receivable = await db.query(`SELECT COALESCE(SUM(balance_amount),0) AS amt FROM tour_bookings WHERE status NOT IN ('cancelled','completed')`);
  const inTrip = await db.query(`SELECT COUNT(*)::int AS cnt FROM tour_bookings WHERE travel_start_date <= CURRENT_DATE AND travel_end_date >= CURRENT_DATE`);
  const visaPending = await db.query(`SELECT COUNT(*)::int AS cnt FROM tour_bookings WHERE visa_status NOT IN ('not_required','approved') AND status NOT IN ('cancelled','completed')`);
  return {
    confirmed: { count: confirmed.rows[0].cnt, value: Number(confirmed.rows[0].amt) },
    upcoming_30d: upcoming.rows[0].cnt,
    in_trip: inTrip.rows[0].cnt,
    receivables: Number(receivable.rows[0].amt),
    visa_pending: visaPending.rows[0].cnt
  };
}

framework.register({
  id: PACK_ID, name: 'Holiday & Travel', industry: 'holiday',
  summary: 'Travel agency — package catalog, bookings, itinerary builder, payments, vouchers.',
  version: '1.0.0',
  features: ['Package catalog (leisure / honeymoon / family / adventure)','Booking with PAX (adults/children/infants) + visa + docs status','Day-wise itinerary builder','Multi-installment payment ledger','Hotel / flight / activity vouchers','Upcoming-travel tracker (30-day window)','10 Holiday statuses + 7 custom fields seeded'],
  nav_items: [
    { id: 'tourpackages',   label: '🗺 Package Catalog', icon: '🗺' },
    { id: 'tourbookings',   label: '📅 Bookings', icon: '📅' },
    { id: 'tourupcoming',   label: '✈️ Upcoming Travel', icon: '✈️' },
    { id: 'tourvouchers',   label: '🎟 Vouchers', icon: '🎟' }
  ],
  install, uninstall
});

module.exports = {
  install, uninstall, _ensureSchema,
  api_tour_packages_list, api_tour_packages_save,
  api_tour_booking_create, api_tour_booking_byLead, api_tour_booking_update,
  api_tour_itinerary_save,
  api_tour_payment_add,
  api_tour_voucher_save, api_tour_voucher_byBooking,
  api_tour_upcomingTravel, api_tour_summary
};
