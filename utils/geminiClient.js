/**
 * utils/geminiClient.js
 *
 * Server-side wrapper around the Google Gemini API. Single source of
 * truth for every call the WhatsApp AI Bot makes.
 *
 * Responsibilities
 *   - Resolve the API key from control.ai_settings (decrypt + cache)
 *   - Resolve pricing (USD/M tokens) + USD→INR rate + markup pct
 *   - POST to v1beta/models/{model}:generateContent
 *   - Parse usageMetadata for input/output tokens
 *   - Compute cost (real $, real ₹, billed ₹) using the rates that were
 *     in effect AT THE TIME OF THE CALL (not whatever's current — so
 *     historical billing rows stay stable)
 *   - Return { text, input_tokens, output_tokens, model, cost_*  }
 *
 * Callers (routes/aiBot.js):
 *   const r = await gemini.generate({ prompt, system, history, model });
 *   await gemini.logUsage({ tenant_slug, ... r ... });
 *
 * Caching: ai_settings is cached for 60 s — pricing changes don't need
 * to land instantly, and avoiding a control-DB round-trip per inbound
 * webhook keeps reply latency in the ~300 ms range.
 */

'use strict';

const control = require('../control/db');
const { decryptString } = require('./aiCrypto');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

let _settingsCache = null;
let _settingsCachedAt = 0;
const SETTINGS_TTL_MS = 60 * 1000;

/**
 * Load (and decrypt) the platform AI settings. Cached 60 s.
 *
 * Key resolution order:
 *   1. ai_settings.gemini_api_key_enc — set via super-admin Settings UI.
 *      Decrypts via utils/aiCrypto.
 *   2. process.env.GEMINI_API_KEY — same env var the existing call-
 *      transcription path (utils/aiCallSummary.js) already uses, so
 *      WhatsApp AI Bot can piggy-back on a Railway env without the
 *      super-admin having to paste the key twice.
 *
 * Returns null when:
 *   - is_active = 0 in ai_settings (super-admin globally disabled), AND
 *     GEMINI_API_KEY env is not set either.  (We treat env-key-only as
 *     "auto-enabled" so existing deployments work out of the box —
 *     setting is_active=0 explicitly via the UI overrides this.)
 *   - no key resolved at all
 */
async function loadSettings(force) {
  if (!force && _settingsCache && (Date.now() - _settingsCachedAt) < SETTINGS_TTL_MS) {
    return _settingsCache;
  }
  let row = null;
  try {
    const r = await control.query(
      `SELECT gemini_api_key_enc, gemini_default_model, gemini_embedding_model,
              price_input_usd_per_m, price_output_usd_per_m,
              exchange_rate_inr, markup_pct, is_active
         FROM ai_settings WHERE id = 1`
    );
    row = r.rows[0] || null;
  } catch (_) { /* table missing — fall through to env-only mode */ }

  // Resolve key
  let apiKey = '';
  let keySource = null;
  if (row && row.gemini_api_key_enc) {
    apiKey = decryptString(row.gemini_api_key_enc);
    if (apiKey) keySource = 'control_db';
  }
  if (!apiKey && process.env.GEMINI_API_KEY) {
    apiKey = String(process.env.GEMINI_API_KEY).trim();
    if (apiKey) keySource = 'env';
  }
  if (!apiKey) return null;

  // Resolve enabled flag.
  //   - If admin EXPLICITLY set is_active = 0 in ai_settings → respect it.
  //   - Otherwise (no row OR is_active = 1) → enabled.
  const explicitlyDisabled = row && Number(row.is_active) === 0
                              && row.gemini_api_key_enc; // only if a key was once saved
  if (explicitlyDisabled) return null;

  _settingsCache = {
    apiKey,
    keySource,
    defaultModel:        (row && row.gemini_default_model)   || 'gemini-2.0-flash-lite',
    embeddingModel:      (row && row.gemini_embedding_model) || 'text-embedding-004',
    priceInputPerM:      Number((row && row.price_input_usd_per_m)  || 0.075),
    priceOutputPerM:     Number((row && row.price_output_usd_per_m) || 0.30),
    exchangeRateInr:     Number((row && row.exchange_rate_inr) || 84),
    markupPct:           Number((row && row.markup_pct) || 30),
  };
  _settingsCachedAt = Date.now();
  return _settingsCache;
}

