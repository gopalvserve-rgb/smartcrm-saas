/**
 * routes/saas/aiBilling.js — AI_BILLING_v1 (2026-09-06)
 *
 * Threshold-triggered billing for Gemini token usage.
 *
 * THE MODEL
 *   Each tenant accrues billable AI usage. When the unbilled amount crosses that
 *   tenant's cap, we raise an invoice for the period, give them `grace_days` to
 *   pay, and if it is still unpaid after that we BLOCK AI FEATURES ONLY — the CRM
 *   itself keeps working. Losing the AI bot is a proportionate consequence for an
 *   unpaid AI bill; locking a sales team out of their leads over a few hundred
 *   rupees is not.
 *
 * PRICE = BASE + MARKUP
 *   base   = (input_tokens / 1e5 * rate_in) + (output_tokens / 1e5 * rate_out)
 *   markup = base * markup_pct / 100
 *   total  = base + markup
 *   Rates come from AI_TOKEN_RATE_v1 (global, or a per-tenant override).
 *   Markup is per-tenant, falling back to a global default.
 *
 * PERIODS
 *   A tenant's next billing period starts where its last non-cancelled invoice
 *   ended, so periods tile without gaps or overlap. Cancelling an invoice
 *   releases its period to be re-billed. We deliberately do NOT store a
 *   watermark column — deriving it from MAX(period_to) cannot drift out of sync
 *   with the invoices themselves.
 *
 * WHY AMOUNTS ARE FROZEN ON THE INVOICE
 *   Unlike the usage REPORT (which re-prices live so a rate change re-prices
 *   history), an invoice records base/markup/total as issued. An invoice is a
 *   commercial document — it must not silently change value after you send it.
 */
'use strict';

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

const money = n => Number(Number(n || 0).toFixed(2));

/* ------------------------------------------------------------------ *
 * Schema — additive, idempotent, guarded (same pattern as callEventCols)
 * ------------------------------------------------------------------ */
