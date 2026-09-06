/**
 * routes/mySubscription.js — MY_SUBSCRIPTION_v1 (2026-09-06)
 *
 * Tenant-facing view of their OWN subscription: plan, status, renewal date,
 * invoices and payments.
 *
 * Everything a tenant needs to answer for themselves — "what plan am I on",
 * "when does it renew", "did my payment go through", "do I owe anything" —
 * already existed in the control database, but was only reachable from the
 * super-admin screens. Every one of those questions therefore arrived as a
 * support message. This exposes the same rows, read-only, to the account they
 * belong to.
 *
 * SCOPING — the important part
 * The tenant slug is taken from the server-side tenant context (tenantStorage),
 * NEVER from anything the client sends. There is deliberately no tenant_slug
 * argument on any function here: if there were, a tenant could pass someone
 * else's slug and read their invoices. Every query filters on tenant_id
 * resolved from that context.
 *
 * Read-only by design. Nothing here can change a plan, mark an invoice paid,
 * or start a payment — those stay with the super admin and the payment gateway.
 */
'use strict';

const control = require('../control/db');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const money = n => Number(Number(n || 0).toFixed(2));

/** Resolve the caller's own tenant row from server-side context only. */
async function _myTenant() {
  let slug = '';
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    if (store && store.slug) slug = String(store.slug);
  } catch (_) {}
  if (!slug) return null;
  try {
    const r = await control.query(
      `SELECT id, slug, name, status, package_id,
              trial_ends_at, current_period_start, current_period_end
         FROM tenants WHERE slug = $1 LIMIT 1`, [slug]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

function _daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

/**
 * api_billing_mySubscription(token)
 *   -> { plan, status, period, dues, unavailable? }
 */
async function api_billing_mySubscription(token) {
  await authUser(token);
  const t = await _myTenant();
  if (!t) return { unavailable: true, reason: 'subscription details are not available for this account' };

  let pkg = null;
  if (t.package_id) {
    try {
      const r = await control.query(
        `SELECT name, description, base_price_inr, recurring_period, recurring_period_count,
                is_lifetime, tax_percent, modules, trial_days
           FROM packages WHERE id = $1`, [t.package_id]);
      pkg = r.rows[0] || null;
    } catch (_) {}
  }

  const now = new Date();
  const endsAt = t.current_period_end || null;
  const daysLeft = endsAt ? _daysBetween(now, endsAt) : null;

  // Outstanding subscription invoices
  let dues = { pending_count: 0, pending_inr: 0, overdue_count: 0, oldest_due: null };
  try {
    const d = (await control.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(total_inr),0) AS amt,
              MIN(period_end) AS oldest
         FROM invoices
        WHERE tenant_id = $1 AND status = 'pending'`, [t.id])).rows[0];
    dues.pending_count = Number(d.n || 0);
    dues.pending_inr = money(d.amt);
    dues.oldest_due = d.oldest || null;
  } catch (_) {}

  const cycle = pkg
    ? (Number(pkg.is_lifetime) === 1
        ? 'Lifetime'
        : (Number(pkg.recurring_period_count) > 1
            ? 'Every ' + pkg.recurring_period_count + ' ' + pkg.recurring_period + 's'
            : 'Per ' + pkg.recurring_period))
    : null;

  return {
    tenant: { name: t.name, slug: t.slug },
    plan: pkg ? {
      name: pkg.name,
      description: pkg.description || '',
      price_inr: money(pkg.base_price_inr),
      tax_percent: Number(pkg.tax_percent || 0),
      cycle,
      is_lifetime: Number(pkg.is_lifetime) === 1,
      modules: String(pkg.modules || '').split(',').map(s => s.trim()).filter(Boolean)
    } : null,
    status: t.status,
    period: {
      started_at: t.current_period_start || null,
      renews_at: endsAt,
      days_left: daysLeft,
      expired: daysLeft != null && daysLeft < 0,
      expiring_soon: daysLeft != null && daysLeft >= 0 && daysLeft <= 7,
      trial_ends_at: t.trial_ends_at || null
    },
    dues
  };
}

/**
 * api_billing_myInvoices(token)
 *   -> { invoices: [...], payments: [...] }
 * Invoices carry a derived `is_overdue` so the UI does not have to reimplement
 * the comparison (and get it subtly different from the server).
 */
async function api_billing_myInvoices(token) {
  await authUser(token);
  const t = await _myTenant();
  if (!t) return { invoices: [], payments: [] };

  let invoices = [], payments = [];
  try {
    invoices = (await control.query(
      `SELECT id, number, description, subtotal_inr, tax_inr, total_inr,
              period_start, period_end, status, paid_at, created_at,
              (status = 'pending' AND period_end IS NOT NULL AND period_end < NOW()) AS is_overdue
         FROM invoices WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 60`, [t.id])).rows;
  } catch (_) {}
  try {
    payments = (await control.query(
      `SELECT id, invoice_id, gateway, amount_inr, status, created_at
         FROM payments WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 60`, [t.id])).rows;
  } catch (_) {}
  return { invoices, payments };
}

module.exports = { api_billing_mySubscription, api_billing_myInvoices };