/** Force a refresh — call from api_saas_ai_settings_save so the next call uses the new rates. */
function invalidateCache() { _settingsCache = null; _settingsCachedAt = 0; }

/**
 * Compute the three cost figures for a call.
 * Returns { cost_usd, cost_inr_real, cost_inr_billed }.
 */
function computeCost(inputTokens, outputTokens, settings) {
  const inUsd  = (Number(inputTokens || 0)  / 1e6) * settings.priceInputPerM;
  const outUsd = (Number(outputTokens || 0) / 1e6) * settings.priceOutputPerM;
  const usd  = inUsd + outUsd;
  const inr  = usd * settings.exchangeRateInr;
  const inrBilled = inr * (1 + settings.markupPct / 100);
  return {
    cost_usd:        Number(usd.toFixed(8)),
    cost_inr_real:   Number(inr.toFixed(4)),
    cost_inr_billed: Number(inrBilled.toFixed(4)),
  };
}

/**
 * Generate a chat response.
 *
 * Args:
 *   {
 *     system:  string — system instructions (persona, KB, rules)
 *     history: [{ role: 'user'|'model', text: '...' }, ...] — recent turns
 *     prompt:  string — the new user message
 *     model:   string|null — overrides settings.defaultModel
 *     maxOutputTokens:  number — default 600
 *     temperature: number — default 0.4
 *   }
 *
 * Returns:
 *   {
 *     ok:            boolean,
 *     text:          string,        // empty on failure
 *     model:         string,
 *     input_tokens:  int,
 *     output_tokens: int,
 *     cost_usd, cost_inr_real, cost_inr_billed,
 *     finish_reason: string|null,
 *     error:         string|null,   // null on success
 *     raw_status:    int|null,
 *   }
 */
async function generate(args) {
  const settings = await loadSettings();
  if (!settings) {
    return { ok: false, text: '', model: '', input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             finish_reason: null, error: 'AI is not configured (missing or disabled).', raw_status: null };
  }
  const model = String(args.model || settings.defaultModel);
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;

  const contents = [];
  (args.history || []).forEach(h => {
    if (!h || !h.text) return;
    contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text) }] });
  });
  contents.push({ role: 'user', parts: [{ text: String(args.prompt || '') }] });

  const body = {
    contents,
    generationConfig: {
      temperature:       args.temperature != null ? Number(args.temperature) : 0.4,
      maxOutputTokens:   Number(args.maxOutputTokens || 600),
    }
  };
  if (args.system) {
    // Gemini supports systemInstruction as a separate top-level field.
    body.systemInstruction = { role: 'system', parts: [{ text: String(args.system) }] };
  }

  let resp, json;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    json = await resp.json();
  } catch (e) {
    return { ok: false, text: '', model, input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             finish_reason: null, error: 'Gemini network error: ' + e.message, raw_status: null };
  }
  if (!resp.ok || json.error) {
    return { ok: false, text: '', model, input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             finish_reason: null,
             error: (json && json.error && json.error.message) || ('HTTP ' + resp.status),
             raw_status: resp.status };
  }

  // Extract reply text
  let text = '';
  let finishReason = null;
  try {
    const cand = (json.candidates || [])[0] || {};
    finishReason = cand.finishReason || null;
    text = (cand.content?.parts || []).map(p => p.text || '').join('').trim();
  } catch (_) {}

  const usage = json.usageMetadata || {};
  const inTok  = Number(usage.promptTokenCount || 0);
  const outTok = Number(usage.candidatesTokenCount || 0);
  const costs = computeCost(inTok, outTok, settings);
  return {
    ok: true,
    text,
    model,
    input_tokens:  inTok,
    output_tokens: outTok,
    cost_usd:        costs.cost_usd,
    cost_inr_real:   costs.cost_inr_real,
    cost_inr_billed: costs.cost_inr_billed,
   