let _colsDone = false;
async function ensureSchema() {
  if (_colsDone) return;
  await control.query(
    `ALTER TABLE ai_settings
       ADD COLUMN IF NOT EXISTS default_markup_pct DECIMAL(6,2)  NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS default_cap_inr    DECIMAL(12,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS grace_days         INTEGER       NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS gst_percent        DECIMAL(5,2)  NOT NULL DEFAULT 18.00`);
  await control.query(
    `ALTER TABLE tenants
       ADD COLUMN IF NOT EXISTS ai_markup_pct DECIMAL(6,2),
       ADD COLUMN IF NOT EXISTS ai_cap_inr    DECIMAL(12,2),
       ADD COLUMN IF NOT EXISTS ai_blocked_at TIMESTAMPTZ`);
  await control.query(
    `CREATE TABLE IF NOT EXISTS ai_invoices (
       id             SERIAL PRIMARY KEY,
       tenant_id      INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
       tenant_slug    TEXT NOT NULL,
       period_from    TIMESTAMPTZ NOT NULL,
       period_to      TIMESTAMPTZ NOT NULL,
       calls          INTEGER NOT NULL DEFAULT 0,
       input_tokens   BIGINT  NOT NULL DEFAULT 0,
       output_tokens  BIGINT  NOT NULL DEFAULT 0,
       rate_in        DECIMAL(10,4) NOT NULL DEFAULT 0,
       rate_out       DECIMAL(10,4) NOT NULL DEFAULT 0,
       base_inr       DECIMAL(12,2) NOT NULL DEFAULT 0,
       markup_pct     DECIMAL(6,2)  NOT NULL DEFAULT 0,
       markup_inr     DECIMAL(12,2) NOT NULL DEFAULT 0,
       subtotal_inr   DECIMAL(12,2) NOT NULL DEFAULT 0,   -- base + markup, before tax
       gst_percent    DECIMAL(5,2)  NOT NULL DEFAULT 0,
       gst_inr        DECIMAL(12,2) NOT NULL DEFAULT 0,
       total_inr      DECIMAL(12,2) NOT NULL DEFAULT 0,   -- subtotal + GST — what the tenant pays
       status         TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | cancelled
       due_at         TIMESTAMPTZ NOT NULL,
       generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       paid_at        TIMESTAMPTZ,
       paid_ref       TEXT,
       notes          TEXT
     )`);
  /* GST_v1 (2026-09-06) — invoices raised before this migration stored a
   * pre-tax figure in total_inr. Backfill so old and new rows mean the same
   * thing: subtotal = the old total, GST added on top, total = the payable
   * amount. Runs once — the WHERE clause makes it idempotent. */
  await control.query(
    `ALTER TABLE ai_invoices
       ADD COLUMN IF NOT EXISTS subtotal_inr DECIMAL(12,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS gst_percent  DECIMAL(5,2)  NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS gst_inr      DECIMAL(12,2) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS pay_order_id TEXT,
       ADD COLUMN IF NOT EXISTS paid_via     TEXT`);
  await control.query(
    `UPDATE ai_invoices
        SET subtotal_inr = total_inr,
            gst_percent  = COALESCE((SELECT gst_percent FROM ai_settings WHERE id = 1), 18),
            gst_inr      = ROUND(total_inr * COALESCE((SELECT gst_percent FROM ai_settings WHERE id = 1), 18) / 100, 2),
            total_inr    = ROUND(total_inr * (1 + COALESCE((SELECT gst_percent FROM ai_settings WHERE id = 1), 18) / 100), 2)
      WHERE subtotal_inr = 0 AND total_inr > 0`);
  await control.query(`CREATE INDEX IF NOT EXISTS idx_ai_inv_tenant ON ai_invoices(tenant_slug, generated_at DESC)`);
  await control.query(`CREATE INDEX IF NOT EXISTS idx_ai_inv_status ON ai_invoices(status, due_at)`);
  _colsDone = true;
}

/* ------------------------------------------------------------------ *
 * Config resolution
 * ------------------------------------------------------------------ */
async function loadPolicy() {
  await ensureSchema();
  const s = (await control.query(
    `SELECT COALESCE(rate_inr_per_lakh_input,0)  AS rin,
            COALESCE(rate_inr_per_lakh_output,0) AS rout,
            COALESCE(default_markup_pct,0)       AS mk,
            COALESCE(default_cap_inr,0)          AS cap,
            COALESCE(grace_days,0)               AS grace,
            COALESCE(gst_percent,18)             AS gst
       FROM ai_settings WHERE id = 1`)).rows[0] || {};
  const g = {
    rate_in:  Number(s.rin  || 0),
    rate_out: Number(s.rout || 0),
    markup_pct: Number(s.mk || 0),
    cap_inr:  Number(s.cap  || 0),
    grace_days: Number(s.grace || 0),
    gst_percent: s.gst == null ? 18 : Number(s.gst)
  };
  const rows = (await control.query(
    `SELECT id, slug,
            ai_rate_inr_per_lakh_input  AS rin,
            ai_rate_inr_per_lakh_output AS rout,
            ai_markup_pct AS mk, ai_cap_inr AS cap, ai_blocked_at
       FROM tenants`)).rows;
  const per = {};
  rows.forEach(t => {
    per[t.slug] = {
      id: t.id, slug: t.slug,
      rate_in:  t.rin  == null ? g.rate_in  : Number(t.rin),
      rate_out: t.rout == null ? g.rate_out : Number(t.rout),
      markup_pct: t.mk  == null ? g.markup_pct : Number(t.mk),
      cap_inr:    t.cap == null ? g.cap_inr    : Number(t.cap),
      gst_percent: g.gst_percent,
      blocked_at: t.ai_blocked_at || null,
      uses_global: { rate: t.rin == null && t.rout == null, markup: t.mk == null, cap: t.cap == null }
    };
  });
  return { global: g, per, for: slug => per[slug] || Object.assign({ slug, blocked_at: null }, g) };
}

