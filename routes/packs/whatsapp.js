/**
 * routes/packs/whatsapp.js
 *
 * Industry Pack: WhatsApp Suite (WA-first businesses).
 * Two features in v1, both layered ON TOP of the existing WhatsApp
 * infrastructure (whatsapp_messages, wa_chat_assignments, wa_campaigns,
 * wa_campaign_targets) — nothing in core WA is modified:
 *
 *   1. Shared Team Inbox + live agent handoff
 *      - one queue of WA conversations, claim / assign / transfer / resolve
 *      - Manager Monitor: per-agent open counts + a live handoff log
 *   2. Engagement-based Smart Retargeting
 *      - segment past campaign recipients by delivered / read / replied /
 *        undelivered / failed, preview the audience, export, or fire a
 *        fresh WA campaign at just that segment (reuses api_wb_campaigns_create)
 *
 *   Pack-owned tables (namespaced wapack_*):
 *     wapack_inbox      — per-conversation status + assignee (pack-owned)
 *     wapack_inbox_log  — claim/assign/transfer/resolve handoff history
 *
 *   All APIs are gated with framework.requireActive('whatsapp') so they
 *   only work for tenants that have this pack installed.
 */
'use strict';

const db        = require('../../db/pg');
const framework = require('./_framework');
const { authUser, getVisibleUserIds } = require('../../utils/auth');

const PACK_ID = 'whatsapp';

