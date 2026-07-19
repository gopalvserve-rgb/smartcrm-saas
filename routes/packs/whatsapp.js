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

  // ── WhatsApp Forms (in-chat lead capture) ───────────────────────
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_forms (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      fields_json TEXT,          -- [{key,label,type,required,options[]}]
      status      TEXT NOT NULL DEFAULT 'draft',  -- draft|published
      submissions INT NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_form_responses (
      id           SERIAL PRIMARY KEY,
      form_id      INT NOT NULL,
      lead_id      INT,
      phone        TEXT,
      contact_name TEXT,
      answers_json TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
  await D.query(`CREATE INDEX IF NOT EXISTS wapack_form_resp_idx ON wapack_form_responses(form_id)`, []);

  // WA_PACK_BOT_FORM_v1 (2026-07-19) — link a form to a published Meta
  // WhatsApp Flow so it can be sent as a NATIVE in-chat form, plus the
  // message copy shown with the CTA. flow_id is optional: without it the
  // form is sent as a graceful text-prompt fallback (works with no Flow).
  for (const [col, ddl] of [
    ['flow_id',     `ALTER TABLE wapack_forms ADD COLUMN IF NOT EXISTS flow_id TEXT`],
    ['cta_text',    `ALTER TABLE wapack_forms ADD COLUMN IF NOT EXISTS cta_text TEXT`],
    ['header_text', `ALTER TABLE wapack_forms ADD COLUMN IF NOT EXISTS header_text TEXT`],
    ['body_text',   `ALTER TABLE wapack_forms ADD COLUMN IF NOT EXISTS body_text TEXT`],
    ['footer_text', `ALTER TABLE wapack_forms ADD COLUMN IF NOT EXISTS footer_text TEXT`],
    ['flow_screen', `ALTER TABLE wapack_forms ADD COLUMN IF NOT EXISTS flow_screen TEXT`]
  ]) { try { await D.query(ddl, []); } catch (_) { /* col exists */ } }

  // Bot → form trigger: when an inbound message matches `keyword`, the AI
  // bot sends `form_id` instead of a text reply. One row per tenant is
  // enough for v1 (single active trigger); the table allows more later.
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_bot_form_triggers (
      id           SERIAL PRIMARY KEY,
      keyword      TEXT,
      form_id      INT  NOT NULL,
      enabled      INT  NOT NULL DEFAULT 1,
      trigger_type TEXT NOT NULL DEFAULT 'keyword',  -- keyword | after_first_reply
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
  // Existing installs: add trigger_type + relax keyword NOT NULL (after_first_reply has none).
  try { await D.query(`ALTER TABLE wapack_bot_form_triggers ADD COLUMN IF NOT EXISTS trigger_type TEXT NOT NULL DEFAULT 'keyword'`, []); } catch (_) {}
  try { await D.query(`ALTER TABLE wapack_bot_form_triggers ALTER COLUMN keyword DROP NOT NULL`, []); } catch (_) {}

  // ── In-chat WebViews (web pages opened inside the chat) ─────────
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_webviews (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      url         TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);

  // ── E-commerce: store connections + product catalog ─────────────
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_shop_connections (
      provider     TEXT PRIMARY KEY,   -- shopify | woocommerce | meta_catalog
      status       TEXT NOT NULL DEFAULT 'disconnected',  -- connected|disconnected
      store_url    TEXT,
      connected_at TIMESTAMPTZ
    )`, []);
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_products (
      id         SERIAL PRIMARY KEY,
      source     TEXT,                 -- shopify | woocommerce | meta_catalog | manual | url | scan
      name       TEXT NOT NULL,
      sku        TEXT,
      price_inr  NUMERIC(12,2),
      image_url  TEXT,
      in_stock   INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
  // STOREFRONT_v1 — extra product columns for the self-serve store.
  for (const ddl of [
    `ALTER TABLE wapack_products ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE wapack_products ADD COLUMN IF NOT EXISTS stock_qty INT`,
    `ALTER TABLE wapack_products ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`,
    `ALTER TABLE wapack_products ADD COLUMN IF NOT EXISTS active INT NOT NULL DEFAULT 1`
  ]) { try { await D.query(ddl, []); } catch (_) {} }

  // STOREFRONT_v1 — single store profile per tenant (id=1 singleton).
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_store (
      id           INT PRIMARY KEY DEFAULT 1,
      store_name   TEXT,
      tagline      TEXT,
      logo_emoji   TEXT DEFAULT '🛍️',
      about        TEXT,
      pay_cod      INT NOT NULL DEFAULT 1,
      pay_upi      INT NOT NULL DEFAULT 0,
      upi_id       TEXT,
      notify_phone TEXT,
      active       INT NOT NULL DEFAULT 1,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);

  // STOREFRONT_v1 — customer orders placed from the public store page.
  await D.query(`
    CREATE TABLE IF NOT EXISTS wapack_orders (
      id            SERIAL PRIMARY KEY,
      order_ref     TEXT,
      customer_name TEXT,
      phone         TEXT,
      address       TEXT,
      items_json    TEXT,
      total_inr     NUMERIC(12,2),
      payment_mode  TEXT,
      status        TEXT NOT NULL DEFAULT 'placed',  -- placed|packed|shipped|delivered|cancelled
      lead_id       INT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`, []);
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
//  FEATURE 3 — WhatsApp Forms (in-chat lead capture)
// ══════════════════════════════════════════════════════════════════
async function api_wapack_forms_list(token) {
  await _gate(token);
  const r = await db.query(`SELECT * FROM wapack_forms ORDER BY id DESC`, []);
  return { forms: (r.rows || []).map(f => ({ ...f, fields: _json(f.fields_json, []) })) };
}
function _json(s, d) { try { return s ? JSON.parse(s) : d; } catch (_) { return d; } }

async function api_wapack_form_save(token, args) {
  await _gate(token);
  args = args || {};
  const id = Number(args.id || 0);
  const fields = Array.isArray(args.fields) ? args.fields : _json(args.fields_json, []);
  const data = {
    name: (args.name || '').trim() || 'Untitled form',
    description: args.description || null,
    fields_json: JSON.stringify(fields),
    status: args.status === 'published' ? 'published' : 'draft',
    // WA_PACK_BOT_FORM_v1 — native-Flow linkage + message copy (all optional)
    flow_id:     (args.flow_id || '').toString().trim() || null,
    cta_text:    (args.cta_text || '').toString().trim() || null,
    header_text: (args.header_text || '').toString().trim() || null,
    body_text:   (args.body_text || '').toString().trim() || null,
    footer_text: (args.footer_text || '').toString().trim() || null,
    flow_screen: (args.flow_screen || '').toString().trim() || null
  };
  if (id > 0) {
    await db.query(
      `UPDATE wapack_forms SET name=$1, description=$2, fields_json=$3, status=$4,
              flow_id=$5, cta_text=$6, header_text=$7, body_text=$8, footer_text=$9, flow_screen=$10
        WHERE id=$11`,
      [data.name, data.description, data.fields_json, data.status,
       data.flow_id, data.cta_text, data.header_text, data.body_text, data.footer_text, data.flow_screen, id]);
    return { ok: true, id };
  }
  const r = await db.query(
    `INSERT INTO wapack_forms (name, description, fields_json, status, flow_id, cta_text, header_text, body_text, footer_text, flow_screen)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [data.name, data.description, data.fields_json, data.status,
     data.flow_id, data.cta_text, data.header_text, data.body_text, data.footer_text, data.flow_screen]);
  return { ok: true, id: r.rows[0].id };
}
async function api_wapack_form_delete(token, args) {
  await _gate(token);
  const id = Number((args && args.id) || 0);
  if (!id) throw new Error('id required');
  await db.query(`DELETE FROM wapack_form_responses WHERE form_id=$1`, [id]);
  await db.query(`DELETE FROM wapack_forms WHERE id=$1`, [id]);
  return { ok: true };
}
async function api_wapack_form_responses(token, args) {
  await _gate(token);
  const fid = Number((args && args.form_id) || 0);
  if (!fid) return { responses: [] };
  const r = await db.query(
    `SELECT * FROM wapack_form_responses WHERE form_id=$1 ORDER BY id DESC LIMIT 200`, [fid]);
  return { responses: (r.rows || []).map(x => ({ ...x, answers: _json(x.answers_json, {}) })) };
}

// ══════════════════════════════════════════════════════════════════
//  WA_PACK_BOT_FORM_v1 — send a form into a WhatsApp chat (native Flow
//  when linked, graceful text-prompt fallback otherwise) + let the AI
//  bot trigger it on a keyword.
// ══════════════════════════════════════════════════════════════════

// Core send. `cfg` is a resolved whatsbot cfg (token + phoneId). Returns
// { sent, mode, wa_message_id, error }. NEVER throws to the bot path.
async function _sendForm(form, phone, cfg, opts) {
  const wb = require('../whatsbot');
  opts = opts || {};
  const to = String(phone || '').replace(/[^\d]/g, '');
  if (!to) return { sent: false, error: 'no phone' };
  const fields = _json(form.fields_json, []);

  // NATIVE FLOW — only when the form is linked to a published Meta Flow.
  if (form.flow_id) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'flow',
        body: { text: String(form.body_text || form.description || ('Please fill: ' + form.name)).slice(0, 1024) },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: 'wapack_' + (form.id || 'f') + '_' + Date.now(),
            flow_id: String(form.flow_id),
            flow_cta: String(form.cta_text || 'Open form').slice(0, 30),
            flow_action: 'navigate',
            flow_action_payload: { screen: String(form.flow_screen || 'RECOMMEND'), data: {} }
          }
        }
      }
    };
    if (form.header_text) body.interactive.header = { type: 'text', text: String(form.header_text).slice(0, 60) };
    if (form.footer_text) body.interactive.footer = { text: String(form.footer_text).slice(0, 60) };
    try {
      const r = await wb._graphPost(`${cfg.phoneId}/messages`, body, cfg);
      const waId = r.body && r.body.messages && r.body.messages[0] && r.body.messages[0].id || null;
      const err = r.body && r.body.error && r.body.error.message || null;
      const dbBody = '[WA Form #' + form.id + ': ' + form.name + '] (native flow)';
      try {
        await db.query(
          `INSERT INTO whatsapp_messages (lead_id, user_id, direction, from_number, to_number, body, wa_message_id, status, message_type, phone_number_id)
           VALUES ($1,$2,'out',$3,$4,$5,$6,$7,'interactive_flow',$8)`,
          [opts.leadId || null, null, cfg.phoneId, to, dbBody, waId, err ? 'failed' : 'sent', cfg.phoneId || null]);
      } catch (_) {}
      return { sent: !err, mode: 'flow', wa_message_id: waId, error: err };
    } catch (e) {
      // Flow send failed (unpublished / bad screen) → fall through to text.
    }
  }

  // FALLBACK — no published Flow: send a text prompt listing the fields so
  // capture still works today. Answers come back as normal inbound messages.
  const lines = fields.map((f, i) => (i + 1) + '. ' + (f.label || f.key || ('Field ' + (i + 1))) + (f.required ? ' *' : ''));
  const intro = String(form.body_text || form.description || ('Please share the following so we can help you:')).trim();
  const text = intro + (lines.length ? ('\n\n' + lines.join('\n')) : '') +
    (form.flow_id ? '' : '\n\n(Reply here with your details.)');
  try {
    const r = await wb._sendText({ to, text, leadId: opts.leadId || null, userId: null }, cfg);
    return { sent: !r.error, mode: 'text', wa_message_id: r.wa_message_id, error: r.error || null };
  } catch (e) {
    return { sent: false, mode: 'text', error: e.message };
  }
}

