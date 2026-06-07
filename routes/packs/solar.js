/**
 * routes/packs/solar.js — Solar industry pack (rooftop & utility solar)
 *
 * Tables (idempotent, namespaced solar_*):
 *   solar_sites solar_quotes solar_installations solar_subsidies solar_amc
 * Seeds: 9 statuses, 6 custom fields, 3 sample system sizes.
 */
'use strict';
const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser } = require('../../utils/auth');
const PACK_ID = 'solar';

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS solar_sites (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, address TEXT NOT NULL DEFAULT '',
    pincode TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '',
    rooftop_area_sqft NUMERIC(10,2) NOT NULL DEFAULT 0,
    monthly_bill_inr NUMERIC(10,2) NOT NULL DEFAULT 0,
    monthly_units_kwh NUMERIC(10,2) NOT NULL DEFAULT 0,
    roof_type TEXT NOT NULL DEFAULT 'rcc', shadow_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    discom TEXT NOT NULL DEFAULT '', sanctioned_load_kw NUMERIC(8,2) NOT NULL DEFAULT 0,
    survey_done INTEGER NOT NULL DEFAULT 0, survey_at TIMESTAMPTZ,
    survey_by INTEGER, survey_notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS solar_sites_lead_idx ON solar_sites(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS solar_quotes (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, site_id INTEGER,
    quote_no TEXT NOT NULL DEFAULT '', system_kw NUMERIC(8,2) NOT NULL DEFAULT 0,
    panel_brand TEXT NOT NULL DEFAULT '', panel_count INTEGER NOT NULL DEFAULT 0,
    inverter_brand TEXT NOT NULL DEFAULT '', structure_type TEXT NOT NULL DEFAULT 'standard',
    on_grid INTEGER NOT NULL DEFAULT 1, battery_kwh NUMERIC(8,2) NOT NULL DEFAULT 0,
    rate_per_kw NUMERIC(10,2) NOT NULL DEFAULT 0, subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    gst NUMERIC(14,2) NOT NULL DEFAULT 0, total NUMERIC(14,2) NOT NULL DEFAULT 0,
    subsidy_estimated NUMERIC(14,2) NOT NULL DEFAULT 0,
    valid_till DATE, sent_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'draft',
    notes TEXT NOT NULL DEFAULT '', created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS solar_quotes_lead_idx ON solar_quotes(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS solar_installations (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, quote_id INTEGER,
    system_kw NUMERIC(8,2) NOT NULL DEFAULT 0,
    material_ordered_at DATE, material_delivered_at DATE,
    installation_start DATE, installation_end DATE,
    net_meter_applied_at DATE, net_meter_installed_at DATE,
    commissioned_at DATE, installer_name TEXT NOT NULL DEFAULT '',
    installer_phone TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS solar_installations_lead_idx ON solar_installations(lead_id)`);

  await db.query(`CREATE TABLE IF NOT EXISTS solar_subsidies (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, installation_id INTEGER,
    dso_app_no TEXT NOT NULL DEFAULT '', subsidy_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    application_at DATE, approval_at DATE, disbursed_at DATE,
    status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  await db.query(`CREATE TABLE IF NOT EXISTS solar_amc (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, installation_id INTEGER,
    start_date DATE NOT NULL, end_date DATE NOT NULL,
    next_visit_date DATE, last_visit_date DATE,
    amount NUMERIC(10,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

async function install(opts) {
  await _ensureSchema();
  const STATUSES = [
    ['New Inquiry','#3b82f6',1],['Site Visit Scheduled','#06b6d4',2],['Site Visit Done','#0891b2',3],
    ['Quote Sent','#f59e0b',4],['Negotiation','#a855f7',5],['Booked','#10b981',6],
    ['Material Ordered','#84cc16',7],['Installation In Progress','#eab308',8],
    ['Commissioned','#22c55e',9],['Subsidy Claimed','#16a34a',10]
  ];
  // PACK_STAGE_TAG_v1 — tag statuses with pack_id for clean industry isolation
  try { await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  try { await db.query(`ALTER TABLE lead_custom_fields ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  // Deactivate any older non-generic pack statuses to keep pipeline clean
  try { await db.query(`UPDATE statuses SET is_active=0 WHERE pack_id IS NOT NULL AND pack_id <> $1`, ['solar']); } catch(_){}
  for (const s of STATUSES) {
    try { await db.query(`INSERT INTO statuses (name,color,sort_order,is_active,pack_id) VALUES ($1,$2,$3,1,'solar') ON CONFLICT (name) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, s); } catch(_){}
  }
  const CFS = [
    ['rooftop_area','Rooftop area (sqft)','number'],
    ['monthly_bill','Monthly bill (₹)','number'],
    ['kw_required','KW required','number'],
    ['subsidy_eligible','Subsidy eligible','text'],
    ['dso_app_no','DISCOM application no','text'],
    ['discom','DISCOM','text']
  ];
  for (const cf of CFS) {
    try { await db.query(`INSERT INTO lead_custom_fields (field_key,label,field_type,is_active,pack_id) VALUES ($1,$2,$3,1,'solar') ON CONFLICT (field_key) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, cf); } catch(_){}
  }
}
async function uninstall() {}

async function api_solar_site_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  if (p.id) {
    await db.query(`UPDATE solar_sites SET address=$1,pincode=$2,state=$3,rooftop_area_sqft=$4,monthly_bill_inr=$5,monthly_units_kwh=$6,roof_type=$7,shadow_pct=$8,discom=$9,sanctioned_load_kw=$10,survey_notes=$11 WHERE id=$12`,
      [p.address||'',p.pincode||'',p.state||'',p.rooftop_area_sqft||0,p.monthly_bill_inr||0,p.monthly_units_kwh||0,p.roof_type||'rcc',p.shadow_pct||0,p.discom||'',p.sanctioned_load_kw||0,p.survey_notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO solar_sites (lead_id,address,pincode,state,rooftop_area_sqft,monthly_bill_inr,monthly_units_kwh,roof_type,shadow_pct,discom,sanctioned_load_kw,survey_notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [p.lead_id,p.address||'',p.pincode||'',p.state||'',p.rooftop_area_sqft||0,p.monthly_bill_inr||0,p.monthly_units_kwh||0,p.roof_type||'rcc',p.shadow_pct||0,p.discom||'',p.sanctioned_load_kw||0,p.survey_notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_solar_site_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM solar_sites WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { sites: r.rows };
}
async function api_solar_site_markSurveyDone(token, payload) {
  const me = await authUser(token);
  await db.query(`UPDATE solar_sites SET survey_done=1, survey_at=NOW(), survey_by=$1, survey_notes=COALESCE($2, survey_notes) WHERE id=$3`,
    [me.id, (payload&&payload.survey_notes)||null, (payload&&payload.id)||0]);
  return { ok: true };
}

async function api_solar_quote_save(token, payload) {
  const me = await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const subtotal = Number(p.system_kw||0) * Number(p.rate_per_kw||0);
  const gst = subtotal * 0.138;
  const total = subtotal + gst;
  if (p.id) {
    await db.query(`UPDATE solar_quotes SET site_id=$1,quote_no=$2,system_kw=$3,panel_brand=$4,panel_count=$5,inverter_brand=$6,structure_type=$7,on_grid=$8,battery_kwh=$9,rate_per_kw=$10,subtotal=$11,gst=$12,total=$13,subsidy_estimated=$14,valid_till=$15,status=$16,notes=$17 WHERE id=$18`,
      [p.site_id||null,p.quote_no||'',p.system_kw||0,p.panel_brand||'',p.panel_count||0,p.inverter_brand||'',p.structure_type||'standard',p.on_grid?1:0,p.battery_kwh||0,p.rate_per_kw||0,subtotal,gst,total,p.subsidy_estimated||0,p.valid_till||null,p.status||'draft',p.notes||'',p.id]);
    return { ok: true, id: p.id, total };
  }
  const r = await db.query(`INSERT INTO solar_quotes (lead_id,site_id,quote_no,system_kw,panel_brand,panel_count,inverter_brand,structure_type,on_grid,battery_kwh,rate_per_kw,subtotal,gst,total,subsidy_estimated,valid_till,status,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [p.lead_id,p.site_id||null,p.quote_no||'',p.system_kw||0,p.panel_brand||'',p.panel_count||0,p.inverter_brand||'',p.structure_type||'standard',p.on_grid?1:0,p.battery_kwh||0,p.rate_per_kw||0,subtotal,gst,total,p.subsidy_estimated||0,p.valid_till||null,p.status||'draft',p.notes||'',me.id]);
  return { ok: true, id: r.rows[0].id, total };
}
async function api_solar_quote_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM solar_quotes WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { quotes: r.rows };
}

async function api_solar_install_create(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const r = await db.query(`INSERT INTO solar_installations (lead_id,quote_id,system_kw,material_ordered_at,material_delivered_at,installation_start,installation_end,net_meter_applied_at,net_meter_installed_at,commissioned_at,installer_name,installer_phone,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [p.lead_id,p.quote_id||null,p.system_kw||0,p.material_ordered_at||null,p.material_delivered_at||null,p.installation_start||null,p.installation_end||null,p.net_meter_applied_at||null,p.net_meter_installed_at||null,p.commissioned_at||null,p.installer_name||'',p.installer_phone||'',p.status||'pending',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_solar_install_update(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('id required');
  await db.query(`UPDATE solar_installations SET material_ordered_at=$1,material_delivered_at=$2,installation_start=$3,installation_end=$4,net_meter_applied_at=$5,net_meter_installed_at=$6,commissioned_at=$7,installer_name=$8,installer_phone=$9,status=$10,notes=$11 WHERE id=$12`,
    [p.material_ordered_at||null,p.material_delivered_at||null,p.installation_start||null,p.installation_end||null,p.net_meter_applied_at||null,p.net_meter_installed_at||null,p.commissioned_at||null,p.installer_name||'',p.installer_phone||'',p.status||'pending',p.notes||'',p.id]);
  return { ok: true };
}
async function api_solar_install_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM solar_installations WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { installations: r.rows };
}

async function api_solar_subsidy_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  if (p.id) {
    await db.query(`UPDATE solar_subsidies SET dso_app_no=$1, subsidy_amount=$2, application_at=$3, approval_at=$4, disbursed_at=$5, status=$6, notes=$7 WHERE id=$8`,
      [p.dso_app_no||'',p.subsidy_amount||0,p.application_at||null,p.approval_at||null,p.disbursed_at||null,p.status||'pending',p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO solar_subsidies (lead_id,installation_id,dso_app_no,subsidy_amount,application_at,approval_at,disbursed_at,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [p.lead_id,p.installation_id||null,p.dso_app_no||'',p.subsidy_amount||0,p.application_at||null,p.approval_at||null,p.disbursed_at||null,p.status||'pending',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_solar_subsidy_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM solar_subsidies WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { subsidies: r.rows };
}

async function api_solar_amc_save(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  if (p.id) {
    await db.query(`UPDATE solar_amc SET start_date=$1, end_date=$2, next_visit_date=$3, last_visit_date=$4, amount=$5, status=$6, notes=$7 WHERE id=$8`,
      [p.start_date,p.end_date,p.next_visit_date||null,p.last_visit_date||null,p.amount||0,p.status||'active',p.notes||'',p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO solar_amc (lead_id,installation_id,start_date,end_date,next_visit_date,amount,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.lead_id,p.installation_id||null,p.start_date,p.end_date,p.next_visit_date||null,p.amount||0,p.status||'active',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_solar_amc_dueVisits(token, payload) {
  await authUser(token); await _ensureSchema();
  const days = parseInt(((payload&&payload.days)||30), 10);
  const r = await db.query(`SELECT a.*, l.name AS lead_name, l.phone AS lead_phone FROM solar_amc a LEFT JOIN leads l ON l.id=a.lead_id WHERE a.status='active' AND a.next_visit_date IS NOT NULL AND a.next_visit_date <= CURRENT_DATE + INTERVAL '${days} days' ORDER BY a.next_visit_date ASC`);
  return { visits: r.rows };
}

async function api_solar_summary(token) {
  await authUser(token); await _ensureSchema();
  const sites = await db.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(CASE WHEN survey_done=1 THEN 1 ELSE 0 END),0)::int AS surveyed FROM solar_sites`);
  const quotes = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(total),0) AS value FROM solar_quotes WHERE status='sent'`);
  const installed = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(system_kw),0) AS kw FROM solar_installations WHERE commissioned_at IS NOT NULL`);
  const subPending = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(subsidy_amount),0) AS amt FROM solar_subsidies WHERE status NOT IN ('disbursed','rejected')`);
  const amcDue = await db.query(`SELECT COUNT(*)::int AS cnt FROM solar_amc WHERE status='active' AND next_visit_date IS NOT NULL AND next_visit_date <= CURRENT_DATE + INTERVAL '30 days'`);
  return {
    sites: { total: sites.rows[0].total, surveyed: sites.rows[0].surveyed },
    quotes_sent: { count: quotes.rows[0].cnt, value: Number(quotes.rows[0].value) },
    commissioned: { count: installed.rows[0].cnt, kw: Number(installed.rows[0].kw) },
    subsidy_pending: { count: subPending.rows[0].cnt, amount: Number(subPending.rows[0].amt) },
    amc_due_30d: amcDue.rows[0].cnt
  };
}

framework.register({
  id: PACK_ID, name: 'Solar', industry: 'solar',
  summary: 'Rooftop / utility solar — site survey, quote builder, installation tracker, subsidy + AMC.',
  version: '1.0.0',
  features: ['Site survey (rooftop area / monthly bill / shadow %)','Quote builder with auto GST + subsidy estimate','Installation tracker (material → install → net-meter → commissioning)','DISCOM subsidy claim tracker','AMC schedule + next-visit reminder','10 Solar statuses + 6 custom fields seeded'],
  nav_items: [
    { id: 'solarsites',     label: '🏠 Site Survey', icon: '🏠' },
    { id: 'solarquotes',    label: '📑 Quote Builder', icon: '📑' },
    { id: 'solarinstalls',  label: '🔧 Installation', icon: '🔧' },
    { id: 'solarsubsidies', label: '💰 Subsidy', icon: '💰' },
    { id: 'solaramc',       label: '🧰 AMC', icon: '🧰' }
  ],
  install, uninstall
});

module.exports = {
  install, uninstall, _ensureSchema,
  api_solar_site_save, api_solar_site_byLead, api_solar_site_markSurveyDone,
  api_solar_quote_save, api_solar_quote_byLead,
  api_solar_install_create, api_solar_install_update, api_solar_install_byLead,
  api_solar_subsidy_save, api_solar_subsidy_byLead,
  api_solar_amc_save, api_solar_amc_dueVisits,
  api_solar_summary
};
