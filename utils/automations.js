/**
 * utils/automations.js — event dispatcher for email / WhatsApp automations.
 *
 * fire(event, context) is called from routes/leads.js (and reminders, webhooks).
 * It loads active automations, filters by event + condition, and sends via the
 * configured channel.
 *
 * Supported events:
 *   lead_created       — ctx: { lead, user }
 *   status_changed     — ctx: { lead, user, new_status }
 *   lead_assigned      — ctx: { lead, user }
 *   followup_due       — ctx: { lead, followup }
 *
 * Template syntax: {{lead.name}}, {{lead.phone}}, {{lead.status_name}}, {{user.name}}, {{new_status.name}}, {{link}}, {{date}}
 *
 * Channels:
 *   email    — via nodemailer (requires SMTP config)
 *   whatsapp — via WhatsApp Cloud API (requires WHATSAPP_* env)
 *   webhook  — POST JSON to the configured URL (template is the URL)
 */
const db = require('../db/pg');

async function fire(event, ctx) {
  try {
    const automations = (await db.getAll('automations')).filter(a =>
      a.event === event && Number(a.is_active) === 1
    );
    if (!automations.length) return;
    // AUTOMATION_LEAD_CREATED_FIX_v1 — enrich the lead with denormalized
    // names so rule conditions like "status = New", "product = Solar",
    // "source = Facebook" actually match. Callers (routes/leads.js,
    // routes/forms.js) pass the raw insert payload which only contains
    // status_id / product_id — the matcher reads status_name / product_name.
    // We also merge extra_json so cf_* fields are visible to the matcher.
    try {
      if (ctx && ctx.lead) {
        ctx.lead = await _enrichLead(ctx.lead);
      }
    } catch (e) {
      console.warn('[automations] enrich failed:', e.message);
    }
    for (const a of automations) {
      try {
        if (!_matchesCondition(a.condition, ctx)) {
          const _why = _whyNotMatched(a.condition, ctx);
          await _log(a, ctx, 'skipped', _why ? ('rule failed: ' + _why) : 'condition not met');
          continue;
        }
        let recipient;
        if (a.channel === 'reassign_lead') {
          // AUTOMATION_REASSIGN_v1 — recipient is not an email/phone.
          // The picked-agent list lives on the automation row (recipient
          // field stores 'user:123' or 'users:1,2,3'). Validation deferred
          // to _reassignLead which produces a clear error if mis-configured.
          recipient = String(a.recipient || '').trim() || '_default';
        } else {
          recipient = await _resolveRecipient(a, ctx);
          if (!recipient) {
            await _log(a, ctx, 'skipped', 'no recipient');
            continue;
          }
        }
        const rendered = _render(a.template, ctx);
        const subject  = _render(a.subject || '', ctx);
        let result;
        if (a.channel === 'email')        result = await _sendEmail(recipient, subject, rendered);
        else if (a.channel === 'whatsapp') result = await _sendWhatsApp(recipient, rendered, ctx, a);
        else if (a.channel === 'webhook')  result = await _sendWebhook(rendered, ctx);
        else if (a.channel === 'reassign_lead') result = await _reassignLead(a, ctx);   /* AUTOMATION_REASSIGN_v1 */
        else                               result = { ok: false, error: 'unknown channel: ' + a.channel };

        await _log(a, ctx, result.ok ? 'sent' : 'failed', result.detail || result.error || '');
      } catch (e) {
        await _log(a, ctx, 'failed', e.message);
      }
    }
  } catch (e) {
    console.error('[automations] fire error:', e.message);
  }
}

// AUTOMATION_LEAD_CREATED_FIX_v1 — denormalize id-only fields into the
// human-readable names the matcher reads. Also merges extra_json so cf_*
// keys are visible.
async function _enrichLead(lead) {
  if (!lead || typeof lead !== 'object') return lead;
  const out = Object.assign({}, lead);
  // Merge extra_json (custom fields land here at insert time).
  try {
    if (out.extra_json) {
      const ex = typeof out.extra_json === 'string'
        ? JSON.parse(out.extra_json || '{}')
        : (out.extra_json || {});
      for (const k of Object.keys(ex || {})) {
        if (out[k] == null || out[k] === '') out[k] = ex[k];
      }
    }
  } catch (_) {}
  if (!out.status_name && out.status_id) {
    try {
      const row = await db.findById('statuses', out.status_id);
      if (row) out.status_name = row.name;
    } catch (_) {}
  }
  if (!out.product_name && out.product_id) {
    try {
      const row = await db.findById('products', out.product_id);
      if (row) out.product_name = row.name;
    } catch (_) {}
  }
  if (!out.assigned_name && out.assigned_to) {
    try {
      const u = await db.findById('users', out.assigned_to);
      if (u) out.assigned_name = u.name;
    } catch (_) {}
  }
  return out;
}

