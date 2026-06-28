/* ============================================================================
 * SaaS-level WhatsApp sender (SAAS_AUTO_INVOICE_v1, 2026-06-27)
 *
 * Sends WhatsApp Cloud API messages from the platform/super-admin side
 * (e.g. billing invoices to tenant contact phones), using credentials
 * stored in `saas_settings` keys: WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN,
 * WA_TEMPLATE_INVOICE, WA_TEMPLATE_LANG.
 *
 * Mirrors the tenant-side whatsbot.js Cloud API call pattern.
 * ============================================================================ */
'use strict';
const https = require('https');
const control = require('../../control/db');

const GRAPH_HOST = 'graph.facebook.com';
const GRAPH_VER  = 'v18.0';

async function _cfg() {
  const get = async k => (await control.getSetting(k)) || '';
  return {
    phone_id:       await get('WA_PHONE_NUMBER_ID'),
    waba_id:        await get('WA_BUSINESS_ID'),
    access_token:   await get('WA_ACCESS_TOKEN'),
    template_name:  (await get('WA_TEMPLATE_INVOICE')) || 'billing_invoice',
    template_lang:  (await get('WA_TEMPLATE_LANG')) || 'en_US'
  };
}

function _post(path, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: GRAPH_HOST,
      path: '/' + GRAPH_VER + path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 20000
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
          else reject(new Error('WA Cloud API ' + res.statusCode + ': ' + (j.error?.message || buf.slice(0,200))));
        } catch (e) { reject(new Error('WA bad response: ' + buf.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WA request timeout')); });
    req.write(data);
    req.end();
  });
}

/** Normalize phone to E.164 digits (10-15 chars). India +91 default. */
function normalizePhone(raw) {
  let s = String(raw || '').replace(/\D/g, '');
  if (s.length === 10) s = '91' + s;            // Indian mobile w/o country code
  if (s.startsWith('0')) s = s.slice(1);
  return s;
}

/** Send a template message — primary path because outside 24h session window
 *  every business-initiated message MUST use a template. */
async function sendTemplate({ to, templateName, templateLang, params }) {
  const cfg = await _cfg();
  if (!cfg.phone_id || !cfg.access_token) {
    throw new Error('SaaS WhatsApp not configured — set WA_PHONE_NUMBER_ID + WA_ACCESS_TOKEN in Settings');
  }
  const phone = normalizePhone(to);
  if (phone.length < 10) throw new Error('Invalid recipient phone: ' + to);

  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName || cfg.template_name,
      language: { code: templateLang || cfg.template_lang }
    }
  };
  if (Array.isArray(params) && params.length) {
    body.template.components = [{
      type: 'body',
      parameters: params.map(p => ({ type: 'text', text: String(p) }))
    }];
  }
  return _post('/' + cfg.phone_id + '/messages', cfg.access_token, body);
}

/** Send a plain text message — only works inside an open 24h session.
 *  Used for testing or reply scenarios. */
async function sendText({ to, text }) {
  const cfg = await _cfg();
  if (!cfg.phone_id || !cfg.access_token) {
    throw new Error('SaaS WhatsApp not configured');
  }
  const phone = normalizePhone(to);
  return _post('/' + cfg.phone_id + '/messages', cfg.access_token, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: String(text || '').slice(0, 4000) }
  });
}

/** Super-admin API: test the WA setup by sending a template message to your own number. */
async function api_saas_settings_testWhatsApp(token, payload) {
  const { requireFullAdmin } = require('./superAdminAuth');
  await requireFullAdmin(token);
  const p = payload || {};
  const to = p.to || (await control.getSetting('SUPPORT_PHONE')) || '';
  if (!to) throw new Error('Provide a "to" phone in payload (or set SUPPORT_PHONE in settings)');
  try {
    const r = await sendTemplate({
      to,
      templateName: p.template || null,
      templateLang: p.lang || null,
      params: p.params || ['Test Tenant', 'INV-TEST-001', '₹1,234', new Date().toLocaleDateString('en-IN')]
    });
    return { ok: true, sent_to: normalizePhone(to), wa_response: r };
  } catch (e) {
    throw new Error('WA test failed: ' + e.message);
  }
}

module.exports = {
  sendTemplate,
  sendText,
  api_saas_settings_testWhatsApp
};
