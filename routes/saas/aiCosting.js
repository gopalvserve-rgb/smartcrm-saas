/**
 * routes/saas/aiCosting.js
 *
 * Super-admin "AI Costing" board.  Aggregates rows from
 * control.ai_usage_log to show, per tenant, over a date range:
 *
 *   - total Gemini calls
 *   - total input + output tokens
 *   - real Google cost in USD
 *   - real cost in INR (cost_usd × exchange rate at call time)
 *   - billed-to-tenant INR (real INR + markup)
 *   - your margin in INR (billed − real)
 *   - cost split by call_kind (reply vs embed vs crawl_summarize)
 *
 * Endpoints (all super-admin):
 *
 *   api_saas_ai_costing_summary(token, opts)
 *     opts.from, opts.to     ISO date strings (default = month-to-date)
 *     opts.tenant_slug?      filter to one tenant
 *
 *   api_saas_ai_costing_daily(token, opts)
 *     time-series chart data (one row per day across the range)
 *
 *   api_saas_ai_costing_recent(token, opts)
 *     last 100 raw rows for drill-down
 *
 * The "tenant" view (tenants see their own marked-up usage in INR
 * without the real-cost / margin columns) lives on a per-tenant
 * route — routes/aiBot.js → api_ai_usage_summary.
 */

'use strict';

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

