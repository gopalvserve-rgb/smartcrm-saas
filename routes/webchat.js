/**
 * routes/webchat.js — WEBCHAT_v1 (2026-08-15) + WEBCHAT_KB_v1
 * A GPT-style website chat channel powered by the same Gemini brain as the AI bot,
 * but with its OWN, SEPARATE knowledge base (table webchat_kb) — it never reads or
 * touches the WhatsApp bot's ai_kb_documents.
 * SELF-CONTAINED / ADDITIVE: new public endpoints, new tables. Does NOT touch the
 * WhatsApp path. Gated to enabled tenants (default vserve) + an on/off config flag.
 *
 * Public (mounted in server.js, tenant resolved from :slug):
 *   GET  /webchat/:slug/widget.js          -> serves the embed widget
 *   POST /webchat/:slug/start              -> { sessionId, greeting, buttons, theme }
 *   POST /webchat/:slug/message {sessionId,text} -> { reply, buttons, done }
 *
 * Flow: greet -> capture Name -> capture Mobile -> create lead (source Web Chat)
 *       -> auto-assign (round-robin over pool) -> Gemini Q&A grounded in webchat_kb.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db/pg');
const gemini = require('../utils/geminiClient');

// Which tenants may use web chat (safety gate). Extend later via config.
const ALLOWED_SLUGS = ['vserve'];

const _ensured = new Set();
async function _ensureTables() {
  const slug = _slug();
  if (slug && _ensured.has(slug)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS webchat_sessions (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'name',   -- name | mobile | chat | done
      name        TEXT,
      mobile      TEXT,
      lead_id     BIGINT,
      history     JSONB NOT NULL DEFAULT '[]'::jsonb,
      page_url    TEXT,
      referrer    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_webchat_sessions_updated ON webchat_sessions(updated_at)`);
  // SEPARATE knowledge base for web chat (independent of WhatsApp ai_kb_documents)
  await db.query(`
    CREATE TABLE IF NOT EXISTS webchat_kb (
      id          SERIAL PRIMARY KEY,
      title       TEXT,
      body        TEXT NOT NULL,
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  if (slug) _ensured.add(slug);
}

function _slug() { try { const s = db.tenantStorage.getStore(); return (s && s.slug) || null; } catch (_) { return null; } }

async function _cfg() {
  const g = async (k, d) => { try { const v = await db.getConfig(k, d); return v == null ? d : v; } catch (_) { return d; } };
  return {
    enabled:  String(await g('WEBCHAT_ENABLED', '0')) === '1',
    title:    String(await g('WEBCHAT_TITLE', 'Chat with us')),
    sub:      String(await g('WEBCHAT_SUB', 'AI · powered by Gemini')),
    color:    String(await g('WEBCHAT_COLOR', '#128C7E')),
    greeting: String(await g('WEBCHAT_GREETING', "👋 Hi! I'm your assistant. To get started, may I know your name?")),
    buttons:  String(await g('WEBCHAT_BUTTONS', 'Product info,Pricing,Support,Talk to a person')).split(',').map(s => s.trim()).filter(Boolean).slice(0, 4),
    persona:  String(await g('WEBCHAT_PERSONA', 'You are a helpful, concise customer-support assistant.')),
    source:   String(await g('WEBCHAT_SOURCE', 'Web Chat')),
    kbMaxChars: Math.max(1000, Math.min(60000, Number(await g('WEBCHAT_KB_MAX_CHARS', '6000')) || 6000)),
    pool:     String(await g('WA_AUTO_ASSIGN_POOL', '')).split(',').map(s => Number(s)).filter(n => n > 0)
  };
}

// Build the web chat's OWN knowledge-base block (from webchat_kb only).
async function _loadKb(cap) {
  cap = Math.max(1000, Number(cap || 6000));
  try {
    const r = await db.query(`SELECT title, body FROM webchat_kb WHERE is_active = 1 ORDER BY id ASC`);
    let buf = '';
    for (const d of r.rows) {
      const block = `\n\n## ${d.title || 'Info'}\n${d.body || ''}`;
      if (buf.length + block.length > cap) { buf += block.slice(0, cap - buf.length); break; }
      buf += block;
    }
    return buf.trim() ? ('\n\n=== KNOWLEDGE BASE (answer using this) ===' + buf + '\n=== END KNOWLEDGE BASE ===') : '';
  } catch (_) { return ''; }
}

// ------- tenant-gated wrapper for public endpoints -------
async function _run(slug, res, fn) {
  const pools = require('../utils/tenantPool');
  if (ALLOWED_SLUGS.indexOf(slug) === -1) return res.status(404).json({ error: 'not_enabled' });
  let t; try { t = await pools.findActiveTenant(slug); } catch (_) { t = null; }
  if (!t) return res.status(404).json({ error: 'unknown_workspace' });
  const pool = pools.poolFor(t); if (!pool) return res.status(503).json({ error: 'unavailable' });
  return db.tenantStorage.run({ pool, tenant: t, slug }, fn);
}

// ------- GET widget.js -------
function expressWidget(req, res) {
  try {
    const p = path.join(__dirname, '..', 'public', 'webchat', 'widget.js');
    const js = fs.readFileSync(p, 'utf8');
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(js);
  } catch (e) { return res.status(404).send('// widget unavailable'); }
}

// ------- POST /start -------
async function expressStart(req, res) {
  const slug = String(req.params.slug || '');
  return _run(slug, res, async () => {
    try {
      await _ensureTables();
      const cfg = await _cfg();
      if (!cfg.enabled) return res.status(403).json({ error: 'disabled' });
      const id = 'wc_' + crypto.randomBytes(18).toString('hex');
      const body = req.body || {};
      await db.query(`INSERT INTO webchat_sessions (id, status, page_url, referrer) VALUES ($1,'name',$2,$3)`,
        [id, String(body.url || '').slice(0, 500), String(body.ref || '').slice(0, 500)]);
      return res.json({ sessionId: id, greeting: cfg.greeting, buttons: [], theme: { primary: cfg.color, title: cfg.title, sub: cfg.sub } });
    } catch (e) { return res.status(500).json({ error: 'start_failed' }); }
  });
}

// ------- POST /message -------
async function expressMessage(req, res) {
  const slug = String(req.params.slug || '');
  return _run(slug, res, async () => {
    try {
      await _ensureTables();
      const cfg = await _cfg();
      if (!cfg.enabled) return res.status(403).json({ error: 'disabled' });
      const body = req.body || {};
      const sid = String(body.sessionId || '');
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!sid || !text) return res.status(400).json({ error: 'bad_request' });
      const sr = await db.query(`SELECT * FROM webchat_sessions WHERE id = $1 LIMIT 1`, [sid]);
      const s = sr.rows[0];
      if (!s) return res.status(404).json({ error: 'no_session' });

      // ---- Capture: Name ----
      if (s.status === 'name') {
        const name = text.slice(0, 80);
        await db.query(`UPDATE webchat_sessions SET name=$1, status='mobile', updated_at=now() WHERE id=$2`, [name, sid]);
        return res.json({ reply: `Thanks, ${name.split(' ')[0]}! 📱 What's the best mobile number for our team to reach you?`, buttons: [], done: false });
      }

      // ---- Capture: Mobile ----
      if (s.status === 'mobile') {
        const digits = text.replace(/\D/g, '');
        if (digits.length < 10) return res.json({ reply: 'Please share a valid mobile number (at least 10 digits) so our team can reach you. 📱', buttons: [], done: false });
        const mobile = digits;
        let leadId = null, assignee = null;
        try {
          const wb = require('./whatsbot');
          let lead = null; try { lead = await wb._findLeadByPhoneDigits(mobile.slice(-10)); } catch (_) {}
          assignee = await _pickAssignee(cfg.pool);
          if (lead) {
            leadId = lead.id;
            if (assignee) { try { await db.query(`UPDATE leads SET assigned_to=$1, updated_at=now() WHERE id=$2 AND (assigned_to IS NULL OR assigned_to=0)`, [assignee, leadId]); } catch (_) {} }
          } else {
            const ins = await db.query(
              `INSERT INTO leads (name, phone, whatsapp, source, assigned_to, created_at, updated_at)
               VALUES ($1,$2,$2,$3,$4,now(),now()) RETURNING id`,
              [s.name || 'Web Visitor', '+' + mobile, cfg.source, assignee]);
            leadId = ins.rows[0].id;
          }
        } catch (_) {}
        await db.query(`UPDATE webchat_sessions SET mobile=$1, lead_id=$2, status='chat', updated_at=now() WHERE id=$3`, [mobile, leadId, sid]);
        return res.json({ reply: 'Perfect 👍 What can I help you with today?', buttons: cfg.buttons, done: false });
      }

      // ---- Free chat (Gemini, grounded in the web chat's OWN KB) ----
      let history = Array.isArray(s.history) ? s.history : [];
      const kb = await _loadKb(cfg.kbMaxChars);
      const system = [
        cfg.persona,
        kb || null,
        `The customer's name is ${s.name || 'unknown'} and their mobile is ${s.mobile || 'unknown'} — do NOT ask for these again.`,
        kb ? `Answer using the KNOWLEDGE BASE above whenever it is relevant. If it does not cover the question, be honest and offer to have a team member follow up — do not invent facts, prices or URLs.` : null,
        `Keep replies short (2-4 sentences), friendly and helpful. If you cannot help or they ask to speak to a person, tell them a team member will contact them shortly on their mobile.`,
        `You may offer up to 3 tap-to-reply buttons. If useful, end your message with a line exactly like: [QR: option1 | option2 | option3]. If no buttons help, omit it.`
      ].filter(Boolean).join('\n');

      let reply = '', buttons = [];
      try {
        const r = await gemini.generate({ feature: 'ai_bot', system, history, prompt: text, maxOutputTokens: 400 });
        try { await gemini.logUsage({ tenant_slug: _slug(), call_kind: 'webchat', lead_id: s.lead_id || null, result: r }); } catch (_) {}
        reply = (r && r.text || '').trim();
        const mm = reply.match(/\[QR:\s*([^\]]+)\]/i);
        if (mm) { buttons = mm[1].split('|').map(x => x.trim()).filter(x => x && x.toLowerCase() !== 'none').slice(0, 3); reply = reply.replace(mm[0], '').trim(); }
      } catch (_) {}
      if (!reply) reply = 'Thanks! A team member will reach out to you shortly. 🙌';

      history = history.concat([{ role: 'user', text }, { role: 'model', text: reply }]).slice(-20);
      const wantsHuman = /talk to (a )?(person|human|agent)|call me|contact me/i.test(text);
      await db.query(`UPDATE webchat_sessions SET history=$1::jsonb, status=$2, updated_at=now() WHERE id=$3`,
        [JSON.stringify(history), wantsHuman ? 'done' : 'chat', sid]);
      return res.json({ reply, buttons: wantsHuman ? [] : buttons, done: !!wantsHuman });
    } catch (e) { return res.status(500).json({ error: 'message_failed' }); }
  });
}

// round-robin over the pool; cursor stored in config
async function _pickAssignee(pool) {
  if (!pool || !pool.length) return null;
  let idx = 0;
  try { idx = Number(await db.getConfig('WEBCHAT_RR_IDX', '0')) || 0; } catch (_) {}
  const pick = pool[((idx % pool.length) + pool.length) % pool.length];
  try { await db.setConfig('WEBCHAT_RR_IDX', String(idx + 1)); } catch (_) {}
  return Number(pick) || null;
}

// ------- admin config (dispatcher) -------
const _auth = (() => { try { return require('../utils/auth'); } catch (_) { return null; } })();
async function _me(token) { if (_auth && _auth.authUser) { const me = await _auth.authUser(token); if (!me) throw new Error('Not authenticated'); return me; } return { id: null }; }

async function api_webchat_config_get(token) {
  await _me(token); await _ensureTables();
  const cfg = await _cfg();
  return { config: cfg, embed: `<div id="smartcrm-chat"></div>\n<script src="${'https://crm.smartcrmsolution.com'}/webchat/${_slug()}/widget.js" defer></script>` };
}
async function api_webchat_config_save(token, payload) {
  await _me(token); await _ensureTables();
  payload = payload || {};
  const set = async (k, v) => { try { await db.setConfig(k, String(v)); } catch (_) {} };
  if (payload.enabled != null)  await set('WEBCHAT_ENABLED', payload.enabled ? '1' : '0');
  if (payload.title != null)    await set('WEBCHAT_TITLE', String(payload.title).slice(0, 80));
  if (payload.sub != null)      await set('WEBCHAT_SUB', String(payload.sub).slice(0, 120));
  if (payload.color != null)    await set('WEBCHAT_COLOR', String(payload.color).slice(0, 20));
  if (payload.greeting != null) await set('WEBCHAT_GREETING', String(payload.greeting).slice(0, 500));
  if (payload.buttons != null)  await set('WEBCHAT_BUTTONS', (Array.isArray(payload.buttons) ? payload.buttons.join(',') : String(payload.buttons)).slice(0, 300));
  if (payload.persona != null)  await set('WEBCHAT_PERSONA', String(payload.persona).slice(0, 1000));
  return { ok: true };
}

// ------- admin: separate Web Chat knowledge base -------
async function api_webchat_kb_list(token) {
  await _me(token); await _ensureTables();
  const r = await db.query(`SELECT id, title, body, is_active, updated_at FROM webchat_kb ORDER BY is_active DESC, id DESC`);
  return { items: r.rows };
}
async function api_webchat_kb_save(token, payload) {
  await _me(token); await _ensureTables();
  payload = payload || {};
  const title = String(payload.title || '').slice(0, 160);
  const bodyTxt = String(payload.body || '').slice(0, 20000);
  if (!bodyTxt.trim()) throw new Error('Content is required');
  if (payload.id) {
    await db.query(`UPDATE webchat_kb SET title=$1, body=$2, updated_at=now() WHERE id=$3`, [title, bodyTxt, Number(payload.id)]);
    return { ok: true, id: Number(payload.id) };
  }
  const ins = await db.query(`INSERT INTO webchat_kb (title, body, is_active) VALUES ($1,$2,1) RETURNING id`, [title, bodyTxt]);
  return { ok: true, id: ins.rows[0].id };
}
async function api_webchat_kb_delete(token, id) {
  await _me(token); await _ensureTables();
  await db.query(`DELETE FROM webchat_kb WHERE id=$1`, [Number(id)]);
  return { ok: true };
}
async function api_webchat_kb_toggle(token, id, isActive) {
  await _me(token); await _ensureTables();
  await db.query(`UPDATE webchat_kb SET is_active=$1, updated_at=now() WHERE id=$2`, [isActive ? 1 : 0, Number(id)]);
  return { ok: true };
}

module.exports = {
  expressWidget, expressStart, expressMessage,
  api_webchat_config_get, api_webchat_config_save,
  api_webchat_kb_list, api_webchat_kb_save, api_webchat_kb_delete, api_webchat_kb_toggle
};
