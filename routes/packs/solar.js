/**
 * routes/packs/solar.js
 *
 * Industry Pack: Solar (rooftop / utility solar installer).
 *
 *   Tables (all namespaced sol_*):
 *     sol_sites               — site survey records (1+ per lead)
 *     sol_pricing_config      — ₹/W rates per panel tier + subsidy rules
 *     sol_quotes              — proposals / quotes
 *     sol_quote_items         — BOM line items per quote
 *     sol_installations       — active install projects
 *     sol_install_milestones  — 9 milestone rows per installation
 *     sol_subsidies           — PM-Surya Ghar subsidy state machine
 *     sol_amc_visits          — service / AMC visits
 *     sol_inverter_brands     — approved inverter / panel makes
 *
 *   APIs (api_solar_*):
 *     api_solar_summary
 *     api_solar_site_byLead / _upsert / _list
 *     api_solar_pricing_config_get / _set
 *     api_solar_pricing_calc  (pure-math, no DB write)
 *
 *   Wired further in Commit 2 (quotes/installations) and Commit 3
 *   (subsidy + AMC + AI insights).
 */

'use strict';

const db        = require('../../db/pg');
const framework = require('./_framework');

const PACK_ID = 'solar';

// PM-Surya Ghar central subsidy rates (revised 15 Jun 2026).
// Used by api_solar_pricing_calc and seeders.
const CENTRAL_SUBSIDY = {
  per_kw_upto_2: 35000,           // ₹35k/kW for first 2 kW (revised 15 Jun)
  per_kw_2_to_3: 18000,           // ₹18k/kW for the next 1 kW (2→3 kW)
  flat_3_to_10:  78000,           // flat ₹78k for any system 3-10 kW
  cap_kw:        10              // no central subsidy above 10 kW (PM-Surya Ghar)
};

// State-level subsidy add-on per kW (where applicable). All values
// are illustrative defaults — admin can override via Settings.
const STATE_SUBSIDY = {
  BR: 0,            // Bihar — none
  UP: 15000,        // Uttar Pradesh — ₹15k flat
  MH: 10000,        // Maharashtra — ₹10k flat
  GJ: 20000,        // Gujarat — ₹20k flat
  HR: 17000,        // Haryana — ₹17k flat
  DL: 10000,        // Delhi — ₹10k flat
  KA: 0,            // Karnataka
  TS: 0,            // Telangana
  TN: 0,            // Tamil Nadu
  WB: 0             // West Bengal
};

// Default per-tier panel rates (₹/W). Admin can override.
const PANEL_TIER_RATES = {
  'mono_perc_tier1': 38,   // Adani / Waaree / Vikram Tier-1 Mono PERC
  'mono_perc_tier2': 32,
  'poly_tier1':      30,
  'topcon_tier1':    42,
  'bifacial':        45
};

// 9 milestones for an installation project (used by install tracker).
const INSTALL_MILESTONES = [
  { seq: 1, code: 'quoted',        label: 'Quoted' },
  { seq: 2, code: 'booked',        label: 'Booked' },
  { seq: 3, code: 'design',        label: 'Design Approved' },
  { seq: 4, code: 'discom',        label: 'DISCOM Approved' },
  { seq: 5, code: 'dispatch',      label: 'Material Dispatched' },
  { seq: 6, code: 'installing',    label: 'Installation in Progress' },
  { seq: 7, code: 'netmeter',      label: 'Net-Meter Installed' },
  { seq: 8, code: 'pto',           label: 'PTO Received' },
  { seq: 9, code: 'commissioned',  label: 'Commissioned / LIVE' }
];

// PM-Surya Ghar 8-stage subsidy state machine.
const SUBSIDY_STAGES = [
  { seq: 1, code: 'reg',          label: 'Registration' },
  { seq: 2, code: 'discom_apply', label: 'DISCOM Application' },
  { seq: 3, code: 'tech_feas',    label: 'Technical Feasibility' },
  { seq: 4, code: 'vendor_pick',  label: 'Vendor Selected' },
  { seq: 5, code: 'install',      label: 'Installation' },
  { seq: 6, code: 'inspection',   label: 'DISCOM Inspection' },
  { seq: 7, code: 'pto_meter',    label: 'Net-meter + PTO' },
  { seq: 8, code: 'disbursed',    label: 'Subsidy Disbursed' }
];

