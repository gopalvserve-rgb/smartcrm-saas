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


// ── Commit 2 APIs — Quotes + Installations ─────────────────────────

async function api_solar_quote_create(_token, args) {
  args = args || {};
  const calc = _calcPricing(args);
  const lead_id = Number(args.lead_id || 0) || null;
  const site_id = Number(args.site_id || 0) || null;
  const kw      = Number(args.kw || 0);
  const inverter_brand = args.inverter_brand || null;
  const panel_tier = args.panel_tier || 'mono_perc_tier1';
  const battery_kwh = Number(args.battery_kwh || 0);
  const state = args.state || 'BR';

  const ins = await db.query(
    `INSERT INTO sol_quotes (
       lead_id, site_id, quote_no, kw, panel_tier, inverter_brand, battery_kwh,
       state, gross_inr, central_subsidy, state_subsidy, net_inr, gst_pct, final_inr,
       annual_gen_kwh, payback_years, roi_25y_inr, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      lead_id, site_id,
      'SOL-' + Date.now().toString(36).toUpperCase(),
      kw, panel_tier, inverter_brand, battery_kwh, state,
      calc.gross_inr, calc.central_subsidy, calc.state_subsidy,
      calc.net_inr, Number(args.gst_pct || 13.8), calc.final_inr,
      calc.annual_gen_kwh, calc.payback_years, calc.roi_25y_inr,
      'draft'
    ]
  );
  const quote = ins.rows[0];

  // Auto-create default BOM lines (panels, inverter, structure, cables, ACDB/DCDB, labor)
  const panel_w = 545;  // assume tier-1 panel default
  const panels  = Math.ceil((kw * 1000) / panel_w);
  const items = [
    ['panel',     'Adani Mono PERC ' + panel_w + 'W', panels, 'nos',  14000],
    ['inverter',  inverter_brand || 'Sungrow String', 1,      'nos',  Number(args.inverter_inr || 38000)],
    ['structure', 'Hot-dip galvanised',                kw,     'kW',   3500],
    ['cable_dc',  'Polycab 6 sqmm',                    kw * 8, 'm',    120],
    ['cable_ac',  'Polycab 4 sqmm',                    kw * 4, 'm',    95],
    ['acdb_dcdb', 'Havells',                           1,      'set',  6500],
    ['earthing',  '—',                                 3,      'pit',  2000],
    ['netmeter',  'DISCOM',                            1,      'nos',  3000],
    ['labor',     'Crew install',                      1,      'job',  6500]
  ];
  for (let i = 0; i < items.length; i++) {
    const [type, make, qty, unit, rate] = items[i];
    await db.query(
      `INSERT INTO sol_quote_items (quote_id, seq, item_type, make, qty, unit, rate, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [quote.id, i + 1, type, make, qty, unit, rate, qty * rate]
    );
  }
  return { ok: true, quote };
}

async function api_solar_quote_byLead(_token, args) {
  const leadId = Number((args && args.lead_id) || 0);
  if (!leadId) return { quotes: [] };
  const r = await db.query(
    `SELECT * FROM sol_quotes WHERE lead_id=$1 ORDER BY id DESC`,
    [leadId]
  );
  return { quotes: r.rows || [] };
}

async function api_solar_quote_list(_token, args) {
  args = args || {};
  const limit = Math.min(500, Math.max(1, Number(args.limit || 50)));
  const params = [limit];
  let where = '1=1';
  if (args.status) { params.push(args.status); where += ` AND q.status = $${params.length}`; }
  const r = await db.query(
    `SELECT q.*, l.name AS lead_name, l.phone AS lead_phone
       FROM sol_quotes q
       LEFT JOIN leads l ON l.id = q.lead_id
      WHERE ${where}
      ORDER BY q.id DESC LIMIT $1`,
    params
  );
  return { quotes: r.rows || [] };
}

async function api_solar_quote_items(_token, args) {
  const qid = Number((args && args.quote_id) || 0);
  if (!qid) return { items: [] };
  const r = await db.query(
    `SELECT * FROM sol_quote_items WHERE quote_id=$1 ORDER BY seq ASC`,
    [qid]
  );
  return { items: r.rows || [] };
}

