/**
 * routes/waBotFlows.js
 *
 * Visual / list-based bot flow runner for WhatsApp inbound.
 *
 * A flow is a directed list of nodes. The engine tracks a session per
 * (phone, flow_id). On WhatsApp inbound:
 *   1. If the phone has an active flow session, advance it.
 *   2. Else, find a flow whose `trigger` matches the inbound text.
 *   3. Else, fall through (AI Bot / Message Bot pick it up).
 *
 * Node types (Phase 1 MVP)
 *   message     - send text body, optionally with up to 3 quick-reply buttons.
 *   image       - send an image (URL) with optional caption + buttons.
 *   ask         - send a question, capture the customer's next reply into vars[save_to_var].
 *   branch      - based on vars[var_name] equals/contains/regex, route to one of N targets (else default).
 *   save_field  - write captured vars to the lead row (eg. vars.name -> leads.name).
 *   handoff     - end the flow + suppress the AI Bot / Message Bot for this thread by stamping
 *                 wa_chat_assignments.handoff_at = NOW().
 *   end         - close the session and stop.
 *
 * Each node has:
 *   id              string  (unique within flow)
 *   type            one of the above
 *   body            string  (text body, supports {{var}} interpolation)
 *   media_url       string  (image type only)
 *   buttons         array   [{ id, label, next_node_id }] (1-3, only for message/image)
 *   save_to_var     string  (ask type)
 *   default_next    string  (any type — node id to jump to if no button matched)
 *   branch_var      string  (branch type)
 *   branch_rules    array   [{ op:'equals'|'contains'|'regex', value, target_node_id }]
 *
 * Schema is bootstrapped lazily on first call.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const _ensuredPools = new WeakSet();
async function _ensureSchema() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _ensuredPools.has(pool)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_bot_flows (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT,
      trigger       TEXT,
      trigger_match TEXT NOT NULL DEFAULT 'exact',
      is_active     INTEGER NOT NULL DEFAULT 0,
      priority      INTEGER NOT NULL DEFAULT 100,
      nodes         JSONB NOT NULL DEFAULT '[]'::jsonb,
      start_node_id TEXT,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_bot_flow_sessions (
      id              SERIAL PRIMARY KEY,
      phone           TEXT NOT NULL,
      phone_number_id TEXT,
      flow_id         INTEGER NOT NULL REFERENCES wa_bot_flows(id) ON DELETE CASCADE,
      current_node_id TEXT NOT NULL,
      vars            JSONB NOT NULL DEFAULT '{}'::jsonb,
      lead_id         INTEGER,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_completed    INTEGER NOT NULL DEFAULT 0,
      UNIQUE (phone)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_bot_flow_sessions_phone ON wa_bot_flow_sessions(phone)`);
  if (pool) _ensuredPools.add(pool);
}

// =====================================================================
// CRUD APIs (auto-mounted by tenantApi.js)
// =====================================================================

async function api_waflow_list(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(
    `SELECT id, name, description, trigger, trigger_match, is_active, priority,
            jsonb_array_length(nodes) AS node_count, start_node_id, created_at, updated_at
       FROM wa_bot_flows ORDER BY is_active DESC, priority ASC, id DESC`
  );
  return { flows: r.rows };
}

async function api_waflow_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM wa_bot_flows WHERE id = $1`, [Number(id)]);
  if (!r.rows[0]) throw new Error('Flow not found');
  return { flow: r.rows[0] };
}

async function api_waflow_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('Flow name is required');
  const trigger = String(p.trigger || '').trim();
  const triggerMatch = ['exact', 'contains', 'startswith', 'regex'].includes(p.trigger_match) ? p.trigger_match : 'exact';
  const isActive = Number(p.is_active) === 1 ? 1 : 0;
  const priority = Number(p.priority) || 100;
  const description = String(p.description || '');
  const nodes = Array.isArray(p.nodes) ? p.nodes : [];
  // Validate every node has an id + type
  const seen = new Set();
  for (const n of nodes) {
    if (!n || !n.id || !n.type) throw new Error('Every node needs id + type');
    if (seen.has(n.id)) throw new Error('Duplicate node id: ' + n.id);
    seen.add(n.id);
  }
  const startNode = String(p.start_node_id || (nodes[0] && nodes[0].id) || '');
  if (nodes.length && !seen.has(startNode)) throw new Error('start_node_id must be one of the nodes');

  if (p.id) {
    await db.query(
      `UPDATE wa_bot_flows SET name=$1, description=$2, trigger=$3, trigger_match=$4,
                              is_active=$5, priority=$6, nodes=$7::jsonb, start_node_id=$8,
                              updated_at=NOW()
        WHERE id=$9`,
      [name, description, trigger, triggerMatch, isActive, priority, JSON.stringify(nodes), startNode, Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  }
  const r = await db.query(
    `INSERT INTO wa_bot_flows (name, description, trigger, trigger_match, is_active, priority, nodes, start_node_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`,
    [name, description, trigger, triggerMatch, isActive, priority, JSON.stringify(nodes), startNode, me.id]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_waflow_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureSchema();
  await db.query(`DELETE FROM wa_bot_flows WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_waflow_toggle(token, id, active) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureSchema();
  await db.query(`UPDATE wa_bot_flows SET is_active=$1, updated_at=NOW() WHERE id=$2`,
    [Number(active) === 1 ? 1 : 0, Number(id)]);
  return { ok: true };
}

/** Drop the active session for a phone. Used when an agent wants to free a stuck thread. */
async function api_waflow_session_clear(token, phone) {
  await authUser(token);
  await _ensureSchema();
  await db.query(`DELETE FROM wa_bot_flow_sessions WHERE phone = $1`, [String(phone || '').replace(/\D/g, '').slice(-15)]);
  return { ok: true };
}

