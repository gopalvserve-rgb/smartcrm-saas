/**
 * routes/saas/aiSettings.js
 *
 * Super-admin: manage the platform-wide WhatsApp AI Bot settings.
 *
 * Stored in control.ai_settings (one singleton row, id = 1):
 *   - gemini_api_key_enc    — AES-256-GCM encrypted; never returned plaintext
 *   - gemini_default_model  — e.g. 'gemini-2.0-flash-lite'
 *   - price_input/output_usd_per_m — current Google list prices
 *   - exchange_rate_inr     — USD → INR
 *   - markup_pct            — added to real INR before billing tenants
 *   - is_active             — global on/off lever
 *
 * The Gemini key is hidden from tenants entirely. Every tenant's bot
 * code path goes through utils/aiClient.js which decrypts the key on
 * demand server-side. The SPA receives `key_set: true/false` + a masked
 * preview only.
 *
 * Endpoints (all require super-admin token):
 *   api_saas_ai_settings_get(token)             → current settings (key masked)
 *   api_saas_ai_settings_save(token, payload)   → upsert; payload.gemini_api_key
 *                                                 is the new key (omit / empty
 *                                                 to keep the existing one)
 *   api_saas_ai_settings_test(token)            → quick ping to Gemini to
 *                                                 validate the saved key
 */

'use strict';

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');
const { encryptString, decryptString, maskKey } = require('../../utils/aiCrypto');

// Allowed defaults — these are SUGGESTED models; you can paste any value
// the Gemini API accepts. Used by the UI to populate a dropdown.
const SUGGESTED_MODELS = [
  'gemini-2.0-flash-lite',  // cheapest, default
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
];