// Diagnostic — explains WHY the condition didn't match (which clause failed,
// what the actual value was). Shown in the Automation log so admins don't
// have to guess why "skipped — condition not met" fired.
function _whyNotMatched(cond, ctx) {
  if (!cond) return '';
  const c = String(cond).trim();
  if (!c) return '';
  const parts = c.split(/\s*&&\s*/);
  for (const raw of parts) {
    const part = String(raw || '').trim();
    if (!part) continue;
    let m, op = 'eq';
    if ((m = part.match(/^([a-zA-Z0-9_]+)\s*!=\s*(.*)$/))) op = 'neq';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*!~\s*(.*)$/))) op = 'ncontains';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*!:\s*(.*)$/))) op = 'neq';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*~\s*(.*)$/))) op = 'contains';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*=\s*(.*)$/))) op = 'eq';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/))) op = 'eq';
    if (!m) continue;
    const lhs = m[1].trim();
    const rhs = String(m[2] || '').trim();
    let actual;
    if (lhs.startsWith('tag')) {
      actual = String(ctx.lead?.tags || '');
    } else if (lhs === 'status' || lhs === 'status_name') {
      actual = String(ctx.new_status?.name || ctx.lead?.status_name || '');
    } else if (lhs === 'source') {
      actual = String(ctx.lead?.source || '');
    } else if (lhs === 'product') {
      actual = String(ctx.lead?.product_name || ctx.lead?.product || '');
    } else {
      actual = ctx.lead?.[lhs];
      if (actual == null) actual = '';
      actual = String(actual);
    }
    const a = actual.toLowerCase();
    const b = rhs.toLowerCase();
    let ok = false;
    if (op === 'eq')        ok = (a === b);
    else if (op === 'neq')  ok = (a !== b);
    else if (op === 'contains')  ok = a.includes(b);
    else if (op === 'ncontains') ok = !a.includes(b);
    if (!ok) {
      const shown = actual === '' ? '(empty)' : actual;
      // AUTOMATION_FB_EXTRA_FIX_v2 — dump the most diagnostic-useful slices
      // of the lead so the admin can immediately tell WHY the field is empty
      // without opening a second tab:
      //   source:       which ingest path the lead came from (manual, facebook, website…)
      //   id:           so the admin can click into it in the leads page
      //   extra_keys:   what custom-field keys actually landed in extra_json
      //                 (the field-mapping target keys without the cf_ prefix)
      const L = ctx.lead || {};
      const src = L.source || '(no source)';
      const id  = L.id != null ? ('#' + L.id) : '(no id)';
      let extraKeys = '(none)';
      try {
        const ex = typeof L.extra_json === 'string'
          ? JSON.parse(L.extra_json || '{}')
          : (L.extra_json || {});
        const keys = Object.keys(ex || {});
        if (keys.length) extraKeys = keys.slice(0, 15).join(',');
      } catch (_) { extraKeys = '(parse error)'; }
      return lhs + ' ' + op + ' "' + rhs + '" — actual: "' + shown
        + '" — lead ' + id + ' source=' + src + ' extras=[' + extraKeys + ']';
    }
  }
  return '';
}

