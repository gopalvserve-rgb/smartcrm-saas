'use strict';
/**
 * TENANT_BILLING_NOTIFY_v1 (2026-06-20) — super-admin → customer
 * WhatsApp sender. Reuses Vserve's WABA so the super-admin doesn't
 * need its own Meta Business Account.
 *
 * Reads on first call:
 *   WHATSAPP_PHONE_NUMBER_ID  ← Vserve tenant DB
 *   WHATSAPP_ACCESS_TOKEN     ← Vserve tenant DB
 * Caches for 5 minutes (creds rotate rarely; refresh on cache miss).
 *
 * Public API:
 *   sendText(toPhone, message)  → { ok, message_id?, error? }
 */
const tenantPool = require('./tenantPool');
const tenantDb   = require('../db/pg');

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;

async function _loadCreds() {
  if (_cache && (Date.now() - _cacheAt) < CACHE_MS) return _cache;
  try {
    const t = await tenantPool.findActiveTenant('vserve');
    if (!t) throw new Error('Vserve tenant not found in control DB');
    const pool = tenantPool.poolFor(t);
    if (!pool) throw new Error('No pool for vserve');
    let creds = null;
    await tenantDb.tenantStorage.run({ pool, tenant: t, slug: 'vserve' }, async () => {
      const phoneId = await tenantDb.getConfig('WHATSAPP_PHONE_NUMBER_ID', '');
      const token   = await tenantDb.getConfig('WHATSAPP_ACCESS_TOKEN',    '');
      creds = { phoneId: String(phoneId || '').trim(), token: String(token || '').trim() };
    });
    if (!creds || !creds.phoneId || !creds.token) {
      throw new Error('Vserve WABA not configured (phoneId/token blank)');
    }
    _cache = creds;
    _cacheAt = Date.now();
    return creds;
  } catch (e) {
    console.warn('[saasWaSender] cred load failed:', e.message);
    return null;
  }
}

function _normalisePhone(raw) {
  let s = String(raw || '').replace(/\D/g, '');
  if (!s) return '';
  if (s.length === 10 && /^[6-9]/.test(s)) s = '91' + s;
  return s;
}

/**
 * Send a plain text WhatsApp via the Cloud API.
 * NOTE: A free-form text only works if the customer messaged us in the
 * last 24h; otherwise Meta requires an approved template. For one-shot
 * welcome / billing nudges we fall back gracefully and log the failure.
 */
async function sendText(toPhone, message) {
  const creds = await _loadCreds();
  if (!creds) return { ok: false, error: 'WABA creds unavailable' };
  const to = _normalisePhone(toPhone);
  if (!to) return { ok: false, error: 'invalid phone' };
  const url = 'https://graph.facebook.com/v18.0/' + encodeURIComponent(creds.phoneId) + '/messages';
  const body = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { preview_url: false, body: String(message || '').slice(0, 4000) }
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + creds.token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = j && j.error && j.error.message
        ? String(j.error.message) : ('HTTP ' + res.status);
      return { ok: false, error: errMsg, raw: j };
    }
    const mid = j && j.messages && j.messages[0] && j.messages[0].id;
    return { ok: true, message_id: mid || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function invalidate() { _cache = null; _cacheAt = 0; }

module.exports = { sendText, invalidate, _loadCreds };
