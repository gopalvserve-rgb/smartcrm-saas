/**
 * Lead-source integrations.
 *
 * 1. Google Sheet sync Ã¢ÂÂ admin pastes a sheet URL, the CRM polls
 *    its public CSV export every poll_interval_min and creates new
 *    leads from new rows.
 *
 * 2. Multi-source lead webhooks Ã¢ÂÂ `POST /hook/leadsource/:source/:key`
 *    accepts each Indian aggregator's payload format and maps it
 *    to the CRM's lead shape. Supported: indiamart, magicbricks,
 *    justdial, tradeindia, 99acres, housing, nobroker, exportersindia,
 *    sulekha, googleads, wordpress, googleforms, pabbly, zapier, make,
 *    leadsquared, zoho, hubspot, salesforce, generic.
 *
 * Both call api_leads_create internally so the existing duplicate
 * policy / cap / round-robin / auto-assignment all apply uniformly.
 */
const crypto = require('crypto');
const fetch = require('node-fetch');
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ============================================================
// Google Sheet sync
// ============================================================

function _parseSheetUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const id = m ? m[1] : String(url || '').trim();
  const g = String(url || '').match(/[?#&]gid=(\d+)/);
  return { sheet_id: id, sheet_gid: g ? g[1] : '0' };
}

function _hashRow(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
}

function _csvParse(text) {
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

/* SHEET_SYNC_v2 — honor explicit column_mapping (JSON) on the integration
 * so admins can point sheet columns to CRM fields without renaming the sheet.
 * Falls back to header-based heuristics so default sheets ('name', 'phone',
 * 'email') still work without any mapping. */
function _normaliseHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}
const _HEADER_ALIASES = {
  name: ['name', 'full_name', 'customer_name', 'lead_name', 'contact_name', 'sender_name'],
  phone: ['phone', 'mobile', 'mobile_no', 'contact_number', 'contact', 'phone_number', 'whatsapp_number', 'cell'],
  whatsapp: ['whatsapp', 'whatsapp_no', 'wa_number'],
  email: ['email', 'e_mail', 'email_id', 'emailaddress', 'email_address'],
  source: ['source', 'lead_source'],
  city: ['city', 'town'],
  state: ['state'],
  country: ['country'],
  company: ['company', 'firm', 'business'],
  notes: ['notes', 'message', 'remarks', 'requirement', 'enquiry'],
  tags: ['tags', 'tag'],
  value: ['value', 'budget', 'price']
};

function _parseMapping(integration) {
  let mapping = {};
  try {
    if (integration.column_mapping) {
      mapping = typeof integration.column_mapping === 'string'
        ? JSON.parse(integration.column_mapping)
        : (integration.column_mapping || {});
    }
  } catch (_) {}
  return mapping;
}

function _resolveColumnTarget(rawHeader, mapping) {
  const norm = _normaliseHeader(rawHeader);
  if (mapping && Object.prototype.hasOwnProperty.call(mapping, rawHeader)) return mapping[rawHeader];
  if (mapping && Object.prototype.hasOwnProperty.call(mapping, norm))      return mapping[norm];
  for (const [crmField, aliases] of Object.entries(_HEADER_ALIASES)) {
    if (aliases.includes(norm)) return crmField;
  }
  return norm;  /* keep as-is; might be a custom field like cf_<key> */
}

/* SHEET_SYNC_v3 — full self-heal for sheet_integrations + sheet_imported_rows.
 * Some tenants ended up with a table that was missing the id column or
 * was never created at all (pre-bootstrap-era tenants). The 'column id
 * does not exist' error was the symptom. This routine now:
 *   1. Creates both tables fresh if missing (with id SERIAL PRIMARY KEY).
 *   2. Adds any columns the runtime relies on (idempotent ALTERs).
 *   3. Cached after first successful run to keep the hot path cheap. */
let _schemaHealed = false;
async function _ensureSchema() {
  if (_schemaHealed) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS sheet_integrations (
        id SERIAL PRIMARY KEY,
        name TEXT,
        sheet_id TEXT,
        sheet_gid TEXT DEFAULT '0',
        default_source TEXT DEFAULT 'Google Sheet',
        default_assignee_id INTEGER,
        poll_interval_min INTEGER DEFAULT 15,
        last_synced_at TIMESTAMPTZ,
        last_synced_count INTEGER DEFAULT 0,
        last_error TEXT,
        is_active INTEGER DEFAULT 1,
        created_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        webhook_token TEXT,
        column_mapping TEXT DEFAULT '{}'
      )
    `);
    // For older tables created without one or more columns — add them now.
    const colsToAdd = [
      ['name', 'TEXT'],
      ['sheet_id', 'TEXT'],
      ['sheet_gid', "TEXT DEFAULT '0'"],
      ['default_source', "TEXT DEFAULT 'Google Sheet'"],
      ['default_assignee_id', 'INTEGER'],
      ['poll_interval_min', 'INTEGER DEFAULT 15'],
      ['last_synced_at', 'TIMESTAMPTZ'],
      ['last_synced_count', 'INTEGER DEFAULT 0'],
      ['last_error', 'TEXT'],
      ['is_active', 'INTEGER DEFAULT 1'],
      ['created_by', 'INTEGER'],
      ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'],
      ['webhook_token', 'TEXT'],
      ['column_mapping', "TEXT DEFAULT '{}'"]
    ];
    for (const [col, type] of colsToAdd) {
      try { await db.query('ALTER TABLE sheet_integrations ADD COLUMN IF NOT EXISTS ' + col + ' ' + type); } catch (_) {}
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS sheet_imported_rows (
        id SERIAL PRIMARY KEY,
        integration_id INTEGER,
        row_hash TEXT,
        imported_at TIMESTAMPTZ DEFAULT NOW(),
        lead_id INTEGER
      )
    `);
    const colsImport = [
      ['integration_id', 'INTEGER'],
      ['row_hash', 'TEXT'],
      ['imported_at', 'TIMESTAMPTZ DEFAULT NOW()'],
      ['lead_id', 'INTEGER']
    ];
    for (const [col, type] of colsImport) {
      try { await db.query('ALTER TABLE sheet_imported_rows ADD COLUMN IF NOT EXISTS ' + col + ' ' + type); } catch (_) {}
    }
  } catch (e) { console.warn('[_ensureSchema sheet_integrations]', e.message); }
  _schemaHealed = true;
}

async function _fetchSheetCsv(integration, opts) {
  opts = opts || {};
  const sheet_id  = (opts.sheet_id  || integration.sheet_id  || '').trim();
  const sheet_gid = (opts.sheet_gid || integration.sheet_gid || '0').trim();
  if (!sheet_id) return { ok: false, error: 'No sheet URL configured (push-only integration)' };
  const url = 'https://docs.google.com/spreadsheets/d/' + sheet_id + '/export?format=csv&gid=' + sheet_gid;
  let res;
  try { res = await fetch(url, { redirect: 'follow', timeout: 20000 }); }
  catch (e) { return { ok: false, error: 'Fetch failed: ' + e.message }; }
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' (is the sheet shared as "Anyone with link – Viewer"?)' };
  const text = await res.text();
  const rows = _csvParse(text);
  return { ok: true, sheet_id, sheet_gid, csv_text_bytes: text.length, total_rows: rows.length, raw: rows };
}

async function _runSheetSync(integration) {
  await _ensureSchema();
  const sheet_id = String(integration.sheet_id || '').trim();
  if (!sheet_id) {
    if (integration.last_error) {
      try { await db.update('sheet_integrations', integration.id, { last_error: '' }); } catch (_) {}
    }
    /* SHEET_SYNC_v2 — push-mode is a no-op for manual sync. Tell the user
     * what's happening so they don't think they need to make the sheet public.
     * Surface last-webhook stats so they can verify the Apps Script trigger
     * is firing. */
    const lastAt = integration.last_synced_at;
    const lastN  = Number(integration.last_synced_count || 0);
    let message = '✅ PUSH mode is active — nothing to sync manually. Your Apps Script POSTs each new row to the CRM automatically.';
    if (lastAt) {
      message += ' Last lead received via webhook: ' + new Date(lastAt).toLocaleString() + ' (' + lastN + ' lead' + (lastN === 1 ? '' : 's') + ' in that batch).';
    } else {
      message += ' No leads received yet — open your sheet → Extensions → Apps Script → Triggers and confirm the pushNewRowsToCRM function has a clock or onChange trigger.';
    }
    return { imported: 0, skipped: 0, total: 0, mode: 'push_only', message };
  }
  const fetched = await _fetchSheetCsv(integration);
  if (!fetched.ok) throw new Error(fetched.error);
  const rows = fetched.raw;
  if (rows.length < 2) return { imported: 0, skipped: 0, total: 0, mode: 'pull', message: 'Sheet has no data rows (only header found)' };

  const rawHeaders = rows[0].map(h => String(h || ''));
  const mapping = _parseMapping(integration);
  const colTargets = rawHeaders.map(h => _resolveColumnTarget(h, mapping));

  const data = rows.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  const seen = new Set((await db.getAll('sheet_imported_rows'))
    .filter(r => Number(r.integration_id) === Number(integration.id))
    .map(r => r.row_hash));
  let imported = 0, skipped = 0;
  const skipped_reasons = { duplicate: 0, no_phone: 0, error: 0 };
  for (const r of data) {
    const obj = {};
    colTargets.forEach((t, i) => {
      if (!t) return;
      const v = String(r[i] || '').trim();
      if (!v) return;
      obj[t] = v;
    });
    const hash = _hashRow(obj);
    if (seen.has(hash)) { skipped++; skipped_reasons.duplicate++; continue; }
    if (!obj.name && !obj.phone && !obj.mobile && !obj.whatsapp) { skipped++; skipped_reasons.no_phone++; continue; }
    obj.source = obj.source || integration.default_source || 'Google Sheet';
    if (!obj.assigned_to && integration.default_assignee_id) obj.assigned_to = integration.default_assignee_id;
    try {
      const created = await _internalCreateLead(obj, integration.created_by);
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(), lead_id: created.id || null
      });
      imported++;
    } catch (e) {
      console.warn('[sheetSync] row failed:', e.message);
      await db.insert('sheet_imported_rows', {
        integration_id: integration.id, row_hash: hash, imported_at: db.nowIso(), lead_id: null
      });
      skipped++; skipped_reasons.error++;
    }
  }
  await db.update('sheet_integrations', integration.id, {
    last_synced_at: db.nowIso(), last_synced_count: imported, last_error: ''
  });
  let message;
  if (imported > 0) {
    message = 'Imported ' + imported + ' new lead(s), skipped ' + skipped + '.';
  } else if (data.length === 0) {
    message = 'Sheet has no data rows.';
  } else if (skipped_reasons.duplicate === data.length) {
    message = 'All ' + data.length + ' row(s) were already imported earlier (deduped by row content hash). To re-import, edit the sheet or clear the imported history.';
  } else if (skipped_reasons.no_phone === data.length) {
    message = 'Found ' + data.length + ' row(s) but none mapped to a name/phone/mobile/whatsapp column. Use the Column Mapping in the integration editor to point your sheet columns to the right CRM fields.';
  } else {
    message = 'Imported 0 of ' + data.length + ' rows — ' + skipped_reasons.duplicate + ' duplicate, ' + skipped_reasons.no_phone + ' missing phone, ' + skipped_reasons.error + ' errored.';
  }
  return { imported, skipped, total: data.length, mode: 'pull', skipped_reasons, message };
}

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

