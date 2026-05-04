/**
 * Cashfree Payments integration.
 *
 * Flow:
 *   1. Public signup form posts → api_saas_signup_create
 *   2. We insert a `signups` row + create a Cashfree Order via REST API
 *   3. Return the payment_session_id; the frontend opens Cashfree's
 *      Hosted Checkout. Customer pays.
 *   4. Cashfree fires the webhook → /hook/cashfree → expressWebhook below
 *   5. We verify the signature, mark payment paid, provision the tenant,
 *      generate the invoice, send a welcome email.
 *
 * Webhook signature (Cashfree v3): HMAC-SHA256 of `timestamp + raw_body`
 * using the secret_key, base64-encoded, in the `x-webhook-signature`
 * header. Timestamp is `x-webhook-timestamp`. We verify with timing-safe
 * compare to prevent forgery.
 */
const fetch = require('node-fetch');
const crypto = require('crypto');
const control = require('../../control/db');

// ---- Cashfree config --------------------------------------------
async function _cfg() {
  const [appId, secret, mode] = await Promise.all([
    control.getSetting('CASHFREE_APP_ID',  process.env.CASHFREE_APP_ID || ''),
    control.getSetting('CASHFREE_SECRET',  process.env.CASHFREE_SECRET || ''),
    control.getSetting('CASHFREE_MODE',    process.env.CASHFREE_MODE || 'PROD')   // PROD | TEST
  ]);
  const base = String(mode).toUpperCase() === 'TEST'
    ? 'https://sandbox.cashfree.com/pg'
    : 'https://api.cashfree.com/pg';
  return { appId, secret, mode: String(mode).toUpperCase(), base };
}

function _headers(c) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'x-api-version': '2023-08-01',
    'x-client-id': c.appId,
    'x-client-secret': c.secret
  };
}

/**
 * Create a Cashfree order. Returns the payment_session_id which the
 * frontend uses to launch Cashfree's Hosted Checkout.
 */
async function createOrder({ orderId, amountInr, customerName, customerEmail, customerPhone, returnUrl, notifyUrl }) {
  const c = await _cfg();
  if (!c.appId || !c.secret) throw new Error('Cashfree credentials not configured. Super-admin → Settings → Cashfree.');

  const body = {
    order_id: orderId,
    order_amount: Number(amountInr),
    order_currency: 'INR',
    customer_details: {
      customer_id: 'cust_' + Date.now(),
      customer_name: customerName || 'Customer',
      customer_email: customerEmail,
      customer_phone: String(customerPhone || '').replace(/\D/g, '').slice(-10) || '0000000000'
    },
    order_meta: {
      return_url: returnUrl,
      notify_url: notifyUrl
    }
  };
  const r = await fetch(c.base + '/orders', {
    method: 'POST',
    headers: _headers(c),
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok || !j.payment_session_id) {
    throw new Error('Cashfree: ' + (j.message || JSON.stringify(j).slice(0, 200)));
  }
  return {
    payment_session_id: j.payment_session_id,
    cf_order_id: j.cf_order_id,
    order_status: j.order_status
  };
}

/**
 * Verify the webhook signature. Throws on mismatch.
 *   timestamp + raw_body  -> HMAC-SHA256 with secret  ->  base64
 */
async function verifyWebhookSignature(rawBody, signature, timestamp) {
  const c = await _cfg();
  if (!c.secret) throw new Error('Cashfree secret not configured');
  if (!signature || !timestamp) throw new Error('Missing signature headers');
  const data = String(timestamp) + (typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
  const expected = crypto.createHmac('sha256', c.secret).update(data).digest('base64');
  // Timing-safe compare
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid webhook signature');
  }
  return true;
}

/**
 * Fetch order status from Cashfree (used by /api/saas/payment/verify
 * after the customer comes back from the hosted checkout, in case the
 * webhook hasn't fired yet).
 */
async function getOrderStatus(orderId) {
  const c = await _cfg();
  const r = await fetch(c.base + '/orders/' + encodeURIComponent(orderId), { headers: _headers(c) });
  return r.json();
}

module.exports = {
  _cfg, createOrder, verifyWebhookSignature, getOrderStatus
};
