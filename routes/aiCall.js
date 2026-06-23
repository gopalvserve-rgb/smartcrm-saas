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

// ════════════════════════════════════════════════════════════════════
// AICALL_v1 Phase 2 — VAPI passthrough proxies
// Every endpoint below loads the saved VAPI_PRIVATE_API_KEY, makes the
// HTTPS call to api.vapi.ai with Bearer auth, and returns the JSON body.
// No data is mirrored locally — Vapi is the source of truth for now.
// Later phases will store call_log rows + webhook handlers locally.
// ════════════════════════════════════════════════════════════════════

async function _vapiKey() {
  const key = await _cfg('VAPI_PRIVATE_API_KEY');
  if (!key) throw new Error('VAPI key not set. Go to FexCall AI → Settings and save your Private API Key first.');
  return key;
}

async function _vapi(method, path, body) {
  const key = await _vapiKey();
  const fetch = (typeof globalThis.fetch === 'function')
    ? globalThis.fetch
    : (await import('node-fetch')).default;
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch('https://api.vapi.ai' + path, opts);
  let payload = null;
  try { payload = await r.json(); } catch (_) { payload = null; }
  if (!r.ok) {
    const msg = (payload && (payload.message || payload.error)) ||
                ('VAPI ' + method + ' ' + path + ' returned HTTP ' + r.status);
    const err = new Error(Array.isArray(msg) ? msg.join('; ') : String(msg));
    err.status = r.status;
    err.vapiBody = payload;
    throw err;
  }
  return payload;
}

// ─── Phone Numbers ─────────────────────────────────────────────────
async function api_aicall_phones_list(token) {
  await _requireAdmin(token);
  const list = await _vapi('GET', '/phone-number');
  return Array.isArray(list) ? list : [];
}
async function api_aicall_phones_get(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  return await _vapi('GET', '/phone-number/' + encodeURIComponent(id));
}
async function api_aicall_phones_create(token, payload) {
  await _requireAdmin(token);
  if (!payload || !payload.provider) throw new Error('provider required (vapi | twilio | byo-phone-number | sip-trunk)');
  return await _vapi('POST', '/phone-number', payload);
}
async function api_aicall_phones_update(token, payload) {
  await _requireAdmin(token);
  if (!payload || !payload.id) throw new Error('id required');
  const id = payload.id;
  const body = Object.assign({}, payload);
  delete body.id;
  return await _vapi('PATCH', '/phone-number/' + encodeURIComponent(id), body);
}
async function api_aicall_phones_delete(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  return await _vapi('DELETE', '/phone-number/' + encodeURIComponent(id));
}

// ─── Assistants ────────────────────────────────────────────────────
async function api_aicall_assistants_list(token) {
  await _requireAdmin(token);
  const list = await _vapi('GET', '/assistant');
  return Array.isArray(list) ? list : [];
}
async function api_aicall_assistants_get(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  return await _vapi('GET', '/assistant/' + encodeURIComponent(id));
}
async function api_aicall_assistants_create(token, payload) {
  await _requireAdmin(token);
  if (!payload || !payload.name) throw new Error('name required');
  return await _vapi('POST', '/assistant', payload);
}
async function api_aicall_assistants_update(token, payload) {
  await _requireAdmin(token);
  if (!payload || !payload.id) throw new Error('id required');
  const id = payload.id;
  const body = Object.assign({}, payload);
  delete body.id;
  return await _vapi('PATCH', '/assistant/' + encodeURIComponent(id), body);
}
async function api_aicall_assistants_delete(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  return await _vapi('DELETE', '/assistant/' + encodeURIComponent(id));
}

// Persist the default outbound assistant id in tenant config so the
// Direct Call button + Lead Call button can pre-select it.
async function api_aicall_default_assistant_set(token, payload) {
  await _requireAdmin(token);
  const id = String((payload && payload.assistant_id) || '').trim();
  await db.setConfig('AI_CALL_DEFAULT_ASSISTANT_ID', id);
  return { ok: true };
}
async function api_aicall_default_assistant_get(token) {
  await _requireAdmin(token);
  const id = await _cfg('AI_CALL_DEFAULT_ASSISTANT_ID');
  return { assistant_id: id || '' };
}

// ─── Knowledge Base (files + named KBs) ────────────────────────────
async function api_aicall_kb_files_list(token) {
  await _requireAdmin(token);
  const list = await _vapi('GET', '/file');
  return Array.isArray(list) ? list : [];
}
async function api_aicall_kb_file_delete(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  return await _vapi('DELETE', '/file/' + encodeURIComponent(id));
}
async function api_aicall_kb_list(token) {
  await _requireAdmin(token);
  const list = await _vapi('GET', '/knowledge-base');
  return Array.isArray(list) ? list : [];
}
async function api_aicall_kb_create(token, payload) {
  await _requireAdmin(token);
  if (!payload || !payload.name) throw new Error('name required');
  return await _vapi('POST', '/knowledge-base', payload);
}
async function api_aicall_kb_delete(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  return await _vapi('DELETE', '/knowledge-base/' + encodeURIComponent(id));
}

// Export Phase 2 additions on the same module.exports object
Object.assign(module.exports, {
  api_aicall_phones_list, api_aicall_phones_get, api_aicall_phones_create,
  api_aicall_phones_update, api_aicall_phones_delete,
  api_aicall_assistants_list, api_aicall_assistants_get, api_aicall_assistants_create,
  api_aicall_assistants_update, api_aicall_assistants_delete,
  api_aicall_default_assistant_set, api_aicall_default_assistant_get,
  api_aicall_kb_files_list, api_aicall_kb_file_delete,
  api_aicall_kb_list, api_aicall_kb_create, api_aicall_kb_delete
});