async function api_solar_quote_setStatus(_token, args) {
  const qid = Number((args && args.quote_id) || 0);
  const status = String((args && args.status) || 'sent');
  if (!qid) throw new Error('quote_id required');
  await db.query(
    `UPDATE sol_quotes SET status=$1, sent_at = CASE WHEN $1 IN ('sent','accepted','booked') AND sent_at IS NULL THEN now() ELSE sent_at END WHERE id=$2`,
    [status, qid]
  );
  return { ok: true };
}

async function api_solar_install_create(_token, args) {
  args = args || {};
  const lead_id  = Number(args.lead_id || 0) || null;
  const quote_id = Number(args.quote_id || 0) || null;
  const kw       = Number(args.kw || 0);
  const total    = Number(args.total_inr || 0);
  const owner    = Number(args.owner_user_id || 0) || null;

  const ins = await db.query(
    `INSERT INTO sol_installations (lead_id, quote_id, project_no, kw, total_inr, owner_user_id, current_stage, booked_at)
     VALUES ($1,$2,$3,$4,$5,$6,2,now()) RETURNING *`,
    [lead_id, quote_id, 'WW-' + Date.now().toString(36).toUpperCase(), kw, total, owner]
  );
  const project = ins.rows[0];

  // Seed all 9 milestones; first 2 marked done (Quoted + Booked)
  for (const m of INSTALL_MILESTONES) {
    const status = (m.seq <= 2) ? 'done' : (m.seq === 3 ? 'in_progress' : 'pending');
    await db.query(
      `INSERT INTO sol_install_milestones (install_id, seq, code, label, status, actual_date)
       VALUES ($1,$2,$3,$4,$5, CASE WHEN $5='done' THEN CURRENT_DATE ELSE NULL END)`,
      [project.id, m.seq, m.code, m.label, status]
    );
  }
  return { ok: true, install: project };
}

async function api_solar_install_list(_token, args) {
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.stage) { params.push(Number(args.stage)); where += ` AND i.current_stage = $${params.length}`; }
  if (args.status) { params.push(args.status); where += ` AND i.status = $${params.length}`; }
  if (args.owner_user_id) { params.push(Number(args.owner_user_id)); where += ` AND i.owner_user_id = $${params.length}`; }

  const r = await db.query(
    `SELECT i.*, l.name AS lead_name, l.phone AS lead_phone, l.city AS lead_city,
            u.name AS owner_name
       FROM sol_installations i
       LEFT JOIN leads l ON l.id = i.lead_id
       LEFT JOIN users u ON u.id = i.owner_user_id
      WHERE ${where}
      ORDER BY i.id DESC`,
    params
  );
  return { installs: r.rows || [] };
}

async function api_solar_install_byLead(_token, args) {
  const leadId = Number((args && args.lead_id) || 0);
  if (!leadId) return { installs: [] };
  const r = await db.query(
    `SELECT * FROM sol_installations WHERE lead_id=$1 ORDER BY id DESC`,
    [leadId]
  );
  return { installs: r.rows || [] };
}

async function api_solar_install_milestones(_token, args) {
  const iid = Number((args && args.install_id) || 0);
  if (!iid) return { milestones: [] };
  const r = await db.query(
    `SELECT m.*, u.name AS owner_name
       FROM sol_install_milestones m
       LEFT JOIN users u ON u.id = m.owner_user_id
      WHERE m.install_id=$1
      ORDER BY m.seq ASC`,
    [iid]
  );
  return { milestones: r.rows || [] };
}

async function api_solar_install_advance(_token, args) {
  const iid = Number((args && args.install_id) || 0);
  const notes = (args && args.notes) || null;
  if (!iid) throw new Error('install_id required');

  const cur = await db.query(`SELECT current_stage FROM sol_installations WHERE id=$1`, [iid]);
  if (!cur.rows[0]) throw new Error('install not found');
  const stage = Number(cur.rows[0].current_stage || 1);
  const nextStage = Math.min(9, stage + 1);

  // Mark current stage done; set new current stage in_progress
  await db.query(
    `UPDATE sol_install_milestones SET status='done', actual_date=CURRENT_DATE, notes=COALESCE($1, notes), updated_at=now()
       WHERE install_id=$2 AND seq=$3`,
    [notes, iid, stage]
  );
  if (nextStage > stage) {
    await db.query(
      `UPDATE sol_install_milestones SET status='in_progress', updated_at=now()
         WHERE install_id=$1 AND seq=$2`,
      [iid, nextStage]
    );
    const isCommissioned = (nextStage === 9);
    await db.query(
      `UPDATE sol_installations
          SET current_stage=$1,
              status = CASE WHEN $1=9 THEN 'done' ELSE status END,
              commissioned_at = CASE WHEN $1=9 AND commissioned_at IS NULL THEN now() ELSE commissioned_at END
        WHERE id=$2`,
      [nextStage, iid]
    );
    return { ok: true, advanced_to: nextStage, commissioned: isCommissioned };
  }
  return { ok: true, advanced_to: stage, commissioned: stage === 9 };
}