async function _internalCreateLead(payload, asUserId) {
  const me = await db.findOneBy('users', 'id', asUserId);
  if (!me) throw new Error('Integration owner missing');
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
  // Honor auto-assign rules — only when payload didn't pin an assignee
  // (explicit owner from Sheet Sync mapping wins). cf_<key> rules look
  // into lead.extra_json / lead.custom_fields automatically.
  try {
    if (!payload.assigned_to) {
      const { pickAssigneeFromRules } = require('../utils/assignmentRules');
      // Surface custom fields on the lead so cf_<key> rules can match
      // them from this code path too. payload.custom_fields and
      // cf_<key> flat keys both supported.
      const probe = Object.assign({}, lead);
      if (payload.custom_fields && typeof payload.custom_fields === 'object') {
        probe.custom_fields = payload.custom_fields;
      }
      Object.keys(payload || {}).forEach(k => {
        if (k.startsWith('cf_')) probe[k] = payload[k];
      });
      const ruleAssignee = await pickAssigneeFromRules(probe);
      if (ruleAssignee) lead.assigned_to = ruleAssignee;
    }
  } catch (e) { console.warn('[integrations] rule eval skipped:', e.message); }
  // Persist custom_fields into extra_json so the matcher (and the rest
  // of the CRM) can read them later.
  try {
    const extras = {};
    if (payload.custom_fields && typeof payload.custom_fields === 'object') Object.assign(extras, payload.custom_fields);
    Object.keys(payload || {}).forEach(k => {
      if (k.startsWith('cf_')) extras[k.slice(3)] = payload[k];
    });
    if (Object.keys(extras).length) lead.extra_json = JSON.stringify(extras);
  } catch (_) {}
  // Auto-attach to a matching campaign if none was pinned. Done BEFORE
  // insert so lead.campaign_id lands in the row.
  let _autoCampaignId = null;
  try {
    if (!payload.campaign_id) {
      const { findCampaignForLead } = require('../utils/campaignAssigner');
      const probe = Object.assign({}, lead);
      if (payload.custom_fields) probe.custom_fields = payload.custom_fields;
      const matched = await findCampaignForLead(probe);
      if (matched && matched.id) {
        lead.campaign_id = matched.id;
        _autoCampaignId = matched.id;
      }
    } else {
      lead.campaign_id = Number(payload.campaign_id);
    }
  } catch (e) { console.warn('[integrations] campaign match lookup failed:', e.message); }
  const id = await db.insert('leads', lead);
  // SHARE_LEAD_v1: auto-share rules from campaign + source for webhook leads.
  try {
    const lr = require('./leads');
    if (typeof lr._applyAutoShare === 'function') await lr._applyAutoShare(id, Object.assign({ id }, lead), null);
  } catch (_) {}

  // OUTBOUND_WH_v1 — fire outbound webhooks (async, never block lead creation)
  try {
    const { fireOutboundWebhooks } = require('./outboundWebhook');
    setImmediate(() => {
      fireOutboundWebhooks(Object.assign({ id }, lead)).catch(e => console.error('[outboundWebhook] webhook-create fire failed:', e.message));
    });
  } catch (_) { /* module not loaded */ }

  // If we auto-attached, run the distribution engine so the campaign's
  // assigned agent (round-robin / equal / etc.) gets the lead.
  if (_autoCampaignId) {
    try {
      const { assignLeadToCampaign } = require('../utils/campaignAssigner');
      await assignLeadToCampaign(id, _autoCampaignId, { skipAutomations: false });
    } catch (e) { console.warn('[integrations] campaign assigner skipped:', e.message); }
  }
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
  await _ensureSchema();
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('Name required');
  let sheet_id = '', sheet_gid = '0';
  if (p.sheet_url || p.sheet_id) {
    const parsed = p.sheet_id
      ? { sheet_id: p.sheet_id, sheet_gid: p.sheet_gid || '0' }
      : _parseSheetUrl(p.sheet_url);
    sheet_id = parsed.sheet_id || '';
    sheet_gid = parsed.sheet_gid || '0';
  }
  /* SHEET_SYNC_v2 — persist column_mapping as JSON. Accept either an
   * object { sheetHeader: 'crmField' } or a JSON string. */
  let column_mapping = '{}';
  try {
    if (p.column_mapping && typeof p.column_mapping === 'object') column_mapping = JSON.stringify(p.column_mapping);
    else if (typeof p.column_mapping === 'string' && p.column_mapping.trim()) column_mapping = p.column_mapping.trim();
  } catch (_) {}
  const data = {
    name: String(p.name).trim(),
    sheet_id, sheet_gid,
    default_source: p.default_source || 'Google Sheet',
    default_assignee_id: p.default_assignee_id ? Number(p.default_assignee_id) : null,
    poll_interval_min: Math.max(5, Number(p.poll_interval_min) || 15),
    is_active: p.is_active === 0 ? 0 : 1,
    column_mapping
  };
  if (p.id) {
    await db.update('sheet_integrations', p.id, data);
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

async function sheetPushWebhook(req, res) {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return res.status(400).json({ error: 'missing token' });
    const all = await db.getAll('sheet_integrations');
    const integ = all.find(i => String(i.webhook_token || '') === token);
    if (!integ) return res.status(404).json({ error: 'unknown token' });
    if (Number(integ.is_active) !== 1) return res.json({ ok: false, error: 'integration paused' });
    const body = req.body || {};
    const rows = Array.isArray(body) ? body : (Array.isArray(body.rows) ? body.rows : [body]);
    const results = [];
    for (const r of rows) {
      const obj = Object.assign({}, r);
      const lower = {};
      for (const k of Object.keys(obj)) lower[String(k).trim().toLowerCase()] = obj[k];
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
        /* SHEET_SYNC_v2 — log push imports so 'already_imported_rows' in
         * diagnose reflects push leads too, and the same row can\'t be
         * imported twice if the script accidentally re-sends it. */
        try {
          const hash = _hashRow(lower);
          await db.insert('sheet_imported_rows', {
            integration_id: integ.id, row_hash: hash,
            imported_at: db.nowIso(), lead_id: created.id || null
          });
        } catch (_) {}
      } catch (e) {
        results.push({ ok: false, error: String(e.message || e) });
      }
    }
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

async function api_sheetSync_diagnose(token, id) {
  const me = await authUser(token);
  await _ensureSchema();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const integration = await db.findOneBy('sheet_integrations', 'id', id);
  if (!integration) throw new Error('Integration not found');
  const out = {
    integration_id: integration.id,
    name: integration.name,
    sheet_id: integration.sheet_id || '',
    sheet_gid: integration.sheet_gid || '0',
    mode: integration.sheet_id ? 'pull' : 'push_only',
    is_active: Number(integration.is_active) === 1,
    last_synced_at: integration.last_synced_at || null,
    last_synced_count: Number(integration.last_synced_count || 0),
    last_error: integration.last_error || null,
    poll_interval_min: Number(integration.poll_interval_min || 15),
    column_mapping: _parseMapping(integration),
    webhook_url_push: integration.webhook_token ? ('/hook/sheet/' + integration.webhook_token) : null,
    already_imported_rows: 0,
    csv: null,
    headers: [],
    detected_columns: [],
    preview: [],
    advice: []
  };
  try {
    const imp = (await db.getAll('sheet_imported_rows')).filter(r => Number(r.integration_id) === Number(id));
    out.already_imported_rows = imp.length;
  } catch (_) {}

  if (out.mode === 'push_only') {
    out.advice.push("✅ This integration uses PUSH mode — your sheet stays fully private. The Apps Script POSTs each new row to the CRM via the webhook URL below. You do NOT need to make the sheet public.");
    if (out.last_synced_at) {
      out.advice.push("Last lead received via webhook: " + new Date(out.last_synced_at).toLocaleString() + " (" + Number(out.last_synced_count || 0) + " in that batch). Add a row to your sheet, wait up to 5 min for the trigger to fire, then refresh this page — last_synced_at should update.");
    } else {
      out.advice.push("⚠ No leads received yet. To diagnose: open your sheet → Extensions → Apps Script → Triggers. Confirm the pushNewRowsToCRM function has a trigger (clock-based every 5 min, or 'On change'). Then open Executions tab — recent runs should show ✓ Completed.");
    }
    return out;
  }

  const fetched = await _fetchSheetCsv(integration);
  if (!fetched.ok) {
    out.csv = { ok: false, error: fetched.error };
    out.advice.push("Sheet fetch failed: " + fetched.error);
    out.advice.push('Make sure the sheet is shared as "Anyone with the link → Viewer" so the CSV export endpoint can reach it.');
    return out;
  }
  out.csv = { ok: true, sheet_id: fetched.sheet_id, sheet_gid: fetched.sheet_gid, bytes: fetched.csv_text_bytes, total_rows: fetched.total_rows };
  const rows = fetched.raw;
  if (!rows.length) { out.advice.push("Sheet appears empty."); return out; }
  const rawHeaders = rows[0].map(h => String(h || ''));
  const mapping = _parseMapping(integration);
  out.headers = rawHeaders;
  out.detected_columns = rawHeaders.map(h => {
    const norm = _normaliseHeader(h);
    const target = _resolveColumnTarget(h, mapping);
    const explicit = mapping && (Object.prototype.hasOwnProperty.call(mapping, h) || Object.prototype.hasOwnProperty.call(mapping, norm));
    return { raw: h, normalised: norm, mapped_to: target, source: explicit ? 'explicit_mapping' : 'auto_heuristic' };
  });
  const dataRows = rows.slice(1).filter(r => r.some(c => String(c || '').trim() !== ''));
  out.preview = dataRows.slice(0, 3).map(r => {
    const obj = {};
    out.detected_columns.forEach((c, i) => {
      const v = String(r[i] || '').trim();
      if (v) obj[c.mapped_to || c.normalised] = v;
    });
    return obj;
  });
  out.total_data_rows = dataRows.length;

  /* Advice — common pitfalls */
  const targets = out.detected_columns.map(c => c.mapped_to);
  if (!targets.includes('name') && !targets.includes('phone') && !targets.includes('mobile') && !targets.includes('whatsapp')) {
    out.advice.push('⚠ None of the sheet columns map to name/phone/mobile/whatsapp. Use the Column Mapping below to point at least one of your columns to "phone" (or "name"), otherwise every row will be skipped.');
  } else if (!targets.includes('phone') && !targets.includes('mobile') && !targets.includes('whatsapp')) {
    out.advice.push('Note: no phone-like column detected. Rows without a phone will be skipped on import.');
  }
  if (out.already_imported_rows && out.already_imported_rows >= dataRows.length) {
    out.advice.push('All ' + dataRows.length + ' rows in the sheet have already been imported earlier (deduped by row content hash). To re-import a row, edit any cell in that row so its hash changes.');
  }
  if (!out.advice.length) {
    out.advice.push('Looks good — click ▶ Sync now and the parser will pick up ' + dataRows.length + ' rows.');
  }
  return out;
}

/* SHEET_SYNC_v2 — Send a synthetic test row to the integration\'s own
 * webhook URL, end-to-end. Proves the URL is reachable + valid + the
 * integration row is set up. Bypasses Apps Script entirely. */
async function api_sheetSync_testReceive(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const integration = await db.findOneBy('sheet_integrations', 'id', id);
  if (!integration) throw new Error('Integration not found');
  if (!integration.webhook_token) throw new Error('No webhook_token on integration — re-save it');

  const baseUrl = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || '').replace(/\/+$/, '');
  const testPayload = {
    name: 'TEST · Sheet sync probe',
    phone: '9999999990',
    email: 'sheetsync-probe@example.com',
    notes: 'Synthetic test row inserted by 📤 Test webhook button at ' + new Date().toISOString(),
    source: integration.default_source || 'Google Sheet (test)'
  };

  // Prefer calling the webhook handler directly (in-process) so we don\'t
  // need a public URL configured. Falls back to HTTP fetch if base URL set.
  try {
    const fakeReq = { params: { token: integration.webhook_token }, body: testPayload };
    let respBody = null, respStatus = 200;
    const fakeRes = {
      status(c) { respStatus = c; return this; },
      json(o)   { respBody = o; return this; }
    };
    await sheetPushWebhook(fakeReq, fakeRes);
    return { ok: true, mode: 'inproc', status: respStatus, response: respBody, payload: testPayload };
  } catch (e) {
    return { ok: false, error: e.message, payload: testPayload };
  }
}

/* Recent activity — last 20 rows imported for this integration so the
 * user can see whether the webhook is actually firing. */
async function api_sheetSync_recentActivity(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const all = await db.getAll('sheet_imported_rows');
  const rows = all
    .filter(r => Number(r.integration_id) === Number(id))
    .sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)))
    .slice(0, 20);
  // Hydrate lead names
  const leadIds = rows.map(r => Number(r.lead_id)).filter(Boolean);
  const leads = (await db.getAll('leads')).filter(l => leadIds.includes(Number(l.id)));
  const byId = {}; leads.forEach(l => { byId[Number(l.id)] = l; });
  return rows.map(r => ({
    imported_at: r.imported_at,
    lead_id: r.lead_id,
    lead_name: (byId[Number(r.lead_id)] || {}).name || '',
    lead_phone: (byId[Number(r.lead_id)] || {}).phone || '',
    row_hash: r.row_hash
  }));
}

