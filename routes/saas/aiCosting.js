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

  const perTenant = await control.query(
    `SELECT
        COALESCE(NULLIF(tenant_slug, ''), '(unattributed)') AS tenant_slug,
        COUNT(*)::int                                         AS calls,
        SUM(input_tokens)::int                                AS input_tokens,
        SUM(output_tokens)::int                               AS output_tokens,
        SUM(cost_usd)                                         AS cost_usd,
        SUM(cost_inr_real)                                    AS cost_inr_real,
        SUM(cost_inr_billed)                                  AS cost_inr_billed,
        SUM(cost_inr_billed - cost_inr_real)                  AS margin_inr,
        SUM(CASE WHEN call_kind = 'reply' THEN cost_inr_billed ELSE 0 END) AS billed_replies,
        SUM(CASE WHEN call_kind = 'embed' THEN cost_inr_billed ELSE 0 END) AS billed_embed,
        SUM(CASE WHEN call_kind <> 'reply' AND call_kind <> 'embed' THEN cost_inr_billed ELSE 0 END) AS billed_other,
        MAX(created_at)                                       AS last_call_at
       FROM ai_usage_log
      WHERE ${where}
      GROUP BY tenant_slug
      ORDER BY cost_inr_billed DESC NULLS LAST`,
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
      WHERE created_at >= $1 AND created_at < $2 AND error_text IS NOT NULL`,
    [r.fromIso, r.toIso]
  );

  return {
    range: { from: r.fromDate, to: r.toDate },
    totals: {
      tenants_billed:    perTenant.rows.length,
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

module.exports = {
  api_saas_ai_costing_summary,
  api_saas_ai_costing_daily,
  api_saas_ai_costing_recent,
};
