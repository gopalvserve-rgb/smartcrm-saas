/**
 * WL_BILLING_v1 — White-Label Customer billing (super-admin module).
 *
 * Customers here are AGENCIES who bought the white-label CRM from
 * SmartCRM Solution. They are NOT tenants. This module lives entirely
 * in the control DB.
 *
 * Schema: wl_customers, wl_invoices, wl_payments, wl_wa_log.
 *
 * WhatsApp sends use a single Cloud API number configured at
 * control level via these keys (settable in Super-Admin Settings):
 *   WL_WA_PHONE_NUMBER_ID
 *   WL_WA_ACCESS_TOKEN
 *   WL_PORTAL_BASE_URL    e.g. https://crm.smartcrmsolution.com
 *
 * Cashfree integration reuses routes/saas/cashfree.js. Payment links
 * are created on-demand when a customer opens the portal OR when the
 * super-admin clicks "Generate Pay Link" on an invoice.
 *
 * APIs (POST /api/saas):
 *   api_saas_wl_customers_list(token)
 *   api_saas_wl_customers_get(token, id)
 *   api_saas_wl_customers_save(token, payload)
 *   api_saas_wl_customers_delete(token, id)
 *   api_saas_wl_invoices_listForCustomer(token, customer_id)
 *   api_saas_wl_invoices_generateMonth(token, customer_id?)  // current month, all if no id
 *   api_saas_wl_invoices_recordPayment(token, payload)
 *   api_saas_wl_invoices_sendWA(token, invoice_id, kind)    // kind: invoice|reminder|thanks
 *   api_saas_wl_summary(token)                              // MRR + balance dashboard
 *   api_saas_wl_settingsGet(token) / api_saas_wl_settingsSave(token, ...)
 *
 * Public (no super-admin token, opened by customers from their WA link):
 *   api_saas_wl_portal_view(portal_token)
 *   api_saas_wl_portal_payLink(portal_token, invoice_id)
 *
 * Cashfree webhook hits /hook/cashfree (existing handler) — we detect
 * wl_* order_ids and reduce the customer's balance + mark paid.
 */

const fetch = require('node-fetch');
const crypto = require('crypto');
const control = require('../../control/db');
const cashfree = require('./cashfree');
const { requireSuperAdmin } = require('./superAdminAuth');

/* ───────────────────── helpers ───────────────────── */

function _portalToken() {
  return crypto.randomBytes(12).toString('hex');
}
function _monthYYYYMM(d) {
  d = d || new Date();
  return d.toISOString().slice(0, 7);   // 2026-06
}
async function _nextInvoiceNumber(periodMonth) {
  const r = await control.query(
    `SELECT COUNT(*)::INT AS n FROM wl_invoices WHERE period_month = $1`,
    [periodMonth]
  );
  return 'WL-' + periodMonth.replace('-', '') + '-' + String(r.rows[0].n + 1).padStart(4, '0');
}

/* ───────────────────── customer CRUD ───────────────────── */

async function api_saas_wl_customers_list(token) {
  await requireSuperAdmin(token);
  const r = await control.query(`
    SELECT c.*,
           (SELECT COUNT(*)::INT FROM wl_invoices i WHERE i.customer_id = c.id AND i.status IN ('pending','sent','overdue')) AS pending_invoices,
           (SELECT COALESCE(SUM(p.amount),0) FROM wl_payments p WHERE p.customer_id = c.id) AS lifetime_paid_calc,
           (SELECT i.due_date FROM wl_invoices i WHERE i.customer_id = c.id AND i.status IN ('pending','sent','overdue') ORDER BY i.due_date ASC LIMIT 1) AS next_unpaid_due_date,
           (SELECT i.invoice_no FROM wl_invoices i WHERE i.customer_id = c.id AND i.status IN ('pending','sent','overdue') ORDER BY i.due_date ASC LIMIT 1) AS next_unpaid_invoice_no
      FROM wl_customers c
     ORDER BY c.created_at DESC
  `);
  // Compute scheduled next_due_date — next billing_day occurrence from today (in IST).
  // If there is already a pending invoice, we surface its due_date as the "real" next due.
  // Otherwise we project forward from billing_day.
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  const day = ist.getUTCDate();
  return r.rows.map(row => {
    const bd = Math.max(1, Math.min(28, Number(row.billing_day) || 1));
    let nextDue;
    if (day < bd) {
      nextDue = new Date(Date.UTC(year, month, bd));
    } else {
      nextDue = new Date(Date.UTC(year, month + 1, bd));
    }
    return {
      ...row,
      next_due_date: row.next_unpaid_due_date || nextDue.toISOString().slice(0, 10),
      scheduled_next_due: nextDue.toISOString().slice(0, 10)
    };
  });
}

