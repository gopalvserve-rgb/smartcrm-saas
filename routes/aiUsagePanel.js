/**
 * routes/aiUsagePanel.js — AI_TENANT_PANEL_v1 (2026-09-06)
 *
 * Tenant-facing view of their own Gemini usage and what it costs them.
 *
 * The mirror of the super-admin AI Tokens screen, scoped to the caller's own
 * tenant and priced with THAT tenant's rate + markup. A tenant can see:
 *   - tokens used, split by service, over a date range
 *   - what it costs them (base + markup, shown as one number)
 *   - how close they are to their cap
 *   - their AI invoices, paid and pending, with due dates
 *
 * Usage rows live in the CONTROL database (ai_usage_log), not the tenant DB, so
 * every query here is hard-scoped by tenant_slug taken from the request's tenant
 * context — never from client input. A tenant must not be able to read another
 * tenant's usage by passing a slug.
 */
'use strict';

const control = require('../control/db');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const money = n => Number(Number(n || 0).toFixed(2));

/** Resolve the caller's tenant slug from the server-side tenant context ONLY. */
function _mySlug() {
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    if (store && store.slug) return String(store.slug);
  } catch (_) {}
  return '';
}

function _range(opts) {
  const o = opts || {};
  const to = o.to ? String(o.to) : new Date().toISOString().slice(0, 10);
  const from = o.from ? String(o.from) : to.slice(0, 8) + '01';
  return { from, to };
}

/**
 * api_ai_myUsage(token, { from, to })
 *   -> { range, slug, totals, by_service, cap, invoices_pending }
 */
async function api_ai_myUsage(token, opts) {
  await authUser(token);                     // any logged-in user of this tenant
  const slug = _mySlug();
  if (!slug) return { unavailable: true, reason: 'tenant context not resolved' };
  const r = _range(opts);

  const billing = require('./saas/aiBilling');
  let pol;
  try { pol = (await billing.loadPolicy()).for(slug); }
  catch (_) { pol = { rate_in: 0, rate_out: 0, markup_pct: 0, cap_inr: 0, blocked_at: null }; }

  const price = (i, o) => {
    const base = (Number(i || 0) / 1e5) * pol.rate_in + (Number(o || 0) / 1e5) * pol.rate_out;
    return money(base * (1 + Number(pol.markup_pct || 0) / 100));
  };

  const rows = (await control.query(
    `SELECT COALESCE(NULLIF(call_kind,''),'other') AS service,
            COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::bigint  AS i,
            COALESCE(SUM(output_tokens),0)::bigint AS o
       FROM ai_usage_log
      WHERE tenant_slug = $1 AND error_text IS NULL
        AND created_at >= $2::date AND created_at < ($3::date + 1)
      GROUP BY 1 ORDER BY 3 DESC`,
    [slug, r.from, r.to])).rows;

  const by_service = rows.map(x => ({
    service: x.service, calls: x.calls,
    input_tokens: Number(x.i), output_tokens: Number(x.o),
    total_tokens: Number(x.i) + Number(x.o),
    cost_inr: price(x.i, x.o)
  }));
  const totals = by_service.reduce((a, s) => {
    a.calls += s.calls; a.input_tokens += s.input_tokens;
    a.output_tokens += s.output_tokens; a.total_tokens += s.total_tokens;
    a.cost_inr = money(a.cost_inr + s.cost_inr); return a;
  }, { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_inr: 0 });

  // Unbilled-to-date vs the cap, so the tenant can see a charge coming.
  let cap = { cap_inr: pol.cap_inr || 0, unbilled_inr: 0, pct: null };
  try {
    const u = await billing.unbilledFor(slug);
    cap.unbilled_inr = price(u.input_tokens, u.output_tokens);
    cap.pct = cap.cap_inr > 0 ? Number((100 * cap.unbilled_inr / cap.cap_inr).toFixed(1)) : null;
  } catch (_) {}

  let invoices_pending = 0, overdue = false;
  try {
    const inv = (await control.query(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE due_at < NOW())::int AS od
         FROM ai_invoices WHERE tenant_slug = $1 AND status = 'pending'`, [slug])).rows[0];
    invoices_pending = Number(inv.n || 0);
    overdue = Number(inv.od || 0) > 0;
  } catch (_) {}

  return {
    range: r, slug, totals, by_service, cap,
    rate: { in_per_lakh: pol.rate_in, out_per_lakh: pol.rate_out, markup_pct: pol.markup_pct },
    invoices_pending, overdue,
    ai_blocked: !!pol.blocked_at
  };
}

/** api_ai_myInvoices(token) — this tenant's AI invoices, newest first. */
async function api_ai_myInvoices(token) {
  await authUser(token);
  const slug = _mySlug();
  if (!slug) return { invoices: [] };
  try {
    const rows = (await control.query(
      `SELECT id, period_from, period_to, calls, input_tokens, output_tokens,
              base_inr, markup_pct, markup_inr, total_inr, status, due_at,
              generated_at, paid_at,
              (status = 'pending' AND due_at < NOW()) AS is_overdue
         FROM ai_invoices WHERE tenant_slug = $1
        ORDER BY generated_at DESC LIMIT 60`, [slug])).rows;
    return { invoices: rows };
  } catch (_) { return { invoices: [] }; }
}

module.exports = { api_ai_myUsage, api_ai_myInvoices };
