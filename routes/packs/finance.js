/**
 * routes/packs/finance.js — Finance industry pack (Insurance / Loans / Investments)
 *
 * Tables (idempotent, namespaced fin_*):
 *   fin_products fin_policies fin_premiums fin_claims
 * Seeds: 4 sample products, 8 statuses, 7 custom fields.
 */
'use strict';
const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser } = require('../../utils/auth');
const PACK_ID = 'finance';

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS fin_products (
    id SERIAL PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'insurance',
    sub_category TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL DEFAULT '',
    sum_assured_min NUMERIC(14,2) NOT NULL DEFAULT 0, sum_assured_max NUMERIC(14,2) NOT NULL DEFAULT 0,
    tenure_min_months INTEGER NOT NULL DEFAULT 12, tenure_max_months INTEGER NOT NULL DEFAULT 360,
    interest_rate NUMERIC(5,2) NOT NULL DEFAULT 0, commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '', is_active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS fin_policies (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, product_id INTEGER,
    policy_no TEXT NOT NULL DEFAULT '', sum_assured NUMERIC(14,2) NOT NULL DEFAULT 0,
    sanctioned_amount NUMERIC(14,2) NOT NULL DEFAULT 0, disbursed_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    tenure_months INTEGER NOT NULL DEFAULT 0, interest_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    emi_amount NUMERIC(12,2) NOT NULL DEFAULT 0, premium_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    premium_frequency TEXT NOT NULL DEFAULT 'annual', start_date DATE, maturity_date DATE,
    status TEXT NOT NULL DEFAULT 'sanctioned', pan TEXT NOT NULL DEFAULT '', cibil INTEGER,
    notes TEXT NOT NULL DEFAULT '', created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS fin_policies_lead_idx ON fin_policies(lead_id)`);
  await db.query(`CREATE TABLE IF NOT EXISTS fin_premiums (
    id SERIAL PRIMARY KEY, policy_id INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 1,
    due_date DATE NOT NULL, amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', paid_at TIMESTAMPTZ,
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0, payment_mode TEXT NOT NULL DEFAULT '',
    payment_ref TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS fin_premiums_policy_idx ON fin_premiums(policy_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS fin_premiums_due_idx ON fin_premiums(status, due_date)`);
  await db.query(`CREATE TABLE IF NOT EXISTS fin_claims (
    id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, policy_id INTEGER,
    claim_no TEXT NOT NULL DEFAULT '', claim_type TEXT NOT NULL DEFAULT '',
    incident_date DATE, claim_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    approved_amount NUMERIC(14,2) NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'submitted',
    docs_status TEXT NOT NULL DEFAULT 'pending', notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS fin_claims_lead_idx ON fin_claims(lead_id)`);
}

async function install(opts) {
  await _ensureSchema();
  const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM fin_products`);
  if (cnt.rows[0].n === 0) {
    const products = [
      ['Term Life Plan','insurance','term_life','LIC',1000000,20000000,60,360,0,5],
      ['Health Insurance','insurance','health','Star Health',200000,5000000,12,12,0,10],
      ['Personal Loan','loan','personal','HDFC Bank',50000,4000000,12,60,11.5,1.5],
      ['Home Loan','loan','home','SBI',1000000,50000000,60,360,8.5,0.5]
    ];
    for (const p of products) {
      await db.query(`INSERT INTO fin_products (name,category,sub_category,provider,sum_assured_min,sum_assured_max,tenure_min_months,tenure_max_months,interest_rate,commission_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, p);
    }
  }
  const STATUSES = [['New Lead','#3b82f6',1],['KYC Pending','#f59e0b',2],['Docs Collected','#8b5cf6',3],['Underwriting','#a855f7',4],['Sanctioned','#10b981',5],['Disbursed','#059669',6],['Renewal Due','#f97316',7],['Lapsed','#ef4444',8]];
  // PACK_STAGE_TAG_v1 — tag statuses with pack_id for clean industry isolation
  try { await db.query(`ALTER TABLE statuses ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  try { await db.query(`ALTER TABLE lead_custom_fields ADD COLUMN IF NOT EXISTS pack_id TEXT DEFAULT NULL`); } catch(_){}
  // Deactivate any older non-generic pack statuses to keep pipeline clean
  try { await db.query(`UPDATE statuses SET is_active=0 WHERE pack_id IS NOT NULL AND pack_id <> $1`, ['finance']); } catch(_){}
  for (const s of STATUSES) {
    try { await db.query(`INSERT INTO statuses (name,color,sort_order,is_active,pack_id) VALUES ($1,$2,$3,1,'finance') ON CONFLICT (name) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, s); } catch(_){}
  }
  const CFS = [['pan','PAN Number','text'],['cibil','CIBIL Score','number'],['loan_amount','Loan Amount','number'],['tenure_months','Tenure (months)','number'],['emi_amount','EMI Amount','number'],['policy_type','Policy Type','text'],['premium_amount','Premium Amount','number']];
  for (const cf of CFS) {
    try { await db.query(`INSERT INTO lead_custom_fields (field_key,label,field_type,is_active,pack_id) VALUES ($1,$2,$3,1,'finance') ON CONFLICT (field_key) DO UPDATE SET is_active=1, pack_id=EXCLUDED.pack_id`, cf); } catch(_){}
  }
}
async function uninstall() {}

async function api_fin_products_list(token) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM fin_products WHERE is_active=1 ORDER BY category,name`);
  return { products: r.rows };
}
async function api_fin_products_save(token, payload) {
  const me = await authUser(token);
  if (me.role!=='admin'&&me.role!=='manager') throw new Error('Admin / manager only');
  await _ensureSchema(); const p = payload || {};
  if (p.id) {
    await db.query(`UPDATE fin_products SET name=$1,category=$2,sub_category=$3,provider=$4,sum_assured_min=$5,sum_assured_max=$6,tenure_min_months=$7,tenure_max_months=$8,interest_rate=$9,commission_pct=$10,notes=$11,is_active=$12 WHERE id=$13`,
      [p.name,p.category||'insurance',p.sub_category||'',p.provider||'',p.sum_assured_min||0,p.sum_assured_max||0,p.tenure_min_months||12,p.tenure_max_months||360,p.interest_rate||0,p.commission_pct||0,p.notes||'',p.is_active!==0?1:0,p.id]);
    return { ok: true, id: p.id };
  }
  const r = await db.query(`INSERT INTO fin_products (name,category,sub_category,provider,sum_assured_min,sum_assured_max,tenure_min_months,tenure_max_months,interest_rate,commission_pct,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [p.name,p.category||'insurance',p.sub_category||'',p.provider||'',p.sum_assured_min||0,p.sum_assured_max||0,p.tenure_min_months||12,p.tenure_max_months||360,p.interest_rate||0,p.commission_pct||0,p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}

async function _genPremiumSchedule(policyId, p) {
  const freq = String(p.premium_frequency||'annual').toLowerCase();
  const monthsPer = freq==='monthly'?1:freq==='quarter'?3:freq==='half'?6:12;
  const totalMonths = Number(p.tenure_months||12);
  const count = Math.max(1, Math.ceil(totalMonths/monthsPer));
  const start = p.start_date ? new Date(p.start_date) : new Date();
  const amount = freq==='annual' ? Number(p.premium_amount||0) : (p.emi_amount?Number(p.emi_amount):Number(p.premium_amount||0));
  for (let i=0; i<count; i++) {
    const d = new Date(start); d.setMonth(d.getMonth()+i*monthsPer);
    await db.query(`INSERT INTO fin_premiums (policy_id,seq,due_date,amount) VALUES ($1,$2,$3,$4)`, [policyId,i+1,d.toISOString().slice(0,10),amount]);
  }
}

async function api_fin_policy_create(token, payload) {
  const me = await authUser(token); await _ensureSchema();
  const p = payload || {};
  if (!p.lead_id) throw new Error('lead_id required');
  const r = await db.query(`INSERT INTO fin_policies (lead_id,product_id,policy_no,sum_assured,sanctioned_amount,disbursed_amount,tenure_months,interest_rate,emi_amount,premium_amount,premium_frequency,start_date,maturity_date,status,pan,cibil,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [p.lead_id,p.product_id||null,p.policy_no||'',p.sum_assured||0,p.sanctioned_amount||0,p.disbursed_amount||0,p.tenure_months||12,p.interest_rate||0,p.emi_amount||0,p.premium_amount||0,p.premium_frequency||'annual',p.start_date||null,p.maturity_date||null,p.status||'sanctioned',p.pan||'',p.cibil||null,p.notes||'',me.id]);
  await _genPremiumSchedule(r.rows[0].id, p);
  return { ok: true, id: r.rows[0].id };
}
async function api_fin_policy_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const leadId = (payload&&payload.lead_id) || 0;
  const pols = await db.query(`SELECT p.*, pr.name AS product_name, pr.category AS product_category FROM fin_policies p LEFT JOIN fin_products pr ON pr.id=p.product_id WHERE p.lead_id=$1 ORDER BY p.created_at DESC`, [leadId]);
  const out = [];
  for (const pol of pols.rows) {
    const prem = await db.query(`SELECT * FROM fin_premiums WHERE policy_id=$1 ORDER BY seq`, [pol.id]);
    out.push({ ...pol, premiums: prem.rows });
  }
  return { policies: out };
}
async function api_fin_policy_cancel(token, payload) {
  const me = await authUser(token);
  if (me.role!=='admin'&&me.role!=='manager') throw new Error('Admin / manager only');
  await db.query(`UPDATE fin_policies SET status='cancelled' WHERE id=$1`, [(payload&&payload.id)||0]);
  return { ok: true };
}
async function api_fin_premium_markPaid(token, payload) {
  await authUser(token);
  const p = payload || {}; if (!p.id) throw new Error('premium id required');
  await db.query(`UPDATE fin_premiums SET status='paid', paid_at=NOW(), paid_amount=$1, payment_mode=$2, payment_ref=$3 WHERE id=$4`,
    [p.paid_amount||0,p.payment_mode||'',p.payment_ref||'',p.id]);
  return { ok: true };
}
async function api_fin_premium_upcomingDue(token, payload) {
  await authUser(token); await _ensureSchema();
  const days = parseInt(((payload&&payload.days)||30), 10);
  const r = await db.query(`SELECT pm.*, p.lead_id, p.policy_no, l.name AS lead_name, l.phone AS lead_phone FROM fin_premiums pm JOIN fin_policies p ON p.id=pm.policy_id LEFT JOIN leads l ON l.id=p.lead_id WHERE pm.status='pending' AND pm.due_date <= CURRENT_DATE + INTERVAL '${days} days' ORDER BY pm.due_date ASC LIMIT 200`);
  return { premiums: r.rows };
}
async function api_fin_claim_create(token, payload) {
  await authUser(token); await _ensureSchema();
  const p = payload || {}; if (!p.lead_id) throw new Error('lead_id required');
  const r = await db.query(`INSERT INTO fin_claims (lead_id,policy_id,claim_no,claim_type,incident_date,claim_amount,approved_amount,status,docs_status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [p.lead_id,p.policy_id||null,p.claim_no||'',p.claim_type||'',p.incident_date||null,p.claim_amount||0,p.approved_amount||0,p.status||'submitted',p.docs_status||'pending',p.notes||'']);
  return { ok: true, id: r.rows[0].id };
}
async function api_fin_claim_byLead(token, payload) {
  await authUser(token); await _ensureSchema();
  const r = await db.query(`SELECT * FROM fin_claims WHERE lead_id=$1 ORDER BY created_at DESC`, [(payload&&payload.lead_id)||0]);
  return { claims: r.rows };
}
async function api_fin_claim_update(token, payload) {
  await authUser(token); const p = payload || {}; if (!p.id) throw new Error('claim id required');
  await db.query(`UPDATE fin_claims SET status=$1, docs_status=$2, approved_amount=$3, notes=$4, updated_at=NOW() WHERE id=$5`,
    [p.status||'submitted',p.docs_status||'pending',p.approved_amount||0,p.notes||'',p.id]);
  return { ok: true };
}
async function api_fin_renewal_due(token, payload) {
  await authUser(token); await _ensureSchema();
  const days = parseInt(((payload&&payload.days)||60), 10);
  const r = await db.query(`SELECT p.*, l.name AS lead_name, l.phone AS lead_phone FROM fin_policies p LEFT JOIN leads l ON l.id=p.lead_id WHERE p.maturity_date IS NOT NULL AND p.status NOT IN ('cancelled','lapsed','renewed') AND p.maturity_date <= CURRENT_DATE + INTERVAL '${days} days' ORDER BY p.maturity_date ASC LIMIT 200`);
  return { renewals: r.rows };
}
async function api_fin_renewal_markRenewed(token, payload) {
  await authUser(token);
  await db.query(`UPDATE fin_policies SET status='renewed' WHERE id=$1`, [(payload&&payload.id)||0]);
  return { ok: true };
}
async function api_fin_summary(token) {
  await authUser(token); await _ensureSchema();
  const sanctioned = await db.query(`SELECT COALESCE(SUM(sanctioned_amount),0) AS amt, COUNT(*)::int AS cnt FROM fin_policies WHERE status IN ('sanctioned','disbursed','renewed')`);
  const disbursed  = await db.query(`SELECT COALESCE(SUM(disbursed_amount),0) AS amt FROM fin_policies WHERE status IN ('disbursed','renewed')`);
  const dueSoon    = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0) AS amt FROM fin_premiums WHERE status='pending' AND due_date <= CURRENT_DATE + INTERVAL '30 days'`);
  const overdue    = await db.query(`SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount),0) AS amt FROM fin_premiums WHERE status='pending' AND due_date < CURRENT_DATE`);
  const claimsOpen = await db.query(`SELECT COUNT(*)::int AS cnt FROM fin_claims WHERE status NOT IN ('settled','rejected','cancelled')`);
  const renewals30 = await db.query(`SELECT COUNT(*)::int AS cnt FROM fin_policies WHERE maturity_date IS NOT NULL AND status NOT IN ('cancelled','lapsed','renewed') AND maturity_date <= CURRENT_DATE + INTERVAL '60 days'`);
  return {
    sanctioned: { count: sanctioned.rows[0].cnt, amount: Number(sanctioned.rows[0].amt) },
    disbursed: { amount: Number(disbursed.rows[0].amt) },
    premium_due_30d: { count: dueSoon.rows[0].cnt, amount: Number(dueSoon.rows[0].amt) },
    overdue: { count: overdue.rows[0].cnt, amount: Number(overdue.rows[0].amt) },
    claims_open: claimsOpen.rows[0].cnt,
    renewals_60d: renewals30.rows[0].cnt
  };
}

framework.register({
  id: PACK_ID, name: 'Finance', industry: 'finance',
  summary: 'Insurance / loan / investment workflow — products, policies, premium schedules, claims, renewals.',
  version: '1.0.0',
  features: ['Product catalog (insurance / loan / SIP)','Per-lead policy issuance + auto premium schedule','Premium due tracker (15 / 7 / 1 days)','Claim tracker with docs status','Renewal due tracker','8 Finance statuses + 7 custom fields seeded'],
  nav_items: [
    { id: 'finpolicies', label: '📋 Policies', icon: '📋' },
    { id: 'finpremiums', label: '💸 Premium Due', icon: '💸' },
    { id: 'finclaims',   label: '🛡 Claims', icon: '🛡' },
    { id: 'finrenewals', label: '🔄 Renewals', icon: '🔄' }
  ],
  install, uninstall
});

module.exports = {
  install, uninstall, _ensureSchema,
  api_fin_products_list, api_fin_products_save,
  api_fin_policy_create, api_fin_policy_byLead, api_fin_policy_cancel,
  api_fin_premium_markPaid, api_fin_premium_upcomingDue,
  api_fin_claim_create, api_fin_claim_byLead, api_fin_claim_update,
  api_fin_renewal_due, api_fin_renewal_markRenewed,
  api_fin_summary
};