// =====================================================================
// Engine
// =====================================================================

function _interpolate(template, vars) {
  return String(template || '').replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, (_m, k) => {
    return (vars && vars[k] != null) ? String(vars[k]) : '';
  });
}

function _findFlowByTrigger(rows, text) {
  const t = String(text || '').trim();
  const tl = t.toLowerCase();
  // Active flows only, ordered by priority asc.
  const active = rows.filter(r => Number(r.is_active) === 1)
                     .sort((a, b) => (a.priority || 100) - (b.priority || 100));
  for (const f of active) {
    const trig = String(f.trigger || '').trim();
    if (!trig) continue;
    const tg = trig.toLowerCase();
    const m = f.trigger_match || 'exact';
    let match = false;
    if (m === 'exact')        match = tl === tg;
    else if (m === 'contains') match = tl.includes(tg);
    else if (m === 'startswith') match = tl.startsWith(tg);
    else if (m === 'regex') {
      try { match = new RegExp(trig, 'i').test(t); } catch (_) {}
    }
    if (match) return f;
  }
  return null;
}

function _findNode(flow, nodeId) {
  return (flow.nodes || []).find(n => n.id === nodeId) || null;
}

/**
 * Send the result of "currently active node" to the customer. Each node
 * ends up either:
 *   - sending one or more outbound messages and waiting for the next reply
 *   - or auto-advancing internally (branch / save_field / end)
 * We keep auto-advancing until we hit a node that requires user input.
 */
