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
       (SELECT COUNT(*) FROM dialer_campaign_leads l WHERE l.campaign_id=c.id AND l.status='queued')::int AS queued
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
  const leads = (Array.isArray(p.leads) ? p.leads : [])
    .map(l => ({ name: String(l.name || '').slice(0, 160), phone: _norm(l.phone) }))
    .filter(l => l.phone.length >= 7);
  if (!leads.length) throw new Error('No valid leads (need at least a phone number)');
  // try to link to an existing lead by phone (last 10)
  let added = 0;
  for (let i = 0; i < leads.length; i++) {
    const l = leads[i];
    const agent = agents.length ? agents[i % agents.length] : null;
    let leadId = null, foundName = null;
    try {
      const m = await db.query(
        `SELECT id, name FROM leads WHERE right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10) = right($1,10) LIMIT 1`,
        [l.phone]);
      if (m.rows.length) { leadId = m.rows[0].id; foundName = m.rows[0].name; }
    } catch (_) {}
    await db.query(
      `INSERT INTO dialer_campaign_leads (campaign_id, lead_id, name, phone, assigned_to) VALUES ($1,$2,$3,$4,$5)`,
      [cid, leadId, l.name || foundName || null, l.phone, agent]);
    added++;
  }
  return { ok: true, added };
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
  api_dialer_myCampaigns,
  api_dialer_nextLead,
  api_dialer_disposition,
  api_dialer_pause
};