// ── Installer ─────────────────────────────────────────────────────
async function _installer({ db: D }) {
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_inbox (
      phone        TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'open',   -- open | pending | resolved
      assigned_to  INT,
      priority     TEXT,                           -- low | normal | high
      snooze_until TIMESTAMPTZ,
      resolved_at  TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS wapack_inbox_assigned_idx ON wapack_inbox(assigned_to)`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS wapack_inbox_status_idx   ON wapack_inbox(status)`, []);

  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_inbox_log (
      id         SERIAL PRIMARY KEY,
      phone      TEXT NOT NULL,
      action     TEXT NOT NULL,                    -- claim|assign|transfer|resolve|reopen|note
      from_user  INT,
      to_user    INT,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `, []);
  await D.query(`CREATE INDEX IF NOT EXISTS wapack_inbox_log_idx ON wapack_inbox_log(phone, created_at DESC)`, []);
}

async function _ensure() {
  try { await _installer({ db }); }
  catch (e) { console.warn('[wapack] _ensure:', e.message); }
}

async function _gate(token) {
  await framework.requireActive(PACK_ID);
  await _ensure();
  return authUser(token);
}

function _digits(s) { return String(s || '').replace(/\D/g, ''); }

// Upsert the pack-owned inbox row + append a handoff-log entry.
async function _touchInbox(phone, fields, logEntry) {
  const cols = Object.keys(fields);
  if (cols.length) {
    const setList = cols.map((c, i) => `${c}=$${i + 2}`).join(', ');
    const insCols = ['phone'].concat(cols).join(', ');
    const insVals = ['$1'].concat(cols.map((_, i) => `$${i + 2}`)).join(', ');
    await db.query(
      `INSERT INTO wapack_inbox (${insCols}, updated_at) VALUES (${insVals}, now())
       ON CONFLICT (phone) DO UPDATE SET ${setList}, updated_at=now()`,
      [phone].concat(cols.map(c => fields[c])));
  } else {
    await db.query(
      `INSERT INTO wapack_inbox (phone, updated_at) VALUES ($1, now())
       ON CONFLICT (phone) DO UPDATE SET updated_at=now()`, [phone]);
  }
  if (logEntry) {
    await db.query(
      `INSERT INTO wapack_inbox_log (phone, action, from_user, to_user, note)
       VALUES ($1,$2,$3,$4,$5)`,
      [phone, logEntry.action, logEntry.from_user || null, logEntry.to_user || null, logEntry.note || null]);
  }
}

// ══════════════════════════════════════════════════════════════════
//  FEATURE 1 — Shared Team Inbox + live agent handoff
// ══════════════════════════════════════════════════════════════════

async function api_wapack_agents(token) {
  await _gate(token);
  const r = await db.query(
    `SELECT id, name, role FROM users WHERE is_active=1 ORDER BY name ASC`, []);
  return { agents: r.rows || [] };
}

async function api_wapack_inbox_list(token, args) {
  const me = await _gate(token);
  args = args || {};
  const scope = ['mine', 'unassigned', 'all', 'resolved'].includes(args.scope) ? args.scope : 'all';
  const q = _digits(args.q);

  // Latest message per customer phone (customer phone = the OTHER party).
  const rows = (await db.query(`
    WITH threads AS (
      SELECT
        CASE WHEN direction='in' THEN from_number ELSE to_number END AS phone,
        body, direction, created_at, lead_id,
        ROW_NUMBER() OVER (
          PARTITION BY (CASE WHEN direction='in' THEN from_number ELSE to_number END)
          ORDER BY created_at DESC) AS rn
      FROM whatsapp_messages
      WHERE created_at > now() - interval '90 days'
        AND COALESCE(CASE WHEN direction='in' THEN from_number ELSE to_number END,'') <> ''
    )
    SELECT t.phone, t.body AS last_body, t.direction AS last_dir,
           t.created_at AS last_at, t.lead_id,
           l.name AS lead_name,
           ib.status, ib.assigned_to, u.name AS assigned_name,
           (SELECT COUNT(*)::int FROM whatsapp_messages m2
              WHERE m2.direction='in' AND m2.from_number = t.phone
                AND m2.created_at > COALESCE(ib.updated_at, to_timestamp(0))) AS unread
      FROM threads t
      LEFT JOIN leads l          ON l.id = t.lead_id
      LEFT JOIN wapack_inbox ib  ON ib.phone = t.phone
      LEFT JOIN users u          ON u.id = ib.assigned_to
     WHERE t.rn = 1
     ORDER BY t.created_at DESC
     LIMIT 400
  `, [])).rows;

  const visible = new Set((await getVisibleUserIds(me)).map(Number));
  let list = rows.map(r => ({
    phone: r.phone,
    name: r.lead_name || r.phone,
    lead_id: r.lead_id,
    last_body: r.last_body,
    last_dir: r.last_dir,
    last_at: r.last_at,
    status: r.status || 'open',
    assigned_to: r.assigned_to,
    assigned_name: r.assigned_name || null,
    unread: Number(r.unread || 0)
  }));

  if (q) list = list.filter(t => _digits(t.phone).indexOf(q) >= 0 || String(t.name).toLowerCase().indexOf(String(args.q).toLowerCase()) >= 0);
  if (scope === 'mine')       list = list.filter(t => Number(t.assigned_to) === Number(me.id) && t.status !== 'resolved');
  else if (scope === 'unassigned') list = list.filter(t => !t.assigned_to && t.status !== 'resolved');
  else if (scope === 'resolved')   list = list.filter(t => t.status === 'resolved');
  else /* all */              list = list.filter(t => t.status !== 'resolved');

  // Manager/admin see everyone; reps only see their own + unassigned in "all".
  const isManager = ['admin', 'manager', 'team_leader'].includes(String(me.role || ''));
  if (!isManager && scope === 'all') {
    list = list.filter(t => !t.assigned_to || visible.has(Number(t.assigned_to)));
  }

  const counts = {
    mine: list.filter(t => Number(t.assigned_to) === Number(me.id)).length,
    unassigned: list.filter(t => !t.assigned_to).length,
    total: list.length
  };
  return { threads: list, counts, me: { id: me.id, role: me.role } };
}

async function api_wapack_inbox_thread(token, args) {
  await _gate(token);
  const phone = String((args && args.phone) || '');
  if (!phone) throw new Error('phone required');
  const msgs = (await db.query(`
    SELECT id, direction, body, status, created_at
      FROM whatsapp_messages
     WHERE (direction='in'  AND from_number=$1)
        OR (direction='out' AND to_number=$1)
     ORDER BY created_at ASC
     LIMIT 300
  `, [phone])).rows;
  const ib = (await db.query(`SELECT * FROM wapack_inbox WHERE phone=$1`, [phone])).rows[0] || null;
  let assignedName = null;
  if (ib && ib.assigned_to) {
    assignedName = ((await db.query(`SELECT name FROM users WHERE id=$1`, [ib.assigned_to])).rows[0] || {}).name || null;
  }
  // Opening the thread clears its unread badge for everyone (watermark).
  await _touchInbox(phone, {}, null);
  return { messages: msgs, inbox: ib, assigned_name: assignedName };
}

async function api_wapack_inbox_claim(token, args) {
  const me = await _gate(token);
  const phone = String((args && args.phone) || '');
  if (!phone) throw new Error('phone required');
  await _touchInbox(phone, { assigned_to: me.id, status: 'open', resolved_at: null },
    { action: 'claim', to_user: me.id });
  return { ok: true };
}

async function api_wapack_inbox_assign(token, args) {
  const me = await _gate(token);
  const phone = String((args && args.phone) || '');
  const uid = Number((args && args.user_id) || 0);
  if (!phone || !uid) throw new Error('phone and user_id required');
  await _touchInbox(phone, { assigned_to: uid, status: 'open', resolved_at: null },
    { action: 'assign', from_user: me.id, to_user: uid });
  return { ok: true };
}

async function api_wapack_inbox_transfer(token, args) {
  const me = await _gate(token);
  const phone = String((args && args.phone) || '');
  const uid = Number((args && args.user_id) || 0);
  if (!phone || !uid) throw new Error('phone and user_id required');
  const prev = (await db.query(`SELECT assigned_to FROM wapack_inbox WHERE phone=$1`, [phone])).rows[0];
  await _touchInbox(phone, { assigned_to: uid, status: 'open', resolved_at: null },
    { action: 'transfer', from_user: (prev && prev.assigned_to) || me.id, to_user: uid, note: (args && args.note) || null });
  return { ok: true };
}

async function api_wapack_inbox_resolve(token, args) {
  const me = await _gate(token);
  const phone = String((args && args.phone) || '');
  if (!phone) throw new Error('phone required');
  await _touchInbox(phone, { status: 'resolved', resolved_at: db.nowIso() },
    { action: 'resolve', from_user: me.id, note: (args && args.note) || null });
  return { ok: true };
}

async function api_wapack_inbox_reopen(token, args) {
  const me = await _gate(token);
  const phone = String((args && args.phone) || '');
  if (!phone) throw new Error('phone required');
  await _touchInbox(phone, { status: 'open', resolved_at: null },
    { action: 'reopen', from_user: me.id });
  return { ok: true };
}

async function api_wapack_inbox_monitor(token) {
  await _gate(token);
  const perAgent = (await db.query(`
    SELECT u.id, u.name,
           COUNT(*) FILTER (WHERE ib.status='open')::int     AS open,
           COUNT(*) FILTER (WHERE ib.status='pending')::int  AS pending,
           COUNT(*) FILTER (WHERE ib.status='resolved')::int AS resolved
      FROM wapack_inbox ib
      JOIN users u ON u.id = ib.assigned_to
     GROUP BY u.id, u.name
     ORDER BY open DESC, u.name ASC
  `, [])).rows;
  const unassigned = ((await db.query(
    `SELECT COUNT(*)::int AS n FROM wapack_inbox WHERE assigned_to IS NULL AND status<>'resolved'`, [])).rows[0] || {}).n || 0;
  const handoffs = (await db.query(`
    SELECT lg.id, lg.phone, lg.action, lg.note, lg.created_at,
           fu.name AS from_name, tu.name AS to_name
      FROM wapack_inbox_log lg
      LEFT JOIN users fu ON fu.id = lg.from_user
      LEFT JOIN users tu ON tu.id = lg.to_user
     ORDER BY lg.created_at DESC
     LIMIT 60
  `, [])).rows;
  return { per_agent: perAgent, unassigned, handoffs };
}

// ══════════════════════════════════════════════════════════════════
//  FEATURE 2 — Engagement-based Smart Retargeting
// ══════════════════════════════════════════════════════════════════

// Build the WHERE clause + params for a segment over wa_campaign_targets (aliased t).
function _segmentSql(segment, campaignId, params) {
  let where = '1=1';
  if (campaignId) { params.push(Number(campaignId)); where += ` AND t.campaign_id = $${params.length}`; }
  switch (segment) {
    case 'read':
      where += ` AND (t.status='read' OR t.read_at IS NOT NULL)`; break;
    case 'delivered_not_read':
      where += ` AND (t.status='delivered' OR t.delivered_at IS NOT NULL) AND t.read_at IS NULL AND t.status<>'read'`; break;
    case 'undelivered':
      where += ` AND (t.status='sent' OR t.sent_at IS NOT NULL) AND t.delivered_at IS NULL AND t.status NOT IN ('delivered','read')`; break;
    case 'failed':
      where += ` AND t.status='failed'`; break;
    case 'no_reply':
      // read the message but never sent an inbound reply afterwards
      where += ` AND (t.status='read' OR t.read_at IS NOT NULL)
                 AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m
                                  WHERE m.direction='in' AND m.from_number = t.phone
                                    AND m.created_at >= COALESCE(t.sent_at, t.created_at))`; break;
    case 'replied':
      where += ` AND EXISTS (SELECT 1 FROM whatsapp_messages m
                              WHERE m.direction='in' AND m.from_number = t.phone
                                AND m.created_at >= COALESCE(t.sent_at, t.created_at))`; break;
    default: break;
  }
  return where;
}

const RETARGET_SEGMENTS = [
  ['read',               '👁 Read (opened)'],
  ['no_reply',           '🤐 Read, no reply'],
  ['replied',            '💬 Replied'],
  ['delivered_not_read', '📩 Delivered, not read'],
  ['undelivered',        '🚫 Not delivered'],
  ['failed',             '❌ Failed']
];

async function api_wapack_retarget_segments(token, args) {
  await _gate(token);
  args = args || {};
  const campaignId = Number(args.campaign_id || 0) || null;
  const out = [];
  for (const [key, label] of RETARGET_SEGMENTS) {
    const params = [];
    const where = _segmentSql(key, campaignId, params);
    let n = 0;
    try {
      n = Number(((await db.query(
        `SELECT COUNT(DISTINCT t.phone)::int AS n FROM wa_campaign_targets t WHERE ${where}`, params)).rows[0] || {}).n || 0);
    } catch (_) { n = 0; }
    out.push({ key, label, count: n });
  }
  const campaigns = (await db.query(
    `SELECT id, name, recipients_total, recipients_read FROM wa_campaigns ORDER BY id DESC LIMIT 50`, [])).rows;
  return { segments: out, campaigns };
}

async function api_wapack_retarget_audience(token, args) {
  await _gate(token);
  args = args || {};
  const segment = String(args.segment || '');
  const campaignId = Number(args.campaign_id || 0) || null;
  const limit = Math.min(2000, Math.max(1, Number(args.limit || 500)));
  const params = [];
  const where = _segmentSql(segment, campaignId, params);
  params.push(limit);
  const rows = (await db.query(`
    SELECT DISTINCT ON (t.phone)
           t.phone, t.name, t.lead_id, t.status, t.sent_at, t.read_at,
           c.name AS campaign_name
      FROM wa_campaign_targets t
      LEFT JOIN wa_campaigns c ON c.id = t.campaign_id
     WHERE ${where}
     ORDER BY t.phone, t.created_at DESC
     LIMIT $${params.length}
  `, params)).rows;
  return { audience: rows, count: rows.length };
}

// Fire a fresh WA campaign at a segment — reuses the core campaign engine.
async function api_wapack_retarget_createCampaign(token, args) {
  await _gate(token);
  args = args || {};
  const segment = String(args.segment || '');
  const campaignId = Number(args.campaign_id || 0) || null;
  const template = String(args.template_name || '');
  if (!template) throw new Error('template_name required');

  const params = [];
  const where = _segmentSql(segment, campaignId, params);
  const rows = (await db.query(
    `SELECT DISTINCT t.lead_id FROM wa_campaign_targets t WHERE ${where} AND t.lead_id IS NOT NULL`, params)).rows;
  const ids = rows.map(r => r.lead_id).filter(Boolean);
  if (!ids.length) throw new Error('No matching leads with a linked contact to retarget');

  const wb = require('../whatsbot');
  const segLabel = (RETARGET_SEGMENTS.find(s => s[0] === segment) || [segment, segment])[1];
  const payload = {
    name: 'Retarget · ' + segLabel + ' · ' + new Date().toISOString().slice(0, 10),
    template_name: template,
    template_language: args.template_language || 'en_US',
    filter: { ids: ids },
    variables_json: args.variables_json || null,
    image_url: args.image_url || null,
    send_now: args.send_now ? 1 : 0
  };
  const res = await wb.api_wb_campaigns_create(token, payload);
  return { ok: true, campaign: res, targeted: ids.length };
}

// ══════════════════════════════════════════════════════════════════
//  SHOWCASE SEED — populates a demo tenant (showcase-whatsapp) with
//  realistic conversations, agents, campaigns and handoffs so every
//  pack feature has data to show. Idempotent (skips if already seeded).
// ══════════════════════════════════════════════════════════════════
const _DEMO_CUSTOMERS = [
  ['Rahul Kapoor',   'price + ready to buy'],
  ['Sneha Patel',    'wants a callback'],
  ['Vikram Joshi',   'asked for comparison'],
  ['Meera Reddy',    'wants a demo'],
  ['Aditya Bose',    'brochure sent'],
  ['Pooja Nair',     'negotiating'],
  ['Karan Malhotra', 'asked about integrations'],
  ['Divya Menon',    'gone quiet after quote'],
  ['Arjun Shah',     'read, no reply'],
  ['Nisha Verma',    'delivered, unread'],
  ['Rohit Sinha',    'number invalid'],
  ['Tanvi Desai',    'happy customer'],
  ['Sameer Khan',    'follow-up next week'],
  ['Ananya Iyer',    'wants pricing sheet']
];
const _DEMO_SCRIPTS = [
  { in: 'Hi, I saw your ad. What is the pricing for 10 users?' },
  { out: 'Hi 👋 For 10 users the Pro plan at ₹9,999/mo fits well — includes AI bot, WhatsApp Cloud API and call recording. Want a quick demo?' },
  { in: 'Yes please share brochure also' },
  { out: 'Sharing the brochure + pricing sheet now. Would 4pm tomorrow work for the demo call?' },
  { in: 'Perfect. Schedule it.' },
  { out: 'Booked for 4pm tomorrow. You will get the meeting link 30 mins before. Looking forward! 🙌' }
];

async function api_wapack_seedDemo(token) {
  const me = await _gate(token);
  if (!['admin', 'manager'].includes(String(me.role || ''))) throw new Error('Admin only');

  // Idempotent by WIPE-AND-RESEED — clean any prior demo data first so a
  // re-run (or a half-finished earlier run) always ends in a clean state.
  const oldLeads = (await db.query(`SELECT id, phone FROM leads WHERE source='WA Demo'`, [])).rows;
  if (oldLeads.length) {
    const ids = oldLeads.map(l => l.id);
    const phones = oldLeads.map(l => l.phone);
    await db.query(`DELETE FROM whatsapp_messages   WHERE lead_id = ANY($1::int[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM wa_campaign_targets WHERE lead_id = ANY($1::int[])`, [ids]).catch(() => {});
    await db.query(`DELETE FROM wapack_inbox        WHERE phone   = ANY($1::text[])`, [phones]).catch(() => {});
    await db.query(`DELETE FROM wapack_inbox_log    WHERE phone   = ANY($1::text[])`, [phones]).catch(() => {});
    await db.query(`DELETE FROM leads               WHERE id      = ANY($1::int[])`, [ids]).catch(() => {});
  }
  await db.query(`DELETE FROM wa_campaigns WHERE name='Diwali Offer Blast'`, []).catch(() => {});

  // 1. Agents (demo users who never log in — placeholder hash).
  const AGENTS = [['Priya Sharma', 'team_leader'], ['Amit Rao', 'sales'], ['Neha Gupta', 'sales'], ['Ravi Kumar', 'sales']];
  const agentIds = [];
  for (const [nm, role] of AGENTS) {
    const em = 'agent.' + nm.toLowerCase().replace(/[^a-z]+/g, '.') + '@wa.demo';
    let id = ((await db.query(`SELECT id FROM users WHERE email=$1`, [em])).rows[0] || {}).id;
    if (!id) {
      id = (await db.query(
        `INSERT INTO users (name, email, role, password_hash, is_active) VALUES ($1,$2,$3,'$demo$disabled$',1) RETURNING id`,
        [nm, em, role])).rows[0].id;
    }
    agentIds.push(id);
  }
  const meId = me.id;

  // 2. Customers + conversations + campaign targets.
  const campaign = (await db.query(
    `INSERT INTO wa_campaigns (name, relation_type, template_name, status, recipients_total, created_by, created_at)
     VALUES ('Diwali Offer Blast','leads','festive_offer','completed',$1,$2, now() - interval '4 days') RETURNING id`,
    [_DEMO_CUSTOMERS.length, meId])).rows[0].id;

  const now = Date.now();
  for (let i = 0; i < _DEMO_CUSTOMERS.length; i++) {
    const [name, tag] = _DEMO_CUSTOMERS[i];
    const phone = '9' + String(100000000 + i * 7654321 + (now % 1000)).slice(-9);
    const leadId = (await db.query(
      `INSERT INTO leads (name, phone, whatsapp, source, created_at)
       VALUES ($1,$2,$2,'WA Demo', now() - ($3||' days')::interval) RETURNING id`,
      [name, phone, String((i % 5) + 1)])).rows[0].id;

    // How much of the script each customer got (varies last-message direction + unread).
    // Cap at the script length so we never index past the end.
    const depth = Math.min(_DEMO_SCRIPTS.length, 2 + (i % (_DEMO_SCRIPTS.length - 1)));
    const baseMin = 60 * (i + 1);   // stagger threads
    for (let s = 0; s < depth; s++) {
      const step = _DEMO_SCRIPTS[s];
      const dir = ('in' in step) ? 'in' : 'out';
      const body = step.in || step.out;
      await db.query(
        `INSERT INTO whatsapp_messages (lead_id, direction, from_number, to_number, body, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() - ($7||' minutes')::interval)`,
        [leadId, dir,
         dir === 'in' ? phone : null,
         dir === 'out' ? phone : null,
         body, dir === 'out' ? 'read' : 'received',
         String(baseMin - s * 7)]);
    }

    // Campaign target status spread → drives retargeting segments.
    //   i%5: 0 read+replied, 1 read-no-reply, 2 delivered-not-read, 3 undelivered, 4 failed
    const bucket = i % 5;
    let status = 'sent', sentAt = "now() - interval '4 days'", delAt = null, readAt = null;
    if (bucket === 0 || bucket === 1) { status = 'read'; delAt = sentAt; readAt = "now() - interval '3 days'"; }
    else if (bucket === 2)            { status = 'delivered'; delAt = sentAt; }
    else if (bucket === 3)            { status = 'sent'; }
    else                              { status = 'failed'; }
    await db.query(
      `INSERT INTO wa_campaign_targets (campaign_id, lead_id, phone, name, status, sent_at, delivered_at, read_at, created_at)
       VALUES ($1,$2,$3,$4,$5, ${sentAt}, ${delAt || 'NULL'}, ${readAt || 'NULL'}, now() - interval '4 days')`,
      [campaign, leadId, phone, name, status]);
  }

  // 3. Inbox assignments + handoff log so Manager Monitor + Team Inbox scopes populate.
  const demoLeads = (await db.query(`SELECT id, phone FROM leads WHERE source='WA Demo' ORDER BY id ASC`, [])).rows;
  for (let i = 0; i < demoLeads.length; i++) {
    const ph = demoLeads[i].phone;
    if (i < 3) {  // resolved
      await _touchInbox(ph, { assigned_to: agentIds[i % agentIds.length], status: 'resolved', resolved_at: db.nowIso() },
        { action: 'resolve', from_user: agentIds[i % agentIds.length] });
    } else if (i < 7) {  // assigned & open
      await _touchInbox(ph, { assigned_to: agentIds[i % agentIds.length], status: 'open' },
        { action: 'assign', from_user: meId, to_user: agentIds[i % agentIds.length] });
    } else if (i === 7) {  // a transfer, for the handoff log
      await _touchInbox(ph, { assigned_to: agentIds[1], status: 'open' },
        { action: 'transfer', from_user: agentIds[0], to_user: agentIds[1], note: 'Better fit for enterprise' });
    }
    // rest stay unassigned
  }

  return {
    ok: true,
    seeded: { customers: _DEMO_CUSTOMERS.length, agents: agentIds.length, campaign, inbox_rows: demoLeads.length }
  };
}

// ── Register the pack ─────────────────────────────────────────────
framework.register({
  id:          PACK_ID,
  name:        'WhatsApp Suite',
  icon:        '💬',
  industry:    'WhatsApp-first',
  summary:     'Shared WhatsApp team inbox with live agent handoff + engagement-based smart retargeting.',
  description: 'Turns SmartCRM into a WhatsApp-first workspace: one shared inbox the whole team works, claim/assign/transfer/resolve with manager monitoring, plus retargeting audiences built from who read, replied to, or ignored your campaigns.',
  namespace:   'wapack_',
  version:     '1.0.0',
  installer:   _installer,
  navItems: [
    { id: 'wapackinbox',    label: 'Team Inbox',        icon: '📥', view: 'wapackinbox' },
    { id: 'wapackretarget', label: 'Smart Retargeting', icon: '🎯', view: 'wapackretarget' }
  ]
});

module.exports = {
  api_wapack_agents,
  api_wapack_inbox_list,
  api_wapack_inbox_thread,
  api_wapack_inbox_claim,
  api_wapack_inbox_assign,
  api_wapack_inbox_transfer,
  api_wapack_inbox_resolve,
  api_wapack_inbox_reopen,
  api_wapack_inbox_monitor,
  api_wapack_retarget_segments,
  api_wapack_retarget_audience,
  api_wapack_retarget_createCampaign,
  api_wapack_seedDemo,
  _installer,
  RETARGET_SEGMENTS
};