function _parseRange(opts) {
  const o = opts || {};
  let from = o.from ? new Date(String(o.from)) : null;
  let to   = o.to   ? new Date(String(o.to))   : null;
  if (!from || isNaN(from.getTime())) {
    // Default = first of current month, in UTC. Cheap, predictable.
    const now = new Date();
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
  if (!to || isNaN(to.getTime())) {
    to = new Date();
  }
  return {
    fromIso: from.toISOString(),
    toIso:   to.toISOString(),
    fromDate: from.toISOString().slice(0, 10),
    toDate:   to.toISOString().slice(0, 10),
  };
}

async function api_saas_ai_costing_summary(token, opts) {
  await requireSuperAdmin(token);
  const r = _parseRange(opts);
  const tenantFilter = (opts && opts.tenant_slug) ? String(opts.tenant_slug) : null;

  // ---- Per-tenant rollup ----
  const params = [r.fromIso, r.toIso];
  let where = `created_at >= $1 AND created_at < $2 AND error_text IS NULL`;
  if (tenantFilter) { params.push(tenantFilter); where += ` AND tenant_slug = $${params.length}`; }

  // Per-tenant aggregate. Counts BOTH successful (cost > 0, error_text IS NULL)
  // and failed (error_text IS NOT NULL) calls, in two separate columns, so the
  // dashboard reveals tenants that ARE calling Gemini but always erroring out
  // (bad key, quota, etc.) - previously these tenants vanished entirely
  // because the WHERE filter dropped any row with error_text.
  const perTenant = await control.query(
    `SELECT
        COALESCE(NULLIF(tenant_slug, ''), '(unattributed)') AS tenant_slug,
        COUNT(*) FILTER (WHERE error_text IS NULL)::int       AS calls,
        /* AI_NOISE_FILTER_v1 (2026-09-05) — exclude the metering-bug rows.
         * Until AI_AUTOLOG_v1, copilotProactive + leadQuickNote called logUsage
         * with flat fields instead of a result object, so the guard wrote a zero-token
         * row stamped with this error. 67,108 of them existed, which made this
         * dashboard report a ~73% failure rate when real Gemini failures were a
         * few hundred. They are logging artefacts, not failed AI calls. */
        COUNT(*) FILTER (WHERE error_text IS NOT NULL
                           AND error_text <> 'logUsage called without a result object')::int AS failed_calls,
        COUNT(*) FILTER (WHERE error_text = 'logUsage called without a result object')::int AS unmetered_calls,
        COALESCE(SUM(input_tokens) FILTER (WHERE error_text IS NULL), 0)::int    AS input_tokens,
        COALESCE(SUM(output_tokens) FILTER (WHERE error_text IS NULL), 0)::int   AS output_tokens,
        COALESCE(SUM(cost_usd) FILTER (WHERE error_text IS NULL), 0)             AS cost_usd,
        COALESCE(SUM(cost_inr_real) FILTER (WHERE error_text IS NULL), 0)        AS cost_inr_real,
        COALESCE(SUM(cost_inr_billed) FILTER (WHERE error_text IS NULL), 0)      AS cost_inr_billed,
        COALESCE(SUM(cost_inr_billed - cost_inr_real) FILTER (WHERE error_text IS NULL), 0) AS margin_inr,
        COALESCE(SUM(CASE WHEN call_kind = 'reply' THEN cost_inr_billed ELSE 0 END) FILTER (WHERE error_text IS NULL), 0) AS billed_replies,
        COALESCE(SUM(CASE WHEN call_kind = 'embed' THEN cost_inr_billed ELSE 0 END) FILTER (WHERE error_text IS NULL), 0) AS billed_embed,
        COALESCE(SUM(CASE WHEN call_kind <> 'reply' AND call_kind <> 'embed' THEN cost_inr_billed ELSE 0 END) FILTER (WHERE error_text IS NULL), 0) AS billed_other,
        MAX(created_at)                                       AS last_call_at,
        MAX(error_text) FILTER (WHERE error_text IS NOT NULL) AS last_error
       FROM ai_usage_log
      WHERE created_at >= $1 AND created_at < $2${tenantFilter ? ' AND tenant_slug = $3' : ''}
      GROUP BY COALESCE(NULLIF(tenant_slug, ''), '(unattributed)')
      ORDER BY cost_inr_billed DESC NULLS LAST, failed_calls DESC NULLS LAST`,
    params
  );

  // ---- Totals + active-tenant ratio ----
  const totals = perTenant.rows.reduce((a, x) => {
    a.calls            += Number(x.calls || 0);
    a.input_tokens     += Number(x.input_tokens || 0);
    a.output_tokens    += Number(x.output_tokens || 0);
    a.cost_usd         += Number(x.cost_usd || 0);
    a.cost_inr_real    += Number(x.cost_inr_real || 0);
    a.cost_inr_billed  += Number(x.cost_inr_billed || 0);
    a.margin_inr       += Number(x.margin_inr || 0);
    return a;
  }, { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, cost_inr_real: 0, cost_inr_billed: 0, margin_inr: 0 });

  // ---- Failure count (informational; not billed) ----
  const failsRes = await control.query(
    `SELECT COUNT(*)::int AS fails
       FROM ai_usage_log
      WHERE created_at >= $1 AND created_at < $2 AND error_text IS NOT NULL
        AND error_text <> 'logUsage called without a result object'`,   /* AI_NOISE_FILTER_v1 */
    [r.fromIso, r.toIso]
  );

  return {
    range: { from: r.fromDate, to: r.toDate },
    totals: {
      tenants_billed:    perTenant.rows.filter(x => Number(x.calls || 0) > 0).length,
      tenants_with_failures: perTenant.rows.filter(x => Number(x.failed_calls || 0) > 0).length,
      calls:             totals.calls,
      input_tokens:      totals.input_tokens,
      output_tokens:     totals.output_tokens,
      cost_usd:          Number(totals.cost_usd.toFixed(6)),
      cost_inr_real:     Number(totals.cost_inr_real.toFixed(2)),
      cost_inr_billed:   Number(totals.cost_inr_billed.toFixed(2)),
      margin_inr:        Number(totals.margin_inr.toFixed(2)),
      margin_pct:        totals.cost_inr_real > 0
                          ? Number((totals.margin_inr / totals.cost_inr_real * 100).toFixed(1))
                          : null,
      failed_calls:      Number(failsRes.rows[0]?.fails || 0),
    },
    per_tenant: perTenant.rows.map(x => ({
      tenant_slug:       x.tenant_slug,
      calls:             Number(x.calls || 0),
      failed_calls:      Number(x.failed_calls || 0),
      unmetered_calls:   Number(x.unmetered_calls || 0),   /* AI_NOISE_FILTER_v1 */
      input_tokens:      Number(x.input_tokens || 0),
      output_tokens:     Number(x.output_tokens || 0),
      cost_usd:          Number(Number(x.cost_usd || 0).toFixed(6)),
      cost_inr_real:     Number(Number(x.cost_inr_real || 0).toFixed(2)),
      cost_inr_billed:   Number(Number(x.cost_inr_billed || 0).toFixed(2)),
      margin_inr:        Number(Number(x.margin_inr || 0).toFixed(2)),
      billed_replies:    Number(Number(x.billed_replies || 0).toFixed(2)),
      billed_embed:      Number(Number(x.billed_embed || 0).toFixed(2)),
      billed_other:      Number(Number(x.billed_other || 0).toFixed(2)),
      last_call_at:      x.last_call_at,
      last_error:        x.last_error || null,
    })),
  };
}

async function api_saas_ai_costing_daily(token, opts) {
  await requireSuperAdmin(token);
  const r = _parseRange(opts);
  const tenantFilter = (opts && opts.tenant_slug) ? String(opts.tenant_slug) : null;
  const params = [r.fromIso, r.toIso];
  let where = `created_at >= $1 AND created_at < $2 AND error_text IS NULL`;
  if (tenantFilter) { params.push(tenantFilter); where += ` AND tenant_slug = $${params.length}`; }
  const dayRes = await control.query(
    `SELECT DATE_TRUNC('day', created_at)::date AS day,
            COUNT(*)::int AS calls,
            SUM(cost_inr_real)   AS cost_inr_real,
            SUM(cost_inr_billed) AS cost_inr_billed
       FROM ai_usage_log
      WHERE ${where}
      GROUP BY 1
      ORDER BY 1 ASC`,
    params
  );
  return {
    range: { from: r.fromDate, to: r.toDate },
    series: dayRes.rows.map(x => ({
      day: x.day,
      calls: Number(x.calls || 0),
      cost_inr_real:   Number(Number(x.cost_inr_real   || 0).toFixed(2)),
      cost_inr_billed: Number(Number(x.cost_inr_billed || 0).toFixed(2)),
    }))
  };
}

async function api_saas_ai_costing_recent(token, opts) {
  await requireSuperAdmin(token);
  const tenantFilter = (opts && opts.tenant_slug) ? String(opts.tenant_slug) : null;
  const params = [];
  let where = '1 = 1';
  if (tenantFilter) { params.push(tenantFilter); where += ` AND tenant_slug = $${params.length}`; }
  const r = await control.query(
    `SELECT id, tenant_slug, call_kind, model, input_tokens, output_tokens,
            cost_usd, cost_inr_real, cost_inr_billed, phone, lead_id,
            error_text, created_at
       FROM ai_usage_log
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT 100`,
    params
  );
  return r.rows.map(x => ({
    id: x.id, tenant_slug: x.tenant_slug, call_kind: x.call_kind, model: x.model,
    input_tokens: Number(x.input_tokens || 0),
    output_tokens: Number(x.output_tokens || 0),
    cost_usd:        Number(Number(x.cost_usd || 0).toFixed(6)),
    cost_inr_real:   Number(Number(x.cost_inr_real || 0).toFixed(4)),
    cost_inr_billed: Number(Number(x.cost_inr_billed || 0).toFixed(4)),
    phone: x.phone, lead_id: x.lead_id,
    error_text: x.error_text || null,
    created_at: x.created_at,
  }));
}


/* ── AI_DIAG_v1 (2026-07-11) ──────────────────────────────────────────────
 * "AI is busy right now (Gemini high-demand)" is a CATCH-ALL: geminiClient
 * raises it for 503 (Google overloaded) AND 429 / RESOURCE_EXHAUSTED (YOUR key
 * is out of quota / rate-limited). Those need opposite fixes, so this endpoint
 * pings Gemini directly and hands back the RAW status + reason.
 *   api_saas_ai_diag(token)  -> { ok, http_status, gemini_status, raw_error, model, key_source }
 * Plus api_saas_ai_recentErrors(token) -> the last failures from ai_usage_log.
 */
async function api_saas_ai_diag(token) {
  await requireSuperAdmin(token);
  const gemini = require('../../utils/geminiClient');
  let settings = null;
  try { settings = await gemini.loadSettings(true); } catch (e) {
    return { ok: false, stage: 'load_settings', raw_error: e.message };
  }
  if (!settings || !settings.apiKey) {
    return { ok: false, stage: 'no_key', raw_error: 'No Gemini API key configured (ai_settings.gemini_api_key_enc / GEMINI_API_KEY env).' };
  }
  const model = settings.model || 'gemini-3.1-flash-lite';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(settings.apiKey);
  let resp, json;
  try {
    resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
                             generationConfig: { maxOutputTokens: 5 } })
    });
    json = await resp.json();
  } catch (e) {
    return { ok: false, stage: 'network', model, raw_error: 'Network error: ' + e.message };
  }
  const err = json && json.error;
  return {
    ok: !!(resp.ok && !err),
    stage: 'gemini_call',
    model,
    http_status: resp.status,
    gemini_status: err ? (err.status || '') : '',
    gemini_code: err ? (err.code || '') : '',
    raw_error: err ? String(err.message || '').slice(0, 600) : '',
    key_tail: '…' + String(settings.apiKey).slice(-4),
    hint: !err ? 'Gemini answered fine — the key + model are healthy right now.'
        : /RESOURCE_EXHAUSTED|quota|rate/i.test(String(err.status) + String(err.message))
          ? 'QUOTA / RATE LIMIT on your API key — not Google being busy. Raise the quota or switch to a paid key.'
        : /UNAVAILABLE|overloaded/i.test(String(err.status) + String(err.message))
          ? 'Google-side overload (503). Transient — retries/fallback should absorb it.'
        : /API_KEY_INVALID|PERMISSION_DENIED/i.test(String(err.status) + String(err.message))
          ? 'The API key is invalid or lacks permission for this model.'
        : /NOT_FOUND/i.test(String(err.status) + String(err.message))
          ? 'The configured model name does not exist / was retired.'
          : 'See raw_error.'
  };
}

