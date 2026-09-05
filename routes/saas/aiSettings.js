/**
 * routes/saas/aiSettings.js
 *
 * Super-admin: manage the platform-wide WhatsApp AI Bot settings.
 *
 * Stored in control.ai_settings (one singleton row, id = 1):
 *   - gemini_api_key_enc    — AES-256-GCM encrypted; never returned plaintext
 *   - gemini_default_model  — e.g. 'gemini-3.1-flash-lite'
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
  'gemini-3.1-flash-lite',  // current default — cheapest + JSON-friendly
  'gemini-3.1-flash',
  'gemini-3.1-pro',
];

async function _ensureRow() {
  // Defensive: schema seeds id=1 on apply, but tenants on older schemas
  // might be missing it. Insert if missing.
  await control.query(`INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await _ensureRateCols();
}

/* AI_TOKEN_RATE_v1 (2026-09-05) — super-admin billing rate, priced per 1,00,000
 * tokens rather than per million USD.
 *
 * The existing price_* / markup_pct fields describe what Gemini charges US and
 * are kept untouched for vendor-cost and margin reporting. These two new fields
 * are what the TENANT is billed, set by the super admin in plain rupees:
 *
 *   rate_inr_per_lakh_input   INR charged per 1,00,000 input tokens
 *   rate_inr_per_lakh_output  INR charged per 1,00,000 output tokens
 *
 * Input and output are separate because Gemini's own costs differ ~4x and the
 * tenant usage mix varies enormously (measured: swigato 99.5% input, showcase
 * 43% output) — one blended rate makes one tenant subsidise another. Set both
 * to the same number for flat pricing.
 *
 * Rates are applied at REPORT time, never frozen onto ai_usage_log rows, so
 * changing a rate re-prices history correctly and a corrected invoice is always
 * reproducible. */
let _rateColsDone = false;
async function _ensureRateCols() {
  if (_rateColsDone) return;
  try {
    await control.query(
      `ALTER TABLE ai_settings
         ADD COLUMN IF NOT EXISTS rate_inr_per_lakh_input  DECIMAL(10,4) NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS rate_inr_per_lakh_output DECIMAL(10,4) NOT NULL DEFAULT 0`);
    // Per-tenant override. NULL = inherit the global rate above.
    await control.query(
      `ALTER TABLE tenants
         ADD COLUMN IF NOT EXISTS ai_rate_inr_per_lakh_input  DECIMAL(10,4),
         ADD COLUMN IF NOT EXISTS ai_rate_inr_per_lakh_output DECIMAL(10,4)`);
    _rateColsDone = true;
  } catch (e) {
    console.warn('[aiSettings] rate column migration:', e.message);
  }
}

/**
 * Resolve the effective billing rates for every tenant: the per-tenant override
 * when set, else the global rate. Returned as a map keyed by slug plus the
 * global pair, so callers price a whole report in one query.
 */
async function resolveRates() {
  await _ensureRateCols();
  let g = { in: 0, out: 0 };
  try {
    const r = await control.query(
      `SELECT rate_inr_per_lakh_input AS i, rate_inr_per_lakh_output AS o
         FROM ai_settings WHERE id = 1`);
    if (r.rows[0]) g = { in: Number(r.rows[0].i || 0), out: Number(r.rows[0].o || 0) };
  } catch (_) {}
  const per = {};
  try {
    const r = await control.query(
      `SELECT slug, ai_rate_inr_per_lakh_input AS i, ai_rate_inr_per_lakh_output AS o
         FROM tenants
        WHERE ai_rate_inr_per_lakh_input IS NOT NULL
           OR ai_rate_inr_per_lakh_output IS NOT NULL`);
    r.rows.forEach(x => {
      per[x.slug] = {
        in:  x.i == null ? g.in  : Number(x.i),
        out: x.o == null ? g.out : Number(x.o)
      };
    });
  } catch (_) {}
  return { global: g, per_tenant: per,
           for: slug => per[slug] || g };
}

/**
 * api_saas_ai_rates_setTenant(token, { tenant_slug, rate_in, rate_out })
 * Pass null for either rate to clear the override and fall back to global.
 */
async function api_saas_ai_rates_setTenant(token, payload) {
  await requireSuperAdmin(token);
  await _ensureRateCols();
  const p = payload || {};
  const slug = String(p.tenant_slug || '').trim();
  if (!slug) throw new Error('tenant_slug required');
  const norm = v => (v === null || v === '' || v === undefined) ? null : Math.max(0, Number(v) || 0);
  await control.query(
    `UPDATE tenants
        SET ai_rate_inr_per_lakh_input = $1, ai_rate_inr_per_lakh_output = $2
      WHERE slug = $3`,
    [norm(p.rate_in), norm(p.rate_out), slug]);
  const rates = await resolveRates();
  return { ok: true, tenant_slug: slug, effective: rates.for(slug), global: rates.global };
}

/** api_saas_ai_rates_list(token) — global rate + every tenant override. */
async function api_saas_ai_rates_list(token) {
  await requireSuperAdmin(token);
  const rates = await resolveRates();
  const r = await control.query(
    `SELECT slug, ai_rate_inr_per_lakh_input AS i, ai_rate_inr_per_lakh_output AS o
       FROM tenants ORDER BY slug`);
  return {
    global: rates.global,
    tenants: r.rows.map(x => ({
      tenant_slug: x.slug,
      rate_in:  x.i == null ? null : Number(x.i),
      rate_out: x.o == null ? null : Number(x.o),
      effective: rates.for(x.slug),
      uses_global: x.i == null && x.o == null
    }))
  };
}

async function api_saas_ai_settings_get(token) {
  await requireSuperAdmin(token);
  await _ensureRow();
  const r = await control.query(
    `SELECT gemini_api_key_enc, gemini_default_model, gemini_embedding_model,
            price_input_usd_per_m, price_output_usd_per_m, exchange_rate_inr,
            markup_pct, is_active, updated_at,
            rate_inr_per_lakh_input, rate_inr_per_lakh_output
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
    gemini_default_model:    row.gemini_default_model    || 'gemini-3.1-flash-lite',
    gemini_embedding_model:  row.gemini_embedding_model  || 'text-embedding-004',
    price_input_usd_per_m:   Number(row.price_input_usd_per_m  || 0.075),
    price_output_usd_per_m:  Number(row.price_output_usd_per_m || 0.30),
    exchange_rate_inr:       Number(row.exchange_rate_inr || 84),
    markup_pct:              Number(row.markup_pct || 30),
    /* AI_TOKEN_RATE_v1 — what the TENANT is billed, INR per 1,00,000 tokens. */
    rate_inr_per_lakh_input:  Number(row.rate_inr_per_lakh_input  || 0),
    rate_inr_per_lakh_output: Number(row.rate_inr_per_lakh_output || 0),
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
  /* AI_TOKEN_RATE_v1 — super admin sets these in plain rupees per 1,00,000 tokens. */
  if (p.rate_inr_per_lakh_input  != null) { sets.push(`rate_inr_per_lakh_input = $${i++}`);  vals.push(Math.max(0, Number(p.rate_inr_per_lakh_input)  || 0)); }
  if (p.rate_inr_per_lakh_output != null) { sets.push(`rate_inr_per_lakh_output = $${i++}`); vals.push(Math.max(0, Number(p.rate_inr_per_lakh_output) || 0)); }
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
  /* AI_TOKEN_RATE_v1 */
  api_saas_ai_rates_list,
  api_saas_ai_rates_setTenant,
  resolveRates,   // used by routes/saas/aiCosting.js to price the token report
};