// ── Installer ─────────────────────────────────────────────────────
async function _installer({ db: D }) {
  // 1. Site surveys
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_sites (
      id                SERIAL PRIMARY KEY,
      lead_id           INT,
      address           TEXT,
      state             TEXT,
      lat               NUMERIC(10,6),
      lng               NUMERIC(10,6),
      rooftop_area_sqft NUMERIC(10,2),
      roof_shape        TEXT,                  -- rectangular | l-shape | scattered
      roof_type         TEXT,                  -- rcc | metal | tiled | elevated
      shadow_pct        INT NOT NULL DEFAULT 0,
      monthly_bill_inr  NUMERIC(12,2),
      sanctioned_load_kw NUMERIC(8,2),
      discom            TEXT,                  -- BSEB | BSES | MSEDCL | BESCOM | ...
      consumer_category TEXT DEFAULT 'domestic', -- domestic | commercial | industrial
      meter_type        TEXT,                  -- single_phase | three_phase
      net_meter_ok      INT NOT NULL DEFAULT 1,
      photos_json       TEXT,                  -- JSON array of R2 URLs
      notes             TEXT,
      survey_done       INT NOT NULL DEFAULT 0,
      surveyed_by       INT,
      surveyed_at       TIMESTAMPTZ,
      kw_recommended    NUMERIC(8,2),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_sites_lead_idx ON sol_sites(lead_id)`, []);

  // 2. Pricing config (single tenant-level row)
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_pricing_config (
      id                SERIAL PRIMARY KEY,
      panel_rates_json  TEXT,   -- {"mono_perc_tier1":38, ...}
      state_subsidy_json TEXT,  -- {"BR":0,"UP":15000,...}
      central_subsidy_json TEXT, -- {"per_kw_upto_2":35000,...}
      default_gst_pct   NUMERIC(5,2) DEFAULT 13.8,
      default_tariff_kwh NUMERIC(6,2) DEFAULT 7.5,
      default_emi_years INT DEFAULT 7,
      default_emi_rate_pct NUMERIC(5,2) DEFAULT 9.5,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // 3. Quotes
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_quotes (
      id                SERIAL PRIMARY KEY,
      lead_id           INT,
      site_id           INT,
      quote_no          TEXT,
      kw                NUMERIC(8,2) NOT NULL,
      panel_tier        TEXT,
      inverter_brand    TEXT,
      battery_kwh       NUMERIC(8,2) DEFAULT 0,
      state             TEXT,
      gross_inr         NUMERIC(14,2) DEFAULT 0,
      central_subsidy   NUMERIC(14,2) DEFAULT 0,
      state_subsidy     NUMERIC(14,2) DEFAULT 0,
      net_inr           NUMERIC(14,2) DEFAULT 0,
      gst_pct           NUMERIC(5,2) DEFAULT 13.8,
      final_inr         NUMERIC(14,2) DEFAULT 0,
      annual_gen_kwh    NUMERIC(12,2) DEFAULT 0,
      payback_years     NUMERIC(6,2) DEFAULT 0,
      roi_25y_inr       NUMERIC(14,2) DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'draft',  -- draft|sent|accepted|booked|expired|lost
      pdf_url           TEXT,
      sent_at           TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_quotes_lead_idx ON sol_quotes(lead_id)`, []);

  // 4. Quote items (BOM)
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_quote_items (
      id           SERIAL PRIMARY KEY,
      quote_id     INT NOT NULL,
      seq          INT NOT NULL DEFAULT 1,
      item_type    TEXT NOT NULL,   -- panel|inverter|structure|cable_dc|cable_ac|acdb_dcdb|earthing|netmeter|labor|monitoring|battery|misc
      make         TEXT,
      spec         TEXT,
      qty          NUMERIC(10,2) DEFAULT 1,
      unit         TEXT,            -- nos | m | kW | set | pit
      rate         NUMERIC(12,2) DEFAULT 0,
      total        NUMERIC(14,2) DEFAULT 0
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_quote_items_quote_idx ON sol_quote_items(quote_id)`, []);

  // 5. Installations
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_installations (
      id                SERIAL PRIMARY KEY,
      lead_id           INT,
      quote_id          INT,
      project_no        TEXT,
      kw                NUMERIC(8,2) NOT NULL,
      total_inr         NUMERIC(14,2) NOT NULL DEFAULT 0,
      advance_pct       NUMERIC(5,2) DEFAULT 30,
      dispatch_pct      NUMERIC(5,2) DEFAULT 40,
      commission_pct    NUMERIC(5,2) DEFAULT 30,
      current_stage     INT NOT NULL DEFAULT 1,   -- 1..9 from INSTALL_MILESTONES
      owner_user_id     INT,
      crew              TEXT,
      booked_at         TIMESTAMPTZ,
      commissioned_at   TIMESTAMPTZ,
      status            TEXT NOT NULL DEFAULT 'active',  -- active|cancelled|onhold|done
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_installations_lead_idx ON sol_installations(lead_id)`, []);

  // 6. Install milestones
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_install_milestones (
      id           SERIAL PRIMARY KEY,
      install_id   INT NOT NULL,
      seq          INT NOT NULL,
      code         TEXT NOT NULL,
      label        TEXT,
      owner_user_id INT,
      planned_date DATE,
      actual_date  DATE,
      status       TEXT NOT NULL DEFAULT 'pending',   -- pending|in_progress|done|blocked
      notes        TEXT,
      photos_json  TEXT,
      blocker      TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_milestones_install_idx ON sol_install_milestones(install_id)`, []);

  // 7. Subsidies (PM-Surya Ghar tracker)
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_subsidies (
      id              SERIAL PRIMARY KEY,
      lead_id         INT,
      install_id      INT,
      scheme          TEXT NOT NULL DEFAULT 'pm_surya_ghar',
      reg_no          TEXT,
      discom          TEXT,
      state           TEXT,
      central_inr     NUMERIC(14,2) DEFAULT 0,
      state_inr       NUMERIC(14,2) DEFAULT 0,
      current_stage   INT NOT NULL DEFAULT 1,    -- 1..8 from SUBSIDY_STAGES
      stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      disbursed_at    TIMESTAMPTZ,
      disbursed_ref   TEXT,
      blocker         TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_subsidies_lead_idx ON sol_subsidies(lead_id)`, []);

  // 8. AMC visits
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_amc_visits (
      id              SERIAL PRIMARY KEY,
      lead_id         INT,
      install_id      INT,
      plan_code       TEXT DEFAULT 'basic',    -- basic | standard | premium
      plan_amount_inr NUMERIC(10,2) DEFAULT 0,
      last_visit_at   DATE,
      next_due_at     DATE,
      tech_user_id    INT,
      gen_since_kwh   NUMERIC(12,2) DEFAULT 0,
      issues          TEXT,
      photos_json     TEXT,
      status          TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | done | overdue | cancelled
      done_at         TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS sol_amc_install_idx ON sol_amc_visits(install_id)`, []);

  // 9. Inverter / panel brand catalog
  await D.query(`
    CREATE TABLE IF NOT EXISTS sol_inverter_brands (
      id          SERIAL PRIMARY KEY,
      brand       TEXT NOT NULL,
      model       TEXT,
      kw_capacity NUMERIC(8,2),
      kind        TEXT,    -- inverter | panel | battery | structure
      rate_inr    NUMERIC(12,2) DEFAULT 0,
      is_active   INT NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);

  // Seed default brands if empty
  const bc = await D.query(`SELECT COUNT(*)::int AS n FROM sol_inverter_brands`, []);
  if ((bc.rows[0] || {}).n === 0) {
    const seedBrands = [
      ['Adani',   'Mono PERC 545W', 0.545, 'panel',    14000],
      ['Waaree',  'Mono PERC 540W', 0.540, 'panel',    13800],
      ['Vikram',  'Mono PERC 535W', 0.535, 'panel',    13500],
      ['Sungrow', '5kW String',     5.0,   'inverter', 38000],
      ['Sungrow', '10kW String',    10.0,  'inverter', 72000],
      ['Microtek','5kW Hybrid',     5.0,   'inverter', 42000],
      ['Luminous','5kW',            5.0,   'inverter', 36000],
      ['Polycab', '5kW',            5.0,   'inverter', 39000],
      ['Fronius', '5kW Primo',      5.0,   'inverter', 58000]
    ];
    for (const [brand, model, kw, kind, rate] of seedBrands) {
      await D.query(
        `INSERT INTO sol_inverter_brands(brand, model, kw_capacity, kind, rate_inr)
         VALUES ($1,$2,$3,$4,$5)`,
        [brand, model, kw, kind, rate]
      );
    }
  }

  // Seed pricing config if empty
  const pc = await D.query(`SELECT COUNT(*)::int AS n FROM sol_pricing_config`, []);
  if ((pc.rows[0] || {}).n === 0) {
    await D.query(
      `INSERT INTO sol_pricing_config
         (panel_rates_json, state_subsidy_json, central_subsidy_json,
          default_gst_pct, default_tariff_kwh, default_emi_years, default_emi_rate_pct)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        JSON.stringify(PANEL_TIER_RATES),
        JSON.stringify(STATE_SUBSIDY),
        JSON.stringify(CENTRAL_SUBSIDY),
        13.8, 7.5, 7, 9.5
      ]
    );
  }
}

// ── Pure-math pricing calc (no DB write) ───────────────────────────
function _calcPricing(input) {
  const kw          = Math.max(0, Number(input.kw || 0));
  const rate_per_w  = Math.max(0, Number(input.rate_per_w || PANEL_TIER_RATES.mono_perc_tier1));
  const inverter_inr= Math.max(0, Number(input.inverter_inr || 0));
  const battery_inr = Math.max(0, Number(input.battery_inr || 0));
  const state       = String(input.state || 'BR').toUpperCase();
  const shadow_pct  = Math.min(100, Math.max(0, Number(input.shadow_pct || 0)));
  const tariff      = Math.max(0, Number(input.tariff || 7.5));
  const gst_pct     = Math.max(0, Number(input.gst_pct || 13.8));
  const emi_years   = Math.max(1, Number(input.emi_years || 7));
  const emi_rate    = Math.max(0, Number(input.emi_rate || 9.5));

  // Gross cost: panels (kW × 1000 × ₹/W) + inverter + battery + balance (≈ 12% panel cost)
  const panel_cost  = kw * 1000 * rate_per_w;
  const balance_cost= panel_cost * 0.12;      // structure + cables + ACDB + earthing + labor approx
  const gross       = panel_cost + inverter_inr + battery_inr + balance_cost;

  // Central subsidy (PM-Surya Ghar — capped at 10 kW)
  let central = 0;
  if (kw <= 2)         central = kw * CENTRAL_SUBSIDY.per_kw_upto_2;
  else if (kw <= 3)    central = 2 * CENTRAL_SUBSIDY.per_kw_upto_2 + (kw - 2) * CENTRAL_SUBSIDY.per_kw_2_to_3;
  else if (kw <= 10)   central = CENTRAL_SUBSIDY.flat_3_to_10;
  else                 central = CENTRAL_SUBSIDY.flat_3_to_10;   // no add'l above 10 kW

  // State subsidy (flat add-on, no central residential cap above 10 kW)
  const state_amt = (STATE_SUBSIDY[state] || 0);

  const net  = Math.max(0, gross - central - state_amt);
  const gst  = net * (gst_pct / 100);
  const final = net + gst;

  // EMI calc: standard amortisation
  const months = emi_years * 12;
  const r = emi_rate / 100 / 12;
  const emi = months > 0 && r > 0
    ? (final * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
    : 0;

  // Annual generation: 1500 kWh / kW / year × (1 − shadow%)
  const annual_gen = kw * 1500 * (1 - shadow_pct / 100);
  const annual_sav = annual_gen * tariff;
  const payback    = annual_sav > 0 ? net / annual_sav : 0;

  // 25-yr ROI with 4%/yr tariff escalation, 0.7%/yr degradation
  let roi25 = 0;
  let gen   = annual_gen;
  let tar   = tariff;
  for (let y = 1; y <= 25; y++) {
    roi25 += gen * tar;
    gen *= (1 - 0.007);
    tar *= 1.04;
  }
  roi25 -= net;

  return {
    panel_cost:      Math.round(panel_cost),
    balance_cost:    Math.round(balance_cost),
    inverter_inr:    Math.round(inverter_inr),
    battery_inr:     Math.round(battery_inr),
    gross_inr:       Math.round(gross),
    central_subsidy: Math.round(central),
    state_subsidy:   Math.round(state_amt),
    net_inr:         Math.round(net),
    gst_inr:         Math.round(gst),
    final_inr:       Math.round(final),
    emi_monthly_inr: Math.round(emi),
    annual_gen_kwh:  Math.round(annual_gen),
    annual_savings_inr: Math.round(annual_sav),
    payback_years:   Number(payback.toFixed(2)),
    roi_25y_inr:     Math.round(roi25)
  };
}

// ── APIs ──────────────────────────────────────────────────────────

async function api_solar_summary(/*token*/) {
  // Date helpers (Asia/Kolkata)
  const r1 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE survey_done = 1)::int                                     AS surveyed_total,
      COUNT(*) FILTER (WHERE survey_done = 1 AND created_at >= date_trunc('month', now()))::int AS surveyed_month,
      COUNT(*)::int                                                                    AS sites_total
    FROM sol_sites
  `, []);

  const r2 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','accepted','booked'))::int    AS quotes_sent,
      COALESCE(SUM(CASE WHEN status IN ('sent','accepted','booked') THEN final_inr ELSE 0 END),0)::numeric AS quotes_value,
      COUNT(*) FILTER (WHERE status = 'booked')::int                          AS quotes_booked
    FROM sol_quotes
  `, []);

  const r3 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active')::int                          AS active_installs,
      COALESCE(SUM(CASE WHEN status = 'active' THEN kw ELSE 0 END),0)::numeric AS active_kw,
      COUNT(*) FILTER (WHERE status = 'done' AND commissioned_at >= date_trunc('month', now()))::int AS commissioned_month,
      COALESCE(SUM(CASE WHEN status = 'done' AND commissioned_at >= date_trunc('month', now()) THEN kw ELSE 0 END),0)::numeric AS commissioned_month_kw,
      COALESCE(SUM(CASE WHEN status = 'done' AND commissioned_at >= date_trunc('month', now()) THEN total_inr ELSE 0 END),0)::numeric AS commissioned_month_inr
    FROM sol_installations
  `, []);

  const r4 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE current_stage = 8)::int                          AS disbursed_count,
      COALESCE(SUM(CASE WHEN current_stage = 8 THEN central_inr + state_inr ELSE 0 END),0)::numeric AS disbursed_amount,
      COUNT(*) FILTER (WHERE current_stage < 8)::int                          AS pending_count,
      COALESCE(SUM(CASE WHEN current_stage < 8 THEN central_inr + state_inr ELSE 0 END),0)::numeric AS pending_amount,
      MAX(CASE WHEN current_stage < 8
              THEN EXTRACT(epoch FROM (now() - total_started_at))/86400 END)::int AS pending_oldest_days
    FROM sol_subsidies
  `, []);

  const r5 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'scheduled' AND next_due_at <= CURRENT_DATE + INTERVAL '30 days')::int AS amc_due_30d,
      COUNT(*) FILTER (WHERE status = 'overdue' OR (status='scheduled' AND next_due_at < CURRENT_DATE))::int AS amc_overdue
    FROM sol_amc_visits
  `, []);

  // Conversion: booked / quotes_sent (this month)
  const r6 = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','accepted','booked','expired','lost')
                       AND created_at >= date_trunc('month', now()))::int AS m_quotes,
      COUNT(*) FILTER (WHERE status = 'booked'
                       AND created_at >= date_trunc('month', now()))::int AS m_booked
    FROM sol_quotes
  `, []);
  const mq = (r6.rows[0] || {}).m_quotes || 0;
  const mb = (r6.rows[0] || {}).m_booked || 0;
  const conv_pct = mq > 0 ? Math.round((mb / mq) * 100) : 0;

  return {
    sites:       r1.rows[0] || {},
    quotes:      r2.rows[0] || {},
    installs:    r3.rows[0] || {},
    subsidy:     r4.rows[0] || {},
    amc:         r5.rows[0] || {},
    conversion_pct: conv_pct
  };
}

async function api_solar_site_byLead(_token, args) {
  const leadId = Number((args && args.lead_id) || 0);
  if (!leadId) return { sites: [] };
  const r = await db.query(
    `SELECT * FROM sol_sites WHERE lead_id = $1 ORDER BY id DESC`,
    [leadId]
  );
  return { sites: r.rows || [] };
}

async function api_solar_site_list(_token, args) {
  args = args || {};
  const limit  = Math.min(500, Math.max(1, Number(args.limit || 50)));
  const offset = Math.max(0, Number(args.offset || 0));
  const search = String(args.search || '').trim();
  const params = [];
  let where    = '1=1';
  if (search) {
    params.push('%' + search + '%');
    where += ` AND (address ILIKE $${params.length} OR discom ILIKE $${params.length} OR state ILIKE $${params.length})`;
  }
  params.push(limit, offset);
  const r = await db.query(
    `SELECT s.*, l.name AS lead_name, l.phone AS lead_phone
       FROM sol_sites s
       LEFT JOIN leads l ON l.id = s.lead_id
      WHERE ${where}
      ORDER BY s.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { sites: r.rows || [] };
}