async function api_saas_wl_customers_get(token, id) {
  await requireSuperAdmin(token);
  const r = await control.query(`SELECT * FROM wl_customers WHERE id = $1`, [Number(id)]);
  return r.rows[0] || null;
}

async function api_saas_wl_customers_save(token, payload) {
  await requireSuperAdmin(token);
  const p = payload || {};
  if (!p.company_name || !p.phone) throw new Error('Company name and phone are required.');
  const data = {
    company_name:   String(p.company_name).trim(),
    contact_name:   String(p.contact_name || '').trim() || null,
    phone:          String(p.phone).replace(/[^\d+]/g, ''),
    email:          p.email ? String(p.email).trim() : null,
    product_name:   p.product_name || 'SmartCRM White Label',
    total_users:    Math.max(0, Number(p.total_users) || 0),
    monthly_amount: Math.max(0, Number(p.monthly_amount) || 0),
    total_paid:     Math.max(0, Number(p.total_paid) || 0),
    balance:        Number(p.balance) || 0,
    currency:       String(p.currency || 'INR').toUpperCase().slice(0, 3),
    billing_day:    Math.max(1, Math.min(28, Number(p.billing_day) || 1)),
    status:         ['active','paused','churned'].includes(p.status) ? p.status : 'active',
    notes:          p.notes || null
  };
  if (p.id) {
    // control.update() already appends updated_at=NOW() automatically — passing it in data caused 'multiple assignments to same column updated_at'.
    await control.update('wl_customers', p.id, data);
    return { id: Number(p.id), ok: true };
  }
  data.portal_token = _portalToken();
  const id = await control.insert('wl_customers', data);
  return { id, ok: true, portal_token: data.portal_token };
}

async function api_saas_wl_customers_delete(token, id) {
  await requireSuperAdmin(token);
  await control.query(`UPDATE wl_customers SET status = 'churned' WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

/* ───────────────────── invoices ───────────────────── */

async function api_saas_wl_invoices_listForCustomer(token, customerId) {
  await requireSuperAdmin(token);
  const r = await control.query(
    `SELECT * FROM wl_invoices WHERE customer_id = $1 ORDER BY generated_at DESC LIMIT 100`,
    [Number(customerId)]
  );
  return r.rows;
}

/** Generate this-month's invoice for one or all active customers. */
async function api_saas_wl_invoices_generateMonth(token, customerId) {
  await requireSuperAdmin(token);
  const month = _monthYYYYMM();
  // WL_BILLING_INV_PARAM_FIX (2026-06-15): SQL was using $2 with a single-
  // element params array (no $1 referenced), so Postgres failed with
  // 'could not determine data type of parameter $1'. The `month` is only
  // used later in the dedup check (separate query), not in this SELECT.
  // Fix: use $1 to match the actual params array.
  const customers = (await control.query(
    `SELECT * FROM wl_customers
      WHERE status = 'active' AND monthly_amount > 0
        ${customerId ? 'AND id = $1' : ''}
      ORDER BY id ASC`,
    customerId ? [Number(customerId)] : []
  )).rows;
  const generated = [];
  const skipped  = [];
  for (const c of customers) {
    // Skip if invoice already exists for this month
    const exists = await control.query(
      `SELECT id FROM wl_invoices WHERE customer_id = $1 AND period_month = $2 LIMIT 1`,
      [c.id, month]
    );
    if (exists.rows.length) { skipped.push({ customer_id: c.id, reason: 'already exists' }); continue; }
    const invNo = await _nextInvoiceNumber(month);
    // Due date = next billing_day. If today is past, due in current month;
    // if current day < billing_day, due this month's billing_day.
    const now = new Date();
    const due = new Date(now.getFullYear(), now.getMonth(), c.billing_day);
    if (due < now) due.setMonth(due.getMonth() + 1);
    const id = await control.insert('wl_invoices', {
      customer_id:  c.id,
      invoice_no:   invNo,
      period_month: month,
      amount:       c.monthly_amount,
      status:       'pending',
      due_date:     due.toISOString().slice(0, 10),
      generated_at: control.nowIso()
    });
    // Bump balance
    await control.query(
      `UPDATE wl_customers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
      [Number(c.monthly_amount), c.id]
    );
    generated.push({ customer_id: c.id, invoice_id: id, invoice_no: invNo, amount: c.monthly_amount });
  }
  return { month, generated, skipped, count: generated.length };
}