async function _executeNode(session, flow, node, ctx) {
  if (!node) return { stop: true, completed: true };
  const wb = ctx.wb;
  const cfg = ctx.cfg;
  const text = (s) => _interpolate(s, session.vars);

  switch (node.type) {
    case 'message':
    case 'button':
    case 'image':
    case 'audio':
    case 'video':
    case 'document': {
      const body = text(node.body || '');
      const mediaUrl = ['image', 'audio', 'video', 'document'].includes(node.type) ? String(node.media_url || '').trim() : '';
      const buttons = Array.isArray(node.buttons) ? node.buttons.slice(0, 3) : [];
      if (mediaUrl) {
        const mediaType = node.type;  // matches WhatsApp Cloud API: image|audio|video|document
        try { await wb._sendMedia({ to: session.phone, mediaType, mediaUrl, caption: body, leadId: session.lead_id }, cfg); }
        catch (e) { console.warn('[waflow] send ' + mediaType + ' failed:', e.message); }
        if (buttons.length) {
          await _sendInteractiveButtons(wb, cfg, session.phone, '👇 Pick one:', buttons, session.lead_id);
        }
      } else if (buttons.length) {
        await _sendInteractiveButtons(wb, cfg, session.phone, body || '👇 Pick one:', buttons, session.lead_id);
      } else {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, cfg); } catch (e) { console.warn('[waflow] send text failed:', e.message); }
      }
      if (buttons.length) return { stop: true };
      if (node.default_next) {
        const next = _findNode(flow, node.default_next);
        if (next) return await _executeNode(session, flow, next, ctx);
      }
      return { stop: true, completed: true };
    }
    case 'location': {
      const body = text(node.body || '');
      const lat = parseFloat(node.latitude);
      const lng = parseFloat(node.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const c = ctx.cfg || await wb._cfg();
        const payload = {
          messaging_product: 'whatsapp',
          to: String(session.phone).replace(/\D/g, ''),
          type: 'location',
          location: { latitude: lat, longitude: lng,
            name: String(node.location_name || '').slice(0, 200) || undefined,
            address: String(node.location_address || '').slice(0, 200) || undefined }
        };
        try { await wb._graphPost(`${c.phoneId}/messages`, payload, c); }
        catch (e) { console.warn('[waflow] location send failed:', e.message); }
      }
      if (body) {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, ctx.cfg); } catch (_) {}
      }
      if (node.default_next) {
        const next = _findNode(flow, node.default_next);
        if (next) return await _executeNode(session, flow, next, ctx);
      }
      return { stop: true, completed: true };
    }
    case 'cta': {
      // URL button (single Call-To-Action) using interactive cta_url
      const body = text(node.body || '');
      const url = String(node.url || '').trim();
      const label = String(node.button_label || 'Open').slice(0, 20);
      if (url) {
        const c = ctx.cfg || await wb._cfg();
        const payload = {
          messaging_product: 'whatsapp',
          to: String(session.phone).replace(/\D/g, ''),
          type: 'interactive',
          interactive: {
            type: 'cta_url',
            body: { text: body || 'Tap below:' },
            action: { name: 'cta_url', parameters: { display_text: label, url } }
          }
        };
        try { await wb._graphPost(`${c.phoneId}/messages`, payload, c); }
        catch (e) {
          console.warn('[waflow] cta send failed, falling back:', e.message);
          try { await wb._sendText({ to: session.phone, text: (body ? body + '\n\n' : '') + label + ': ' + url, leadId: session.lead_id }, ctx.cfg); } catch (_) {}
        }
      } else if (body) {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, ctx.cfg); } catch (_) {}
      }
      if (node.default_next) {
        const next = _findNode(flow, node.default_next);
        if (next) return await _executeNode(session, flow, next, ctx);
      }
      return { stop: true, completed: true };
    }
    case 'ai_handoff': {
      // Hand the next inbound off to the AI Bot. We mark the session as
      // completed so the runner exits — the inbound webhook's normal
      // pipeline will dispatch the AI Bot since no flow session is active.
      const body = text(node.body || '');
      if (body) {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, ctx.cfg); } catch (_) {}
      }
      return { stop: true, completed: true };
    }
    case 'ask': {
      const body = text(node.body || '');
      const buttons = Array.isArray(node.buttons) ? node.buttons.slice(0, 3) : [];
      if (buttons.length) {
        await _sendInteractiveButtons(wb, cfg, session.phone, body || 'Please choose:', buttons, session.lead_id);
      } else {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, cfg); } catch (e) { console.warn('[waflow] ask send failed:', e.message); }
      }
      return { stop: true, awaiting_input: true };
    }
    case 'branch': {
      const v = String(session.vars[node.branch_var || ''] || '').toLowerCase();
      const rules = Array.isArray(node.branch_rules) ? node.branch_rules : [];
      let target = node.default_next;
      for (const r of rules) {
        const op = r.op || 'equals';
        const val = String(r.value || '').toLowerCase();
        let m = false;
        if (op === 'equals') m = v === val;
        else if (op === 'contains') m = v.includes(val);
        else if (op === 'regex') { try { m = new RegExp(r.value, 'i').test(session.vars[node.branch_var] || ''); } catch (_) {} }
        if (m) { target = r.target_node_id; break; }
      }
      const next = target ? _findNode(flow, target) : null;
      if (next) return await _executeNode(session, flow, next, ctx);
      return { stop: true, completed: true };
    }
    case 'save_field': {
      // Map vars onto the lead row
      const field = String(node.field_name || '').trim();
      const valueVar = String(node.value_var || '').trim();
      if (field && valueVar && session.lead_id) {
        const v = session.vars[valueVar];
        if (v != null && v !== '') {
          try {
            await db.query(`UPDATE leads SET ${field} = $1, updated_at = NOW() WHERE id = $2`,
              [String(v).slice(0, 500), session.lead_id]);
          } catch (e) { console.warn('[waflow] save_field failed:', e.message); }
        }
      }
      const next = node.default_next ? _findNode(flow, node.default_next) : null;
      if (next) return await _executeNode(session, flow, next, ctx);
      return { stop: true, completed: true };
    }
    case 'handoff': {
      const body = text(node.body || '');
      if (body) {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, cfg); } catch (_) {}
      }
      // Stamp a "human handoff" marker. The AI Bot's _shouldSuppress checks
      // wa_chat_assignments.handoff_at and shuts up if it's recent.
      try {
        await db.query(`
          INSERT INTO wa_chat_assignments (phone, handoff_at, updated_at)
          VALUES ($1, NOW(), NOW())
          ON CONFLICT (phone) DO UPDATE SET handoff_at = NOW(), updated_at = NOW()
        `, [session.phone]);
      } catch (_) {}
      return { stop: true, completed: true };
    }
    case 'end':
    default: {
      const body = text(node.body || '');
      if (body) {
        try { await wb._sendText({ to: session.phone, text: body, leadId: session.lead_id }, cfg); } catch (_) {}
      }
      return { stop: true, completed: true };
    }
  }
}

