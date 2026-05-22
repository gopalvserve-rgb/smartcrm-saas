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
  resume_after_idle_seconds: 86400,
  max_replies_per_thread: 0,
  escalation_keywords: '',
  model_override: null,
  use_kb: 1,
  kb_max_chars: 4000,  // COST_REDUCE_v1: was 8000. Most KBs answer well within 4000 chars; admin can raise per-bot.
  history_messages: 8,
  reengage_enabled: 0,
  reengage_after_minutes: 60,
  reengage_message: 'Hi {{name}}, just checking — did you get a chance to look at our last message? Happy to help if you have any questions.',
  reengage_max_attempts: 1,
  heat_enabled: 1,
  pause_after_human_handoff: 0,
  heat_keywords: [],
  heat_notify_levels: 'hot,very_hot,on_fire',
  heat_notify_recipients: 'assigned,admins',
  quick_reply_buttons: [],
  quick_reply_trigger: 'always',
  quick_reply_keywords: '',
  quick_reply_filter_tapped: 1,
  quick_reply_mode: 'static',
  quick_reply_pool: '',
};

function _coerceSettings(row) {
  if (!row) return { ..._DEFAULT_SETTINGS };
  const out = { ..._DEFAULT_SETTINGS };
  Object.keys(out).forEach(k => { if (row[k] !== undefined && row[k] !== null) out[k] = row[k]; });
  // JSONB coercions — pg returns these as objects, but if a row was
  // saved by a path that stringified them, parse defensively.
  for (const key of ['reply_modes', 'business_hours', 'active_phone_number_ids', 'heat_keywords', 'quick_reply_buttons']) {
    if (typeof out[key] === 'string') {
      try { out[key] = JSON.parse(out[key]); } catch (_) { out[key] = _DEFAULT_SETTINGS[key]; }
    }
  }
  out.is_enabled = Number(out.is_enabled || 0);
  out.use_kb     = Number(out.use_kb || 0);
  return out;
}

async function api_aibot_settings_get(token, phoneNumberId) {
  const me = await authUser(token);
  await _ensureAiBotColumns();
  const phId = phoneNumberId ? String(phoneNumberId) : null;
  let row;
  try {
    if (phId) {
      const r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id = $1 LIMIT 1`, [phId]);
      row = r.rows[0];
      if (!row) {
        const d = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`);
        row = d.rows[0];
        if (row) row.phone_number_id = phId;
      }
    } else {
      const r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`);
      row = r.rows[0];
      if (!row) {
        const r2 = await db.query(`SELECT * FROM ai_bot_settings WHERE id = 1`);
        row = r2.rows[0];
      }
    }
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

  const coerced = _coerceSettings(row);
  if (row) {
    coerced.phone_number_id      = row.phone_number_id || null;
    coerced.bot_label            = row.bot_label || '';
    let addl = row.additional_phone_ids;
    if (typeof addl === 'string') { try { addl = JSON.parse(addl); } catch (_) { addl = []; } }
    coerced.additional_phone_ids = Array.isArray(addl) ? addl.map(String) : [];
  }
  return {
    settings: coerced,
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

const _aiBotEnsuredPools = new WeakSet();
async function _ensureAiBotColumns() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _aiBotEnsuredPools.has(pool)) return;
  try {
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS resume_after_idle_seconds INTEGER NOT NULL DEFAULT 86400`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS active_phone_number_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await db.query(`UPDATE ai_bot_settings SET resume_after_idle_seconds = COALESCE(resume_after_idle_minutes, 1440) * 60 WHERE resume_after_idle_seconds = 86400 AND resume_after_idle_minutes IS NOT NULL`);
    // Per-number bot configs: a row per phone gets its own training; the
    // legacy id=1 row keeps phone_number_id IS NULL and acts as the
    // fallback for any phone without a specific config.
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS phone_number_id TEXT`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_bot_settings_phone ON ai_bot_settings(phone_number_id) WHERE phone_number_id IS NOT NULL`);
    // KB scope: each doc can be GLOBAL (NULL = used by every bot, the
    // safe default) or scoped to a specific phone_number_id (used only
    // when that phone's bot replies). Lets a tenant with two
    // businesses keep their KBs separate per number.
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS phone_number_id TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_kb_documents_phone ON ai_kb_documents(phone_number_id)`);
    // Multi-phone KB scope (May 2026): a single KB doc can be assigned to N phones at once.
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS additional_phone_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    // Bot-centric UX (May 2026): each ai_bot_settings row is a 'Bot' with
    // a friendly label + array of additional phones it serves besides its primary.
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS bot_label TEXT`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS additional_phone_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    // The legacy schema has CONSTRAINT ai_bot_settings_singleton CHECK (id = 1)
    // which forbids per-phone rows. Drop it so multi-bot tenants work.
    try { await db.query(`ALTER TABLE ai_bot_settings DROP CONSTRAINT IF EXISTS ai_bot_settings_singleton`); } catch (_) {}
    try { await db.query(`ALTER TABLE ai_bot_settings ALTER COLUMN id DROP DEFAULT`); } catch (_) {}
    // Auto re-engagement (May 2026): bot can send a soft check-in if customer goes silent
    // for N minutes after the bot's last reply. Configured per bot.
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS reengage_enabled INTEGER NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS reengage_after_minutes INTEGER NOT NULL DEFAULT 60`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS reengage_message TEXT NOT NULL DEFAULT 'Hi {{name}}, just checking — did you get a chance to look at our last message? Happy to help if you have any questions.'`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS reengage_max_attempts INTEGER NOT NULL DEFAULT 1`);
    // Tenant-configurable heat detection (May 2026): client can add their own
    // high-intent keywords + choose which heat levels fire a notification.
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS heat_keywords JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS heat_notify_levels TEXT NOT NULL DEFAULT 'hot,very_hot,on_fire'`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS heat_notify_recipients TEXT NOT NULL DEFAULT 'assigned,admins'`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS heat_enabled INTEGER NOT NULL DEFAULT 1`);
    // Human handoff sticky-mute (May 2026): when 1, once any human agent
    // replies in the thread, the bot stays muted on that thread indefinitely
    // (NOT just for resume_after_idle_seconds). Default OFF so existing
    // tenants keep the previous auto-resume behaviour.
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS pause_after_human_handoff INTEGER NOT NULL DEFAULT 0`);
    // Quick-reply buttons (May 2026): array of up to 3 {id, title} objects.
    // quick_reply_trigger controls WHEN the buttons attach to outgoing replies:
    //   'always'      — every bot reply (default)
    //   'first_only'  — only the bot's first reply in a thread (no prior outbound)
    //   'keywords'    — only when the customer's last inbound matches quick_reply_keywords
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS quick_reply_buttons JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS quick_reply_trigger TEXT NOT NULL DEFAULT 'always'`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS quick_reply_keywords TEXT NOT NULL DEFAULT ''`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS quick_reply_filter_tapped INTEGER NOT NULL DEFAULT 1`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS quick_reply_mode TEXT NOT NULL DEFAULT 'static'`);
    await db.query(`ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS quick_reply_pool TEXT NOT NULL DEFAULT ''`);
    await db.query(`CREATE TABLE IF NOT EXISTS ai_reengage_log (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      lead_id INTEGER,
      phone_number_id TEXT,
      last_outbound_at TIMESTAMPTZ NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'scheduled',
      sent_message TEXT,
      sent_at TIMESTAMPTZ,
      cancelled_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_reengage_log_due ON ai_reengage_log(status, scheduled_for) WHERE status = 'scheduled'`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ai_reengage_log_phone ON ai_reengage_log(phone)`);
    // KB file attachments (May 2026): brochure, company profile, PPTs etc.
    // Bot sends these via WhatsApp media when the customer's inbound text
    // matches the doc's trigger_keywords (comma-separated).
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`);
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_mime_type TEXT`);
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_name TEXT`);
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER`);
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS is_attachable INTEGER NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS trigger_keywords TEXT`);
    await db.query(`ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0`);
    // Hot-lead heat scoring (May 2026): every WhatsApp inbound is classified
    // for buying-intent signals; high-heat triggers a push notification to
    // the assigned agent + admin and a chip on the lead row.
    try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_score INTEGER`); } catch (_) {}
    try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_label TEXT`); } catch (_) {}
    try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_signal TEXT`); } catch (_) {}
    try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_action_required TEXT`); } catch (_) {}
    try { await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_updated_at TIMESTAMPTZ`); } catch (_) {}
    try { await db.query(`CREATE INDEX IF NOT EXISTS idx_leads_heat_label ON leads(heat_label) WHERE heat_label IS NOT NULL`); } catch (_) {}
    if (pool) _aiBotEnsuredPools.add(pool);
  } catch (e) { /* table missing — _coerceSettings handles defaults */ }
}