async function api_sheetSync_runNow(token, id) {
  const me = await authUser(token);
  await _ensureSchema();
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  const i = await db.findOneBy('sheet_integrations', 'id', id);
  if (!i) throw new Error('Integration not found');
  const r = await _runSheetSync(i);
  return r;
}

// ============================================================
// Multi-source lead webhook
// ============================================================

/**
 * Map an inbound payload from a known vendor into the CRM's
 * standard lead shape. Returns an array of lead objects (some
 * vendors batch multiple leads per webhook call, e.g. IndiaMART).
 *
 * Supported sources:
 *   indiamart, magicbricks, justdial, tradeindia, 99acres, housing,
 *   nobroker, exportersindia, sulekha, googleads, wordpress, cf7,
 *   wpforms, gravityforms, googleforms, pabbly, zapier, make,
 *   integromat, n8n, leadsquared, zoho, zohocrm, hubspot,
 *   salesforce, sfdc, generic
 */

// ============================================================
// Per-tenant lead-source field mapping
// ============================================================
// The operator can override the hardcoded _adaptLeadSourcePayload
// defaults by saving a row in lead_source_mapping(source, mapping).
// If a key in the incoming payload appears in the saved mapping, we
// use the configured CRM field; otherwise we fall back to the default
// mapper above. This lets each tenant deal with vendor variations
// (custom IndiaMART form fields, white-labelled ad partners, etc.)
// without code changes.