async function _sendInteractiveButtons(wb, cfg, to, body, buttons, leadId) {
  // WhatsApp Cloud API interactive button format.
  const c = cfg || await wb._cfg();
  const payload = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(body || '').slice(0, 1024) || 'Please pick one:' },
      action: {
        buttons: buttons.slice(0, 3).map(b => ({
          type: 'reply',
          reply: { id: String(b.id || b.next_node_id || b.label).slice(0, 256), title: String(b.label || 'OK').slice(0, 20) }
        }))
      }
    }
  };
  try {
    const r = await wb._graphPost(`${c.phoneId}/messages`, payload, c).catch(async () => null);
    // Persist outbound for chat history
    const waMsgId = r && r.body && r.body.messages && r.body.messages[0] && r.body.messages[0].id;
    await db.query(
      `INSERT INTO whatsapp_messages (lead_id, direction, from_number, to_number, body, wa_message_id, status, message_type, phone_number_id)
       VALUES ($1, 'out', $2, $3, $4, $5, 'sent', 'interactive', $6)`,
      [leadId || null, c.phoneId, payload.to, body, waMsgId || null, c.phoneId]
    ).catch(() => {});
  } catch (e) {
    console.warn('[waflow] interactive send failed, falling back to text:', e.message);
    // Fall back to numbered text if interactive fails
    const numbered = body + '\n\n' + buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n');
    try { await wb._sendText({ to, text: numbered, leadId }, cfg); } catch (_) {}
  }
}

/**
 * Public entry called from whatsbot._handleInbound BEFORE the AI Bot
 * dispatch. Returns true if a flow handled the message, in which case
 * the caller should skip the AI Bot.
 *
 *   const handled = await waBotFlows.handleInbound({
 *     phone, leadId, inboundText, inboundButtonId, inboundPhoneId, wb
 *   });
 *   if (handled) return;
 */