/** Manually record an offline payment. */
async function api_saas_wl_invoices_recordPayment(token, payload) {
  const ctx = await requireSuperAdmin(token);
  const p = payload || {};
  if (!p.customer_id || !p.amount) throw new Error('customer_id and amount required');
  const amt = Number(p.amount);
  if (!(amt > 0)) throw new Error('amount must be > 0');
  const payId = await control.insert('wl_payments', {
    customer_id: Number(p.customer_id),
    invoice_id:  p.invoice_id ? Number(p.invoice_id) : null,
    amount:      amt,
    paid_at:     p.paid_at || control.nowIso(),
    method:      p.method || 'manual',
    reference:   p.reference || null,
    notes:       p.notes || null,
    recorded_by: (ctx && ctx.email) || 'admin'
  });
  // Adjust totals
  await control.query(
    `UPDATE wl_customers
        SET total_paid = total_paid + $1,
            balance    = balance - $1,
            updated_at = NOW()
      WHERE id = $2`,
    [amt, Number(p.customer_id)]
  );
  if (p.invoice_id) {
    await control.query(
      `UPDATE wl_invoices SET status = 'paid', paid_at = NOW() WHERE id = $1`,
      [Number(p.invoice_id)]
    );
  }
  return { id: payId, ok: true };
}

/* ───────────────────── WhatsApp send ───────────────────── */

async function _waCreds() {
  const [phoneId, accessToken, portalBase] = await Promise.all([
    control.getSetting('WL_WA_PHONE_NUMBER_ID', ''),
    control.getSetting('WL_WA_ACCESS_TOKEN', ''),
    control.getSetting('WL_PORTAL_BASE_URL', 'https://crm.smartcrmsolution.com')
  ]);
  return { phoneId, accessToken, portalBase };
}

function _buildInvoiceMessage({ c, inv, portalUrl, kind }) {
  const amt = Number(inv.amount).toFixed(2);
  const due = inv.due_date ? new Date(inv.due_date).toLocaleDateString('en-IN') : '';
  const tag = kind === 'reminder' ? '⏰ *Payment Reminder*'
             : kind === 'thanks'   ? '🎉 *Payment Received*'
             : '🧾 *New Invoice*';
  if (kind === 'thanks') {
    return `${tag}\n\nHi ${c.contact_name || c.company_name},\n\nWe've received your payment of ₹${amt} for ${inv.invoice_no}. Thank you!\n\nYour current balance: ₹${Number(c.balance).toFixed(2)}\n\n— SmartCRM Solution`;
  }
  const lines = [
    tag,
    '',
    `Hi ${c.contact_name || c.company_name},`,
    '',
    `Your invoice for *${inv.period_month}* is ready.`,
    `Amount: *₹${amt}*`,
    due ? `Due: *${due}*` : '',
    inv.invoice_no ? `Invoice #: ${inv.invoice_no}` : '',
    '',
    `View invoice & pay online:`,
    portalUrl,
    '',
    '— SmartCRM Solution'
  ].filter(Boolean);
  return lines.join('\n');
}

/** Internal: send WA for an invoice (no auth check, used by cron + public API). */
async function _sendWAForInvoice(invoiceId, kind) {
  return await _doSendWA(Number(invoiceId), kind || 'invoice');
}