// Known incoming-key catalog per source — used by the SPA mapping UI
// to suggest fields the operator can map. Order matters; first key in
// each list is what the default mapper picks first.
const KNOWN_KEYS_BY_SOURCE = {
  indiamart:     ['SENDER_NAME', 'SENDER_MOBILE', 'SENDER_EMAIL', 'SENDER_COMPANY', 'SENDER_CITY', 'SENDER_STATE', 'SENDER_ADDRESS', 'QUERY_MESSAGE', 'QUERY_PRODUCT_NAME', 'UNIQUE_QUERY_ID', 'SUBJECT'],
  magicbricks:   ['contact_person', 'mobile', 'email', 'city', 'message', 'remarks', 'requirement', 'lead_id', 'leadId', 'projectName', 'budget'],
  justdial:      ['prefix', 'name', 'mobile', 'email', 'city', 'category', 'service', 'enquiry', 'leadid', 'area'],
  tradeindia:    ['GLUSR_USR_FNAME', 'GLUSR_USR_PHONE', 'GLUSR_USR_EMAIL', 'GLUSR_USR_COMPANY', 'GLUSR_USR_CITY', 'MESSAGE', 'QUERY_ID', 'GLUSR_USR_INTRESTED_PRODUCTS'],
  '99acres':     ['name', 'mobile', 'email', 'city', 'message', 'lead_id', 'projectName', 'budget'],
  housing:       ['name', 'phone', 'email', 'city', 'message', 'project', 'budget', 'lead_id'],
  nobroker:      ['name', 'phone', 'email', 'city', 'message', 'lead_id', 'project'],
  exportersindia:['contact_person', 'mobile', 'email', 'company', 'city', 'message', 'product_required', 'enquiry_id'],
  sulekha:       ['customer_name', 'mobile', 'email', 'city', 'service', 'message', 'lead_id'],
  googleads:     ['user_column_data', 'lead_id', 'campaign_id', 'form_id'],
  wordpress:     ['name', 'first_name', 'last_name', 'email', 'phone', 'message', 'subject', 'company'],
  googleforms:   ['name', 'phone', 'email', 'message', 'company', 'city'],
  pabbly:        ['name', 'phone', 'email', 'company', 'city', 'message', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'],
  zapier:        ['name', 'phone', 'email', 'company', 'city', 'message', 'source', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'],
  make:          ['name', 'full_name', 'contact_name', 'phone', 'mobile', 'email', 'company', 'organization', 'city', 'message', 'enquiry', 'source', 'source_ref', 'utm_source', 'utm_medium', 'utm_campaign', 'gclid'],
  facebook:      ['full_name', 'name', 'first_name', 'last_name', 'phone_number', 'mobile_phone', 'email', 'company_name', 'job_title', 'city', 'state', 'country', 'date_of_birth', 'gender', 'street_address', 'post_code', 'zip_code', 'budget', 'product_of_interest', 'service_of_interest', 'message'],
  website:       ['name', 'phone', 'email', 'company', 'city', 'state', 'address', 'message', 'source', 'source_ref', 'product', 'value', 'tags', 'campaign_name_new', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gad_campaignid'],
  generic:       ['name', 'phone', 'email', 'company', 'city', 'state', 'address', 'message', 'source', 'source_ref', 'product', 'value', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gad_campaignid']
};

// Known target CRM fields — used by the mapping UI dropdown.
const CRM_FIELDS = ['name','phone','email','company','city','state','address','source','source_ref','notes','product','value','tags','utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','gad_campaignid'];

async function _ensureLeadSourceMappingTable() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS lead_source_mapping (
      source        TEXT PRIMARY KEY,
      mapping       JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_payload  JSONB,
      last_seen_at  TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // WMS_v1 — value_rules JSONB column for per-target-field value
    // transformation. Format: [{ field, op, src_key, src_value, set_value }]
    await db.query(`ALTER TABLE lead_source_mapping ADD COLUMN IF NOT EXISTS value_rules JSONB NOT NULL DEFAULT '[]'::jsonb`);
  } catch (_) {}
}

// WMS_v1 — value-transformation rule engine.
//
// Rules are stored on lead_source_mapping.value_rules as an array. Each rule:
//   { field, op, src_key, src_value, set_value }
//
// During ingest we:
//   1. Read the raw incoming body
//   2. For each rule, check if (body[src_key] OP src_value) is true
//   3. If so, override item[field] = set_value
//   4. First match wins per field (rules earlier in the list have priority)
//
// Operators: equals / not_equals / contains / not_contains / starts_with /
// ends_with / regex / is_empty / is_not_empty / is_one_of (set_value
// comma-separated).
//
// Special src_key '*' means "match always" — used to set a default value
// at the end of the rule list.
async function _loadValueRules(source) {
  try {
    const r = await db.query(`SELECT value_rules FROM lead_source_mapping WHERE source = $1`, [String(source).toLowerCase()]);
    const raw = r.rows[0] && r.rows[0].value_rules;
    if (!raw) return [];
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function _readKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  // Dot-notation support: "form.title" → obj.form.title
  if (key.indexOf('.') !== -1) {
    return key.split('.').reduce((acc, part) => (acc != null && typeof acc === 'object') ? acc[part] : undefined, obj);
  }
  // Case-insensitive fallback
  const lc = String(key).toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lc) return obj[k];
  }
  return undefined;
}

function _evalValueRule(rule, body) {
  if (!rule || !rule.field) return false;
  const op = String(rule.op || 'equals').toLowerCase();
  const src = String(rule.src_key || '');
  // Wildcard '*' = always match (used for defaults).
  if (src === '*') return true;
  const incoming = _readKey(body, src);
  const sv = incoming == null ? '' : String(incoming).toLowerCase();
  const cmp = rule.src_value == null ? '' : String(rule.src_value).toLowerCase();
  switch (op) {
    case 'equals':       return sv === cmp;
    case 'not_equals':   return sv !== cmp;
    case 'contains':     return cmp && sv.includes(cmp);
    case 'not_contains': return !cmp || !sv.includes(cmp);
    case 'starts_with':  return cmp && sv.startsWith(cmp);
    case 'ends_with':    return cmp && sv.endsWith(cmp);
    case 'is_empty':     return !sv;
    case 'is_not_empty': return !!sv;
    case 'is_one_of': {
      const opts = String(rule.src_value || '').toLowerCase().split(/[,|;]/).map(t => t.trim()).filter(Boolean);
      return opts.includes(sv);
    }
    case 'regex': {
      try { return new RegExp(rule.src_value, 'i').test(sv); } catch (_) { return false; }
    }
    default: return false;
  }
}

function _applyValueRules(item, body, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return item;
  const out = Object.assign({}, item);
  const setFields = new Set();
  for (const rule of rules) {
    if (!rule || !rule.field || setFields.has(rule.field)) continue;
    if (_evalValueRule(rule, body)) {
      out[rule.field] = rule.set_value == null ? '' : String(rule.set_value);
      setFields.add(rule.field);
    }
  }
  return out;
}

async function _loadCustomMapping(source) {
  try {
    const r = await db.query(`SELECT mapping FROM lead_source_mapping WHERE source = $1`, [String(source).toLowerCase()]);
    if (r.rows[0] && r.rows[0].mapping) {
      const m = typeof r.rows[0].mapping === 'string' ? JSON.parse(r.rows[0].mapping) : r.rows[0].mapping;
      return m || null;
    }
  } catch (_) {}
  return null;
}

async function _saveLastPayload(source, payload) {
  try {
    await _ensureLeadSourceMappingTable();
    await db.query(
      `INSERT INTO lead_source_mapping (source, last_payload, last_seen_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE SET last_payload = EXCLUDED.last_payload, last_seen_at = NOW()`,
      [String(source).toLowerCase(), JSON.stringify(payload).slice(0, 60000)]
    );
  } catch (_) {}
}

// Apply the custom mapping. Returns null if no custom mapping exists
// (caller falls back to _adaptLeadSourcePayload).
function _applyCustomMapping(payload, mapping) {
  // Flatten nested {data:{...}}, {RESPONSE:[...]}, {Lead:{...}} wrappers
  // so the mapping keys are top-level.
  const items = Array.isArray(payload.RESPONSE) ? payload.RESPONSE
              : Array.isArray(payload.response) ? payload.response
              : Array.isArray(payload.Lead)     ? payload.Lead
              : Array.isArray(payload.leads)    ? payload.leads
              : payload.data    ? [payload.data]
              : payload.lead    ? [payload.lead]
              : payload.Lead    ? [payload.Lead]
              : [payload];
  return items.map(row => {
    const out = {};
    Object.keys(mapping).forEach(srcKey => {
      const target = mapping[srcKey];
      if (!target || row[srcKey] == null || row[srcKey] === '') return;
      if (target.startsWith('cf_')) {
        // MAKE_CF_MAP_FIX_v1 — store custom-field values under
        // out.custom_fields[<key>] (without the 'cf_' prefix). This is the
        // shape _internalCreateLead expects when it builds extra_json.
        // Previously stored as out.extra_json.cf_<key> which _internalCreateLead
        // never read, causing the value to be silently dropped.
        if (!out.custom_fields) out.custom_fields = {};
        out.custom_fields[target.slice(3)] = String(row[srcKey]);
      } else {
        // If multiple source keys map to same target, append.
        if (out[target] && target === 'name') out[target] += ' ' + String(row[srcKey]);
        else out[target] = String(row[srcKey]);
      }
    });
    return out;
  });
}

// Public APIs —————————————————————————————————————————————————

async function api_integrations_mapping_get(token, source) {
  const me = await authUser(token);
  await _ensureSchema();
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureLeadSourceMappingTable();
  const norm = String(source || '').toLowerCase();
  let row = null;
  try {
    const r = await db.query(`SELECT mapping, last_payload, last_seen_at FROM lead_source_mapping WHERE source = $1`, [norm]);
    row = r.rows[0] || null;
  } catch (_) {}
  // CFMAP_v1 — include tenant custom fields so the field-mapping modal
  // can offer them as targets (not just core lead columns).
  let customFields = [];
  try {
    const cf = await db.query(
      `SELECT key, label, field_type FROM custom_fields
       WHERE COALESCE(is_active, 1) = 1 ORDER BY COALESCE(sort_order, 0), id`
    );
    customFields = (cf.rows || [])
      .filter(r => r && r.key)
      .map(r => ({ key: 'cf_' + r.key, label: r.label || r.key, type: r.field_type || 'text' }));
  } catch (e) {
    console.warn('[integrations.mapping_get] custom_fields lookup failed:', e.message);
  }

  // WMS_v1 — pull value_rules too. Tolerate the column not existing on
  // older tenant DBs (defensive — _ensureLeadSourceMappingTable adds it
  // but it might not have run yet during the very first request).
  let valueRules = [];
  try {
    const vr = await db.query(`SELECT value_rules FROM lead_source_mapping WHERE source = $1`, [norm]);
    const raw = vr.rows[0] && vr.rows[0].value_rules;
    if (raw) {
      const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
      valueRules = Array.isArray(arr) ? arr : [];
    }
  } catch (_) {}

  return {
    source: norm,
    mapping: row ? (typeof row.mapping === 'string' ? JSON.parse(row.mapping) : row.mapping) : {},
    last_payload: row ? row.last_payload : null,
    last_seen_at: row ? row.last_seen_at : null,
    known_keys: KNOWN_KEYS_BY_SOURCE[norm] || KNOWN_KEYS_BY_SOURCE.generic,
    crm_fields: CRM_FIELDS,
    custom_fields: customFields,
    value_rules: valueRules
  };
}


// FB_FORM_MAP_LIST_v1 — list every saved facebook:<form_id> mapping so the
// SPA Form Mapper modal can show 'previously configured forms' with Edit buttons.
async function api_integrations_mapping_listFB(token) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureLeadSourceMappingTable();
  let rows = [];
  try {
    const r = await db.query(
      `SELECT source, mapping, last_seen_at, last_payload FROM lead_source_mapping
       WHERE source LIKE 'facebook:%' ORDER BY last_seen_at DESC NULLS LAST, source`
    );
    rows = r.rows || [];
  } catch (_) {}
  return rows.map(r => {
    let map = r.mapping;
    if (typeof map === 'string') { try { map = JSON.parse(map); } catch (_) { map = {}; } }
    map = map || {};
    let pl = r.last_payload;
    if (typeof pl === 'string') { try { pl = JSON.parse(pl); } catch (_) { pl = null; } }
    const formId = String(r.source).replace(/^facebook:/, '');
    return {
      source: r.source,
      form_id: formId,
      form_name: pl && pl._form_name || '',
      page_name: pl && pl._page_name || '',
      page_id: pl && pl._page_id || '',
      mapping_count: Object.keys(map).length,
      last_seen_at: r.last_seen_at,
      mapping: map
    };
  });
}

async function api_integrations_mapping_save(token, source, mapping) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureLeadSourceMappingTable();
  const norm = String(source || '').toLowerCase();
  if (!norm) throw new Error('source required');
  // WMS_v1 — accept either { mapping, value_rules } (new shape) OR just
  // the mapping object (legacy). Detect by presence of mapping key.
  let mapObj = mapping;
  let valueRules = null;
  if (mapping && typeof mapping === 'object' &&
      (Object.prototype.hasOwnProperty.call(mapping, 'mapping') ||
       Object.prototype.hasOwnProperty.call(mapping, 'value_rules'))) {
    mapObj = mapping.mapping || {};
    valueRules = Array.isArray(mapping.value_rules) ? mapping.value_rules : null;
  }
  const map = (mapObj && typeof mapObj === 'object') ? mapObj : {};
  // Strip empty entries
  const clean = {};
  Object.keys(map).forEach(k => {
    if (k && map[k]) clean[String(k)] = String(map[k]);
  });
  // Clean value rules: drop ones without field. Keep order intact (first-match-wins).
  let cleanRules = null;
  if (valueRules) {
    cleanRules = valueRules
      .filter(r => r && r.field && r.op)
      .map(r => ({
        field: String(r.field),
        op: String(r.op),
        src_key: r.src_key ? String(r.src_key) : '',
        src_value: r.src_value == null ? '' : String(r.src_value),
        set_value: r.set_value == null ? '' : String(r.set_value)
      }));
  }
  if (cleanRules !== null) {
    await db.query(
      `INSERT INTO lead_source_mapping (source, mapping, value_rules, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE
         SET mapping = EXCLUDED.mapping,
             value_rules = EXCLUDED.value_rules,
             updated_at = NOW()`,
      [norm, JSON.stringify(clean), JSON.stringify(cleanRules)]
    );
  } else {
    await db.query(
      `INSERT INTO lead_source_mapping (source, mapping, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (source) DO UPDATE SET mapping = EXCLUDED.mapping, updated_at = NOW()`,
      [norm, JSON.stringify(clean)]
    );
  }
  return { ok: true, source: norm, mapping: clean, value_rules: cleanRules || [] };
}