async function handleInbound({ phone, leadId, inboundText, inboundButtonId, inboundPhoneId, wb }) {
  await _ensureSchema().catch(() => {});
  const phoneNorm = String(phone || '').replace(/\D/g, '').slice(-15);
  if (!phoneNorm) return false;
  const ctx = { wb, cfg: inboundPhoneId ? await wb._cfgForPhone(inboundPhoneId).catch(() => wb._cfg()) : await wb._cfg() };

  // Check for an active session on this phone first.
  const sessRes = await db.query(`SELECT * FROM wa_bot_flow_sessions WHERE phone = $1 AND is_completed = 0`, [phoneNorm]);
  let session = sessRes.rows[0];

  if (session) {
    // Session exists — advance it.
    const flowRes = await db.query(`SELECT * FROM wa_bot_flows WHERE id = $1`, [session.flow_id]);
    const flow = flowRes.rows[0];
    if (!flow || Number(flow.is_active) !== 1) {
      // Flow disabled — close session and let downstream handle.
      await db.query(`UPDATE wa_bot_flow_sessions SET is_completed = 1 WHERE id = $1`, [session.id]).catch(() => {});
      return false;
    }
    const node = _findNode(flow, session.current_node_id);
    if (!node) {
      await db.query(`UPDATE wa_bot_flow_sessions SET is_completed = 1 WHERE id = $1`, [session.id]).catch(() => {});
      return false;
    }
    let nextNode = null;
    let vars = session.vars || {};
    if (typeof vars === 'string') { try { vars = JSON.parse(vars); } catch (_) { vars = {}; } }
    if (node.type === 'ask') {
      // Save the customer's reply into vars[save_to_var]
      const k = String(node.save_to_var || node.id).trim();
      vars[k] = String(inboundText || '').trim();
      // Then advance to default_next or first matching button
      if (inboundButtonId && Array.isArray(node.buttons)) {
        const btn = node.buttons.find(b => String(b.id || '') === String(inboundButtonId));
        if (btn && btn.next_node_id) nextNode = _findNode(flow, btn.next_node_id);
      }
      if (!nextNode && node.default_next) nextNode = _findNode(flow, node.default_next);
    } else if (Array.isArray(node.buttons) && node.buttons.length) {
      // Match button reply by id or label
      let btn = null;
      if (inboundButtonId) btn = node.buttons.find(b => String(b.id || '') === String(inboundButtonId));
      if (!btn) {
        const tx = String(inboundText || '').trim().toLowerCase();
        btn = node.buttons.find(b => String(b.label || '').toLowerCase() === tx);
        // Also match by 1/2/3 numeric reply
        if (!btn && /^[1-9]$/.test(tx)) {
          const idx = Number(tx) - 1;
          if (node.buttons[idx]) btn = node.buttons[idx];
        }
      }
      if (btn && btn.next_node_id) nextNode = _findNode(flow, btn.next_node_id);
      else if (node.default_next) nextNode = _findNode(flow, node.default_next);
    } else if (node.default_next) {
      nextNode = _findNode(flow, node.default_next);
    }
    // Update session to the next node
    if (!nextNode) {
      await db.query(`UPDATE wa_bot_flow_sessions SET is_completed = 1, last_at = NOW(), vars = $1::jsonb WHERE id = $2`,
        [JSON.stringify(vars), session.id]).catch(() => {});
      return true; // we did handle the inbound (terminal)
    }
    await db.query(`UPDATE wa_bot_flow_sessions SET current_node_id = $1, vars = $2::jsonb, last_at = NOW() WHERE id = $3`,
      [nextNode.id, JSON.stringify(vars), session.id]).catch(() => {});
    session.current_node_id = nextNode.id;
    session.vars = vars;
    const r = await _executeNode(session, flow, nextNode, ctx);
    if (r.completed) {
      await db.query(`UPDATE wa_bot_flow_sessions SET is_completed = 1, last_at = NOW() WHERE id = $1`, [session.id]).catch(() => {});
    }
    return true;
  }

  // No active session — match against active flows by trigger.
  const allRes = await db.query(`SELECT * FROM wa_bot_flows WHERE is_active = 1 ORDER BY priority ASC`);
  const flow = _findFlowByTrigger(allRes.rows, inboundText);
  if (!flow) return false;

  const startId = flow.start_node_id || (flow.nodes && flow.nodes[0] && flow.nodes[0].id);
  if (!startId) return false;
  const startNode = _findNode(flow, startId);
  if (!startNode) return false;

  // Create the session
  let sessionId;
  try {
    const ins = await db.query(
      `INSERT INTO wa_bot_flow_sessions (phone, phone_number_id, flow_id, current_node_id, vars, lead_id)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
       ON CONFLICT (phone) DO UPDATE SET flow_id = EXCLUDED.flow_id, current_node_id = EXCLUDED.current_node_id, vars = '{}'::jsonb, lead_id = EXCLUDED.lead_id, started_at = NOW(), last_at = NOW(), is_completed = 0
       RETURNING id`,
      [phoneNorm, inboundPhoneId || null, flow.id, startId, leadId || null]
    );
    sessionId = ins.rows[0].id;
  } catch (e) {
    console.warn('[waflow] session insert failed:', e.message);
    return false;
  }
  const sessForExec = { id: sessionId, phone: phoneNorm, lead_id: leadId || null, vars: {}, current_node_id: startId };
  const r = await _executeNode(sessForExec, flow, startNode, ctx);
  if (r.completed) {
    await db.query(`UPDATE wa_bot_flow_sessions SET is_completed = 1 WHERE id = $1`, [sessionId]).catch(() => {});
  }
  return true;
}