/* GST_v1 — the full ladder, in one place:
 *   base     = tokens x rate
 *   markup   = base x markup_pct
 *   subtotal = base + markup
 *   gst      = subtotal x gst_percent      (18% by default)
 *   total    = subtotal + gst              <- what the tenant actually pays
 * total_inr stays the payable amount so every existing caller keeps meaning
 * the same thing; the breakdown is additive. */
function priceOf(pol, inTok, outTok) {
  const base = (Number(inTok || 0) / 1e5) * pol.rate_in + (Number(outTok || 0) / 1e5) * pol.rate_out;
  const markup = base * (Number(pol.markup_pct || 0) / 100);
  const subtotal = base + markup;
  const gstPct = pol.gst_percent == null ? 18 : Number(pol.gst_percent);
  const gst = subtotal * (gstPct / 100);
  return {
    base_inr: money(base),
    markup_inr: money(markup),
    subtotal_inr: money(subtotal),
    gst_percent: gstPct,
    gst_inr: money(gst),
    total_inr: money(subtotal + gst)
  };
}

/* ------------------------------------------------------------------ *
 * Unbilled usage — everything after the last non-cancelled invoice
 * ------------------------------------------------------------------ */
async function unbilledFor(slug) {
  await ensureSchema();
  const last = (await control.query(
    `SELECT MAX(period_to) AS upto FROM ai_invoices
      WHERE tenant_slug = $1 AND status <> 'cancelled'`, [slug])).rows[0];
  const from = last && last.upto ? last.upto : null;
  const u = (await control.query(
    `SELECT COUNT(*)::int AS calls,
            COALESCE(SUM(input_tokens),0)::bigint  AS i,
            COALESCE(SUM(output_tokens),0)::bigint AS o,
            MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM ai_usage_log
      WHERE tenant_slug = $1 AND error_text IS NULL
        AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)`,
    [slug, from])).rows[0];
  return {
    period_from: from || u.first_at || null,
    period_to:   u.last_at || null,
    calls: Number(u.calls || 0),
    input_tokens: Number(u.i || 0),
    output_tokens: Number(u.o || 0)
  };
}

/* ------------------------------------------------------------------ *
 * The worker tick: raise invoices, then enforce overdue
 * ------------------------------------------------------------------ */
