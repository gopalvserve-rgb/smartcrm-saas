/**
 * routes/whatsapp.js — WhatsApp Cloud API helpers.
 * Fetches approved message templates from Meta, used by the automation UI.
 */
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function _cfg() {
  const wabaId = await db.getConfig('WHATSAPP_BUSINESS_ACCOUNT_ID', process.env.WHATSAPP_BUSINESS_ACCOUNT_ID);
  const token  = await db.getConfig('WHATSAPP_ACCESS_TOKEN',        process.env.WHATSAPP_ACCESS_TOKEN);
  return { wabaId, token };
}

async function api_whatsapp_templates(token) {
  await authUser(token);
  const { wabaId, token: waToken } = await _cfg();
  if (!wabaId || !waToken) {
    return { templates: [], error: 'WhatsApp not configured. Set WHATSAPP_BUSINESS_ACCOUNT_ID and WHATSAPP_ACCESS_TOKEN in Settings → WhatsApp.' };
  }
  try {
    const url = `https://graph.facebook.com/v19.0/${wabaId}/message_templates?limit=100&access_token=${encodeURIComponent(waToken)}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) return { templates: [], error: j.error.message };
    const list = (j.data || []).map(t => ({
      name: t.name,
      language: t.language,
      status: t.status,
      category: t.category,
      components: t.components,
      // Pre-compute the parameter count per component
      body_params: ((t.components || []).find(c => c.type === 'BODY')?.text?.match(/\{\{\d+\}\}/g) || []).length,
      header_type: (t.components || []).find(c => c.type === 'HEADER')?.format || null,
      has_buttons: !!(t.components || []).find(c => c.type === 'BUTTONS')
    }));
    // Prefer APPROVED templates
    list.sort((a, b) => (a.status === 'APPROVED' ? -1 : 1) - (b.status === 'APPROVED' ? -1 : 1) || a.name.localeCompare(b.name));
    return { templates: list };
  } catch (e) {
    return { templates: [], error: e.message };
  }
}

/**
 * Send a WhatsApp template message to a phone number.
 * params: [{ type: 'body', parameters: [{type:'text', text:'...'}] }]
 */
async function api_whatsapp_send_template(token, to, templateName, language, params) {
  await authUser(token);
  const phoneId = await db.getConfig('WHATSAPP_PHONE_NUMBER_ID', process.env.WHATSAPP_PHONE_NUMBER_ID);
  const waToken = await db.getConfig('WHATSAPP_ACCESS_TOKEN', process.env.WHATSAPP_ACCESS_TOKEN);
  if (!phoneId || !waToken) throw new Error('WhatsApp not configured');
  const body = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/\D/g, ''),
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'en_US' },
      components: params || []
    }
  };
  const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + waToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return { ok: true, wa_message_id: j.messages?.[0]?.id };
}

module.exports = {
  api_whatsapp_templates,
  api_whatsapp_send_template
};
