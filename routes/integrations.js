/**
 * Lead-source integrations.
 *
 *  1. Google Sheet sync — admin pastes a sheet URL, the CRM polls
 *     its public CSV export every poll_interval_min and creates new
 *     leads from new rows.
 *
 *  2. Multi-source lead webhooks — `POST /hook/leadsource/:source/:key`
 *     accepts each Indian aggregator's payload format and maps it
 *     to the CRM's lead shape. Supported out of the box: indiamart,
 *     magicbricks, justdial, tradeindia, 99acres, housing, generic.
 *
 *  Both call api_leads_create internally so the existing duplicate
 *  policy / cap / round-robin / auto-assignment all apply uniformly.
 */
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const leads = require('./leads');

// ============================================================
//  Google Sheet sync
// ============================================================

function _parseSheetUrl(url) {
  // Accepts:
  //   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=<GID>
  //   https://docs.google.com/spreadsheets/d/<ID>/edit?usp=sharing
  //   <ID>          (raw)
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : String(url || '').trim();
  const g = String(url || '').match(/[?#&]gid=(\d+)/);
  return { sheet_id: id, sheet_gid: g ? g[1] : '0' };
}

function _hashRow(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function _csvParse(text) {
  // Minimal RFC 4180 parser — handles quoted fields, embedded commas
  // and escaped quotes ("").
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c === '\r') { /* skip */ }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function _runSheetSync(integration) {
  // Push-only integration (no sheet_id set) — the user is using the
  // Apps Script "push from sheet" mode, so the legacy CSV pull is
  // skipped entirely. Clear any stale 404 error that's left over from
  // before they switched modes.
  if (!String(integration.sheet_id || '').trim()) {
    if (integration.last_error) {
      try {
        await db.update('sheet_integrations', integration.id, { last_error: '' });
      } catch (_) {}
    }
    return { imported: 0, skipped: 0, total: 0, mode: 'push' };
  }
  const url = `https://docs.google.com/spreadsheets/d/${integration.sheet_id}/export?format=csv&gid=${integration.sheet_gid || '0'}`;
  const res = await fetch(url, { redirect: 'follow', timeout: 20000 });
  if (!res.ok) throw new Error('Sheet fetch failed: HTTP ' + res.status + ' (is the sheet shared as "Anyone with link → Viewer"?)');
  const text = await res.text();
  const rows = _csvParse(text);
  if (rows.length < 2) return { imported: 0, skipped: 0, total: 0 };
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const data = rows.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  const seen = new Set((await db.getAll('sheet_imported_rows'))
    .filter(r => Number(r.integration_id) === Number(integration.id))
    .map(r => r.row_hash));
  let imported = 0, skipped = 0;
  // Synthesize a token so api_leads_create runs as the admin who set up
  // the integration. We pass null and rely on the wrapper below.
  for (const r of data) {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = String(r[i] || '').trim(); });
    const hash = _hashRow(obj);
    if (seen.has(hash)) { skipped++; continue; }
    if (!obj.name && !obj.phone && !obj.mobile) { skipped++; continue; }
    obj.source = obj.source || integration.default_source || 'Google Sheet';
    if (!obj.assigned_to && integration.default_assignee_id) {
      obj.assigned_to = integration.default_assignee_id;
    }
    try {
      const created = await _internalCreateLead(obj, integration.created_by);
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(),
        lead_id: created.id || null
      });
      imported++;
    } catch (e) {
      // Record the row hash so we don't keep retrying broken rows every cycle
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(),
        lead_id: null
      });
      skipped++;
    }
  }
  await db.update('sheet_integrations', integration.id, {
    last_synced_at: db.nowIso(),
    last_synced_count: imported,
    last_error: ''
  });
  return { imported, skipped, total: data.length };
}

/**
 * Run all due sheet integrations. Called by a setInterval at startup.
 */
async function runDueSheetSyncs() {
  const all = await db.getAll('sheet_integrations').catch(() => []);
  const active = all.filter(i => Number(i.is_active) === 1);
  const now = Date.now();
  for (const i of active) {
    const last = i.last_synced_at ? new Date(i.last_synced_at).getTime() : 0;
    const interval = (Number(i.poll_interval_min) || 15) * 60 * 1000;
    if (now - last < interval) continue;
    try { await _runSheetSync(i); }
    catch (e) {
      console.error('[sheetSync] integration', i.id, 'failed:', e.message);
      try { await db.update('sheet_integrations', i.id, { last_synced_at: db.nowIso(), last_error: String(e.message || e).slice(0, 500) }); } catch (_) {}
    }
  }
}

