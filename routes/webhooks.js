/**
 * routes/webhooks.js — inbound webhook handlers
 *
 * Endpoints mounted by server.js:
 *   GET  /hook/meta      — Meta subscription verification
 *   POST /hook/meta      — Meta Lead Ads events
 *   GET  /hook/whatsapp  — WhatsApp verify
 *   POST /hook/whatsapp  — WhatsApp events
 *   POST /hook/website   — HTML form -> lead (requires x-api-key)
 *   POST /hook/other     — generic JSON lead ingest (requires x-api-key)
 */
const fetch = require('node-fetch');
const db = require('../db/pg');

const GRAPH = 'https://graph.facebook.com/v19.0';

// -------------------- Meta verification (GET) --------------------
async function metaVerify(req, res) {
  const mode     = req.query['hub.mode'];
  const token    = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  // Read from DB config first; fall back to env var so existing setups keep working.
  const expected = (await db.getConfig('META_VERIFY_TOKEN', process.env.META_VERIFY_TOKEN || '')) || '';
  if (mode === 'subscribe' && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
}

// -------------------- Meta events (POST) -------------------------
async function metaEvent(req, res) {
  // Always 200 quickly so Meta doesn't retry.
  res.status(200).send('EVENT_RECEIVED');
  try {
    const body = req.body || {};
    await db.insert('webhook_log', { source: 'meta', payload: body, processed: 0 });

    const entries = body.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'leadgen') continue;
        const leadgenId = change.value?.leadgen_id;
        const pageId    = change.value?.page_id;
        const formId    = change.value?.form_id;
        if (!leadgenId) continue;
        try {
          await _processLeadgen(leadgenId, pageId, formId);
        } catch (e) {
          console.error('[meta] leadgen failed:', leadgenId, e.message);
          await db.insert('webhook_log', {
            source: 'meta', payload: { leadgen_id: leadgenId, error: e.message },
            processed: 0, error: e.message
          });
        }
      }
    }
  } catch (e) {
    console.error('[meta] event handler error:', e);
  }
}

async function _processLeadgen(leadgenId, pageId, formId) {
  // Resolve page-specific access token + the configured default operator/source/status
  // for incoming Meta leads. Falls back to the legacy single-page token if the
  // multi-page config isn't set up yet (back-compat for old deployments).
  let ctx = { access_token: '', default_source: 'Facebook Lead Ad', default_user_id: null, default_status_id: null };
  try {
    const fb = require('./fb');
    if (typeof fb._pageContextForWebhook === 'function') {
      ctx = await fb._pageContextForWebhook(pageId);
    }
  } catch (_) { /* ignore — fall back below */ }
  let pageToken = ctx.access_token;
  if (!pageToken) {
    pageToken = await db.getConfig('META_PAGE_ACCESS_TOKEN', '');
  }
  if (!pageToken) throw new Error('No access token for page ' + pageId + ' — admin must connect with Facebook and monitor this page.');

  const r = await fetch(`${GRAPH}/${leadgenId}?access_token=${pageToken}`);
  const j = await r.json();
  if (j.error) throw new Error('Graph: ' + j.error.message);

  const fieldData = j.field_data || [];
  const payload = {};
  fieldData.forEach(f => {
    payload[f.name] = Array.isArray(f.values) ? f.values.join(', ') : f.values;
  });

  const lead = {
    name:     payload.full_name || payload.name || '',
    phone:    payload.phone_number || payload.phone || '',
    email:    payload.email || '',
    whatsapp: payload.phone_number || payload.phone || '',
    source:   ctx.default_source || 'Facebook Lead Ad',
    notes:    'Imported from Meta Lead Ad' + (ctx.page_name ? ' — page: ' + ctx.page_name : ''),
    meta_json: { leadgen_id: leadgenId, page_id: pageId, form_id: formId, raw: j },
    created_at: db.nowIso(),
    updated_at: db.nowIso()
  };
  if (ctx.default_user_id) lead.assigned_to = ctx.default_user_id;
  if (ctx.default_status_id) lead.status_id = ctx.default_status_id;

  await _createLeadFromWebhook(lead);
}

// -------------------- WhatsApp verification ----------------------
async function whatsappVerify(req, res) {
  const mode     = req.query['hub.mode'];
  const token    = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || '';
  if (mode === 'subscribe' && token === expected) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
}

