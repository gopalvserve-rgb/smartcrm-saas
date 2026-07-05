'use strict';
/**
 * SAAS_WA_EMBEDDED_v1 (2026-07-05) — super-admin WhatsApp connection.
 *
 * Lets the PLATFORM (super-admin) connect its OWN dedicated WhatsApp
 * number via Meta Embedded Signup, then use it to notify tenants
 * (welcome credentials, invoices, payment info, billing reminders).
 *
 * Connected creds are stored in the `vserve` tenant config
 * (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID /
 *  WHATSAPP_BUSINESS_ACCOUNT_ID) because utils/saasWaSender.js already
 * reads those keys from the vserve tenant DB — so connecting a number
 * here immediately routes all super-admin -> tenant WhatsApp through it.
 */
const fetch      = require('node-fetch');
const tenantPool = require('../../utils/tenantPool');
const tenantDb   = require('../../db/pg');
const saasWa     = require('../../utils/saasWaSender');
const { requireSuperAdmin } = require('./superAdminAuth');

const GRAPH = 'https://graph.facebook.com/v19.0';
const PLATFORM_FB_APP_ID     = process.env.PLATFORM_FB_APP_ID     || '965594974738358';
const PLATFORM_FB_APP_SECRET = process.env.PLATFORM_FB_APP_SECRET || '3d04f767b437f9083ee45533e97d3c18';
const PLATFORM_FB_CONFIG_ID  = process.env.PLATFORM_FB_CONFIG_ID  || '678267295315635';

async function _inVserve(fn) {
  const t = await tenantPool.findActiveTenant('vserve');
  if (!t) throw new Error('Vserve tenant not found in control DB');
  const pool = tenantPool.poolFor(t);
  if (!pool) throw new Error('No pool for vserve');
  let out;
  await tenantDb.tenantStorage.run({ pool, tenant: t, slug: 'vserve' }, async () => { out = await fn(); });
  return out;
}

async function api_saas_wa_status(token) {
  await requireSuperAdmin(token);
  let phoneId = '', wabaId = '', tok = '';
  try {
    await _inVserve(async () => {
      phoneId = String((await tenantDb.getConfig('WHATSAPP_PHONE_NUMBER_ID', '')) || '').trim();
      wabaId  = String((await tenantDb.getConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', '')) || '').trim();
      tok     = String((await tenantDb.getConfig('WHATSAPP_ACCESS_TOKEN', '')) || '').trim();
    });
  } catch (_) {}
  let display = '', verified = '';
  if (phoneId && tok) {
    try {
      const r = await fetch(`${GRAPH}/${phoneId}?fields=display_phone_number,verified_name`, { headers: { Authorization: 'Bearer ' + tok } });
      const j = await r.json();
      if (!j.error) { display = j.display_phone_number || ''; verified = j.verified_name || ''; }
    } catch (_) {}
  }
  return {
    connected: !!(phoneId && tok),
    phone_number_id: phoneId,
    waba_id: wabaId,
    display_phone_number: display,
    verified_name: verified,
    fb_app_id: PLATFORM_FB_APP_ID,
    fb_config_id: PLATFORM_FB_CONFIG_ID
  };
}

async function api_saas_wa_connect(token, code, phoneNumberId, wabaId) {
  await requireSuperAdmin(token);
  if (!code) throw new Error('Missing code from Facebook');
  if (!phoneNumberId || !wabaId) {
    throw new Error('Did not receive phone_number_id / waba_id from the dialog. Make sure the Login-for-Business config has WhatsApp asset selection enabled.');
  }
  const exUrl = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(PLATFORM_FB_APP_ID)}&client_secret=${encodeURIComponent(PLATFORM_FB_APP_SECRET)}&code=${encodeURIComponent(code)}`;
  const r = await fetch(exUrl);
  const j = await r.json();
  if (j.error || !j.access_token) {
    throw new Error('Token exchange failed: ' + ((j.error && j.error.message) || 'no access_token returned'));
  }
  const accessToken = j.access_token;
  await _inVserve(async () => {
    await tenantDb.setConfig('WHATSAPP_ACCESS_TOKEN', accessToken);
    await tenantDb.setConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', String(wabaId));
    await tenantDb.setConfig('WHATSAPP_PHONE_NUMBER_ID', String(phoneNumberId));
  });
  try { if (typeof saasWa.invalidate === 'function') saasWa.invalidate(); } catch (_) {}
  return { ok: true, waba_id: String(wabaId), phone_number_id: String(phoneNumberId) };
}

async function api_saas_wa_disconnect(token) {
  await requireSuperAdmin(token);
  await _inVserve(async () => {
    await tenantDb.setConfig('WHATSAPP_ACCESS_TOKEN', '');
    await tenantDb.setConfig('WHATSAPP_PHONE_NUMBER_ID', '');
    await tenantDb.setConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', '');
  });
  try { if (typeof saasWa.invalidate === 'function') saasWa.invalidate(); } catch (_) {}
  return { ok: true };
}

async function api_saas_wa_sendTest(token, payload) {
  await requireSuperAdmin(token);
  const p = payload || {};
  const to  = String(p.to || '').trim();
  const msg = String(p.message || '').trim() || 'Test message from Smart CRM Solution';
  if (!to) throw new Error('Recipient phone number required');
  const res = await saasWa.sendText(to, msg);
  if (!res || !res.ok) throw new Error((res && res.error) || 'Send failed (needs an open 24h session or an approved template)');
  return { ok: true, message_id: res.message_id || null };
}

module.exports = {
  api_saas_wa_status,
  api_saas_wa_connect,
  api_saas_wa_disconnect,
  api_saas_wa_sendTest
};