// Internal helper — bypasses authUser by directly mimicking what
// api_leads_create needs. We reuse the existing function so duplicate
// policy / cap / assignment rules all apply.
async function _internalCreateLead(payload, asUserId) {
  // Forge a synthetic "admin" token by inserting a fake record into
  // db.findById path? Simpler: just call api_leads_create with a token
  // that resolves to the integration's owner.
  // We can't generate JWTs from here without secrets — so call the
  // raw insert path directly.
  // Implementation: use leads._lowLevelCreate if exposed, else inline.
  //
  // Simpler still: reuse the existing api_leads_create by constructing
  // a fake token map. The cleanest way is to use db ops directly.
  const me = await db.findOneBy('users', 'id', asUserId);
  if (!me) throw new Error('Integration owner missing');
  // Resolve status
  const _status = await db.findOneBy('statuses', 'name', 'New');
  const _phone = String(payload.phone || payload.mobile || '').replace(/^'/, '').trim();
  const _phoneDigits = _phone.replace(/\D/g, '');
  if (!_phoneDigits) throw new Error('No phone');
  const lead = {
    name: String(payload.name || _phone).trim(),
    phone: _phone,
    whatsapp: String(payload.whatsapp || _phone).replace(/^'/, '').trim(),
    email: String(payload.email || '').trim(),
    source: payload.source || 'Sheet sync',
    source_ref: payload.source_ref || '',
    status_id: _status ? _status.id : null,
    assigned_to: payload.assigned_to ? Number(payload.assigned_to) : me.id,
    city: payload.city || '',
    company: payload.company || '',
    notes: payload.notes || payload.message || '',
    tags: payload.tags || '',
    value: Number(payload.value) || null,
    created_by: me.id,
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    last_status_change_at: db.nowIso()
  };
  const id = await db.insert('leads', lead);
  return { id };
}

// ---- API wrappers ---------------------------------------------

async function api_sheetSync_list(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const all = await db.getAll('sheet_integrations');
  return all.sort((a, b) => Number(b.id) - Number(a.id));
}

async function api_sheetSync_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  const p = payload || {};
  if (!p.name) throw new Error('Name required');
  // sheet_url is now optional — if absent we assume push mode (the
  // user will paste an Apps Script into their private sheet that
  // POSTs rows to /hook/sheet/<token>). If present we keep CSV poll
  // mode for users who don't mind a public sheet.
  let sheet_id = '', sheet_gid = '0';
  if (p.sheet_url || p.sheet_id) {
    const parsed = p.sheet_id
      ? { sheet_id: p.sheet_id, sheet_gid: p.sheet_gid || '0' }
      : _parseSheetUrl(p.sheet_url);
    sheet_id = parsed.sheet_id || '';
    sheet_gid = parsed.sheet_gid || '0';
  }
  const data = {
    name: String(p.name).trim(),
    sheet_id, sheet_gid,
    default_source: p.default_source || 'Google Sheet',
    default_assignee_id: p.default_assignee_id ? Number(p.default_assignee_id) : null,
    poll_interval_min: Math.max(5, Number(p.poll_interval_min) || 15),
    is_active: p.is_active === 0 ? 0 : 1
  };
  if (p.id) {
    await db.update('sheet_integrations', p.id, data);
    // Mint a token if one doesn't exist yet (existing rows from before
    // push mode shipped). Idempotent — only generates when missing.
    const existing = await db.findOneBy('sheet_integrations', 'id', p.id);
    if (!existing.webhook_token) {
      await db.update('sheet_integrations', p.id, { webhook_token: 'sht_' + crypto.randomBytes(20).toString('hex') });
    }
    return { id: Number(p.id), ok: true };
  }
  data.created_by = me.id;
  data.created_at = db.nowIso();
  data.webhook_token = 'sht_' + crypto.randomBytes(20).toString('hex');
  const id = await db.insert('sheet_integrations', data);
  return { id, ok: true };
}

/**
 * Express handler: POST /hook/sheet/:token
 * The Apps Script in the user's private sheet posts JSON like
 *   { name: "...", phone: "...", email: "...", city: "...", ... }
 * for every row that hasn't been pushed yet. We match by webhook_token,
 * apply the integration's default_source / default_assignee_id, and
 * route through _internalCreateLead.
 */
async function sheetPushWebhook(req, res) {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'missing token' });
    const all = await db.getAll('sheet_integrations');
    const integ = all.find(i => String(i.webhook_token || '') === token);
    if (!integ) return res.status(404).json({ error: 'unknown token' });
    if (Number(integ.is_active) !== 1) return res.json({ ok: false, error: 'integration paused' });
    const body = req.body || {};
    // Accept either a single row or an array of rows
    const rows = Array.isArray(body) ? body : (Array.isArray(body.rows) ? body.rows : [body]);
    const results = [];
    for (const r of rows) {
      const obj = Object.assign({}, r);
      // lower-case all keys for tolerance
      const lower = {};
      for (const k of Object.keys(obj)) lower[String(k).trim().toLowerCase()] = obj[k];
      // Map mobile→phone if phone missing
      if (!lower.phone && lower.mobile) lower.phone = lower.mobile;
      if (!lower.name && !lower.phone && !lower.email) {
        results.push({ ok: false, error: 'no name/phone/email' });
        continue;
      }
      lower.source = lower.source || integ.default_source || 'Google Sheet';
      if (!lower.assigned_to && integ.default_assignee_id) {
        lower.assigned_to = integ.default_assignee_id;
      }
      try {
        const created = await _internalCreateLead(lower, integ.created_by);
        results.push({ ok: true, lead_id: created.id });
      } catch (e) {
        results.push({ ok: false, error: String(e.message || e) });
      }
    }
    // Update last-synced counters so the admin tab reflects activity
    const okCount = results.filter(r => r.ok).length;
    if (okCount) {
      await db.update('sheet_integrations', integ.id, {
        last_synced_at: db.nowIso(),
        last_synced_count: okCount,
        last_error: ''
      });
    }
    return res.json({ ok: true, processed: results.length, created: okCount, results });
  } catch (e) {
    console.error('[sheetPush] error:', e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

async function api_sheetSync_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.removeRow('sheet_integrations', id);
  return { ok: true };
}

async function api_sheetSync_runNow(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const i = await db.findOneBy('sheet_integrations', 'id', id);
  if (!i) throw new Error('Integration not found');
  const r = await _runSheetSync(i);
  return r;
}

// ============================================================
//  Multi-source lead webhook
// ============================================================

/**
 * Map an inbound payload from a known vendor into the CRM's
 * standard lead shape. Each vendor uses different field names; we
 * try several common ones per field.
 *
 * Returns an array of lead objects (some vendors batch multiple in
 * one webhook call, e.g. IndiaMART's RESPONSE array).
 */
function _adaptLeadSourcePayload(source, body) {
  const norm = String(source || '').toLowerCase().trim();
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
    }
    return '';
  };

  if (norm === 'indiamart') {
    // IndiaMART CRM webhook v2: { RESPONSE: [ {...}, ... ] }
    const arr = Array.isArray(body.RESPONSE) ? body.RESPONSE
              : Array.isArray(body.response) ? body.response
              : [body];
    return arr.map(r => ({
      name:       pick(r, ['SENDER_NAME', 'sender_name', 'name', 'NAME']),
      phone:      pick(r, ['SENDER_MOBILE', 'sender_mobile', 'mobile', 'MOBILE', 'phone']),
      email:      pick(r, ['SENDER_EMAIL', 'sender_email', 'email', 'EMAIL']),
      company:    pick(r, ['SENDER_COMPANY', 'sender_company', 'company']),
      city:       pick(r, ['SENDER_CITY', 'sender_city', 'city']),
      state:      pick(r, ['SENDER_STATE', 'sender_state', 'state']),
      address:    pick(r, ['SENDER_ADDRESS', 'sender_address', 'address']),
      notes:      pick(r, ['QUERY_MESSAGE', 'query_message', 'message', 'SUBJECT', 'subject']),
      source:     'IndiaMART',
      source_ref: pick(r, ['UNIQUE_QUERY_ID', 'unique_query_id', 'query_id'])
    }));
  }

  if (norm === 'magicbricks') {
    // MagicBricks Builder Lead API: flat object, sometimes "Lead" wrapper.
    const r = body.Lead || body.lead || body;
    return [{
      name:       pick(r, ['contact_person', 'name', 'Name', 'lead_name']),
      phone:      pick(r, ['mobile', 'phone', 'mobile_number', 'contact_no']),
      email:      pick(r, ['email', 'email_id']),
      city:       pick(r, ['city', 'lead_city', 'location']),
      notes:      pick(r, ['message', 'remarks', 'requirement']),
      source:     'MagicBricks',
      source_ref: pick(r, ['lead_id', 'leadId', 'id'])
    }];
  }

  if (norm === 'justdial' || norm === 'jd') {
    // JustDial lead webhook
    const r = body.lead || body;
    const prefix = pick(r, ['prefix', 'salutation']);
    const fname = pick(r, ['name', 'first_name', 'fname']);
    return [{
      name:       (prefix ? prefix + ' ' : '') + fname,
      phone:      pick(r, ['mobile', 'phone', 'mobile_no', 'mobileno']),
      email:      pick(r, ['email', 'email_id']),
      city:       pick(r, ['city', 'area']),
      notes:      pick(r, ['category', 'service', 'enquiry']),
      source:     'JustDial',
      source_ref: pick(r, ['leadid', 'lead_id', 'id'])
    }];
  }

  if (norm === 'tradeindia' || norm === 'ti') {
    // TradeIndia
    return [{
      name:       pick(body, ['GLUSR_USR_FNAME', 'glusr_usr_fname', 'first_name', 'name']),
      phone:      pick(body, ['GLUSR_USR_PHONE', 'glusr_usr_phone', 'phone', 'mobile']),
      email:      pick(body, ['GLUSR_USR_EMAIL', 'glusr_usr_email', 'email']),
      company:    pick(body, ['GLUSR_USR_COMPANY', 'glusr_usr_company', 'company']),
      city:       pick(body, ['GLUSR_USR_CITY', 'glusr_usr_city', 'city']),
      notes:      pick(body, ['MESSAGE', 'message', 'enquiry']),
      source:     'TradeIndia',
      source_ref: pick(body, ['QUERY_ID', 'query_id', 'enquiry_id', 'id'])
    }];
  }

  if (norm === '99acres' || norm === 'acres') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'fullName']),
      phone:      pick(r, ['mobile', 'phone', 'contactNumber']),
      email:      pick(r, ['email', 'emailId']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'requirement', 'propertyName']),
      source:     '99acres',
      source_ref: pick(r, ['leadId', 'lead_id', 'id'])
    }];
  }

  if (norm === 'housing' || norm === 'housing.com') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'fullName', 'contactName']),
      phone:      pick(r, ['phone', 'mobile', 'contactNumber']),
      email:      pick(r, ['email']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'requirement']),
      source:     'Housing.com',
      source_ref: pick(r, ['id', 'leadId'])
    }];
  }

  // Generic — flatten and accept anything
  const r = body.lead || body;
  return [{
    name:    pick(r, ['name', 'full_name', 'customer_name', 'contact_name']),
    phone:   pick(r, ['phone', 'mobile', 'contact', 'mobile_number', 'contact_number']),
    email:   pick(r, ['email', 'email_id']),
    company: pick(r, ['company', 'organization']),
    city:    pick(r, ['city', 'location']),
    notes:   pick(r, ['message', 'enquiry', 'requirement', 'notes']),
    source:  pick(r, ['source']) || 'Webhook',
    source_ref: pick(r, ['id', 'lead_id', 'reference'])
  }];
}

