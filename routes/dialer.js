/* POWER_DIALER_v1 — Phase 1 (web power/progressive dialer).
 * Admin builds a campaign + uploads leads + assigns to agents (round-robin).
 * Agent runs an auto-advancing dial loop: get next lead -> call -> disposition
 * + remark -> system serves the next lead. (Native APK auto-dial = later phase.)
 *
 * Self-healing schema (raw queries; no SCHEMA-cache registration needed).
 */
'use strict';
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

let _ensured = false;
async function ensureSchema() {
  if (_ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS dialer_campaigns (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'running',   -- running | paused | done
      pacing_sec    INT  NOT NULL DEFAULT 3,
      require_remark INT NOT NULL DEFAULT 1,
      created_by    INT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS dialer_campaign_leads (
      id            SERIAL PRIMARY KEY,
      campaign_id   INT NOT NULL,
      lead_id       INT,
      name          TEXT,
      phone         TEXT,
      assigned_to   INT,
      status        TEXT NOT NULL DEFAULT 'queued',    -- queued | in_progress | done | callback | dnc
      outcome       TEXT,
      remark        TEXT,
      attempt_count INT NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dcl_camp ON dialer_campaign_leads(campaign_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_dcl_agent ON dialer_campaign_leads(assigned_to, status)`);
  // DIALER_RECHURN_v1 — how many times a lead has been re-churned (recycled to another agent).
  await db.query(`ALTER TABLE dialer_campaign_leads ADD COLUMN IF NOT EXISTS churn_count INT NOT NULL DEFAULT 0`);
  _ensured = true;
}

const _norm = (p) => String(p || '').replace(/\D/g, '').slice(-12);

// ---------- admin ----------
async function api_dialer_campaigns_list(token) {
  const me = await authUser(token);
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT c.*,
       (SELECT COUNT(*) FROM dialer_campaign_leads l WHERE l.campaign_id=c.id)::int AS total,
       (SELECT COUNT(*) FROM dialer_campaign_leads l WHERE l.campaign_id=c.id AND l.status='done')::int AS done,
       (SELECT COUNT(*) FROM dialer_campaign_leads l WHERE l.campaign_id=c.id AND l.status='queued')::int AS queued,
       (SELECT COALESCE(SUM(l.churn_count),0) FROM dialer_campaign_leads l WHERE l.campaign_id=c.id)::int AS churned
     FROM dialer_campaigns c ORDER BY c.id DESC`);
  return rows;
}

async function api_dialer_campaign_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('Campaign name required');
  const pacing = Math.max(0, Math.min(60, Number(p.pacing_sec) || 3));
  const reqRem = p.require_remark === false || Number(p.require_remark) === 0 ? 0 : 1;
  if (p.id) {
    await db.query(`UPDATE dialer_campaigns SET name=$1, pacing_sec=$2, require_remark=$3, status=$4 WHERE id=$5`,
      [String(p.name).slice(0, 160), pacing, reqRem, String(p.status || 'running'), Number(p.id)]);
    return { ok: true, id: Number(p.id) };
  }
  const r = await db.query(
    `INSERT INTO dialer_campaigns (name, pacing_sec, require_remark, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [String(p.name).slice(0, 160), pacing, reqRem, me.id]);
  return { ok: true, id: r.rows[0].id };
}

async function api_dialer_campaign_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await ensureSchema();
  await db.query(`DELETE FROM dialer_campaign_leads WHERE campaign_id=$1`, [Number(id)]);
  await db.query(`DELETE FROM dialer_campaigns WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* DIALER_DIST_v1 — return an array (length n) of agent ids per lead.
 * round_robin: a,b,c,a,b,c…  equal: contiguous chunks  percent: by weight %. */
function _buildAssignPlan(n, agents, distribution, weights) {
  const plan = [];
  if (!agents.length) return plan;
  if (distribution === 'equal') {
    const chunk = Math.ceil(n / agents.length);
    for (let i = 0; i < n; i++) plan.push(agents[Math.min(agents.length - 1, Math.floor(i / chunk))]);
  } else if (distribution === 'percent' && weights) {
    const counts = agents.map(a => Math.floor(((Number(weights[a]) || 0) / 100) * n));
    let assigned = counts.reduce((x, y) => x + y, 0);
    let idx = 0;
    while (assigned < n) { counts[idx % agents.length]++; assigned++; idx++; }
    agents.forEach((a, i) => { for (let k = 0; k < counts[i]; k++) plan.push(a); });
  } else {
    for (let i = 0; i < n; i++) plan.push(agents[i % agents.length]);
  }
  return plan;
}

/* Add leads + round-robin assign across the given agent ids.
 * payload: { campaign_id, leads:[{name,phone}], assign_to:[userId,...] } */
async function api_dialer_addLeads(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await ensureSchema();
  const p = payload || {};
  const cid = Number(p.campaign_id);
  if (!cid) throw new Error('campaign_id required');
  const agents = (Array.isArray(p.assign_to) ? p.assign_to : []).map(Number).filter(Boolean);
  const distribution = ['round_robin', 'equal', 'percent'].includes(p.distribution) ? p.distribution : 'round_robin';
  const weights = (p.weights && typeof p.weights === 'object') ? p.weights : null;
  const dupPolicy = ['allow', 'skip_campaign', 'skip_all'].includes(p.duplicate_policy) ? p.duplicate_policy : 'skip_campaign';
  const rawLeads = (Array.isArray(p.leads) ? p.leads : [])
    .map(l => ({ name: String(l.name || '').slice(0, 160), phone: _norm(l.phone) }))
    .filter(l => l.phone.length >= 7);
  if (!rawLeads.length) throw new Error('No valid leads (need at least a phone number)');
  if (rawLeads.length > 10000) throw new Error('Too many leads in one upload (max 10,000). Split the file.');

  // DIALER_DEDUPE_v1 — existing phones already in THIS campaign (last 10 digits).
  const campPhones = new Set();
  if (dupPolicy !== 'allow') {
    try {
      const ex = await db.query(
        `SELECT right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10) AS p10
           FROM dialer_campaign_leads WHERE campaign_id=$1`, [cid]);
      ex.rows.forEach(r => { if (r.p10) campPhones.add(r.p10); });
    } catch (_) {}
  }

  // Resolve existing CRM lead + apply the duplicate policy → finalLeads.
  const finalLeads = [];
  const seen = new Set();
  let skipped = 0;
  for (const l of rawLeads) {
    const p10 = l.phone.slice(-10);
    let leadId = null, foundName = null;
    try {
      const m = await db.query(
        `SELECT id, name FROM leads WHERE right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10) = right($1,10) LIMIT 1`,
        [l.phone]);
      if (m.rows.length) { leadId = m.rows[0].id; foundName = m.rows[0].name; }
    } catch (_) {}
    if (dupPolicy !== 'allow') {
      if (seen.has(p10) || campPhones.has(p10)) { skipped++; continue; }   // dup in file or already in campaign
      if (dupPolicy === 'skip_all' && leadId) { skipped++; continue; }      // already exists anywhere in CRM
    }
    seen.add(p10);
    finalLeads.push({ name: l.name, phone: l.phone, leadId, foundName });
  }
  if (!finalLeads.length) return { ok: true, added: 0, skipped, policy: dupPolicy };

  // Build the assignment plan on the de-duplicated list (keeps distribution even).
  const _plan = _buildAssignPlan(finalLeads.length, agents, distribution, weights);
  let added = 0;
  for (let i = 0; i < finalLeads.length; i++) {
    const l = finalLeads[i];
    const agent = _plan[i] != null ? _plan[i] : (agents.length ? agents[i % agents.length] : null);
    await db.query(
      `INSERT INTO dialer_campaign_leads (campaign_id, lead_id, name, phone, assigned_to) VALUES ($1,$2,$3,$4,$5)`,
      [cid, l.leadId, l.name || l.foundName || null, l.phone, agent]);
    added++;
  }
  return { ok: true, added, skipped, policy: dupPolicy };
}

/* DIALER_RECHURN_v1 — outcome/status breakdown for the re-churn picker.
 * Returns completed dispositions (not currently queued/in_progress) grouped. */
async function api_dialer_campaign_outcomes(token, campaignId) {
  await authUser(token);
  await ensureSchema();
  const cid = Number(campaignId);
  const { rows } = await db.query(
    `SELECT COALESCE(NULLIF(outcome,''), status) AS key,
            COUNT(*)::int AS count
       FROM dialer_campaign_leads
      WHERE campaign_id=$1 AND status NOT IN ('queued','in_progress')
      GROUP BY COALESCE(NULLIF(outcome,''), status)
      ORDER BY count DESC`, [cid]);
  return rows;
}

/* DIALER_RECHURN_v1 — recycle leads with the chosen outcome(s)/status back into
 * the queue, reassigned to a DIFFERENT caller, so unpicked leads get re-dialled.
 * payload: { campaign_id, outcomes:[...], assign_to:[...], distribution, weights,
 *            exclude_current_owner, max_churn } */
async function api_dialer_rechurn(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await ensureSchema();
  const p = payload || {};
  const cid = Number(p.campaign_id);
  if (!cid) throw new Error('campaign_id required');
  const keys = (Array.isArray(p.outcomes) ? p.outcomes : []).map(String).filter(Boolean);
  if (!keys.length) throw new Error('Pick at least one status/outcome to re-churn');
  const distribution = ['round_robin', 'equal', 'percent'].includes(p.distribution) ? p.distribution : 'round_robin';
  const weights = (p.weights && typeof p.weights === 'object') ? p.weights : null;
  const excludeOwner = p.exclude_current_owner !== false; // default true
  const maxChurn = Number(p.max_churn) > 0 ? Number(p.max_churn) : null;

  // Agents to redistribute to (default: agents already in the campaign).
  let agents = (Array.isArray(p.assign_to) ? p.assign_to : []).map(Number).filter(Boolean);
  if (!agents.length) {
    const ag = await db.query(
      `SELECT DISTINCT assigned_to FROM dialer_campaign_leads WHERE campaign_id=$1 AND assigned_to IS NOT NULL`, [cid]);
    agents = ag.rows.map(r => Number(r.assigned_to)).filter(Boolean);
  }
  if (!agents.length) throw new Error('No agents to assign to — select agents');

  // Pull the matching leads (match on outcome OR status, the same key the picker shows).
  let q = `SELECT id, assigned_to FROM dialer_campaign_leads
            WHERE campaign_id=$1 AND status NOT IN ('queued','in_progress')
              AND COALESCE(NULLIF(outcome,''), status) = ANY($2)`;
  const args = [cid, keys];
  if (maxChurn) { q += ` AND churn_count < $3`; args.push(maxChurn); }
  q += ` ORDER BY id ASC`;
  const { rows } = await db.query(q, args);
  if (!rows.length) return { ok: true, rechurned: 0 };

  const plan = _buildAssignPlan(rows.length, agents, distribution, weights);
  let rechurned = 0;
  for (let i = 0; i < rows.length; i++) {
    const lead = rows[i];
    let agent = plan[i] != null ? plan[i] : agents[i % agents.length];
    // Push to a DIFFERENT caller where possible.
    if (excludeOwner && agents.length > 1 && Number(agent) === Number(lead.assigned_to)) {
      const idx = agents.indexOf(agent);
      agent = agents[(idx + 1) % agents.length];
    }
    await db.query(
      `UPDATE dialer_campaign_leads
          SET status='queued', outcome=NULL, assigned_to=$1,
              churn_count=churn_count+1, last_attempt_at=NULL
        WHERE id=$2`, [agent, lead.id]);
    rechurned++;
  }
  return { ok: true, rechurned };
}

async function api_dialer_campaign_detail(token, id) {
  const me = await authUser(token);
  await ensureSchema();
  const cid = Number(id);
  const c = await db.query(`SELECT * FROM dialer_campaigns WHERE id=$1`, [cid]);
  if (!c.rows.length) throw new Error('Campaign not found');
  const byAgent = await db.query(
    `SELECT l.assigned_to AS user_id, u.name AS agent,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE l.status='done')::int AS done,
       COUNT(*) FILTER (WHERE l.status='queued')::int AS queued,
       COUNT(*) FILTER (WHERE l.status='callback')::int AS callback
     FROM dialer_campaign_leads l LEFT JOIN users u ON u.id=l.assigned_to
     WHERE l.campaign_id=$1 GROUP BY l.assigned_to, u.name ORDER BY u.name`, [cid]);
  return { campaign: c.rows[0], agents: byAgent.rows };
}

// ---------- agent ----------
/* Campaigns that have queued leads assigned to me. */
async function api_dialer_myCampaigns(token) {
  const me = await authUser(token);
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.status, c.pacing_sec, c.require_remark,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE l.status='done')::int AS done,
       COUNT(*) FILTER (WHERE l.status IN ('queued','in_progress'))::int AS remaining
     FROM dialer_campaign_leads l JOIN dialer_campaigns c ON c.id=l.campaign_id
     WHERE l.assigned_to=$1
     GROUP BY c.id, c.name, c.status, c.pacing_sec, c.require_remark
     HAVING COUNT(*) FILTER (WHERE l.status IN ('queued','in_progress')) > 0 OR COUNT(*)>0
     ORDER BY c.id DESC`, [me.id]);
  return rows;
}

/* Serve the next dial for this agent in a campaign (oldest queued / callback-due). */
async function api_dialer_nextLead(token, campaignId) {
  const me = await authUser(token);
  await ensureSchema();
  const cid = Number(campaignId);
  const c = await db.query(`SELECT status FROM dialer_campaigns WHERE id=$1`, [cid]);
  if (!c.rows.length) throw new Error('Campaign not found');
  if (c.rows[0].status === 'paused') return { paused: true };
  const r = await db.query(
    `SELECT * FROM dialer_campaign_leads
      WHERE campaign_id=$1 AND assigned_to=$2 AND status IN ('queued','in_progress')
      ORDER BY (status='in_progress') DESC, id ASC LIMIT 1`, [cid, me.id]);
  if (!r.rows.length) return { done_all: true };
  const lead = r.rows[0];
  await db.query(`UPDATE dialer_campaign_leads SET status='in_progress', attempt_count=attempt_count+1, last_attempt_at=NOW() WHERE id=$1`, [lead.id]);
  // progress
  const p = await db.query(
    `SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='done')::int done
       FROM dialer_campaign_leads WHERE campaign_id=$1 AND assigned_to=$2`, [cid, me.id]);
  return { lead, progress: p.rows[0] };
}

/* Save the disposition + remark, then the client asks for the next lead.
 * payload: { clead_id, outcome, remark } */
async function api_dialer_disposition(token, payload) {
  const me = await authUser(token);
  await ensureSchema();
  const p = payload || {};
  const id = Number(p.clead_id);
  if (!id) throw new Error('clead_id required');
  const r = await db.query(`SELECT * FROM dialer_campaign_leads WHERE id=$1`, [id]);
  if (!r.rows.length) throw new Error('Dial record not found');
  const cl = r.rows[0];
  const outcome = String(p.outcome || 'connected').slice(0, 40);
  const remark = String(p.remark || '').slice(0, 2000);
  const newStatus = outcome === 'callback' ? 'callback' : (outcome === 'dnc' ? 'dnc' : 'done');
  await db.query(`UPDATE dialer_campaign_leads SET status=$1, outcome=$2, remark=$3 WHERE id=$4`,
    [newStatus, outcome, remark, id]);
  // mirror the remark onto the real lead if linked
  if (cl.lead_id && remark) {
    try {
      await db.query(`INSERT INTO remarks (lead_id, user_id, remark, created_at) VALUES ($1,$2,$3,NOW())`,
        [cl.lead_id, me.id, '☎ Dialer (' + outcome + '): ' + remark]);
    } catch (_) {}
    try {
      await db.query(`UPDATE leads SET notes = LEFT(COALESCE($2,'') || ' — ' || COALESCE(notes,''), 5000) WHERE id=$1`,
        [cl.lead_id, '☎ ' + outcome + ': ' + remark]);
    } catch (_) {}
  }
  return { ok: true };
}

async function api_dialer_pause(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await ensureSchema();
  const p = payload || {};
  await db.query(`UPDATE dialer_campaigns SET status=$1 WHERE id=$2`, [p.status === 'running' ? 'running' : 'paused', Number(p.campaign_id)]);
  return { ok: true };
}

module.exports = {
  api_dialer_campaigns_list,
  api_dialer_campaign_save,
  api_dialer_campaign_delete,
  api_dialer_addLeads,
  api_dialer_campaign_detail,
  api_dialer_campaign_outcomes,
  api_dialer_rechurn,
  api_dialer_myCampaigns,
  api_dialer_nextLead,
  api_dialer_disposition,
  api_dialer_pause
};