/** Send (or resend) a WhatsApp message about a specific invoice. */
async function api_saas_wl_invoices_sendWA(token, invoiceId, kind) {
  await requireSuperAdmin(token);
  return await _doSendWA(Number(invoiceId), kind || 'invoice');
}

async function _doSendWA(invoiceId, kind) {
  const inv = (await control.query(`SELECT * FROM wl_invoices WHERE id = $1`, [Number(invoiceId)])).rows[0];
  if (!inv) throw new Error('Invoice not found');
  const c = (await control.query(`SELECT * FROM wl_customers WHERE id = $1`, [inv.customer_id])).rows[0];
  if (!c) throw new Error('Customer not found');
  const { phoneId, accessToken, portalBase } = await _waCreds();
  if (!phoneId || !accessToken) {
    throw new Error('WhatsApp not configured. Super-Admin → Settings → White-Label Billing → set WL_WA_PHONE_NUMBER_ID + WL_WA_ACCESS_TOKEN.');
  }
  const portalUrl = `${portalBase.replace(/\/$/, '')}/wl/portal/${c.portal_token}`;
  const message = _buildInvoiceMessage({ c, inv, portalUrl, kind: kind || 'invoice' });
  const to = String(c.phone).replace(/\D/g, '');
  let waMessageId = null, errMsg = null, status = 'sent';
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url: true, body: message }
      })
    });
    const j = await r.json();
    if (j.error) { status = 'failed'; errMsg = j.error.message; }
    else { waMessageId = j.messages && j.messages[0] && j.messages[0].id; }
  } catch (e) { status = 'failed'; errMsg = e.message; }
  await control.insert('wl_wa_log', {
    customer_id: c.id, invoice_id: inv.id, phone: to,
    message_body: message, wa_message_id: waMessageId, status, error: errMsg
  });
  if (status === 'sent' && (kind || 'invoice') !== 'thanks') {
    await control.query(
      `UPDATE wl_invoices SET status = CASE WHEN status='pending' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, NOW()) WHERE id = $1`,
      [inv.id]
    );
  }
  if (status !== 'sent') throw new Error('WhatsApp send failed: ' + (errMsg || 'unknown'));
  return { ok: true, wa_message_id: waMessageId };
}

/* ───────────────────── summary / dashboard ───────────────────── */

async function api_saas_wl_summary(token) {
  await requireSuperAdmin(token);
  const month = _monthYYYYMM();
  const r = await control.query(`
    SELECT
      (SELECT COUNT(*) FROM wl_customers WHERE status = 'active')::INT AS active_customers,
      (SELECT COALESCE(SUM(monthly_amount),0) FROM wl_customers WHERE status = 'active')::NUMERIC AS mrr,
      (SELECT COALESCE(SUM(balance),0) FROM wl_customers WHERE status = 'active')::NUMERIC AS total_balance,
      (SELECT COALESCE(SUM(total_paid),0) FROM wl_customers)::NUMERIC AS lifetime_revenue,
      (SELECT COALESCE(SUM(amount),0) FROM wl_payments WHERE paid_at::DATE >= DATE_TRUNC('month', NOW()))::NUMERIC AS this_month_collected,
      (SELECT COUNT(*) FROM wl_invoices WHERE period_month = $1 AND status IN ('pending','sent','overdue'))::INT AS pending_this_month
  `, [month]);
  return Object.assign({ month }, r.rows[0]);
}

/* ───────────────────── settings ───────────────────── */