async function api_aibot_settings_save(token, payload) {
  const me = await authUser(token);
  await _ensureAiBotColumns();
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};

  // Partial upsert: build SET clause from only the keys the caller passed.
  // Unspecified fields keep their current value (was a full-replace before,
  // which made saving a single field reset everything else \u2014 a footgun
  // that wiped business_name, system_prompt, etc. when callers forgot them).
  const sets = [];
  const vals = [];
  let i = 1;
  function addCol(col, sqlExpr, val) {
    sets.push(col + ' = ' + sqlExpr.replace('$$', '$' + i));
    vals.push(val);
    i++;
  }
  if (p.is_enabled                != null) addCol('is_enabled',                '$$',          p.is_enabled ? 1 : 0);
  if (p.bot_name                  != null) addCol('bot_name',                  '$$',          String(p.bot_name).slice(0, 80));
  if (p.business_name             != null) addCol('business_name',             '$$',          String(p.business_name).slice(0, 200));
  if (p.language                  != null) addCol('language',                  '$$',          String(p.language));
  if (p.system_prompt             != null) addCol('system_prompt',             '$$',          String(p.system_prompt).slice(0, 8000));
  if (p.welcome_message           != null) addCol('welcome_message',           '$$',          String(p.welcome_message).slice(0, 2000));
  if (p.reply_modes               != null) addCol('reply_modes',               '$$::jsonb',   JSON.stringify(Array.isArray(p.reply_modes) ? p.reply_modes.map(String) : ['always']));
  if (p.business_hours            != null) addCol('business_hours',            '$$::jsonb',   JSON.stringify(typeof p.business_hours === 'object' ? p.business_hours : _DEFAULT_SETTINGS.business_hours));
  if (p.trigger_keywords          != null) addCol('trigger_keywords',          '$$',          String(p.trigger_keywords).slice(0, 1000));
  if (p.off_keywords              != null) addCol('off_keywords',              '$$',          String(p.off_keywords).slice(0, 1000));
  if (p.active_phone_number_ids   != null) addCol('active_phone_number_ids',   '$$::jsonb',   JSON.stringify(Array.isArray(p.active_phone_number_ids) ? p.active_phone_number_ids.map(String) : []));
  if (p.resume_after_idle_minutes != null) addCol('resume_after_idle_minutes', '$$',          Math.max(0, Number(p.resume_after_idle_minutes)));
  if (p.resume_after_idle_seconds != null) addCol('resume_after_idle_seconds', '$$',          Math.max(0, Number(p.resume_after_idle_seconds)));
  if (p.max_replies_per_thread    != null) addCol('max_replies_per_thread',    '$$',          Math.max(0, Number(p.max_replies_per_thread)));
  if (p.escalation_keywords       != null) addCol('escalation_keywords',       '$$',          String(p.escalation_keywords).slice(0, 1000));
  if (p.model_override            !== undefined) addCol('model_override',      '$$',          p.model_override ? String(p.model_override).slice(0, 80) : null);
  if (p.use_kb                    != null) addCol('use_kb',                    '$$',          p.use_kb ? 1 : 0);
  if (p.kb_max_chars              != null) addCol('kb_max_chars',              '$$',          Math.max(2000, Math.min(120000, Number(p.kb_max_chars))));
  if (p.history_messages          != null) addCol('history_messages',          '$$',          Math.max(0, Math.min(40, Number(p.history_messages))));
  if (p.reengage_enabled          != null) addCol('reengage_enabled',          '$$',          p.reengage_enabled ? 1 : 0);
  if (p.reengage_after_minutes    != null) addCol('reengage_after_minutes',    '$$',          Math.max(5, Math.min(10080, Number(p.reengage_after_minutes))));
  if (p.reengage_message          != null) addCol('reengage_message',          '$$',          String(p.reengage_message).slice(0, 1000));
  if (p.reengage_max_attempts     != null) addCol('reengage_max_attempts',     '$$',          Math.max(1, Math.min(5, Number(p.reengage_max_attempts))));
  if (p.heat_enabled              != null) addCol('heat_enabled',              '$$',          p.heat_enabled ? 1 : 0);
  if (p.pause_after_human_handoff != null) addCol('pause_after_human_handoff','$$',          p.pause_after_human_handoff ? 1 : 0);
  if (p.heat_keywords             != null) addCol('heat_keywords',             '$$::jsonb',   JSON.stringify(Array.isArray(p.heat_keywords) ? p.heat_keywords : []));
  if (p.heat_notify_levels        != null) addCol('heat_notify_levels',        '$$',          String(p.heat_notify_levels).slice(0, 200));
  if (p.heat_notify_recipients    != null) addCol('heat_notify_recipients',    '$$',          String(p.heat_notify_recipients).slice(0, 500));
  // Quick-reply buttons: array of {id?, title} — max 3, titles <=20 chars
  if (p.quick_reply_buttons       != null) {
    const arr = Array.isArray(p.quick_reply_buttons) ? p.quick_reply_buttons : [];
    const sanitised = arr.slice(0, 3).map((b, idx) => ({
      id:    String((b && (b.id || b.title)) || ('btn_' + (idx + 1))).slice(0, 256),
      title: String((b && b.title) || '').slice(0, 20).trim()
    })).filter(b => b.title);
    addCol('quick_reply_buttons', '$$::jsonb', JSON.stringify(sanitised));
  }
  if (p.quick_reply_trigger       != null) {
    const allowed = ['always', 'first_only', 'keywords'];
    const t = String(p.quick_reply_trigger || 'always').toLowerCase();
    addCol('quick_reply_trigger', '$$', allowed.includes(t) ? t : 'always');
  }
  if (p.quick_reply_keywords      != null) {
    addCol('quick_reply_keywords', '$$', String(p.quick_reply_keywords || '').slice(0, 500));
  }
  if (p.quick_reply_filter_tapped != null) {
    addCol('quick_reply_filter_tapped', '$$', p.quick_reply_filter_tapped ? 1 : 0);
  }
  if (p.quick_reply_mode          != null) {
    const allowed = ['static', 'dynamic'];
    const m = String(p.quick_reply_mode || 'static').toLowerCase();
    addCol('quick_reply_mode', '$$', allowed.includes(m) ? m : 'static');
  }
  if (p.quick_reply_pool          != null) {
    addCol('quick_reply_pool', '$$', String(p.quick_reply_pool || '').slice(0, 2000));
  }

  // Phone-keyed upsert: one bot row per phone_number_id (NULL = legacy default).
  const phId = (p.phone_number_id != null && String(p.phone_number_id).length > 0) ? String(p.phone_number_id) : null;

  if (p.bot_label != null) addCol('bot_label', '$$', String(p.bot_label).slice(0, 120));
  if (p.additional_phone_ids != null) addCol('additional_phone_ids', '$$::jsonb', JSON.stringify(Array.isArray(p.additional_phone_ids) ? p.additional_phone_ids.map(String) : []));

  if (sets.length === 0) return await api_aibot_settings_get(token, phId);

  if (phId) {
    const exists = await db.query(`SELECT id FROM ai_bot_settings WHERE phone_number_id = $1 LIMIT 1`, [phId]);
    if (exists.rows[0]) {
      sets.push('updated_at = NOW()');
      await db.query(`UPDATE ai_bot_settings SET ${sets.join(', ')} WHERE id = $${i}`, [...vals, exists.rows[0].id]);
    } else {
      // Seed a brand-new per-phone row by cloning the default row, then overlay caller's fields.
      const def = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`);
      const seed = def.rows[0] || {};
      const cloneCols = ['is_enabled','bot_name','business_name','language','system_prompt','welcome_message','reply_modes','business_hours','trigger_keywords','off_keywords','active_phone_number_ids','resume_after_idle_minutes','resume_after_idle_seconds','max_replies_per_thread','escalation_keywords','model_override','use_kb','kb_max_chars','history_messages','reengage_enabled','reengage_after_minutes','reengage_message','reengage_max_attempts','heat_enabled','heat_keywords','heat_notify_levels','heat_notify_recipients','pause_after_human_handoff'];
      const insertCols = ['phone_number_id'];
      const insertVals = [phId];
      const _jsonbCols = ['reply_modes','business_hours','active_phone_number_ids','additional_phone_ids','heat_keywords'];
      cloneCols.forEach(c => {
        if (seed[c] !== undefined && seed[c] !== null) {
          insertCols.push(c);
          if (_jsonbCols.includes(c)) {
            insertVals.push(typeof seed[c] === 'string' ? seed[c] : JSON.stringify(seed[c]));
          } else {
            insertVals.push(seed[c]);
          }
        }
      });
      // Schema has id INTEGER PRIMARY KEY DEFAULT 1 — without an explicit id, the
      // INSERT inherits id=1 and collides with the default-fallback row. Compute
      // the next free id explicitly.
      const nextIdR = await db.query(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ai_bot_settings`);
      const nextId = Number(nextIdR.rows[0].next_id);
      insertCols.push('id');
      insertVals.push(nextId);
      const placeholders = insertCols.map((col, idx) => {
        if (_jsonbCols.includes(col) || col === 'additional_phone_ids') return '$' + (idx + 1) + '::jsonb';
        return '$' + (idx + 1);
      });
      await db.query(`INSERT INTO ai_bot_settings (${insertCols.join(', ')}) VALUES (${placeholders.join(', ')})`, insertVals);
      if (sets.length > 0) {
        sets.push('updated_at = NOW()');
        await db.query(`UPDATE ai_bot_settings SET ${sets.join(', ')} WHERE phone_number_id = $${i}`, [...vals, phId]);
      }
    }
  } else {
    // Default-fallback bot: keyed by id = 1 (legacy compatibility).
    await db.query(`INSERT INTO ai_bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    sets.push('updated_at = NOW()');
    await db.query(`UPDATE ai_bot_settings SET ${sets.join(', ')} WHERE id = 1`, vals);
  }
  return await api_aibot_settings_get(token, phId);
}

// List every bot configured on this tenant: default-fallback row PLUS every per-phone bot row.
async function api_aibot_settings_listAll(token) {
  await authUser(token);
  await _ensureAiBotColumns();
  let rows = [];
  try {
    const r = await db.query(`SELECT * FROM ai_bot_settings ORDER BY (phone_number_id IS NULL) DESC, id ASC`);
    rows = r.rows.map(row => {
      const c = _coerceSettings(row);
      c.phone_number_id      = row.phone_number_id || null;
      c.bot_label            = row.bot_label || '';
      c.id                   = row.id;
      let addl = row.additional_phone_ids;
      if (typeof addl === 'string') { try { addl = JSON.parse(addl); } catch (_) { addl = []; } }
      c.additional_phone_ids = Array.isArray(addl) ? addl.map(String) : [];
      return c;
    });
  } catch (_) { rows = []; }
  return { configs: rows };
}

// Delete a per-phone bot row. Default-fallback row cannot be deleted.
async function api_aibot_settings_delete(token, phoneNumberId) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureAiBotColumns();
  const phId = phoneNumberId ? String(phoneNumberId) : null;
  if (!phId) throw new Error('Cannot delete the default-fallback bot');
  const r = await db.query(`DELETE FROM ai_bot_settings WHERE phone_number_id = $1`, [phId]);
  return { ok: true, deleted: r.rowCount };
}

// Bulk-assign KB doc IDs to a bot (or to global if phone_number_id is empty).
async function api_aibot_kb_assign_bulk(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureAiBotColumns();
  const ids = Array.isArray(payload && payload.doc_ids) ? payload.doc_ids.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
  const phId = (payload && payload.phone_number_id) ? String(payload.phone_number_id) : null;
  if (!ids.length) return { ok: true, updated: 0 };
  await db.query(`UPDATE ai_kb_documents SET phone_number_id = $1, updated_at = NOW() WHERE id = ANY($2::int[])`, [phId, ids]);
  return { ok: true, updated: ids.length };
}

// ============================================================
// LEGACY: original full-replace UPSERT, kept here for reference \u2014 do not call.
// (Inlined above as partial upsert; this stub remains to avoid mass-renaming
// callers that imported the symbol if any did.)
// ============================================================
async function _api_aibot_settings_save_LEGACY_FULL_REPLACE(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};
  const reply_modes = Array.isArray(p.reply_modes) ? p.reply_modes.map(String) : ['always'];
  const business_hours = (p.business_hours && typeof p.business_hours === 'object') ? p.business_hours : _DEFAULT_SETTINGS.business_hours;
  const phones = Array.isArray(p.active_phone_number_ids) ? p.active_phone_number_ids.map(String) : [];

  await db.query(
    `INSERT INTO ai_bot_settings
       (id, is_enabled, bot_name, business_name, language, system_prompt, welcome_message,
        reply_modes, business_hours, trigger_keywords, off_keywords, active_phone_number_ids,
        resume_after_idle_minutes, resume_after_idle_seconds, max_replies_per_thread, escalation_keywords,
        model_override, use_kb, kb_max_chars, history_messages, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb,
             $12, $13, $14, $15, $16, $17, $18, $19, NOW())
     ON CONFLICT (id) DO UPDATE SET
       is_enabled = EXCLUDED.is_enabled,
       bot_name = EXCLUDED.bot_name, business_name = EXCLUDED.business_name,
       language = EXCLUDED.language, system_prompt = EXCLUDED.system_prompt,
       welcome_message = EXCLUDED.welcome_message,
       reply_modes = EXCLUDED.reply_modes, business_hours = EXCLUDED.business_hours,
       trigger_keywords = EXCLUDED.trigger_keywords, off_keywords = EXCLUDED.off_keywords,
       active_phone_number_ids = EXCLUDED.active_phone_number_ids,
       resume_after_idle_minutes = EXCLUDED.resume_after_idle_minutes,
       resume_after_idle_seconds = EXCLUDED.resume_after_idle_seconds,
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
      Math.max(0, Number(p.resume_after_idle_seconds || 86400)),
      Math.max(0, Number(p.max_replies_per_thread || 0)),
      String(p.escalation_keywords || '').slice(0, 1000),
      p.model_override ? String(p.model_override).slice(0, 80) : null,
      p.use_kb ? 1 : 0,
      Math.max(2000, Math.min(120000, Number(p.kb_max_chars || 8000))),
      Math.max(0, Math.min(40, Number(p.history_messages || 8))),
    ]
  );
  return await api_aibot_settings_get(token);
}