// AUTOMATION_RULES_v2_OPS — recognise operators eq / neq / contains / ncontains.
// Storage format on each part:
//   field=value      equals
//   field!=value     not equals
//   field~value      contains
//   field!~value     does not contain
//   tag:value        legacy tag-equals (lead has tag)
//   tag!:value       tag does NOT match
function _matchesCondition(cond, ctx) {
  if (!cond) return true;
  const c = String(cond).trim();
  if (!c) return true;
  const parts = c.split(/\s*&&\s*/);
  for (const raw of parts) {
    const part = String(raw || '').trim();
    if (!part) continue;
    // Detect operator longest-first.
    let m, op = 'eq';
    if ((m = part.match(/^([a-zA-Z0-9_]+)\s*!=\s*(.*)$/))) op = 'neq';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*!~\s*(.*)$/))) op = 'ncontains';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*!:\s*(.*)$/))) op = 'neq';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*~\s*(.*)$/))) op = 'contains';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*=\s*(.*)$/))) op = 'eq';
    else if ((m = part.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/))) op = 'eq';
    if (!m) continue;
    const lhs = m[1].trim();
    const rhs = String(m[2] || '').trim();
    if (!lhs) continue;

    // Resolve the actual field value off the context.
    let actual;
    if (lhs.startsWith('tag')) {
      const tags = String(ctx.lead?.tags || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const want = rhs.toLowerCase();
      const present = tags.includes(want);
      // For tag: eq means "lead has tag", neq means "lead does NOT have tag",
      // contains is the same as eq, ncontains is the same as neq.
      const wantPresent = (op === 'eq' || op === 'contains');
      if (wantPresent !== present) return false;
      continue;
    } else if (lhs === 'status' || lhs === 'status_name') {
      actual = String(ctx.new_status?.name || ctx.lead?.status_name || '');
    } else if (lhs === 'source') {
      actual = String(ctx.lead?.source || '');
    } else if (lhs === 'product') {
      actual = String(ctx.lead?.product_name || ctx.lead?.product || '');
    } else {
      actual = ctx.lead?.[lhs];
      if (actual == null) actual = '';
      actual = String(actual);
    }
    const a = actual.toLowerCase();
    const b = rhs.toLowerCase();
    let ok = false;
    if (op === 'eq')        ok = (a === b);
    else if (op === 'neq')  ok = (a !== b);
    else if (op === 'contains')  ok = a.includes(b);
    else if (op === 'ncontains') ok = !a.includes(b);
    else ok = (a === b);
    if (!ok) return false;
  }
  return true;
}

async function _resolveRecipient(a, ctx) {
  const r = String(a.recipient || 'lead').toLowerCase();
  const lead = ctx.lead || {};
  if (r === 'lead') return a.channel === 'email' ? lead.email : lead.phone || lead.whatsapp;
  if (r === 'assignee') {
    if (!lead.assigned_to) return null;
    const u = await db.findById('users', lead.assigned_to);
    if (!u) return null;
    return a.channel === 'email' ? u.email : u.phone;
  }
  if (r === 'admin') {
    const admin = await db.findOneBy('users', 'role', 'admin');
    return admin ? (a.channel === 'email' ? admin.email : admin.phone) : null;
  }
  return r; // literal email or phone
}

function _render(tpl, ctx) {
  return String(tpl || '').replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    key = key.trim();
    const [ns, field] = key.split('.');
    let v;
    if (field === undefined) {
      v = { date: new Date().toLocaleDateString(), time: new Date().toLocaleTimeString() }[ns];
    } else {
      v = ctx[ns] && ctx[ns][field];
    }
    return v == null ? '' : String(v);
  });
}

