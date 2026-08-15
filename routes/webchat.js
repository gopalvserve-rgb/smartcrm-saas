/**
 * routes/webchat.js — WEBCHAT_v1 (2026-08-15) + WEBCHAT_REUSE_v1
 * A GPT-style website chat channel that runs the SAME AI bot the tenant already
 * uses on WhatsApp — same config, same knowledge base (ai_bot_settings default
 * row + ai_kb_documents), via aiBot.generateWebReply(). No separate bot, no
 * separate KB. This file only adds the web CHANNEL (widget, lead capture,
 * auto-assign); the brain is the existing AI Assistant.
 * SELF-CONTAINED / ADDITIVE: new public endpoints + a sessions table. Does NOT
 * touch the WhatsApp path. Gated to enabled tenants (default vserve) + a flag.
 *
 * Public (mounted in server.js, tenant resolved from :slug):
 *   GET  /webchat/:slug/widget.js          -> serves the embed widget
 *   POST /webchat/:slug/start              -> { sessionId, greeting, buttons, theme }
 *   POST /webchat/:slug/message {sessionId,text} -> { reply, buttons, done }
 *
 * Flow: greet -> capture Name -> capture Mobile -> create lead (source Web Chat)
 *       -> auto-assign (round-robin) -> chat answered by the existing AI bot.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../db/pg');

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
    source:   String(await g('WEBCHAT_SOURCE', 'Web Chat')),
    pool:     String(await g('WA_AUTO_ASSIGN_POOL', '')).split(',').map(s => Number(s)).filter(n => n > 0)
  };
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

      // ---- Free chat: answered by the SAME AI bot as WhatsApp ----
      let history = Array.isArray(s.history) ? s.history : [];
      let reply = '', buttons = [];
      try {
        const aiBot = require('./aiBot');
        const r = await aiBot.generateWebReply({ text, history, leadId: s.lead_id || null });
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
  return { ok: true };
}

module.exports = {
  expressWidget, expressStart, expressMessage,
  api_webchat_config_get, api_webchat_config_save
};
