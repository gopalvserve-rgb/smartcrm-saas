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
// SHOWCASE_AI_v2 — feature-aware kill switch for demo tenants.
//   Copilot, Quick Note, AI Bot reply: ALLOWED (Copilot daily quota enforced
//   upstream by crmCopilot.js — set COPILOT_DAILY_LIMIT_PER_USER=30 on
//   showcase tenants).
//   AI Call Audit / Call Summary / Hot-Lead Detect: BLOCKED so prospects
//   clicking "Audit" on a demo recording can't burn money.
const db = require('../db/pg');
async function _isDemoTenant() {
  try {
    const r = await db.findOneBy('config', 'key', 'DEMO_TENANT').catch(() => null);
    return r && String(r.value) === '1';
  } catch (_) { return false; }
}
// Features allowed on demo tenants. Everything else is blocked.
const DEMO_ALLOWED_FEATURES = new Set([
  'copilot', 'copilot_ask', 'crm_copilot',
  'quick_note', 'lead_quicknote',
  'ai_bot', 'whatsbot', 'aibot_reply'
]);
async function _demoBlocked(args) {
  if (!(await _isDemoTenant())) return null;
  const feature = String((args && args.feature) || '').toLowerCase();
  if (DEMO_ALLOWED_FEATURES.has(feature)) return null;     // allow
  return { ok: false, text: '', model: '', input_tokens: 0, output_tokens: 0,
           cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
           finish_reason: null, error: 'AI Audit / Summary is disabled on showcase / demo tenants. Copilot and Quick Note still work (limited to 30 / day).', raw_status: null };
}

