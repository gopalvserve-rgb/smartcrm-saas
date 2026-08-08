/**
 * WA_CENTRAL_FORWARDER_v1 (2026-08-08)
 *
 * Replacement for the lost PHP central forwarder (whatsbot_webhook_all.php +
 * wa_connections.json) that used to live on the old smartcrmsolution.com PHP
 * hosting. The Meta App "Smart CRM Solution" delivers ALL WhatsApp Cloud API
 * webhook events (messages, statuses) for EVERY connected phone number to:
 *
 *     https://smartcrmsolution.com/whatsbot_webhook_all.php
 *
 * When the root domain moved to this Express app the PHP files vanished →
 * Meta got 404s → delivery/read/failed statuses AND inbound chat messages
 * stopped for every domain (Stockbox, Celeste, all SaaS tenants) on 2026-08-07.
 *
 * These handlers restore the exact same URLs on the same host:
 *   GET  /whatsbot_webhook_all.php   → Meta verification (echo hub.challenge)
 *   POST /whatsbot_webhook_all.php   → route event by phone_number_id → tenant webhook_url
 *   POST /whatsbot_register.php      → upsert a routing row   (X-Register-Secret)
 *   POST /whatsbot_deregister.php    → remove a routing row   (X-Register-Secret)
 *
 * Routing table: wa_connections.json in the app root —
 *   { "<phone_number_id>": { "webhook_url": "...", "business_account_id": "...",
 *                            "tenant_name": "...", "updated_at": "..." } }
 *
 * Design notes:
 * - Meta is ACKed immediately with 200 (before forwarding) — Meta only needs
 *   receipt confirmation; slow/failing tenant endpoints must never make Meta
 *   mark our webhook unhealthy again.
 * - Forwards are best-effort with an 8s timeout, logged on failure.
 * - Unknown phone_number_id events are logged and dropped (still 200).
 * - The file is re-read on every event (cheap; campaigns are the hot path at
 *   ~25 msg/30s) so registrations apply instantly across all pm2 workers.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'wa_connections.json');

function _load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (_) { return {}; }
}

function _save(map) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, FILE);
}

/** GET — Meta webhook verification handshake. Echo the challenge. */
function verify(req, res) {
  const q = req.query || {};
  const challenge = q['hub.challenge'] || q.hub_challenge;
  if (challenge) return res.status(200).send(String(challenge));
  return res.status(200).send('wa-forwarder up');
}

/** POST — a Meta event. Ack instantly, then fan out by phone_number_id. */
function event(req, res) {
  res.status(200).json({ ok: true });
  try {
    let body = req.body;
    if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString('utf8')); } catch (_) { body = null; } }
    if (!body || typeof body !== 'object') return;
    const phones = new Set();
    (body.entry || []).forEach(e => (e.changes || []).forEach(c => {
      const p = c && c.value && c.value.metadata && c.value.metadata.phone_number_id;
      if (p) phones.add(String(p));
    }));
    if (!phones.size) { console.warn('[waFwd] event with no phone_number_id — dropped'); return; }
    const map = _load();
    for (const p of phones) {
      const reg = map[p];
      if (!reg || !reg.webhook_url) { console.warn('[waFwd] no registration for phone', p, '— dropped'); continue; }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      fetch(reg.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal
      }).then(r => {
        clearTimeout(timer);
        if (r.status >= 300) console.warn('[waFwd]', p, '->', reg.webhook_url, 'HTTP', r.status);
      }).catch(e => { clearTimeout(timer); console.warn('[waFwd] forward failed', p, '->', reg.webhook_url, e.message); });
    }
  } catch (e) {
    console.warn('[waFwd] event handler error:', e.message);
  }
}

function _auth(req, res) {
  const secret = process.env.FORWARDER_REGISTER_SECRET || '';
  if (!secret || req.get('X-Register-Secret') !== secret) {
    res.status(403).json({ ok: false, error: 'bad or missing X-Register-Secret' });
    return false;
  }
  return true;
}

/** POST — upsert a routing row. Same contract the CRMs' register calls use. */
function register(req, res) {
  if (!_auth(req, res)) return;
  const b = req.body || {};
  const phone = String(b.phone_number_id || '').trim();
  const url = String(b.webhook_url || '').trim();
  if (!phone || !url) return res.status(400).json({ ok: false, error: 'phone_number_id and webhook_url required' });
  if (!/^https:\/\//.test(url)) return res.status(400).json({ ok: false, error: 'webhook_url must be https' });
  const map = _load();
  map[phone] = {
    webhook_url: url,
    business_account_id: String(b.business_account_id || ''),
    tenant_name: String(b.tenant_name || ''),
    updated_at: new Date().toISOString()
  };
  _save(map);
  console.log('[waFwd] registered', phone, '->', url);
  return res.json({ ok: true });
}

/** POST — remove a routing row. */
function deregister(req, res) {
  if (!_auth(req, res)) return;
  const b = req.body || {};
  const phone = String(b.phone_number_id || '').trim();
  if (!phone) return res.status(400).json({ ok: false, error: 'phone_number_id required' });
  const map = _load();
  const existed = !!map[phone];
  delete map[phone];
  _save(map);
  console.log('[waFwd] deregistered', phone, '(existed:', existed + ')');
  return res.json({ ok: true, existed });
}

module.exports = { verify, event, register, deregister };
