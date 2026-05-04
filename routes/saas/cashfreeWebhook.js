/**
 * Cashfree webhook handler — POST /hook/cashfree
 *
 * Cashfree v3 webhooks send a JSON body and two signature headers:
 *   x-webhook-timestamp
 *   x-webhook-signature
 *
 * We verify the HMAC-SHA256 signature, then pattern-match on
 * `data.payment.payment_status` to decide what to do:
 *   SUCCESS  → mark signup paid, provision tenant, mark invoice paid
 *   FAILED   → mark signup abandoned, mark payment failed
 *   USER_DROPPED / CANCELLED → leave the signup in `pending` so the user
 *     can retry from the return URL
 *
 * The express handler MUST receive the raw body (not the parsed JSON
 * object) because the signature is computed over the exact bytes
 * Cashfree sent. server.js wires this up with `express.raw()`.
 */
const cashfree = require('./cashfree');
const provisioning = require('./provisioning');
const control = require('../../control/db');

async function expressWebhook(req, res) {
  const sig = req.headers['x-webhook-signature'];
  const ts  = req.headers['x-webhook-timestamp'];
  // req.body is a Buffer here because we used express.raw() at the route.
  const rawBody = req.body && req.body.toString ? req.body.toString('utf8') : String(req.body || '');
  let event;
  try {
    await cashfree.verifyWebhookSignature(rawBody, sig, ts);
    event = JSON.parse(rawBody);
  } catch (e) {
    console.warn('[cashfree-webhook] verify/parse failed:', e.message);
    // Always log the attempt for forensics
    try {
      await control.insert('audit_log', {
        actor_type: 'webhook', event: 'cashfree.verify_failed',
        detail: JSON.stringify({ error: e.message, ts, sig: sig?.slice(0, 16) })
      });
    } catch (_) {}
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const data = event.data || {};
  const order = data.order || {};
  const payment = data.payment || {};
  const orderId = order.order_id || data.order_id;
  const status  = String(payment.payment_status || data.event || event.type || '').toUpperCase();

  // Audit
  try {
    await control.insert('audit_log', {
      actor_type: 'webhook', event: 'cashfree.' + status.toLowerCase(),
      detail: JSON.stringify({ order_id: orderId, status, type: event.type })
    });
  } catch (_) {}

  // Look up the signup
  let signup = orderId ? await control.findOneBy('signups', 'cashfree_order_id', orderId) : null;
  if (!signup) {
    return res.json({ ok: true, note: 'No matching signup, ignored' });
  }

  // Persist a payments row (one per webhook event so we can audit)
  try {
    await control.insert('payments', {
      tenant_id: null,
      gateway: 'cashfree',
      gateway_order_id: orderId,
      gateway_txn_id: payment.cf_payment_id || null,
      amount_inr: Number(payment.payment_amount || order.order_amount || 0),
      status: status.toLowerCase(),
      raw_response: JSON.stringify(event)
    });
  } catch (_) {}

  if (status === 'SUCCESS' || status === 'PAID') {
    try {
      await control.update('signups', signup.id, { status: 'paid' });
      // Provision (idempotent — safe if webhook fires twice)
      const result = await provisioning.provisionFromSignup(signup.id);
      // Mark the latest invoice for this tenant as paid
      try {
        await control.query(
          `UPDATE invoices SET status = 'paid', paid_at = NOW()
            WHERE tenant_id = $1 AND status = 'pending'
            ORDER BY id DESC LIMIT 1`,
          [result.tenant_id]
        );
      } catch (_) {}
      return res.json({ ok: true, provisioned: true, slug: result.slug });
    } catch (e) {
      console.error('[cashfree-webhook] provisioning failed:', e.message, e.stack);
      try {
        await control.insert('audit_log', {
          actor_type: 'webhook', event: 'tenant.provision_failed',
          detail: JSON.stringify({ signup_id: signup.id, error: e.message })
        });
      } catch (_) {}
      return res.status(500).json({ error: 'Provisioning failed: ' + e.message });
    }
  }

  if (status === 'FAILED') {
    try { await control.update('signups', signup.id, { status: 'abandoned' }); } catch (_) {}
  }
  return res.json({ ok: true });
}

module.exports = { expressWebhook };