async function generate(args) {
  const blocked = await _demoBlocked(args);
  if (blocked) return blocked;
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
  // Retry-with-backoff for transient errors (503/429). Same logic as
  // generateWithTools — Gemini flash models hiccup at peak, 2-3 retries
  // with exponential delay usually wins, then fall back to sibling model.
  let triedFallback = false;
  let currentModel = model;
  let currentUrl = url;
  const MAX_RETRIES = 3;
  let attempt = 0;
  let ok = false;
  while (!ok) {
    try {
      resp = await fetch(currentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      json = await resp.json();
    } catch (e) {
      return { ok: false, text: '', model: currentModel, input_tokens: 0, output_tokens: 0,
               cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
               finish_reason: null, error: 'Gemini network error: ' + e.message, raw_status: null };
    }
    const errMsg = (json && json.error && json.error.message) || '';
    const isOverloaded = resp.status === 503 || resp.status === 429
                      || /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|rate.{0,5}limit/i.test(errMsg);
    if (resp.ok && !json.error) { ok = true; break; }
    if (isOverloaded && attempt < MAX_RETRIES) {
      attempt++;
      const delay = (Math.pow(2, attempt) * 400) + Math.floor(Math.random() * 400);
      console.warn('[gemini] ' + resp.status + ' on ' + currentModel + ', retry ' + attempt + '/' + MAX_RETRIES + ' in ' + delay + 'ms');
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    if (isOverloaded && !triedFallback) {
      const fallbackModel = currentModel.includes('flash-lite') ? 'gemini-2.0-flash'
                          : currentModel.includes('flash')      ? 'gemini-2.0-flash-lite'
                          : null;
      if (fallbackModel) {
        triedFallback = true;
        currentModel = fallbackModel;
        currentUrl = `${GEMINI_BASE}/models/${encodeURIComponent(fallbackModel)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
        attempt = 0;
        console.warn('[gemini] retries exhausted on ' + model + ' — fallback to ' + fallbackModel);
        continue;
      }
    }
    const userMsg = isOverloaded
      ? 'AI is busy right now (Gemini high-demand). Please try again in a moment.'
      : (errMsg || ('HTTP ' + resp.status));
    return { ok: false, text: '', model: currentModel, input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             finish_reason: null, error: userMsg, raw_status: resp.status };
  }
  // currentModel may have been swapped if we fell back — reflect in returned record
  if (currentModel !== model) model = currentModel;

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
    finish_reason: finishReason,
    error: null,
    raw_status: resp.status
  };
}

/**
 * Append a row to control.ai_usage_log. Always called after generate(),
 * even on failure (so super-admin sees the error rate). Failed calls
 * have error_text set + cost = 0 so they aren't billed.
 */
async function logUsage({ tenant_slug, tenant_id, call_kind, phone, lead_id, wa_message_id, result }) {
  // Defensive slug capture - if the caller passed an empty slug (e.g. because
  // they read it from tenantStorage too early, or were called from a path
  // where tenantStorage wasn't set), try to recover the slug from the
  // AsyncLocalStorage now (since logUsage tends to be called inside the
  // same tenant-scoped Promise chain).
  let slug = String(tenant_slug || '').trim();
  let tid  = tenant_id;
  if (!slug || !tid) {
    try {
      const dbMod = require('../db/pg');
      const store = dbMod.tenantStorage && dbMod.tenantStorage.getStore && dbMod.tenantStorage.getStore();
      if (store) {
        if (!slug && store.slug) slug = String(store.slug);
        if (!tid && store.tenant && store.tenant.id) tid = store.tenant.id;
      }
    } catch (_) {}
  }
  // Visibility: log every insertion attempt so Railway logs show whether
  // a tenant's calls are reaching here. Spammy on purpose - turn down
  // once we're sure logging is working.
  console.log('[gemini.logUsage]',
    'slug=' + (slug || '(empty)'),
    'tid=' + (tid || '-'),
    'kind=' + (call_kind || 'reply'),
    'ok=' + (result && result.ok ? '1' : '0'),
    'in=' + (result && result.input_tokens || 0),
    'out=' + (result && result.output_tokens || 0)
  );

  try {
    await control.query(
      `INSERT INTO ai_usage_log
         (tenant_id, tenant_slug, call_kind, model, input_tokens, output_tokens,
          cost_usd, cost_inr_real, cost_inr_billed,
          phone, lead_id, wa_message_id, error_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tid || null, slug, call_kind || 'reply',
        result.model || '',
        result.input_tokens || 0, result.output_tokens || 0,
        result.cost_usd || 0, result.cost_inr_real || 0, result.cost_inr_billed || 0,
        phone || null, lead_id || null, wa_message_id || null,
        result.ok ? null : (result.error || 'failed').slice(0, 500)
      ]
    );
  } catch (e) {
    // Loud failure - if THIS is what's been silently eating learnimo's
    // rows, it'll show up in Railway logs the next time the bot replies.
    console.error('[gemini.logUsage] INSERT failed slug=' + slug + ' kind=' + (call_kind || '?') + ':', e.message);
    // Best-effort secondary write to make the failure VISIBLE in the
    // dashboard - drop a row marked with error_text so the super-admin
    // can see the call existed at all. Most failures are schema drift
    // (missing column after a recent migration) - this 'fallback row'
    // shouldn't fail because it uses fewer columns.
    try {
      await control.query(
        `INSERT INTO ai_usage_log (tenant_slug, call_kind, model, error_text)
         VALUES ($1, $2, $3, $4)`,
        [slug || '(unattributed)', call_kind || 'reply', '', 'logUsage_insert_failed: ' + e.message.slice(0, 300)]
      );
    } catch (_) { /* truly broken - give up */ }
  }
}


/**
 * Generate WITH function-calling. Loop until the model returns plain
 * text or hits maxTurns. Each loop, if Gemini wants to call a tool,
 * we invoke `runTool(name, args)` and feed the result back as the next
 * `functionResponse` in the conversation history.
 *
 * args:
 *   system, history, prompt — like generate()
 *   tools: [{ name, description, parameters }]  (Gemini schema)
 *   runTool: async (name, args) => any  (caller-provided)
 *   model:  override
 *   maxTurns: 6
 *
 * Returns: { ok, text, model, input_tokens, output_tokens, cost_*,
 *            tools_called: [{ name, args, result }], error }
 */
async function generateWithTools(args) {
  // Copilot calls this; pass feature='copilot' so it's allowed on demo tenants.
  // If caller forgot the feature label and we're on a demo tenant, default
  // to allow (Copilot is the primary user of this method — block-by-default
  // here would break Copilot when the label is missed).
  if (await _isDemoTenant()) {
    const feature = String((args && args.feature) || 'copilot').toLowerCase();
    if (!DEMO_ALLOWED_FEATURES.has(feature)) {
      return { ok: false, text: '', model: '', input_tokens: 0, output_tokens: 0,
               cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
               tools_called: [], error: 'This AI feature is disabled on showcase / demo tenants.' };
    }
  }
  const settings = await loadSettings();
  if (!settings) {
    return { ok: false, text: '', model: '', input_tokens: 0, output_tokens: 0,
             cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
             tools_called: [], error: 'AI is not configured.' };
  }
  const model = String(args.model || settings.defaultModel);
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
  const tools = (args.tools && args.tools.length)
    ? [{ functionDeclarations: args.tools }]
    : undefined;

  // Build the running contents array.
  const contents = [];
  (args.history || []).forEach(h => {
    if (!h || !h.text) return;
    contents.push({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text) }] });
  });
  contents.push({ role: 'user', parts: [{ text: String(args.prompt || '') }] });

  let inTok = 0, outTok = 0;
  const toolsCalled = [];
  const maxTurns = Math.max(1, Math.min(10, Number(args.maxTurns || 6)));
  let lastText = '';
  let lastFinish = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    const body = {
      contents,
      generationConfig: {
        temperature:     args.temperature != null ? Number(args.temperature) : 0.3,
        maxOutputTokens: Number(args.maxOutputTokens || 800),
      }
    };
    if (args.system) body.systemInstruction = { role: 'system', parts: [{ text: String(args.system) }] };
    if (tools) body.tools = tools;
    // Retry-with-backoff for transient errors (503 UNAVAILABLE, 429 RESOURCE_EXHAUSTED).
    // Gemini's flash models occasionally return 'currently experiencing high demand'
    // for a few seconds at peak. Three retries with exponential delay + jitter
    // typically converts 90%+ of these into successes. After all retries
    // exhausted, attempt ONE fallback to a more available sibling model
    // (flash-lite if we were on flash) before giving up.
    let resp, json;
    let triedFallback = false;
    let currentModel = model;
    let currentUrl = url;
    const MAX_RETRIES = 3;
    let attempt = 0;
    let retryLoopOk = false;
    while (!retryLoopOk) {
      try {
        resp = await fetch(currentUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        json = await resp.json();
      } catch (e) {
        return { ok: false, text: '', model: currentModel, input_tokens: inTok, output_tokens: outTok,
                 cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
                 tools_called: toolsCalled, error: 'Gemini network error: ' + e.message };
      }
      const errMsg = (json && json.error && json.error.message) || '';
      const isOverloaded = resp.status === 503 || resp.status === 429
                        || /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|rate.{0,5}limit/i.test(errMsg);
      if (resp.ok && !json.error) { retryLoopOk = true; break; }
      if (isOverloaded && attempt < MAX_RETRIES) {
        attempt++;
        const delay = (Math.pow(2, attempt) * 400) + Math.floor(Math.random() * 400);   // 800ms, 1.6s, 3.2s + 0-400ms jitter
        console.warn('[gemini] ' + resp.status + ' on ' + currentModel + ', retry ' + attempt + '/' + MAX_RETRIES + ' in ' + delay + 'ms — ' + errMsg.slice(0, 100));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      // Retries exhausted on a transient error → fallback to a sibling model once.
      if (isOverloaded && !triedFallback) {
        const fallbackModel = currentModel.includes('flash-lite') ? 'gemini-2.0-flash'
                            : currentModel.includes('flash')      ? 'gemini-2.0-flash-lite'
                            : null;
        if (fallbackModel) {
          triedFallback = true;
          currentModel = fallbackModel;
          currentUrl = `${GEMINI_BASE}/models/${encodeURIComponent(fallbackModel)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;
          attempt = 0;
          console.warn('[gemini] all retries exhausted on ' + model + ' — falling back to ' + fallbackModel);
          continue;
        }
      }
      // Non-retriable error, or fallback also failed.
      const userMsg = isOverloaded
        ? 'AI is busy right now (Gemini high-demand). Please try again in a moment.'
        : (errMsg || ('HTTP ' + resp.status));
      return { ok: false, text: '', model: currentModel, input_tokens: inTok, output_tokens: outTok,
               cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0,
               tools_called: toolsCalled, error: userMsg };
    }
    const cand = (json.candidates || [])[0] || {};
    lastFinish = cand.finishReason || null;
    const usage = json.usageMetadata || {};
    inTok  += Number(usage.promptTokenCount || 0);
    outTok += Number(usage.candidatesTokenCount || 0);

    const parts = (cand.content && cand.content.parts) || [];
    // Collect any function calls Gemini wants to make in this turn.
    const fnCalls = parts.filter(p => p.functionCall && p.functionCall.name).map(p => p.functionCall);
    if (fnCalls.length) {
      // Echo the model's call into history so subsequent turn sees it.
      contents.push({ role: 'model', parts: parts.filter(p => p.functionCall) });
      const fnResponses = [];
      for (const fc of fnCalls) {
        const name = String(fc.name);
        const a = (fc.args && typeof fc.args === 'object') ? fc.args : {};
        let result;
        try {
          result = await args.runTool(name, a);
        } catch (e) {
          result = { error: e.message };
        }
        toolsCalled.push({ name, args: a, result });
        fnResponses.push({
          functionResponse: { name, response: { content: result } }
        });
      }
      contents.push({ role: 'user', parts: fnResponses });
      continue;   // next turn — model will read tool results and decide
    }

    // No function calls — collect text.
    lastText = parts.map(p => p.text || '').filter(Boolean).join('').trim();
    break;
  }

  const costs = computeCost(inTok, outTok, settings);
  return {
    ok: true, text: lastText, model,
    input_tokens: inTok, output_tokens: outTok,
    cost_usd:        costs.cost_usd,
    cost_inr_real:   costs.cost_inr_real,
    cost_inr_billed: costs.cost_inr_billed,
    tools_called: toolsCalled,
    finish_reason: lastFinish,
    error: null,
  };
}

module.exports = { loadSettings, invalidateCache, generate, generateWithTools, logUsage, computeCost };
