/* ============================================================================
 * CF_LINK_WEBHOOK_v1 (2026-07-20)
 *
 * Receives Cashfree PAYMENT_LINK_EVENT webhooks for TENANT payment links and
 * updates the tenant's payment_links row (paid / partially paid / expired /
 * cancelled).
 *
 * Why a separate file from routes/saas/cashfreeWebhook.js: that one handles
 * SaaS signup/subscription orders and writes to the CONTROL db. Payment links
 * live in the TENANT db, so this handler must run inside the tenant's pool.
 *
 * URL: POST /hook/cashfree-link/:slug
 *   The slug makes tenant resolution trivial and is set automatically as
 *   link_meta.notify_url when the link is created (routes/payments.js).
 *
 * Signature (docs: payment-links/webhooks + webhook-signature-verification):
 *   signature = base64( HMAC_SHA256( x-webhook-timestamp + RAW_BODY, secret ) )
 *   compared against the x-webhook-signature header.
 *   The RAW body is mandatory — re-serialising parsed JSON changes the bytes
 *   and the signature will never match. That is why server.js mounts this
 *   route with bodyParser.raw BEFORE bodyParser.json.
 * ==========================================================================*/

const crypto = require('crypto');
const db = require('../db/pg');

function _rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  try { return JSON.stringify(req.body || {}); } catch (_) { return ''; }
}

function verifySignature(rawBody, timestamp, signature, secret) {
  if (!signature || !timestamp || !secret) return false;
  try {
    const expected = crypto.createHmac('sha256', secret)
      .update(String(timestamp) + rawBody)
      .digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);   // constant-time — avoid a timing oracle
  } catch (_) { return false; }
}

/** Apply a PAYMENT_LINK_EVENT to the tenant's payment_links row. */
async function applyLinkEvent(data) {
  const payments = require('./payments');
  const linkId   = data.link_id;
  const cfLinkId = data.cf_link_id;
  if (!linkId && !cfLinkId) return { ok: false, reason: 'no link id in payload' };

  let row = null;
  try {
    const r = await db.query(
      `SELECT * FROM payment_links
        WHERE link_id_custom = $1 OR gateway_link_id = $2
        ORDER BY id DESC LIMIT 1`,
      [String(linkId || ''), String(cfLinkId || '')]
    );
    row = r.rows[0];
  } catch (e) { return { ok: false, reason: 'lookup failed: ' + e.message }; }
  if (!row) return { ok: false, reason: 'no matching payment_link for ' + (linkId || cfLinkId) };

  const status = payments._cfStatusToLocal(data.link_status);
  const paid   = Number(data.link_amount_paid || 0);
  const order  = data.order || {};

  const patch = { updated_at: db.nowIso() };
  if (status) patch.status = status;
  if (!isNaN(paid)) patch.amount_paid_inr = paid;
  if (status === 'paid' || status === 'partial') {
    patch.paid_at = db.nowIso();
    if (order.transaction_id) patch.paid_txn_count = Number(row.paid_txn_count || 0) + 1;
  }
  await db.update('payment_links', row.id, patch);

  // Record the individual transaction when present (link_payments table).
  if (order.order_id) {
    try {
      await db.query(
        `INSERT INTO link_payments (link_id, gateway_txn_id, amount_inr, status, payment_mode, paid_at, raw_json)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6)`,
        [row.id, String(order.transaction_id || order.order_id),
         Number(order.order_amount || 0), String(order.transaction_status || ''),
         '', JSON.stringify(data)]
      );
    } catch (_) { /* table may not exist on older tenants — never fail the webhook */ }
  }
  return { ok: true, link_row_id: row.id, status: patch.status };
}

/** Express handler — mounted at /hook/cashfree-link/:slug with a RAW body. */
async function expressWebhook(req, res) {
  const raw = _rawBody(req);
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { payload = {}; }

  const ts  = req.headers['x-webhook-timestamp'];
  const sig = req.headers['x-webhook-signature'];

  // Signature is verified against the TENANT's own Cashfree secret, so this
  // must already be running inside the tenant's storage scope.
  let secret = '';
  try { secret = String((await db.getConfig('CASHFREE_SECRET_KEY', '')) || ''); } catch (_) {}

  if (secret && !verifySignature(raw, ts, sig, secret)) {
    console.warn('[cf-link-hook] signature mismatch — rejected');
    return res.status(401).json({ ok: false, error: 'signature verification failed' });
  }
  if (!secret) console.warn('[cf-link-hook] no CASHFREE_SECRET_KEY for tenant — processing UNVERIFIED');

  if (String(payload.type || '') !== 'PAYMENT_LINK_EVENT') {
    return res.json({ ok: true, ignored: 'not a PAYMENT_LINK_EVENT' });
  }

  let result;
  try { result = await applyLinkEvent(payload.data || {}); }
  catch (e) {
    console.error('[cf-link-hook] apply failed:', e.message);
    return res.status(200).json({ ok: false, error: e.message });  // 200 so Cashfree stops retrying a permanent error
  }
  return res.json(result);
}

module.exports = { expressWebhook, applyLinkEvent, verifySignature };