async function _ensureRow() {
  // Defensive: schema seeds id=1 on apply, but tenants on older schemas
  // might be missing it. Insert if missing.
  await control.query(`INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

async function api_saas_ai_settings_get(token) {
  await requireSuperAdmin(token);
  await _ensureRow();
  const r = await control.query(
    `SELECT gemini_api_key_enc, gemini_default_model, gemini_embedding_model,
            price_input_usd_per_m, price_output_usd_per_m, exchange_rate_inr,
            markup_pct, is_active, updated_at
       FROM ai_settings WHERE id = 1`
  );
  const row = r.rows[0] || {};
  const realKey = decryptString(row.gemini_api_key_enc);
  // Env-var fallback — same key the call-recording AI uses.
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  const effectiveKey = realKey || envKey;
  const keySource = realKey ? 'database' : (envKey ? 'env' : null);
  return {
    key_set:                 !!effectiveKey,
    key_source:              keySource,
    key_preview:             maskKey(effectiveKey),
    db_key_set:              !!realKey,
    env_key_set:             !!envKey,
    gemini_default_model:    row.gemini_default_model    || 'gemini-2.0-flash-lite',
    gemini_embedding_model:  row.gemini_embedding_model  || 'text-embedding-004',
    price_input_usd_per_m:   Number(row.price_input_usd_per_m  || 0.075),
    price_output_usd_per_m:  Number(row.price_output_usd_per_m || 0.30),
    exchange_rate_inr:       Number(row.exchange_rate_inr || 84),
    markup_pct:              Number(row.markup_pct || 30),
    is_active:               Number(row.is_active || 0) === 1 || (!realKey && !!envKey),
    db_is_active:            Number(row.is_active || 0) === 1,
    updated_at:              row.updated_at || null,
    suggested_models:        SUGGESTED_MODELS,
  };
}

async function api_saas_ai_settings_save(token, payload) {
  await requireSuperAdmin(token);
  await _ensureRow();
  const p = payload || {};
  const sets = [];
  const vals = [];
  let i = 1;

  // Only overwrite the key when the caller passes a non-empty new value.
  if (p.gemini_api_key && String(p.gemini_api_key).trim()) {
    const trimmed = String(p.gemini_api_key).trim();
    sets.push(`gemini_api_key_enc = $${i++}`);
    vals.push(encryptString(trimmed));
  } else if (p.clear_key === true) {
    sets.push(`gemini_api_key_enc = NULL`);
    sets.push(`is_active = 0`);
  }

  if (p.gemini_default_model)   { sets.push(`gemini_default_model = $${i++}`);   vals.push(String(p.gemini_default_model)); }
  if (p.gemini_embedding_model) { sets.push(`gemini_embedding_model = $${i++}`); vals.push(String(p.gemini_embedding_model)); }
  if (p.price_input_usd_per_m  != null) { sets.push(`price_input_usd_per_m = $${i++}`);  vals.push(Number(p.price_input_usd_per_m)); }
  if (p.price_output_usd_per_m != null) { sets.push(`price_output_usd_per_m = $${i++}`); vals.push(Number(p.price_output_usd_per_m)); }
  if (p.exchange_rate_inr      != null) { sets.push(`exchange_rate_inr = $${i++}`);      vals.push(Number(p.exchange_rate_inr)); }
  if (p.markup_pct             != null) { sets.push(`markup_pct = $${i++}`);             vals.push(Number(p.markup_pct)); }
  if (p.is_active != null)              { sets.push(`is_active = $${i++}`);              vals.push(p.is_active ? 1 : 0); }

  if (!sets.length) return await api_saas_ai_settings_get(token);

  sets.push(`updated_at = NOW()`);
  await control.query(`UPDATE ai_settings SET ${sets.join(', ')} WHERE id = 1`, vals);

  // Auto-flip is_active to 1 when a key is being set for the first time
  // (unless the caller explicitly set is_active=false).
  if (p.gemini_api_key && p.is_active == null) {
    await control.query(`UPDATE ai_settings SET is_active = 1 WHERE id = 1 AND is_active = 0 AND gemini_api_key_enc IS NOT NULL`);
  }
  return await api_saas_ai_settings_get(token);
}

/**
 * Quick liveness check against Gemini using the saved key. Calls the
 * tiny `models.list` endpoint which is free and returns instantly.
 */
async function api_saas_ai_settings_test(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`SELECT gemini_api_key_enc FROM ai_settings WHERE id = 1`);
  let apiKey = decryptString(r.rows[0]?.gemini_api_key_enc);
  let source = apiKey ? 'database' : null;
  if (!apiKey && process.env.GEMINI_API_KEY) {
    apiKey = String(process.env.GEMINI_API_KEY).trim();
    source = 'env';
  }
  if (!apiKey) return { ok: false, error: 'No Gemini API key configured (paste one or set GEMINI_API_KEY env var).' };
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey);
    const resp = await fetch(url, { method: 'GET' });
    const j = await resp.json();
    if (!resp.ok) return { ok: false, error: j?.error?.message || ('HTTP ' + resp.status) };
    const count = Array.isArray(j.models) ? j.models.length : 0;
    return { ok: true, models_visible: count, sample_model: j.models?.[0]?.name || null, key_source: source };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}


/**
 * List Gemini models that support generateContent on the current key.
 * Useful when 'limit: 0' / 'not found' errors come back — the user can
 * see exactly which models are usable on their billing project and pick
 * one from the dropdown.
 */
async function api_saas_ai_models_available(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`SELECT gemini_api_key_enc FROM ai_settings WHERE id = 1`);
  let apiKey = decryptString(r.rows[0]?.gemini_api_key_enc);
  if (!apiKey && process.env.GEMINI_API_KEY) apiKey = String(process.env.GEMINI_API_KEY).trim();
  if (!apiKey) return { ok: false, error: 'No Gemini key configured.' };
  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey);
    const resp = await fetch(url);
    const j = await resp.json();
    if (!resp.ok) return { ok: false, error: j?.error?.message || ('HTTP ' + resp.status) };
    const all = Array.isArray(j.models) ? j.models : [];
    const usable = all
      .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
      .map(m => ({
        name: String(m.name || '').replace(/^models\//, ''),
        displayName: m.displayName,
        description: m.description,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
      }));
    return { ok: true, total_models: all.length, generate_content_models: usable };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  api_saas_ai_settings_get,
  api_saas_ai_settings_save,
  api_saas_ai_settings_test,
  api_saas_ai_models_available,
};