// ============================================================
// Knowledge base
// ============================================================

async function api_aibot_kb_list(token, phoneNumberId) {
  await authUser(token);
  await _ensureAiBotColumns();
  const phId = phoneNumberId && phoneNumberId !== 'all' ? String(phoneNumberId) : null;
  // Defensive: try the full column set first; if any column is missing on
  // an older tenant DB, fall back to the original pre-attachment set so
  // the LIST keeps working even when the migration hasn't fully landed.
  const FULL_COLS = `id, source_type, title, char_count, source_url, file_path, file_size,
              phone_number_id, is_active, ingest_status, ingest_error, created_at, updated_at,
              file_name, file_mime_type, file_size_bytes, is_attachable, trigger_keywords,
              sent_count, additional_phone_ids`;
  const MIN_COLS = `id, source_type, title, char_count, source_url, file_path, file_size,
              phone_number_id, is_active, ingest_status, ingest_error, created_at, updated_at`;
  async function _runSelect(cols) {
    if (!phId) {
      return await db.query(`SELECT ${cols} FROM ai_kb_documents ORDER BY is_active DESC, created_at DESC`);
    }
    if (phId === '__global__' || phId === 'default') {
      return await db.query(`SELECT ${cols} FROM ai_kb_documents WHERE phone_number_id IS NULL ORDER BY is_active DESC, created_at DESC`);
    }
    return await db.query(`SELECT ${cols} FROM ai_kb_documents WHERE phone_number_id IS NULL OR phone_number_id = $1 ORDER BY is_active DESC, created_at DESC`, [phId]);
  }
  let r;
  try { r = await _runSelect(FULL_COLS); }
  catch (e) {
    console.warn('[ai-bot] kb_list full column SELECT failed (' + e.message + '), retrying with minimal cols');
    r = await _runSelect(MIN_COLS);
  }
  const totalChars = r.rows.reduce((a, x) => a + (Number(x.char_count) || 0) * (Number(x.is_active) === 1 ? 1 : 0), 0);
  return { docs: r.rows, total_active_chars: totalChars };
}