async function runBillingTick(opts) {
  await ensureSchema();
  const dry = !!(opts && opts.dryRun);
  const pol = await loadPolicy();
  const out = { raised: [], blocked: [], unblocked: [], skipped: 0, dry_run: dry };

  const slugs = (await control.query(
    `SELECT DISTINCT tenant_slug FROM ai_usage_log WHERE error_text IS NULL`)).rows.map(r => r.tenant_slug);

  for (const slug of slugs) {
    const p = pol.for(slug);
    if (!p.cap_inr || p.cap_inr <= 0) { out.skipped++; continue; }   // no cap = never auto-invoice
    if (p.rate_in <= 0 && p.rate_out <= 0) { out.skipped++; continue; } // no rate set = nothing to bill
    const u = await unbilledFor(slug);
    if (!u.period_to || (!u.input_tokens && !u.output_tokens)) { out.skipped++; continue; }
    const price = priceOf(p, u.input_tokens, u.output_tokens);
    if (price.total_inr < p.cap_inr) { out.skipped++; continue; }

    if (!dry) {
      await control.query(
        `INSERT INTO ai_invoices
           (tenant_id, tenant_slug, period_from, period_to, calls, input_tokens, output_tokens,
            rate_in, rate_out, base_inr, markup_pct, markup_inr,
            subtotal_inr, gst_percent, gst_inr, total_inr,
            status, due_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 'pending', NOW() + ($17 || ' days')::interval, $18)`,
        [p.id || null, slug, u.period_from, u.period_to, u.calls, u.input_tokens, u.output_tokens,
         p.rate_in, p.rate_out, price.base_inr, p.markup_pct, price.markup_inr,
         price.subtotal_inr, price.gst_percent, price.gst_inr, price.total_inr,
         String(pol.global.grace_days),
         'Auto-raised: unbilled AI usage reached the ₹' + p.cap_inr + ' cap']);
    }
    out.raised.push({ tenant_slug: slug, total_inr: price.total_inr, cap_inr: p.cap_inr,
                      tokens: u.input_tokens + u.output_tokens });
  }

  // Enforcement — block tenants with an invoice past its due date
  const overdue = (await control.query(
    `SELECT DISTINCT tenant_slug FROM ai_invoices
      WHERE status = 'pending' AND due_at < NOW()`)).rows.map(r => r.tenant_slug);
  for (const slug of overdue) {
    const p = pol.for(slug);
    if (p.blocked_at) continue;
    if (!dry) await control.query(
      `UPDATE tenants SET ai_blocked_at = NOW() WHERE slug = $1 AND ai_blocked_at IS NULL`, [slug]);
    out.blocked.push(slug);
  }

  // Release anyone whose invoices are all settled
  const clear = (await control.query(
    `SELECT slug FROM tenants t
      WHERE t.ai_blocked_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ai_invoices i
                         WHERE i.tenant_slug = t.slug AND i.status = 'pending' AND i.due_at < NOW())`
  )).rows.map(r => r.slug);
  for (const slug of clear) {
    if (!dry) await control.query(`UPDATE tenants SET ai_blocked_at = NULL WHERE slug = $1`, [slug]);
    out.unblocked.push(slug);
  }
  return out;
}

/* Cheap check used by the AI call path. Cached briefly so we do not hit the
 * control DB on every Gemini call. */
let _blockCache = { at: 0, set: new Set() };
async function isTenantAiBlocked(slug) {
  if (!slug) return false;
  const now = Date.now();
  if (now - _blockCache.at > 60_000) {
    try {
      await ensureSchema();
      const r = await control.query(`SELECT slug FROM tenants WHERE ai_blocked_at IS NOT NULL`);
      _blockCache = { at: now, set: new Set(r.rows.map(x => x.slug)) };
    } catch (_) { return false; }   // never block because of an infra hiccup
  }
  return _blockCache.set.has(String(slug));
}
function clearBlockCache() { _blockCache = { at: 0, set: new Set() }; }

/* ------------------------------------------------------------------ *
 * Super-admin API
 * ------------------------------------------------------------------ */
async function api_saas_ai_billing_config(token) {
  await requireSuperAdmin(token);
  const pol = await loadPolicy();
  const rows = (await control.query(
    `SELECT t.slug, t.ai_markup_pct, t.ai_cap_inr, t.ai_blocked_at,
            t.ai_rate_inr_per_lakh_input AS rin, t.ai_rate_inr_per_lakh_output AS rout
       FROM tenants t ORDER BY t.slug`)).rows;
  const withUnbilled = [];
  for (const r of rows) {
    const p = pol.for(r.slug);
    const u = await unbilledFor(r.slug);
    const price = priceOf(p, u.input_tokens, u.output_tokens);
    withUnbilled.push({
      tenant_slug: r.slug,
      markup_pct: r.ai_markup_pct == null ? null : Number(r.ai_markup_pct),
      cap_inr:    r.ai_cap_inr    == null ? null : Number(r.ai_cap_inr),
      rate_in:  r.rin  == null ? null : Number(r.rin),
      rate_out: r.rout == null ? null : Number(r.rout),
      effective: { rate_in: p.rate_in, rate_out: p.rate_out, markup_pct: p.markup_pct, cap_inr: p.cap_inr },
      blocked_at: r.ai_blocked_at || null,
      unbilled: { tokens: u.input_tokens + u.output_tokens, calls: u.calls,
                  base_inr: price.base_inr, markup_inr: price.markup_inr, total_inr: price.total_inr,
                  pct_of_cap: p.cap_inr > 0 ? Number((100 * price.total_inr / p.cap_inr).toFixed(1)) : null }
    });
  }
  return { global: pol.global, tenants: withUnbilled };
}

