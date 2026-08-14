/**
 * routes/waCampaign.js — WA_API_CAMPAIGN_v1 (2026-08-13)
 *
 * AiSensy-style "API Campaign": an external system POSTs one JSON body with an
 * apiKey + campaignName to send an approved WhatsApp template through the
 * tenant's own Meta Cloud API number, auto-creating the lead if new.
 *
 * PUBLIC endpoint (mounted in server.js):
 *   POST /campaign/t1/api/v2      (AiSensy-identical body — drop-in)
 *   POST /api/v2/wa/campaign      (native alias)
 *   -> expressApiSend(req,res)
 *
 * TENANT ADMIN (auto-loaded by routes/saas/tenantApi.js dispatcher; api_* fns):
 *   api_waCampaign_templates / _list / _save / _setStatus / _delete
 *   api_waCampaign_keys_list / _keys_create / _keys_revoke
 *   api_waCampaign_logs / _test
 *
 * DESIGN NOTES
 *  - Reuses whatsbot._sendTemplate (same engine as chat/bots/campaigns) so the
 *    outbound message also lands in the lead's chat thread + tat timeline, and
 *    delivery-status webhooks update it exactly like any other WA message.
 *  - New tables are created with CREATE TABLE IF NOT EXISTS (no db/pg SCHEMA
 *    edit). api_keys lives in the CONTROL db (looked up via db.pool.query);
 *    wa_api_campaigns + wa_campaign_logs live per-tenant (tenant-scoped db.query).
 *  - Purely additive: nothing existing is modified.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db/pg');

let _auth = null;
try { _auth = require('../utils/auth'); } catch (_) { _auth = null; }

// ---------------------------------------------------------------------------
// Table bootstrap (idempotent, cached)
// ---------------------------------------------------------------------------
let _ctrlEnsured = false;
const _tenantEnsured = new Set();

async function _ensureControlTable() {
  if (_ctrlEnsured) return;
  await db.pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id            BIGSERIAL PRIMARY KEY,
      key_hash      TEXT UNIQUE NOT NULL,
      key_prefix    TEXT NOT NULL,
      slug          TEXT NOT NULL,
      label         TEXT,
      scopes        TEXT[] DEFAULT ARRAY['wa_campaign']::text[],
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      daily_quota   INTEGER NOT NULL DEFAULT 0,
      created_by    INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ,
      revoked_at    TIMESTAMPTZ
    )`);
  await db.pool.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_slug ON api_keys(slug)`);
  _ctrlEnsured = true;
}

function _slug() {
  try { const s = db.tenantStorage.getStore(); return (s && s.slug) || null; } catch (_) { return null; }
}

async function _ensureTenantTables() {
  const slug = _slug();
  if (slug && _tenantEnsured.has(slug)) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_api_campaigns (
      id                BIGSERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'draft',
      template_name     TEXT NOT NULL,
      template_language TEXT NOT NULL DEFAULT 'en_US',
      header_type       TEXT DEFAULT 'none',
      body_param_count  INTEGER NOT NULL DEFAULT 0,
      default_source    TEXT,
      default_tags      TEXT,
      default_assignee  INTEGER,
      default_status_id INTEGER,
      created_by        INTEGER,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_api_campaigns_name ON wa_api_campaigns (lower(name))`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS wa_campaign_logs (
      id              BIGSERIAL PRIMARY KEY,
      campaign_id     BIGINT,
      api_key_id      BIGINT,
      destination     TEXT,
      user_name       TEXT,
      template_params JSONB,
      media           JSONB,
      client_ref      TEXT,
      wa_message_id   TEXT,
      lead_id         BIGINT,
      status          TEXT NOT NULL DEFAULT 'queued',
      error_code      TEXT,
      error_detail    TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_wa_campaign_logs_campaign ON wa_campaign_logs(campaign_id)`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_campaign_logs_ref ON wa_campaign_logs (campaign_id, client_ref) WHERE client_ref IS NOT NULL`);
  if (slug) _tenantEnsured.add(slug);
}

// ---------------------------------------------------------------------------
// API-key helpers (CONTROL db)
// ---------------------------------------------------------------------------
function _hashKey(k) { return crypto.createHash('sha256').update(String(k)).digest('hex'); }
function _genKey() { return 'SCRM_live_' + crypto.randomBytes(24).toString('hex'); }

async function _lookupApiKey(rawKey) {
  await _ensureControlTable();
  const r = await db.pool.query(
    `SELECT * FROM api_keys WHERE key_hash = $1 AND active = TRUE AND revoked_at IS NULL LIMIT 1`,
    [_hashKey(rawKey)]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// PUBLIC send endpoint
// ---------------------------------------------------------------------------
async function expressApiSend(req, res) {
  try {
    const body = req.body || {};
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) return res.status(401).json({ success: false, error: 'INVALID_API_KEY', message: 'apiKey is required' });

    const keyRow = await _lookupApiKey(apiKey);
    if (!keyRow) return res.status(401).json({ success: false, error: 'INVALID_API_KEY', message: 'Invalid or revoked API key' });

    const campaignName = String(body.campaignName || '').trim();
    const destination = String(body.destination || '').trim();
    const userName = String(body.userName || '').trim();
    if (!campaignName || !destination || !userName) {
      return res.status(400).json({ success: false, error: 'MISSING_FIELDS', message: 'campaignName, destination and userName are required' });
    }

    const pools = require('../utils/tenantPool');
    let t;
    try { t = await pools.findActiveTenant(keyRow.slug); } catch (_) { t = null; }
    if (!t) return res.status(404).json({ success: false, error: 'TENANT_UNAVAILABLE', message: 'Workspace unavailable' });
    const pool = pools.poolFor(t);
    if (!pool) return res.status(503).json({ success: false, error: 'TENANT_UNAVAILABLE', message: 'Workspace pool unavailable' });

    return db.tenantStorage.run({ pool, tenant: t, slug: keyRow.slug }, async () => {
      const out = await _processSend(keyRow, body);
      try { await db.pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [keyRow.id]); } catch (_) {}
      return res.status(out.httpStatus).json(out.json);
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: 'INTERNAL', message: String((e && e.message) || e) });
  }
}

// Core send (runs INSIDE the resolved tenant's storage scope).
// `opts.testUserId` set when triggered from the admin "test send".
async function _processSend(keyRow, body, opts) {
  opts = opts || {};
  await _ensureTenantTables();
  const whatsbot = require('./whatsbot');

  const campaignName = String(body.campaignName || '').trim();
  const destination = String(body.destination || '').trim();
  const userName = String(body.userName || '').trim();
  const templateParams = Array.isArray(body.templateParams) ? body.templateParams : [];
  const media = (body.media && body.media.url) ? body.media : null;
  const clientRef = body.clientRef ? String(body.clientRef) : null;

  // 1. Resolve campaign (by id when testing, else by name); must be Live for API.
  let campaign;
  if (opts.campaignId) {
    const cr = await db.query(`SELECT * FROM wa_api_campaigns WHERE id = $1 LIMIT 1`, [opts.campaignId]);
    campaign = cr.rows[0];
  } else {
    const cr = await db.query(`SELECT * FROM wa_api_campaigns WHERE lower(name) = lower($1) LIMIT 1`, [campaignName]);
    campaign = cr.rows[0];
  }
  if (!campaign) return { httpStatus: 404, json: { success: false, error: 'CAMPAIGN_NOT_FOUND', message: `Campaign '${campaignName}' not found` } };
  if (!opts.allowNonLive && String(campaign.status) !== 'live') {
    return { httpStatus: 400, json: { success: false, error: 'CAMPAIGN_NOT_LIVE', message: `Campaign '${campaign.name}' is not Live` } };
  }

  // 2. Idempotency (skip for test sends).
  if (clientRef && !opts.testUserId) {
    const ex = await db.query(`SELECT wa_message_id, status FROM wa_campaign_logs WHERE campaign_id = $1 AND client_ref = $2 LIMIT 1`, [campaign.id, clientRef]);
    if (ex.rows[0]) return { httpStatus: 200, json: { success: true, submittedId: 'wc_' + campaign.id + '_' + clientRef, waMessageId: ex.rows[0].wa_message_id, status: ex.rows[0].status, idempotent: true } };
  }

  // 3. Validate against the cached approved template.
  const tr = await db.query(`SELECT * FROM wa_templates WHERE name = $1 ORDER BY (language = $2) DESC LIMIT 1`, [campaign.template_name, campaign.template_language || 'en_US']);
  const tpl = tr.rows[0];
  const needParams = tpl ? Number(tpl.body_params || 0) : Number(campaign.body_param_count || 0);
  const headerType = String((tpl && tpl.header_type) || campaign.header_type || 'none').toLowerCase();
  if (templateParams.length !== needParams) {
    return { httpStatus: 400, json: { success: false, error: 'TEMPLATE_PARAM_MISMATCH', message: `Template '${campaign.template_name}' expects ${needParams} parameter(s), got ${templateParams.length}` } };
  }
  if (['image', 'video', 'document'].indexOf(headerType) !== -1 && !media) {
    return { httpStatus: 400, json: { success: false, error: 'MEDIA_REQUIRED', message: `Template header requires media.url (${headerType})` } };
  }

  // 4. WA configured?
  let cfg = null;
  try { cfg = await whatsbot._cfg(); } catch (_) { cfg = null; }
  if (!cfg || !cfg.token || !cfg.phoneId) {
    return { httpStatus: 400, json: { success: false, error: 'TENANT_WA_NOT_CONFIGURED', message: 'WhatsApp is not configured for this workspace' } };
  }

  // 5. Upsert lead by phone digits (same matcher inbound uses).
  const digits = destination.replace(/\D/g, '');
  let leadId = null, leadCreated = false, leadError = null;
  try { const lead = await whatsbot._findLeadByPhoneDigits(digits); if (lead) leadId = lead.id; } catch (_) {}
  if (!leadId) {
    const source = String(body.source || campaign.default_source || cfg.autoLeadSource || 'API Campaign');
    const statusId = campaign.default_status_id || cfg.defaultStatus || null;
    const assignee = campaign.default_assignee || cfg.defaultUser || null;
    const tagList = [];
    if (campaign.default_tags) String(campaign.default_tags).split(',').forEach(s => { const v = s.trim(); if (v) tagList.push(v); });
    if (Array.isArray(body.tags)) body.tags.forEach(s => { const v = String(s).trim(); if (v) tagList.push(v); });
    const tagsStr = tagList.length ? tagList.join(',') : null;
    const attrs = (body.attributes && typeof body.attributes === 'object') ? body.attributes : null;
    try {
      const ins = await db.query(
        `INSERT INTO leads (name, phone, whatsapp, source, status_id, assigned_to, tags, extra_json, created_at, updated_at)
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7::json, now(), now()) RETURNING id`,
        [userName, destination, source, statusId, assignee, tagsStr, attrs ? JSON.stringify(attrs) : null]);
      leadId = ins.rows[0].id; leadCreated = true;
    } catch (e) { leadError = String((e && e.message) || e); }
  }

  // 6. Log row (queued).
  let logId = null;
  try {
    const lg = await db.query(
      `INSERT INTO wa_campaign_logs (campaign_id, api_key_id, destination, user_name, template_params, media, client_ref, lead_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, 'queued', now(), now()) RETURNING id`,
      [campaign.id, keyRow ? keyRow.id : null, destination, userName,
       JSON.stringify(templateParams), media ? JSON.stringify(media) : null, clientRef, leadId]);
    logId = lg.rows[0].id;
  } catch (e) {
    if (clientRef && !opts.testUserId) {
      const ex = await db.query(`SELECT wa_message_id, status FROM wa_campaign_logs WHERE campaign_id = $1 AND client_ref = $2 LIMIT 1`, [campaign.id, clientRef]);
      if (ex.rows[0]) return { httpStatus: 200, json: { success: true, submittedId: 'wc_' + campaign.id + '_' + clientRef, waMessageId: ex.rows[0].wa_message_id, status: ex.rows[0].status, idempotent: true } };
    }
  }

  // 7. Send via the shared engine.
  let sendRes = null;
  try {
    sendRes = await whatsbot._sendTemplate({
      to: destination,
      templateName: campaign.template_name,
      language: campaign.template_language || 'en_US',
      variables: templateParams,
      imageUrl: media ? media.url : null,
      leadId: leadId || null,
      userId: opts.testUserId || null,
      campaignId: null
    }, null);
  } catch (e) {
    if (logId) { try { await db.query(`UPDATE wa_campaign_logs SET status='failed', error_code='SEND_EXCEPTION', error_detail=$2, updated_at=now() WHERE id=$1`, [logId, String((e && e.message) || e)]); } catch (_) {} }
    return { httpStatus: 502, json: { success: false, error: 'SEND_FAILED', message: String((e && e.message) || e), submittedId: logId ? ('wc_' + logId) : null, leadId: leadId || null, leadCreated, leadError } };
  }

  const waMsgId = (sendRes && sendRes.wa_message_id) || null;
  const err = (sendRes && sendRes.error) || null;
  const ok = !!waMsgId && !err;
  if (logId) { try { await db.query(`UPDATE wa_campaign_logs SET status=$2, wa_message_id=$3, error_detail=$4, updated_at=now() WHERE id=$1`, [logId, ok ? 'sent' : 'failed', waMsgId, err]); } catch (_) {} }

  if (!ok) {
    let code = 'SEND_FAILED';
    if (err && /token|expired|oauth|\b190\b|session has been invalidated/i.test(err)) code = 'WA_TOKEN_EXPIRED';
    return { httpStatus: 502, json: { success: false, error: code, message: err || 'WhatsApp send failed', submittedId: logId ? ('wc_' + logId) : null, leadId: leadId || null, leadCreated, leadError } };
  }
  return { httpStatus: 200, json: { success: true, submittedId: logId ? ('wc_' + logId) : ('wc_' + campaign.id), waMessageId: waMsgId, status: 'sent', leadId: leadId || null, leadCreated } };
}

// ---------------------------------------------------------------------------
// Tenant admin API (dispatcher-loaded; signature: api_x(token, ...args))
// ---------------------------------------------------------------------------
async function _me(token) {
  if (_auth && typeof _auth.authUser === 'function') {
    const me = await _auth.authUser(token);
    if (!me) { const e = new Error('Not authenticated'); e.status = 401; throw e; }
    return me;
  }
  return { id: null };
}

async function api_waCampaign_templates(token) {
  await _me(token); await _ensureTenantTables();
  const r = await db.query(`SELECT name, language, status, COALESCE(body_params,0) AS body_params, COALESCE(header_type,'none') AS header_type, COALESCE(has_buttons,false) AS has_buttons FROM wa_templates ORDER BY name, language`);
  return { templates: r.rows };
}

async function api_waCampaign_list(token) {
  await _me(token); await _ensureTenantTables();
  const r = await db.query(`
    SELECT c.*,
      (SELECT count(*) FROM wa_campaign_logs l WHERE l.campaign_id = c.id) AS total_sent,
      (SELECT count(*) FROM wa_campaign_logs l WHERE l.campaign_id = c.id AND l.status = 'sent') AS delivered_ok,
      (SELECT count(*) FROM wa_campaign_logs l WHERE l.campaign_id = c.id AND l.status = 'failed') AS failed
    FROM wa_api_campaigns c ORDER BY c.created_at DESC`);
  return { campaigns: r.rows };
}

async function api_waCampaign_save(token, payload) {
  const me = await _me(token); await _ensureTenantTables();
  payload = payload || {};
  const name = String(payload.name || '').trim();
  const templateName = String(payload.template_name || '').trim();
  const language = String(payload.template_language || 'en_US').trim() || 'en_US';
  if (!name) throw new Error('Campaign name is required');
  if (!templateName) throw new Error('Template is required');
  // Derive header_type + param count from the cached template.
  let headerType = 'none', bodyParams = 0;
  const tr = await db.query(`SELECT COALESCE(header_type,'none') AS header_type, COALESCE(body_params,0) AS body_params FROM wa_templates WHERE name = $1 ORDER BY (language = $2) DESC LIMIT 1`, [templateName, language]);
  if (tr.rows[0]) { headerType = String(tr.rows[0].header_type || 'none').toLowerCase(); bodyParams = Number(tr.rows[0].body_params || 0); }
  const status = ['draft', 'live', 'paused'].indexOf(String(payload.status)) !== -1 ? String(payload.status) : 'draft';
  const defSource = payload.default_source ? String(payload.default_source) : null;
  const defTags = payload.default_tags ? String(payload.default_tags) : null;
  const defAssignee = payload.default_assignee ? Number(payload.default_assignee) : null;
  const defStatusId = payload.default_status_id ? Number(payload.default_status_id) : null;

  if (payload.id) {
    await db.query(`UPDATE wa_api_campaigns SET name=$2, template_name=$3, template_language=$4, header_type=$5, body_param_count=$6, default_source=$7, default_tags=$8, default_assignee=$9, default_status_id=$10, status=$11, updated_at=now() WHERE id=$1`,
      [Number(payload.id), name, templateName, language, headerType, bodyParams, defSource, defTags, defAssignee, defStatusId, status]);
    return { ok: true, id: Number(payload.id) };
  }
  const ins = await db.query(`INSERT INTO wa_api_campaigns (name, template_name, template_language, header_type, body_param_count, default_source, default_tags, default_assignee, default_status_id, status, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now()) RETURNING id`,
    [name, templateName, language, headerType, bodyParams, defSource, defTags, defAssignee, defStatusId, status, me && me.id ? me.id : null]);
  return { ok: true, id: ins.rows[0].id };
}

async function api_waCampaign_setStatus(token, id, status) {
  await _me(token); await _ensureTenantTables();
  const st = ['draft', 'live', 'paused'].indexOf(String(status)) !== -1 ? String(status) : 'draft';
  await db.query(`UPDATE wa_api_campaigns SET status=$2, updated_at=now() WHERE id=$1`, [Number(id), st]);
  return { ok: true, id: Number(id), status: st };
}

async function api_waCampaign_delete(token, id) {
  await _me(token); await _ensureTenantTables();
  await db.query(`DELETE FROM wa_api_campaigns WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

async function api_waCampaign_keys_list(token) {
  await _me(token); await _ensureControlTable();
  const slug = _slug();
  const r = await db.pool.query(`SELECT id, key_prefix, label, active, daily_quota, created_at, last_used_at, revoked_at FROM api_keys WHERE slug = $1 ORDER BY created_at DESC`, [slug]);
  return { keys: r.rows };
}

async function api_waCampaign_keys_create(token, payload) {
  const me = await _me(token); await _ensureControlTable();
  const slug = _slug();
  if (!slug) throw new Error('No tenant scope');
  payload = payload || {};
  const rawKey = _genKey();
  const prefix = rawKey.slice(0, 16);
  const ins = await db.pool.query(`INSERT INTO api_keys (key_hash, key_prefix, slug, label, created_by, created_at) VALUES ($1,$2,$3,$4,$5,now()) RETURNING id`,
    [_hashKey(rawKey), prefix, slug, payload.label ? String(payload.label) : null, me && me.id ? me.id : null]);
  // Full key returned ONCE — never stored in plaintext.
  return { ok: true, id: ins.rows[0].id, apiKey: rawKey, key_prefix: prefix };
}

async function api_waCampaign_keys_revoke(token, id) {
  await _me(token); await _ensureControlTable();
  const slug = _slug();
  await db.pool.query(`UPDATE api_keys SET active = FALSE, revoked_at = now() WHERE id = $1 AND slug = $2`, [Number(id), slug]);
  return { ok: true };
}

async function api_waCampaign_logs(token, payload) {
  await _me(token); await _ensureTenantTables();
  const limit = Math.min(500, Math.max(1, Number((payload && payload.limit) || 100)));
  const r = await db.query(`SELECT l.id, l.campaign_id, c.name AS campaign_name, l.destination, l.user_name, l.status, l.wa_message_id, l.error_code, l.error_detail, l.lead_id, l.created_at
    FROM wa_campaign_logs l LEFT JOIN wa_api_campaigns c ON c.id = l.campaign_id ORDER BY l.id DESC LIMIT $1`, [limit]);
  return { logs: r.rows };
}

async function api_waCampaign_test(token, payload) {
  const me = await _me(token); await _ensureTenantTables();
  payload = payload || {};
  if (!payload.campaignId) throw new Error('campaignId is required');
  if (!payload.destination) throw new Error('destination is required');
  const body = {
    destination: String(payload.destination),
    userName: String(payload.userName || 'Test'),
    templateParams: Array.isArray(payload.templateParams) ? payload.templateParams : [],
    media: (payload.media && payload.media.url) ? payload.media : null,
    source: payload.source || 'API Campaign Test'
  };
  const out = await _processSend(null, body, { campaignId: Number(payload.campaignId), allowNonLive: true, testUserId: (me && me.id) || null });
  return out.json;
}

module.exports = {
  // public
  expressApiSend,
  // admin (dispatcher)
  api_waCampaign_templates,
  api_waCampaign_list,
  api_waCampaign_save,
  api_waCampaign_setStatus,
  api_waCampaign_delete,
  api_waCampaign_keys_list,
  api_waCampaign_keys_create,
  api_waCampaign_keys_revoke,
  api_waCampaign_logs,
  api_waCampaign_test
};