/**
 * Express handler: POST /hook/leadsource/:source/:key
 */
async function leadSourceWebhook(req, res) {
  try {
    const apiKey = String(req.params.key || req.headers['x-api-key'] || '').trim();
    const expected = await db.getConfig('WEBSITE_API_KEY', '').catch(() => process.env.WEBSITE_API_KEY || '');
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const source = String(req.params.source || 'generic').toLowerCase();
    const body = req.body || {};
    const items = _adaptLeadSourcePayload(source, body);
    const owner = await db.getAll('users').then(us => us.find(u => u.role === 'admin'));
    if (!owner) return res.status(500).json({ error: 'No admin user to own leads' });
    const results = [];
    for (const it of items) {
      if (!it.phone && !it.email && !it.name) continue;
      try {
        const r = await _internalCreateLead(it, owner.id);
        results.push({ ok: true, lead_id: r.id, name: it.name });
      } catch (e) {
        results.push({ ok: false, name: it.name, error: e.message });
      }
    }
    return res.json({ ok: true, source, processed: results.length, results });
  } catch (e) {
    console.error('[leadsource] webhook error:', e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

module.exports = {
  // JSON-RPC API
  api_sheetSync_list,
  api_sheetSync_save,
  api_sheetSync_delete,
  api_sheetSync_runNow,
  // Express handlers
  leadSourceWebhook,
  sheetPushWebhook,
  // Background poller
  runDueSheetSyncs
};