async function api_solar_install_summary(/*token*/) {
  const r = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status='active')::int                          AS active,
      COALESCE(SUM(CASE WHEN status='active' THEN kw ELSE 0 END),0)::numeric AS active_kw,
      COUNT(*) FILTER (WHERE status='done' AND commissioned_at >= date_trunc('month', now()))::int AS commissioned_month,
      COALESCE(AVG(CASE WHEN status='done' THEN EXTRACT(epoch FROM (commissioned_at - booked_at))/86400 END),0)::numeric AS avg_cycle_days
    FROM sol_installations
  `, []);
  const r2 = await db.query(`
    SELECT seq, code, label,
           AVG(CASE WHEN status='done' AND actual_date IS NOT NULL THEN EXTRACT(epoch FROM (actual_date::timestamp - updated_at))/86400 END) AS avg_days
      FROM sol_install_milestones
     GROUP BY seq, code, label
     ORDER BY seq ASC
  `, []);
  return { kpis: r.rows[0] || {}, stage_metrics: r2.rows || [] };
}

async function api_solar_inverter_brands_list(/*token*/) {
  const r = await db.query(
    `SELECT * FROM sol_inverter_brands WHERE is_active=1 ORDER BY kind, brand, kw_capacity`,
    []
  );
  return { brands: r.rows || [] };
}



// ── v1.1 APIs — Subsidy + AMC + Insights ───────────────────────────

async function api_solar_subsidy_list(_token, args) {
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.stuck) where += ` AND (now() - s.stage_entered_at) > INTERVAL '30 days' AND s.current_stage < 8`;
  if (args.disbursed) where += ` AND s.current_stage = 8`;
  const r = await db.query(
    `SELECT s.*, l.name AS lead_name,
            EXTRACT(epoch FROM (now() - s.stage_entered_at))/86400 AS days_in_stage,
            EXTRACT(epoch FROM (now() - s.total_started_at))/86400 AS total_days
       FROM sol_subsidies s
       LEFT JOIN leads l ON l.id = s.lead_id
      WHERE ${where}
      ORDER BY s.current_stage DESC, s.id DESC`,
    params);
  return { subsidies: r.rows || [] };
}

async function api_solar_subsidy_advance(_token, args) {
  const id = Number((args && args.subsidy_id) || 0);
  if (!id) throw new Error('subsidy_id required');
  const cur = await db.query(`SELECT current_stage FROM sol_subsidies WHERE id=$1`, [id]);
  if (!cur.rows[0]) throw new Error('not found');
  const next = Math.min(8, Number(cur.rows[0].current_stage || 1) + 1);
  await db.query(
    `UPDATE sol_subsidies
        SET current_stage = $1,
            stage_entered_at = now(),
            disbursed_at = CASE WHEN $1 = 8 AND disbursed_at IS NULL THEN now() ELSE disbursed_at END,
            disbursed_ref = CASE WHEN $1 = 8 AND disbursed_ref IS NULL THEN 'DBT/' || id::text ELSE disbursed_ref END
      WHERE id = $2`, [next, id]);
  return { ok: true, advanced_to: next };
}

async function api_solar_subsidy_report(/*token*/) {
  const k = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE current_stage < 8)::int  AS in_pipeline,
      COUNT(*) FILTER (WHERE current_stage = 8)::int  AS disbursed,
      COUNT(*) FILTER (WHERE current_stage < 8 AND (now() - stage_entered_at) > INTERVAL '30 days')::int AS stuck,
      COALESCE(SUM(central_inr + state_inr) FILTER (WHERE current_stage < 8),0)::numeric AS pending_amt,
      COALESCE(SUM(central_inr + state_inr) FILTER (WHERE current_stage = 8
              AND disbursed_at >= date_trunc('year', now())),0)::numeric AS disbursed_fy
    FROM sol_subsidies
  `, []);
  return { kpis: k.rows[0] || {} };
}

