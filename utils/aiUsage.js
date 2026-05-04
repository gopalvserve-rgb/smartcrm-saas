/**
 * utils/aiUsage.js
 *
 * Per-tenant AI usage + cost reporting helpers.
 *
 *   Each tenant deploys its own Postgres on Railway, so tenant
 *   isolation is automatic — every recording row belongs to one
 *   tenant only. Aggregating lead_recordings by month / user gives
 *   us a billable usage report per client without ever touching
 *   Google's billing console.
 *
 * Pricing model:
 *   - Vendor cost (raw Gemini cost) is stored on each recording row
 *     when it gets processed: ai_cost_usd, ai_cost_inr.
 *   - We bill the client at vendor cost × markup. Markup defaults to
 *     30% (configurable per tenant via AI_PRICE_MARKUP env / config).
 *   - Estimator endpoint converts an "X minutes of audio" forecast
 *     into a billable amount using the same model.
 *
 * Functions exposed via the /api dispatcher (api_*):
 *   - api_reports_aiUsage(filters)      → total + by-rep + by-day
 *   - api_reports_aiCostEstimator(mins) → "what does N minutes cost?"
 */

const db = require('../db/pg');
const { authUser } = require('./auth');

const GEMINI_INPUT_USD_PER_M  = 0.30;   // Gemini 2.5 Flash audio/text input
const GEMINI_OUTPUT_USD_PER_M = 2.50;   // Gemini 2.5 Flash text output
const AUDIO_TOKENS_PER_SECOND = 32;     // Gemini audio tokenisation rate
const DEFAULT_MARKUP          = 1.30;   // 30% markup over vendor cost

async function _markup() {
  // Per-tenant markup multiplier. Default 1.30 (= 30% markup).
  // Set to 1.0 to bill at-cost; higher to charge more.
  try {
    const cfg = await db.getConfig('AI_PRICE_MARKUP', '');
    const f = Number(cfg);
    if (Number.isFinite(f) && f >= 1 && f <= 3) return f;
  } catch (_) {}
  const env = Number(process.env.AI_PRICE_MARKUP);
  if (Number.isFinite(env) && env >= 1 && env <= 3) return env;
  return DEFAULT_MARKUP;
}

async function _usdToInr() {
  const env = Number(process.env.USD_TO_INR_RATE);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const cfg = await db.getConfig('USD_TO_INR_RATE', '');
    const f = Number(cfg);
    if (Number.isFinite(f) && f > 0) return f;
  } catch (_) {}
  return 84;
}

/**
 * Aggregate AI usage for the tenant. Returns:
 *   {
 *     scope: 'tenant',
 *     month: '2026-05',
 *     this_month: { calls, processed, audio_minutes, input_tokens,
 *                   output_tokens, cost_usd, cost_inr_at_cost,
 *                   cost_inr_billable, markup },
 *     all_time:   { same shape },
 *     by_user:    [{ user_id, user_name, calls, audio_minutes, cost_inr_billable }],
 *     by_day:     [{ day, calls, cost_inr_billable }],   // last 30 days
 *     pricing:    { input_usd_per_m, output_usd_per_m, usd_to_inr, markup }
 *   }
 */