// Manual/testing send from the UI. { form_id, phone, phone_number_id?, lead_id? }
async function api_wapack_form_send(token, args) {
  await _gate(token);
  args = args || {};
  const fid = Number(args.form_id || 0);
  const phone = String(args.phone || '').trim();
  if (!fid) throw new Error('form_id required');
  if (!phone) throw new Error('phone required');
  const fr = await db.query(`SELECT * FROM wapack_forms WHERE id=$1`, [fid]);
  if (!fr.rows.length) throw new Error('form not found');
  const wb = require('../whatsbot');
  const cfg = args.phone_number_id ? await wb._cfgForPhone(String(args.phone_number_id)) : await wb._cfg();
  const res = await _sendForm(fr.rows[0], phone, cfg, { leadId: args.lead_id || null });
  return res;
}

// Bot → form trigger config (single active row in v1).
async function api_wapack_bot_trigger_get(token) {
  await _gate(token);
  const r = await db.query(`SELECT * FROM wapack_bot_form_triggers ORDER BY id DESC LIMIT 1`, []);
  return { trigger: r.rows[0] || null };
}
async function api_wapack_bot_trigger_save(token, args) {
  await _gate(token);
  args = args || {};
  const type = (args.trigger_type === 'after_first_reply') ? 'after_first_reply' : 'keyword';
  const keyword = String(args.keyword || '').trim();
  const formId = Number(args.form_id || 0);
  const enabled = args.enabled === false || args.enabled === 0 ? 0 : 1;
  if (!formId) throw new Error('form_id required');
  if (type === 'keyword' && !keyword) throw new Error('keyword required');
  // Single-row model: replace any existing trigger.
  await db.query(`DELETE FROM wapack_bot_form_triggers`, []);
  const r = await db.query(
    `INSERT INTO wapack_bot_form_triggers (keyword, form_id, enabled, trigger_type) VALUES ($1,$2,$3,$4) RETURNING id`,
    [type === 'keyword' ? keyword.toLowerCase() : null, formId, enabled, type]);
  return { ok: true, id: r.rows[0].id };
}

// Called from aiBot.maybeReplyToInbound (thin, pack-gated hook). Returns
// { sent:true, form_name } if it sent a form (bot should stop), else falsy.
// Strict no-op for any tenant without the WhatsApp pack active.
async function _botMaybeSendForm({ phone, leadId, inboundText, inboundPhoneId }) {
  try {
    if (!(await framework.isPackActive(PACK_ID))) return false;
    await _ensure();
    const tr = await db.query(`SELECT * FROM wapack_bot_form_triggers WHERE enabled=1 ORDER BY id DESC LIMIT 1`, []);
    if (!tr.rows.length) return false;
    const trig = tr.rows[0];
    const type = trig.trigger_type || 'keyword';
    if (type === 'after_first_reply') {
      // Send the form ONCE per contact, only after the bot has already replied
      // at least once to this thread. So: 1st inbound → bot welcomes/replies
      // (no form yet); next inbound → form goes out; never again after that.
      // ai_chat_log is the bot's own send ledger (phone stored digits-only).
      const already = await db.query(
        `SELECT 1 FROM ai_chat_log WHERE phone=$1 AND status='sent' AND mode_used='wa_form' LIMIT 1`, [phone]);
      if (already.rows.length) return false;                 // already sent to this contact
      const replied = await db.query(
        `SELECT 1 FROM ai_chat_log WHERE phone=$1 AND status='sent' AND (mode_used IS NULL OR mode_used <> 'wa_form') LIMIT 1`, [phone]);
      if (!replied.rows.length) return false;                // wait until the bot has replied once
    } else {
      const kw = String(trig.keyword || '').toLowerCase().trim();
      const t = String(inboundText || '').toLowerCase();
      if (!kw || !t.includes(kw)) return false;
    }
    const fr = await db.query(`SELECT * FROM wapack_forms WHERE id=$1`, [trig.form_id]);
    if (!fr.rows.length) return false;
    const wb = require('../whatsbot');
    const cfg = inboundPhoneId ? await wb._cfgForPhone(String(inboundPhoneId)) : await wb._cfg();
    const res = await _sendForm(fr.rows[0], phone, cfg, { leadId: leadId || null });
    return res.sent ? { sent: true, form_name: fr.rows[0].name, mode: res.mode } : false;
  } catch (_) {
    return false;   // never break the bot flow
  }
}

