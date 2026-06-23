/**
 * routes/aiCall.js — AICALL_v1 (FexCall AI / VAPI integration)
 *
 * Phase 1 surface:
 *   api_aicall_settings_get    — read VAPI config (keys redacted)
 *   api_aicall_settings_save   — admin saves VAPI keys + toggles
 *   api_aicall_test_connection — pings VAPI /assistant to verify the key
 *
 * Keys stored in tenant config table:
 *   AI_CALL_ENABLED         '0' | '1'  (master switch)
 *   AI_CALL_PROVIDER        'vapi'     (only vapi for Phase 1)
 *   VAPI_PRIVATE_API_KEY    secret — never returned in plain text
 *   VAPI_PUBLIC_KEY         public  — returned as-is for web SDK
 *   AI_CALL_DEFAULT_SOURCE  string (lead source for AI-created leads)
 *   AI_CALL_DEFAULT_STATUS  string (lead status for AI follow-up)
 *
 * Later phases will add: phone numbers, assistants, knowledge base,
 * campaigns, call logs.
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const VAPI_BASE = 'https://api.vapi.ai';

// Mask all but last 4 chars of a secret for safe display
function _mask(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 4) return '****';
  return '••••••••••••' + str.slice(-4);
}

async function _requireAdmin(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  return me;
}

async function _cfg(key) {
  try {
    const v = await db.getConfig(key);
    return v == null ? '' : String(v);
  } catch (_) { return ''; }
}

async function api_aicall_settings_get(token) {
  await _requireAdmin(token);
  const [enabled, provider, priv, pub, src, stat] = await Promise.all([
    _cfg('AI_CALL_ENABLED'),
    _cfg('AI_CALL_PROVIDER'),
    _cfg('VAPI_PRIVATE_API_KEY'),
    _cfg('VAPI_PUBLIC_KEY'),
    _cfg('AI_CALL_DEFAULT_SOURCE'),
    _cfg('AI_CALL_DEFAULT_STATUS')
  ]);
  return {
    enabled: enabled === '1',
    provider: provider || 'vapi',
    has_private_key: !!priv,
    private_key_masked: _mask(priv),
    public_key: pub || '',
    default_source: src || 'AI Call Assistant',
    default_status: stat || ''
  };
}

async function api_aicall_settings_save(token, payload) {
  await _requireAdmin(token);
  const p = payload || {};
  const writes = [];

  // Master switch
  if ('enabled' in p) writes.push(db.setConfig('AI_CALL_ENABLED', p.enabled ? '1' : '0'));
  if ('provider' in p) writes.push(db.setConfig('AI_CALL_PROVIDER', String(p.provider || 'vapi').toLowerCase()));

  // Keys — only update when caller provided a non-blank value. Sending
  // empty string explicitly clears the key (so admin can rotate / remove).
  if (p.private_key != null) {
    const v = String(p.private_key || '').trim();
    // Don't overwrite when the UI re-sends the masked placeholder
    if (!v.startsWith('••••')) writes.push(db.setConfig('VAPI_PRIVATE_API_KEY', v));
  }
  if (p.public_key != null) {
    writes.push(db.setConfig('VAPI_PUBLIC_KEY', String(p.public_key || '').trim()));
  }
  if (p.default_source != null) writes.push(db.setConfig('AI_CALL_DEFAULT_SOURCE', String(p.default_source || '').trim()));
  if (p.default_status != null) writes.push(db.setConfig('AI_CALL_DEFAULT_STATUS', String(p.default_status || '').trim()));

  await Promise.all(writes);
  return { ok: true };
}

/**
 * Ping VAPI /assistant — confirms the API key is valid + we can reach
 * VAPI. Returns the count of assistants on success so the admin sees
 * something tangible.
 */
async function api_aicall_test_connection(token) {
  await _requireAdmin(token);
  const key = await _cfg('VAPI_PRIVATE_API_KEY');
  if (!key) {
    return { ok: false, error: 'No VAPI private API key saved. Paste your key and Save Settings first.' };
  }
  try {
    const fetch = (typeof globalThis.fetch === 'function')
      ? globalThis.fetch
      : (await import('node-fetch')).default;
    const r = await fetch(VAPI_BASE + '/assistant', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key }
    });
    if (r.status === 401 || r.status === 403) {
      return { ok: false, status: r.status, error: 'VAPI rejected the key (HTTP ' + r.status + '). Double-check the Private API Key from your Vapi dashboard.' };
    }
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: 'VAPI returned HTTP ' + r.status + ': ' + body.slice(0, 200) };
    }
    const j = await r.json().catch(() => []);
    const list = Array.isArray(j) ? j : (j && j.data) || [];
    return {
      ok: true,
      status: 200,
      assistant_count: list.length,
      message: 'Connected to VAPI. ' + list.length + ' assistant' + (list.length === 1 ? '' : 's') + ' available in this account.'
    };
  } catch (e) {
    return { ok: false, error: 'Network error talking to VAPI: ' + (e && e.message || e) };
  }
}

module.exports = {
  api_aicall_settings_get,
  api_aicall_settings_save,
  api_aicall_test_connection
};