async function api_solar_amc_list(_token, args) {
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.overdue) where += ` AND a.next_due_at < CURRENT_DATE`;
  if (args.due_soon) where += ` AND a.next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'`;
  const r = await db.query(
    `SELECT a.*, l.name AS lead_name, i.project_no, i.kw,
            (a.next_due_at - CURRENT_DATE)::int AS days_until_due
       FROM sol_amc_visits a
       LEFT JOIN leads l ON l.id = a.lead_id
       LEFT JOIN sol_installations i ON i.id = a.install_id
      WHERE ${where}
      ORDER BY a.next_due_at ASC NULLS LAST`,
    params);
  return { visits: r.rows || [] };
}

async function api_solar_amc_markDone(_token, args) {
  const id = Number((args && args.visit_id) || 0);
  if (!id) throw new Error('visit_id required');
  await db.query(
    `UPDATE sol_amc_visits
        SET status = 'done',
            done_at = now(),
            last_visit_at = CURRENT_DATE,
            next_due_at = CURRENT_DATE + INTERVAL '180 days',
            issues = COALESCE($2, issues)
      WHERE id = $1`,
    [id, (args && args.issues) || null]);
  return { ok: true };
}

async function api_solar_amc_summary(/*token*/) {
  const r = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('scheduled','overdue'))::int                                 AS active,
      COUNT(*) FILTER (WHERE next_due_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'
                       AND status='scheduled')::int                                                  AS due_14d,
      COUNT(*) FILTER (WHERE next_due_at < CURRENT_DATE AND status<>'done')::int                     AS overdue,
      COUNT(*) FILTER (WHERE status='done' AND done_at >= date_trunc('month', now()))::int          AS done_month
    FROM sol_amc_visits
  `, []);
  return { kpis: r.rows[0] || {} };
}

// Rule-based AI insights (deterministic — no Gemini in v1.1; weekly cron in v1.2)
async function api_solar_insights_get(/*token*/) {
  const insights = [];

  // 1. Conversion by kW size
  const conv = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE kw <= 5)::int                                                 AS small_total,
      COUNT(*) FILTER (WHERE kw <= 5 AND status='booked')::int                             AS small_booked,
      COUNT(*) FILTER (WHERE kw > 5)::int                                                  AS large_total,
      COUNT(*) FILTER (WHERE kw > 5 AND status='booked')::int                              AS large_booked
    FROM sol_quotes
  `, []);
  const c = conv.rows[0] || {};
  if ((c.small_total || 0) >= 3 && (c.small_booked || 0) > (c.large_booked || 0)) {
    const ratio = ((c.small_booked / Math.max(1, c.small_total)) /
                   Math.max(0.05, (c.large_booked / Math.max(1, c.large_total)))).toFixed(1);
    insights.push({
      type: 'growth', emoji: '📈',
      headline: '≤5 kW systems closing ' + ratio + '× faster than larger ones',
      detail: c.small_booked + ' of ' + c.small_total + ' small quotes booked vs ' +
              c.large_booked + ' of ' + c.large_total + ' large quotes. Push 3-5 kW pitch.',
      action: 'Update WA template + homepage to lead with 5 kW'
    });
  }

  // 2. Subsidy stuck
  const stuck = await db.query(`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(central_inr + state_inr),0)::numeric AS amt
      FROM sol_subsidies
     WHERE current_stage < 8 AND (now() - stage_entered_at) > INTERVAL '30 days'
  `, []);
  if ((stuck.rows[0] || {}).n > 0) {
    insights.push({
      type: 'warning', emoji: '⚠️',
      headline: '₹' + Math.round(stuck.rows[0].amt / 100000) + 'L subsidy stuck > 30 days',
      detail: stuck.rows[0].n + ' projects stuck in DISCOM stages > 30 days.',
      action: 'File grievance via DISCOM portal + escalate via Direct DC office'
    });
  }

  // 3. AMC overdue
  const overdue = await db.query(`
    SELECT COUNT(*)::int AS n FROM sol_amc_visits
     WHERE next_due_at < CURRENT_DATE AND status <> 'done'
  `, []);
  if ((overdue.rows[0] || {}).n > 0) {
    insights.push({
      type: 'warning', emoji: '🛠️',
      headline: overdue.rows[0].n + ' AMC visit' + (overdue.rows[0].n > 1 ? 's' : '') + ' overdue',
      detail: 'Customers will churn if not visited. Each overdue visit is a churn risk.',
      action: 'Send WA reminders + assign to closest tech today'
    });
  }

  // 4. Outstanding balance on bookings travelling soon
  const dueSoon = await db.query(`
    SELECT COUNT(*)::int AS n
      FROM sol_quotes
     WHERE status IN ('sent','accepted') AND created_at < now() - INTERVAL '5 days'
  `, []);
  if ((dueSoon.rows[0] || {}).n > 0) {
    insights.push({
      type: 'suggest', emoji: '💰',
      headline: dueSoon.rows[0].n + ' quote' + (dueSoon.rows[0].n > 1 ? 's' : '') + ' sent > 5d ago, no booking',
      detail: 'Customers cooling off. Standard playbook: WA reminder day 5, call day 7, escalate day 10.',
      action: 'Auto-trigger reminder WA + flag for sales rep to call'
    });
  }

  // 5. PM-Surya Ghar rate change (informational)
  insights.push({
    type: 'trend', emoji: '🌞',
    headline: 'PM-Surya Ghar rate revised 15 Jun 2026',
    detail: 'Central subsidy structure changed — ≤2 kW now ₹35k/kW. Re-quote any old quotes for the better deal.',
    action: 'Open Pricing Calc → verify rates → re-send quotes from before 15 Jun'
  });

  // 6. Top performer (if multiple quotes from multiple owners)
  insights.push({
    type: 'growth', emoji: '🏆',
    headline: 'Run agent leaderboard from Reports to spot top performers',
    detail: 'Identify who is closing more quotes and pair them with juniors.',
    action: 'View Reports → Agent Leaderboard'
  });

  return { insights, generated_at: new Date().toISOString() };
}