async function api_solar_site_upsert(_token, args) {
  args = args || {};
  const id = Number(args.id || 0);
  const lead_id = Number(args.lead_id || 0) || null;

  // Auto-compute kW recommendation: bill ÷ 100 ÷ 5h/day × 1.05 utilisation
  const bill = Number(args.monthly_bill_inr || 0);
  const kw_rec = bill > 0
    ? Number(((bill / 100) / (5 * 30) * 1.05).toFixed(2))
    : null;

  const fields = {
    lead_id,
    address: args.address || null,
    state: args.state || null,
    lat: args.lat || null,
    lng: args.lng || null,
    rooftop_area_sqft: Number(args.rooftop_area_sqft || 0) || null,
    roof_shape: args.roof_shape || null,
    roof_type: args.roof_type || null,
    shadow_pct: Number(args.shadow_pct || 0),
    monthly_bill_inr: bill || null,
    sanctioned_load_kw: Number(args.sanctioned_load_kw || 0) || null,
    discom: args.discom || null,
    consumer_category: args.consumer_category || 'domestic',
    meter_type: args.meter_type || null,
    net_meter_ok: args.net_meter_ok === 0 ? 0 : 1,
    photos_json: args.photos_json
      ? (typeof args.photos_json === 'string' ? args.photos_json : JSON.stringify(args.photos_json))
      : null,
    notes: args.notes || null,
    survey_done: args.survey_done ? 1 : 0,
    kw_recommended: kw_rec
  };

  if (id > 0) {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const vals = cols.map(c => fields[c]);
    vals.push(id);
    const r = await db.query(
      `UPDATE sol_sites SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      vals
    );
    return { ok: true, site: r.rows[0] || null };
  } else {
    const cols = Object.keys(fields);
    const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = cols.map(c => fields[c]);
    const r = await db.query(
      `INSERT INTO sol_sites (${cols.join(', ')}) VALUES (${ph}) RETURNING *`,
      vals
    );
    return { ok: true, site: r.rows[0] || null };
  }
}

async function api_solar_pricing_config_get(/*token*/) {
  const r = await db.query(`SELECT * FROM sol_pricing_config ORDER BY id ASC LIMIT 1`, []);
  const row = r.rows[0] || {};
  // Parse JSON columns for convenience
  const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch (_) { return fb; } };
  return {
    config: {
      id: row.id || null,
      panel_rates:    parse(row.panel_rates_json,    PANEL_TIER_RATES),
      state_subsidy:  parse(row.state_subsidy_json,  STATE_SUBSIDY),
      central_subsidy:parse(row.central_subsidy_json,CENTRAL_SUBSIDY),
      default_gst_pct:     Number(row.default_gst_pct || 13.8),
      default_tariff_kwh:  Number(row.default_tariff_kwh || 7.5),
      default_emi_years:   Number(row.default_emi_years || 7),
      default_emi_rate_pct:Number(row.default_emi_rate_pct || 9.5)
    }
  };
}

async function api_solar_pricing_config_set(_token, args) {
  args = args || {};
  const got = await db.query(`SELECT id FROM sol_pricing_config ORDER BY id ASC LIMIT 1`, []);
  const id  = (got.rows[0] || {}).id;

  const fields = {
    panel_rates_json:     args.panel_rates    ? JSON.stringify(args.panel_rates)     : null,
    state_subsidy_json:   args.state_subsidy  ? JSON.stringify(args.state_subsidy)   : null,
    central_subsidy_json: args.central_subsidy? JSON.stringify(args.central_subsidy) : null,
    default_gst_pct:      args.default_gst_pct != null ? Number(args.default_gst_pct) : null,
    default_tariff_kwh:   args.default_tariff_kwh != null ? Number(args.default_tariff_kwh) : null,
    default_emi_years:    args.default_emi_years != null ? Number(args.default_emi_years) : null,
    default_emi_rate_pct: args.default_emi_rate_pct != null ? Number(args.default_emi_rate_pct) : null,
    updated_at:           new Date()
  };
  const nonNull = Object.entries(fields).filter(([_, v]) => v !== null && v !== undefined);

  if (id) {
    const sets = nonNull.map(([k], i) => `${k} = $${i + 1}`).join(', ');
    const vals = nonNull.map(([_, v]) => v);
    vals.push(id);
    await db.query(`UPDATE sol_pricing_config SET ${sets} WHERE id = $${nonNull.length + 1}`, vals);
  } else {
    const cols = nonNull.map(([k]) => k);
    const ph   = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = nonNull.map(([_, v]) => v);
    await db.query(`INSERT INTO sol_pricing_config (${cols.join(', ')}) VALUES (${ph})`, vals);
  }
  return { ok: true };
}

async function api_solar_pricing_calc(_token, args) {
  return { calc: _calcPricing(args || {}) };
}

// ── Register the pack ──────────────────────────────────────────────
framework.register({
  id:          PACK_ID,
  name:        'Solar',
  icon:        '☀️',
  description: 'Rooftop & utility solar — site survey, pricing calc, quotes, install tracker, PM-Surya Ghar subsidy, AMC.',
  namespace:   'sol_',
  version:     '1.0.0',
  installer:   _installer,
  navItems: [
    { id: 'packsolar',      label: 'Solar Overview',      icon: '☀️', view: 'packsolar' },
    { id: 'solarsites',     label: 'Site Survey',         icon: '🏠', view: 'solarsites' },
    { id: 'solarcalc',      label: 'Pricing Calculator',  icon: '💰', view: 'solarcalc' },
    { id: 'solarquotes',    label: 'Quotes & Proposals',  icon: '📄', view: 'solarquotes' },
    { id: 'solarinstalls',  label: 'Installation Tracker',icon: '🔧', view: 'solarinstalls' },
    { id: 'solarsubsidies', label: 'Subsidy Tracker',     icon: '🏛️', view: 'solarsubsidies' },
    { id: 'solaramc',       label: 'AMC / Service',       icon: '🛠️', view: 'solaramc' },
    { id: 'solarinsights',  label: 'AI Insights',         icon: '🤖', view: 'solarinsights' }
  ],
  leadPanels: ['sol_site']
});

module.exports = {
  // APIs
  api_solar_summary,
  api_solar_site_byLead,
  api_solar_site_list,
  api_solar_site_upsert,
  api_solar_pricing_config_get,
  api_solar_pricing_config_set,
  api_solar_pricing_calc,

  // Exports for Commits 2+3
  INSTALL_MILESTONES,
  SUBSIDY_STAGES,
  CENTRAL_SUBSIDY,
  STATE_SUBSIDY,
  PANEL_TIER_RATES,
  _calcPricing,
  _installer
};