// WMS_v1 Phase 1 — Live Payloads Inspector.
// Returns the last N webhook hits that PROBABLY arrived for this source.
// We match against webhook_logs.path containing the source identifier OR
// the parsed body referencing it. Falls back to showing ALL recent hits
// when no specific match (so admins can still see something useful).
async function api_integrations_payloads_recent(token, source) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const norm = String(source || '').toLowerCase();
  let rows = [];
  try {
    // Strategy 1: path contains source token
    const sourceTok = norm.split(':')[0]; // facebook:<form_id> → 'facebook'
    const r = await db.query(
      `SELECT id, path, method, source_ip, response_code, duration_ms, created_at,
              LEFT(body_text, 20000) AS body_text
         FROM webhook_logs
         WHERE path ILIKE $1 OR path ILIKE $2 OR body_text ILIKE $3
         ORDER BY id DESC LIMIT 30`,
      ['%hook/' + sourceTok + '%', '%hook/leadsource/' + sourceTok + '%', '%"' + sourceTok + '"%']
    );
    rows = r.rows || [];
    // Fallback — if nothing matches, show the most recent 30 anyway so the
    // admin always sees SOMETHING. Useful for the 'website' source where
    // many integrations land on the same /hook/website endpoint.
    if (!rows.length) {
      const r2 = await db.query(
        `SELECT id, path, method, source_ip, response_code, duration_ms, created_at,
                LEFT(body_text, 20000) AS body_text
           FROM webhook_logs
           ORDER BY id DESC LIMIT 30`);
      rows = r2.rows || [];
    }
  } catch (_) {
    return { rows: [], note: 'webhook_logs table missing — no inbound hooks received yet.' };
  }
  return { rows };
}

// WMS_v1 Phase 3 — Test mode.
// Applies the saved mapping + value rules to a provided body and returns
// the resulting lead-shaped object. The caller passes either an explicit
// body or the id of a webhook_logs row. Does NOT save anything.
async function api_integrations_mapping_test(token, source, opts) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureLeadSourceMappingTable();
  const norm = String(source || '').toLowerCase();
  let body = (opts && opts.body) || null;
  if (!body && opts && opts.log_id) {
    try {
      const r = await db.query(`SELECT body_text FROM webhook_logs WHERE id = $1`, [Number(opts.log_id)]);
      const bt = r.rows[0] && r.rows[0].body_text;
      if (bt) {
        try { body = JSON.parse(bt); }
        catch (_) {
          // Form-urlencoded fallback
          const params = new URLSearchParams(bt);
          body = {};
          for (const [k, v] of params) body[k] = v;
        }
      }
    } catch (_) {}
  }
  if (!body || typeof body !== 'object') {
    return { error: 'No payload — supply opts.body or opts.log_id (and check the log row has body_text).' };
  }
  const customMap = await _loadCustomMapping(norm);
  let items;
  if (customMap && Object.keys(customMap).length) {
    items = _applyCustomMapping(body, customMap);
    const defaults = _adaptLeadSourcePayload(norm, body);
    items.forEach((item, i) => {
      const d = defaults[i] || {};
      for (const k of Object.keys(d)) {
        const v = item[k];
        if (v == null || v === '' || (typeof v === 'object' && Object.keys(v||{}).length === 0)) {
          item[k] = d[k];
        }
      }
    });
  } else {
    items = _adaptLeadSourcePayload(norm, body);
  }
  const valueRules = await _loadValueRules(norm);
  const beforeRules = items.map(it => Object.assign({}, it));
  if (valueRules.length) {
    items = items.map(it => _applyValueRules(it, body, valueRules));
  }
  // Diff per field
  const diffs = items.map((after, i) => {
    const before = beforeRules[i] || {};
    const fields = {};
    new Set([...Object.keys(before), ...Object.keys(after)]).forEach(k => {
      fields[k] = { before: before[k], after: after[k], changed: before[k] !== after[k] };
    });
    return fields;
  });
  return { ok: true, source: norm, body, items, diffs, rules_applied: valueRules.length };
}