async function api_saas_ai_billing_setGlobal(token, payload) {
  await requireSuperAdmin(token);
  await ensureSchema();
  const p = payload || {};
  const sets = [], vals = []; let i = 1;
  if (p.default_markup_pct != null) { sets.push(`default_markup_pct = $${i++}`); vals.push(Math.max(0, Number(p.default_markup_pct) || 0)); }
  if (p.default_cap_inr    != null) { sets.push(`default_cap_inr = $${i++}`);    vals.push(Math.max(0, Number(p.default_cap_inr) || 0)); }
  if (p.grace_days         != null) { sets.push(`grace_days = $${i++}`);         vals.push(Math.max(0, parseInt(p.grace_days, 10) || 0)); }
  if (p.gst_percent        != null) { sets.push(`gst_percent = $${i++}`);        vals.push(Math.max(0, Number(p.gst_percent) || 0)); }
  if (sets.length) await control.query(`UPDATE ai_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
  return await api_saas_ai_billing_config(token);
}

/** Per-tenant markup / cap. Pass null for either to fall back to the global value. */
async function api_saas_ai_billing_setTenant(token, payload) {
  await requireSuperAdmin(token);
  await ensureSchema();
  const p = payload || {};
  const slug = String(p.tenant_slug || '').trim();
  if (!slug) throw new Error('tenant_slug required');
  const norm = v => (v === null || v === '' || v === undefined) ? null : Math.max(0, Number(v) || 0);
  const sets = [], vals = []; let i = 1;
  if ('markup_pct' in p) { sets.push(`ai_markup_pct = $${i++}`); vals.push(norm(p.markup_pct)); }
  if ('cap_inr'    in p) { sets.push(`ai_cap_inr = $${i++}`);    vals.push(norm(p.cap_inr)); }
  if (!sets.length) throw new Error('nothing to update');
  vals.push(slug);
  await control.query(`UPDATE tenants SET ${sets.join(', ')} WHERE slug = $${i}`, vals);
  const pol = await loadPolicy();
  return { ok: true, tenant_slug: slug, effective: pol.for(slug) };
}

async function api_saas_ai_invoices_list(token, opts) {
  await requireSuperAdmin(token);
  await ensureSchema();
  const o = opts || {};
  const where = [], vals = []; let i = 1;
  if (o.status)      { where.push(`status = $${i++}`);      vals.push(String(o.status)); }
  if (o.tenant_slug) { where.push(`tenant_slug = $${i++}`); vals.push(String(o.tenant_slug)); }
  const sql = `SELECT *, (status = 'pending' AND due_at < NOW()) AS is_overdue
                 FROM ai_invoices
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY generated_at DESC LIMIT ${Math.min(Number(o.limit) || 200, 500)}`;
  const rows = (await control.query(sql, vals)).rows;
  const sum = (await control.query(
    `SELECT status, COUNT(*)::int AS n, COALESCE(SUM(total_inr),0) AS amt
       FROM ai_invoices GROUP BY status`)).rows;
  const totals = { pending: { n: 0, amt: 0 }, paid: { n: 0, amt: 0 }, cancelled: { n: 0, amt: 0 } };
  sum.forEach(r => { if (totals[r.status]) totals[r.status] = { n: r.n, amt: money(r.amt) }; });
  const od = (await control.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(total_inr),0) AS amt
       FROM ai_invoices WHERE status='pending' AND due_at < NOW()`)).rows[0];
  totals.overdue = { n: Number(od.n || 0), amt: money(od.amt) };
  return { invoices: rows, totals };
}