// =====================================================================
// Phase 2: Flow Templates library
// Pre-built flows users can pick with one click. Each template is a
// fully-formed flow definition - users get an instant working starting
// point and can edit from there.
// =====================================================================
const FLOW_TEMPLATES = [
  {
    key: 'booking',
    title: '📅 Site visit / Appointment booking',
    description: 'Greets customer, asks property/service of interest, captures preferred date, hands off to human for confirmation.',
    flow: {
      name: 'Booking flow',
      description: 'Site visit / appointment booking',
      trigger: 'book',
      trigger_match: 'contains',
      is_active: 0,
      priority: 100,
      start_node_id: 'welcome',
      nodes: [
        { id: 'welcome', type: 'message', body: '👋 Hi! Happy to help you book a slot. Which option are you interested in?',
          buttons: [
            { id: 'b_a', label: 'Option A', next_node_id: 'ask_date' },
            { id: 'b_b', label: 'Option B', next_node_id: 'ask_date' },
            { id: 'b_other', label: 'Something else', next_node_id: 'handoff' }
          ], default_next: 'ask_date' },
        { id: 'ask_date', type: 'ask', body: 'Great. When would you like to visit? (eg. tomorrow 11am, this Sat)', save_to_var: 'visit_date', default_next: 'save_lead' },
        { id: 'save_lead', type: 'save_field', field_name: 'notes', value_var: 'visit_date', default_next: 'confirm' },
        { id: 'confirm', type: 'message', body: 'Got it - {{visit_date}}. Our team will call to confirm. Anything else?',
          buttons: [
            { id: 'b_yes', label: 'Yes, more help', next_node_id: 'handoff' },
            { id: 'b_no', label: 'No, thanks', next_node_id: 'thanks' }
          ], default_next: 'thanks' },
        { id: 'thanks', type: 'end', body: 'Thanks! 🙏 We\'ll see you soon.' },
        { id: 'handoff', type: 'handoff', body: 'Connecting you to a human agent. Hang on!' }
      ]
    }
  },
  {
    key: 'qualify',
    title: '📋 Lead qualification',
    description: 'Collects budget, timeline, requirement type. Saves to lead. Routes hot leads to human, others to nurture.',
    flow: {
      name: 'Lead qualification',
      description: 'Budget + timeline + requirement',
      trigger: 'enquire',
      trigger_match: 'contains',
      is_active: 0,
      priority: 100,
      start_node_id: 'q1',
      nodes: [
        { id: 'q1', type: 'message', body: 'Hi! Quick few questions to help you better. What\'s your budget range?',
          buttons: [
            { id: 'b_low',  label: 'Under 50L',   next_node_id: 'save_budget' },
            { id: 'b_mid',  label: '50L - 1Cr',   next_node_id: 'save_budget' },
            { id: 'b_high', label: '1Cr+',       next_node_id: 'save_budget' }
          ], default_next: 'save_budget' },
        { id: 'save_budget', type: 'ask', body: 'And when are you looking to buy?', save_to_var: 'timeline',
          buttons: [
            { id: 'b_now',  label: 'Within 1 month', next_node_id: 'branch' },
            { id: 'b_3mo',  label: '1-3 months',     next_node_id: 'branch' },
            { id: 'b_later',label: '3+ months',      next_node_id: 'branch' }
          ], default_next: 'branch' },
        { id: 'branch', type: 'branch', branch_var: 'timeline',
          branch_rules: [{ op: 'contains', value: '1 month', target_node_id: 'hot' }],
          default_next: 'nurture' },
        { id: 'hot', type: 'handoff', body: '🔥 Great timing - connecting you with a senior consultant right now.' },
        { id: 'nurture', type: 'message', body: 'Thanks! We\'ll send you curated options over the next few weeks. Talk soon 👋',
          default_next: 'end' },
        { id: 'end', type: 'end', body: '' }
      ]
    }
  },
  {
    key: 'support',
    title: '🛠️ Support triage',
    description: 'Customer types support keyword → menu of issue types → routes urgent ones to handoff, FAQs to AI Bot.',
    flow: {
      name: 'Support triage',
      description: 'Categorise support request',
      trigger: 'support',
      trigger_match: 'contains',
      is_active: 0,
      priority: 90,
      start_node_id: 'menu',
      nodes: [
        { id: 'menu', type: 'message', body: 'Sorry to hear you need help. What\'s the issue?',
          buttons: [
            { id: 'b_billing', label: 'Billing',   next_node_id: 'handoff_billing' },
            { id: 'b_tech',    label: 'Technical', next_node_id: 'handoff_tech' },
            { id: 'b_other',   label: 'Other',     next_node_id: 'ai_handoff' }
          ], default_next: 'ai_handoff' },
        { id: 'handoff_billing', type: 'handoff', body: 'Routing you to the billing team. They\'ll reply shortly.' },
        { id: 'handoff_tech',    type: 'handoff', body: 'Routing you to a tech agent. They\'ll reply shortly.' },
        { id: 'ai_handoff', type: 'end', body: 'Sure! Tell me more about the issue and I\'ll help.' }
      ]
    }
  },
  {
    key: 'faq',
    title: '📖 FAQ menu',
    description: 'Common questions menu - each button shows the answer + offers to talk to a human.',
    flow: {
      name: 'FAQ menu',
      description: 'Frequently asked questions',
      trigger: 'help',
      trigger_match: 'exact',
      is_active: 0,
      priority: 100,
      start_node_id: 'menu',
      nodes: [
        { id: 'menu', type: 'message', body: 'Here are quick answers. Pick one:',
          buttons: [
            { id: 'b_hours',   label: 'Hours',   next_node_id: 'a_hours' },
            { id: 'b_pricing', label: 'Pricing', next_node_id: 'a_pricing' },
            { id: 'b_human',   label: 'Talk to human', next_node_id: 'handoff' }
          ], default_next: 'handoff' },
        { id: 'a_hours',   type: 'message', body: 'We\'re open Mon-Sat, 10am-7pm.',  default_next: 'menu' },
        { id: 'a_pricing', type: 'message', body: 'Pricing depends on the package. Reply with your requirement and we\'ll quote.', default_next: 'menu' },
        { id: 'handoff', type: 'handoff', body: 'Connecting you to an agent now.' }
      ]
    }
  },
  {
    key: 'welcome',
    title: '👋 Welcome / first-touch',
    description: 'Greets a brand-new contact, captures their name, sends an intro message, hands off.',
    flow: {
      name: 'Welcome flow',
      description: 'First-touch greeting + name capture',
      trigger: 'hi',
      trigger_match: 'exact',
      is_active: 0,
      priority: 200,
      start_node_id: 'greet',
      nodes: [
        { id: 'greet', type: 'ask', body: 'Welcome 👋 We\'re glad you reached out. May I know your name?',
          save_to_var: 'caller_name', default_next: 'save_name' },
        { id: 'save_name', type: 'save_field', field_name: 'name', value_var: 'caller_name', default_next: 'intro' },
        { id: 'intro', type: 'message', body: 'Lovely to meet you, {{caller_name}}! Tell me what you\'re looking for and I\'ll help.',
          default_next: 'end' },
        { id: 'end', type: 'end', body: '' }
      ]
    }
  }
];