async function whatsappEvent(req, res) {
  res.status(200).send('EVENT_RECEIVED');
  try {
    const body = req.body || {};
    await db.insert('webhook_log', { source: 'whatsapp', payload: body, processed: 0 });
    // Optional: persist new inbound message as a remark on matching lead
    const entries = body.entry || [];
    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const msgs = change.value?.messages || [];
        for (const m of msgs) {
          const from = m.from;
          const text = m.text?.body || '';
          if (!from || !text) continue;
          const lead = (await db.getAll('leads')).find(l => {
            const p = String(l.phone || '').replace(/\D/g, '');
            const w = String(l.whatsapp || '').replace(/\D/g, '');
            const f = String(from).replace(/\D/g, '');
            return p && (p === f || w === f);
          });
          if (lead) {
            await db.insert('remarks', {
              lead_id: lead.id, user_id: null,
              remark: '[WhatsApp] ' + text, created_at: db.nowIso()
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('[whatsapp] error:', e);
  }
}

// -------------------- Website hook -------------------------------

/**
 * Read the inbound API key from any of the conventional places. Lots of
 * connector tools (Pabbly, Zapier, Make, n8n, Facebook Lead Ads bridges) only
 * expose certain auth styles in their UI, so we accept all of:
 *   - `x-api-key: <key>`              (canonical)
 *   - `Authorization: Bearer <key>`   (most common default in HTTP clients)
 *   - `api_key` body field            (form-encoded webhooks)
 *   - `?api_key=<key>` query param    (last-resort for tools that only let
 *                                       you append URL params)
 * The rest of the validation is unchanged — must equal WEBSITE_API_KEY.
 */
function _extractApiKey(req) {
  const xkey = req.header('x-api-key');
  if (xkey) return String(xkey).trim();
  const auth = req.header('authorization') || '';
  const bearer = /^bearer\s+(.+)$/i.exec(auth);
  if (bearer) return String(bearer[1]).trim();
  if (req.body && req.body.api_key) return String(req.body.api_key).trim();
  if (req.query && req.query.api_key) return String(req.query.api_key).trim();
  return '';
}

async function websiteHook(req, res) {
  const key = _extractApiKey(req);
  if (!process.env.WEBSITE_API_KEY || key !== process.env.WEBSITE_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  try {
    const b = req.body || {};
    // Tags — accept either a comma-separated string or a JSON array
    let tags = '';
    if (Array.isArray(b.tags)) tags = b.tags.join(',');
    else if (b.tags) tags = String(b.tags);
    else if (Array.isArray(b.labels)) tags = b.labels.join(',');
    else if (b.labels) tags = String(b.labels);

    // ---- Google Ads ValueTrack normalisation ----------------------
    // Landing pages like:  ?campaign={campaignid}&network={network}&keyword={keyword}&gclid={gclid}
    // map directly into our utm_* + source_ref + meta_json columns.
    const campaignId   = b.campaign || b.campaign_id || b.campaignid || b.utm_campaign || '';
    const campaignName = b.campaign_name || b.campaignname || '';
    const network      = b.network || b.utm_medium || '';   // search | content | youtube | display
    const keyword      = b.keyword || b.utm_term || '';
    const gclid        = b.gclid || b.clickid || b.click_id || '';
    const adgroupid    = b.adgroupid || b.adgroup_id || '';
    const matchtype    = b.matchtype || b.match_type || '';
    const device       = b.device || '';
    const placement    = b.placement || '';
    const adposition   = b.adposition || b.ad_position || '';
    const utmSource    = b.utm_source || (gclid ? 'google' : '');

    // If we received Google Ads params, force source = "Google Ads" so it shows
    // up cleanly in reports/segmentation. Manual b.source overrides.
    const source = b.source || (gclid || campaignId ? 'Google Ads' : 'Website');

    // Build meta_json — keep every Google Ads param + UTM aliases + landing URL
    const adsMeta = {};
    if (campaignId)   adsMeta.campaign_id   = campaignId;
    if (campaignName) adsMeta.campaign_name = campaignName;
    if (network)      adsMeta.network       = network;
    if (keyword)      adsMeta.keyword       = keyword;
    if (gclid)        adsMeta.gclid         = gclid;
    if (adgroupid)    adsMeta.adgroup_id    = adgroupid;
    if (matchtype)    adsMeta.match_type    = matchtype;
    if (device)       adsMeta.device        = device;
    if (placement)    adsMeta.placement     = placement;
    if (adposition)   adsMeta.ad_position   = adposition;
    if (utmSource)    adsMeta.utm_source    = utmSource;
    if (network)      adsMeta.utm_medium    = network;
    if (campaignId)   adsMeta.utm_campaign  = campaignId;
    if (keyword)      adsMeta.utm_term      = keyword;
    if (b.utm_content)  adsMeta.utm_content  = b.utm_content;
    if (b.landing_page) adsMeta.landing_page = b.landing_page;
    if (b.referrer)     adsMeta.referrer     = b.referrer;

    // Tag the lead with the campaign name (or ID) so it's filterable
    if (campaignName && !tags.includes(campaignName)) {
      tags = tags ? tags + ',' + campaignName : campaignName;
    }
    if (network && !tags.toLowerCase().includes(network.toLowerCase())) {
      tags = tags ? tags + ',' + network : network;
    }

    const lead = {
      name:      b.name || '',
      phone:     b.phone || b.mobile || '',
      whatsapp:  b.whatsapp || b.phone || '',
      email:     b.email || '',
      source,
      source_ref: b.source_ref || campaignName || campaignId || '',
      product:   b.product || '',
      notes:     b.notes || b.message || '',
      city:      b.city || '',
      state:     b.state || '',
      country:   b.country || '',
      company:   b.company || '',
      address:   b.address || '',
      pincode:   b.pincode || b.zip || '',
      tags,
      value:     (b.value != null && b.value !== '' && !isNaN(Number(b.value))) ? Number(b.value) : null,
      currency:  b.currency || '',
      next_followup_at: b.next_followup_at || null,
      // First-class attribution columns (also kept in meta_json above for
      // backwards-compat with any reports already querying the JSON blob).
      gclid:          gclid || '',
      gad_campaignid: b.gad_campaignid || campaignId || '',
      utm_source:     utmSource || '',
      utm_medium:     network || '',
      utm_campaign:   campaignId || b.utm_campaign || '',
      utm_term:       keyword || '',
      utm_content:    b.utm_content || '',
      meta_json: Object.keys(adsMeta).length ? Object.assign({}, b.meta || {}, adsMeta) : (b.meta || null),
      created_at: db.nowIso(),
      updated_at: db.nowIso()
    };
    const result = await _createLeadFromWebhook(lead);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[website] error:', e);
    res.status(400).json({ error: e.message });
  }
}

async function otherHook(req, res) {
  const key = _extractApiKey(req);
  if (!process.env.WEBSITE_API_KEY || key !== process.env.WEBSITE_API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  try {
    const b = req.body || {};
    const lead = {
      name: b.name || '',
      phone: b.phone || '',
      email: b.email || '',
      source: b.source || 'Other',
      notes: b.notes || '',
      meta_json: b,
      created_at: db.nowIso(),
      updated_at: db.nowIso()
    };
    const r = await _createLeadFromWebhook(lead);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// -------------------- Shared lead creator ------------------------
// Applies simple round-robin if assignment_rules don't match.
async function _createLeadFromWebhook(lead) {
  // 0. Phone validation. Reject leads with no phone outright (we can't
  //    follow up without one). Auto-flag short phones (<10 digits) as
  //    Junk so they're visible but don't pollute the active pipeline.
  const _phDigits = String(lead.phone || '').replace(/\D/g, '');
  if (!_phDigits) {
    return { ok: false, error: 'phone required' };
  }
  const isJunkPhone = _phDigits.length < 10;

  // 1. Find default status — 'Junk' if the phone is too short, else 'New'
  const statuses = await db.getAll('statuses');
  if (isJunkPhone) {
    let junk = statuses.find(s => /^(junk|junk\s+lead|spam)$/i.test(String(s.name || '')));
    if (!junk) {
      // Auto-create 'Junk' status if it doesn't exist
      const id = await db.insert('statuses', { name: 'Junk', color: '#64748b', sort_order: 990, is_final: 1 });
      junk = { id, name: 'Junk' };
    }
    lead.status_id = junk.id;
    lead.notes = '⚠ Auto-flagged Junk: phone "' + (lead.phone || '') + '" has only ' + _phDigits.length + ' digits.\n' + (lead.notes || '');
  } else {
    const newStatus = statuses.find(s => s.name === 'New');
    if (newStatus) lead.status_id = newStatus.id;
  }

  // 2. Apply assignment rules (first matching one by priority wins)
  const rules = (await db.getAll('assignment_rules'))
    .filter(r => Number(r.is_active) === 1)
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
  let assignedUserId = null;
  for (const rule of rules) {
    const fieldVal = String(lead[rule.field] || '').toLowerCase();
    const ruleVal  = String(rule.value || '').toLowerCase();
    let match = false;
    switch (rule.operator) {
      case 'equals':      match = fieldVal === ruleVal; break;
      case 'contains':    match = fieldVal.includes(ruleVal); break;
      case 'starts_with': match = fieldVal.startsWith(ruleVal); break;
      case 'ends_with':   match = fieldVal.endsWith(ruleVal); break;
      default: break;
    }
    if (match) {
      const ids = String(rule.assigned_to || '').split(',').map(s => Number(s.trim())).filter(Boolean);
      if (ids.length) {
        // Round robin: pick the user with the fewest open leads today
        const counts = {};
        const today = new Date().toISOString().slice(0, 10);
        const todays = (await db.getAll('leads'))
          .filter(l => String(l.created_at).slice(0, 10) === today);
        todays.forEach(l => {
          const k = Number(l.assigned_to) || 0;
          counts[k] = (counts[k] || 0) + 1;
        });
        ids.sort((a, b) => (counts[a] || 0) - (counts[b] || 0));
        assignedUserId = ids[0];
        break;
      }
    }
  }
  if (assignedUserId) lead.assigned_to = assignedUserId;

  // 3. Duplicate check (within window). Always runs — we mark every dupe so
  // the "⚠️ Duplicates only" filter and the bulk-Dedupe button can see them.
  const policy = process.env.DUPLICATE_POLICY || 'allow';
  const hours = Number(process.env.DUPLICATE_WINDOW_HOURS) || 24;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const phoneDigits = String(lead.phone || '').replace(/\D/g, '');
  const emailLower  = String(lead.email || '').toLowerCase();
  const dup = (phoneDigits || emailLower)
    ? (await db.getAll('leads')).find(l => {
        if (String(l.created_at) < since) return false;
        const lp = String(l.phone || '').replace(/\D/g, '');
        const le = String(l.email || '').toLowerCase();
        return (phoneDigits && lp === phoneDigits) ||
               (emailLower && le === emailLower);
      })
    : null;

  if (dup) {
    // Always flag — visible to the dedupe filter even under the default 'allow' policy
    lead.is_duplicate = 1;
    lead.duplicate_of = dup.id;
    if (policy === 'reject') {
      return { duplicate: true, matched_id: dup.id, skipped: true };
    }
    if (policy === 'assign_same_user' && dup.assigned_to) {
      lead.assigned_to = dup.assigned_to;
    }
    if (policy === 'skip_assignment') lead.assigned_to = null;
    lead.notes = (lead.notes || '') + '\n[DUPLICATE of lead #' + dup.id + ']';
  }
  // Also flag is_duplicate=1 if the row's tag explicitly says "Duplicate"
  if (!lead.is_duplicate && /\b(duplicate|dup)\b/i.test(String(lead.tags || ''))) {
    lead.is_duplicate = 1;
  }

  const id = await db.insert('leads', lead);

  if (lead.assigned_to) {
    await db.insert('notifications', {
      user_id: lead.assigned_to,
      type: 'lead_assigned',
      title: 'New lead: ' + (lead.name || lead.phone || ''),
      body:  'Source: ' + (lead.source || ''),
      link:  '#/leads/' + id,
      is_read: 0,
      created_at: db.nowIso()
    });
  }
  // Fire automations for inbound leads
  try { require('../utils/automations').fire('lead_created', { lead: Object.assign({ id }, lead) }); } catch (_) {}
  return { id, assigned_to: lead.assigned_to || null };
}

// -------------------- Calendly inbound webhook --------------------
/**
 * POST /hook/calendly/:token
 *
 * Calendly POSTs here when an invitee creates or cancels a meeting.
 * The :token in the URL identifies the rep — each user has a unique
 * users.calendly_webhook_token they paste into Calendly's webhook
 * config (Integrations → Webhooks → Add).
 *
 * On invitee.created: find a matching lead by email/phone (preferring
 * one assigned to this rep), then create a follow-up at the booked
 * start_time and add a remark "📅 Meeting confirmed for ...".
 * If no lead matches, auto-create one with source=Calendly so the
 * booking isn't lost.
 *
 * On invitee.canceled: mark the most recent open follow-up done and
 * log a cancellation remark.
 *
 * Always returns 200 unless the URL token is missing/wrong, so
 * Calendly doesn't keep retrying on benign data issues. Errors are
 * logged for admin triage.
 */
async function calendlyEvent(req, res) {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'missing token' });
    const all = await db.getAll('users');
    const rep = all.find(u => String(u.calendly_webhook_token || '') === token);
    if (!rep) return res.status(404).json({ error: 'unknown token' });

    const ev = req.body || {};
    const kind = ev.event || (ev.payload && ev.payload.event) || '';
    const p = ev.payload || ev;

    // Calendly's body shape varies a bit by plan / API version. Be defensive.
    const inviteeEmail = String(p.email || (p.invitee && p.invitee.email) || '').trim().toLowerCase();
    const inviteeName  = String(p.name  || (p.invitee && p.invitee.name)  || '').trim();
    const qa = Array.isArray(p.questions_and_answers)
      ? p.questions_and_answers
      : (p.invitee && Array.isArray(p.invitee.questions_and_answers) ? p.invitee.questions_and_answers : []);
    const phoneAnswer = qa.find(q => /phone|mobile|whatsapp|number/i.test(q.question || '')) || null;
    const inviteePhoneRaw = String((phoneAnswer && phoneAnswer.answer) || p.text_reminder_number || '').trim();
    const inviteePhone = inviteePhoneRaw.replace(/\D/g, '');

    const sched = p.scheduled_event || p.event || {};
    const startTime = sched.start_time || p.start_time || p.start || null;
    const eventName = sched.name || sched.event_type || 'Calendly meeting';

    const leads = await db.getAll('leads');
    const norm = (s) => String(s || '').replace(/\D/g, '');
    let lead = null;
    if (inviteeEmail) {
      lead = leads.find(l => String(l.email || '').toLowerCase() === inviteeEmail && Number(l.assigned_to) === Number(rep.id))
          || leads.find(l => String(l.email || '').toLowerCase() === inviteeEmail);
    }
    if (!lead && inviteePhone) {
      lead = leads.find(l => norm(l.phone) === inviteePhone && Number(l.assigned_to) === Number(rep.id))
          || leads.find(l => norm(l.phone).slice(-10) === inviteePhone.slice(-10) && norm(l.phone).length >= 10);
    }

    if (kind === 'invitee.created' || kind === 'invitee_created') {
      if (!lead) {
        const _newStatusId = await (async () => {
          const s = await db.findOneBy('statuses', 'name', 'New');
          return s ? s.id : null;
        })();
        const newLeadId = await db.insert('leads', {
          name: inviteeName || inviteeEmail || 'Calendly booking',
          phone: inviteePhone || '',
          email: inviteeEmail || '',
          source: 'Calendly',
          source_ref: 'webhook',
          status_id: _newStatusId,
          assigned_to: rep.id,
          notes: 'Auto-created from Calendly booking · ' + eventName,
          created_by: rep.id,
          created_at: db.nowIso(),
          updated_at: db.nowIso(),
          last_status_change_at: db.nowIso(),
          next_followup_at: startTime || null
        });
        lead = await db.findOneBy('leads', 'id', newLeadId);
      } else if (startTime) {
        await db.update('leads', lead.id, {
          next_followup_at: startTime,
          updated_at: db.nowIso()
        });
      }
      if (startTime && lead) {
        await db.insert('followups', {
          lead_id: lead.id, user_id: rep.id, due_at: startTime,
          note: '📅 Calendly: ' + eventName + (inviteeName ? ' with ' + inviteeName : ''),
          is_done: 0, created_at: db.nowIso()
        });
        await db.insert('remarks', {
          lead_id: lead.id, user_id: rep.id,
          remark: '📅 Meeting confirmed for ' + new Date(startTime).toLocaleString('en-IN') +
                  ' · ' + eventName + ' · via Calendly',
          status_id: ''
        });
      }
      return res.json({ ok: true, lead_id: lead ? lead.id : null });
    }

    if (kind === 'invitee.canceled' || kind === 'invitee_canceled') {
      if (!lead) return res.json({ ok: true, ignored: 'no matching lead' });
      const fus = (await db.getAll('followups'))
        .filter(f => Number(f.lead_id) === Number(lead.id) && Number(f.is_done) === 0)
        .sort((a, b) => String(b.due_at).localeCompare(String(a.due_at)));
      if (fus.length) {
        await db.update('followups', fus[0].id, { is_done: 1, done_at: db.nowIso() });
      }
      await db.insert('remarks', {
        lead_id: lead.id, user_id: rep.id,
        remark: '❌ Calendly meeting canceled' +
                (startTime ? ' (was scheduled for ' + new Date(startTime).toLocaleString('en-IN') + ')' : '') +
                (p.cancellation && p.cancellation.reason ? ' · reason: ' + p.cancellation.reason : ''),
        status_id: ''
      });
      return res.json({ ok: true, lead_id: lead.id, action: 'canceled' });
    }

    return res.json({ ok: true, ignored: 'unhandled event ' + kind });
  } catch (e) {
    console.error('[calendly] webhook error:', e.message);
    return res.json({ ok: false, error: String(e.message || e) });
  }
}

module.exports = {
  metaVerify, metaEvent,
  whatsappVerify, whatsappEvent,
  websiteHook, otherHook,
  calendlyEvent
};