async function api_saas_ai_recentErrors(token, opts) {
  await requireSuperAdmin(token);
  const o = opts || {};
  const lim = Math.min(200, Math.max(1, Number(o.limit) || 50));
  const r = await control.query(
    `SELECT created_at, tenant_slug, call_kind, model, error_text
       FROM ai_usage_log
      WHERE error_text IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${lim}`
  );
  const byReason = {};
  r.rows.forEach(x => {
    const k = String(x.error_text || '').split(' :: ')[0];
    byReason[k] = (byReason[k] || 0) + 1;
  });
  return { rows: r.rows, by_reason: byReason, count: r.rows.length };
}


/**
 * AI_TOKENS_BY_SERVICE_v1 (2026-09-05)
 *
 * Tenant-wise token usage broken down by service, for the super-admin
 * "AI Tokens" view. Pure token accounting - no pricing, no markup.
 *
 * The numbers are Gemini's own usageMetadata (promptTokenCount /
 * candidatesTokenCount) recorded per call, verified against the per-tenant
 * ai_chat_log / crm_copilot_log / lead_recordings tables: they agreed to
 * within 0.03% for August 2026, so this is the authoritative token source.
 *
 * Rows carrying error_text are excluded from token sums - a failed call
 * returns no usageMetadata, so it contributes nothing to spend.
 *
 *   api_saas_ai_tokens_summary(token, { from, to, tenant_slug? })
 *     -> { range, totals, per_tenant:[{ tenant_slug, input_tokens,
 *          output_tokens, total_tokens, calls, services:[{ call_kind,
 *          calls, input_tokens, output_tokens, total_tokens }] }] }
 */