function _prettyKey(k) {
  return String(k || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }).trim();
}

// WA_PACK_BOT_FORM_v1 — called from whatsbot._handleInbound when a WhatsApp
// Flow (in-chat form) is submitted. Parses the answers, stores a form
// response, and writes the answers into the lead's remark timeline (same
// `remarks` + notes pattern the FB lead-form ingest uses). Pack-gated →
// strict no-op for tenants without the WhatsApp Suite pack. Never throws.
async function _captureFormResponse({ phone, leadId, nfmReply, contactName }) {
  try {
    if (!(await framework.isPackActive(PACK_ID))) return null;
    await _ensure();
    // Parse the response payload (Meta sends response_json as a JSON string).
    let answers = {};
    try {
      const raw = nfmReply && nfmReply.response_json;
      answers = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    } catch (_) { answers = {}; }
    // Drop Meta's internal keys (flow_token, screen names, etc.).
    const clean = {};
    Object.keys(answers || {}).forEach(function (k) {
      if (k === 'flow_token' || /^flow_/i.test(k)) return;
      const v = answers[k];
      if (v == null || v === '') return;
      clean[k] = (typeof v === 'object') ? JSON.stringify(v) : v;
    });
    const pairs = Object.keys(clean).map(function (k) { return _prettyKey(k) + ': ' + clean[k]; });

    // Best-effort: correlate to the form via the most recent native-flow send
    // to this phone (we tag those rows '[WA Form #<id>: ...]').
    let formId = null;
    try {
      const tail = String(phone || '').replace(/\D/g, '').slice(-10);
      const r = await db.query(
        `SELECT body FROM whatsapp_messages
          WHERE direction='out' AND message_type='interactive_flow'
            AND RIGHT(regexp_replace(to_number, '[^0-9]', '', 'g'), 10) = $1
          ORDER BY id DESC LIMIT 1`, [tail]);
      const mm = r.rows[0] && String(r.rows[0].body || '').match(/\[WA Form #(\d+):/);
      if (mm) formId = Number(mm[1]);
    } catch (_) {}

    // Store the structured response.
    try {
      await db.query(
        `INSERT INTO wapack_form_responses (form_id, lead_id, phone, contact_name, answers_json)
         VALUES ($1,$2,$3,$4,$5)`,
        [formId, leadId || null, phone || null, contactName || null, JSON.stringify(clean)]);
      if (formId) { try { await db.query(`UPDATE wapack_forms SET submissions = COALESCE(submissions,0)+1 WHERE id=$1`, [formId]); } catch (_) {} }
    } catch (_) {}

    // Write into the lead remark timeline (remarks row + notes) — same shape
    // as the FB lead-form ingest, so it renders in the standard timeline UI.
    if (leadId && pairs.length) {
      const remark = '📋 WhatsApp form answers:\n' + pairs.join('\n');
      try { await db.insert('remarks', { lead_id: leadId, user_id: null, remark: remark, created_at: db.nowIso() }); } catch (_) {}
      try { await db.query(
        `UPDATE leads SET notes = LEFT($2 || CASE WHEN COALESCE(notes,'')='' THEN '' ELSE E'\n\n' || notes END, 4096) WHERE id=$1`,
        [leadId, remark]); } catch (_) {}
      try { require('../tat').logAction(leadId, 'form_response', null, { answers: pairs.length, preview: pairs.slice(0, 3).join(' · ').slice(0, 200) }); } catch (_) {}
    }
    return { captured: true, answers: pairs.length, form_id: formId };
  } catch (_) {
    return null;   // never break the inbound flow
  }
}

// ── In-chat WebViews ──────────────────────────────────────────────
async function api_wapack_webviews_list(token) {
  await _gate(token);
  const r = await db.query(`SELECT * FROM wapack_webviews ORDER BY id DESC`, []);
  return { webviews: r.rows || [] };
}
async function api_wapack_webview_save(token, args) {
  await _gate(token);
  args = args || {};
  const id = Number(args.id || 0);
  if (!args.title || !args.url) throw new Error('title and url required');
  if (id > 0) {
    await db.query(`UPDATE wapack_webviews SET title=$1, url=$2, description=$3 WHERE id=$4`,
      [args.title, args.url, args.description || null, id]);
    return { ok: true, id };
  }
  const r = await db.query(`INSERT INTO wapack_webviews (title, url, description) VALUES ($1,$2,$3) RETURNING id`,
    [args.title, args.url, args.description || null]);
  return { ok: true, id: r.rows[0].id };
}
async function api_wapack_webview_delete(token, args) {
  await _gate(token);
  const id = Number((args && args.id) || 0);
  if (!id) throw new Error('id required');
  await db.query(`DELETE FROM wapack_webviews WHERE id=$1`, [id]);
  return { ok: true };
}
// Send a WhatsApp interactive CTA-URL message — a proper tappable "Open"
// button bubble in the chat (opens the URL in the browser). Works today with
// no Meta Flows. Returns { wa_message_id, error }.
async function _sendCtaUrl({ to, headerText, bodyText, buttonText, url, leadId }, cfg) {
  const wb = require('../whatsbot');
  const c = cfg || await wb._cfg();
  const body = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/[^\d]/g, ''),
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: String(bodyText || ' ').slice(0, 1024) || ' ' },
      action: { name: 'cta_url', parameters: { display_text: String(buttonText || 'Open').slice(0, 20), url: String(url) } }
    }
  };
  if (headerText) body.interactive.header = { type: 'text', text: String(headerText).slice(0, 60) };
  const r = await wb._graphPost(`${c.phoneId}/messages`, body, c);
  const waId = (r.body && r.body.messages && r.body.messages[0] && r.body.messages[0].id) || null;
  const err = (r.body && r.body.error && r.body.error.message) || null;
  try {
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, direction, from_number, to_number, body, wa_message_id, status, message_type, phone_number_id)
       VALUES ($1,'out',$2,$3,$4,$5,$6,'interactive_cta',$7)`,
      [leadId || null, c.phoneId, body.to, (headerText ? headerText + ' — ' : '') + url, waId, err ? 'failed' : 'sent', c.phoneId || null]);
  } catch (_) {}
  return { wa_message_id: waId, error: err };
}

// WEBVIEW_SEND_v1 — send a saved web page into a WhatsApp chat as a tappable
// "Open" BUTTON (interactive cta_url). Falls back to a plain link if the
// button send is rejected. True in-chat page rendering still needs Meta Flows.
async function api_wapack_webview_send(token, args) {
  await _gate(token);
  args = args || {};
  const id = Number((args.id || args.webview_id) || 0);
  const phone = _digits(args.phone);
  if (!id) throw new Error('webview id required');
  if (!phone) throw new Error('phone required');
  const w = (await db.query(`SELECT * FROM wapack_webviews WHERE id=$1`, [id])).rows[0];
  if (!w) throw new Error('WebView not found');
  const wb = require('../whatsbot');
  const cfg = await wb._cfg();
  const lead = (await db.query(
    `SELECT id FROM leads WHERE regexp_replace(COALESCE(phone,''),'\\D','','g')=$1
       OR regexp_replace(COALESCE(whatsapp,''),'\\D','','g')=$1 LIMIT 1`, [phone.slice(-10)])).rows[0];
  const leadId = lead ? lead.id : null;
  // Preferred: tappable Open button.
  let res;
  try { res = await _sendCtaUrl({ to: phone, headerText: w.title, bodyText: w.description || w.title, buttonText: 'Open', url: w.url, leadId: leadId }, cfg); }
  catch (e) { res = { error: e.message }; }
  if (res && !res.error) return { ok: true, sent_to: phone, mode: 'button' };
  // Fallback: plain tappable link.
  const text = '🌐 *' + w.title + '*' + (w.description ? ('\n' + w.description) : '') + '\n' + w.url;
  const t = await wb._sendText({ to: phone, text: text, leadId: leadId, userId: null }, cfg);
  if (t && t.error) throw new Error(t.error);
  return { ok: true, sent_to: phone, mode: 'link' };
}

// ══════════════════════════════════════════════════════════════════
//  FEATURE 4 — Storefront (Shopify / WooCommerce / FB catalog)
// ══════════════════════════════════════════════════════════════════
const SHOP_PROVIDERS = [
  ['shopify',      'Shopify',      '🛍️', 'Sync products & orders from your Shopify store'],
  ['woocommerce',  'WooCommerce',  '🪵', 'Sync products from your WooCommerce site'],
  ['meta_catalog', 'Facebook Catalog', '📘', 'Link your Meta catalog to show products in WhatsApp']
];

async function api_wapack_shop_connections(token) {
  await _gate(token);
  const rows = (await db.query(`SELECT * FROM wapack_shop_connections`, [])).rows || [];
  const byProv = {}; rows.forEach(r => { byProv[r.provider] = r; });
  const providers = SHOP_PROVIDERS.map(([id, name, icon, blurb]) => ({
    provider: id, name, icon, blurb,
    status: (byProv[id] && byProv[id].status) || 'disconnected',
    store_url: byProv[id] && byProv[id].store_url || null
  }));
  const productCount = Number(((await db.query(`SELECT COUNT(*)::int AS n FROM wapack_products`, [])).rows[0] || {}).n || 0);
  return { providers, product_count: productCount };
}

// NOTE: a real connection performs OAuth against the store and needs the
// merchant's API keys. This endpoint records a connection so the CRM side
// is demonstrable; wiring the live sync happens once keys are supplied.
async function api_wapack_shop_connect(token, args) {
  await _gate(token);
  args = args || {};
  const provider = String(args.provider || '');
  if (!SHOP_PROVIDERS.some(p => p[0] === provider)) throw new Error('Unknown provider');
  const status = args.disconnect ? 'disconnected' : 'connected';
  await db.query(
    `INSERT INTO wapack_shop_connections (provider, status, store_url, connected_at)
     VALUES ($1,$2,$3, CASE WHEN $2='connected' THEN now() ELSE NULL END)
     ON CONFLICT (provider) DO UPDATE SET status=$2, store_url=COALESCE($3, wapack_shop_connections.store_url),
       connected_at = CASE WHEN $2='connected' THEN now() ELSE NULL END`,
    [provider, status, args.store_url || null]);
  return { ok: true, provider, status };
}

async function api_wapack_products_list(token, args) {
  await _gate(token);
  args = args || {};
  const params = [];
  let where = '1=1';
  if (args.source) { params.push(String(args.source)); where += ` AND source=$${params.length}`; }
  const r = await db.query(`SELECT * FROM wapack_products WHERE ${where} ORDER BY id DESC LIMIT 200`, params);
  return { products: r.rows || [] };
}

// Send a product card into a WhatsApp chat (writes an outbound message row).
async function api_wapack_product_send(token, args) {
  const me = await _gate(token);
  args = args || {};
  const pid = Number(args.product_id || 0);
  const phone = String(args.phone || '');
  if (!pid || !phone) throw new Error('product_id and phone required');
  const p = (await db.query(`SELECT * FROM wapack_products WHERE id=$1`, [pid])).rows[0];
  if (!p) throw new Error('Product not found');
  const body = '🛍️ *' + p.name + '*\n' + (p.price_inr ? '₹' + Number(p.price_inr).toLocaleString('en-IN') + '\n' : '') +
    (p.in_stock ? 'In stock — reply to order.' : 'Currently out of stock.');
  const lead = (await db.query(`SELECT id FROM leads WHERE phone=$1 OR whatsapp=$1 LIMIT 1`, [phone])).rows[0];
  await db.query(
    `INSERT INTO whatsapp_messages (lead_id, direction, to_number, body, status, created_at)
     VALUES ($1,'out',$2,$3,'read', now())`,
    [lead ? lead.id : null, phone, body]);
  return { ok: true, sent_to: phone };
}

// ══════════════════════════════════════════════════════════════════
//  STOREFRONT_v1 — self-serve store: build store, add products (manual /
//  from URL / scan a menu photo), share one link, take customer orders.
// ══════════════════════════════════════════════════════════════════

async function _getStore() {
  const r = await db.query(`SELECT * FROM wapack_store WHERE id=1`, []);
  return r.rows[0] || null;
}
async function api_wapack_store_get(token) {
  await _gate(token);
  const store = await _getStore();
  const pc = Number(((await db.query(`SELECT COUNT(*)::int AS n FROM wapack_products WHERE COALESCE(active,1)=1`, [])).rows[0] || {}).n || 0);
  return { store: store || null, product_count: pc };
}
async function api_wapack_store_save(token, args) {
  await _gate(token);
  args = args || {};
  await db.query(
    `INSERT INTO wapack_store (id, store_name, tagline, logo_emoji, about, pay_cod, pay_upi, upi_id, notify_phone, active, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (id) DO UPDATE SET store_name=$1, tagline=$2, logo_emoji=$3, about=$4,
        pay_cod=$5, pay_upi=$6, upi_id=$7, notify_phone=$8, active=$9, updated_at=now()`,
    [(args.store_name || '').trim() || 'My Store', args.tagline || null, (args.logo_emoji || '🛍️').slice(0, 4),
     args.about || null, args.pay_cod === false || args.pay_cod === 0 ? 0 : 1, args.pay_upi ? 1 : 0,
     args.upi_id || null, _digits(args.notify_phone) || null, args.active === false ? 0 : 1]);
  return { ok: true };
}

// Manual add / edit a product (all fields).
async function api_wapack_product_save(token, args) {
  await _gate(token);
  args = args || {};
  const id = Number(args.id || 0);
  const name = (args.name || '').trim();
  if (!name) throw new Error('name required');
  const price = args.price_inr != null && args.price_inr !== '' ? Number(args.price_inr) : null;
  const active = args.active === false || args.active === 0 ? 0 : 1;
  const inStock = args.in_stock === false || args.in_stock === 0 ? 0 : 1;
  if (id > 0) {
    await db.query(
      `UPDATE wapack_products SET name=$1, price_inr=$2, image_url=$3, description=$4, stock_qty=$5, in_stock=$6, active=$7 WHERE id=$8`,
      [name, price, args.image_url || null, args.description || null, args.stock_qty != null && args.stock_qty !== '' ? Number(args.stock_qty) : null, inStock, active, id]);
    return { ok: true, id };
  }
  const r = await db.query(
    `INSERT INTO wapack_products (source, name, price_inr, image_url, description, stock_qty, in_stock, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [args.source || 'manual', name, price, args.image_url || null, args.description || null,
     args.stock_qty != null && args.stock_qty !== '' ? Number(args.stock_qty) : null, inStock, active]);
  return { ok: true, id: r.rows[0].id };
}
async function api_wapack_product_delete(token, args) {
  await _gate(token);
  const id = Number((args && args.id) || 0);
  if (!id) throw new Error('id required');
  await db.query(`DELETE FROM wapack_products WHERE id=$1`, [id]);
  return { ok: true };
}
async function api_wapack_products_bulk_add(token, args) {
  await _gate(token);
  const list = (args && Array.isArray(args.products)) ? args.products : [];
  let n = 0;
  for (const p of list) {
    const name = String((p && p.name) || '').trim();
    if (!name) continue;
    const price = _num(p.price_inr);
    try {
      await db.query(
        `INSERT INTO wapack_products (source, name, price_inr, image_url, description, in_stock, active)
         VALUES ($1,$2,$3,$4,$5,1,1)`,
        [args.source || 'scan', name, price, p.image_url || null, p.description || null]);
      n++;
    } catch (_) {}
  }
  return { ok: true, added: n };
}