async function api_saas_ai_invoice_markPaid(token, payload) {
  await requireSuperAdmin(token);
  await ensureSchema();
  const p = payload || {};
  const id = Number(p.id); if (!id) throw new Error('invoice id required');
  await control.query(
    `UPDATE ai_invoices SET status='paid', paid_at=NOW(), paid_ref=$2 WHERE id=$1`,
    [id, p.paid_ref ? String(p.paid_ref).slice(0, 120) : null]);
  const r = (await control.query(`SELECT tenant_slug FROM ai_invoices WHERE id=$1`, [id])).rows[0];
  if (r) {
    // Release the hold if nothing else is overdue for this tenant.
    await control.query(
      `UPDATE tenants t SET ai_blocked_at = NULL
        WHERE t.slug = $1
          AND NOT EXISTS (SELECT 1 FROM ai_invoices i
                           WHERE i.tenant_slug = t.slug AND i.status='pending' AND i.due_at < NOW())`,
      [r.tenant_slug]);
    clearBlockCache();
  }
  return { ok: true, id };
}

async function api_saas_ai_invoice_cancel(token, payload) {
  await requireSuperAdmin(token);
  await ensureSchema();
  const id = Number((payload || {}).id); if (!id) throw new Error('invoice id required');
  await control.query(`UPDATE ai_invoices SET status='cancelled' WHERE id=$1`, [id]);
  clearBlockCache();
  return { ok: true, id };
}

/** Raise an invoice for a tenant now, ignoring the cap. */
async function api_saas_ai_invoice_generateNow(token, payload) {
  await requireSuperAdmin(token);
  await ensureSchema();
  const slug = String((payload || {}).tenant_slug || '').trim();
  if (!slug) throw new Error('tenant_slug required');
  const pol = await loadPolicy();
  const p = pol.for(slug);
  const u = await unbilledFor(slug);
  if (!u.period_to) throw new Error('No unbilled usage for ' + slug);
  const price = priceOf(p, u.input_tokens, u.output_tokens);
  const r = await control.query(
    `INSERT INTO ai_invoices
       (tenant_id, tenant_slug, period_from, period_to, calls, input_tokens, output_tokens,
        rate_in, rate_out, base_inr, markup_pct, markup_inr,
        subtotal_inr, gst_percent, gst_inr, total_inr,
        status, due_at, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
             'pending', NOW() + ($17 || ' days')::interval, $18)
     RETURNING id`,
    [p.id || null, slug, u.period_from, u.period_to, u.calls, u.input_tokens, u.output_tokens,
     p.rate_in, p.rate_out, price.base_inr, p.markup_pct, price.markup_inr,
     price.subtotal_inr, price.gst_percent, price.gst_inr, price.total_inr,
     String(pol.global.grace_days), 'Raised manually by super admin']);
  return { ok: true, id: r.rows[0].id, total_inr: price.total_inr };
}

/** Run the tick on demand (dry run by default so it is safe to click). */
async function api_saas_ai_billing_runNow(token, payload) {
  await requireSuperAdmin(token);
  return await runBillingTick({ dryRun: !(payload && payload.apply === true) });
}

/* ------------------------------------------------------------------ *
 * Background worker — registered from server.js behind WORKERS_ON
 * ------------------------------------------------------------------ */
let _started = false;
function startBillingWorker() {
  if (_started) return;
  _started = true;
  const every = Number(process.env.AI_BILLING_TICK_MS || 15 * 60 * 1000);
  setInterval(() => {
    runBillingTick({ dryRun: false })
      .then(r => { if (r.raised.length || r.blocked.length || r.unblocked.length)
        console.log('[ai-billing] raised=' + r.raised.length + ' blocked=' + r.blocked.length +
                    ' released=' + r.unblocked.length); })
      .catch(e => console.warn('[ai-billing] tick failed:', e.message));
  }, every);
  console.log('[ai-billing] worker started, every ' + Math.round(every / 60000) + ' min');
}


