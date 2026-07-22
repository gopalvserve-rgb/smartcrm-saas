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

  /* Record the individual transaction. Table is payment_link_txns (an earlier
   * draft wrote to a non-existent 'link_payments'). gateway_txn_id has a UNIQUE
   * index, so a Cashfree retry of the same event must not blow up — hence
   * ON CONFLICT DO NOTHING. */
  if (order.order_id) {
    try {
      await db.query(
        `INSERT INTO payment_link_txns (link_id, gateway_txn_id, amount_inr, status, payment_mode, paid_at, raw_json)
         VALUES ($1,$2,$3,$4,$5,NOW(),$6)
         ON CONFLICT (gateway_txn_id) DO NOTHING`,
        [row.id, String(order.transaction_id || order.order_id),
         Number(order.order_amount || 0), String(order.transaction_status || ''),
         '', JSON.stringify(data)]
      );
    } catch (e) { console.warn('[cf-link-hook] txn insert skipped:', e.message); }
  }
  return { ok: true, link_row_id: row.id, status: patch.status };
}

/* CF_LINK_LOG_v1 — persist EVERY webhook hit, including ones we reject.
 * A rejected/unmatched event is precisely what you need when a customer says
 * they paid, so this must never be gated behind a successful match. Sensitive
 * headers are redacted; the raw body is kept verbatim for signature re-checks. */
async function _logHit(fields) {
  try {
    await db.query(
      `INSERT INTO payment_link_logs
        (link_row_id, gateway, event_type, link_id, cf_link_id, link_status,
         amount_inr, amount_paid_inr, order_id, txn_id, signature_ok,
         http_status, outcome, error_text, headers_json, payload_json)
       VALUES ($1,'cashfree',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [fields.link_row_id || null, fields.event_type || null,
       fields.link_id || null, fields.cf_link_id || null, fields.link_status || null,
       fields.amount_inr == null ? null : Number(fields.amount_inr),
       fields.amount_paid_inr == null ? null : Number(fields.amount_paid_inr),
       fields.order_id || null, fields.txn_id || null,
       fields.signature_ok ? 1 : 0, fields.http_status || null,
       fields.outcome || null, fields.error_text || null,
       fields.headers_json || null, fields.payload_json || null]
    );
  } catch (e) { console.warn('[cf-link-hook] log write failed:', e.message); }
}

function _safeHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach(k => {
    const lk = String(k).toLowerCase();
    // Keep the signature/timestamp (needed to re-verify) but never store auth secrets.
    if (lk === 'authorization' || lk === 'cookie' || lk === 'x-client-secret') out[lk] = '***redacted***';
    else out[lk] = h[k];
  });
  return out;
}

/** Express handler — mounted at /hook/cashfree-link/:slug with a RAW body. */
async function expressWebhook(req, res) {
  /* Make sure payment_link_logs / payment_link_txns exist — a tenant may
   * receive a webhook before anyone has opened the Payments page, and
   * _ensureSchema is otherwise only triggered by the API handlers. */
  try { await require('./payments')._ensureSchema(); } catch (_) {}

  const raw = _rawBody(req);
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch (_) { payload = {}; }

  const ts  = req.headers['x-webhook-timestamp'];
  const sig = req.headers['x-webhook-signature'];
  const d   = payload.data || {};
  const ord = d.order || {};

  const base = {
    event_type: payload.type || null,
    link_id: d.link_id || null,
    cf_link_id: d.cf_link_id == null ? null : String(d.cf_link_id),
    link_status: d.link_status || null,
    amount_inr: d.link_amount == null ? null : d.link_amount,
    amount_paid_inr: d.link_amount_paid == null ? null : d.link_amount_paid,
    order_id: ord.order_id || null,
    txn_id: ord.transaction_id == null ? null : String(ord.transaction_id),
    headers_json: JSON.stringify(_safeHeaders(req.headers)),
    payload_json: raw ? String(raw).slice(0, 20000) : null
  };

  let secret = '';
  try { secret = String((await db.getConfig('CASHFREE_SECRET_KEY', '')) || ''); } catch (_) {}

  const sigOk = secret ? verifySignature(raw, ts, sig, secret) : false;

  if (secret && !sigOk) {
    console.warn('[cf-link-hook] signature mismatch — rejected');
    await _logHit(Object.assign({}, base, {
      signature_ok: 0, http_status: 401, outcome: 'rejected',
      error_text: 'signature verification failed'
    }));
    return res.status(401).json({ ok: false, error: 'signature verification failed' });
  }
  if (!secret) console.warn('[cf-link-hook] no CASHFREE_SECRET_KEY for tenant — processing UNVERIFIED');

  if (String(payload.type || '') !== 'PAYMENT_LINK_EVENT') {
    await _logHit(Object.assign({}, base, {
      signature_ok: sigOk || !secret ? 1 : 0, http_status: 200, outcome: 'ignored',
      error_text: 'not a PAYMENT_LINK_EVENT'
    }));
    return res.json({ ok: true, ignored: 'not a PAYMENT_LINK_EVENT' });
  }

  let result;
  try {
    result = await applyLinkEvent(d);
  } catch (e) {
    console.error('[cf-link-hook] apply failed:', e.message);
    await _logHit(Object.assign({}, base, {
      signature_ok: sigOk ? 1 : 0, http_status: 200, outcome: 'error', error_text: e.message
    }));
    return res.status(200).json({ ok: false, error: e.message });
  }

  await _logHit(Object.assign({}, base, {
    link_row_id: result.link_row_id || null,
    signature_ok: sigOk ? 1 : 0,
    http_status: 200,
    outcome: result.ok ? ('applied:' + (result.status || '')) : 'unmatched',
    error_text: result.ok ? null : (result.reason || null)
  }));
  return res.json(result);
}

module.exports = { expressWebhook, applyLinkEvent, verifySignature, _safeHeaders };