async function _sendEmail(to, subject, html) {
  // AUTOMATION_SMTP_DBCONFIG_v1: read SMTP config from the per-tenant config
  // table first, with process.env as fallback. Previously this function
  // only looked at process.env — so tenants that had saved credentials via
  // Settings → SMTP (which writes to the config DB, not env) always got
  // 'SMTP disabled' even though the Test SMTP button worked.
  const enabledRaw = await db.getConfig('EMAIL_NOTIFY_ENABLED', process.env.EMAIL_NOTIFY_ENABLED);
  const host    = await db.getConfig('SMTP_HOST', process.env.SMTP_HOST);
  const port    = await db.getConfig('SMTP_PORT', process.env.SMTP_PORT);
  const secure  = await db.getConfig('SMTP_SECURE', process.env.SMTP_SECURE);
  const user    = await db.getConfig('SMTP_USER', process.env.SMTP_USER);
  const pass    = await db.getConfig('SMTP_PASSWORD', process.env.SMTP_PASSWORD);
  const from    = await db.getConfig('EMAIL_NOTIFY_FROM', process.env.EMAIL_NOTIFY_FROM);
  // AUTOMATION_SMTP_AUTOENABLE_v1 — treat email as ENABLED if host/user/pass
  // are all set, UNLESS the admin has explicitly set EMAIL_NOTIFY_ENABLED='0'
  // to opt out. This matches user intent ('I configured + tested SMTP, of
  // course I want it on') and removes the gotcha where the toggle defaulted
  // to '0' on older tenants.
  const explicitlyOff = String(enabledRaw || '') === '0';
  if (explicitlyOff) return { ok: false, error: 'SMTP explicitly disabled (EMAIL_NOTIFY_ENABLED=0). Set it to 1 in Settings → SMTP to enable.' };
  if (!host || !user || !pass) return { ok: false, error: 'SMTP creds missing (host/user/pass)' };
  try {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host,
      port: Number(port) || 587,
      secure: String(secure || '').toLowerCase() === 'true',
      auth: { user, pass }
    });
    await t.sendMail({
      from: from || 'Lead CRM <noreply@localhost>',
      to, subject, html
    });
    return { ok: true, detail: 'sent to ' + to };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function _sendWhatsApp(to, body, ctx, automation) {
  const phoneId = await db.getConfig('WHATSAPP_PHONE_NUMBER_ID', process.env.WHATSAPP_PHONE_NUMBER_ID);
  const token   = await db.getConfig('WHATSAPP_ACCESS_TOKEN', process.env.WHATSAPP_ACCESS_TOKEN);
  if (!phoneId || !token) return { ok: false, error: 'WhatsApp not configured' };

  // If the automation.subject starts with "template:" we send a Meta-approved template
  // Format:  subject="template:my_template_name:en_US"  template="{{lead.name}}|{{lead.phone}}"
  //                                                                 ↑ pipe-separated body params
  try {
    const fetch = require('node-fetch');
    const phone = String(to).replace(/\D/g, '');
    let payload;
    const subj = String(automation?.subject || '');
    if (subj.startsWith('template:')) {
      const parts = subj.split(':');
      const name = parts[1];
      const lang = parts[2] || 'en_US';

      // Look up the template metadata so we know how many body params Meta
      // actually expects. The cached row was populated by api_wb_templates_sync
      // and stores `body_params` (count of {{N}} placeholders in the body) +
      // `header_type` ('TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null) +
      // `components_json` (full component structure including buttons).
      // This is the source of truth — without it we were sending whatever the
      // user pipe-typed, which produced (#132000) whenever the count didn't
      // match Meta's expectation.
      let expectedBodyParams = null;
      let headerType = null;
      let headerHasVar = false;
      let urlButtons = []; // [{ index, varCount }] for buttons with {{N}} in url
      try {
        const tpl = await db.findOneBy('wa_templates', 'name', name);
        if (tpl) {
          expectedBodyParams = Number(tpl.body_params) || 0;
          headerType = tpl.header_type || null;
          try {
            const comps = typeof tpl.components_json === 'string'
              ? JSON.parse(tpl.components_json) : (tpl.components_json || []);
            const head = (comps || []).find(c => String(c.type).toUpperCase() === 'HEADER');
            if (head && head.format === 'TEXT' && /\{\{\d+\}\}/.test(head.text || '')) {
              headerHasVar = true;
            }
            // Walk button components — URL buttons with `{{N}}` in their URL
            // require a `button` component in the send payload, otherwise Meta
            // throws 132000 even when body params are correct (very common
            // with marketing "Thank You" templates that have a "Visit website"
            // CTA pointing at /thanks/{{1}}).
            const btnComp = (comps || []).find(c => String(c.type).toUpperCase() === 'BUTTONS');
            if (btnComp && Array.isArray(btnComp.buttons)) {
              btnComp.buttons.forEach((b, idx) => {
                if (String(b.type).toUpperCase() === 'URL' && /\{\{\d+\}\}/.test(b.url || '')) {
                  const varCount = (b.url.match(/\{\{\d+\}\}/g) || []).length;
                  urlButtons.push({ index: idx, varCount });
                }
              });
            }
          } catch (_) {}
        }
      } catch (_) {}

      // Render the pipe-separated body params. Crucially we DO NOT filter out
      // empty strings — empties get replaced with a single em-dash so Meta still
      // sees a non-empty param at the expected position. Then we pad/truncate
      // to match the template's actual `body_params` count.
      const FALLBACK = '—';
      const splitParams = String(_render(body || '', ctx)).split('|').map(s => {
        const v = (s || '').trim();
        return v === '' ? FALLBACK : v;
      });
      let bodyParams = splitParams;
      if (expectedBodyParams !== null) {
        if (bodyParams.length < expectedBodyParams) {
          // Pad with em-dash so we always send the right count.
          while (bodyParams.length < expectedBodyParams) bodyParams.push(FALLBACK);
        } else if (bodyParams.length > expectedBodyParams) {
          bodyParams = bodyParams.slice(0, expectedBodyParams);
        }
      }

      const components = [];
      // Header component — required only when the header has a TEXT variable.
      // For IMAGE/VIDEO/DOCUMENT headers the automation flow doesn't yet
      // support attaching media, so we surface a clearer error than Meta's.
      if (headerHasVar) {
        components.push({
          type: 'header',
          parameters: [{ type: 'text', text: bodyParams[0] || FALLBACK }]
        });
      } else if (headerType && headerType !== 'TEXT') {
        return {
          ok: false,
          error: `Template "${name}" has a ${headerType} header — automations don't support media headers yet. Use a template with a TEXT or no header.`
        };
      }
      if (bodyParams.length > 0) {
        components.push({
          type: 'body',
          parameters: bodyParams.map(text => ({ type: 'text', text }))
        });
      }
      // URL button components — Meta requires one `button` component per URL
      // button that contains a {{N}} placeholder. We default the param to the
      // lead's phone (a stable per-lead value Meta accepts as a URL fragment)
      // unless one of the body params is already filled — in which case we
      // reuse it. This isn't a full button-param API yet, but it stops 132000
      // for the most common case: "Thank you" templates with a CTA URL.
      const buttonValue = (ctx.lead?.id != null ? String(ctx.lead.id) : (ctx.lead?.phone || FALLBACK));
      urlButtons.forEach(b => {
        const params = [];
        for (let i = 0; i < b.varCount; i++) params.push({ type: 'text', text: buttonValue });
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(b.index),
          parameters: params
        });
      });
      payload = {
        messaging_product: 'whatsapp', to: phone, type: 'template',
        template: { name, language: { code: lang }, components }
      };
    } else {
      payload = {
        messaging_product: 'whatsapp', to: phone, type: 'text',
        text: { body: String(body) }
      };
    }
    const r = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await r.json();
    if (j.error) {
      // Friendlier error for 132000 — the most common automation failure.
      if (Number(j.error.code) === 132000) {
        const tplName = (subj.startsWith('template:') && subj.split(':')[1]) || 'unknown';
        return {
          ok: false,
          error: `Template "${tplName}" param count mismatch. Re-sync templates and re-check the pipe-separated values in the automation. (${j.error.message})`
        };
      }
      return { ok: false, error: j.error.message };
    }
    const waMsgId = j.messages?.[0]?.id || null;

    // Persist the outbound message into whatsapp_messages so it shows up in
    // the WhatsBot → Chat tab thread for the lead. Without this, automation
    // sends were happening (Meta returned a wamid) but nobody could see them
    // in the CRM's chat — a silent disconnect between "Sent" in Recent log and
    // the actual conversation thread the team works from.
    try {
      let msgType = 'text';
      let preview = String(body || '');
      let templateName = null;
      if (subj.startsWith('template:')) {
        msgType = 'template';
        const parts = subj.split(':');
        templateName = parts[1];
        // Render the template body_text with the actual params we just sent
        // so the chat shows the customer-visible message, not the raw
        // pipe-separated form.
        try {
          const tpl = await db.findOneBy('wa_templates', 'name', templateName);
          if (tpl && tpl.bodyText) preview = String(tpl.bodyText);
          else if (tpl && tpl.body_text) preview = String(tpl.body_text);
        } catch (_) {}
        // Substitute {{1}}, {{2}}, ... with the rendered body params we sent.
        try {
          const rendered = String(_render(body || '', ctx))
            .split('|')
            .map(s => (s || '').trim())
            .map(s => s === '' ? '—' : s);
          preview = String(preview).replace(/\{\{(\d+)\}\}/g, (_, n) => {
            const idx = Number(n) - 1;
            return rendered[idx] != null ? rendered[idx] : ('{{' + n + '}}');
          });
        } catch (_) {}
      }

      await db.query(
        `INSERT INTO whatsapp_messages
           (lead_id, user_id, direction, from_number, to_number, body,
            wa_message_id, status, message_type, template_name, error_text)
         VALUES ($1, $2, 'out', $3, $4, $5, $6, 'sent', $7, $8, NULL)`,
        [
          ctx.lead?.id || null,
          null,                 // automation has no acting user
          String(phoneId),
          phone,
          preview,
          waMsgId,
          msgType,
          templateName
        ]
      );

      // Lead activity timeline so the lead modal shows "automation sent
      // WhatsApp template" in the activity log too.
      if (ctx.lead?.id) {
        try {
          require('../routes/tat').logAction(ctx.lead.id, 'whatsapp_out', null, {
            preview: String(preview).slice(0, 200),
            template: templateName,
            type: msgType,
            via: 'automation'
          });
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[automations] save-to-chat failed:', e.message);
    }

    return { ok: true, detail: 'wa_message_id=' + (waMsgId || '?') };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function _sendWebhook(url, ctx) {
  if (!/^https?:/.test(url)) return { ok: false, error: 'template should be a URL for webhook channel' };
  try {
    const fetch = require('node-fetch');
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: ctx.event, lead: ctx.lead, user: ctx.user })
    });
    return { ok: r.ok, detail: 'status ' + r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function _log(a, ctx, status, detail) {
  try {
    await db.insert('automation_log', {
      automation_id: a.id,
      lead_id: ctx.lead?.id || null,
      event: a.event,
      channel: a.channel,
      recipient: null,
      status, detail,
      created_at: db.nowIso()
    });
  } catch (_) {}
}

/* ============================================================
 * AUTOMATION_REASSIGN_v1 (2026-06-02)
 *
 * Reassign action — fires from any event the automation engine knows
 * about (lead_created, status_changed, lead_assigned, followup_due).
 *
 * Recipient string formats accepted (stored on automations.recipient):
 *   user:<id>            single user — that user becomes the new owner
 *   users:<id>,<id>,<id> multi-user pool — round-robin by fewest leads
 *                        created today (same heuristic Auto-assign Rules use)
 *
 * Safe defaults the user asked for ('insure no other things disturbed'):
 *   - Silent replace of previous assigned_to (previous owner loses lead)
 *   - Adds a remark on the lead so there's an audit trail
 *   - Skips paused / inactive users from the target pool
 *   - 60-second recursion guard: if the lead was reassigned by THIS
 *     automation in the last 60 seconds, skip — prevents loops where
 *     a reassign triggers status_changed which re-fires the same rule.
 *   - Bumps updated_at and last_status_change_at left untouched.
 *
 * Returns { ok, detail } so the existing _log() path works unchanged.
 * ============================================================ */
const _reassignDebounce = new Map();
async function _reassignLead(a, ctx) {
  const leadId = ctx && ctx.lead && Number(ctx.lead.id);
  if (!leadId) return { ok: false, error: 'reassign skipped: no lead in event ctx' };

  // 60s recursion guard, keyed by (automation id, lead id)
  const dbKey = String(a.id || a.name) + ':' + leadId;
  const lastFiredAt = _reassignDebounce.get(dbKey) || 0;
  if (Date.now() - lastFiredAt < 60000) {
    return { ok: false, error: 'reassign skipped: debounced (fired <60s ago)' };
  }

  // Parse the target user-id list off the automation's recipient field.
  const raw = String(a.recipient || '').trim();
  let ids = [];
  if (raw.startsWith('users:')) {
    ids = raw.slice('users:'.length).split(',').map(x => Number(x.trim())).filter(x => x > 0);
  } else if (raw.startsWith('user:')) {
    ids = [Number(raw.slice('user:'.length).trim())].filter(x => x > 0);
  }
  if (!ids.length) return { ok: false, error: 'reassign skipped: no target user(s) configured (recipient should be "user:<id>" or "users:<id>,<id>")' };

  // Filter out paused / inactive users so we don't park leads on someone on leave.
  try {
    const allUsers = await db.getAll('users');
    const eligible = new Set(allUsers.filter(u =>
      Number(u.is_active != null ? u.is_active : 1) === 1 &&
      u.paused_for_leads !== true && Number(u.paused_for_leads) !== 1
    ).map(u => Number(u.id)));
    ids = ids.filter(id => eligible.has(Number(id)));
  } catch (_) {}
  if (!ids.length) return { ok: false, error: 'reassign skipped: every target user is paused or inactive' };

  // AUTOMATION_ROUND_ROBIN_v1 (2026-06-17) — TRUE round-robin.
  // Previous implementation was "fewest-loaded today" which biased
  // toward whoever happened to have a slow morning. User asked for
  // strict round-robin: cycle through the ticked pool one at a time
  // in order, regardless of how many other leads each user has.
  //
  // State is one INTEGER column on the automations row,
  // last_picked_user_id, added via idempotent ALTER in db/schema.sql.
  // Pick algorithm:
  //   1. Read last_picked_user_id for this rule.
  //   2. Find its index in the current eligible pool (after
  //      paused/inactive filtering).
  //   3. Pick the user at (idx + 1) mod pool.length — the next in
  //      rotation. If last_picked isn't in the current pool (was
  //      paused / removed from the rule / first run), start at
  //      pool[0].
  //   4. Persist the new pickedId back into last_picked_user_id.
  //
  // Pool order = order of user IDs in the recipient string. The SPA
  // saves users in the order they appear in the checkbox grid, so
  // rotation order is stable and predictable.
  let pickedId = ids[0];
  if (ids.length > 1) {
    let lastPicked = 0;
    try {
      const r = await db.query(`SELECT last_picked_user_id FROM automations WHERE id = $1`, [a.id]);
      lastPicked = Number(r.rows[0] && r.rows[0].last_picked_user_id) || 0;
    } catch (_) {}
    const idx = ids.indexOf(lastPicked);
    pickedId = idx >= 0 ? ids[(idx + 1) % ids.length] : ids[0];
  }

  // Look up the previous owner (for the audit remark) and the new owner.
  const lead = await db.findById('leads', leadId);
  if (!lead) return { ok: false, error: 'reassign skipped: lead ' + leadId + ' not found' };
  if (Number(lead.assigned_to) === Number(pickedId)) {
    return { ok: true, detail: 'no-op: lead is already owned by user ' + pickedId };
  }

  const newOwner  = await db.findById('users', pickedId).catch(() => null);
  const prevOwner = lead.assigned_to ? await db.findById('users', lead.assigned_to).catch(() => null) : null;

  // The actual write.
  await db.update('leads', leadId, { assigned_to: pickedId });

  // AUTOMATION_ROUND_ROBIN_v1 — persist the picked user so the NEXT
  // fire of this same rule advances to the next position. Wrapped in
  // try/catch so a write failure doesn't abort the reassign.
  try {
    await db.query(`UPDATE automations SET last_picked_user_id = $1 WHERE id = $2`, [pickedId, a.id]);
  } catch (_) {}

  // Audit remark — admin can see who moved this lead and when.
  try {
    await db.insert('remarks', {
      lead_id: leadId,
      user_id: null,                                  // system action
      remark: '🔄 Auto-reassigned from ' +
              (prevOwner ? prevOwner.name : '(unassigned)') +
              ' → ' + (newOwner ? newOwner.name : ('user ' + pickedId)) +
              ' by automation "' + (a.name || ('#' + a.id)) + '"'
    });
  } catch (_) {}

  _reassignDebounce.set(dbKey, Date.now());

  // CHAT_AUTO_REASSIGN_v1 (2026-06-04) — propagate the auto-reassign onto
  // the lead's WhatsApp chat thread so the new owner takes over the
  // conversation, not just the lead row. Same helper used by manual
  // single-edit and bulk-edit paths. Fire-and-forget; chat failure
  // never blocks the automation result.
  try {
    const leadsMod = require('../routes/leads');
    if (typeof leadsMod._reassignChatForLead === 'function') {
      // Pass the lead BEFORE the update so the helper compares correctly.
      await leadsMod._reassignChatForLead({
        lead: { id: leadId, phone: lead.phone, whatsapp: lead.whatsapp, name: lead.name, assigned_to: lead.assigned_to },
        newOwnerId: pickedId,
        actorId:    null,                 // automation has no human actor
        reason:     'automation: ' + (a.name || ('#' + a.id))
      });
    }
  } catch (e) { console.warn('[automation][reassign] chat-reassign failed:', e.message); }

  return {
    ok: true,
    detail: 'reassigned lead ' + leadId + ' from ' +
            (prevOwner ? prevOwner.name : '(unassigned)') +
            ' to ' + (newOwner ? newOwner.name : ('user ' + pickedId))
  };
}


module.exports = { fire };