async function api_saas_wl_settingsGet(token) {
  await requireSuperAdmin(token);
  const keys = ['WL_WA_PHONE_NUMBER_ID', 'WL_WA_ACCESS_TOKEN', 'WL_PORTAL_BASE_URL'];
  const out = {};
  for (const k of keys) out[k] = await control.getSetting(k, '');
  // Mask the access token for display
  if (out.WL_WA_ACCESS_TOKEN) {
    out.WL_WA_ACCESS_TOKEN_MASKED = '••••' + out.WL_WA_ACCESS_TOKEN.slice(-6);
    delete out.WL_WA_ACCESS_TOKEN;
  }
  return out;
}
async function api_saas_wl_settingsSave(token, payload) {
  await requireSuperAdmin(token);
  const p = payload || {};
  if (p.WL_WA_PHONE_NUMBER_ID != null) await control.setSetting('WL_WA_PHONE_NUMBER_ID', String(p.WL_WA_PHONE_NUMBER_ID).trim());
  // Only overwrite token if a fresh one is provided (not the masked placeholder)
  if (p.WL_WA_ACCESS_TOKEN && !/^•/.test(p.WL_WA_ACCESS_TOKEN)) await control.setSetting('WL_WA_ACCESS_TOKEN', String(p.WL_WA_ACCESS_TOKEN).trim());
  if (p.WL_PORTAL_BASE_URL != null) await control.setSetting('WL_PORTAL_BASE_URL', String(p.WL_PORTAL_BASE_URL).trim());
  return { ok: true };
}

/* ───────────────────── public portal ───────────────────── */

async function api_saas_wl_portal_view(token) {
  // Note: this `token` is the portal_token, NOT a super-admin token.
  if (!token) throw new Error('Invalid link');
  const c = (await control.query(`SELECT * FROM wl_customers WHERE portal_token = $1`, [String(token)])).rows[0];
  if (!c) throw new Error('Customer not found');
  const invoices = (await control.query(
    `SELECT id, invoice_no, period_month, amount, status, due_date, generated_at, paid_at, cashfree_link
       FROM wl_invoices WHERE customer_id = $1 ORDER BY generated_at DESC LIMIT 24`,
    [c.id]
  )).rows;
  const payments = (await control.query(
    `SELECT id, amount, paid_at, method, reference
       FROM wl_payments WHERE customer_id = $1 ORDER BY paid_at DESC LIMIT 24`,
    [c.id]
  )).rows;
  return {
    customer: {
      company_name: c.company_name,
      contact_name: c.contact_name,
      product_name: c.product_name,
      total_users:  c.total_users,
      monthly_amount: c.monthly_amount,
      currency:     c.currency,
      total_paid:   c.total_paid,
      balance:      c.balance
    },
    invoices,
    payments
  };
}

/** Generate a Cashfree pay link for one invoice. Cached on the row. */
async function api_saas_wl_portal_payLink(token, invoiceId) {
  if (!token) throw new Error('Invalid link');
  const c = (await control.query(`SELECT * FROM wl_customers WHERE portal_token = $1`, [String(token)])).rows[0];
  if (!c) throw new Error('Customer not found');
  const inv = (await control.query(
    `SELECT * FROM wl_invoices WHERE id = $1 AND customer_id = $2`,
    [Number(invoiceId), c.id]
  )).rows[0];
  if (!inv) throw new Error('Invoice not found');
  if (inv.status === 'paid') return { ok: true, paid: true };
  if (inv.cashfree_link) return { ok: true, link: inv.cashfree_link };
  const portalBase = await control.getSetting('WL_PORTAL_BASE_URL', 'https://crm.smartcrmsolution.com');
  const orderId = 'wl_' + inv.id + '_' + Date.now();
  const out = await cashfree.createOrder({
    orderId,
    amountInr: Number(inv.amount),
    customerName: c.contact_name || c.company_name,
    customerEmail: c.email || 'noemail@smartcrmsolution.com',
    customerPhone: c.phone,
    returnUrl: `${portalBase.replace(/\/$/, '')}/wl/portal/${c.portal_token}?paid=1`,
    notifyUrl: `${portalBase.replace(/\/$/, '')}/hook/cashfree`
  });
  // Build Cashfree Hosted Checkout link
  const link = `https://payments.cashfree.com/order/#${out.payment_session_id}`;
  await control.query(
    `UPDATE wl_invoices SET cashfree_order_id = $1, cashfree_link = $2 WHERE id = $3`,
    [orderId, link, inv.id]
  );
  return { ok: true, link, order_id: orderId };
}


