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
const CF_API_VERSION = '2023-08-01';

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
async function _fetch() {
  return (typeof globalThis.fetch === 'function') ? globalThis.fetch : (await import('node-fetch')).default;
}

// ═══════════════ Settings ═══════════════
async function api_payments_settings_get(token) {
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
async function _cashfreeCreateLink(opts) {
  const fetch = await _fetch();
  const [id, sec, mode] = await Promise.all([_cfg('CASHFREE_APP_ID'), _cfg('CASHFREE_SECRET_KEY'), _cfg('CASHFREE_MODE')]);
  if (!id || !sec) throw new Error('Cashfree not configured. Go to Payments → Settings.');
  const linkMode = (mode || 'live').toLowerCase();
  const body = {
    link_amount: Number(opts.amount_inr),
    link_currency: 'INR',
    link_purpose: String(opts.description || 'Payment').slice(0, 500),
    customer_details: {
      customer_phone: String(opts.customer_phone || '').replace(/\D/g, ''),
      customer_email: opts.customer_email || undefined,
      customer_name: opts.customer_name || undefined
    },
    link_partial_payments: opts.allow_partial ? true : false,
    link_minimum_partial_amount: opts.allow_partial && opts.min_partial_inr ? Number(opts.min_partial_inr) : undefined,
    link_notify: {
      send_sms: !!opts.send_sms,
      send_email: !!opts.send_email
    },
    link_meta: {
      return_url: opts.redirect_url || undefined,
      payment_methods: opts.link_type === 'one_time_upi' ? 'upi' : undefined
    },
    link_expiry_time: opts.expire_at || undefined,
    link_id: opts.link_id_custom || undefined,
    link_auto_reminders: false,
    link_notes: { thank_you: opts.thank_you_message || '', terms: opts.terms_conditions || '' }
  };
  const r = await fetch(CF_URLS[linkMode] + '/links', {
    method: 'POST',
    headers: { 'x-client-id': id, 'x-client-secret': sec, 'x-api-version': CF_API_VERSION, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && (j.message || j.error_description || j.code)) || ('Cashfree HTTP ' + r.status);
    throw new Error('Cashfree: ' + msg);
  }
  return {
    gateway_link_id: j.cf_link_id || j.link_id,
    gateway_short_url: j.link_url,
    gateway_mode: linkMode,
    raw: j
  };
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
  const me = await _requireAdmin(token);
  const p = payload || {};
  if (!p.amount_inr || Number(p.amount_inr) <= 0) throw new Error('amount_inr is required and must be > 0');
  if (!p.customer_phone) throw new Error('customer phone is required');
  const gateway = String(p.gateway || (await _cfg('PAYMENTS_ACTIVE_GATEWAY'))).toLowerCase();
  if (!gateway) throw new Error('No payment gateway active. Go to Payments → Settings.');

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
    link_id_custom: p.link_id_custom || null,
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
  await _requireAdmin(token);
  return await db.findById('payment_links', id);
}
async function api_payments_link_cancel(token, id) {
  await _requireAdmin(token);
  if (!id) throw new Error('id required');
  await db.update('payment_links', id, { status: 'cancelled', updated_at: db.nowIso() });
  return { ok: true };
}

// Re-share the same payment link via WA / SMS / email
async function api_payments_link_send(token, payload) {
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

module.exports = {
  api_payments_settings_get, api_payments_settings_save, api_payments_test_connection,
  api_payments_link_create, api_payments_link_list, api_payments_link_get,
  api_payments_link_cancel, api_payments_link_send,
  api_payments_customers_list
};