// ── Showcase demo seed (idempotent) ─────────────────────────────────
// Solar lead pipeline stages — must match the install milestones for a clean handoff
const SOLAR_LEAD_STAGES = [
  { name: 'New Enquiry',              color: '#3b82f6' },
  { name: 'Site Visit Scheduled',     color: '#06b6d4' },
  { name: 'Site Surveyed',            color: '#8b5cf6' },
  { name: 'Quote Sent',               color: '#f59e0b' },
  { name: 'Booked / Advance Paid',    color: '#ec4899' },
  { name: 'Design + DISCOM Approved', color: '#f97316' },
  { name: 'Material Dispatched',      color: '#dc2626' },
  { name: 'Installation In Progress', color: '#b91c1c' },
  { name: 'Net-meter + PTO',          color: '#84cc16' },
  { name: 'Commissioned / LIVE',      color: '#16a34a', is_final: 1 },
  { name: 'AMC Active',               color: '#0d9488', is_final: 1 },
  { name: 'Lost',                     color: '#6b7280', is_final: 1 }
];

async function _seedSolarStages() {
  // Idempotent — insert if missing, update sort_order + color if present
  for (let i = 0; i < SOLAR_LEAD_STAGES.length; i++) {
    const s = SOLAR_LEAD_STAGES[i];
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
  // Push generic/non-Solar stages to the bottom (sort_order 100+)
  const keep = SOLAR_LEAD_STAGES.map(s => s.name.toLowerCase());
  const all = await db.query(`SELECT id, name FROM statuses`, []);
  let bottom = 100;
  for (const row of all.rows) {
    if (keep.includes(String(row.name).toLowerCase())) continue;
    // Only delete generic stages with ZERO leads — safer than blind delete
    const useCnt = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE status_id=$1`, [row.id]);
    if (Number(useCnt.rows[0].c) === 0) {
      try { await db.query(`DELETE FROM statuses WHERE id=$1`, [row.id]); }
      catch (_) { await db.query(`UPDATE statuses SET sort_order=$1 WHERE id=$2`, [bottom++, row.id]); }
    } else {
      await db.query(`UPDATE statuses SET sort_order=$1 WHERE id=$2`, [bottom++, row.id]);
    }
  }
}

async function api_solar_resetStages(/*token*/) {
  await _seedSolarStages();
  return { ok: true, stages: SOLAR_LEAD_STAGES.map(s => s.name) };
}

async function api_solar_seedDemo(/*token*/) {
  // Step 0: apply Solar-specific lead pipeline stages first
  await _seedSolarStages();

  // Idempotency check
  const existing = await db.query(`SELECT COUNT(*)::int AS n FROM sol_installations`, []);
  if ((existing.rows[0] || {}).n >= 10) {
    return { ok: true, skipped: true, message: 'Demo data already present (Solar stages still re-applied).' };
  }

  // 1. Ensure we have ~30 leads to attach surveys/quotes/installs to
  const leadCount = await db.query(`SELECT COUNT(*)::int AS n FROM leads`, []);
  const need = Math.max(0, 30 - (leadCount.rows[0] || {}).n);

  const FIRST = ['Rajesh','Anita','Vikas','Sunita','Krishna','Pradeep','Geeta','Ramesh',
                 'Sanjay','Lalit','Mira','Amit','Priya','Rohit','Aarti','Vivek','Neha',
                 'Sandeep','Rekha','Kapil','Sushma','Manoj','Pooja','Deepak','Komal',
                 'Sunil','Anjali','Gaurav','Swati','Akash','Ritu','Hardik','Naina'];
  const LAST  = ['Kumar','Devi','Iyer','Joshi','Sharma','Patel','Nair','Yadav',
                 'Reddy','Khanna','Verma','Singh','Mehta','Kapoor','Gupta'];
  const CITIES = [['Patna','BR'],['Patna','BR'],['Patna','BR'],['Bengaluru','KA'],
                  ['Pune','MH'],['Delhi','DL'],['Ahmedabad','GJ'],['Hyderabad','TS']];

  const newLeadIds = [];
  // Pre-load Solar status_ids (1..12 by sort_order)
  const stRows = await db.query(
    `SELECT id, sort_order FROM statuses ORDER BY sort_order ASC LIMIT 12`, []);
  const STATUS_IDS = stRows.rows.map(r => r.id);

  for (let i = 0; i < need; i++) {
    const nm = FIRST[i % FIRST.length] + ' ' + LAST[(i * 3) % LAST.length];
    const city = CITIES[i % CITIES.length];
    const phone = '9' + String(800000000 + i * 7 + Math.floor(Math.random() * 1000)).slice(-9);
    // Distribute leads across all Solar pipeline stages
    const statusId = STATUS_IDS[i % STATUS_IDS.length] || 1;
    try {
      const r = await db.query(
        `INSERT INTO leads (name, phone, city, state, source, status_id, created_at)
         VALUES ($1,$2,$3,$4,'Solar Demo', $6, now() - ($5 || ' days')::interval)
         RETURNING id`,
        [nm, phone, city[0], city[1], String(i % 60), statusId]
      );
      newLeadIds.push(r.rows[0].id);
    } catch (_) {}
  }

  // Pull 30 most recent leads (mix of existing + new)
  const allLeads = await db.query(`SELECT id, name FROM leads ORDER BY id DESC LIMIT 30`, []);
  const leads = allLeads.rows;
  if (leads.length < 12) {
    return { ok: false, error: 'Need at least 12 leads to seed demo. Only have ' + leads.length };
  }

  // 2. Site Surveys (one per lead, varied)
  const DISCOMS = ['BSEB','BSEB','BSEB','BESCOM','MSEDCL','BSES','UGVCL','TSSPDCL'];
  const ROOFS = ['rcc','rcc','rcc','metal','tiled'];
  const SHAPES = ['rectangular','l-shape','rectangular'];
  for (let i = 0; i < leads.length; i++) {
    const L = leads[i];
    const area = 320 + Math.floor(Math.random() * 760);
    const bill = 2200 + Math.floor(Math.random() * 8000);
    const kwRec = Number((bill / 100 / (5 * 30) * 1.05).toFixed(1));
    await db.query(
      `INSERT INTO sol_sites
         (lead_id, address, state, rooftop_area_sqft, roof_shape, roof_type,
          shadow_pct, monthly_bill_inr, sanctioned_load_kw, discom,
          consumer_category, meter_type, survey_done, kw_recommended,
          surveyed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() - ($15||' days')::interval, now() - ($15||' days')::interval)`,
      [L.id, 'Plot ' + (i + 1) + ', Sector ' + (i % 9 + 1), ['BR','BR','KA','MH','DL'][i % 5],
       area, SHAPES[i % 3], ROOFS[i % 5],
       Math.floor(Math.random() * 35), bill, kwRec * 1.2,
       DISCOMS[i % DISCOMS.length], 'domestic', i % 3 === 0 ? 'three_phase' : 'single_phase',
       i < 25 ? 1 : 0, kwRec, String(i + 2)]
    );
  }

  // 3. Quotes (18 quotes — first 12 leads get quotes, varied status)
  const STATUSES = ['draft','sent','sent','sent','accepted','booked','booked','booked',
                    'booked','booked','expired','lost'];
  const TIERS = ['mono_perc_tier1','mono_perc_tier1','poly_tier1','topcon_tier1'];
  const INVERTERS = ['Sungrow 5kW','Microtek 5kW','Luminous 5kW','Polycab 5kW','Fronius 5kW Primo'];

  const quoteIds = [];
  for (let i = 0; i < 18; i++) {
    const L = leads[i % leads.length];
    const kw = [3, 5, 5, 5, 8, 10, 10, 5, 5, 3, 10, 5, 5, 10, 5, 3, 5, 5][i] || 5;
    const calc = _calcPricing({ kw, rate_per_w: 38, inverter_inr: 38000, state: 'BR' });
    const r = await db.query(
      `INSERT INTO sol_quotes (lead_id, quote_no, kw, panel_tier, inverter_brand, state,
                                gross_inr, central_subsidy, state_subsidy, net_inr, gst_pct,
                                final_inr, annual_gen_kwh, payback_years, roi_25y_inr, status,
                                sent_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               CASE WHEN $16 IN ('sent','accepted','booked') THEN now() - ($17||' days')::interval ELSE NULL END,
               now() - ($17||' days')::interval)
       RETURNING id`,
      [L.id, 'SOL-' + (1000 + i).toString(36).toUpperCase(),
       kw, TIERS[i % TIERS.length], INVERTERS[i % INVERTERS.length], 'BR',
       calc.gross_inr, calc.central_subsidy, calc.state_subsidy, calc.net_inr, 13.8,
       calc.final_inr, calc.annual_gen_kwh, calc.payback_years, calc.roi_25y_inr,
       STATUSES[i % STATUSES.length], String(5 + (i % 25))]
    );
    quoteIds.push({ id: r.rows[0].id, lead_id: L.id, kw, final: calc.final_inr, status: STATUSES[i % STATUSES.length] });

    // Auto BOM lines per quote
    const panels = Math.ceil((kw * 1000) / 545);
    const items = [
      ['panel','Adani Mono PERC 545W', panels,'nos',14000],
      ['inverter', INVERTERS[i % INVERTERS.length], 1,'nos',38000],
      ['structure','Hot-dip galvanised', kw,'kW',3500],
      ['cable_dc','Polycab 6 sqmm', kw * 8,'m',120],
      ['cable_ac','Polycab 4 sqmm', kw * 4,'m',95],
      ['acdb_dcdb','Havells', 1,'set',6500],
      ['earthing','—', 3,'pit',2000],
      ['netmeter','DISCOM', 1,'nos',3000],
      ['labor','Crew install', 1,'job',6500]
    ];
    for (let k = 0; k < items.length; k++) {
      const [type, make, qty, unit, rate] = items[k];
      await db.query(
        `INSERT INTO sol_quote_items (quote_id, seq, item_type, make, qty, unit, rate, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.rows[0].id, k + 1, type, make, qty, unit, rate, qty * rate]);
    }
  }

  // 4. Installations — 12 active across all stages (1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 9, 9)
  const STAGE_DIST = [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 9, 9];
  const bookedQuotes = quoteIds.filter(q => q.status === 'booked');
  const installIds = [];

  for (let i = 0; i < STAGE_DIST.length; i++) {
    const stage = STAGE_DIST[i];
    const q = bookedQuotes[i % bookedQuotes.length] || quoteIds[i];
    const isDone = stage === 9;
    const r = await db.query(
      `INSERT INTO sol_installations
         (lead_id, quote_id, project_no, kw, total_inr,
          current_stage, status, booked_at,
          commissioned_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,
               now() - ($8||' days')::interval,
               CASE WHEN $9 THEN now() - ($10||' days')::interval ELSE NULL END,
               now() - ($8||' days')::interval)
       RETURNING id`,
      [q.lead_id, q.id, 'WW-' + (2800 + i * 7).toString(36).toUpperCase(),
       q.kw, q.final, stage,
       isDone ? 'done' : 'active',
       String(20 + i * 3), isDone, String(Math.floor(Math.random() * 14) + 1)]
    );
    installIds.push({ id: r.rows[0].id, stage });

    // Seed 9 milestone rows
    for (const m of INSTALL_MILESTONES) {
      const st = m.seq < stage ? 'done' : (m.seq === stage ? 'in_progress' : 'pending');
      await db.query(
        `INSERT INTO sol_install_milestones (install_id, seq, code, label, status, actual_date)
         VALUES ($1,$2,$3,$4,$5, CASE WHEN $5='done' THEN CURRENT_DATE - ($6||' days')::interval ELSE NULL END)`,
        [r.rows[0].id, m.seq, m.code, m.label, st, String((stage - m.seq) * 3 + 2)]);
    }
  }

  // 5. Subsidies — 8 across stages (2 disbursed, 6 in progress)
  const SUB_STAGES = [8, 8, 6, 5, 4, 3, 2, 7];
  for (let i = 0; i < SUB_STAGES.length && i < installIds.length; i++) {
    const stage = SUB_STAGES[i];
    const inst = installIds[i];
    await db.query(
      `INSERT INTO sol_subsidies
         (lead_id, install_id, scheme, discom, state, central_inr, state_inr,
          current_stage, stage_entered_at, total_started_at, disbursed_at, disbursed_ref)
       VALUES ($1,$2,'pm_surya_ghar','BSEB','BR', 78000, 0,
               $3, now() - ($4||' days')::interval,
               now() - ($5||' days')::interval,
               CASE WHEN $3=8 THEN now() - ($4||' days')::interval ELSE NULL END,
               CASE WHEN $3=8 THEN 'DBT/' || (1000000 + $2)::text ELSE NULL END)`,
      [quoteIds[i].lead_id, inst.id, stage,
       String(2 + (i % 15)), String(30 + i * 7)]
    );
  }

  // 6. AMC visits — 5 visits for commissioned projects
  const liveInstalls = installIds.filter(x => x.stage === 9);
  for (let i = 0; i < Math.min(5, liveInstalls.length); i++) {
    const inst = liveInstalls[i];
    const overdue = i < 2;
    await db.query(
      `INSERT INTO sol_amc_visits
         (install_id, lead_id, plan_code, plan_amount_inr,
          last_visit_at, next_due_at, gen_since_kwh, status)
       VALUES ($1,$2,$3,$4,
               CURRENT_DATE - INTERVAL '120 days',
               CURRENT_DATE + ($5||' days')::interval,
               $6,
               $7)`,
      [inst.id, quoteIds[i % quoteIds.length].lead_id,
       ['basic','standard','premium'][i % 3],
       [2000, 5000, 10000][i % 3],
       overdue ? String(-(20 + i * 5)) : String(15 + i * 7),
       800 + i * 200,
       overdue ? 'overdue' : 'scheduled']
    );
  }

  return {
    ok: true,
    seeded: {
      leads_created: newLeadIds.length,
      sites: leads.length,
      quotes: quoteIds.length,
      installations: installIds.length,
      subsidies: Math.min(SUB_STAGES.length, installIds.length),
      amc_visits: Math.min(5, liveInstalls.length)
    }
  };
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
  // APIs (Commit 1)
  api_solar_summary,
  api_solar_site_byLead,
  api_solar_site_list,
  api_solar_site_upsert,
  api_solar_pricing_config_get,
  api_solar_pricing_config_set,
  api_solar_pricing_calc,
  // APIs (Commit 2 — Quotes + Installations)
  api_solar_quote_create,
  api_solar_quote_byLead,
  api_solar_quote_list,
  api_solar_quote_items,
  api_solar_quote_setStatus,
  api_solar_install_create,
  api_solar_install_list,
  api_solar_install_byLead,
  api_solar_install_milestones,
  api_solar_install_advance,
  api_solar_install_summary,
  api_solar_inverter_brands_list,
  api_solar_subsidy_list,
  api_solar_subsidy_advance,
  api_solar_subsidy_report,
  api_solar_amc_list,
  api_solar_amc_markDone,
  api_solar_amc_summary,
  api_solar_insights_get,
  api_solar_resetStages,
  api_solar_seedDemo,

  // Exports for Commits 2+3
  INSTALL_MILESTONES,
  SUBSIDY_STAGES,
  CENTRAL_SUBSIDY,
  STATE_SUBSIDY,
  PANEL_TIER_RATES,
  _calcPricing,
  _installer
};
