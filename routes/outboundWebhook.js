// OUTBOUND_WH_v1 — send each NEW lead to one or more external URLs
// based on per-webhook filter rules (source / status / cf_*).
//
// Tables: outbound_webhooks, outbound_webhook_log
// Public APIs:
//   api_outboundWebhook_list / _save / _delete / _test / _logs / _retry
// Internal:
//   fireOutboundWebhooks(lead) — called from lead creation path

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// Schema state per tenant (memoised)
const _schemaReady = new Set();
async function _ensureSchema() {
  const tenant = (db._tenantSlug && db._tenantSlug()) || 'default';
  if (_schemaReady.has(tenant)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS outbound_webhooks (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'POST',
      headers_json JSONB DEFAULT '{}'::jsonb,
      body_template TEXT DEFAULT '',
      source_filter TEXT DEFAULT '',
      status_filter TEXT DEFAULT '',
      cf_filter_json JSONB DEFAULT '{}'::jsonb,
      enabled BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS outbound_webhook_log (
      id SERIAL PRIMARY KEY,
      webhook_id INT,
      lead_id INT,
      url TEXT,
      method TEXT,
      request_headers TEXT,
      request_body TEXT,
      http_status INT,
      response_body TEXT,
      error_message TEXT,
      success BOOLEAN DEFAULT FALSE,
      attempted_at TIMESTAMPTZ DEFAULT NOW(),
      retry_count INT DEFAULT 0
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_owl_webhook_id ON outbound_webhook_log(webhook_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_owl_attempted ON outbound_webhook_log(attempted_at DESC);`);
  _schemaReady.add(tenant);
}

function _splitCsv(s) {
  return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

function _flattenCfs(lead) {
  // OUTBOUND_WH_CF_FIRE_v1 — make CF lookup tolerant of both key forms.
  // The SPA stores rule keys WITHOUT the cf_ prefix (e.g. {"orderid":"ABC"})
  // because the cf field-select dropdown uses cf.key as-is. Real leads also
  // store extra_json keys WITHOUT the cf_ prefix (routes/leads.js strips it
  // with key.slice(3) at line ~822). The previous code only added
  // cf_-prefixed keys to the lookup map, so cfs["orderid"] was always
  // undefined → match silently failed → webhook never fired. Now we store
  // every extra_json key under BOTH forms so either rule shape works.
  const out = {};
  const tryAdd = (k, v) => {
    if (v == null) return;
    out[String(k).toLowerCase()] = String(v);
  };
  let ej = lead.extra_json;
  if (typeof ej === 'string') { try { ej = JSON.parse(ej); } catch (_) { ej = null; } }
  if (ej && typeof ej === 'object') {
    Object.keys(ej).forEach(k => {
      // Store under both the raw key and a cf_-prefixed form
      tryAdd(k, ej[k]);
      if (!k.startsWith('cf_')) tryAdd('cf_' + k, ej[k]);
    });
  }
  if (lead.custom_fields && typeof lead.custom_fields === 'object') {
    Object.keys(lead.custom_fields).forEach(k => {
      tryAdd(k, lead.custom_fields[k]);
      if (!k.startsWith('cf_')) tryAdd('cf_' + k, lead.custom_fields[k]);
    });
  }
  Object.keys(lead).forEach(k => {
    if (k.startsWith('cf_')) {
      tryAdd(k, lead[k]);
      tryAdd(k.slice(3), lead[k]); // also expose unprefixed form
    }
  });
  return out;
}

async function _matchesFilters(webhook, lead) {
  const sf = _splitCsv(webhook.source_filter);
  if (sf.length > 0) {
    const src = String(lead.source || '').toLowerCase();
    if (!sf.includes(src)) return false;
  }
  const stf = _splitCsv(webhook.status_filter);
  if (stf.length > 0) {
    let statusName = lead._statusName || '';
    if (!statusName && lead.status_id) {
      try {
        const s = await db.findOneBy('statuses', 'id', lead.status_id);
        statusName = s ? String(s.name || '').toLowerCase() : '';
      } catch (_) { statusName = ''; }
    }
    statusName = String(statusName).toLowerCase();
    if (!stf.includes(statusName)) return false;
  }
  let cfRules = webhook.cf_filter_json;
  if (typeof cfRules === 'string') { try { cfRules = JSON.parse(cfRules); } catch (_) { cfRules = {}; } }
  cfRules = cfRules || {};
  const cfs = _flattenCfs(lead);
  for (const [k, raw] of Object.entries(cfRules)) {
    // OUTBOUND_WH_v7 — rule shape is either:
    //   legacy: "value" | ["v1","v2"]           → treat as op:'equals'
    //   new:    { op: 'equals'|'exact'|'contains'|'not_equals', values: [...] }
    let op = 'equals';
    let rawVals = raw;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.op || raw.values)) {
      op = String(raw.op || 'equals').toLowerCase();
      rawVals = raw.values;
    }
    const wantedRaw = Array.isArray(rawVals)
      ? rawVals.filter(x => x != null && String(x).trim() !== '').map(x => String(x).trim())
      : (rawVals != null && String(rawVals).trim() !== '' ? [String(rawVals).trim()] : []);
    if (wantedRaw.length === 0) continue;
    const wantedLower = wantedRaw.map(x => x.toLowerCase());

    // OUTBOUND_WH_CF_FIRE_v1 — lookup under BOTH the raw rule key and cf_-prefixed form.
    const kLower = String(k).toLowerCase();
    let have = cfs[kLower];
    if (have == null && !kLower.startsWith('cf_')) have = cfs['cf_' + kLower];
    if (have == null && kLower.startsWith('cf_')) have = cfs[kLower.slice(3)];
    if (have == null) {
      // for not_equals on a missing field, treat as pass (no value can equal something it isn't)
      if (op === 'not_equals') continue;
      console.log('[outboundWebhook] cf rule miss — key', k, 'not in lead. op=' + op + '. Available cf keys:', Object.keys(cfs).join(','));
      return false;
    }
    const haveRaw = String(have).trim();
    const haveLower = haveRaw.toLowerCase();

    let pass = false;
    if (op === 'contains') {
      pass = wantedLower.some(w => haveLower.includes(w));
    } else if (op === 'exact') {
      // case-sensitive exact match
      pass = wantedRaw.includes(haveRaw);
    } else if (op === 'not_equals') {
      pass = !wantedLower.includes(haveLower);
    } else {
      // equals (case-insensitive) — default + legacy behaviour
      pass = wantedLower.includes(haveLower);
    }
    if (!pass) {
      console.log('[outboundWebhook] cf rule value mismatch — key', k, 'op=' + op, 'wanted', wantedRaw, 'got', haveRaw);
      return false;
    }
  }
  return true;
}

async function _renderBody(webhook, lead) {
  const cfs = _flattenCfs(lead);
  let assigneeName = '';
  if (lead.assigned_to) {
    try { const u = await db.findOneBy('users', 'id', lead.assigned_to); if (u) assigneeName = u.name || u.email || ''; } catch (_) {}
  }
  let statusName = lead._statusName || '';
  if (!statusName && lead.status_id) {
    try { const s = await db.findOneBy('statuses', 'id', lead.status_id); statusName = s ? s.name : ''; } catch (_) {}
  }
  const ctx = {
    id: lead.id || '',
    name: lead.name || '',
    phone: lead.phone || '',
    whatsapp: lead.whatsapp || '',
    email: lead.email || '',
    source: lead.source || '',
    source_ref: lead.source_ref || '',
    status: statusName,
    status_id: lead.status_id || '',
    city: lead.city || '',
    company: lead.company || '',
    notes: lead.notes || '',
    tags: lead.tags || '',
    value: lead.value || '',
    assigned_to_id: lead.assigned_to || '',
    assigned_to_name: assigneeName,
    created_at: lead.created_at || ''
  };
  Object.assign(ctx, cfs);

  const tpl = String(webhook.body_template || '').trim();
  if (!tpl) return JSON.stringify(ctx);
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = ctx[key];
    return v == null ? '' : String(v);
  });
}

async function _doDelivery(webhook, lead, opts) {
  opts = opts || {};
  const url = String(webhook.url || '').trim();
  const method = String(webhook.method || 'POST').toUpperCase();
  let headers = webhook.headers_json;
  if (typeof headers === 'string') { try { headers = JSON.parse(headers); } catch (_) { headers = {}; } }
  headers = headers || {};
  const isBodyMethod = (method === 'POST' || method === 'PUT' || method === 'PATCH');
  if (isBodyMethod && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }
  const body = isBodyMethod ? await _renderBody(webhook, lead) : null;

  let httpStatus = 0, responseBody = '', success = false, errorMessage = '';
  const startTs = Date.now();
  try {
    const ctl = new AbortController();
    const tmo = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(url, {
      method, headers,
      body: isBodyMethod ? body : undefined,
      signal: ctl.signal
    });
    clearTimeout(tmo);
    httpStatus = r.status;
    try { responseBody = (await r.text() || '').slice(0, 2000); } catch (_) { responseBody = ''; }
    success = r.ok;
    if (!success) errorMessage = 'HTTP ' + r.status;
  } catch (e) {
    errorMessage = (e && e.message) ? e.message : String(e);
  }
  const tookMs = Date.now() - startTs;

  try {
    await db.insert('outbound_webhook_log', {
      webhook_id: webhook.id || null,
      lead_id: lead.id || null,
      url, method,
      request_headers: JSON.stringify(headers || {}),
      request_body: body ? String(body).slice(0, 8000) : '',
      http_status: httpStatus || null,
      response_body: responseBody,
      error_message: errorMessage,
      success,
      attempted_at: db.nowIso(),
      retry_count: opts.retryCount || 0
    });
  } catch (e) {
    console.error('[outboundWebhook] log insert failed:', e.message);
  }
  return { success, httpStatus, errorMessage, responseBody, tookMs, isTest: !!opts.isTest };
}

async function fireOutboundWebhooks(lead) {
  if (!lead || !lead.id) return { skipped: 'no lead' };
  try { await _ensureSchema(); } catch (_) {}
  let webhooks = [];
  try { webhooks = await db.getAll('outbound_webhooks'); } catch (e) { return { skipped: 'no table' }; }
  const enabled = webhooks.filter(w => w.enabled === true || w.enabled === 1 || String(w.enabled) === 'true');
  if (enabled.length === 0) return { fired: 0 };
  let fullLead = lead;
  if (lead.id && (!lead.extra_json || lead.extra_json === '{}')) {
    try { const fresh = await db.findOneBy('leads', 'id', lead.id); if (fresh) fullLead = Object.assign({}, fresh, lead); } catch (_) {}
  }
  let fired = 0;
  for (const w of enabled) {
    try {
      const matches = await _matchesFilters(w, fullLead);
      if (!matches) continue;
      await _doDelivery(w, fullLead, { isTest: false });
      fired++;
    } catch (e) {
      console.error('[outboundWebhook] fire failed for webhook', w.id, e.message);
    }
  }
  return { fired, evaluated: enabled.length };
}

async function api_outboundWebhook_list(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  const rows = await db.getAll('outbound_webhooks');
  return rows.sort((a, b) => Number(b.id) - Number(a.id));
}

async function api_outboundWebhook_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('Name required');
  if (!p.url) throw new Error('URL required');
  if (!/^https?:\/\//i.test(p.url)) throw new Error('URL must start with http:// or https://');
  let cfFilter = p.cf_filter_json;
  if (typeof cfFilter === 'string') { try { cfFilter = cfFilter.trim() ? JSON.parse(cfFilter) : {}; } catch (_) { throw new Error('cf_filter_json must be valid JSON'); } }
  cfFilter = cfFilter || {};
  let headers = p.headers_json;
  if (typeof headers === 'string') { try { headers = headers.trim() ? JSON.parse(headers) : {}; } catch (_) { throw new Error('headers_json must be valid JSON'); } }
  headers = headers || {};
  const row = {
    name: String(p.name).trim(),
    url: String(p.url).trim(),
    method: String(p.method || 'POST').toUpperCase(),
    headers_json: JSON.stringify(headers),
    body_template: String(p.body_template || ''),
    source_filter: String(p.source_filter || '').trim(),
    status_filter: String(p.status_filter || '').trim(),
    cf_filter_json: JSON.stringify(cfFilter),
    enabled: !(p.enabled === false || p.enabled === 0 || p.enabled === '0'),
    updated_at: db.nowIso()
  };
  if (p.id) {
    await db.update('outbound_webhooks', Number(p.id), row);
    return { ok: true, id: Number(p.id) };
  }
  row.created_at = db.nowIso();
  const id = await db.insert('outbound_webhooks', row);
  return { ok: true, id };
}

async function api_outboundWebhook_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  await db.del('outbound_webhooks', Number(id));
  return { ok: true };
}

async function api_outboundWebhook_test(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const p = payload || {};
  const webhook = p.webhook_id ? await db.findOneBy('outbound_webhooks', 'id', Number(p.webhook_id)) : p;
  if (!webhook) throw new Error('Webhook not found');
  const dummyLead = {
    id: 0,
    name: 'Test Lead',
    phone: '+919999999999',
    whatsapp: '+919999999999',
    email: 'test@example.com',
    source: 'Test',
    source_ref: 'webhook-test',
    status_id: null,
    _statusName: 'New',
    city: 'Test City',
    company: 'Test Co',
    notes: 'This is a test event fired by the admin from Settings > Outbound Webhooks',
    tags: 'test',
    value: '0',
    assigned_to: me.id,
    created_at: new Date().toISOString(),
    extra_json: {}
  };
  let cfRules = webhook.cf_filter_json;
  if (typeof cfRules === 'string') { try { cfRules = JSON.parse(cfRules); } catch (_) { cfRules = {}; } }
  if (cfRules && typeof cfRules === 'object') {
    Object.keys(cfRules).forEach(k => { if (cfRules[k]) dummyLead[k] = cfRules[k]; });
  }
  return await _doDelivery(webhook, dummyLead, { isTest: true });
}

async function api_outboundWebhook_logs(token, opts) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  await _ensureSchema();
  opts = opts || {};
  const limit = Math.min(Number(opts.limit) || 100, 500);
  const wid = opts.webhook_id ? Number(opts.webhook_id) : null;
  let sql = 'SELECT * FROM outbound_webhook_log';
  const args = [];
  if (wid) { sql += ' WHERE webhook_id = $1'; args.push(wid); }
  sql += ' ORDER BY attempted_at DESC LIMIT ' + limit;
  const r = await db.query(sql, args);
  return r.rows || [];
}

async function api_outboundWebhook_retry(token, logId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  const log = await db.findOneBy('outbound_webhook_log', 'id', Number(logId));
  if (!log) throw new Error('Log entry not found');
  const webhook = log.webhook_id ? await db.findOneBy('outbound_webhooks', 'id', log.webhook_id) : null;
  if (!webhook) throw new Error('Original webhook no longer exists');
  let headers = {};
  try { headers = JSON.parse(log.request_headers || '{}'); } catch (_) {}
  const method = String(log.method || webhook.method || 'POST').toUpperCase();
  const isBodyMethod = (method === 'POST' || method === 'PUT' || method === 'PATCH');
  let httpStatus = 0, responseBody = '', success = false, errorMessage = '';
  try {
    const ctl = new AbortController();
    const tmo = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(log.url, {
      method, headers,
      body: isBodyMethod ? (log.request_body || '') : undefined,
      signal: ctl.signal
    });
    clearTimeout(tmo);
    httpStatus = r.status;
    try { responseBody = (await r.text() || '').slice(0, 2000); } catch (_) { responseBody = ''; }
    success = r.ok;
    if (!success) errorMessage = 'HTTP ' + r.status;
  } catch (e) {
    errorMessage = (e && e.message) ? e.message : String(e);
  }
  await db.insert('outbound_webhook_log', {
    webhook_id: webhook.id,
    lead_id: log.lead_id || null,
    url: log.url, method,
    request_headers: log.request_headers || '{}',
    request_body: log.request_body || '',
    http_status: httpStatus || null,
    response_body: responseBody,
    error_message: errorMessage,
    success,
    attempted_at: db.nowIso(),
    retry_count: Number(log.retry_count || 0) + 1
  });
  return { ok: true, success, httpStatus, errorMessage, responseBody };
}


// OUTBOUND_WH_v2 — return dropdown options so the SPA can render friendly
// pickers instead of CSV / JSON textareas. Lists sources, statuses, and
// each custom field with its known distinct values (sampled from
// extra_json across recent leads).
async function api_outboundWebhook_filterOptions(token) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin / manager only');
  // 1) Sources: distinct lead.source values + lead_source_mapping rows
  let sources = [];
  try {
    const r1 = await db.query(`SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND source <> '' ORDER BY source LIMIT 200`);
    sources = (r1.rows || []).map(r => r.source).filter(Boolean);
  } catch (_) {}
  // 2) Statuses
  let statuses = [];
  try {
    const r2 = await db.query(`SELECT name FROM statuses ORDER BY COALESCE(sort_order, 0), id`);
    statuses = (r2.rows || []).map(r => r.name).filter(Boolean);
  } catch (_) {}
  // 3) Custom fields + distinct values sampled from leads.extra_json
  let customFields = [];
  try {
    const r3 = await db.query(`SELECT key, label FROM custom_fields WHERE COALESCE(is_active, 1) = 1 ORDER BY COALESCE(sort_order, 0), id`);
    const fields = (r3.rows || []).filter(r => r && r.key);
    for (const f of fields) {
      const key = 'cf_' + f.key;
      let values = [];
      try {
        // Pull from leads.extra_json JSONB. Falls back gracefully if extra_json is text.
        const r4 = await db.query(
          `SELECT DISTINCT (extra_json->>$1) AS v FROM leads WHERE extra_json IS NOT NULL AND (extra_json->>$1) IS NOT NULL AND (extra_json->>$1) <> '' ORDER BY v LIMIT 50`,
          [key]
        );
        values = (r4.rows || []).map(r => r.v).filter(Boolean);
      } catch (_) {
        try {
          // Fallback if extra_json is stored as text
          const r5 = await db.query(`SELECT extra_json FROM leads WHERE extra_json IS NOT NULL AND extra_json::text LIKE $1 LIMIT 500`, ['%"' + key + '"%']);
          const seen = new Set();
          for (const row of (r5.rows || [])) {
            try {
              const obj = typeof row.extra_json === 'string' ? JSON.parse(row.extra_json) : row.extra_json;
              if (obj && obj[key]) seen.add(String(obj[key]));
            } catch (_) {}
          }
          values = Array.from(seen).slice(0, 50).sort();
        } catch (_) {}
      }
      customFields.push({ key, label: f.label || f.key, values });
    }
  } catch (e) {
    console.warn('[outboundWebhook] filterOptions cf lookup failed:', e.message);
  }
  return { sources, statuses, custom_fields: customFields };
}

module.exports = {
  fireOutboundWebhooks,
  api_outboundWebhook_list,
  api_outboundWebhook_save,
  api_outboundWebhook_delete,
  api_outboundWebhook_test,
  api_outboundWebhook_logs,
  api_outboundWebhook_filterOptions,
  api_outboundWebhook_retry
};
