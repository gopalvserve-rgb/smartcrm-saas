/**
 * routes/aiBot.js
 *
 * Per-tenant WhatsApp AI Bot. Loaded by tenantApi.js (so every api_*
 * function below is auto-exposed at POST /t/<slug>/api).
 *
 * Public surface:
 *   - api_aibot_settings_get / save
 *   - api_aibot_kb_list / save_text / delete / toggle / crawl_url / save_uploaded
 *   - api_aibot_chatlog_list
 *   - api_aibot_usage_summary           — tenant view (INR with markup baked in)
 *   - api_aibot_estimator               — what would N customer messages cost?
 *
 * Internal (called from whatsbot._handleInbound):
 *   - maybeReplyToInbound(m, value, leadId, dbInsertedRowId, tenantSlug)
 *
 * The bot decides whether to reply based on ai_bot_settings.is_enabled +
 * reply_modes + business hours + recent agent activity. It builds a
 * prompt = system + KB + history + new msg, calls gemini, then either
 * sends the reply (modes: always/keyword/after_hours/phone_only) OR
 * stores a draft (mode: manual) for the agent to send.
 */

'use strict';

const db = require('../db/pg');
const control = require('../control/db');
const { authUser } = require('../utils/auth');
const gemini = require('../utils/geminiClient');

// Pulled lazily inside maybeReplyToInbound so we don't create a circular
// require — whatsbot.js already requires this module.
let _whatsbot = null;
function _wb() { if (!_whatsbot) _whatsbot = require('./whatsbot'); return _whatsbot; }

// ============================================================
// Settings
// ============================================================

const _DEFAULT_SETTINGS = {
  id: 1,
  is_enabled: 0,
  bot_name: 'Assistant',
  business_name: '',
  language: 'en',
  system_prompt: '',
  welcome_message: '',
  reply_modes: ['always'],
  business_hours: { tz: 'Asia/Kolkata', days: [1,2,3,4,5], start: '09:00', end: '19:00' },
  trigger_keywords: '',
  off_keywords: '',
  active_phone_number_ids: [],
  resume_after_idle_minutes: 1440,
  max_replies_per_thread: 0,
  escalation_keywords: '',
  model_override: null,
  use_kb: 1,
  kb_max_chars: 60000,
  history_messages: 8,
};

function _coerceSettings(row) {
  if (!row) return { ..._DEFAULT_SETTINGS };
  const out = { ..._DEFAULT_SETTINGS };
  Object.keys(out).forEach(k => { if (row[k] !== undefined && row[k] !== null) out[k] = row[k]; });
  // JSONB coercions — pg returns these as objects, but if a row was
  // saved by a path that stringified them, parse defensively.
  for (const key of ['reply_modes', 'business_hours', 'active_phone_number_ids']) {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch (_) { out[key] = _DEFAULT_SETTINGS[key]; }
    }
  }
  out.is_enabled = Number(out.is_enabled || 0);
  out.use_kb     = Number(out.use_kb || 0);
  return out;
}

async function api_aibot_settings_get(token) {
  const me = await authUser(token);
  let row;
  try {
    const r = await db.query(`SELECT * FROM ai_bot_settings WHERE id = 1`);
    row = r.rows[0];
  } catch (_) { row = null; }

  // Pull global activation status (super-admin can globally disable)
  let global = { is_active: false, default_model: 'gemini-2.0-flash-lite' };
  try {
    const g = await control.query(`SELECT is_active, gemini_default_model FROM ai_settings WHERE id = 1`);
    if (g.rows[0]) {
      global.is_active = Number(g.rows[0].is_active) === 1;
      global.default_model = g.rows[0].gemini_default_model;
    }
  } catch (_) {}

  return {
    settings: _coerceSettings(row),
    is_admin: me.role === 'admin' || me.role === 'manager',
    global,
    available_modes: [
      { id: 'always',      label: 'Always reply' },
      { id: 'after_hours', label: 'After business hours only' },
      { id: 'keyword',     label: 'Only when keyword matches' },
      { id: 'manual',      label: 'Draft replies for agent approval' },
      { id: 'phone_only',  label: 'Only on selected phone numbers' },
    ]
  };
}