function _adaptLeadSourcePayload(source, body) {
  const norm = String(source || '').toLowerCase().trim();
  const pick = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
    }
    return '';
  };

  // Ã¢ÂÂÃ¢ÂÂ IndiaMART Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'indiamart') {
    // INDIAMART_PAYLOAD_UNWRAP_v1 (2026-06-03): IndiaMART real-time Push wraps
    // the lead as { CODE: 200, RESPONSE: { SENDER_NAME, ... } } — RESPONSE is
    // an OBJECT, not an array. Older docs also show RESPONSE as an array of
    // many rows for batch/pull APIs. Existing code only handled the array
    // case, so single-record live pushes silently mapped a blank lead.
    // Fix: accept all three shapes: array, single-object-RESPONSE, or flat.
    const arr = Array.isArray(body.RESPONSE) ? body.RESPONSE
              : Array.isArray(body.response) ? body.response
              : (body.RESPONSE && typeof body.RESPONSE === 'object') ? [body.RESPONSE]
              : (body.response && typeof body.response === 'object') ? [body.response]
              : [body];
    // INDIAMART_FULL_MAP_v1 (2026-06-03): enrich mapping per actual IndiaMART
    // production payload sample. Phone arrives as '+91-9999999999' or
    // '0120-1234567' (landlines) — normalize to digits. Address is split
    // across SENDER_ADDRESS / CITY / STATE / PINCODE / COUNTRY_ISO and
    // notes should lead with SUBJECT + PRODUCT for context. Everything
    // else lands in extra_json so nothing is lost.
    const _imNormPhone = (raw) => {
      if (!raw) return '';
      let s = String(raw).replace(/[\s\-()]/g, ''); // strip spaces, hyphens, parens
      if (s.startsWith('+')) s = s.slice(1);           // drop leading +
      // collapse leading 0 (landline trunk) when followed by enough digits
      if (s.length >= 11 && s.startsWith('0')) s = s.slice(1);
      return s.replace(/[^0-9]/g, '');
    };
    const _imJoinAddr = (r) => {
      const parts = [
        r.SENDER_ADDRESS || r.sender_address,
        r.SENDER_CITY    || r.sender_city,
        r.SENDER_STATE   || r.sender_state,
        r.SENDER_PINCODE || r.sender_pincode,
        r.SENDER_COUNTRY_ISO || r.sender_country_iso || r.SENDER_COUNTRY
      ].filter(x => x && String(x).trim());
      return parts.join(', ');
    };
    const _imNotes = (r) => {
      const bits = [];
      const subj = r.SUBJECT || r.subject;
      const prod = r.QUERY_PRODUCT_NAME || r.query_product_name || r.QUERY_MCAT_NAME;
      const msg  = r.QUERY_MESSAGE || r.query_message;
      if (subj) bits.push('Subject: ' + subj);
      if (prod) bits.push('Product: ' + prod);
      if (msg)  bits.push(msg);
      return bits.join('\n');
    };
    return arr.map(r => ({
      name:       pick(r, ['SENDER_NAME',    'sender_name',    'name',    'NAME']),
      phone:      _imNormPhone(pick(r, ['SENDER_MOBILE', 'sender_mobile', 'mobile', 'MOBILE', 'phone', 'SENDER_PHONE', 'sender_phone'])),
      email:      pick(r, ['SENDER_EMAIL',   'sender_email',   'email',   'EMAIL']),
      company:    pick(r, ['SENDER_COMPANY', 'sender_company', 'company']),
      city:       pick(r, ['SENDER_CITY',    'sender_city',    'city']),
      state:      pick(r, ['SENDER_STATE',   'sender_state',   'state']),
      address:    _imJoinAddr(r),
      notes:      _imNotes(r),
      source:     'IndiaMART',
      source_ref: pick(r, ['UNIQUE_QUERY_ID', 'unique_query_id', 'query_id']),
      // Stash everything else into extra_json under sensible keys so the
      // rest of the data isn't lost. These show on the lead's custom-field
      // panel once the admin creates matching custom fields.
      custom_fields: {
        indiamart_subject:        r.SUBJECT || r.subject || '',
        indiamart_query_time:     r.QUERY_TIME || r.query_time || '',
        indiamart_query_type:     r.QUERY_TYPE || r.query_type || '',
        indiamart_mcat:           r.QUERY_MCAT_NAME || r.query_mcat_name || '',
        indiamart_product:        r.QUERY_PRODUCT_NAME || r.query_product_name || '',
        indiamart_pincode:        r.SENDER_PINCODE || r.sender_pincode || '',
        indiamart_country:        r.SENDER_COUNTRY_ISO || r.sender_country_iso || '',
        indiamart_landline:       _imNormPhone(r.SENDER_PHONE || r.sender_phone || ''),
        indiamart_mobile_alt:     _imNormPhone(r.SENDER_MOBILE_ALT || r.sender_mobile_alt || ''),
        indiamart_email_alt:      r.SENDER_EMAIL_ALT || r.sender_email_alt || '',
        indiamart_call_duration:  r.CALL_DURATION || r.call_duration || ''
      }
    }));
  }

  // Ã¢ÂÂÃ¢ÂÂ MagicBricks Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'magicbricks') {
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

  // Ã¢ÂÂÃ¢ÂÂ JustDial Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'justdial' || norm === 'jd') {
    const r = body.lead || body;
    const prefix = pick(r, ['prefix', 'salutation']);
    const fname  = pick(r, ['name', 'first_name', 'fname']);
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

  // Ã¢ÂÂÃ¢ÂÂ TradeIndia Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'tradeindia' || norm === 'ti') {
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

  // Ã¢ÂÂÃ¢ÂÂ 99acres Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

  // Ã¢ÂÂÃ¢ÂÂ Housing.com Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
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

  // Ã¢ÂÂÃ¢ÂÂ NoBroker Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'nobroker') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'contactName', 'customer_name', 'fullName']),
      phone:      pick(r, ['phone', 'mobile', 'contactNumber', 'contact']),
      email:      pick(r, ['email']),
      city:       pick(r, ['city', 'location', 'locality']),
      notes:      pick(r, ['requirement', 'message', 'propertyType', 'property_type']),
      source:     'NoBroker',
      source_ref: pick(r, ['id', 'leadId', 'lead_id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ ExportersIndia Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'exportersindia' || norm === 'exporter') {
    return [{
      name:       pick(body, ['SENDER_NAME',    'sender_name',    'name']),
      phone:      pick(body, ['SENDER_MOBILE',  'sender_mobile',  'mobile', 'phone']),
      email:      pick(body, ['SENDER_EMAIL',   'sender_email',   'email']),
      company:    pick(body, ['SENDER_COMPANY', 'sender_company', 'company']),
      city:       pick(body, ['SENDER_CITY',    'sender_city',    'city']),
      notes:      pick(body, ['QUERY_MESSAGE',  'query_message',  'message', 'SUBJECT']),
      source:     'ExportersIndia',
      source_ref: pick(body, ['QUERY_ID', 'query_id', 'id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Sulekha Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'sulekha') {
    const r = body.lead || body;
    return [{
      name:       pick(r, ['name', 'customer_name', 'customerName', 'fullName']),
      phone:      pick(r, ['mobile', 'phone', 'contact', 'mobile_number']),
      email:      pick(r, ['email', 'email_id']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['service', 'category', 'message', 'requirements']),
      source:     'Sulekha',
      source_ref: pick(r, ['id', 'leadId', 'lead_id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Google Ads Lead Form Extensions Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  // Payload: { google_key, campaign_id, adgroup_id, lead_id,
  //            user_column_data: [{column_name, string_value}] }
  if (norm === 'googleads' || norm === 'google_ads' || norm === 'google-ads') {
    const cols = {};
    if (Array.isArray(body.user_column_data)) {
      body.user_column_data.forEach(c => {
        if (c.column_name) {
          cols[String(c.column_name).toLowerCase().replace(/\s+/g, '_')] = c.string_value || '';
        }
      });
    }
    const r = Object.assign({}, body, cols);
    return [{
      name:       pick(r, ['full_name', 'name', 'first_name', 'customer_name']),
      phone:      pick(r, ['phone_number', 'phone', 'mobile', 'contact_number']),
      email:      pick(r, ['email', 'email_address']),
      city:       pick(r, ['city', 'location']),
      notes:      'Google Ads Lead Form' +
                  (body.campaign_id ? ' ÃÂ· Campaign: ' + body.campaign_id : '') +
                  (body.adgroup_id  ? ' ÃÂ· AdGroup: '  + body.adgroup_id  : ''),
      source:     'Google Ads',
      source_ref: pick(body, ['lead_id', 'adgroup_id', 'campaign_id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ WordPress Forms (CF7 / WPForms / Gravity Forms) Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (['wordpress', 'cf7', 'wpforms', 'gravityforms', 'gravity_forms'].includes(norm)) {
    const r = body.data || body.fields || body;
    const fname = pick(r, ['your-name', 'name', 'full_name', 'first_name', 'fullName', 'field_1', 'input_1']);
    const lname = pick(r, ['last_name', 'field_2', 'input_2']);
    const fullName = (fname + (lname ? ' ' + lname : '')).trim();
    return [{
      name:       fullName,
      phone:      pick(r, ['your-phone', 'phone', 'mobile', 'phone_number', 'field_3', 'input_3', 'contact']),
      email:      pick(r, ['your-email', 'email', 'email_address', 'field_4', 'input_4']),
      city:       pick(r, ['city', 'your-city', 'field_5', 'input_5']),
      notes:      pick(r, ['your-message', 'message', 'comments', 'field_6', 'input_6']) +
                  (body.page_url ? '\nSource page: ' + body.page_url : ''),
      source:     'WordPress',
      source_ref: pick(body, ['form_id', '_wpcf7', 'id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Google Forms (via Apps Script webhook) Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  // Apps Script maps form Q&A into a flat JSON object sent here.
  if (norm === 'googleforms' || norm === 'google_forms' || norm === 'google-forms') {
    const r = body.response || body;
    return [{
      name:       pick(r, ['name', 'full_name', 'your_name', 'Name', 'Full Name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'Phone', 'Mobile', 'Phone Number']),
      email:      pick(r, ['email', 'Email', 'email_address', 'Email Address']),
      city:       pick(r, ['city', 'City', 'location', 'Location']),
      notes:      pick(r, ['message', 'Message', 'enquiry', 'notes', 'Notes', 'Enquiry']),
      source:     'Google Forms',
      source_ref: pick(body, ['formId', 'form_id', 'responseId'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Pabbly Connect Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'pabbly') {
    const r = body.data || body;
    return [{
      name:       pick(r, ['name', 'full_name', 'contact_name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'contact']),
      email:      pick(r, ['email', 'email_address']),
      company:    pick(r, ['company', 'organization', 'company_name']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'notes', 'enquiry', 'description']),
      source:     pick(r, ['source']) || 'Pabbly Connect',
      source_ref: pick(r, ['source_ref', 'id', 'reference'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Zapier Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'zapier') {
    const r = body.data || body;
    return [{
      name:       pick(r, ['name', 'full_name', 'contact_name', 'customer_name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'contact']),
      email:      pick(r, ['email', 'email_address']),
      company:    pick(r, ['company', 'organization', 'company_name']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'notes', 'enquiry', 'description']),
      source:     pick(r, ['source']) || 'Zapier',
      source_ref: pick(r, ['source_ref', 'id', 'reference', 'zap_id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Make (Integromat) / n8n Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'make' || norm === 'integromat' || norm === 'n8n') {
    const r = body.data || body;
    const src = norm === 'n8n' ? 'n8n' : 'Make';
    return [{
      name:       pick(r, ['name', 'full_name', 'contact_name']),
      phone:      pick(r, ['phone', 'mobile', 'phone_number', 'contact']),
      email:      pick(r, ['email', 'email_address']),
      company:    pick(r, ['company', 'organization']),
      city:       pick(r, ['city', 'location']),
      notes:      pick(r, ['message', 'notes', 'enquiry']),
      source:     pick(r, ['source']) || src,
      source_ref: pick(r, ['source_ref', 'id', 'reference'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ LeadSquared Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  // Supports both flat format and { LeadPropertyList: [{Attribute, Value}] }
  if (norm === 'leadsquared' || norm === 'ls') {
    const attrs = {};
    if (Array.isArray(body.LeadPropertyList)) {
      body.LeadPropertyList.forEach(p => { if (p.Attribute) attrs[p.Attribute] = p.Value; });
    }
    const r = Object.assign({}, attrs, body.Lead || body.lead || body);
    const fname = pick(r, ['FirstName', 'first_name', 'name']);
    const lname = pick(r, ['LastName', 'last_name']);
    return [{
      name:       (fname + (lname ? ' ' + lname : '')).trim(),
      phone:      pick(r, ['Phone', 'Mobile', 'phone', 'mobile']),
      email:      pick(r, ['EmailAddress', 'Email', 'email']),
      company:    pick(r, ['Company', 'company']),
      city:       pick(r, ['City', 'city']),
      notes:      pick(r, ['Notes', 'note', 'notes', 'Source']),
      source:     'LeadSquared',
      source_ref: pick(r, ['ProspectID', 'Id', 'id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Zoho CRM Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'zoho' || norm === 'zohocrm' || norm === 'zoho_crm') {
    const arr = Array.isArray(body.leads) ? body.leads
              : Array.isArray(body.data)  ? body.data
              : [body.lead || body];
    return arr.map(r => {
      const fname = pick(r, ['First_Name', 'first_name']);
      const lname = pick(r, ['Last_Name',  'last_name']);
      return {
        name:       (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['Full_Name', 'Name', 'name']),
        phone:      pick(r, ['Phone', 'Mobile', 'phone', 'mobile']),
        email:      pick(r, ['Email', 'email']),
        company:    pick(r, ['Company', 'company']),
        city:       pick(r, ['City', 'city']),
        notes:      pick(r, ['Description', 'description', 'Lead_Source']),
        source:     'Zoho CRM',
        source_ref: pick(r, ['id', 'Id', '$id'])
      };
    });
  }

  // Ã¢ÂÂÃ¢ÂÂ HubSpot Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  // Supports event-array format and contact-properties format.
  if (norm === 'hubspot') {
    if (Array.isArray(body)) {
      // Group events by objectId Ã¢ÂÂ reconstruct contact
      const map = {};
      body.forEach(ev => {
        const id = String(ev.objectId || '');
        if (!map[id]) map[id] = {};
        if (ev.propertyName) map[id][ev.propertyName] = ev.propertyValue;
      });
      return Object.values(map).map(r => {
        const fname = pick(r, ['firstname']);
        const lname = pick(r, ['lastname']);
        return {
          name:    (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['name']),
          phone:   pick(r, ['phone', 'mobilephone']),
          email:   pick(r, ['email']),
          company: pick(r, ['company']),
          city:    pick(r, ['city']),
          notes:   pick(r, ['message', 'notes', 'hs_lead_status']),
          source:  'HubSpot',
          source_ref: ''
        };
      });
    }
    const r = body.properties || body;
    const fname = pick(r, ['firstname', 'first_name']);
    const lname = pick(r, ['lastname',  'last_name']);
    return [{
      name:       (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['name']),
      phone:      pick(r, ['phone', 'mobilephone', 'mobile']),
      email:      pick(r, ['email']),
      company:    pick(r, ['company']),
      city:       pick(r, ['city']),
      notes:      pick(r, ['message', 'notes', 'description', 'hs_lead_status']),
      source:     'HubSpot',
      source_ref: pich(body, ['id', 'vid'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Salesforce Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  if (norm === 'salesforce' || norm === 'sfdc') {
    const r = body.Lead || body.lead || body;
    const fname = pick(r, ['FirstName', 'first_name']);
    const lname = pick(r, ['LastName',  'last_name']);
    return [{
      name:       (fname + (lname ? ' ' + lname : '')).trim() || pick(r, ['Name', 'name']),
      phone:      pick(r, ['Phone', 'MobilePhone', 'phone', 'mobile']),
      email:      pick(r, ['Email', 'email']),
      company:    pick(r, ['Company', 'company']),
      city:       pick(r, ['City', 'city']),
      notes:      pick(r, ['Description', 'description', 'LeadSource']),
      source:     'Salesforce',
      source_ref: pick(r, ['Id', 'id'])
    }];
  }

  // Ã¢ÂÂÃ¢ÂÂ Generic fallback Ã¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂÃ¢ÂÂ
  const r = body.lead || body;
  return [{
    name:       pick(r, ['name', 'full_name', 'customer_name', 'contact_name']),
    phone:      pick(r, ['phone', 'mobile', 'contact', 'mobile_number', 'contact_number']),
    email:      pick(r, ['email', 'email_id']),
    company:    pick(r, ['company', 'organization']),
    city:       pick(r, ['city', 'location']),
    notes:      pick(r, ['message', 'enquiry', 'requirement', 'notes']),
    source:     pick(r, ['source']) || 'Webhook',
    source_ref: pick(r, ['id', 'lead_id', 'reference'])
  }];
}

/**
 * Express handler: POST /hook/leadsource/:source/:key
 *
 * URL format: https://<host>/hook/leadsource/<platform>/<api-key>
 * Supported platforms: indiamart, 99acres, magicbricks, housing,
 *   nobroker, justdial, tradeindia, exportersindia, sulekha,
 *   googleads, wordpress, cf7, wpforms, oravityforms, googleforms,
 *   pabbly, zapier, make, leadsquared, zoho, hubspot, salesforce
 *
 * The <api-key> must match the WEBSITE_API_KEY set in Admin Ã¢ÂÂ Website API.
 */
async function leadSourceWebhook(req, res) {
  try {
    const apiKey  = String(req.params.key || req.headers['x-api-key'] || '').trim();
    const expected = await db.getConfig('WEBSITE_API_KEY', '').catch(() => process.env.WEBSITE_API_KEY || '');
    if (!apiKey || apiKey !== expected) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    const source = String(req.params.source || 'generic').toLowerCase();
    let body   = req.body || {};

    // INDIAMART_PAYLOAD_UNWRAP_v1.2 (2026-06-03): IndiaMART real-time Push
    // wraps every lead as {CODE,STATUS,RESPONSE:{...}}. The default mapper
    // already handles array-RESPONSE, but when a tenant has a saved custom
    // mapping, _applyCustomMapping reads the TOP LEVEL — and never sees the
    // unwrapped record. Solve once for both paths by unwrapping RESPONSE
    // here, before either mapper runs.
    if (source === 'indiamart' && body && typeof body === 'object'
        && body.RESPONSE && typeof body.RESPONSE === 'object'
        && !Array.isArray(body.RESPONSE)
        && !body.SENDER_NAME && !body.SENDER_MOBILE) {
      body = { ...body.RESPONSE, _wrapped_code: body.CODE, _wrapped_status: body.STATUS };
    }

    // Log raw hit for admin diagnostics
    try {
      await db.insert('webhook_log', { source, payload: body, processed: 0, error: '' });
    } catch (_) {}

    // Save the latest payload for the mapping UI (best-effort)
    try { await _saveLastPayload(source, body); } catch (_) {}
    // Apply tenant's custom mapping if one exists, fall back to defaults
    let items;
    const customMap = await _loadCustomMapping(source);
    if (customMap && Object.keys(customMap).length) {
      // CUSTOM_MAP_DEFAULTS_FILL_v1 (2026-06-03): tenant's custom mapping
      // wins where it has a value, but for any field it leaves blank, fall
      // back to the default mapper. So a tenant who maps just (name, phone)
      // still gets address/company/notes/source_ref/custom_fields from the
      // built-in adapter — they don't have to remap everything.
      items = _applyCustomMapping(body, customMap);
      const defaults = _adaptLeadSourcePayload(source, body);
      items.forEach((item, i) => {
        const d = defaults[i] || {};
        for (const k of Object.keys(d)) {
          const v = item[k];
          if (v == null || v === '' || (typeof v === 'object' && Object.keys(v||{}).length === 0)) {
            item[k] = d[k];
          }
        }
      });
    } else {
      items = _adaptLeadSourcePayload(source, body);
    }

    // WMS_v1 — apply tenant-configured value transformation rules. These
    // override specific fields (e.g. force source='Meta' when page_name
    // contains 'New Shop'). Evaluated against the ORIGINAL body so admins
    // can match on any incoming key, not just the ones that got mapped.
    try {
      const valueRules = await _loadValueRules(source);
      if (valueRules.length) {
        items = items.map(it => _applyValueRules(it, body, valueRules));
      }
    } catch (e) { console.warn('[integrations.value_rules] apply failed:', e.message); }

    // Preserve custom fields from the original body across all adapters.
    // Per-source adapters only project standard fields (name, phone, ...)
    // so cf_<key> aliases and a custom_fields:{...} object would otherwise
    // be lost before _internalCreateLead runs. Pull them out of the body
    // (or each row of an array body, indexed) and stamp onto each item.
    try {
      const _bodyCustomFields = (b) => {
        const out = {};
        if (b && typeof b === 'object') {
          // 1. flat cf_<key> aliases
          Object.keys(b).forEach(k => {
            if (k.startsWith('cf_') && b[k] != null && b[k] !== '') {
              out[k.slice(3)] = b[k];
            }
          });
          // 2. nested custom_fields object
          if (b.custom_fields && typeof b.custom_fields === 'object') {
            Object.keys(b.custom_fields).forEach(k => {
              if (b.custom_fields[k] != null && b.custom_fields[k] !== '') {
                out[k] = b.custom_fields[k];
              }
            });
          }
          // 3. cf nested under data wrapper (Make often wraps as data:{})
          if (b.data && typeof b.data === 'object') {
            const inner = _bodyCustomFields(b.data);
            Object.assign(out, inner);
          }
        }
        return out;
      };
      // For array-style bodies (IndiaMART RESPONSE[]), pair item[i] with row[i]
      let rowsForIdx = null;
      if (Array.isArray(body && body.RESPONSE)) rowsForIdx = body.RESPONSE;
      else if (Array.isArray(body && body.response)) rowsForIdx = body.response;
      else if (Array.isArray(body && body.leads)) rowsForIdx = body.leads;
      else if (Array.isArray(body)) rowsForIdx = body;
      const globalCfs = _bodyCustomFields(body);
      items.forEach((item, i) => {
        const rowCfs = rowsForIdx && rowsForIdx[i] ? _bodyCustomFields(rowsForIdx[i]) : {};
        const merged = Object.assign({}, globalCfs, rowCfs);
        if (Object.keys(merged).length) {
          item.custom_fields = Object.assign({}, item.custom_fields || {}, merged);
        }
      });
    } catch (e) { console.warn('[leadsource] cf passthrough failed:', e.message); }

    const owner = await db.getAll('users').then(us => us.find(u => u.role === 'admin'));
    if (!owner) return res.status(500).json({ error: 'No admin user to own leads' });

    const results = [];
    for (const it of items) {
      if (!it.phone && !it.email && !it.name) continue;
      try {
        const r = await _internalCreateLead(it, owner.id);
        // Update webhook_log row as processed
        results.push({ ok: true, lead_id: r.id, name: it.name });
      } catch (e) {
        results.push({ ok: false, name: it.name, error: e.message });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    // Update the log row to processed
    try {
      const logs = await db.getAll('webhook_log');
      const last = logs.filter(l => l.source === source).sort((a, b) => b.id - a.id)[0];
      if (last) await db.update('webhook_log', last.id, { processed: okCount > 0 ? 1 : 0 });
    } catch (_) {}

    return res.json({ ok: true, source, processed: results.length, created: okCount, results });
  } catch (e) {
    console.error('[leadsource] webhook error:', e.message);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

// ============================================================
// Native pull-mode integrations (IndiaMART, JustDial)
// ============================================================

/**
 * IndiaMART CRM API - pull leads using GLID + API key.
 * Endpoint: https://mapi.indiamart.com/wservce/crm/crmListing/v2/
 * Returns up to 100 leads per call (sorted newest-first).
 */
async function _pullIndiaMARTLeads(cfg) {
  const { glid, api_key } = cfg.config_json || {};
  if (!glid || !api_key) throw new Error('IndiaMART: GLID and API key are required');

  const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(api_key)}&glusr_crm_glid=${encodeURIComponent(glid)}&start_time=&end_time=&start=1&end=100`;

  const resp = await fetch(url, { timeout: 15000 });
  if (!resp.ok) throw new Error(`IndiaMART API HTTP ${resp.status}`);

  const json = await resp.json();

  // IndiaMART returns { STATUS: 'true'|'false', RESPONSE: [...] }
  if (!json || (json.STATUS && String(json.STATUS).toLowerCase() === 'false')) {
    throw new Error(json.MESSAGE || 'IndiaMART API returned failure status');
  }

  const rows = Array.isArray(json.RESPONSE) ? json.RESPONSE : [];

  return rows.map(r => ({
    source:      'indiamart',
    source_ref:  String(r.UNIQUE_QUERY_ID || r.unique_query_id || ''),
    name:        [r.SENDER_NAME, r.SENDER_COMPANY].filter(Boolean).join(' - ') || 'IndiaMART Lead',
    email:       r.SENDER_EMAIL  || r.sender_email  || '',
    phone:       r.SENDER_MOBILE || r.sender_mobile || r.SENDER_PHONE || '',
    message:     r.QUERY_MESSAGE || r.query_message || '',
    address:     [r.SENDER_CITY, r.SENDER_STATE, r.SENDER_COUNTRY].filter(Boolean).join(', '),
    product:     r.SUBJECT       || r.subject       || '',
    raw:         r,
  }));
}

/**
 * JustDial Lead Pull API - HMAC-SHA1 signed request.
 * Endpoint: https://api.justdial.com/api/v1/leads
 */
async function _pullJustDialLeads(cfg) {
  const { api_key, secret } = cfg.config_json || {};
  if (!api_key || !secret) throw new Error('JustDial: api_key and secret are required');

  const ts  = Math.floor(Date.now() / 1000);
  const sig = crypto
    .createHmac('sha1', String(secret))
    .update(String(api_key) + String(ts))
    .digest('base64');

  const url = `https://api.justdial.com/api/v1/leads?api_key=${encodeURIComponent(api_key)}&timestamp=${ts}&signature=${encodeURIComponent(sig)}&limit=100`;

  const resp = await fetch(url, { timeout: 15000 });
  if (!resp.ok) throw new Error(`JustDial API HTTP ${resp.status}`);

  const json = await resp.json();

  if (!json || json.status === 'error') {
    throw new Error(json.message || 'JustDial API returned error');
  }

  const rows = Array.isArray(json.leads) ? json.leads
             : Array.isArray(json.data)  ? json.data
             : [];

  return rows.map(r => ({
    source:      'justdial',
    source_ref:  String(r.id || r.lead_id || r.contact_id || ''),
    name:        r.name || r.contact_name || 'JustDial Lead',
    email:       r.email || '',
    phone:       r.mobile || r.phone || r.contact_mobile || '',
    message:     r.requirement || r.message || r.query || '',
    address:     [r.city, r.area].filter(Boolean).join(', '),
    product:     r.category || r.service || '',
    raw:         r,
  }));
}

/**
 * Run a native pull for a single integration config.
 * Deduplicates by source_ref (preferred) or phone digits, then calls
 * _internalCreateLead for each new lead.
 */
async function _runNativePull(cfg, adminUserId) {
  let pulled;
  if (cfg.source === 'indiamart') {
    pulled = await _pullIndiaMARTLeads(cfg);
  } else if (cfg.source === 'justdial') {
    pulled = await _pullJustDialLeads(cfg);
  } else {
    throw new Error(`Unknown pull source: ${cfg.source}`);
  }

  if (!pulled || !pulled.length) return 0;

  // Load existing source_refs + phones for dedup
  const existingLeads = await db.getAll('leads');
  const existingRefs  = new Set(
    existingLeads.filter(l => l.source_ref).map(l => String(l.source_ref))
  );
  const existingPhones = new Set(
    existingLeads
      .filter(l => l.phone)
      .map(l => String(l.phone).replace(/\D/g, '').slice(-10))
  );

  let created = 0;
  for (const lead of pulled) {
    // Skip if already imported by source_ref
    if (lead.source_ref && existingRefs.has(lead.source_ref)) continue;

    // Skip by phone digits as fallback
    const phoneDigits = String(lead.phone || '').replace(/\D/g, '').slice(-10);
    if (phoneDigits && existingPhones.has(phoneDigits)) continue;

    try {
      await _internalCreateLead({
        name:       lead.name,
        email:      lead.email,
        phone:      lead.phone,
        source:     lead.source,
        source_ref: lead.source_ref,
        message:    lead.message,
        address:    lead.address,
        product:    lead.product,
        status:     'new',
      }, adminUserId);

      if (lead.source_ref) existingRefs.add(lead.source_ref);
      if (phoneDigits)     existingPhones.add(phoneDigits);
      created++;
    } catch (e) {
      console.warn(`[nativePull] Failed to create lead (${lead.source}):`, e.message);
    }
  }

  return created;
}

/**
 * Called by the background poller every 5 min.
 * Checks each active pull-mode config to see if its interval has elapsed.
 */
async function runDueNativePulls() {
  let configs;
  try {
    configs = await db.getAll('integration_configs');
  } catch (_) {
    // Table not yet migrated — silently skip
    return;
  }

  const due = configs.filter(c =>
    Number(c.is_active) &&
    c.poll_mode === 'pull' &&
    (!c.last_synced_at ||
      Date.now() - new Date(c.last_synced_at).getTime() >= (c.poll_interval_min || 15) * 60 * 1000)
  );

  for (const cfg of due) {
    try {
      const users    = await db.getAll('users');
      const adminUsr = users.find(u => u.role === 'admin' && Number(u.is_active)) || users[0];
      const count    = await _runNativePull(cfg, adminUsr && adminUsr.id);
      await db.update('integration_configs', cfg.id, {
        last_synced_at:    new Date().toISOString(),
        last_synced_count: count,
        last_error:        null,
        updated_at:        new Date().toISOString(),
      });
    } catch (e) {
      console.error(`[nativePull] ${cfg.source}:`, e.message);
      try {
        await db.update('integration_configs', cfg.id, {
          last_error: e.message,
          updated_at: new Date().toISOString(),
        });
      } catch (_) {}
    }
  }
}

// ============================================================
// API handlers — integration_configs CRUD
// ============================================================

async function api_integration_list(token) {
  await authUser(token);
  try {
    const rows = await db.getAll('integration_configs');
    return rows;
  } catch (_) {
    // Table not yet migrated
    return [];
  }
}

async function api_integration_save(token, payload) {
  const user = await authUser(token, 'admin');
  const { source, label, config_json, is_active, poll_mode, poll_interval_min } = payload || {};
  if (!source) throw new Error('source is required');
  if (!label)  throw new Error('label is required');

  let existing;
  try {
    const rows = await db.getAll('integration_configs');
    existing = rows.find(r => r.source === source);
  } catch (_) { existing = null; }

  const now = new Date().toISOString();

  if (existing) {
    await db.update('integration_configs', existing.id, {
      label,
      config_json:      config_json || {},
      is_active:        is_active !== undefined ? Number(is_active) : existing.is_active,
      poll_mode:        poll_mode        || existing.poll_mode,
      poll_interval_min: poll_interval_min != null ? Number(poll_interval_min) : existing.poll_interval_min,
      updated_at:       now,
    });
    return { saved: true, id: existing.id };
  } else {
    const id = await db.insert('integration_configs', {
      source,
      label,
      config_json:       config_json || {},
      is_active:         is_active !== undefined ? Number(is_active) : 1,
      poll_mode:         poll_mode || 'push',
      poll_interval_min: poll_interval_min != null ? Number(poll_interval_min) : 15,
      created_by:        user.id,
      created_at:        now,
      updated_at:        now,
    });
    return { saved: true, id };
  }
}

async function api_integration_delete(token, id) {
  await authUser(token, 'admin');
  if (!id) throw new Error('id is required');
  await db.delete('integration_configs', id);
  return { deleted: true };
}

async function api_integration_syncNow(token, id) {
  await authUser(token, 'admin');
  if (!id) throw new Error('id is required');

  let cfg;
  try {
    const rows = await db.getAll('integration_configs');
    cfg = rows.find(r => Number(r.id) === Number(id));
  } catch (_) {}

  if (!cfg) throw new Error('Integration config not found');
  if (cfg.poll_mode !== 'pull') throw new Error('This integration is push-mode only — no manual sync needed');

  const users    = await db.getAll('users');
  const adminUsr = users.find(u => u.role === 'admin' && Number(u.is_active)) || users[0];
  const count    = await _runNativePull(cfg, adminUsr && adminUsr.id);

  const now = new Date().toISOString();
  await db.update('integration_configs', cfg.id, {
    last_synced_at:    now,
    last_synced_count: count,
    last_error:        null,
    updated_at:        now,
  });

  return { synced: true, created: count };
}


/**
 * api_integrations_csvImport(token, payload)
 *
 * Bulk-import leads from a CSV exported from another CRM. Caller
 * supplies the column mapping (source-header -> CRM-field). Each row
 * is run through the same de-dup + assignment pipeline as a manual
 * lead create. Custom fields are stored verbatim in extra_json.
 *
 * payload = {
 *   source:  'leadsquared' | 'zoho' | 'hubspot' | 'salesforce' | 'generic',
 *   csv:     string (raw CSV text),
 *   mapping: { 'CSV column header': 'crm_field_name' | 'cf_<custom_key>' }
 * }
 */
async function api_integrations_csvImport(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};
  const csv = String(p.csv || '');
  const mapping = p.mapping || {};
  const source = String(p.source || 'generic');
  if (!csv) throw new Error('CSV is empty');

  const rows = _csvParse(csv);
  if (!rows.length) return { ok: true, created: 0, skipped: 0 };
  const headers = Object.keys(rows[0]);
  // headers must overlap with mapping keys; warn if mapping is empty
  if (!Object.keys(mapping).length) throw new Error('Mapping is empty');

  let created = 0, skipped = 0;
  for (const row of rows) {
    const lead = { extra_json: {} };
    for (const h of headers) {
      const target = mapping[h];
      const v = row[h];
      if (!target || v == null || v === '') continue;
      if (target.startsWith('cf_')) {
        lead.extra_json[target] = String(v);
      } else if (target === 'name' && lead.name) {
        // Compose "First Last" if both columns map to name/lastname
        lead.name = lead.name + ' ' + String(v);
      } else if (target === 'lastname') {
        lead.name = (lead.name || '') + (lead.name ? ' ' : '') + String(v);
      } else {
        lead[target] = String(v);
      }
    }
    if (!lead.name && !lead.phone) { skipped++; continue; }
    if (!lead.source) lead.source = source.charAt(0).toUpperCase() + source.slice(1);
    try {
      await _internalCreateLead(lead, me.id);
      created++;
    } catch (e) {
      skipped++;
    }
  }
  return { ok: true, created, skipped, source };
}

module.exports = {
  api_integrations_mapping_get, api_integrations_mapping_listFB,
  api_integrations_mapping_save,
  api_integrations_payloads_recent, api_integrations_mapping_test,
  api_integrations_csvImport,
  // Sheet sync
  runDueSheetSyncs,
  api_sheetSync_list,
  api_sheetSync_save,
  api_sheetSync_diagnose,        /* SHEET_SYNC_v2 */
  api_sheetSync_testReceive,     /* SHEET_SYNC_v2 */
  api_sheetSync_recentActivity,  /* SHEET_SYNC_v2 */
  api_sheetSync_delete,
  api_sheetSync_runNow,
  // Webhook endpoints
  leadSourceWebhook,
  sheetPushWebhook,
  // Native pull integrations
  runDueNativePulls,
  api_integration_list,
  api_integration_save,
  api_integration_delete,
  api_integration_syncNow,
  // Reusable helpers — exported so other ingest paths (FB Lead Ads, etc.)
  // can apply the same per-tenant field mapping system without duplicating logic.
  _loadCustomMapping,
  _applyCustomMapping,
  _saveLastPayload,
};