async function api_saas_ai_tokens_summary(token, opts) {
  await requireSuperAdmin(token);
  const r = _parseRange(opts);
  const params = [r.fromIso, r.toIso];
  let extra = '';
  if (opts && opts.tenant_slug) { params.push(String(opts.tenant_slug)); extra = ' AND tenant_slug = $3'; }

  const res = await control.query(
    `SELECT COALESCE(NULLIF(tenant_slug, ''), '(unattributed)') AS tenant_slug,
            COALESCE(NULLIF(call_kind, ''), 'other')            AS call_kind,
            COUNT(*)::int                            AS calls,
            COALESCE(SUM(input_tokens), 0)::bigint   AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::bigint  AS output_tokens
       FROM ai_usage_log
      WHERE created_at >= $1 AND created_at < $2
        AND error_text IS NULL` + extra + `
      GROUP BY 1, 2
      ORDER BY 1, 5 DESC`,
    params
  );

  const byTenant = new Map();
  for (const x of res.rows) {
    const inTok = Number(x.input_tokens || 0), outTok = Number(x.output_tokens || 0);
    if (!byTenant.has(x.tenant_slug)) {
      byTenant.set(x.tenant_slug, {
        tenant_slug: x.tenant_slug, calls: 0,
        input_tokens: 0, output_tokens: 0, total_tokens: 0, services: []
      });
    }
    const t = byTenant.get(x.tenant_slug);
    t.calls         += Number(x.calls || 0);
    t.input_tokens  += inTok;
    t.output_tokens += outTok;
    t.total_tokens  += inTok + outTok;
    t.services.push({
      call_kind:     x.call_kind,
      calls:         Number(x.calls || 0),
      input_tokens:  inTok,
      output_tokens: outTok,
      total_tokens:  inTok + outTok
    });
  }
  const per_tenant = [...byTenant.values()].sort((a, b) => b.total_tokens - a.total_tokens);

  const totals = per_tenant.reduce((a, t) => {
    a.calls += t.calls; a.input_tokens += t.input_tokens;
    a.output_tokens += t.output_tokens; a.total_tokens += t.total_tokens; return a;
  }, { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 });

  // Platform-wide per-service rollup, for the summary strip above the table.
  const byService = new Map();
  per_tenant.forEach(t => t.services.forEach(sv => {
    const cur = byService.get(sv.call_kind) ||
                { call_kind: sv.call_kind, calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    cur.calls += sv.calls; cur.input_tokens += sv.input_tokens;
    cur.output_tokens += sv.output_tokens; cur.total_tokens += sv.total_tokens;
    byService.set(sv.call_kind, cur);
  }));

  return {
    range: { from: r.fromDate, to: r.toDate },
    totals,
    tenants: per_tenant.length,
    by_service: [...byService.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    per_tenant
  };
}

module.exports = {
  api_saas_ai_costing_summary,
  api_saas_ai_costing_daily,
  api_saas_ai_costing_recent,
  api_saas_ai_diag,
  api_saas_ai_recentErrors,
  api_saas_ai_tokens_summary   /* AI_TOKENS_BY_SERVICE_v1 */
};