/** Public read-only API: list available templates (no instantiation). */
async function api_waflow_templates_list(token) {
  await authUser(token);
  return { templates: FLOW_TEMPLATES.map(t => ({ key: t.key, title: t.title, description: t.description, node_count: t.flow.nodes.length })) };
}

/** Instantiate a template: create the flow row from the template (inactive). */
async function api_waflow_templates_create(token, key) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureSchema();
  const tpl = FLOW_TEMPLATES.find(t => t.key === key);
  if (!tpl) throw new Error('Unknown template: ' + key);
  const f = tpl.flow;
  const r = await db.query(
    `INSERT INTO wa_bot_flows (name, description, trigger, trigger_match, is_active, priority, nodes, start_node_id, created_by)
     VALUES ($1, $2, $3, $4, 0, $5, $6::jsonb, $7, $8) RETURNING id`,
    [f.name, f.description, f.trigger, f.trigger_match, f.priority, JSON.stringify(f.nodes), f.start_node_id, me.id]
  );
  return { ok: true, id: r.rows[0].id, message: 'Created (disabled). Edit + toggle Active to launch.' };
}

/** Per-flow analytics: sessions started in window, completion %, drop-off node. */
async function api_waflow_analytics(token, opts) {
  await authUser(token);
  await _ensureSchema();
  const o = opts || {};
  const days = Math.max(1, Math.min(180, Number(o.days) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const flowId = o.flow_id ? Number(o.flow_id) : null;
  const params = [since];
  let where = `started_at >= $1`;
  if (flowId) { params.push(flowId); where += ` AND flow_id = $${params.length}`; }

  // Per-flow rollup
  const r = await db.query(
    `SELECT s.flow_id, f.name AS flow_name,
            COUNT(*)::int AS sessions,
            COUNT(*) FILTER (WHERE s.is_completed = 1)::int AS completed,
            COUNT(*) FILTER (WHERE s.is_completed = 0 AND s.last_at < NOW() - INTERVAL '24 hours')::int AS abandoned
       FROM wa_bot_flow_sessions s
       LEFT JOIN wa_bot_flows f ON f.id = s.flow_id
      WHERE ${where}
      GROUP BY s.flow_id, f.name
      ORDER BY sessions DESC`,
    params
  );
  // Drop-off node breakdown (where in-flight sessions are stuck)
  const drop = await db.query(
    `SELECT flow_id, current_node_id, COUNT(*)::int AS stuck
       FROM wa_bot_flow_sessions
      WHERE is_completed = 0 AND ${where}
      GROUP BY flow_id, current_node_id
      ORDER BY stuck DESC
      LIMIT 30`,
    params
  );

  return {
    range_days: days,
    per_flow: r.rows.map(x => ({
      flow_id: x.flow_id, flow_name: x.flow_name,
      sessions: x.sessions, completed: x.completed, abandoned: x.abandoned,
      completion_pct: x.sessions ? Math.round((x.completed / x.sessions) * 100) : 0
    })),
    drop_off: drop.rows
  };
}

module.exports = {
  // public tenant API (auto-mounted)
  api_waflow_list, api_waflow_get, api_waflow_save, api_waflow_delete, api_waflow_toggle, api_waflow_session_clear,
  api_waflow_templates_list, api_waflow_templates_create, api_waflow_analytics,
  // engine
  handleInbound,
};