async function api_reports_aiUsage(token, filters) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) {
    throw new Error('Only admins and managers can see AI usage');
  }
  const markup = await _markup();
  const usdInr = await _usdToInr();
  const month = (new Date()).toISOString().slice(0, 7);
  const monthStart = month + '-01';

  // Single round-trip with multiple aggregates via FILTER clauses.
  const sql = `
    WITH src AS (
      SELECT lr.user_id, u.name AS user_name,
             lr.duration_s, lr.ai_input_tokens, lr.ai_output_tokens,
             lr.ai_cost_usd, lr.ai_cost_inr,
             lr.ai_processed_at, lr.created_at
        FROM lead_recordings lr
        LEFT JOIN users u ON u.id = lr.user_id
       WHERE lr.ai_provider IN ('gemini', 'gemini-demo')
    )
    SELECT
      COUNT(*)                                    AS all_calls,
      COUNT(ai_processed_at)                      AS all_processed,
      COALESCE(SUM(duration_s),0)                 AS all_audio_s,
      COALESCE(SUM(ai_input_tokens),0)            AS all_in_tokens,
      COALESCE(SUM(ai_output_tokens),0)           AS all_out_tokens,
      COALESCE(SUM(ai_cost_usd),0)                AS all_cost_usd,
      COALESCE(SUM(ai_cost_inr),0)                AS all_cost_inr,
      COUNT(*)            FILTER (WHERE ai_processed_at >= $1) AS m_calls,
      COALESCE(SUM(duration_s)        FILTER (WHERE ai_processed_at >= $1),0) AS m_audio_s,
      COALESCE(SUM(ai_input_tokens)   FILTER (WHERE ai_processed_at >= $1),0) AS m_in_tokens,
      COALESCE(SUM(ai_output_tokens)  FILTER (WHERE ai_processed_at >= $1),0) AS m_out_tokens,
      COALESCE(SUM(ai_cost_usd)       FILTER (WHERE ai_processed_at >= $1),0) AS m_cost_usd,
      COALESCE(SUM(ai_cost_inr)       FILTER (WHERE ai_processed_at >= $1),0) AS m_cost_inr
    FROM src;
  `;
  let totals;
  try {
    const { rows } = await db.query(sql, [monthStart]);
    totals = rows[0] || {};
  } catch (e) {
    if (/column .* does not exist/i.test(e.message)) {
      return { error: 'Cost columns not migrated yet — restart the service to apply schema.' };
    }
    throw e;
  }

  const round = n => Math.round(Number(n) * 100) / 100;
  const fmt = (usd, inr) => ({
    cost_usd:           round(usd),
    cost_inr_at_cost:   round(inr),
    cost_inr_billable:  round(inr * markup)
  });

  const this_month = Object.assign({
    calls: Number(totals.m_calls) || 0,
    audio_minutes: Math.round((Number(totals.m_audio_s) || 0) / 60),
    input_tokens:  Number(totals.m_in_tokens) || 0,
    output_tokens: Number(totals.m_out_tokens) || 0,
    markup
  }, fmt(totals.m_cost_usd, totals.m_cost_inr));

  const all_time = Object.assign({
    calls:     Number(totals.all_calls) || 0,
    processed: Number(totals.all_processed) || 0,
    audio_minutes: Math.round((Number(totals.all_audio_s) || 0) / 60),
    input_tokens:  Number(totals.all_in_tokens) || 0,
    output_tokens: Number(totals.all_out_tokens) || 0,
    markup
  }, fmt(totals.all_cost_usd, totals.all_cost_inr));

  // By-user breakdown for this month
  const userSql = `
    SELECT lr.user_id, u.name AS user_name,
           COUNT(*) AS calls,
           COALESCE(SUM(lr.duration_s),0) AS audio_s,
           COALESCE(SUM(lr.ai_cost_usd),0) AS cost_usd,
           COALESCE(SUM(lr.ai_cost_inr),0) AS cost_inr
      FROM lead_recordings lr
      LEFT JOIN users u ON u.id = lr.user_id
     WHERE lr.ai_processed_at >= $1
       AND lr.ai_provider IN ('gemini', 'gemini-demo')
     GROUP BY lr.user_id, u.name
     ORDER BY cost_inr DESC NULLS LAST
  `;
  const { rows: userRows } = await db.query(userSql, [monthStart]).catch(() => ({ rows: [] }));
  const by_user = userRows.map(r => ({
    user_id: r.user_id,
    user_name: r.user_name || '(unknown)',
    calls: Number(r.calls),
    audio_minutes: Math.round((Number(r.audio_s) || 0) / 60),
    cost_usd: round(r.cost_usd),
    cost_inr_at_cost: round(r.cost_inr),
    cost_inr_billable: round(Number(r.cost_inr) * markup)
  }));

  // Last 30 days
  const daySql = `
    SELECT DATE(ai_processed_at) AS day,
           COUNT(*) AS calls,
           COALESCE(SUM(ai_cost_inr),0) AS cost_inr
      FROM lead_recordings
     WHERE ai_processed_at >= NOW() - INTERVAL '30 days'
       AND ai_provider IN ('gemini', 'gemini-demo')
     GROUP BY DATE(ai_processed_at)
     ORDER BY day DESC
  `;
  const { rows: dayRows } = await db.query(daySql, []).catch(() => ({ rows: [] }));
  const by_day = dayRows.map(r => ({
    day: r.day,
    calls: Number(r.calls),
    cost_inr_billable: round(Number(r.cost_inr) * markup)
  }));

  // Forecast: average daily run-rate (last 7 days) × 30 days
  let forecast_inr = 0;
  if (by_day.length > 0) {
    const last7 = by_day.slice(0, 7);
    const dailyAvg = last7.reduce((s, d) => s + d.cost_inr_billable, 0) / Math.max(1, last7.length);
    forecast_inr = round(dailyAvg * 30);
  }

  return {
    scope: 'tenant',
    month,
    this_month,
    all_time,
    forecast_monthly_inr: forecast_inr,
    by_user,
    by_day,
    pricing: {
      model: 'gemini-2.5-flash',
      input_usd_per_m:  GEMINI_INPUT_USD_PER_M,
      output_usd_per_m: GEMINI_OUTPUT_USD_PER_M,
      audio_tokens_per_second: AUDIO_TOKENS_PER_SECOND,
      usd_to_inr: usdInr,
      markup
    }
  };
}

