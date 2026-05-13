/**
 * utils/webhookLogger.js — capture every external hit on /hook/* so admins
 * can debug "what did the website / Pabbly / Make.com / Meta actually send
 * me, and what did we return?" without enabling server-side logs.
 *
 * Storage is per-tenant: each tenant's pool has its own webhook_logs table.
 * Rows are trimmed to 50 KB per field to bound DB growth. Auto-prunes the
 * oldest rows beyond 2000 on every insert so the table never bloats.
 */

'use strict';

const MAX_BODY = 50_000;
const MAX_HEADERS = 10_000;
const MAX_ROWS = 2000;

function _safeJson(o, max) {
  try {
    const s = typeof o === 'string' ? o : JSON.stringify(o);
    return (s || '').slice(0, max || MAX_BODY);
  } catch (_) {
    try { return String(o).slice(0, max || MAX_BODY); } catch (_) { return ''; }
  }
}

function _redactHeaders(h) {
  // Drop the auth / signature headers from the captured copy so logs don't
  // leak secrets to admins. Path/IP/UA/content-type stay.
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    const lk = String(k).toLowerCase();
    if (lk === 'authorization' || lk === 'x-api-key' || lk.includes('signature') || lk === 'cookie' || lk === 'x-auth-token') {
      out[k] = '••••••';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Express middleware factory. Mount with: app.use('/hook', webhookLogger())
 * Runs AFTER body-parser middleware so req.body is the parsed object.
 * Buffers req body separately for raw access if needed. Wraps res.json /
 * res.send / res.end to capture the response payload and status.
 */
function middleware() {
  return function _webhookLogger(req, res, next) {
    const start = Date.now();
    // Stash the captured body
    const captured = {
      path:   String(req.originalUrl || req.url || '').slice(0, 500),
      method: String(req.method || ''),
      source_ip:  String(req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress || ''),
      user_agent: String(req.headers['user-agent'] || ''),
      headers_json: _safeJson(_redactHeaders(req.headers), MAX_HEADERS),
      query_json:   _safeJson(req.query || {}, 2000),
      body_text:    _safeJson(req.body, MAX_BODY)
    };

    // Wrap response writers to capture the response payload + code
    let responseText = '';
    let responseCode = 200;
    const origJson = res.json.bind(res);
    res.json = function (obj) {
      try { responseText = _safeJson(obj, MAX_BODY); responseCode = res.statusCode || 200; } catch (_) {}
      return origJson(obj);
    };
    const origSend = res.send.bind(res);
    res.send = function (body) {
      try { responseText = _safeJson(body, MAX_BODY); responseCode = res.statusCode || 200; } catch (_) {}
      return origSend(body);
    };
    const origEnd = res.end.bind(res);
    res.end = function (body, enc) {
      try {
        if (body && !responseText) responseText = _safeJson(body, MAX_BODY);
        if (!responseCode) responseCode = res.statusCode || 200;
      } catch (_) {}
      writeRow(req, captured, responseCode, responseText, Date.now() - start);
      return origEnd(body, enc);
    };
    next();
  };
}

async function writeRow(req, c, code, respText, durationMs) {
  // setImmediate so we never block the actual response. Errors are
  // swallowed — webhook delivery must not depend on log success.
  setImmediate(async () => {
    try {
      const db = require('../db/pg');
      // The tenant pool is set on the AsyncLocalStorage by the tenant
      // middleware that ran before this. If there's no store, fall back
      // to the default (single-tenant) pool.
      await db.query(`
        CREATE TABLE IF NOT EXISTS webhook_logs (
          id            SERIAL PRIMARY KEY,
          path          TEXT NOT NULL,
          method        TEXT NOT NULL,
          source_ip     TEXT,
          user_agent    TEXT,
          headers_json  TEXT,
          query_json    TEXT,
          body_text     TEXT,
          response_code INTEGER,
          response_text TEXT,
          duration_ms   INTEGER,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_webhook_logs_path    ON webhook_logs(path)`);
      await db.query(
        `INSERT INTO webhook_logs (path, method, source_ip, user_agent, headers_json, query_json, body_text, response_code, response_text, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [c.path, c.method, c.source_ip, c.user_agent, c.headers_json, c.query_json, c.body_text,
         code || 0, (respText || '').slice(0, MAX_BODY), Number.isFinite(durationMs) ? durationMs : 0]
      );
      // Cap table size — delete oldest rows beyond MAX_ROWS
      await db.query(
        `DELETE FROM webhook_logs WHERE id IN (
           SELECT id FROM webhook_logs ORDER BY id DESC OFFSET $1
         )`, [MAX_ROWS]
      );
    } catch (e) {
      console.warn('[webhook-log] insert failed:', e.message);
    }
  });
}

/** Admin API — list recent webhook events */
async function api_admin_webhookLogs_list(token, opts) {
  const { authUser } = require('./auth');
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const db = require('../db/pg');
  const o = opts || {};
  const limit = Math.max(1, Math.min(500, Number(o.limit || 100)));
  let rows;
  try {
    const conditions = [];
    const vals = [];
    if (o.path) { vals.push('%' + String(o.path) + '%'); conditions.push('path ILIKE $' + vals.length); }
    if (o.since) { vals.push(String(o.since)); conditions.push('created_at >= $' + vals.length); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    vals.push(limit);
    const r = await db.query(
      `SELECT id, path, method, source_ip, user_agent, response_code, duration_ms, created_at,
              LEFT(body_text, 4000) AS body_preview, LEFT(response_text, 1500) AS response_preview
         FROM webhook_logs ${where}
         ORDER BY id DESC LIMIT $${vals.length}`, vals);
    rows = r.rows;
  } catch (e) {
    // Table doesn't exist yet (no webhook has been received) — surface empty.
    return { rows: [], note: 'webhook_logs table does not exist yet — first inbound hook will create it.' };
  }
  return { rows };
}

async function api_admin_webhookLogs_get(token, id) {
  const { authUser } = require('./auth');
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const db = require('../db/pg');
  const r = await db.query(`SELECT * FROM webhook_logs WHERE id = $1`, [Number(id)]);
  return r.rows[0] || null;
}


/**
 * Walk recent webhook_logs and (re-)apply the source resolver to each
 * payload. If the resulting source is more specific than what currently
 * sits on the lead (i.e. lead.source is 'Website', 'manual', 'unknown',
 * empty, or null), update the lead. Matches log → lead by phone within
 * ±15 minutes of the log timestamp.
 *
 * opts.daysBack defaults to 30. opts.dryRun returns the proposed
 * updates without writing.
 */
async function api_admin_webhookLogs_backfillSources(token, opts) {
  const { authUser } = require('./auth');
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') {
    throw new Error('Admin / manager only');
  }
  const db = require('../db/pg');
  const days = Math.max(1, Math.min(180, Number((opts && opts.daysBack) || 30)));
  const dryRun = !!(opts && opts.dryRun);
  const GENERIC = new Set(['', 'website', 'manual', 'unknown', 'web', 'web_form']);

  // Pull logs from /hook/* in the window. Newest first so we apply the
  // most-recent payload per phone.
  const { rows } = await db.query(
    `SELECT id, path, body_text, response_code, created_at
       FROM webhook_logs
      WHERE created_at >= NOW() - ($1::int || ' days')::interval
        AND path ILIKE '/hook/%'
        AND response_code BETWEEN 200 AND 299
      ORDER BY created_at DESC`,
    [days]
  );

  // Resolver — mirrors the new websiteHook logic.
  function resolveSource(b) {
    if (!b || typeof b !== 'object') return '';
    const named = b.source || b.lead_source || b.leadsource || b.origin
               || b.source_type || b.source_name || b.channel || b.referrer;
    if (named && String(named).trim()) return String(named).trim();
    if (b.gclid || b.campaign_id || b.campaignid || b.campaignId) return 'Google Ads';
    if (b.utm_source && String(b.utm_source).trim()) return String(b.utm_source).trim();
    // Catch-all: any key containing 'source' (except metadata)
    for (const k of Object.keys(b)) {
      const nk = String(k).toLowerCase();
      if (!nk.includes('source')) continue;
      if (nk === 'source_ref' || nk === 'source_ip' || nk.startsWith('utm_')) continue;
      const v = String(b[k] || '').trim();
      if (v) return v;
    }
    return '';
  }

  function cleanDigits(s) {
    return String(s || '').replace(/\D/g, '').slice(-10);
  }

  const updates = [];
  const seenPhones = new Set(); // first-touch (most recent) wins
  for (const log of rows) {
    let body;
    try { body = JSON.parse(log.body_text || '{}'); } catch (_) { continue; }
    const newSrc = resolveSource(body);
    if (!newSrc) continue;
    const phone = cleanDigits(body.phone || body.mobile || body.contact || body.whatsapp);
    if (!phone) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);

    // Find the lead created around this log
    const lookup = await db.query(
      `SELECT id, name, phone, source, created_at FROM leads
        WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE $1
          AND created_at BETWEEN ($2::timestamptz - INTERVAL '15 minutes')
                             AND ($2::timestamptz + INTERVAL '15 minutes')
        ORDER BY created_at DESC LIMIT 1`,
      ['%' + phone, log.created_at]
    );
    const lead = lookup.rows[0];
    if (!lead) continue;

    const curr = String(lead.source || '').trim().toLowerCase();
    if (!GENERIC.has(curr) && curr === newSrc.toLowerCase()) continue; // already correct
    if (!GENERIC.has(curr) && curr !== newSrc.toLowerCase()) {
      // Lead has an explicit source already — don't overwrite a real value.
      continue;
    }
    updates.push({
      lead_id: lead.id, name: lead.name, phone: lead.phone,
      old: lead.source, new: newSrc, log_id: log.id, when: log.created_at
    });
  }

  if (!dryRun) {
    for (const u of updates) {
      try {
        await db.query('UPDATE leads SET source = $1 WHERE id = $2', [u.new, u.lead_id]);
      } catch (_) {}
    }
  }

  return {
    days_back: days,
    logs_scanned: rows.length,
    leads_updated: dryRun ? 0 : updates.length,
    proposed: dryRun ? updates.length : 0,
    sample: updates.slice(0, 25),
    dry_run: dryRun
  };
}

module.exports = { middleware, api_admin_webhookLogs_list, api_admin_webhookLogs_get, api_admin_webhookLogs_backfillSources };