/* ------------------------------------------------------------------ *
 * PAY_NOW_v1 (2026-09-06) — tenant-initiated payment for an AI invoice.
 *
 * Reuses the Cashfree integration already used for signup rather than adding a
 * second gateway path. The order id embeds the invoice id so the existing
 * webhook can settle it, and we store it on the invoice so a duplicate click
 * reuses the same order instead of creating a second one.
 *
 * Called from the TENANT side, so the invoice is looked up by id AND slug —
 * passing another tenant's invoice id returns "not found", never their data.
 * ------------------------------------------------------------------ */
async function createPaymentOrder(slug, invoiceId, customer) {
  await ensureSchema();
  const r = await control.query(
    `SELECT id, tenant_slug, total_inr, status, pay_order_id
       FROM ai_invoices WHERE id = $1 AND tenant_slug = $2`, [Number(invoiceId), String(slug)]);
  const inv = r.rows[0];
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'paid') throw new Error('This invoice is already paid');
  if (inv.status === 'cancelled') throw new Error('This invoice was cancelled');
  if (Number(inv.total_inr) <= 0) throw new Error('Nothing to pay on this invoice');

  const cashfree = require('./cashfree');
  const orderId = inv.pay_order_id || ('AIINV' + inv.id + 'T' + Date.now().toString(36).toUpperCase());
  const base = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const order = await cashfree.createOrder({
    orderId,
    amountInr: Number(inv.total_inr),
    customerName:  (customer && customer.name)  || slug,
    customerEmail: (customer && customer.email) || 'billing@' + slug + '.invalid',
    customerPhone: (customer && customer.phone) || '',
    returnUrl: base + '/t/' + slug + '/#/aiusage',
    notifyUrl: base + '/webhook/cashfree'
  });
  await control.query(`UPDATE ai_invoices SET pay_order_id = $2 WHERE id = $1`, [inv.id, orderId]);
  return {
    ok: true, invoice_id: inv.id, order_id: orderId,
    amount_inr: Number(inv.total_inr),
    payment_session_id: order.payment_session_id
  };
}

/** Settle an invoice paid through the gateway (called by the webhook path). */
async function markPaidByOrder(orderId, ref) {
  await ensureSchema();
  const r = await control.query(
    `UPDATE ai_invoices SET status='paid', paid_at=NOW(), paid_via='cashfree', paid_ref=$2
      WHERE pay_order_id = $1 AND status = 'pending' RETURNING id, tenant_slug`,
    [String(orderId), ref ? String(ref).slice(0, 120) : null]);
  if (!r.rows.length) return { ok: false, reason: 'no matching pending invoice' };
  const slug = r.rows[0].tenant_slug;
  await control.query(
    `UPDATE tenants t SET ai_blocked_at = NULL
      WHERE t.slug = $1
        AND NOT EXISTS (SELECT 1 FROM ai_invoices i
                         WHERE i.tenant_slug = t.slug AND i.status='pending' AND i.due_at < NOW())`,
    [slug]);
  clearBlockCache();
  return { ok: true, id: r.rows[0].id, tenant_slug: slug };
}

module.exports = {
  ensureSchema, loadPolicy, priceOf, unbilledFor, runBillingTick,
  isTenantAiBlocked, clearBlockCache, startBillingWorker,
  api_saas_ai_billing_config,
  api_saas_ai_billing_setGlobal,
  api_saas_ai_billing_setTenant,
  api_saas_ai_invoices_list,
  api_saas_ai_invoice_markPaid,
  api_saas_ai_invoice_cancel,
  api_saas_ai_invoice_generateNow,
  api_saas_ai_billing_runNow,
  createPaymentOrder, markPaidByOrder   /* PAY_NOW_v1 */
};