async function api_aibot_settings_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};
  // Coerce reply_modes / business_hours / active_phone_number_ids to JSON.
  const reply_modes = Array.isArray(p.reply_modes) ? p.reply_modes.map(String) : ['always'];
  const business_hours = (p.business_hours && typeof p.business_hours === 'object') ? p.business_hours : _DEFAULT_SETTINGS.business_hours;
  const phones = Array.isArray(p.active_phone_number_ids) ? p.active_phone_number_ids.map(String) : [];

  await db.query(
    `INSERT INTO ai_bot_settings
       (id, is_enabled, bot_name, business_name, language, system_prompt, welcome_message,
        reply_modes, business_hours, trigger_keywords, off_keywords, active_phone_number_ids,
        resume_after_idle_minutes, max_replies_per_thread, escalation_keywords,
        model_override, use_kb, kb_max_chars, history_messages, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb,
             $12, $13, $14, $15, $16, $17, $18, NOW())
     ON CONFLICT (id) DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       bot_name = EXCLUDED.bot_name, business_name = EXCLUDED.business_name,
       language = EXCLUDED.language, system_prompt = EXCLUDED.system_prompt,
       welcome_message = EXCLUDED.welcome_message,
       reply_modes = EXCLUDED.reply_modes, business_hours = EXCLUDED.business_hours,
       trigger_keywords = EXCLUDED.trigger_keywords, off_keywords = EXCLUDED.off_keywords,
       active_phone_number_ids = EXCLUDED.active_phone_number_ids,
       resume_after_idle_minutes = EXCLUDED.resume_after_idle_minutes,
       max_replies_per_thread = EXCLUDED.max_replies_per_thread,
       escalation_keywords = EXCLUDED.escalation_keywords,
       model_override = EXCLUDED.model_override,
       use_kb = EXCLUDED.use_kb, kb_max_chars = EXCLUDED.kb_max_chars,
       history_messages = EXCLUDED.history_messages,
       updated_at = NOW()`,
    [
      p.is_enabled ? 1 : 0,
      String(p.bot_name || 'Assistant').slice(0, 80),
      String(p.business_name || '').slice(0, 200),
      String(p.language || 'en'),
      String(p.system_prompt || '').slice(0, 8000),
      String(p.welcome_message || '').slice(0, 2000),
      JSON.stringify(reply_modes),
      JSON.stringify(business_hours),
      String(p.trigger_keywords || '').slice(0, 1000),
      String(p.off_keywords || '').slice(0, 1000),
      JSON.stringify(phones),
      Math.max(0, Number(p.resume_after_idle_minutes || 1440)),
      Math.max(0, Number(p.max_replies_per_thread || 0)),
      String(p.escalation_keywords || '').slice(0, 1000),
      p.model_override ? String(p.model_override).slice(0, 80) : null,
      p.use_kb ? 1 : 0,
      Math.max(2000, Math.min(120000, Number(p.kb_max_chars || 60000))),
      Math.max(0, Math.min(40, Number(p.history_messages || 8))),
    ]
  );
  return await api_aibot_settings_get(token);
}

// ============================================================
// Knowledge base
// ============================================================

async function api_aibot_kb_list(token) {
  await authUser(token);
  const r = await db.query(
    `SELECT id, source_type, title, char_count, source_url, file_path, file_size,
            is_active, ingest_status, ingest_error, created_at, updated_at
       FROM ai_kb_documents
       ORDER BY is_active DESC, created_at DESC`
  );
  // Aggregate stats so the UI can warn about KB-too-big.
  const totalChars = r.rows.reduce((a, x) => a + (Number(x.char_count) || 0) * (Number(x.is_active) === 1 ? 1 : 0), 0);
  return { docs: r.rows, total_active_chars: totalChars };
}