async function api_aibot_kb_save_text(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  const p = payload || {};
  const id = Number(p.id || 0);
  const title = String(p.title || 'Untitled').slice(0, 200);
  // Accept multiple key names for backwards-compat with older client SPAs
  // (Celeste was sending 'text', saas was sending 'raw_text', etc.)
  const text  = String(p.raw_text || p.text || p.body || '');
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

async function api_aibot_kb_set_phone(token, id, phoneNumberId) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureAiBotColumns();
  // Accepts: a single string ('__global__'/'default'/null/phoneId), OR an array of phone IDs.
  // Array model: first element becomes primary phone_number_id, rest go into additional_phone_ids.
  // Empty / 'global' => fully global (NULL primary, [] additional).
  let primary = null;
  let additional = [];
  if (Array.isArray(phoneNumberId)) {
    const arr = phoneNumberId.map(x => String(x || '').trim()).filter(x => x && x !== '__global__' && x !== 'default');
    primary = arr[0] || null;
    additional = arr.slice(1);
  } else {
    const v = phoneNumberId && phoneNumberId !== '__global__' && phoneNumberId !== 'default' ? String(phoneNumberId) : null;
    primary = v;
    additional = [];
  }
  await db.query(
    `UPDATE ai_kb_documents SET phone_number_id = $1, additional_phone_ids = $2::jsonb, updated_at = NOW() WHERE id = $3`,
    [primary, JSON.stringify(additional), Number(id)]
  );
  return { ok: true, primary, additional };
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
  // Many WordPress / nginx / Cloudflare sites block obvious bot UAs with 403.
  // Use a realistic Chrome UA + the headers a normal browser sends. Falls back
  // to a Googlebot UA if the first attempt fails — some sites whitelist Google.
  const _UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const _UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
  const _BASE_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
  };
  async function _crawlOnce(ua) {
    const r = await fetch(url, {
      method: 'GET',
      headers: { ..._BASE_HEADERS, 'User-Agent': ua },
      redirect: 'follow'
    });
    return r;
  }
  let resp, html;
  try {
    resp = await _crawlOnce(_UA_BROWSER);
    if (!resp.ok && (resp.status === 403 || resp.status === 401 || resp.status === 429)) {
      // Some sites whitelist Googlebot — give that a shot.
      resp = await _crawlOnce(_UA_GOOGLEBOT);
    }
    if (!resp.ok) {
      throw new Error('Server returned HTTP ' + resp.status + ' (' + (resp.statusText || 'no reason') + '). The site may be blocking automated fetches; try saving the page text manually instead via Paste plain text.');
    }
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

  // ALWAYS-ON GUARD: if any human agent replied in the last 30 minutes,
  // assume they're still actively handling this thread and silence the
  // bot. This runs regardless of pause_after_human_handoff /
  // resume_after_idle_seconds settings so the bot never steps on a live
  // human conversation. Window is intentionally short — within 30 min of
  // the last agent reply is a strong signal someone's at the keyboard.
  try {
    const r = await db.query(
      `SELECT 1 FROM whatsapp_messages
        WHERE direction = 'out' AND user_id IS NOT NULL
          AND (to_number = $1 OR from_number = $1)
          AND created_at > NOW() - INTERVAL '30 minutes'
        LIMIT 1`,
      [phone]
    );
    if (r.rows.length) return 'human actively chatting (last 30 min)';
  } catch (_) { /* if the table query errors, fall through to other checks */ }

  // Has a real (non-bot) agent replied to this thread recently?
  // ai_chat_log tracks bot replies separately, so we look for a row in
  // whatsapp_messages from a real user_id within the resume window.
  // resume_after_idle_seconds takes precedence when set; falls back to
  // resume_after_idle_minutes \u00d7 60 for backwards compat.
  // Two flavours of human-handoff suppression:
  //  (a) sticky mute — pause_after_human_handoff = 1. Once ANY human agent
  //      has ever replied on this thread, the bot stays muted indefinitely.
  //  (b) idle-resume — within the last resume_after_idle_seconds window.
  // (a) takes precedence so the user can turn the bot fully off when
  //     a human agent picks up a thread.
  if (Number(settings.pause_after_human_handoff) === 1) {
    const r = await db.query(
      `SELECT 1 FROM whatsapp_messages
        WHERE direction = 'out' AND user_id IS NOT NULL
          AND (to_number = $1 OR from_number = $1)
        LIMIT 1`,
      [phone]
    );
    if (r.rows.length) return 'human agent has taken over this thread';
  }
  const idleSec = settings.resume_after_idle_seconds != null && Number(settings.resume_after_idle_seconds) >= 0
    ? Math.max(0, Number(settings.resume_after_idle_seconds))
    : Math.max(0, Number(settings.resume_after_idle_minutes || 1440)) * 60;
  if (idleSec > 0) {
    const r = await db.query(
      `SELECT 1 FROM whatsapp_messages
        WHERE direction = 'out' AND user_id IS NOT NULL
          AND (to_number = $1 OR from_number = $1)
          AND created_at > NOW() - ($2 || ' seconds')::interval
        LIMIT 1`,
      [phone, String(idleSec)]
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
  // Build language hint from the multi-lang setting (e.g. 'en+hi+mr')
  const LANG_NAMES = { en: 'English', hi: 'Hindi', mr: 'Marathi', gu: 'Gujarati', ta: 'Tamil', te: 'Telugu', bn: 'Bengali', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi', ur: 'Urdu', ar: 'Arabic' };
  const langCodes = String(settings.language || 'en+hi').split(/[+,\s]/).map(x => x.trim()).filter(Boolean);
  const langNames = langCodes.map(c => LANG_NAMES[c] || c);
  const langInstr = langNames.length === 1
    ? `Always reply in ${langNames[0]}.`
    : `Detect the customer's language and reply in the SAME language. Acceptable languages: ${langNames.join(', ')}. If the customer writes in a language outside this list, default to ${langNames[0]}.`;

  const persona = String(settings.system_prompt || '').trim()
    || (`You are ${settings.bot_name || 'an assistant'} for ${settings.business_name || 'this business'}. ` +
        `Answer customer questions on WhatsApp, briefly and helpfully. ` +
        `Use ONLY the knowledge base below. If you don't know, say so politely and offer to connect with a human. ` +
        `Keep responses under 60 words unless they explicitly ask for detail.`);
  // Append language instruction at the END so it always wins regardless of
  // what the tenant put in their system_prompt.
  const personaWithLang = persona + '\n\n' + langInstr;

  // KB
  let kb = '';
  if (Number(settings.use_kb) === 1) {
    const cap = Math.max(2000, Number(settings.kb_max_chars || 8000));
    // settings has phone_number_id when this prompt is being built for a
    // per-phone bot config. In that case, include only KB docs that are
    // global (NULL phone) OR scoped to the same phone. For the default
    // (NULL) bot, include only global docs - the per-phone scoped docs
    // belong to other bots.
    const cfgPhId = settings.phone_number_id ? String(settings.phone_number_id) : null;
    const addlPhIds = Array.isArray(settings.additional_phone_ids) ? settings.additional_phone_ids.map(String) : [];
    const allBotPhIds = (cfgPhId ? [cfgPhId] : []).concat(addlPhIds);
    const r = allBotPhIds.length
      ? await db.query(
          `SELECT title, raw_text FROM ai_kb_documents
            WHERE is_active = 1 AND source_type <> 'attachment' AND (
              phone_number_id IS NULL
              OR phone_number_id = ANY($1::text[])
              OR additional_phone_ids ?| $1::text[]
            )
            ORDER BY id ASC`,
          [allBotPhIds]
        )
      : await db.query(
          `SELECT title, raw_text FROM ai_kb_documents
            WHERE is_active = 1 AND phone_number_id IS NULL
              AND source_type <> 'attachment'
            ORDER BY id ASC`
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

  // AIBOT_CONTEXT_v1 — lead snapshot injected into the system prompt.
  // Without this block the bot answered every customer the same way
  // regardless of who they were ("forgets who the lead is"). We fetch a
  // small JSON profile and render it as a delimited section so the model
  // can refer to "the customer's name", "their last status", "what they
  // bought last time" etc. Falls back gracefully when leadId is missing
  // (first-touch with no lead row yet).
  let leadContextBlock = '';
  try {
    if (leadId) {
      const lr = await db.query(
        `SELECT l.id, l.name, l.phone, l.email, l.city, l.source, l.tags,
                l.created_at, l.next_followup_at, l.notes, l.extra_json,
                l.budget_max, l.requirement_type, l.requirement_notes,
                l.heat_score, l.assigned_to,
                s.name AS status_name,
                p.name AS product_name,
                u.name AS owner_name
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
           LEFT JOIN products p ON p.id = l.product_id
           LEFT JOIN users    u ON u.id = l.assigned_to
          WHERE l.id = $1 LIMIT 1`,
        [leadId]
      );
      const lead = lr.rows[0];
      if (lead) {
        const lines = [];
        if (lead.name)         lines.push('Name: ' + lead.name);
        if (lead.status_name)  lines.push('Status: ' + lead.status_name);
        if (lead.source)       lines.push('Source: ' + lead.source);
        if (lead.product_name) lines.push('Product interest: ' + lead.product_name);
        if (lead.city)         lines.push('City: ' + lead.city);
        if (lead.tags)         lines.push('Tags: ' + lead.tags);
        if (lead.owner_name)   lines.push('Sales rep: ' + lead.owner_name);
        if (lead.budget_max)   lines.push('Budget: \u20b9' + lead.budget_max);
        if (lead.requirement_type)  lines.push('Requirement: ' + lead.requirement_type);
        if (lead.requirement_notes) lines.push('Requirement notes: ' + String(lead.requirement_notes).slice(0, 200));
        if (lead.next_followup_at)  lines.push('Next follow-up scheduled: ' + new Date(lead.next_followup_at).toISOString().slice(0, 16).replace('T', ' '));
        // Custom fields from extra_json — surface every primitive value
        if (lead.extra_json) {
          let ej = lead.extra_json;
          if (typeof ej === 'string') { try { ej = JSON.parse(ej); } catch (_) { ej = null; } }
          if (ej && typeof ej === 'object') {
            const cfBits = [];
            Object.keys(ej).forEach(k => {
              if (k[0] === '_') return;
              if (k === 'extra_phones') return;
              const v = ej[k];
              if (v == null || v === '') return;
              if (typeof v === 'object') return;
              const human = k.replace(/[_\-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              cfBits.push(human + ': ' + String(v).slice(0, 160));
            });
            if (cfBits.length) lines.push('Other details \u2014 ' + cfBits.slice(0, 12).join('; '));
          }
        }
        if (Number(lead.heat_score) > 0) lines.push('Heat score: ' + Number(lead.heat_score) + '/100 (higher = more buying intent)');
        if (lead.notes) lines.push('Internal notes about this lead: ' + String(lead.notes).slice(0, 400));

        // Last 3 remarks (most recent first) — agents' notes about prior conversations
        try {
          const rmk = await db.query(
            `SELECT remark, created_at FROM remarks
              WHERE lead_id = $1 AND remark IS NOT NULL AND remark <> ''
              ORDER BY created_at DESC LIMIT 3`,
            [leadId]
          );
          if (rmk.rows.length) {
            lines.push('Recent activity notes:');
            rmk.rows.forEach(r => {
              const when = new Date(r.created_at).toISOString().slice(0, 10);
              lines.push('  - [' + when + '] ' + String(r.remark || '').slice(0, 240));
            });
          }
        } catch (_) {}

        // Open quotation if any — bot can reference the active quote
        try {
          const qz = await db.query(
            `SELECT number, status, total, created_at FROM quotations
              WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 2`,
            [leadId]
          );
          if (qz.rows.length) {
            lines.push('Quotations on file:');
            qz.rows.forEach(q => lines.push('  - ' + q.number + ' (' + q.status + ', \u20b9' + Number(q.total || 0).toLocaleString('en-IN') + ')'));
          }
        } catch (_) {}

        if (lines.length) {
          leadContextBlock = '\n\n=== CUSTOMER CONTEXT ===\n'
            + 'You are talking to this specific person on WhatsApp. Use their name when natural, '
            + 'reference past activity if relevant, and tailor your tone to their stage in the pipeline.\n'
            + lines.join('\n')
            + '\n=== END CUSTOMER CONTEXT ===';
        }
      }
    }
  } catch (e) { console.warn('[aiBot] lead-context build failed:', e && e.message); }

  const system = personaWithLang + leadContextBlock + kb;

  // History: last N inbound + outbound messages (chronological), but
  // exclude the just-arrived inbound that whatsbot already wrote to
  // whatsapp_messages before invoking us — otherwise the model sees
  // the user's current question both in history AND in 'prompt' and
  // starts replying as if it had already been asked twice.
  // Floor at 10 so legacy tenants who left history_messages at 0/1
  // also benefit from short-term memory.
  const hCountRaw = Number(settings.history_messages);
  const hCount = Math.max(10, isFinite(hCountRaw) && hCountRaw > 0 ? hCountRaw : 10);
  const history = [];
  try {
    const r = await db.query(
      `SELECT direction, body, message_type, created_at FROM whatsapp_messages
        WHERE (from_number = $1 OR to_number = $1)
        ORDER BY created_at DESC
        LIMIT $2`,
      [phone, hCount + 2]   // fetch a few extra so we can safely drop the inbound dup
    );
    let rows = r.rows.slice().reverse();
    // Drop the most recent inbound if its body matches the current
    // inboundText — that's the message we're answering, it shouldn't
    // be in history. Walk from the tail.
    if (rows.length && inboundText) {
      const last = rows[rows.length - 1];
      if (last && last.direction === 'in' && String(last.body || '').trim() === String(inboundText).trim()) {
        rows.pop();
      }
    }
    // Trim to hCount
    if (rows.length > hCount) rows = rows.slice(rows.length - hCount);
    rows.forEach(m => {
      const text = m.body || ('[' + (m.message_type || 'media') + ']');
      history.push({ role: m.direction === 'in' ? 'user' : 'model', text });
    });
  } catch (e) { console.warn('[aiBot] history build failed:', e && e.message); }

  return { system, history, prompt: String(inboundText || '') };
}

/**
 * Main entry called from whatsbot._handleInbound. NEVER throws — every
 * failure is logged into ai_chat_log so the tenant can see what happened
 * without breaking the inbound webhook flow.
 */
async function maybeReplyToInbound({ phone, leadId, inboundText, inboundPhoneId, inboundMsgId, tenantSlug, tenantId }) {
  let settings;
  let _settingsRow = null;
  try {
    // Per-phone bot lookup: 1) phone_number_id match, 2) additional_phone_ids match, 3) default (NULL) row.
    let r;
    if (inboundPhoneId) {
      r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id = $1 LIMIT 1`, [String(inboundPhoneId)]);
      if (!r.rows.length) {
        try {
          r = await db.query(`SELECT * FROM ai_bot_settings WHERE additional_phone_ids @> $1::jsonb LIMIT 1`, [JSON.stringify([String(inboundPhoneId)])]);
        } catch (_) { r = { rows: [] }; }
      }
      if (!r.rows.length) {
        r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`);
      }
    } else {
      r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`);
      if (!r.rows.length) r = await db.query(`SELECT * FROM ai_bot_settings WHERE id = 1`);
    }
    _settingsRow = r.rows[0];
    settings = _coerceSettings(_settingsRow);
    // Surface phone_number_id + additional_phone_ids onto coerced settings so _buildPrompt can scope KB.
    if (_settingsRow) {
      settings.phone_number_id = _settingsRow.phone_number_id || null;
      let addl = _settingsRow.additional_phone_ids;
      if (typeof addl === 'string') { try { addl = JSON.parse(addl); } catch (_) { addl = []; } }
      settings.additional_phone_ids = Array.isArray(addl) ? addl.map(String) : [];
    }
  } catch (_) { return; }   // table missing → tenant not migrated yet
  if (Number(settings.is_enabled) !== 1) return;

  // Customer replied — cancel any pending re-engagement for this phone.
  try { await _cancelReengageOnInbound(phone); } catch (_) {}

  // Per-number scoping: if active_phone_number_ids is non-empty, only
  // reply to inbounds that arrived on one of those phones. Empty list
  // (the default) means "reply on every connected number". This lets
  // tenants run the AI Bot only on Sales / only on Support / etc.
  const activeIds = Array.isArray(settings.active_phone_number_ids) ? settings.active_phone_number_ids.map(String) : [];
  if (activeIds.length > 0 && inboundPhoneId && !activeIds.includes(String(inboundPhoneId))) {
    try {
      await db.query(
        `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, status, suppressed_reason, mode_used, phone_number_id)
         VALUES ($1, $2, $3, 'suppressed', $4, $5, $6)`,
        [phone, leadId || null, inboundMsgId || null,
         'phone_number_id ' + inboundPhoneId + ' not in AI Bot active list',
         (settings.reply_modes || []).join('+') || 'always', inboundPhoneId || null]
      );
    } catch (_) {}
    return;
  }

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

  let { system, history, prompt } = await _buildPrompt(settings, phone, leadId, inboundText);

  // Dynamic quick-reply mode: ask the model to also choose 0-3 buttons
  // from a pool, based on what the customer just said. We append the pool
  // to the system prompt with a strict output format the model emits at
  // the end of its reply, then parse it out before sending.
  const _qrMode = String(settings.quick_reply_mode || 'static').toLowerCase();
  let _qrPool = [];
  if (_qrMode === 'dynamic') {
    const raw = String(settings.quick_reply_pool || '');
    _qrPool = raw.split(/[\n,]/).map(s => s.trim()).filter(s => s && s.length <= 20).slice(0, 15);
    if (_qrPool.length) {
      system = (system || '') + `\n\nQUICK-REPLY BUTTONS:\nYou can attach up to 3 tap-to-reply buttons to your message. Pick the most relevant options from this list based on what the customer asked:\n${_qrPool.map(o => '- ' + o).join('\n')}\n\nFormat your response EXACTLY like this:\n[Your reply text]\n[QR: option1 | option2 | option3]\n\nOnly pick buttons that genuinely make sense for THIS specific message. If no buttons are useful, write [QR: none] at the end. Maximum 3 buttons. Use EXACT spelling from the list above.`;
    }
  }

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

  let replyText = (result.text || '').trim();

  // Dynamic mode: parse out the [QR: a | b | c] tag from the bot's reply
  // and convert it to the buttons array, then strip the tag from the
  // customer-facing text.
  let _qrDynamicButtons = null;
  if (_qrMode === 'dynamic') {
    const m = replyText.match(/\[QR:\s*([^\]]*?)\s*\]\s*$/i);
    if (m) {
      replyText = replyText.slice(0, m.index).trim();
      const raw = String(m[1] || '').trim();
      if (raw && raw.toLowerCase() !== 'none') {
        _qrDynamicButtons = raw.split('|').map(s => s.trim())
          .filter(s => s && s.length <= 20)
          .slice(0, 3)
          .map(title => ({ title }));
      } else {
        _qrDynamicButtons = [];  // explicit "none" — send plain text
      }
    }
  }
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

  // Send via WhatsApp — if quick-reply buttons are configured on this
  // bot, send as interactive button message instead of plain text.
  // 1024-char body cap + max 3 buttons enforced inside the helper.
  try {
    const wb = _wb();
    const cfg = inboundPhoneId ? await wb._cfgForPhone(inboundPhoneId).catch(() => wb._cfg()) : await wb._cfg();
    let buttons = [];
    if (Array.isArray(_qrDynamicButtons)) {
      // Dynamic mode took priority — model picked these
      buttons = _qrDynamicButtons;
    } else {
      try {
        const raw = settings.quick_reply_buttons;
        buttons = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : []);
      } catch (_) { buttons = []; }
    }

    // Evaluate trigger condition: should we attach buttons to THIS reply?
    // Filter out buttons the customer has already tapped in this thread
    // (so the bot doesn't keep offering choices the customer already made).
    // Match is case-insensitive exact match against past inbound message bodies.
    if (Array.isArray(buttons) && buttons.length && Number(settings.quick_reply_filter_tapped || 0) === 1) {
      try {
        const titles = buttons.map(b => String((b && b.title) || '').trim().toLowerCase()).filter(t => t);
        if (titles.length) {
          const pr = await db.query(
            `SELECT DISTINCT LOWER(TRIM(body)) AS t FROM whatsapp_messages
             WHERE from_number = $1 AND direction = 'in' AND body IS NOT NULL
             ORDER BY 1`,
            [phone]
          );
          const taps = new Set(pr.rows.map(r => r.t));
          buttons = buttons.filter(b => !taps.has(String((b && b.title) || '').trim().toLowerCase()));
        }
      } catch (_) { /* on error keep all buttons */ }
    }

    let attachButtons = Array.isArray(buttons) && buttons.length > 0;
    if (attachButtons) {
      const trigger = String(settings.quick_reply_trigger || 'always').toLowerCase();
      if (trigger === 'first_only') {
        // Attach only if bot has not sent any prior outbound to this phone
        try {
          const prior = await db.query(
            `SELECT 1 FROM whatsapp_messages WHERE to_number = $1 AND direction = 'out' LIMIT 1`,
            [phone]
          );
          if (prior.rows.length > 0) attachButtons = false;
        } catch (_) { /* on error, fall through and attach */ }
      } else if (trigger === 'keywords') {
        // Attach only if the customer's inbound text contains one of the keywords
        const kwRaw = String(settings.quick_reply_keywords || '');
        const kws = kwRaw.split(/[,\n]/).map(k => k.trim().toLowerCase()).filter(k => k);
        const inboundLower = String(inboundText || '').toLowerCase();
        if (!kws.length || !kws.some(k => inboundLower.includes(k))) attachButtons = false;
      }
      // 'always' or unknown → keep attachButtons true
    }

    let send;
    if (attachButtons && replyText && replyText.length <= 1024) {
      send = await wb._sendInteractiveButtons({
        to: phone, text: replyText, buttons,
        leadId: leadId || null, userId: null
      }, cfg);
    } else {
      send = await wb._sendText({ to: phone, text: replyText, leadId: leadId || null, userId: null }, cfg);
    }
    const outboundId = send.wa_message_id || null;
    await db.query(
      `INSERT INTO ai_chat_log (phone, lead_id, inbound_msg_id, reply_text, model, mode_used, status, input_tokens, output_tokens, cost_inr_billed, phone_number_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'sent', $7, $8, $9, $10)`,
      [phone, leadId || null, inboundMsgId || null, replyText, result.model, modes.join('+'),
       result.input_tokens, result.output_tokens, result.cost_inr_billed, inboundPhoneId || null]
    );
    // Schedule re-engagement ping if the bot is configured for it.
    try { await _scheduleReengage({ settings, phone, leadId, inboundPhoneId }); } catch (_) {}
    // After the text reply, check if the inbound matches any attachable KB doc
    // (brochure / company profile / PPT) and send them as media attachments.
    try {
      const matches = await _findAttachmentMatches(inboundText, settings);
      if (matches && matches.length) await _sendAttachmentMatches({ matches, phone, leadId, inboundPhoneId });
    } catch (_) {}

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


// ============================================================
// Auto re-engagement (May 2026)
// ============================================================
// When the bot SENDS a reply, schedule a soft re-engagement message
// to fire after `reengage_after_minutes` of silence. If the customer
// replies before that, _cancelReengage() blanks the row.
// ============================================================
async function _scheduleReengage({ settings, phone, leadId, inboundPhoneId }) {
  if (!settings || Number(settings.reengage_enabled) !== 1) return;
  const minutes = Math.max(5, Math.min(10080, Number(settings.reengage_after_minutes || 60)));
  // Cancel any earlier scheduled rows for this phone so we only ever have one pending.
  try {
    await db.query(
      `UPDATE ai_reengage_log SET status = 'superseded', cancelled_reason = 'newer reply scheduled' WHERE phone = $1 AND status = 'scheduled'`,
      [String(phone)]
    );
  } catch (_) {}
  try {
    // Count how many re-engage attempts already happened for this phone in the last 7 days.
    // Stops the bot from spamming a customer who keeps going silent.
    const r = await db.query(
      `SELECT COUNT(*)::int AS n FROM ai_reengage_log
        WHERE phone = $1 AND status = 'sent' AND created_at > NOW() - INTERVAL '7 days'`,
      [String(phone)]
    );
    const sentCount = Number(r.rows[0] && r.rows[0].n) || 0;
    const maxAttempts = Math.max(1, Number(settings.reengage_max_attempts || 1));
    if (sentCount >= maxAttempts) return; // already pinged the max number of times
    await db.query(
      `INSERT INTO ai_reengage_log (phone, lead_id, phone_number_id, last_outbound_at, scheduled_for, attempt_no)
       VALUES ($1, $2, $3, NOW(), NOW() + ($4::int * INTERVAL '1 minute'), $5)`,
      [String(phone), leadId || null, inboundPhoneId || null, minutes, sentCount + 1]
    );
  } catch (e) {
    console.warn('[reengage] schedule failed:', e.message);
  }
}

async function _cancelReengageOnInbound(phone) {
  if (!phone) return;
  try {
    await db.query(
      `UPDATE ai_reengage_log SET status = 'cancelled', cancelled_reason = 'customer replied' WHERE phone = $1 AND status = 'scheduled'`,
      [String(phone)]
    );
  } catch (_) {}
}

/**
 * Tick: scan due re-engagement rows for THIS tenant pool and send them.
 * Called either from a per-tenant cron OR by the SaaS-wide cron in server.js.
 */
async function _reengageTick() {
  let due = [];
  try {
    const r = await db.query(
      `SELECT * FROM ai_reengage_log WHERE status = 'scheduled' AND scheduled_for <= NOW() ORDER BY id ASC LIMIT 50`
    );
    due = r.rows;
  } catch (_) { return; }
  if (!due.length) return;
  const wb = _wb();
  for (const row of due) {
    try {
      // Re-check: did the customer reply between scheduling and now?
      const last = await db.query(
        `SELECT direction, created_at FROM whatsapp_messages
          WHERE (from_number = $1 OR to_number = $1)
          ORDER BY created_at DESC LIMIT 1`,
        [String(row.phone)]
      );
      const lastMsg = last.rows[0];
      if (lastMsg && lastMsg.direction === 'in' && new Date(lastMsg.created_at) > new Date(row.last_outbound_at)) {
        await db.query(`UPDATE ai_reengage_log SET status = 'cancelled', cancelled_reason = 'customer replied (verified at send-time)' WHERE id = $1`, [row.id]);
        continue;
      }
      // Pull the bot config that owns this phone so we can render the message.
      let cfgRow = null;
      try {
        const c = row.phone_number_id
          ? (await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id = $1 LIMIT 1`, [String(row.phone_number_id)])).rows[0]
          : null;
        cfgRow = c || (await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`)).rows[0];
      } catch (_) {}
      if (!cfgRow || Number(cfgRow.reengage_enabled) !== 1) {
        await db.query(`UPDATE ai_reengage_log SET status = 'cancelled', cancelled_reason = 'bot disabled re-engagement' WHERE id = $1`, [row.id]);
        continue;
      }
      // Render {{name}} from the lead row (if any)
      let leadName = '';
      if (row.lead_id) {
        try {
          const l = await db.query(`SELECT name FROM leads WHERE id = $1 LIMIT 1`, [row.lead_id]);
          leadName = (l.rows[0] && l.rows[0].name) || '';
        } catch (_) {}
      }
      const msg = String(cfgRow.reengage_message || '')
        .replace(/\{\{\s*name\s*\}\}/g, leadName || 'there')
        .trim() || 'Just checking in — let me know if you need any help.';
      // Send via whatsbot using the bot's phone (or default).
      const cfg = row.phone_number_id ? await wb._cfgForPhone(row.phone_number_id).catch(() => wb._cfg()) : await wb._cfg();
      let sendResult = null;
      try {
        sendResult = await wb._sendText({ to: row.phone, text: msg }, cfg);
      } catch (e) {
        await db.query(`UPDATE ai_reengage_log SET status = 'failed', cancelled_reason = $2 WHERE id = $1`, [row.id, String(e.message).slice(0, 200)]);
        continue;
      }
      await db.query(
        `UPDATE ai_reengage_log SET status = 'sent', sent_message = $2, sent_at = NOW() WHERE id = $1`,
        [row.id, msg.slice(0, 1000)]
      );
      // Persist as an outbound whatsapp_message row so the chat shows it.
      try {
        await db.query(
          `INSERT INTO whatsapp_messages (direction, from_number, to_number, body, message_type, phone_number_id, wa_message_id, created_at)
           VALUES ('out', $1, $2, $3, 'text', $4, $5, NOW())`,
          [(cfg.phoneId || row.phone_number_id || '0'), String(row.phone), msg, row.phone_number_id || null, (sendResult && sendResult.wa_message_id) || null]
        );
      } catch (_) {}
    } catch (e) {
      console.warn('[reengage] row', row.id, 'failed:', e.message);
      try { await db.query(`UPDATE ai_reengage_log SET status = 'failed', cancelled_reason = $2 WHERE id = $1`, [row.id, String(e.message).slice(0, 200)]); } catch (_) {}
    }
  }
}

// ============================================================
// KB attachments (May 2026)
// ============================================================
// Customers often ask for a brochure / company profile / PPT — let users
// upload those files to the KB and tag them with trigger keywords. When
// an inbound matches a keyword, the bot sends the file via WhatsApp media
// alongside its text reply.
// ============================================================

const _MAX_KB_ATTACHMENT_BYTES = 16 * 1024 * 1024; // 16 MB — Meta document limit

/** Save a base64-encoded attachment to the KB. */
async function api_aibot_kb_save_attachment(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureAiBotColumns();
  const p = payload || {};
  const title = String(p.title || p.file_name || 'Attachment').slice(0, 200);
  const fileName = String(p.file_name || 'attachment').slice(0, 200);
  const mimeType = String(p.mime_type || 'application/octet-stream').slice(0, 120);
  const triggerKw = String(p.trigger_keywords || '').slice(0, 500);
  const phoneNumberId = p.phone_number_id ? String(p.phone_number_id) : null;
  const b64 = String(p.file_base64 || '');
  if (!b64) throw new Error('file_base64 is required');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw new Error('Could not decode file_base64');
  if (buf.length > _MAX_KB_ATTACHMENT_BYTES) throw new Error('File exceeds 16 MB limit (WhatsApp media cap)');

  const r = await db.query(
    `INSERT INTO ai_kb_documents
       (source_type, title, raw_text, file_data, file_mime_type, file_name, file_size_bytes,
        is_attachable, trigger_keywords, phone_number_id, is_active, ingest_status, created_by)
     VALUES ('attachment', $1, '', $2, $3, $4, $5, 1, $6, $7, 1, 'ready', $8)
     RETURNING id`,
    [title, buf, mimeType, fileName, buf.length, triggerKw, phoneNumberId, me.id || null]
  );
  return { ok: true, id: r.rows[0].id, size: buf.length, mime_type: mimeType };
}

/** Update attachable metadata on an existing KB row (toggle is_attachable / change keywords). */
async function api_aibot_kb_set_attachment_meta(token, id, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureAiBotColumns();
  const p = payload || {};
  const sets = []; const vals = []; let i = 1;
  if (p.is_attachable    != null) { sets.push('is_attachable = $' + (i++));    vals.push(p.is_attachable ? 1 : 0); }
  if (p.trigger_keywords != null) { sets.push('trigger_keywords = $' + (i++)); vals.push(String(p.trigger_keywords).slice(0, 500)); }
  if (p.title            != null) { sets.push('title = $' + (i++));            vals.push(String(p.title).slice(0, 200)); }
  if (!sets.length) return { ok: true };
  vals.push(Number(id));
  await db.query(`UPDATE ai_kb_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
  return { ok: true };
}

/** Find attachments to send for a given inbound text. Returns up to 2 matches. */
async function _findAttachmentMatches(inboundText, settings) {
  if (!inboundText || !String(inboundText).trim()) return [];
  await _ensureAiBotColumns();
  const cfgPhId = settings && settings.phone_number_id ? String(settings.phone_number_id) : null;
  const addlPhIds = settings && Array.isArray(settings.additional_phone_ids) ? settings.additional_phone_ids.map(String) : [];
  const allBotPhIds = (cfgPhId ? [cfgPhId] : []).concat(addlPhIds);
  let r;
  try {
    r = allBotPhIds.length
      ? await db.query(
          `SELECT id, title, file_name, file_mime_type, file_size_bytes, trigger_keywords
             FROM ai_kb_documents
            WHERE is_active = 1 AND is_attachable = 1
              AND (phone_number_id IS NULL OR phone_number_id = ANY($1::text[]))
            ORDER BY id ASC`,
          [allBotPhIds]
        )
      : await db.query(
          `SELECT id, title, file_name, file_mime_type, file_size_bytes, trigger_keywords
             FROM ai_kb_documents
            WHERE is_active = 1 AND is_attachable = 1 AND phone_number_id IS NULL
            ORDER BY id ASC`
        );
  } catch (_) { return []; }
  const text = String(inboundText).toLowerCase();
  const hits = [];
  for (const row of r.rows) {
    const kws = String(row.trigger_keywords || '').toLowerCase().split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
    if (!kws.length) continue;
    if (kws.some(kw => text.includes(kw))) hits.push(row);
    if (hits.length >= 2) break;
  }
  return hits;
}

/** Send the matched attachment(s) via WhatsApp using whatsbot helpers. */
async function _sendAttachmentMatches({ matches, phone, leadId, inboundPhoneId }) {
  if (!matches || !matches.length) return 0;
  const wb = _wb();
  const cfg = inboundPhoneId ? await wb._cfgForPhone(inboundPhoneId).catch(() => wb._cfg()) : await wb._cfg();
  if (!cfg || !cfg.token || !cfg.phoneId) return 0;
  let sent = 0;
  for (const m of matches) {
    try {
      // Pull the binary
      const r = await db.query(`SELECT file_data, file_name, file_mime_type FROM ai_kb_documents WHERE id = $1`, [m.id]);
      const row = r.rows[0];
      if (!row || !row.file_data) continue;
      const buf = Buffer.isBuffer(row.file_data) ? row.file_data : Buffer.from(row.file_data);
      // Upload to WhatsApp Graph media to get a media_id, then send as a document.
      const media = await wb._uploadMediaToWhatsApp(buf, row.file_mime_type || 'application/octet-stream', row.file_name || 'attachment', cfg);
      if (!media || !media.id) continue;
      // Map mime type to WhatsApp media kind. PDFs / docs / PPTs go through 'document';
      // images via 'image'; videos via 'video'; audio via 'audio'.
      const mt = String(row.file_mime_type || '').toLowerCase();
      const mediaKind = mt.startsWith('image/') ? 'image'
        : mt.startsWith('video/') ? 'video'
        : mt.startsWith('audio/') ? 'audio'
        : 'document';
      const payload = {
        messaging_product: 'whatsapp',
        to: String(phone),
        type: mediaKind,
        [mediaKind]: { id: media.id }
      };
      // Document type also accepts a filename hint on WhatsApp.
      if (mediaKind === 'document') payload.document.filename = row.file_name || 'attachment';
      const sendRes = await wb._graphPost(`${cfg.phoneId}/messages`, payload, cfg).catch(e => ({ error: e.message }));
      // Persist as an outbound row so the chat shows it.
      try {
        await db.query(
          `INSERT INTO whatsapp_messages (direction, from_number, to_number, body, message_type, phone_number_id, wa_message_id, media_id, media_filename, created_at)
           VALUES ('out', $1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [String(cfg.phoneId), String(phone), '[' + (row.file_name || 'attachment') + ']', mediaKind,
           inboundPhoneId || null, (sendRes && sendRes.body && sendRes.body.messages && sendRes.body.messages[0] && sendRes.body.messages[0].id) || null,
           media.id, row.file_name || null]
        );
      } catch (_) {}
      await db.query(`UPDATE ai_kb_documents SET sent_count = COALESCE(sent_count, 0) + 1 WHERE id = $1`, [m.id]);
      sent++;
    } catch (e) {
      console.warn('[ai-bot] send attachment failed:', e.message);
    }
  }
  return sent;
}

// ============================================================
// Hot-lead heat detection (May 2026)
// ============================================================
// Every WhatsApp inbound is scanned for buying-intent signals (price ask,
// callback request, "interested", "ready to buy"). On a heat upgrade the
// lead's heat_label / heat_score / heat_signal columns are updated and a
// push notification fires to the assigned agent + admin.
// ============================================================

// Keyword buckets — each contributes a signal weight + a category we expose
// to the agent in the action_required field.
const _HEAT_BUCKETS = [
  // Clear buying intent — single match should already push to very_hot.
  { weight: 45, action: 'send_quote', signal: 'asked about price',
    kws: ['price', 'pricing', 'cost', 'rate ', 'rates', 'fee', 'fees', 'how much', 'kitna', 'quote', 'quotation', 'budget', 'rs.', 'rupees', 'inr ', 'usd ', 'plan', 'tariff'] },
  { weight: 45, action: 'send_quote', signal: 'ready to buy',
    kws: ['ready to buy', 'want to buy', 'interested', 'go ahead', 'lets proceed', "let's proceed", 'proceed with', 'sign up', 'sign me up', 'kharidna hai', 'lena hai', 'finalize', 'finalise', 'confirm order', 'place order', 'count me in'] },
  { weight: 45, action: 'book_meeting', signal: 'wants a demo',
    kws: ['demo', 'want demo', 'demonstration', 'show me', 'walkthrough', 'walk through', 'free trial', 'trial', 'sample', 'preview', 'see it in action', 'demo karo', 'dikhao'] },
  { weight: 40, action: 'callback', signal: 'wants a callback',
    kws: ['call me', 'callback', 'call back', 'ring me', 'phone me', 'speak now', 'speak today', 'baat karni hai', 'phone karo', 'call karo', 'call kar', 'call kr', 'whatsapp call', 'video call'] },
  { weight: 35, action: 'send_brochure', signal: 'asked for comparison',
    kws: ['comparison', 'comparision', 'compare', 'comparing', 'vs ', ' vs.', 'difference', 'what makes you different', 'why you', 'better than'] },
  { weight: 30, action: 'send_brochure', signal: 'asked for details',
    kws: ['send details', 'share details', 'send brochure', 'send catalog', 'send catalogue', 'company profile', 'more info', 'tell me more', 'product details', 'features', 'more details', 'specifications', 'specs'] },
  { weight: 30, action: 'book_meeting', signal: 'wants a meeting',
    kws: ['schedule meeting', 'book meeting', 'book a call', 'appointment', 'site visit', 'visit office', 'meet up', 'meet you'] },
  { weight: 25, action: 'urgent_followup', signal: 'urgency expressed',
    kws: ['urgent', 'asap', 'today only', 'right now', 'jaldi', 'turant', 'right away', 'immediately'] }
];

const _HEAT_NEGATIVES = ['not interested', 'dont call', "don't call", 'stop messaging', 'remove me', 'unsubscribe', 'spam', 'block', 'gaali', 'mat karo'];

function _classifyHeatHeuristic(text, extraBuckets) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return { score: 0, label: null, signal: '', action: 'none' };
  for (const neg of _HEAT_NEGATIVES) {
    if (t.includes(neg)) return { score: -50, label: 'cold', signal: 'said "' + neg + '"', action: 'remove_or_pause' };
  }
  let score = 0;
  const matches = [];
  const actions = new Set();
  // Tenant-defined buckets win first so a custom keyword's weight + signal
  // labels show up cleanly. Then the built-in buckets cover anything the
  // tenant didn't explicitly list.
  const allBuckets = (Array.isArray(extraBuckets) ? extraBuckets : []).concat(_HEAT_BUCKETS);
  for (const b of allBuckets) {
    if (!b || !Array.isArray(b.kws)) continue;
    const w = Math.max(5, Math.min(60, Number(b.weight) || 30));
    for (const kw of b.kws) {
      const k = String(kw || '').toLowerCase().trim();
      if (k && t.includes(k)) {
        score += w;
        matches.push(String(b.signal || k));
        actions.add(String(b.action || 'followup'));
        break; // count each bucket only once
      }
    }
  }
  // Question-mark + at least one signal = small bonus
  if (matches.length && t.includes('?')) score += 5;
  if (score === 0) return { score: 0, label: null, signal: '', action: 'none' };
  let label = 'warm';
  if (score >= 75) label = 'on_fire';
  else if (score >= 40) label = 'very_hot';
  else if (score >= 25) label = 'hot';
  else if (score >= 10) label = 'warm';
  return { score: Math.min(100, score), label, signal: matches.slice(0, 2).join(' + '), action: Array.from(actions)[0] || 'followup' };
}

const _HEAT_RANK = { cold: 0, warm: 1, hot: 2, very_hot: 3, on_fire: 4 };

/**
 * Public entry point — called from whatsbot._handleInbound on every inbound.
 * Updates the lead's heat columns and pushes a notification on upgrade.
 *
 * Heat detection is now tenant-configurable: each bot can add its own
 * high-intent keywords (heat_keywords) and pick which heat levels trigger
 * a notification (heat_notify_levels). Defaults to the built-in keyword
 * set + push on hot/very_hot/on_fire to the assigned agent + admins.
 */
async function classifyAndAlertOnInbound({ phone, leadId, inboundText, inboundPhoneId, tenantSlug }) {
  if (!leadId || !inboundText) return;
  try {
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_score INTEGER`);
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_label TEXT`);
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_signal TEXT`);
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_action_required TEXT`);
    await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_updated_at TIMESTAMPTZ`);
  } catch (e) { console.warn('[heat] migrate leads failed:', e.message); }
  // Load the bot config that owns this phone — gives us the tenant's custom
  // heat keywords + notify-level preferences.
  let botCfg = null;
  try {
    let r;
    if (inboundPhoneId) {
      r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id = $1 LIMIT 1`, [String(inboundPhoneId)]);
      if (!r.rows.length) {
        try { r = await db.query(`SELECT * FROM ai_bot_settings WHERE additional_phone_ids @> $1::jsonb LIMIT 1`, [JSON.stringify([String(inboundPhoneId)])]); } catch (_) { r = { rows: [] }; }
      }
    } else { r = { rows: [] }; }
    if (!r.rows.length) r = await db.query(`SELECT * FROM ai_bot_settings WHERE phone_number_id IS NULL ORDER BY id ASC LIMIT 1`);
    botCfg = r.rows[0] || null;
  } catch (e) { console.warn('[heat] bot config lookup failed:', e.message); }
  if (botCfg && Number(botCfg.heat_enabled || 1) === 0) {
    console.log('[heat] disabled for this bot — skipping');
    return;
  }
  // Custom keyword buckets — JSONB array of {kws, weight, signal, action}.
  let customBuckets = [];
  if (botCfg && botCfg.heat_keywords) {
    let raw = botCfg.heat_keywords;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (_) { raw = []; } }
    if (Array.isArray(raw)) customBuckets = raw.filter(b => b && Array.isArray(b.kws) && b.kws.length);
  }
  const cls = _classifyHeatHeuristic(inboundText, customBuckets);
  console.log('[heat] inbound lead=' + leadId + ' phone=' + phone + ' score=' + cls.score + ' label=' + (cls.label || 'none') + ' signal=' + cls.signal + ' text=' + String(inboundText).slice(0, 80));
  if (!cls.label) return; // nothing meaningful detected

  // Read the current heat (if any) so we can compare and only alert on UPGRADES.
  let prev = null;
  try {
    const r = await db.query(`SELECT heat_label, heat_score, assigned_to, name FROM leads WHERE id = $1 LIMIT 1`, [leadId]);
    prev = r.rows[0];
  } catch (_) { return; }
  if (!prev) return;

  const newRank = _HEAT_RANK[cls.label] || 0;
  const oldRank = _HEAT_RANK[prev.heat_label || 'cold'] || 0;
  const oldScore = Number(prev.heat_score || 0);

  // Persist whichever is higher — heat is sticky once assigned, only goes UP
  // until an explicit cooldown (a "not interested" inbound resets to cold).
  let nextLabel = prev.heat_label || cls.label;
  let nextScore = oldScore;
  let upgraded = false;
  if (cls.label === 'cold') { // explicit negative — overwrite to cold
    nextLabel = 'cold'; nextScore = 0;
  } else if (newRank > oldRank || cls.score > oldScore) {
    nextLabel = cls.label; nextScore = cls.score; upgraded = true;
  }
  try {
    await db.query(
      `UPDATE leads SET heat_score = $1, heat_label = $2, heat_signal = $3, heat_action_required = $4, heat_updated_at = NOW() WHERE id = $5`,
      [nextScore, nextLabel, cls.signal.slice(0, 200), cls.action.slice(0, 50), leadId]
    );
  } catch (e) { console.warn('[heat] update failed:', e.message); return; }
  if (!upgraded) {
    console.log('[heat] no upgrade for lead ' + leadId + ' (was ' + (prev.heat_label || 'none') + '/' + oldScore + ', new ' + cls.label + '/' + cls.score + ')');
    return;
  }
  console.log('[heat] UPGRADED lead ' + leadId + ' to ' + nextLabel + '/' + nextScore + ' (' + cls.signal + ')');

  // Respect tenant-configured notify levels — only push if the NEW label is in the list.
  const levels = String((botCfg && botCfg.heat_notify_levels) || 'hot,very_hot,on_fire').split(',').map(s => s.trim()).filter(Boolean);
  if (levels.length && !levels.includes(nextLabel)) {
    console.log('[heat] level ' + nextLabel + ' not in notify list ' + levels.join(',') + ' — skipping push');
    return;
  }

  // Push notification to the assigned agent + admins.
  try {
    const push = require('./push');
    const recipients = new Set();
    const recipTokens = String((botCfg && botCfg.heat_notify_recipients) || 'assigned,admins').split(',').map(s => s.trim()).filter(Boolean);
    const wantAssigned = recipTokens.includes('assigned');
    const wantAdmins   = recipTokens.includes('admins');
    const wantManagers = recipTokens.includes('managers');
    if (wantAssigned && prev.assigned_to) recipients.add(Number(prev.assigned_to));
    if (wantAdmins || wantManagers) {
      const roles = [];
      if (wantAdmins) roles.push("'admin'");
      if (wantManagers) roles.push("'manager'");
      const roleClause = '(' + roles.join(',') + ')';
      try {
        let adm;
        try {
          adm = await db.query(`SELECT id FROM users WHERE role IN ${roleClause} AND is_active = 1`);
        } catch (_) {
          try { adm = await db.query(`SELECT id FROM users WHERE role IN ${roleClause} AND is_active = TRUE`); }
          catch (_) { adm = await db.query(`SELECT id FROM users WHERE role IN ${roleClause}`); }
        }
        adm.rows.forEach(u => recipients.add(Number(u.id)));
      } catch (e) { console.warn('[heat] admin/manager lookup failed:', e.message); }
    }
    // Also accept literal user IDs in the recipients list (e.g. 'assigned,5,12').
    recipTokens.forEach(t => { if (/^\d+$/.test(t)) recipients.add(Number(t)); });
    // Fallback: if NO recipients were resolved (lead unassigned + no admin
    // matched), broadcast the alert to every active user so somebody acts.
    if (!recipients.size) {
      try {
        let r;
        try { r = await db.query(`SELECT id FROM users WHERE is_active = 1 LIMIT 50`); }
        catch (_) {
          try { r = await db.query(`SELECT id FROM users WHERE is_active = TRUE LIMIT 50`); }
          catch (_) { r = await db.query(`SELECT id FROM users LIMIT 50`); }
        }
        r.rows.forEach(u => recipients.add(Number(u.id)));
        console.warn('[heat] no configured recipients found — broadcasting to ' + recipients.size + ' active users');
      } catch (e) { console.warn('[heat] broadcast fallback failed:', e.message); }
    }
    console.log('[heat] recipients for lead ' + leadId + ':', Array.from(recipients).join(','));
    if (!recipients.size) {
      console.warn('[heat] no recipients for lead ' + leadId + ' — push skipped (no assigned agent + no admins)');
    }
    const heatEmoji = cls.label === 'on_fire' ? '🔥🔥🔥' : cls.label === 'very_hot' ? '🔥🔥' : cls.label === 'hot' ? '🔥' : '✨';
    const actionLbl = ({
      callback: 'wants a callback',
      send_quote: 'asking about price',
      send_brochure: 'asking for details',
      book_meeting: 'wants to meet',
      urgent_followup: 'urgent — act now',
      followup: 'positive signal'
    })[cls.action] || 'positive signal';
    const title = heatEmoji + ' ' + (cls.label === 'on_fire' ? 'ON FIRE' : cls.label.toUpperCase().replace('_', ' ')) + ' — ' + (prev.name || phone);
    const body  = actionLbl + (cls.signal ? ' (' + cls.signal + ')' : '');
    const url   = '/#/leads/' + leadId;
    for (const uid of recipients) {
      // Durable in-app notification row — agent sees it on the bell drawer
      // even if web-push / FCM delivery fails (e.g. no subscription yet).
      try {
        await db.insert('notifications', {
          user_id: uid,
          type: 'heat_alert',
          title: title.slice(0, 200),
          body: body.slice(0, 500),
          link: url,
          is_read: 0
        });
      } catch (e) { console.warn('[heat] notification row insert failed for user ' + uid + ':', e.message); }
      push.sendPushToUser(uid, {
        title, body, url,
        tag: 'heat-' + leadId,
        sticky: true,
        data: { type: 'heat_alert', lead_id: leadId, heat_label: cls.label, action: cls.action }
      }).then(r => console.log('[heat] push to user ' + uid + ' for lead ' + leadId + ': sent=' + (r.sent || 0) + ' failed=' + (r.failed || 0)))
        .catch(e => console.warn('[heat] push failed for user ' + uid + ':', e.message));
    }
  } catch (e) { console.warn('[heat] push pipeline error:', e.message); }
}

/**
 * Self-test: lets a tenant admin fire a sample heat alert to themselves
 * to verify push notifications are wired up correctly. Useful when the
 * admin can't tell whether their FCM/web-push registration is working.
 */
async function api_aibot_heat_test_alert(token) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  // Persist an in-app notification + push the same payload the real
  // heat-detection pipeline uses, so behaviour matches end-to-end.
  const title = '🔥🔥 Very hot — test lead';
  const body  = 'Sample heat alert — verifying push delivery to your device.';
  const url   = '/#/leads';
  let pushResult = { sent: 0, failed: 0 };
  try {
    await db.insert('notifications', { user_id: me.id, type: 'heat_alert', title, body, link: url, is_read: 0 });
  } catch (_) {}
  try {
    const push = require('./push');
    pushResult = await push.sendPushToUser(me.id, {
      title, body, url, tag: 'heat-test-' + me.id, sticky: true,
      data: { type: 'heat_alert', test: 1 }
    });
  } catch (e) { return { ok: false, error: e.message, push: pushResult }; }
  return {
    ok: true,
    delivered: { sent: pushResult.sent || 0, failed: pushResult.failed || 0 },
    web: pushResult.web || null,
    fcm: pushResult.fcm || null,
    note: pushResult.sent === 0
      ? 'No subscriptions found — enable browser push (allow notifications) on this device, or install the mobile APK and sign in.'
      : 'Sent to ' + pushResult.sent + ' device(s).'
  };
}

/**
 * Heat diagnostics — returns the last N leads where heat fired, plus the
 * notification rows we created for them, plus the most recent inbound
 * messages so we can see WHAT triggered the score.
 *
 * Lets a tenant admin debug "why didn't I get an alert" without DB shell
 * access.
 */
async function api_aibot_heat_diagnostics(token, opts) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin/manager only');
  await _ensureAiBotColumns();
  const limit = Math.max(1, Math.min(50, Number((opts && opts.limit) || 20)));

  // Last leads with a heat signal, regardless of whether a notification row exists.
  let leads = [];
  try {
    const r = await db.query(
      `SELECT id, name, phone, status_id, assigned_to,
              heat_score, heat_label, heat_signal, heat_action_required, heat_updated_at
         FROM leads
        WHERE heat_label IS NOT NULL
        ORDER BY heat_updated_at DESC NULLS LAST
        LIMIT $1`, [limit]);
    leads = r.rows;
  } catch (e) {
    return { error: 'leads heat columns missing — make sure the migration has run: ' + e.message, leads: [] };
  }

  // For each lead, gather the most recent heat_alert notifications (across users).
  // Also count unread vs read so we can tell whether the recipient saw it.
  const notifByLead = new Map();
  try {
    const r = await db.query(
      `SELECT id, user_id, title, body, link, is_read, created_at
         FROM notifications
        WHERE type = 'heat_alert'
          AND created_at > NOW() - INTERVAL '7 days'
        ORDER BY created_at DESC
        LIMIT 500`);
    for (const n of r.rows) {
      // The link is '/#/leads/<id>' — extract the lead id back out.
      const m = String(n.link || '').match(/leads\/(\d+)/);
      if (!m) continue;
      const lid = Number(m[1]);
      if (!notifByLead.has(lid)) notifByLead.set(lid, []);
      notifByLead.get(lid).push(n);
    }
  } catch (_) {}

  // Last inbound text per lead — gives the agent the exact phrase that triggered.
  const lastInbound = new Map();
  try {
    if (leads.length) {
      const phones = leads.map(l => String(l.phone || '')).filter(Boolean);
      if (phones.length) {
        const r = await db.query(
          `SELECT DISTINCT ON (from_number) from_number, body, created_at
             FROM whatsapp_messages
            WHERE direction = 'in' AND from_number = ANY($1::text[])
            ORDER BY from_number, created_at DESC`, [phones]);
        r.rows.forEach(row => lastInbound.set(String(row.from_number), { body: row.body, created_at: row.created_at }));
      }
    }
  } catch (_) {}

  // Resolve user names for the assigned_to + the notification recipients.
  const userIds = new Set();
  leads.forEach(l => { if (l.assigned_to) userIds.add(Number(l.assigned_to)); });
  notifByLead.forEach(arr => arr.forEach(n => { if (n.user_id) userIds.add(Number(n.user_id)); }));
  const userById = new Map();
  if (userIds.size) {
    try {
      const r = await db.query(`SELECT id, name FROM users WHERE id = ANY($1::int[])`, [Array.from(userIds)]);
      r.rows.forEach(u => userById.set(Number(u.id), u.name));
    } catch (_) {}
  }

  // Count push subscriptions (web + FCM) per user — surfaces whether the
  // assigned agent / recipients can actually receive a mobile push.
  const subCounts = new Map();
  try {
    const w = await db.query(`SELECT user_id, COUNT(*)::int AS n FROM push_subscriptions GROUP BY user_id`);
    w.rows.forEach(r => subCounts.set(Number(r.user_id), { web: Number(r.n), fcm: 0 }));
  } catch (_) {}
  try {
    const f = await db.query(`SELECT user_id, COUNT(*)::int AS n FROM fcm_tokens GROUP BY user_id`);
    f.rows.forEach(r => {
      const cur = subCounts.get(Number(r.user_id)) || { web: 0, fcm: 0 };
      cur.fcm = Number(r.n);
      subCounts.set(Number(r.user_id), cur);
    });
  } catch (_) {}

  return {
    leads: leads.map(l => {
      const notifs = notifByLead.get(Number(l.id)) || [];
      return {
        id: l.id,
        name: l.name,
        phone: l.phone,
        assigned_to: l.assigned_to,
        assigned_name: userById.get(Number(l.assigned_to)) || null,
        heat_score: l.heat_score,
        heat_label: l.heat_label,
        heat_signal: l.heat_signal,
        heat_action_required: l.heat_action_required,
        heat_updated_at: l.heat_updated_at,
        last_inbound: lastInbound.get(String(l.phone || '')) || null,
        notifications: notifs.map(n => ({
          id: n.id, user_id: n.user_id,
          user_name: userById.get(Number(n.user_id)) || ('User #' + n.user_id),
          title: n.title, body: n.body, is_read: Number(n.is_read) === 1,
          created_at: n.created_at,
          subs: subCounts.get(Number(n.user_id)) || { web: 0, fcm: 0 }
        }))
      };
    }),
    summary: {
      leads_with_heat: leads.length,
      total_alerts_7d: Array.from(notifByLead.values()).reduce((s, a) => s + a.length, 0)
    }
  };
}


/* BOT_DIAGNOSE_v1 — explain why the AI Bot did or didn't reply for a given phone */
async function api_aiBot_diagnose(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const phone = String((payload && payload.phone) || '').replace(/\D/g, '');
  if (!phone) throw new Error('phone required');

  const out = { phone, checks: [], recent_log: [], recent_messages: [], settings: {}, flow_session: null };

  // Bot settings snapshot
  try {
    const s = (await db.query(`SELECT * FROM ai_bot_settings ORDER BY id ASC LIMIT 1`)).rows[0];
    if (s) {
      out.settings = {
        id: s.id,
        is_enabled: s.is_enabled,
        reply_modes: s.reply_modes,
        off_keywords: s.off_keywords,
        pause_after_human_handoff: s.pause_after_human_handoff,
        resume_after_idle_seconds: s.resume_after_idle_seconds,
        max_replies_per_thread: s.max_replies_per_thread,
        active_phone_number_ids: s.active_phone_number_ids,
        phone_number_id: s.phone_number_id
      };
      if (Number(s.is_enabled) !== 1) out.checks.push({ level: 'block', msg: 'Bot is DISABLED in settings (is_enabled = 0). Turn it on in AI Bot → Settings.' });
    } else {
      out.checks.push({ level: 'block', msg: 'No ai_bot_settings row found for this tenant — bot has not been configured.' });
    }
  } catch (e) { out.checks.push({ level: 'warn', msg: 'Could not read ai_bot_settings: ' + e.message }); }

  // Has any human agent EVER replied? (pause_after_human_handoff sticky mute)
  try {
    const r = await db.query(
      `SELECT created_at, user_id, body FROM whatsapp_messages
        WHERE direction = 'out' AND user_id IS NOT NULL
          AND (to_number = $1 OR from_number = $1)
        ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (r.rows.length) {
      out.checks.push({
        level: out.settings.pause_after_human_handoff ? 'block' : 'info',
        msg: 'A human agent (user_id=' + r.rows[0].user_id + ') replied on this thread at ' + r.rows[0].created_at + '. ' +
             (out.settings.pause_after_human_handoff ?
               'pause_after_human_handoff=1 → the bot is permanently muted on this thread until you disable the setting.' :
               'Bot will still reply (handoff pause is OFF) but the 30-min "human actively chatting" rule will suppress for 30 min after.'),
        last_human_at: r.rows[0].created_at
      });
    } else {
      out.checks.push({ level: 'ok', msg: 'No human agent has replied on this thread. Handoff suppression does not apply.' });
    }
  } catch (e) { out.checks.push({ level: 'warn', msg: 'human-agent check failed: ' + e.message }); }

  // Recent ai_chat_log entries (last 10) — show what the bot did or why it skipped
  try {
    const r = await db.query(
      `SELECT created_at, status, suppressed_reason, mode_used, reply_text, error_text, inbound_msg_id, phone_number_id
         FROM ai_chat_log WHERE phone = $1 ORDER BY created_at DESC LIMIT 10`,
      [phone]
    );
    out.recent_log = r.rows;
    if (r.rows.length === 0) {
      out.checks.push({ level: 'warn', msg: 'No ai_chat_log entries for this phone — the AI Bot pipeline never ran for any inbound from this number. Possible causes: tenant-wide off, inbound webhook not reaching the bot, or button-reply not being routed.' });
    } else if (r.rows[0].status === 'suppressed') {
      out.checks.push({ level: 'block', msg: 'Most recent inbound was SUPPRESSED. Reason: ' + (r.rows[0].suppressed_reason || '(no reason captured)') });
    } else if (r.rows[0].status === 'failed') {
      out.checks.push({ level: 'block', msg: 'Most recent reply FAILED. Error: ' + (r.rows[0].error_text || '(no error captured)') });
    } else if (r.rows[0].status === 'sent') {
      out.checks.push({ level: 'ok', msg: 'Most recent reply was SENT at ' + r.rows[0].created_at + '. Customer may not have received it (WhatsApp 24-hr window expired? token revoked?). Check whatsapp_messages for the actual Meta status.' });
    }
  } catch (e) { out.checks.push({ level: 'warn', msg: 'ai_chat_log read failed: ' + e.message }); }

  // Last 10 whatsapp_messages — to compare with ai_chat_log
  try {
    const r = await db.query(
      `SELECT created_at, direction, user_id, message_type, status, error_text, LEFT(body, 200) AS body, phone_number_id
         FROM whatsapp_messages
        WHERE from_number = $1 OR to_number = $1
        ORDER BY created_at DESC LIMIT 10`,
      [phone]
    );
    out.recent_messages = r.rows;
  } catch (e) { out.checks.push({ level: 'warn', msg: 'whatsapp_messages read failed: ' + e.message }); }

  // Active bot-flow session
  try {
    const r = await db.query(
      `SELECT id, flow_id, current_node_id, is_completed, last_at FROM wa_bot_flow_sessions
        WHERE phone = $1 AND is_completed = 0 ORDER BY last_at DESC LIMIT 1`,
      [phone.slice(-15)]
    );
    if (r.rows.length) {
      out.flow_session = r.rows[0];
      out.checks.push({ level: 'block', msg: 'Active Bot Flow session is consuming this thread (flow_id=' + r.rows[0].flow_id + ', node=' + r.rows[0].current_node_id + '). The Bot Flow runs BEFORE the AI Bot, so the AI Bot never gets the inbound. Close the session or finish the flow.' });
    } else {
      out.checks.push({ level: 'ok', msg: 'No active Bot Flow session — AI Bot path is not blocked by a flow.' });
    }
  } catch (e) { out.checks.push({ level: 'warn', msg: 'flow session check failed: ' + e.message }); }

  return out;
}

/* BOT_DIAGNOSE_v1 — clear a stuck bot-flow session so the AI Bot regains the thread */
async function api_aiBot_clearFlowSession(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  const phone = String((payload && payload.phone) || '').replace(/\D/g, '').slice(-15);
  if (!phone) throw new Error('phone required');
  const r = await db.query(`UPDATE wa_bot_flow_sessions SET is_completed = 1 WHERE phone = $1 AND is_completed = 0`, [phone]);
  return { ok: true, cleared: r.rowCount || 0 };
}

module.exports = {
  api_aiBot_diagnose, api_aiBot_clearFlowSession,  /* BOT_DIAGNOSE_v1 */
  // Public tenant API (auto-exposed via tenantApi.js loader)
  api_aibot_settings_get, api_aibot_settings_save,
  api_aibot_settings_listAll, api_aibot_settings_delete,
  api_aibot_kb_list, api_aibot_kb_save_text, api_aibot_kb_delete, api_aibot_kb_toggle, api_aibot_kb_crawl_url, api_aibot_kb_set_phone, api_aibot_kb_assign_bulk,
  api_aibot_kb_save_attachment, api_aibot_kb_set_attachment_meta,
  api_aibot_heat_test_alert,
  api_aibot_heat_diagnostics,
  api_aibot_chatlog_list, api_aibot_usage_summary, api_aibot_estimator,
  api_aibot_send_draft, api_aibot_discard_draft,
  // Internal — called from whatsbot.js + server.tenant.js upload route
  maybeReplyToInbound,
  classifyAndAlertOnInbound,
  _saveKBFromUpload,
  // Re-engagement worker — invoked from server.js cross-tenant cron
  _reengageTick,
};