/**
 * Cost estimator — "what does N minutes of transcription cost?"
 * Returns vendor cost and billable cost (with markup) for the given
 * minutes of audio. Assumes ~700 output tokens per call summary
 * (empirical avg from real calls).
 */
async function api_reports_aiCostEstimator(token, opts) {
  await authUser(token);
  opts = opts || {};
  const minutes = Math.max(0, Number(opts.minutes) || 100);
  const avgCallMin = Math.max(0.5, Number(opts.avgCallMinutes) || 5);
  const calls = Math.max(1, Math.round(minutes / avgCallMin));
  const outTokensPerCall = Number(opts.outTokensPerCall) || 700;

  const audioTokens = minutes * 60 * AUDIO_TOKENS_PER_SECOND;
  const outputTokens = calls * outTokensPerCall;

  const inputUsd  = audioTokens   / 1_000_000 * GEMINI_INPUT_USD_PER_M;
  const outputUsd = outputTokens  / 1_000_000 * GEMINI_OUTPUT_USD_PER_M;
  const totalUsd  = inputUsd + outputUsd;

  const usdInr = await _usdToInr();
  const markup = await _markup();
  const totalInrAtCost   = totalUsd * usdInr;
  const totalInrBillable = totalInrAtCost * markup;

  const round = n => Math.round(Number(n) * 100) / 100;

  return {
    minutes,
    calls,
    avg_call_minutes: avgCallMin,
    audio_tokens: audioTokens,
    output_tokens: outputTokens,
    cost_usd:           round(totalUsd),
    cost_inr_at_cost:   round(totalInrAtCost),
    cost_inr_billable:  round(totalInrBillable),
    per_minute_inr_billable: round(totalInrBillable / Math.max(1, minutes)),
    per_call_inr_billable:   round(totalInrBillable / Math.max(1, calls)),
    pricing: {
      model: 'gemini-2.5-flash',
      input_usd_per_m:  GEMINI_INPUT_USD_PER_M,
      output_usd_per_m: GEMINI_OUTPUT_USD_PER_M,
      audio_tokens_per_second: AUDIO_TOKENS_PER_SECOND,
      usd_to_inr: usdInr,
      markup
    },
    examples: [
      { label: '100 min',  ...await _quickQuote(100,  avgCallMin, usdInr, markup) },
      { label: '500 min',  ...await _quickQuote(500,  avgCallMin, usdInr, markup) },
      { label: '2,000 min',...await _quickQuote(2000, avgCallMin, usdInr, markup) },
      { label: '10,000 min',...await _quickQuote(10000, avgCallMin, usdInr, markup) }
    ]
  };
}

async function _quickQuote(mins, avgCallMin, usdInr, markup) {
  const calls = Math.max(1, Math.round(mins / avgCallMin));
  const audioTokens = mins * 60 * AUDIO_TOKENS_PER_SECOND;
  const outputTokens = calls * 700;
  const usd = audioTokens / 1_000_000 * GEMINI_INPUT_USD_PER_M
            + outputTokens / 1_000_000 * GEMINI_OUTPUT_USD_PER_M;
  const inr = usd * usdInr;
  const round = n => Math.round(Number(n) * 100) / 100;
  return {
    cost_usd: round(usd),
    cost_inr_at_cost: round(inr),
    cost_inr_billable: round(inr * markup)
  };
}

module.exports = { api_reports_aiUsage, api_reports_aiCostEstimator };