async function api_aibot_kb_save_text(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};
  const id = Number(p.id || 0);
  const title = String(p.title || 'Untitled').slice(0, 200);
  const text  = String(p.raw_text || '');
  if (!text.trim()) throw new Error('Text is empty');
  if (text.length > 200000) throw new Error('Text too large (max 200k chars per doc)');

  if (id) {
    await db.query(
      `UPDATE ai_kb_documents
          SET title = $1, raw_text = $2, ingest_status = 'ready', ingest_error = NULL, updated_at = NOW()
        WHERE id = $3 AND source_type = 'text'`,
      [title, text, id]
    );
    return { ok: true, id };
  }
  const r = await db.query(
    `INSERT INTO ai_kb_documents (source_type, title, raw_text, is_active, ingest_status, created_by)
     VALUES ('text', $1, $2, 1, 'ready', $3) RETURNING id`,
    [title, text, me.id]
  );
  return { ok: true, id: r.rows[0].id };
}

async function api_aibot_kb_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await db.query(`DELETE FROM ai_kb_documents WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_aibot_kb_toggle(token, id, isActive) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await db.query(`UPDATE ai_kb_documents SET is_active = $1, updated_at = NOW() WHERE id = $2`, [isActive ? 1 : 0, Number(id)]);
  return { ok: true };
}

/**
 * Crawl a URL, extract main text, save as a KB doc.
 * Lightweight Readability — strip <script>/<style>, replace tags with
 * spaces, collapse whitespace. Good enough for a typical "About us /
 * Services / FAQ" page; brittle on JS-heavy SPAs (we'd need a headless
 * browser for those, out of scope).
 */
async function api_aibot_kb_crawl_url(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};
  const url = String(p.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http:// or https://');
  let resp, html;
  try {
    resp = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'SmartCRM-AIBot/1.0' }, redirect: 'follow' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    html = await resp.text();
  } catch (e) {
    throw new Error('Could not fetch URL: ' + e.message);
  }
  if (html.length > 5_000_000) html = html.slice(0, 5_000_000);
  const text = _htmlToText(html).slice(0, 200000);
  if (!text.trim()) throw new Error('Page returned no extractable text');
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch ? titleMatch[1].trim() : new URL(url).hostname).slice(0, 200);

  const r = await db.query(
    `INSERT INTO ai_kb_documents (source_type, title, raw_text, source_url, is_active, ingest_status, created_by)
     VALUES ('url', $1, $2, $3, 1, 'ready', $4) RETURNING id, char_count`,
    [title, text, url, me.id]
  );
  return { ok: true, id: r.rows[0].id, char_count: r.rows[0].char_count };
}

function _htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/?(?:p|br|div|li|tr|h[1-6])[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * Internal — called from server.tenant.js's /api/aibot/upload route AFTER
 * pdf-parse / mammoth has produced raw_text. We don't expose this on the
 * api_* dispatcher because file uploads need multipart, not JSON.
 */
async function _saveKBFromUpload({ user, title, sourceType, rawText, filePath, fileSize }) {
  if (!rawText || !rawText.trim()) throw new Error('Could not extract any text from the file');
  const r = await db.query(
    `INSERT INTO ai_kb_documents (source_type, title, raw_text, file_path, file_size, is_active, ingest_status, created_by)
     VALUES ($1, $2, $3, $4, $5, 1, 'ready', $6) RETURNING id, char_count`,
    [sourceType, String(title).slice(0, 200), rawText, filePath || null, fileSize || null, user?.id || null]
  );
  return r.rows[0];
}

// ============================================================
// Activity log + usage
// ============================================================

async function api_aibot_chatlog_list(token, opts) {
  await authUser(token);
  const o = opts || {};
  const limit = Math.max(1, Math.min(200, Number(o.limit || 50)));
  const r = await db.query(
    `SELECT l.id, l.phone, l.lead_id, l.draft_text, l.reply_text, l.model, l.mode_used,
            l.input_tokens, l.output_tokens, l.cost_inr_billed, l.status,
            l.suppressed_reason, l.error_text, l.phone_number_id, l.created_at,
            ld.name AS lead_name
       FROM ai_chat_log l
       LEFT JOIN leads ld ON ld.id = l.lead_id
       ORDER BY l.created_at DESC
       LIMIT $1`,
    [limit]
  );
  return r.rows;
}

async function api_aibot_usage_summary(token, _opts) {
  await authUser(token);
  // Tenant view = pull from ai_chat_log on this DB (which mirrors what
  // was billed to them). Real $ cost lives only on control DB; we never
  // surface it to tenants.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const monthRes = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int     AS sent,
            COUNT(*) FILTER (WHERE status = 'draft')::int    AS drafts,
            COUNT(*) FILTER (WHERE status = 'suppressed')::int AS suppressed,
            COUNT(*) FILTER (WHERE status = 'failed')::int   AS failed,
            COALESCE(SUM(input_tokens), 0)::int              AS input_tokens,
            COALESCE(SUM(output_tokens), 0)::int             AS output_tokens,
            COALESCE(SUM(cost_inr_billed), 0)                AS cost_inr_billed
       FROM ai_chat_log WHERE created_at >= $1`,
    [monthStart]
  );
  const m = monthRes.rows[0] || {};
  const allRes = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int  AS sent,
            COALESCE(SUM(cost_inr_billed), 0)              AS cost_inr_billed
       FROM ai_chat_log`
  );
  const a = allRes.rows[0] || {};

  // Forecast: cost so far in the month / day-of-month × days-in-month
  const day = now.getUTCDate();
  const dim = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const forecast = (Number(m.cost_inr_billed || 0) / Math.max(1, day)) * dim;

  return {
    month_label: now.toLocaleString('en', { month: 'long', year: 'numeric' }),
    this_month: {
      sent: Number(m.sent || 0),
      drafts: Number(m.drafts || 0),
      suppressed: Number(m.suppressed || 0),
      failed: Number(m.failed || 0),
      input_tokens: Number(m.input_tokens || 0),
      output_tokens: Number(m.output_tokens || 0),
      cost_inr: Number(Number(m.cost_inr_billed || 0).toFixed(2)),
    },
    all_time: {
      sent: Number(a.sent || 0),
      cost_inr: Number(Number(a.cost_inr_billed || 0).toFixed(2)),
    },
    forecast_inr: Number(forecast.toFixed(2)),
  };
}

/**
 * Cost estimator — tenant-facing. Anchors the per-reply ₹ cost on the
 * tenant's actual recent average; falls back to a defensive default.
 */
async function api_aibot_estimator(token, opts) {
  await authUser(token);
  const o = opts || {};
  const replies = Math.max(1, Number(o.replies || 500));
  const r = await db.query(
    `SELECT COUNT(*)::int AS sent_30d,
            COALESCE(SUM(cost_inr_billed), 0) AS inr_30d
       FROM ai_chat_log
      WHERE status = 'sent' AND created_at >= NOW() - INTERVAL '30 days'`
  );
  const sent = Number(r.rows[0]?.sent_30d || 0);
  const inr  = Number(r.rows[0]?.inr_30d || 0);
  const perReplyInr = sent > 5 ? (inr / sent) : 0.05;  // sane default ~₹0.05/reply
  return {
    replies,
    per_reply_inr: Number(perReplyInr.toFixed(4)),
    total_inr:     Number((perReplyInr * replies).toFixed(2)),
    derived_from:  sent > 5
      ? ('Anchored on last 30 days: ' + sent + ' replies @ ₹' + perReplyInr.toFixed(3) + '/reply')
      : 'Using default rate ₹0.05/reply — not enough usage history yet'
  };
}

// ============================================================
// Inbound reply path  (called from whatsbot._handleInbound)
// ============================================================

async function _shouldSuppress(settings, phone, inboundText, inboundPhoneId, tenantSlug) {
  // Master switch
  if (Number(settings.is_enabled) !== 1) return 'bot disabled';

  // Customer typed an OFF keyword → silence forever for this thread (until agent revives)
  const offWords = String(settings.off_keywords || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (offWords.length) {
    const t = String(inboundText || '').toLowerCase();
    if (offWords.some(w => t.includes(w))) return 'off_keyword matched';
  }

  // phone_only mode
  const modes = Array.isArray(settings.reply_modes) ? settings.reply_modes : ['always'];
  if (modes.includes('phone_only')) {
    const allowed = (settings.active_phone_number_ids || []).map(String);
    if (allowed.length && inboundPhoneId && !allowed.includes(String(inboundPhoneId))) {
      return 'phone not in active list';
    }
  }

  // keyword mode
  if (modes.includes('keyword') && !modes.includes('always')) {
    const kws = String(settings.trigger_keywords || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    const t = String(inboundText || '').toLowerCase();
    if (kws.length === 0 || !kws.some(k => t.includes(k))) return 'no trigger keyword';
  }

  // after_hours mode
  if (modes.includes('after_hours') && !modes.includes('always')) {
    if (!_isAfterHours(settings.business_hours)) return 'inside business hours';
  }

  // Has a real (non-bot) agent replied to this thread recently?
  // ai_chat_log tracks bot replies separately, so we look for a row in
  // whatsapp_messages from a real user_id within the resume window.
  const idleMin = Math.max(0, Number(settings.resume_after_idle_minutes || 1440));
  if (idleMin > 0) {
    const r = await db.query(
      `SELECT 1 FROM whatsapp_messages
        WHERE direction = 'out' AND user_id IS NOT NULL
          AND (to_number = $1 OR from_number = $1)
          AND created_at > NOW() - ($2 || ' minutes')::interval
        LIMIT 1`,
      [phone, String(idleMin)]
    );
    if (r.rows.length) return 'human agent recently active';
  }

  // max_replies_per_thread cap (0 = unlimited)
  const cap = Number(settings.max_replies_per_thread || 0);
  if (cap > 0) {
    const r = await db.query(
      `SELECT COUNT(*)::int AS c FROM ai_chat_log WHERE phone = $1 AND status IN ('sent', 'draft')`,
      [phone]
    );
    if (Number(r.rows[0]?.c || 0) >= cap) return 'max replies per thread reached';
  }

  return null;
}

function _isAfterHours(bh) {
  if (!bh || typeof bh !== 'object') return false;
  try {
    const tz = bh.tz || 'Asia/Kolkata';
    const now = new Date();
    // Get the day-of-week + HH:MM in the configured timezone.
    const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    const parts = fmt.formatToParts(now).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dow = dayMap[parts.weekday];
    const hhmm = (parts.hour || '00') + ':' + (parts.minute || '00');
    const days = Array.isArray(bh.days) ? bh.days.map(Number) : [1,2,3,4,5];
    if (!days.includes(dow)) return true;        // weekend → after hours
    if (bh.start && hhmm < String(bh.start)) return true;
    if (bh.end   && hhmm >= String(bh.end))  return true;
    return false;
  } catch (_) { return false; }
}

async function _buildPrompt(settings, phone, leadId, inboundText) {
  const persona = String(settings.system_prompt || '').trim()
    || (`You are ${settings.bot_name || 'an assistant'} for ${settings.business_name || 'this business'}. ` +
        `Answer customer questions on WhatsApp, briefly and helpfully. ` +
        `Use ONLY the knowledge base below. If you don't know, say so politely and offer to connect with a human. ` +
        `Reply in the customer's language. Keep responses under 60 words unless they explicitly ask for detail.`);

  // KB
  let kb = '';
  if (Number(settings.use_kb) === 1) {
    const cap = Math.max(2000, Number(settings.kb_max_chars || 60000));
    const r = await db.query(
      `SELECT title, raw_text FROM ai_kb_documents WHERE is_active = 1 ORDER BY id ASC`
    );
    let buf = '';
    for (const d of r.rows) {
      const block = `\n\n## ${d.title}\n${d.raw_text}`;
      if (buf.length + block.length > cap) {
        buf += block.slice(0, cap - buf.length);
        break;
      }
      buf += block;
    }
    if (buf.trim()) kb = '\n\n=== KNOWLEDGE BASE ===' + buf + '\n=== END KNOWLEDGE BASE ===';
  }

  const system = persona + kb;

  // History: last N inbound + outbound messages (chronological).
  const hCount = Math.max(0, Number(settings.history_messages || 8));
  const history = [];
  if (hCount > 0) {
    const r = await db.query(
      `SELECT direction, body, message_type FROM whatsapp_messages
        WHERE (from_number = $1 OR to_number = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [phone, hCount]
    );
    r.rows.reverse().forEach(m => {
      const text = m.body || ('[' + (m.message_type || 'media') + ']');
      history.push({ role: m.direction === 'in' ? 'user' : 'model', text });
    });
  }
  return { system, history, prompt: String(inboundText || '') };
}

/**
 * Main entry called from whatsbot._handleInbound. NEVER throws — every
 * failure is logged into ai_chat_log so the tenant can see what happened
 * without breaking the inbound webhook flow.
 */
async function maybeReplyToInbound({ phone, leadId, inboundText, inboundPhoneId, inboundMsgId, tenantSlug, tenantId }) {
  let settings;
  try {
    const s = await db.query(`SELECT * FROM ai_bot_settings WHERE id = 1`);
    settings = _coerceSettings(s.rows[0]);
  } catch (_) { return; }   // table missing → tenant not migrated yet
  if (Number(settings.is_enabled) !== 1) return;
  if (!inboundText || !String(inboundText).trim()) return;  // skip media-only inbound

  const suppressReason = await _shouldSuppress(settings, phone, inboundText, inboundPhoneId, tenantSlug);
  if (suppressReason) {
    try {
      await db.query(
        `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, status, suppressed_reason, mode_used, phone_number_id)
         VALUES ($1, $2, $3, 'suppressed', $4, $5, $6)`,
        [phone, leadId || null, inboundMsgId || null, suppressReason.slice(0, 200),
         (settings.reply_modes || []).join('+') || 'always', inboundPhoneId || null]
      );
    } catch (_) {}
    return;
  }

  const modes = Array.isArray(settings.reply_modes) ? settings.reply_modes : ['always'];
  const isManual = modes.includes('manual') && !modes.includes('always');

  const { system, history, prompt } = await _buildPrompt(settings, phone, leadId, inboundText);

  const result = await gemini.generate({
    system, history, prompt,
    model: settings.model_override || null,
    maxOutputTokens: 500
  });

  // Log to control DB regardless of success
  try {
    await gemini.logUsage({
      tenant_slug: tenantSlug, tenant_id: tenantId,
      call_kind: 'reply', phone, lead_id: leadId,
      result
    });
  } catch (_) {}

  if (!result.ok) {
    try {
      await db.query(
        `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, status, error_text, mode_used, model, phone_number_id)
         VALUES ($1, $2, $3, 'failed', $4, $5, $6, $7)`,
        [phone, leadId || null, inboundMsgId || null,
         (result.error || 'unknown error').slice(0, 500),
         modes.join('+'), result.model || '', inboundPhoneId || null]
      );
    } catch (_) {}
    return;
  }

  const replyText = (result.text || '').trim();
  if (!replyText) {
    try {
      await db.query(
        `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, status, error_text, mode_used, model, phone_number_id, input_tokens, output_tokens, cost_inr_billed)
         VALUES ($1, $2, $3, 'failed', 'empty response', $4, $5, $6, $7, $8, $9)`,
        [phone, leadId || null, inboundMsgId || null, modes.join('+'), result.model, inboundPhoneId || null,
         result.input_tokens, result.output_tokens, result.cost_inr_billed]
      );
    } catch (_) {}
    return;
  }

  // Manual mode → store as DRAFT; agent will Send/Edit from the chat thread.
  if (isManual) {
    try {
      await db.query(
        `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, draft_text, model, mode_used, status, input_tokens, output_tokens, cost_inr_billed, phone_number_id)
         VALUES ($1, $2, $3, $4, $5, 'manual', 'draft', $6, $7, $8, $9)`,
        [phone, leadId || null, inboundMsgId || null, replyText, result.model,
         result.input_tokens, result.output_tokens, result.cost_inr_billed, inboundPhoneId || null]
      );
    } catch (_) {}
    return;
  }

  // Send via WhatsApp
  try {
    const wb = _wb();
    const cfg = inboundPhoneId ? await wb._cfgForPhone(inboundPhoneId).catch(() => wb._cfg()) : await wb._cfg();
    const send = await wb._sendText({ to: phone, text: replyText, leadId: leadId || null, userId: null }, cfg);
    const outboundId = send.wa_message_id || null;
    await db.query(
      `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, reply_text, model, mode_used, status, input_tokens, output_tokens, cost_inr_billed, phone_number_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7, $8, $9, $10)`,
      [phone, leadId || null, inboundMsgId || null, replyText, result.model, modes.join('+'),
       result.input_tokens, result.output_tokens, result.cost_inr_billed, inboundPhoneId || null]
    );
  } catch (e) {
    try {
      await db.query(
        `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, reply_text, model, mode_used, status, error_text, input_tokens, output_tokens, cost_inr_billed, phone_number_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'failed', $7, $8, $9, $10, $11)`,
        [phone, leadId || null, inboundMsgId || null, replyText, result.model, modes.join('+'),
         e.message.slice(0, 500), result.input_tokens, result.output_tokens, result.cost_inr_billed, inboundPhoneId || null]
      );
    } catch (_) {}
  }
}

/**
 * Send a draft reply that was queued in manual mode. Used by the chat UI
 * "Send AI draft" button.
 */
async function api_aibot_send_draft(token, draftId) {
  const me = await authUser(token);
  const r = await db.query(`SELECT * FROM ai_chat_log WHERE id = $1`, [Number(draftId)]);
  const row = r.rows[0];
  if (!row) throw new Error('Draft not found');
  if (row.status !== 'draft') throw new Error('Not a draft');
  const wb = _wb();
  const cfg = row.phone_number_id ? await wb._cfgForPhone(row.phone_number_id).catch(() => wb._cfg()) : await wb._cfg();
  const send = await wb._sendText({ to: row.phone, text: row.draft_text, leadId: row.lead_id, userId: me.id }, cfg);
  await db.query(
    `UPDATE ai_chat_log SET status = 'sent', reply_text = draft_text, draft_text = NULL WHERE id = $1`,
    [row.id]
  );
  return { ok: true, wa_message_id: send.wa_message_id || null };
}

async function api_aibot_discard_draft(token, draftId) {
  await authUser(token);
  const r = await db.query(`UPDATE ai_chat_log SET status = 'suppressed', suppressed_reason = 'agent discarded draft' WHERE id = $1 AND status = 'draft'`, [Number(draftId)]);
  return { ok: true, updated: r.rowCount };
}

module.exports = {
  // Public tenant API (auto-exposed via tenantApi.js loader)
  api_aibot_settings_get, api_aibot_settings_save,
  api_aibot_kb_list, api_aibot_kb_save_text, api_aibot_kb_delete, api_aibot_kb_toggle, api_aibot_kb_crawl_url,
  api_aibot_chatlog_list, api_aibot_usage_summary, api_aibot_estimator,
  api_aibot_send_draft, api_aibot_discard_draft,
  // Internal — called from whatsbot.js + server.tenant.js upload route
  maybeReplyToInbound,
  _saveKBFromUpload,
};