// Parse any price-ish value ("₹1,499", "1499.00", 1499) → number | null.
function _num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const d = String(v).replace(/[^\d.]/g, '');
  if (!d) return null;
  const n = Number(d);
  return isNaN(n) ? null : n;
}

// Shopify stores (very common for D2C brands like Ambrane, boAt) expose a
// public JSON feed. A /collections/<x> link → many products; a /products/<x>
// link → one. Returns { list:[...] } | { single:{...} } | null.
function _shopProd(p) {
  const v = (p.variants && p.variants[0]) || {};
  const img = (p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src) || (p.featured_image) || null;
  return {
    name: String(p.title || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    price_inr: _num(v.price != null ? v.price : p.price),
    image_url: img || null,
    description: p.body_html ? String(p.body_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : null,
    source: 'url'
  };
}
async function _tryShopify(url) {
  try {
    const u = new URL(url);
    let jsonUrl, single = false;
    const pm = u.pathname.match(/\/products\/([^\/?#]+)/);
    const cm = u.pathname.match(/\/collections\/([^\/?#]+)/);
    if (pm) { jsonUrl = u.origin + '/products/' + pm[1] + '.json'; single = true; }
    else if (cm) { jsonUrl = u.origin + '/collections/' + cm[1] + '/products.json?limit=100'; }
    else { jsonUrl = u.origin + '/products.json?limit=100'; }
    const r = await fetch(jsonUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (single && j.product) return { single: _shopProd(j.product) };
    if (Array.isArray(j.products) && j.products.length) return { list: j.products.map(_shopProd).filter(function (x) { return x.name; }) };
    return null;
  } catch (_) { return null; }
}

// Extract product(s) from a URL. Strategy: Shopify JSON feed (collection →
// MANY, product → one) → OG/Twitter meta → JSON-LD → inline price → Gemini
// fallback. Marketplaces that block bots (Flipkart/Amazon) return a clear
// "add manually / scan" message. Returns { drafts:[...] } for collections,
// else { draft:{...} }.
async function api_wapack_product_from_url(token, args) {
  await _gate(token);
  const url = String((args && args.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a valid product URL (starting http/https)');
  // Shopify fast-path (handles collection pages = many products at once).
  const shop = await _tryShopify(url);
  if (shop && shop.list && shop.list.length) return { drafts: shop.list };
  if (shop && shop.single && shop.single.name) return { draft: shop.single };
  let html = '';
  try {
    const r = await fetch(url, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml'
    } });
    html = await r.text();
  } catch (e) { throw new Error('Could not fetch that URL'); }

  const meta = (props) => {
    for (const prop of props) {
      const m = html.match(new RegExp('<meta[^>]+(?:property|name|itemprop)=["\']' + prop + '["\'][^>]*content=["\']([^"\']+)["\']', 'i'))
             || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name|itemprop)=["\']' + prop + '["\']', 'i'));
      if (m) return m[1];
    }
    return '';
  };
  let name = meta(['og:title', 'twitter:title']) || (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '';
  let image = meta(['og:image', 'twitter:image', 'twitter:image:src']) || '';
  let price = _num(meta(['og:price:amount', 'product:price:amount', 'price']));
  let desc = meta(['og:description', 'twitter:description', 'description']) || '';

  // JSON-LD Product blocks
  try {
    const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const b of blocks) {
      let data;
      try { data = JSON.parse(b.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim()); } catch (_) { continue; }
      const arr = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
      for (const node of arr) {
        if (!node) continue;
        const t = node['@type'];
        const isProd = t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0);
        if (!isProd) continue;
        if (!name && node.name) name = node.name;
        if (!image && node.image) image = Array.isArray(node.image) ? node.image[0] : (typeof node.image === 'object' ? node.image.url : node.image);
        if (price == null && node.offers) { const off = Array.isArray(node.offers) ? node.offers[0] : node.offers; if (off) price = _num(off.price || off.lowPrice || (off.priceSpecification && off.priceSpecification.price)); }
        if (!desc && node.description) desc = node.description;
      }
    }
  } catch (_) {}

  if (price == null) { const m = html.match(/itemprop=["\']price["\'][^>]*content=["\']?([\d,.]+)/i); if (m) price = _num(m[1]); }
  if (price == null) { const m = html.match(/"(?:price|sellingPrice|final_price|sale_price|amount)"\s*:\s*"?([\d,]+(?:\.\d+)?)"?/i); if (m) price = _num(m[1]); }
  if (price == null) { const m = html.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i); if (m) price = _num(m[1]); }

  // Gemini fallback — feed just the <head> + JSON-LD (small, targeted).
  if ((!name || price == null) && html && html.length > 200) {
    try {
      const gem = require('../../utils/geminiClient');
      const head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0].slice(0, 6000);
      const ld = (html.match(/<script[^>]+application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []).join('\n').slice(0, 6000);
      const blob = (head + '\n' + ld).slice(0, 11000);
      const res = await gem.generate({ prompt: 'From this HTML head/metadata of a shopping page, extract the single product. Return ONLY JSON {"name":"","price_inr":<number or null>,"image_url":""} — price as digits only. HTML:\n' + blob, maxOutputTokens: 300, temperature: 0, call_kind: 'store_url' });
      if (res && res.ok) { let t = String(res.text || '').trim(); const jm = t.match(/\{[\s\S]*\}/); if (jm) t = jm[0]; const g = JSON.parse(t); if (!name && g.name) name = g.name; if (price == null && g.price_inr != null) price = _num(g.price_inr); if (!image && g.image_url) image = g.image_url; }
    } catch (_) {}
  }

  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  if (!name && price == null && !image) {
    throw new Error('Could not read this page. Big sites like Flipkart/Amazon block automated reading, and store/collection links hold many products. Try a single product page — or add it manually / by scanning a photo.');
  }
  return { draft: { name, price_inr: price, image_url: image || null, description: desc ? String(desc).replace(/\s+/g, ' ').slice(0, 300) : null, source: 'url' } };
}

// Scan a menu / product photo → draft product list via Gemini vision.
async function api_wapack_product_scan(token, args) {
  await _gate(token);
  args = args || {};
  let data = String(args.image_base64 || '');
  const mime = args.mime_type || 'image/jpeg';
  const m = data.match(/^data:([^;]+);base64,(.*)$/);
  if (m) { data = m[2]; }
  if (!data) throw new Error('image required');
  let gem;
  try {
    gem = require('../../utils/geminiClient');
  } catch (_) { throw new Error('AI not available'); }
  const prompt = 'You are reading a photo of a menu or product list. Extract EVERY distinct item with its price. ' +
    'Look carefully for prices printed next to each item (they may be at the end of the line, in a separate column, or after a ₹/Rs symbol). ' +
    'Return ONLY a compact JSON array, no prose, exactly like: [{"name":"Paneer Tikka","price_inr":220},{"name":"Cold Coffee","price_inr":120}]. ' +
    'price_inr MUST be a plain number (digits only, no ₹ sign, no commas). If a price is genuinely not visible use null. Keep names short and clean.';
  const res = await gem.generate({ prompt, images: [{ mime_type: mime, data: data }], maxOutputTokens: 1500, temperature: 0.1, call_kind: 'store_scan' });
  if (!res || !res.ok) throw new Error((res && res.error) || 'Scan failed');
  let txt = String(res.text || '').trim();
  const jm = txt.match(/\[[\s\S]*\]/);
  if (jm) txt = jm[0];
  let items = [];
  try { items = JSON.parse(txt); } catch (_) { throw new Error('Could not read items from the image — try a clearer, straight-on photo'); }
  const drafts = (Array.isArray(items) ? items : []).map(function (it) {
    const raw = (it.price_inr != null && it.price_inr !== '') ? it.price_inr : (it.price != null ? it.price : (it.amount != null ? it.amount : null));
    return { name: String(it.name || '').trim().slice(0, 120), price_inr: _num(raw) };
  }).filter(function (d) { return d.name; });
  return { drafts: drafts };
}

async function api_wapack_orders_list(token, args) {
  await _gate(token);
  const st = args && args.status ? String(args.status) : null;
  const params = []; let where = '1=1';
  if (st) { params.push(st); where += ` AND status=$${params.length}`; }
  const r = await db.query(`SELECT * FROM wapack_orders WHERE ${where} ORDER BY id DESC LIMIT 200`, params);
  return { orders: (r.rows || []).map(o => ({ ...o, items: _json(o.items_json, []) })) };
}
async function api_wapack_order_setStatus(token, args) {
  await _gate(token);
  const id = Number((args && args.id) || 0);
  const status = String((args && args.status) || '');
  if (!id || !['placed', 'packed', 'shipped', 'delivered', 'cancelled'].includes(status)) throw new Error('id + valid status required');
  await db.query(`UPDATE wapack_orders SET status=$1 WHERE id=$2`, [status, id]);
  return { ok: true };
}

/* ---- Public store page + order placement (no auth; tenant-scoped) ---- */
function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function _inr(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }

async function expressRenderStore(req, res) {
  try {
    if (!(await framework.isPackActive(PACK_ID))) return res.status(404).send('Store not found');
    await _ensure();
    const store = await _getStore();
    if (!store || Number(store.active) !== 1) return res.status(404).send('This store is not open right now.');
    const prods = (await db.query(`SELECT * FROM wapack_products WHERE COALESCE(active,1)=1 ORDER BY COALESCE(sort_order,0), id DESC LIMIT 300`, [])).rows || [];
    const slug = (req.tenantSlug || (req.tenant && req.tenant.slug) || '');
    const html = _storeHtml(store, prods, slug);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) { res.status(500).send('Store error'); }
}

async function expressPlaceOrder(req, res) {
  try {
    if (!(await framework.isPackActive(PACK_ID))) return res.status(404).json({ error: 'not found' });
    await _ensure();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const phone = _digits(b.phone);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!name || !phone || !items.length) return res.status(400).json({ error: 'Name, phone and at least one item are required' });
    // Recompute total from our own product prices (never trust the client).
    let total = 0; const clean = [];
    for (const it of items) {
      const p = (await db.query(`SELECT id, name, price_inr FROM wapack_products WHERE id=$1`, [Number(it.id) || 0])).rows[0];
      if (!p) continue;
      const qty = Math.max(1, Math.min(999, Number(it.qty) || 1));
      total += Number(p.price_inr || 0) * qty;
      clean.push({ id: p.id, name: p.name, qty: qty, price: Number(p.price_inr || 0) });
    }
    if (!clean.length) return res.status(400).json({ error: 'No valid items' });
    const ref = 'ORD-' + Date.now().toString().slice(-6);
    const payMode = b.payment === 'upi' ? 'UPI' : 'COD';
    const address = String(b.address || '').slice(0, 500);

    // Find or create a lead for this customer.
    let leadId = null;
    try {
      const last10 = phone.slice(-10);
      const ld = await db.query(
        `SELECT id FROM leads WHERE regexp_replace(COALESCE(phone,''),'\\D','','g') = $1
           OR regexp_replace(COALESCE(whatsapp,''),'\\D','','g') = $1
           OR regexp_replace(COALESCE(phone,''),'\\D','','g') = $2 LIMIT 1`, [phone, last10]);
      if (ld.rows.length) leadId = ld.rows[0].id;
      else {
        leadId = await db.insert('leads', { name: name, phone: phone, whatsapp: phone, source: 'Storefront', created_at: db.nowIso(), updated_at: db.nowIso() });
        try { require('../tat').logAction(leadId, 'created', null, { source: 'storefront' }); } catch (_) {}
      }
    } catch (_) {}

    await db.query(
      `INSERT INTO wapack_orders (order_ref, customer_name, phone, address, items_json, total_inr, payment_mode, status, lead_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'placed',$8)`,
      [ref, name, phone, address, JSON.stringify(clean), total, payMode, leadId || null]);

    // Drop the order into the lead remark timeline.
    if (leadId) {
      const lines = clean.map(c => '• ' + c.name + ' × ' + c.qty + ' — ' + _inr(c.price * c.qty)).join('\n');
      const remark = '🛒 Placed order ' + ref + ' — ' + _inr(total) + ' (' + payMode + ')\n' + lines + (address ? ('\n📍 ' + address) : '');
      try { await db.insert('remarks', { lead_id: leadId, user_id: null, remark: remark, created_at: db.nowIso() }); } catch (_) {}
      try { await db.query(`UPDATE leads SET notes = LEFT($2 || CASE WHEN COALESCE(notes,'')='' THEN '' ELSE E'\n\n' || notes END, 4096) WHERE id=$1`, [leadId, remark]); } catch (_) {}
      try { require('../tat').logAction(leadId, 'order_placed', null, { ref: ref, total: total, items: clean.length }); } catch (_) {}
    }

    // Notify the shopkeeper on WhatsApp (best-effort; needs WABA configured).
    try {
      const store = await _getStore();
      const notify = store && store.notify_phone;
      if (notify) {
        const wb = require('../whatsbot');
        const msg = '🛒 New order ' + ref + '\n' + name + ' · ' + phone + '\n' + _inr(total) + ' · ' + payMode + '\n' +
          clean.map(c => '• ' + c.name + ' ×' + c.qty).join('\n') + (address ? ('\n📍 ' + address) : '');
        await wb._sendText({ to: notify, text: msg, leadId: null, userId: null }, await wb._cfg());
      }
    } catch (_) {}

    res.json({ ok: true, order_ref: ref, total: total });
  } catch (e) { res.status(500).json({ error: 'Could not place order' }); }
}

function _storeHtml(store, prods, slug) {
  const items = prods.map(function (p) {
    return { id: p.id, name: p.name, price: Number(p.price_inr || 0), img: p.image_url || '', desc: p.description || '', stock: Number(p.in_stock) };
  });
  const pay = { cod: Number(store.pay_cod) === 1, upi: Number(store.pay_upi) === 1, upi_id: store.upi_id || '' };
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<title>' + _esc(store.store_name || 'Store') + '</title>' +
    '<style>:root{--wa:#25d366;--wd:#075e54}*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f7f9fb;color:#0f172a;padding-bottom:78px}' +
    '.hero{background:linear-gradient(135deg,#128c7e,#075e54);color:#fff;padding:22px 16px;text-align:center}.logo{font-size:40px}.hero h1{font-size:20px;margin:6px 0 2px}.hero p{font-size:12.5px;opacity:.9}' +
    '.wrap{max-width:640px;margin:0 auto;padding:12px}.lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin:8px 4px}' +
    '.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{background:#fff;border:1px solid #e6ebf1;border-radius:14px;overflow:hidden;display:flex;flex-direction:column}' +
    '.pi{height:120px;background:linear-gradient(135deg,#e0f2fe,#dcfce7);display:flex;align-items:center;justify-content:center;font-size:40px;overflow:hidden}.pi img{width:100%;height:100%;object-fit:cover}' +
    '.pb{padding:9px;flex:1;display:flex;flex-direction:column;gap:2px}.pn{font-size:13px;font-weight:700;line-height:1.25}.pp{color:var(--wd);font-weight:800;font-size:13.5px}.pd{font-size:11px;color:#64748b}' +
    '.add{margin-top:6px;background:var(--wa);color:#fff;border:none;border-radius:9px;padding:8px;font-weight:800;font-size:12.5px;cursor:pointer}.qtyrow{margin-top:6px;display:flex;align-items:center;justify-content:space-between}.qbtn{width:28px;height:28px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;font-size:16px;font-weight:800;cursor:pointer}' +
    '.bar{position:fixed;left:0;right:0;bottom:0;background:var(--wa);color:#fff;padding:13px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:800;cursor:pointer;box-shadow:0 -4px 16px rgba(0,0,0,.12)}.bar.hide{display:none}' +
    '.sheet{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;align-items:flex-end;z-index:20}.sheet.on{display:flex}.panel{background:#fff;width:100%;max-width:640px;margin:0 auto;border-radius:18px 18px 0 0;max-height:92vh;overflow:auto;padding:16px}' +
    '.panel h2{font-size:16px;margin-bottom:10px}.oi{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px dashed #eef2f7}.inp{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:9px;font-size:14px;margin-top:8px}' +
    '.payopt{display:flex;gap:8px;margin:8px 0}.payopt label{flex:1;border:1px solid #cbd5e1;border-radius:9px;padding:9px;text-align:center;font-size:12.5px;cursor:pointer}.payopt input{display:none}.payopt label.on{border-color:var(--wa);background:#f0fdf4;color:var(--wd);font-weight:700}' +
    '.place{width:100%;background:var(--wa);color:#fff;border:none;border-radius:11px;padding:13px;font-weight:800;font-size:15px;cursor:pointer;margin-top:10px}.muted{color:#94a3b8;font-size:11px;text-align:center;margin-top:12px}.empty{text-align:center;color:#94a3b8;padding:30px}</style></head><body>' +
    '<div class="hero"><div class="logo">' + _esc(store.logo_emoji || '🛍️') + '</div><h1>' + _esc(store.store_name || 'Store') + '</h1>' +
    (store.tagline ? '<p>' + _esc(store.tagline) + '</p>' : '') + '</div>' +
    '<div class="wrap"><div class="lbl">Products</div><div id="grid" class="grid"></div>' +
    (items.length ? '' : '<div class="empty">No products yet. Please check back soon.</div>') + '</div>' +
    '<div class="bar hide" id="bar" onclick="openCart()"><span id="barc">🛒 0 items</span><span id="bart">' + _inr(0) + ' · Checkout →</span></div>' +
    '<div class="sheet" id="sheet"><div class="panel" id="panel"></div></div>' +
    '<script>' +
    'var P=' + JSON.stringify(items) + ';var PAY=' + JSON.stringify(pay) + ';var SLUG=' + JSON.stringify(slug) + ';var WA=' + JSON.stringify(_digits(store.notify_phone)) + ';var cart={};' +
    'function inr(n){return "\\u20B9"+Number(n||0).toLocaleString("en-IN");}' +
    'function count(){return Object.values(cart).reduce(function(a,b){return a+b;},0);}' +
    'function total(){return P.reduce(function(s,p){return s+(cart[p.id]||0)*p.price;},0);}' +
    'function grid(){var g=document.getElementById("grid");g.innerHTML=P.map(function(p){var q=cart[p.id]||0;return "<div class=card><div class=pi>"+(p.img?("<img src=\\""+p.img+"\\" onerror=\\"this.style.display=\\x27none\\x27\\">"):"\\uD83D\\uDCE6")+"</div><div class=pb><div class=pn>"+esc(p.name)+"</div><div class=pp>"+inr(p.price)+"</div>"+(p.desc?("<div class=pd>"+esc(p.desc)+"</div>"):"")+(q?("<div class=qtyrow><button class=qbtn onclick=\\"chg("+p.id+",-1)\\">\\u2212</button><b>"+q+"</b><button class=qbtn onclick=\\"chg("+p.id+",1)\\">+</button></div>"):("<button class=add onclick=\\"chg("+p.id+",1)\\">Add</button>"))+"</div></div>";}).join("");bar();}' +
    'function esc(s){return String(s).replace(/[&<>\\"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}' +
    'function chg(id,d){cart[id]=Math.max(0,(cart[id]||0)+d);if(!cart[id])delete cart[id];grid();}' +
    'function bar(){var b=document.getElementById("bar");if(count()){b.classList.remove("hide");document.getElementById("barc").textContent="\\uD83D\\uDED2 "+count()+" item(s)";document.getElementById("bart").textContent=inr(total())+" \\u00B7 Checkout \\u2192";}else{b.classList.add("hide");}}' +
    'function openCart(){var items=P.filter(function(p){return cart[p.id];});var pm=(PAY.cod?"cod":"upi");' +
    'var h="<h2>Your order</h2>"+items.map(function(p){return "<div class=oi><span>"+esc(p.name)+" \\u00D7 "+cart[p.id]+"</span><span>"+inr(p.price*cart[p.id])+"</span></div>";}).join("")+"<div class=oi style=\\"font-weight:800;border:none\\"><span>Total</span><span>"+inr(total())+"</span></div>";' +
    'h+="<input class=inp id=cn placeholder=\\"Your name\\"><input class=inp id=cp placeholder=\\"Phone number\\" inputmode=numeric><textarea class=inp id=ca placeholder=\\"Delivery address\\" style=height:60px></textarea>";' +
    'h+="<div class=payopt>"+(PAY.cod?"<label class=on id=lcod><input type=radio name=pay value=cod checked>Cash on Delivery</label>":"")+(PAY.upi?"<label id=lupi"+(PAY.cod?"":" class=on")+"><input type=radio name=pay value=upi"+(PAY.cod?"":" checked")+">UPI"+(PAY.upi_id?(" "+esc(PAY.upi_id)):"")+"</label>":"")+"</div>";' +
    'h+="<button class=place onclick=place()>"+(WA?"\\uD83D\\uDCF2 Order on WhatsApp":("Place order \\u00B7 "+inr(total())))+"</button><div class=muted>"+(WA?"Opens WhatsApp with your order ready to send.":"You\\u2019ll get a confirmation.")+"</div>";' +
    'document.getElementById("panel").innerHTML=h;document.getElementById("sheet").classList.add("on");' +
    'var opts=document.querySelectorAll(".payopt label");opts.forEach(function(l){l.onclick=function(){opts.forEach(function(x){x.classList.remove("on");});l.classList.add("on");l.querySelector("input").checked=true;};});}' +
    'function place(){var n=document.getElementById("cn").value.trim();var p=document.getElementById("cp").value.trim();var a=document.getElementById("ca").value.trim();' +
    'if(!n||!p){alert("Please enter your name and phone");return;}var pay=(document.querySelector("input[name=pay]:checked")||{}).value||"cod";' +
    'var items=P.filter(function(x){return cart[x.id];}).map(function(x){return{id:x.id,qty:cart[x.id]};});' +
    'fetch("/t/"+SLUG+"/store/order",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:n,phone:p,address:a,payment:pay,items:items})}).then(function(r){return r.json();}).then(function(j){' +
    'if(j&&j.ok){if(WA){' +
    'var lines=P.filter(function(x){return cart[x.id];}).map(function(x){return "\\u2022 "+x.name+" x"+cart[x.id]+" - "+inr(x.price*cart[x.id]);}).join("\\n");' +
    'var msg="Hi! I would like to order (Ref "+j.order_ref+"):\\n"+lines+"\\nTotal: "+inr(j.total)+"\\nPay: "+(pay=="upi"?"UPI":"COD")+"\\nName: "+n+"\\nPhone: "+p+(a?("\\nAddress: "+a):"");' +
    'var wa="https://wa.me/"+WA+"?text="+encodeURIComponent(msg);cart={};' +
    'document.getElementById("panel").innerHTML="<div style=\\"text-align:center;padding:32px 16px\\"><div style=font-size:54px>\\uD83D\\uDCF2</div><h2>Almost done!</h2><p style=\\"color:#64748b;margin:6px 0 14px\\">Tap to send your order on WhatsApp \\u2014 it\\u2019s saved too.</p><a href=\\""+wa+"\\" class=place style=\\"display:block;text-decoration:none;box-sizing:border-box\\">\\uD83D\\uDCF2 Send on WhatsApp</a></div>";' +
    'setTimeout(function(){location.href=wa;},500);' +
    '}else{document.getElementById("panel").innerHTML="<div style=text-align:center;padding:40px><div style=font-size:54px>\\u2705</div><h2>Order placed!</h2><p style=color:#64748b;margin-top:6px>Order "+j.order_ref+" \\u00B7 "+inr(j.total)+"</p><button class=place onclick=\\"location.reload()\\">Done</button></div>";cart={};}}' +
    'else{alert((j&&j.error)||"Could not place order");}}).catch(function(){alert("Network error, please try again");});}' +
    'grid();</script></body></html>';
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

  // 4. WhatsApp Forms + responses (wipe-and-reseed).
  await db.query(`DELETE FROM wapack_form_responses`, []).catch(() => {});
  await db.query(`DELETE FROM wapack_forms`, []).catch(() => {});
  const demoForm = (await db.query(
    `INSERT INTO wapack_forms (name, description, fields_json, status, submissions)
     VALUES ('Demo Booking Request','Captured right inside the WhatsApp chat',$1,'published',3) RETURNING id`,
    [JSON.stringify([
      { key: 'name', label: 'Full name', type: 'text', required: true },
      { key: 'company', label: 'Company', type: 'text', required: false },
      { key: 'team_size', label: 'Team size', type: 'select', required: true, options: ['1-10', '11-50', '51-200', '200+'] },
      { key: 'email', label: 'Work email', type: 'email', required: true }
    ])])).rows[0].id;
  await db.query(
    `INSERT INTO wapack_forms (name, description, fields_json, status)
     VALUES ('Support Ticket','Let customers raise an issue in-chat',$1,'draft')`,
    [JSON.stringify([
      { key: 'issue', label: 'What went wrong?', type: 'text', required: true },
      { key: 'priority', label: 'Priority', type: 'select', required: true, options: ['Low', 'Medium', 'High'] }
    ])]).catch(() => {});
  const respSamples = [
    ['Rahul Kapoor', { name: 'Rahul Kapoor', company: 'Kapoor Retail', team_size: '11-50', email: 'rahul@kapoor.co' }],
    ['Sneha Patel',  { name: 'Sneha Patel', company: 'Patel Foods', team_size: '1-10', email: 'sneha@patelfoods.in' }],
    ['Meera Reddy',  { name: 'Meera Reddy', company: 'Reddy Textiles', team_size: '51-200', email: 'meera@reddytex.com' }]
  ];
  for (const [nm, ans] of respSamples) {
    const l = (await db.query(`SELECT id, phone FROM leads WHERE name=$1 AND source='WA Demo' LIMIT 1`, [nm])).rows[0];
    await db.query(
      `INSERT INTO wapack_form_responses (form_id, lead_id, phone, contact_name, answers_json, created_at)
       VALUES ($1,$2,$3,$4,$5, now() - interval '2 days')`,
      [demoForm, l && l.id, l && l.phone, nm, JSON.stringify(ans)]).catch(() => {});
  }

  // 5. In-chat WebViews.
  await db.query(`DELETE FROM wapack_webviews`, []).catch(() => {});
  for (const [t, u, d] of [
    ['Pricing Plans', 'https://smartcrmsolution.com/pricing', 'Live pricing page — opens inside the chat'],
    ['Book a Demo',   'https://smartcrmsolution.com/demo',    'Calendar booking without leaving WhatsApp'],
    ['Product Tour',  'https://smartcrmsolution.com/tour',    'Interactive walkthrough']
  ]) {
    await db.query(`INSERT INTO wapack_webviews (title, url, description) VALUES ($1,$2,$3)`, [t, u, d]).catch(() => {});
  }

  // 6. Storefront — connections + demo product catalog.
  await db.query(`INSERT INTO wapack_shop_connections (provider,status,store_url,connected_at)
    VALUES ('shopify','connected','demo-store.myshopify.com',now())
    ON CONFLICT (provider) DO UPDATE SET status='connected', store_url='demo-store.myshopify.com', connected_at=now()`, []).catch(() => {});
  await db.query(`DELETE FROM wapack_products`, []).catch(() => {});
  const PRODUCTS = [
    ['shopify', 'Wireless Earbuds Pro', 'EAR-PRO', 2499, 1],
    ['shopify', 'Smart Watch Series 6', 'WATCH-6', 5999, 1],
    ['shopify', 'Bluetooth Speaker Mini', 'SPK-MINI', 1299, 1],
    ['woocommerce', 'Organic Green Tea 250g', 'TEA-250', 349, 1],
    ['woocommerce', 'Yoga Mat Premium', 'YOGA-PRM', 899, 0],
    ['meta_catalog', 'Cotton Kurta (Blue)', 'KRT-BLU', 1199, 1]
  ];
  for (const [src, nm, sku, price, stock] of PRODUCTS) {
    await db.query(
      `INSERT INTO wapack_products (source, name, sku, price_inr, in_stock) VALUES ($1,$2,$3,$4,$5)`,
      [src, nm, sku, price, stock]).catch(() => {});
  }

  return {
    ok: true,
    seeded: { customers: _DEMO_CUSTOMERS.length, agents: agentIds.length, campaign,
      inbox_rows: demoLeads.length, forms: 2, form_responses: respSamples.length,
      webviews: 3, products: PRODUCTS.length }
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
    { id: 'wapackforms',    label: 'Forms & WebViews',  icon: '📝', view: 'wapackforms' },
    { id: 'wapackshop',     label: 'Storefront',        icon: '🛒', view: 'wapackshop' },
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
  api_wapack_forms_list,
  api_wapack_form_save,
  api_wapack_form_delete,
  api_wapack_form_responses,
  api_wapack_form_send,
  api_wapack_bot_trigger_get,
  api_wapack_bot_trigger_save,
  _botMaybeSendForm,
  _captureFormResponse,
  api_wapack_webviews_list,
  api_wapack_webview_save,
  api_wapack_webview_delete,
  api_wapack_webview_send,
  api_wapack_shop_connections,
  api_wapack_shop_connect,
  api_wapack_products_list,
  api_wapack_product_send,
  // STOREFRONT_v1
  api_wapack_store_get,
  api_wapack_store_save,
  api_wapack_product_save,
  api_wapack_product_delete,
  api_wapack_products_bulk_add,
  api_wapack_product_from_url,
  api_wapack_product_scan,
  api_wapack_orders_list,
  api_wapack_order_setStatus,
  expressRenderStore,
  expressPlaceOrder,
  api_wapack_seedDemo,
  _installer,
  RETARGET_SEGMENTS
};