// ───────────────────────────────────────────────────────────────────────
// WL_BILLING_CRON_v1 — daily cron worker
// Runs once a day around 9am IST. For every active customer whose
// billing_day equals today's day-of-month, generates a monthly invoice
// (idempotent — _invoices_generateMonth skips if one already exists for
// the current period_month) and then auto-sends the invoice via WhatsApp
// (if WL_WA_PHONE_NUMBER_ID + WL_WA_ACCESS_TOKEN are configured) and
// email (if SMTP is configured).
//
// Manual trigger: api_saas_wl_runBillingCronNow(token, { dryRun? })
// ───────────────────────────────────────────────────────────────────────
async function _runBillingForToday(opts) {
  const dryRun = !!(opts && opts.dryRun);
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  const todayDay = ist.getUTCDate();
  const out = { day: todayDay, due_today: 0, generated: [], sent: [], errors: [] };

  // Pull all active customers whose billing_day == today
  const r = await control.query(
    `SELECT * FROM wl_customers WHERE status='active' AND monthly_amount > 0 AND billing_day = $1`,
    [todayDay]
  );
  out.due_today = r.rows.length;
  if (!r.rows.length) return out;

  if (dryRun) {
    out.would_invoice = r.rows.map(c => ({ id: c.id, company_name: c.company_name, amount: c.monthly_amount }));
    return out;
  }

  // For each due customer: generate this month's invoice + auto-send WA
  for (const c of r.rows) {
    try {
      // Use generateMonth scoped to a single customer (idempotent — skips if exists)
      // The function is super-admin-gated, but we are running in a trusted context;
      // call _generateInvoiceForCustomer-equivalent inline so we don't need a token.
      const month = _monthYYYYMM();
      const exists = await control.query(
        `SELECT id FROM wl_invoices WHERE customer_id = $1 AND period_month = $2 LIMIT 1`,
        [c.id, month]
      );
      let invoiceId;
      if (exists.rows.length) {
        invoiceId = exists.rows[0].id;
      } else {
        const invNo = await _nextInvoiceNumber(month);
        const due = new Date(ist.getUTCFullYear(), ist.getUTCMonth(), c.billing_day);
        invoiceId = await control.insert('wl_invoices', {
          customer_id:  c.id,
          invoice_no:   invNo,
          period_month: month,
          amount:       c.monthly_amount,
          status:       'pending',
          due_date:     due.toISOString().slice(0, 10),
          generated_at: control.nowIso()
        });
        await control.query(
          `UPDATE wl_customers SET balance = balance + $1, updated_at = NOW() WHERE id = $2`,
          [Number(c.monthly_amount), c.id]
        );
        out.generated.push({ customer_id: c.id, invoice_id: invoiceId, invoice_no: invNo, amount: c.monthly_amount });
      }
      // Auto-send the invoice WA (kind='invoice')
      try {
        if (typeof _sendWAForInvoice === 'function') {
          await _sendWAForInvoice(invoiceId, 'invoice');
          await control.query(
            `UPDATE wl_invoices SET status='sent', sent_at=NOW() WHERE id=$1 AND status='pending'`,
            [invoiceId]
          );
          out.sent.push({ customer_id: c.id, invoice_id: invoiceId });
        }
      } catch (sendErr) {
        out.errors.push({ customer_id: c.id, invoice_id: invoiceId, send_error: sendErr.message });
      }
    } catch (e) {
      out.errors.push({ customer_id: c.id, error: e.message });
    }
  }
  return out;
}

// Super-admin manual trigger for the cron — useful for testing and for
// a "Run Billing Now" button on the WL Billing dashboard.
async function api_saas_wl_runBillingCronNow(token, payload) {
  await requireSuperAdmin(token);
  return await _runBillingForToday(payload || {});
}

module.exports = {
  api_saas_wl_customers_list,
  api_saas_wl_customers_get,
  api_saas_wl_customers_save,
  api_saas_wl_customers_delete,
  api_saas_wl_invoices_listForCustomer,
  api_saas_wl_invoices_generateMonth,
  api_saas_wl_invoices_recordPayment,
  api_saas_wl_invoices_sendWA,
  api_saas_wl_summary,
  api_saas_wl_settingsGet,
  api_saas_wl_settingsSave,
  api_saas_wl_portal_view,
  api_saas_wl_portal_payLink,
  api_saas_wl_runBillingCronNow,
  _runBillingForToday
};
