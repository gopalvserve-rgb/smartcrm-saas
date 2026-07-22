/**
 * routes/payments.js — PAYMENTS_v1 (Cashfree + Razorpay)
 *
 * Tenant module for accepting payments via Cashfree or Razorpay
 * payment links. Phase 1 surface:
 *
 *   api_payments_settings_get / save / test_connection
 *   api_payments_link_create / list / get / cancel / sync_status
 *   api_payments_link_send         (SMS / WA / email re-share)
 *   api_payments_customers_list    (aggregate active customers)
 *
 * Config keys (under tenant config table):
 *   PAYMENTS_ACTIVE_GATEWAY     'cashfree' | 'razorpay' | ''
 *   CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_MODE       (live|test)
 *   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_MODE       (live|test)
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const CF_URLS  = { live: 'https://api.cashfree.com/pg',   test: 'https://sandbox.cashfree.com/pg' };
const RZ_URL   = 'https://api.razorpay.com/v1';
/* CF_LINKS_FIX_v1 — current Cashfree PG API version (was 2023-08-01). */
const CF_API_VERSION = '2025-01-01';

function _mask(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 6) return '••••';
  return '••••••••' + str.slice(-4);
}
function _cfg(k) {
  return db.getConfig(k).then(v => v == null ? '' : String(v)).catch(() => '');
}
async function _requireAdmin(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  return me;
}
// PAYMENTS_v1.1 (2026-06-23) — idempotent schema bootstrap.
// schema.sql changes don't auto-apply to existing tenant DBs; this
// ensures tables exist on first call. Runs once per process per tenant
// (cached on the pool object).
const _schemaEnsured = new WeakSet();
async function _ensureSchema() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _schemaEnsured.has(pool)) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS payment_links (
      id                     SERIAL PRIMARY KEY,
      gateway                TEXT NOT NULL,
      gateway_mode           TEXT NOT NULL DEFAULT 'live',
      gateway_link_id        TEXT,
      gateway_short_url      TEXT,
      link_id_custom         TEXT,
      link_type              TEXT NOT NULL DEFAULT 'one_time_all',
      description            TEXT NOT NULL DEFAULT '',
      amount_inr             NUMERIC(10,2) NOT NULL DEFAULT 0,
      currency               TEXT NOT NULL DEFAULT 'INR',
      allow_partial          INTEGER NOT NULL DEFAULT 0,
      min_partial_inr        NUMERIC(10,2),
      customer_phone         TEXT,
      customer_email         TEXT,
      customer_name          TEXT,
      send_sms               INTEGER NOT NULL DEFAULT 0,
      send_whatsapp          INTEGER NOT NULL DEFAULT 0,
      send_email             INTEGER NOT NULL DEFAULT 0,
      allow_invoice_download INTEGER NOT NULL DEFAULT 0,
      expire_at              TIMESTAMPTZ,
      redirect_url           TEXT,
      thank_you_message      TEXT,
      terms_conditions       TEXT,
      status                 TEXT NOT NULL DEFAULT 'created',
      amount_paid_inr        NUMERIC(10,2) NOT NULL DEFAULT 0,
      paid_txn_count         INTEGER NOT NULL DEFAULT 0,
      paid_at                TIMESTAMPTZ,
      payment_mode           TEXT,
      lead_id                INTEGER,
      created_by             INTEGER,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta_json              JSONB
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_status  ON payment_links(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_phone   ON payment_links(customer_phone)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_created ON payment_links(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_links_lead    ON payment_links(lead_id)`);
    await db.query(`CREATE TABLE IF NOT EXISTS payment_link_txns (
      id              SERIAL PRIMARY KEY,
      link_id         INTEGER NOT NULL REFERENCES payment_links(id) ON DELETE CASCADE,
      gateway_txn_id  TEXT NOT NULL,
      amount_inr      NUMERIC(10,2) NOT NULL,
      status          TEXT NOT NULL,
      payment_mode    TEXT,
      paid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_json        JSONB
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_txns_link ON payment_link_txns(link_id)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_txns_gtxn ON payment_link_txns(gateway_txn_id)`);

    /* CF_LINK_LOG_v1 (2026-07-20) — every Cashfree webhook hit for a payment
     * link, stored verbatim. Keeps the raw signed body + headers + what we did
     * with it, so a "customer paid but the CRM says unpaid" dispute is
     * answerable from data. Rows are written even when signature verification
     * FAILS or no link matches — those are exactly the cases worth seeing. */
    await db.query(`CREATE TABLE IF NOT EXISTS payment_link_logs (
      id              SERIAL PRIMARY KEY,
      link_row_id     INTEGER,
      gateway         TEXT DEFAULT 'cashfree',
      event_type      TEXT,
      link_id         TEXT,
      cf_link_id      TEXT,
      link_status     TEXT,
      amount_inr      NUMERIC,
      amount_paid_inr NUMERIC,
      order_id        TEXT,
      txn_id          TEXT,
      signature_ok    INTEGER,
      http_status     INTEGER,
      outcome         TEXT,
      error_text      TEXT,
      headers_json    TEXT,
      payload_json    TEXT,
      received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_pl_logs_link ON payment_link_logs(link_row_id, received_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_pl_logs_time ON payment_link_logs(received_at DESC)`);
    if (pool) _schemaEnsured.add(pool);
  } catch (e) {
    console.warn('[payments] _ensureSchema failed:', e.message);
  }
}

async function _fetch() {
  return (typeof globalThis.fetch === 'function') ? globalThis.fetch : (await import('node-fetch')).default;
}

// ═══════════════ Settings ═══════════════
async function api_payments_settings_get(token) {
  await _ensureSchema();
  await _requireAdmin(token);
  const [active, cfId, cfSec, cfMode, rzId, rzSec, rzMode] = await Promise.all([
    _cfg('PAYMENTS_ACTIVE_GATEWAY'),
    _cfg('CASHFREE_APP_ID'), _cfg('CASHFREE_SECRET_KEY'), _cfg('CASHFREE_MODE'),
    _cfg('RAZORPAY_KEY_ID'), _cfg('RAZORPAY_KEY_SECRET'), _cfg('RAZORPAY_MODE')
  ]);
  return {
    active_gateway: active || '',
    cashfree: {
      app_id: cfId || '',
      has_secret: !!cfSec,
      secret_masked: _mask(cfSec),
      mode: cfMode || 'live'
    },
    razorpay: {
      key_id: rzId || '',
      has_secret: !!rzSec,
      secret_masked: _mask(rzSec),
      mode: rzMode || 'live'
    }
  };
}
async function api_payments_settings_save(token, payload) {
  await _ensureSchema();
  await _requireAdmin(token);
  const p = payload || {};
  const writes = [];
  if ('active_gateway' in p) {
    const v = String(p.active_gateway || '').toLowerCase();
    if (v && !['cashfree', 'razorpay'].includes(v)) throw new Error('active_gateway must be cashfree | razorpay | (blank)');
    writes.push(db.setConfig('PAYMENTS_ACTIVE_GATEWAY', v));
  }
  if (p.cashfree) {
    if ('app_id' in p.cashfree) writes.push(db.setConfig('CASHFREE_APP_ID', String(p.cashfree.app_id || '').trim()));
    if (p.cashfree.secret_key != null) {
      const v = String(p.cashfree.secret_key || '').trim();
      if (!v.startsWith('••••')) writes.push(db.setConfig('CASHFREE_SECRET_KEY', v));
    }
    if ('mode' in p.cashfree) writes.push(db.setConfig('CASHFREE_MODE', ['live', 'test'].includes(String(p.cashfree.mode || '').toLowerCase()) ? String(p.cashfree.mode).toLowerCase() : 'live'));
  }
  if (p.razorpay) {
    if ('key_id' in p.razorpay) writes.push(db.setConfig('RAZORPAY_KEY_ID', String(p.razorpay.key_id || '').trim()));
    if (p.razorpay.key_secret != null) {
      const v = String(p.razorpay.key_secret || '').trim();
      if (!v.startsWith('••••')) writes.push(db.setConfig('RAZORPAY_KEY_SECRET', v));
    }
    if ('mode' in p.razorpay) writes.push(db.setConfig('RAZORPAY_MODE', ['live', 'test'].includes(String(p.razorpay.mode || '').toLowerCase()) ? String(p.razorpay.mode).toLowerCase() : 'live'));
  }
  await Promise.all(writes);
  return { ok: true };
}

// Hit gateway with a tiny GET to confirm creds work
async function api_payments_test_connection(token, gateway) {
  await _ensureSchema();
  await _requireAdmin(token);
  const gw = String(gateway || '').toLowerCase();
  if (gw === 'cashfree') {
    const id = await _cfg('CASHFREE_APP_ID');
    const sec = await _cfg('CASHFREE_SECRET_KEY');
    const mode = (await _cfg('CASHFREE_MODE')) || 'live';
    if (!id || !sec) return { ok: false, error: 'Cashfree App ID + Secret Key required. Save them first.' };
    const fetch = await _fetch();
    try {
      // POST /pg/links with no body returns a 400 if credentials are valid (validation error),
      // 401/403 if creds are bad. We use that to verify creds without creating anything.
      const r = await fetch(CF_URLS[mode] + '/links', {
        method: 'POST',
        headers: { 'x-client-id': id, 'x-client-secret': sec, 'x-api-version': CF_API_VERSION, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (r.status === 401 || r.status === 403) {
        const body = await r.text().catch(() => '');
        return { ok: false, error: 'Cashfree rejected credentials (HTTP ' + r.status + '). ' + body.slice(0, 200) };
      }
      return { ok: true, message: 'Cashfree connection OK (mode: ' + mode + ')' };
    } catch (e) { return { ok: false, error: 'Network: ' + (e && e.message) }; }
  }
  if (gw === 'razorpay') {
    const id = await _cfg('RAZORPAY_KEY_ID');
    const sec = await _cfg('RAZORPAY_KEY_SECRET');
    if (!id || !sec) return { ok: false, error: 'Razorpay Key ID + Key Secret required. Save them first.' };
    const fetch = await _fetch();
    try {
      const auth = Buffer.from(id + ':' + sec).toString('base64');
      const r = await fetch(RZ_URL + '/payment_links?count=1', {
        method: 'GET',
        headers: { Authorization: 'Basic ' + auth }
      });
      if (r.status === 401) return { ok: false, error: 'Razorpay rejected credentials (HTTP 401).' };
      if (!r.ok) return { ok: false, error: 'Razorpay returned HTTP ' + r.status };
      return { ok: true, message: 'Razorpay connection OK' };
    } catch (e) { return { ok: false, error: 'Network: ' + (e && e.message) }; }
  }
  return { ok: false, error: 'gateway required (cashfree | razorpay)' };
}

// ═══════════════ Gateway clients (create link) ═══════════════
/* ── Cashfree helpers (CF_LINKS_FIX_v1, 2026-07-20) ────────────────────────
 * Spec: https://www.cashfree.com/docs/api-reference/payments/latest/payment-links
 * Required on create: link_amount, link_currency, customer_details
 * (customer_phone), link_purpose. link_notes = max 5 STRING values.
 * link_expiry_time must be full ISO-8601 WITH offset.
 */
async function _cfCreds() {
  const [id, sec, mode] = await Promise.all([
    _cfg('CASHFREE_APP_ID'), _cfg('CASHFREE_SECRET_KEY'), _cfg('CASHFREE_MODE')
  ]);
  if (!id || !sec) throw new Error('Cashfree not configured. Go to Payments → Settings.');
  return { id, sec, mode: (mode || 'live').toLowerCase() };
}
function _cfHeaders(id, sec) {
  return {
    'x-client-id': id, 'x-client-secret': sec,
    'x-api-version': CF_API_VERSION, 'Content-Type': 'application/json',
    'x-request-id': 'smartcrm-' + Date.now()
  };
}
/* Cashfree returns {message, code, type, help}. Surface ALL of it — the old
 * code showed a bare "API error" which told the user nothing. */
function _cfErr(j, status, requestId) {
  const bits = [];
  if (j && j.message) bits.push(j.message);
  if (j && j.code)    bits.push('[' + j.code + ']');
  if (j && j.type)    bits.push('(' + j.type + ')');
  if (!bits.length)   bits.push('HTTP ' + status);
  if (requestId)      bits.push('· req ' + requestId);
  return 'Cashfree: ' + bits.join(' ');
}
/* link_id: merchant reference used by GET/cancel/orders. Alphanumeric plus
 * - and _ only, max 50. We ALWAYS send one — without it we could not call the
 * other link APIs later (cf_link_id is NOT accepted there). */
function _cfLinkId(custom) {
  const raw = String(custom || '').trim();
  if (raw) return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
  return ('scrm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)).slice(0, 50);
}
/* Cashfree needs ISO-8601 WITH a timezone offset. A datetime-local input gives
 * "2026-07-25T15:04" which Cashfree rejects — normalise to +05:30. */
function _cfExpiry(v) {
  if (!v) return undefined;
  const str = String(v).trim();
  if (/[+-]\d{2}:\d{2}$|Z$/.test(str)) return str;      // already has offset
  const d = new Date(str);
  if (isNaN(d.getTime())) return undefined;
  const pad = n => String(n).padStart(2, '0');
  // Render in IST (+05:30) — Cashfree accounts here are India-based.
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60000);
  return ist.getUTCFullYear() + '-' + pad(ist.getUTCMonth() + 1) + '-' + pad(ist.getUTCDate())
       + 'T' + pad(ist.getUTCHours()) + ':' + pad(ist.getUTCMinutes()) + ':' + pad(ist.getUTCSeconds())
       + '+05:30';
}
/* link_notes: max 5 pairs, values MUST be non-empty strings. The old code
 * always sent {thank_you:'', terms:''} — empty values get rejected. */
function _cfNotes(opts) {
  const notes = {};
  const add = (k, v) => {
    const val = String(v == null ? '' : v).trim();
    if (val && Object.keys(notes).length < 5) notes[k] = val.slice(0, 200);
  };
  add('thank_you', opts.thank_you_message);
  add('terms', opts.terms_conditions);
  if (opts.lead_id) add('lead_id', opts.lead_id);
  return Object.keys(notes).length ? notes : undefined;
}

async function _cashfreeCreateLink(opts) {
  const fetch = await _fetch();
  const { id, sec, mode } = await _cfCreds();
  const linkId = _cfLinkId(opts.link_id_custom);

  const customer = { customer_phone: String(opts.customer_phone || '').replace(/\D/g, '') };
  if (opts.customer_email) customer.customer_email = String(opts.customer_email).trim();
  if (opts.customer_name)  customer.customer_name  = String(opts.customer_name).trim();
  if (!customer.customer_phone) throw new Error('Cashfree requires a customer phone number.');

  const meta = {};
  if (opts.redirect_url) meta.return_url = String(opts.redirect_url).trim();
  if (opts.notify_url)   meta.notify_url = String(opts.notify_url).trim();
  if (opts.link_type === 'one_time_upi') { meta.payment_methods = 'upi'; meta.upi_intent = 'true'; }

  const body = {
    link_id: linkId,
    link_amount: Number(opts.amount_inr),
    link_currency: 'INR',
    link_purpose: String(opts.description || 'Payment').slice(0, 500),
    customer_details: customer,
    link_partial_payments: !!opts.allow_partial,
    link_notify: { send_sms: !!opts.send_sms, send_email: !!(opts.send_email && customer.customer_email) },
    link_auto_reminders: false
  };
  if (opts.allow_partial && opts.min_partial_inr) body.link_minimum_partial_amount = Number(opts.min_partial_inr);
  const exp = _cfExpiry(opts.expire_at); if (exp) body.link_expiry_time = exp;
  const notes = _cfNotes(opts);          if (notes) body.link_notes = notes;
  if (Object.keys(meta).length) body.link_meta = meta;

  const headers = _cfHeaders(id, sec);
  const r = await fetch(CF_URLS[mode] + '/links', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(_cfErr(j, r.status, r.headers && r.headers.get && r.headers.get('x-request-id')));
    e.cf_request = body; e.cf_response = j; e.cf_status = r.status;
    throw e;
  }
  return {
    gateway_link_id: j.cf_link_id || j.link_id,
    merchant_link_id: j.link_id || linkId,
    gateway_short_url: j.link_url,
    gateway_mode: mode,
    request: body,
    raw: j
  };
}

/* Fetch Payment Link details — GET /links/{link_id} (merchant link_id). */
async function _cashfreeGetLink(linkId) {
  const fetch = await _fetch();
  const { id, sec, mode } = await _cfCreds();
  const r = await fetch(CF_URLS[mode] + '/links/' + encodeURIComponent(linkId), {
    method: 'GET', headers: _cfHeaders(id, sec)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(_cfErr(j, r.status));
  return j;
}

/* Cancel Payment Link — POST /links/{link_id}/cancel. */
async function _cashfreeCancelLink(linkId) {
  const fetch = await _fetch();
  const { id, sec, mode } = await _cfCreds();
  const r = await fetch(CF_URLS[mode] + '/links/' + encodeURIComponent(linkId) + '/cancel', {
    method: 'POST', headers: _cfHeaders(id, sec)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(_cfErr(j, r.status));
  return j;
}

/* Orders created against a link — GET /links/{link_id}/orders. */
async function _cashfreeLinkOrders(linkId) {
  const fetch = await _fetch();
  const { id, sec, mode } = await _cfCreds();
  const r = await fetch(CF_URLS[mode] + '/links/' + encodeURIComponent(linkId) + '/orders', {
    method: 'GET', headers: _cfHeaders(id, sec)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(_cfErr(j, r.status));
  return Array.isArray(j) ? j : (j.orders || j.data || []);
}
async function _razorpayCreateLink(opts) {
  const fetch = await _fetch();
  const [id, sec, mode] = await Promise.all([_cfg('RAZORPAY_KEY_ID'), _cfg('RAZORPAY_KEY_SECRET'), _cfg('RAZORPAY_MODE')]);
  if (!id || !sec) throw new Error('Razorpay not configured. Go to Payments → Settings.');
  const body = {
    amount: Math.round(Number(opts.amount_inr) * 100), // Razorpay wants paise
    currency: 'INR',
    accept_partial: !!opts.allow_partial,
    first_min_partial_amount: opts.allow_partial && opts.min_partial_inr ? Math.round(Number(opts.min_partial_inr) * 100) : undefined,
    description: String(opts.description || 'Payment').slice(0, 2048),
    customer: {
      name: opts.customer_name || undefined,
      contact: opts.customer_phone ? '+91' + String(opts.customer_phone).replace(/\D/g, '').slice(-10) : undefined,
      email: opts.customer_email || undefined
    },
    notify: { sms: !!opts.send_sms, email: !!opts.send_email },
    reminder_enable: false,
    callback_url: opts.redirect_url || undefined,
    callback_method: opts.redirect_url ? 'get' : undefined,
    upi_link: opts.link_type === 'one_time_upi'
  };
  if (opts.expire_at) body.expire_by = Math.floor(new Date(opts.expire_at).getTime() / 1000);
  const auth = Buffer.from(id + ':' + sec).toString('base64');
  const r = await fetch(RZ_URL + '/payment_links', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && j.error && (j.error.description || j.error.code)) || ('Razorpay HTTP ' + r.status);
    throw new Error('Razorpay: ' + msg);
  }
  return {
    gateway_link_id: j.id,
    gateway_short_url: j.short_url,
    gateway_mode: (mode || 'live').toLowerCase(),
    raw: j
  };
}

// ═══════════════ Payment Links ═══════════════
async function api_payments_link_create(token, payload) {
  await _ensureSchema();
  const me = await _requireAdmin(token);
  const p = payload || {};
  if (!p.amount_inr || Number(p.amount_inr) <= 0) throw new Error('amount_inr is required and must be > 0');
  if (!p.customer_phone) throw new Error('customer phone is required');
  const gateway = String(p.gateway || (await _cfg('PAYMENTS_ACTIVE_GATEWAY'))).toLowerCase();
  if (!gateway) throw new Error('No payment gateway active. Go to Payments → Settings.');

  /* CF_LINKS_FIX_v1 — auto-point Cashfree at this tenant's webhook so paid /
   * partially-paid / expired / cancelled events update the row automatically. */
  if (!p.notify_url) {
    try {
      const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
      const slug = store && store.slug;
      const base = String(process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
      if (slug) p.notify_url = base + '/hook/cashfree-link/' + slug;
    } catch (_) {}
  }

  let r;
  if (gateway === 'cashfree') r = await _cashfreeCreateLink(p);
  else if (gateway === 'razorpay') r = await _razorpayCreateLink(p);
  else throw new Error('Unsupported gateway: ' + gateway);

  // Persist
  const id = await db.insert('payment_links', {
    gateway,
    gateway_mode: r.gateway_mode,
    gateway_link_id: r.gateway_link_id || '',
    gateway_short_url: r.gateway_short_url || '',
    link_id_custom: r.merchant_link_id || p.link_id_custom || null,   /* CF_LINKS_FIX_v1 — merchant link_id drives GET/cancel/orders */
    link_type: p.link_type || 'one_time_all',
    description: p.description || '',
    amount_inr: Number(p.amount_inr),
    currency: 'INR',
    allow_partial: p.allow_partial ? 1 : 0,
    min_partial_inr: p.min_partial_inr || null,
    customer_phone: String(p.customer_phone || '').replace(/\D/g, ''),
    customer_email: p.customer_email || null,
    customer_name: p.customer_name || null,
    send_sms: p.send_sms ? 1 : 0,
    send_whatsapp: p.send_whatsapp ? 1 : 0,
    send_email: p.send_email ? 1 : 0,
    allow_invoice_download: p.allow_invoice_download ? 1 : 0,
    expire_at: p.expire_at || null,
    redirect_url: p.redirect_url || null,
    thank_you_message: p.thank_you_message || null,
    terms_conditions: p.terms_conditions || null,
    status: 'created',
    lead_id: p.lead_id || null,
    created_by: me.id,
    meta_json: r.raw ? JSON.stringify(r.raw) : null
  });

  // Best-effort: send WhatsApp via our existing wa_chat_send if requested
  if (p.send_whatsapp && r.gateway_short_url) {
    try {
      const phone = String(p.customer_phone || '').replace(/\D/g, '').slice(-10);
      if (phone) {
        const wb = require('./whatsbot');
        if (wb && typeof wb.api_wb_chat_send === 'function') {
          const txt = (p.customer_name ? 'Hi ' + p.customer_name + ', ' : 'Hi, ') +
                      'please complete your payment: ' + r.gateway_short_url +
                      (p.amount_inr ? '\nAmount: ₹' + Number(p.amount_inr).toLocaleString('en-IN') : '');
          await wb.api_wb_chat_send(token, { phone: phone, text: txt }).catch(() => {});
        }
      }
    } catch (_) {}
  }

  return { ok: true, id, gateway_link_id: r.gateway_link_id, short_url: r.gateway_short_url };
}

async function api_payments_link_list(token, filters) {
  await _ensureSchema();
  await _requireAdmin(token);
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.status) { params.push(String(f.status)); where.push('status = $' + params.length); }
  if (f.phone)  { params.push('%' + String(f.phone).replace(/\D/g, '') + '%'); where.push('customer_phone LIKE $' + params.length); }
  if (f.q) {
    params.push('%' + String(f.q).toLowerCase() + '%');
    where.push('(LOWER(description) LIKE $' + params.length + ' OR LOWER(COALESCE(customer_name,\'\')) LIKE $' + params.length +
               ' OR LOWER(COALESCE(customer_email,\'\')) LIKE $' + params.length + ' OR customer_phone LIKE $' + params.length + ')');
  }
  if (f.range === 'today') {
    where.push("created_at >= date_trunc('day', NOW())");
  } else if (f.range === 'last7') {
    where.push("created_at >= NOW() - INTERVAL '7 days'");
  } else if (f.range === 'last30') {
    where.push("created_at >= NOW() - INTERVAL '30 days'");
  }
  const sql = `SELECT id, gateway, gateway_mode, gateway_link_id, gateway_short_url,
                      link_id_custom, link_type, description, amount_inr, currency,
                      customer_phone, customer_email, customer_name,
                      status, amount_paid_inr, paid_at, payment_mode, paid_txn_count,
                      send_sms, send_whatsapp, send_email,
                      lead_id, created_by, created_at, updated_at
                 FROM payment_links
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT 500`;
  const r = await db.query(sql, params);
  return r.rows;
}
async function api_payments_link_get(token, id) {
  await _ensureSchema();
  await _requireAdmin(token);
  const row = await db.findById('payment_links', id);
  if (!row) throw new Error('Link not found');
  /* CF_LINKS_FIX_v1 — this used to return only our local row, so the status
   * never reflected reality. Now refresh from Cashfree on read. */
  if (row.gateway === 'cashfree' && row.link_id_custom) {
    try {
      const live = await _cashfreeGetLink(row.link_id_custom);
      const status = _cfStatusToLocal(live.link_status);
      const paid = Number(live.link_amount_paid || 0);
      const patch = { updated_at: db.nowIso() };
      if (status && status !== row.status) patch.status = status;
      if (paid !== Number(row.amount_paid_inr || 0)) patch.amount_paid_inr = paid;
      if (live.link_url && !row.gateway_short_url) patch.gateway_short_url = live.link_url;
      if (Object.keys(patch).length > 1) { await db.update('payment_links', id, patch); Object.assign(row, patch); }
      row.live = live;
    } catch (e) { row.live_error = e.message; }
  }
  return row;
}

/* Cashfree link_status -> our local status vocabulary. */
function _cfStatusToLocal(st) {
  switch (String(st || '').toUpperCase()) {
    case 'PAID':           return 'paid';
    case 'PARTIALLY_PAID': return 'partial';
    case 'EXPIRED':        return 'expired';
    case 'CANCELLED':      return 'cancelled';
    case 'ACTIVE':         return 'created';
    default:               return '';
  }
}

/* Orders raised against a payment link (docs: get-orders-for-link). */
async function api_payments_link_orders(token, id) {
  await _ensureSchema();
  await _requireAdmin(token);
  const row = await db.findById('payment_links', id);
  if (!row) throw new Error('Link not found');
  if (row.gateway !== 'cashfree') return { orders: [], note: 'Only supported for Cashfree links' };
  if (!row.link_id_custom) return { orders: [], note: 'This link was created before link_id tracking — recreate it to use this.' };
  const orders = await _cashfreeLinkOrders(row.link_id_custom);
  return { orders };
}
async function api_payments_link_cancel(token, id) {
  await _ensureSchema();
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  const row = await db.findById('payment_links', id);
  if (!row) throw new Error('Link not found');
  /* CF_LINKS_FIX_v1 — previously this only flipped OUR row to 'cancelled' and
   * never told Cashfree, so the link stayed live and payable. */
  let cfResult = null;
  if (row.gateway === 'cashfree' && row.link_id_custom) {
    cfResult = await _cashfreeCancelLink(row.link_id_custom);   // throws on failure — do not lie to the user
  }
  await db.update('payment_links', id, { status: 'cancelled', updated_at: db.nowIso() });
  return { ok: true, cashfree: cfResult };
}

// Re-share the same payment link via WA / SMS / email
async function api_payments_link_send(token, payload) {
  await _ensureSchema();
  await _requireAdmin(token);
  const p = payload || {};
  if (!p.id) throw new Error('id required');
  const link = await db.findById('payment_links', p.id);
  if (!link) throw new Error('Link not found');
  const channel = String(p.channel || '').toLowerCase();
  const url = link.gateway_short_url;
  if (!url) throw new Error('Payment link has no short_url');
  const txt = (link.customer_name ? 'Hi ' + link.customer_name + ', ' : 'Hi, ') +
              'please complete your payment: ' + url +
              (link.amount_inr ? '\nAmount: ₹' + Number(link.amount_inr).toLocaleString('en-IN') : '');
  if (channel === 'whatsapp') {
    const phone = String(link.customer_phone || '').replace(/\D/g, '').slice(-10);
    if (!phone) throw new Error('No customer phone on this link');
    const wb = require('./whatsbot');
    if (!wb || typeof wb.api_wb_chat_send !== 'function') throw new Error('WhatsApp module unavailable');
    await wb.api_wb_chat_send(token, { phone: phone, text: txt });
    return { ok: true, channel: 'whatsapp' };
  }
  if (channel === 'email') {
    if (!link.customer_email) throw new Error('No customer email on this link');
    // Best-effort delegate to admin email helper
    try {
      const adm = require('./admin');
      if (adm && typeof adm.api_admin_sendEmail === 'function') {
        await adm.api_admin_sendEmail(token, { to: link.customer_email, subject: 'Payment Link', body_html: '<p>' + txt.replace(/\n/g, '<br>') + '</p>' });
      } else {
        throw new Error('Email module unavailable on this tenant');
      }
    } catch (e) { throw new Error('Email send failed: ' + e.message); }
    return { ok: true, channel: 'email' };
  }
  if (channel === 'sms') {
    return { ok: false, error: 'SMS gateway not configured. Use WhatsApp or email for now.' };
  }
  throw new Error('channel must be whatsapp | email | sms');
}

// ═══════════════ Customers (aggregate) ═══════════════
async function api_payments_customers_list(token, filters) {
  await _ensureSchema();
  await _requireAdmin(token);
  const f = filters || {};
  const params = [];
  let dateClause = '';
  if (f.range === 'last7') dateClause = "AND created_at >= NOW() - INTERVAL '7 days'";
  else if (f.range === 'last30') dateClause = "AND created_at >= NOW() - INTERVAL '30 days'";
  else if (f.range === 'today') dateClause = "AND created_at >= date_trunc('day', NOW())";

  const sql = `
    SELECT
      customer_phone AS phone,
      MAX(customer_email) AS latest_email,
      MAX(customer_name)  AS latest_name,
      SUM(amount_paid_inr) AS total_spends,
      SUM(paid_txn_count)  AS total_paid_txns,
      MAX(paid_at)         AS last_transacted_at,
      MODE() WITHIN GROUP (ORDER BY payment_mode) AS preferred_mode
    FROM payment_links
    WHERE customer_phone IS NOT NULL
      AND customer_phone <> ''
      AND amount_paid_inr > 0
      ${dateClause}
    GROUP BY customer_phone
    ORDER BY last_transacted_at DESC NULLS LAST
    LIMIT 500`;
  const r = await db.query(sql, params);
  return r.rows;
}

/* CF_LINK_LOG_v1 — webhook activity log. {link_id} for one link's history,
 * omit it for the newest events across all links, {only_failed:1} to triage. */
async function api_payments_link_logs(token, payload) {
  await _ensureSchema();
  await _requireAdmin(token);
  const p = payload || {};
  const lim = Math.min(200, Math.max(1, Number(p.limit) || 50));
  const where = []; const params = [];
  if (p.link_id)    { params.push(Number(p.link_id)); where.push('link_row_id = $' + params.length); }
  if (p.only_failed) where.push('(signature_ok = 0 OR error_text IS NOT NULL)');
  const r = await db.query(
    `SELECT * FROM payment_link_logs
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY received_at DESC LIMIT ${lim}`, params);
  return { logs: r.rows };
}

module.exports = {
  api_payments_settings_get, api_payments_settings_save, api_payments_test_connection,
  api_payments_link_create, api_payments_link_list, api_payments_link_get,
  api_payments_link_cancel, api_payments_link_send,
  api_payments_link_orders,          /* CF_LINKS_FIX_v1 */
  api_payments_link_logs,            /* CF_LINK_LOG_v1 */
  _ensureSchema,                     /* webhook calls this so the log table exists on a cold tenant */
  _cfStatusToLocal,                 /* used by the webhook */
  api_payments_customers_list
};
