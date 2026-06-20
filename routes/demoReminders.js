/* ============================================================================
 * DEMO_REMINDER_v1 (2026-06-20) — Per-rep demo reminder system.
 *
 * What it does:
 *   1. 10 AM IST daily — every rep with demos scheduled today gets a card in
 *      their Copilot inbox: "You have N demos today. Confirm batch reminder?"
 *   2. ~30 min before each demo — same rep gets a single-row card with a
 *      drafted message (template if WA 24h window closed, AI-composed if open).
 *
 * Rep always taps to confirm — no auto-send. Always sends via Cloud API
 * (tenant's own WABA number), never personal WA.
 *
 * Gated behind:
 *   - DEMO_REMINDER_ENABLED config flag (default '0'; flipped to '1' on vserve)
 *   - Tenant must have configured DEMO_REMINDER_STATUSES (at least 1 status_id)
 *
 * APIs (all callable from SPA):
 *   api_demoReminder_settingsGet(token)
 *   api_demoReminder_settingsSet(token, payload)
 *   api_demoReminder_listTodayForMe(token)
 *   api_demoReminder_pendingCards(token)
 *   api_demoReminder_previewBatch(token, { reminder_type })
 *   api_demoReminder_sendBatch(token, { reminder_type, lead_ids[] })
 *   api_demoReminder_dismissCard(token, { card_id })
 *
 * Workers (called from server.js):
 *   runMorningBatchForAllTenants()       — daily 10 AM IST
 *   runPreDemoSweepForAllTenants()       — every 10 min
 * ============================================================================ */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/* ════════════════════════════ SCHEMA ════════════════════════════ */

let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;

  // Audit + dedup row per sent reminder.
  await db.query(`
    CREATE TABLE IF NOT EXISTS demo_reminders_sent (
      id              SERIAL PRIMARY KEY,
      lead_id         INTEGER NOT NULL,
      assigned_to     INTEGER,
      demo_at         TIMESTAMPTZ NOT NULL,
      reminder_type   TEXT NOT NULL,       -- 'morning_batch' | 'pre_30min'
      channel         TEXT NOT NULL,       -- 'template' | 'free_text'
      template_name   TEXT,
      message_body    TEXT,
      window_state    TEXT,                -- 'open' | 'closed'
      sent_at         TIMESTAMPTZ DEFAULT NOW(),
      sent_by         INTEGER,
      status          TEXT DEFAULT 'sent', -- 'sent' | 'failed'
      error_text      TEXT
    )`);
  // Dedup: never send the same reminder twice for the same lead+demo+type.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_drs_dedup
    ON demo_reminders_sent(lead_id, demo_at, reminder_type)
    WHERE status = 'sent'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_drs_assignee
    ON demo_reminders_sent(assigned_to, sent_at DESC)`);

  // Per-user Copilot card inbox. The morning batch worker drops rows here;
  // the SPA fetches them on first login + every 60s while logged in.
  await db.query(`
    CREATE TABLE IF NOT EXISTS demo_reminder_cards (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER NOT NULL,
      card_type       TEXT NOT NULL,       -- 'morning_batch' | 'pre_30min'
      payload_json    JSONB NOT NULL,      -- list of {lead_id, name, demo_at, window_state, draft_text}
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      shown_at        TIMESTAMPTZ,
      dismissed_at    TIMESTAMPTZ,
      acted_at        TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ          -- after this, card is hidden
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_drc_user_open
    ON demo_reminder_cards(user_id) WHERE dismissed_at IS NULL AND acted_at IS NULL`);

  _schemaReady = true;
}

/* ════════════════════════════ HELPERS ════════════════════════════ */

function _todayIstRange() {
  // Returns [start, end] in UTC for "today in IST". Postgres TIMESTAMPTZ
  // handles the conversion — we just need bounds.
  const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const y = nowIst.getFullYear(), m = nowIst.getMonth(), d = nowIst.getDate();
  const start = new Date(Date.UTC(y, m, d - 1, 18, 30, 0)); // 00:00 IST = 18:30 prev day UTC
  const end   = new Date(Date.UTC(y, m, d,     18, 29, 59));
  return { start: start.toISOString(), end: end.toISOString() };
}

async function _getSettings() {
  const enabled = await db.getConfig('DEMO_REMINDER_ENABLED', '0');
  const raw = await db.getConfig('DEMO_REMINDER_SETTINGS', '{}');
  let s = {};
  try { s = JSON.parse(raw || '{}'); } catch (_) {}
  return {
    enabled: String(enabled) === '1',
    statusIds: Array.isArray(s.status_ids) ? s.status_ids.map(Number).filter(Boolean) : [],
    morningTimeIst: s.morning_time_ist || '10:00',
    preLeadMinutes: Number(s.pre_lead_minutes) || 30,
    templateName: s.template_name || '',
    aiTone: s.ai_tone || 'friendly',
    skipIfPaused: s.skip_if_paused !== false
  };
}

async function _saveSettings(patch) {
  // Merge with existing so partial saves work.
  const cur = await _getSettings();
  const merged = {
    status_ids: Array.isArray(patch.status_ids) ? patch.status_ids.map(Number).filter(Boolean) : cur.statusIds,
    morning_time_ist: patch.morning_time_ist || cur.morningTimeIst,
    pre_lead_minutes: Number(patch.pre_lead_minutes) || cur.preLeadMinutes,
    template_name: patch.template_name != null ? patch.template_name : cur.templateName,
    ai_tone: patch.ai_tone || cur.aiTone,
    skip_if_paused: patch.skip_if_paused != null ? !!patch.skip_if_paused : cur.skipIfPaused
  };
  // setConfig is the standard pattern — wrap via a tiny query.
  await db.query(
    `INSERT INTO config (key, value) VALUES ('DEMO_REMINDER_SETTINGS', $1::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(merged)]
  );
  if (patch.enabled != null) {
    await db.query(
      `INSERT INTO config (key, value) VALUES ('DEMO_REMINDER_ENABLED', $1::text)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [patch.enabled ? '1' : '0']
    );
  }
  return _getSettings();
}

/* Check WA 24-hour customer-service window for a lead. Returns 'open' if the
 * customer sent us a message in the last 24h, else 'closed'. */
async function _checkWaWindow(phone) {
  if (!phone) return 'closed';
  try {
    const r = await db.query(
      `SELECT created_at FROM whatsapp_messages
       WHERE direction = 'in' AND from_number = $1
         AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 1`,
      [String(phone)]
    );
    return r.rows.length ? 'open' : 'closed';
  } catch (_) { return 'closed'; }
}

/* Find a rep's demos for today (per Q2 spec: scoped to the assigned rep). */
async function _findDemosForUser(userId, statusIds, reminderType /* 'morning_batch'|'pre_30min' */) {
  if (!statusIds.length) return [];
  let timeFilter;
  if (reminderType === 'pre_30min') {
    // Demos starting in the next 30-40 min window (next sweep covers 40-50).
    timeFilter = `next_followup_at BETWEEN NOW() + INTERVAL '30 minutes' AND NOW() + INTERVAL '40 minutes'`;
  } else {
    // Morning batch: today's remaining demos (skip already-lapsed ones, per Q1).
    timeFilter = `next_followup_at BETWEEN NOW() AND $1::date + INTERVAL '1 day' - INTERVAL '1 second'`;
  }
  const sql = `
    SELECT id, name, phone, whatsapp, assigned_to, next_followup_at, status_id
    FROM leads
    WHERE assigned_to = $2
      AND status_id = ANY($3::int[])
      AND ${timeFilter}
    ORDER BY next_followup_at ASC
    LIMIT 50
  `;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const r = await db.query(sql, reminderType === 'pre_30min' ? [null, userId, statusIds] : [today, userId, statusIds]);
    return r.rows;
  } catch (e) {
    console.warn('[demoReminders] _findDemosForUser failed:', e.message);
    return [];
  }
}

/* Find ALL reps in the tenant who have at least one demo today.
 * Used by the morning batch worker. */
async function _findRepsWithDemosToday(statusIds) {
  if (!statusIds.length) return [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await db.query(
      `SELECT DISTINCT l.assigned_to AS user_id
       FROM leads l
       JOIN users u ON u.id = l.assigned_to
       WHERE l.assigned_to IS NOT NULL
         AND l.status_id = ANY($1::int[])
         AND l.next_followup_at BETWEEN NOW() AND $2::date + INTERVAL '1 day' - INTERVAL '1 second'
         AND COALESCE(u.is_active, 1) = 1`,
      [statusIds, today]
    );
    return r.rows.map(x => x.user_id);
  } catch (_) { return []; }
}

/* Compose a draft for one demo lead. Returns { channel, message, template_name }. */
async function _draftMessage(lead, settings) {
  const windowState = await _checkWaWindow(lead.phone || lead.whatsapp);
  const demoTimeIst = new Date(lead.next_followup_at).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true
  });
  const name = (lead.name || 'there').split(' ')[0];

  if (windowState === 'closed') {
    // Must use template.
    return {
      channel: 'template',
      template_name: settings.templateName || 'demo_reminder_today',
      window_state: 'closed',
      message: `[Template: ${settings.templateName || 'demo_reminder_today'}] Hi ${name}, this is a reminder of your demo today at ${demoTimeIst}.`,
      template_params: [name, demoTimeIst]
    };
  }

  // Window open — Gemini draft. Cheap, fast.
  let aiText = '';
  try {
    const gemini = require('../utils/geminiClient');
    if (gemini && gemini.generateText) {
      const tone = settings.aiTone || 'friendly';
      const prompt = [
        `Write a 2-line WhatsApp reminder message.`,
        `Recipient first name: ${name}`,
        `Demo time today: ${demoTimeIst}`,
        `Tone: ${tone} — polite, warm, no exclamation marks.`,
        `End with a soft offer to reschedule if needed.`,
        `First-person plural (we / our team).`,
        `Under 240 characters total.`
      ].join('\n');
      const r = await gemini.generateText({ prompt, maxTokens: 120 });
      aiText = (r && r.text || '').trim();
    }
  } catch (_) { /* fall through to default */ }

  if (!aiText) {
    aiText = `Hi ${name}, just a quick reminder we're set for our demo today at ${demoTimeIst}. If anything changes, please let us know.`;
  }

  return {
    channel: 'free_text',
    template_name: null,
    window_state: 'open',
    message: aiText
  };
}

/* Build the per-lead preview that goes into a Copilot card. */
async function _buildPreviewForLead(lead, settings) {
  const draft = await _draftMessage(lead, settings);
  return {
    lead_id: lead.id,
    lead_name: lead.name || '',
    phone: lead.phone || lead.whatsapp || '',
    demo_at: lead.next_followup_at,
    window_state: draft.window_state,
    channel: draft.channel,
    template_name: draft.template_name,
    template_params: draft.template_params || null,
    draft_text: draft.message,
    has_phone: !!(lead.phone || lead.whatsapp)
  };
}

/* ════════════════════════════ SEND PATH ════════════════════════════ */

async function _sendReminder(preview, sentBy) {
  if (!preview.has_phone) {
    return { ok: false, error: 'no_phone' };
  }
  // Re-check window at send time (could have flipped since preview).
  const windowNow = await _checkWaWindow(preview.phone);
  let body, channel, templateName;
  if (windowNow === 'open' && preview.channel === 'free_text') {
    body = preview.draft_text;
    channel = 'free_text';
  } else {
    // Closed (or was always closed) — use template.
    channel = 'template';
    templateName = preview.template_name || 'demo_reminder_today';
    body = `[Template ${templateName}] ` + preview.draft_text;
  }

  let sendOk = false, errorText = null;
  try {
    const wb = require('./whatsbot');
    const cfg = await wb._cfg();
    if (channel === 'template' && wb._sendTemplate) {
      const r = await wb._sendTemplate({
        to: preview.phone,
        templateName: templateName,
        language: 'en',
        variables: preview.template_params || [],
        leadId: preview.lead_id,
        userId: sentBy
      }, cfg);
      sendOk = !!r && !r.error;
      errorText = r && r.error || null;
    } else if (channel === 'free_text' && wb._sendText) {
      const r = await wb._sendText({
        to: preview.phone,
        text: preview.draft_text,
        leadId: preview.lead_id,
        userId: sentBy
      }, cfg);
      sendOk = !!r && !r.error;
      errorText = r && r.error || null;
    } else {
      errorText = 'whatsbot_helpers_missing';
    }
  } catch (e) {
    errorText = String(e && e.message || e).slice(0, 240);
  }

  // Audit row.
  try {
    await db.query(
      `INSERT INTO demo_reminders_sent
       (lead_id, assigned_to, demo_at, reminder_type, channel, template_name,
        message_body, window_state, sent_by, status, error_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (lead_id, demo_at, reminder_type) WHERE status = 'sent' DO NOTHING`,
      [preview.lead_id, sentBy, preview.demo_at, preview.reminder_type || 'morning_batch',
       channel, templateName || null, body, windowNow, sentBy,
       sendOk ? 'sent' : 'failed', errorText]
    );
  } catch (_) {}

  return { ok: sendOk, error: errorText, channel, window_state: windowNow };
}

/* ════════════════════════════ ENDPOINTS ════════════════════════════ */

async function api_demoReminder_settingsGet(token) {
  await _ensureSchema();
  await authUser(token);
  return _getSettings();
}

async function api_demoReminder_settingsSet(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  if (!me || (me.role !== 'admin' && me.role !== 'manager')) {
    throw new Error('Admin only');
  }
  return _saveSettings(payload || {});
}

/* Returns the rep's own demos for today + WA window state. */
async function api_demoReminder_listTodayForMe(token) {
  await _ensureSchema();
  const me = await authUser(token);
  const s = await _getSettings();
  if (!s.enabled || !s.statusIds.length) return { enabled: false, demos: [] };
  const demos = await _findDemosForUser(me.id, s.statusIds, 'morning_batch');
  // Annotate each with window state (no draft — that comes from preview).
  const out = [];
  for (const d of demos) {
    const windowState = await _checkWaWindow(d.phone || d.whatsapp);
    out.push({
      lead_id: d.id, lead_name: d.name, phone: d.phone || d.whatsapp || '',
      demo_at: d.next_followup_at, window_state: windowState,
      has_phone: !!(d.phone || d.whatsapp)
    });
  }
  return { enabled: true, demos: out };
}

/* Returns any non-dismissed, non-expired cards for the rep.
 * Called on first SPA boot + periodically. */
async function api_demoReminder_pendingCards(token) {
  await _ensureSchema();
  const me = await authUser(token);
  const r = await db.query(
    `SELECT id, card_type, payload_json, created_at, expires_at
     FROM demo_reminder_cards
     WHERE user_id = $1
       AND dismissed_at IS NULL AND acted_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 10`,
    [me.id]
  );
  return { cards: r.rows };
}

/* Build the full preview (with drafted messages) for the rep's batch. */
async function api_demoReminder_previewBatch(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const s = await _getSettings();
  if (!s.enabled) throw new Error('Demo Reminders are not enabled');
  const reminderType = (payload && payload.reminder_type) || 'morning_batch';
  const demos = await _findDemosForUser(me.id, s.statusIds, reminderType);
  const out = [];
  for (const d of demos) {
    const preview = await _buildPreviewForLead(d, s);
    preview.reminder_type = reminderType;
    out.push(preview);
  }
  return { previews: out, count: out.length };
}

/* The actual send. Accepts a subset of lead_ids the rep selected. */
async function api_demoReminder_sendBatch(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const s = await _getSettings();
  if (!s.enabled) throw new Error('Demo Reminders are not enabled');
  const reminderType = (payload && payload.reminder_type) || 'morning_batch';
  const allowIds = new Set((payload && payload.lead_ids || []).map(Number));
  const demos = await _findDemosForUser(me.id, s.statusIds, reminderType);
  const results = [];
  for (const d of demos) {
    if (allowIds.size && !allowIds.has(d.id)) continue;
    const preview = await _buildPreviewForLead(d, s);
    preview.reminder_type = reminderType;
    const r = await _sendReminder(preview, me.id);
    results.push({ lead_id: d.id, lead_name: d.name, ...r });
    // Throttle 1/sec to be polite to Meta.
    await new Promise(res => setTimeout(res, 1000));
  }
  // Mark the user's card as acted on.
  if (payload && payload.card_id) {
    await db.query(`UPDATE demo_reminder_cards SET acted_at = NOW() WHERE id = $1 AND user_id = $2`,
      [payload.card_id, me.id]).catch(() => {});
  }
  const okCount = results.filter(r => r.ok).length;
  return { sent: okCount, total: results.length, results };
}

async function api_demoReminder_dismissCard(token, payload) {
  await _ensureSchema();
  const me = await authUser(token);
  const id = Number(payload && payload.card_id);
  if (!id) throw new Error('card_id required');
  await db.query(`UPDATE demo_reminder_cards SET dismissed_at = NOW() WHERE id = $1 AND user_id = $2`,
    [id, me.id]);
  return { ok: true };
}

/* ════════════════════════════ WORKERS ════════════════════════════ */

/* Drop a morning_batch card into every rep with demos today.
 * Card expires at end of IST day. Skips reps who already have an open card. */
async function dropMorningCardsForTenant() {
  await _ensureSchema();
  const s = await _getSettings();
  if (!s.enabled || !s.statusIds.length) return { skipped: true };
  const reps = await _findRepsWithDemosToday(s.statusIds);
  let dropped = 0;
  for (const userId of reps) {
    // Skip if rep already has a non-dismissed morning card from today.
    const ex = await db.query(
      `SELECT id FROM demo_reminder_cards
       WHERE user_id = $1 AND card_type = 'morning_batch'
         AND created_at::date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
         AND dismissed_at IS NULL AND acted_at IS NULL LIMIT 1`,
      [userId]
    );
    if (ex.rows.length) continue;
    const demos = await _findDemosForUser(userId, s.statusIds, 'morning_batch');
    if (!demos.length) continue;
    // Stub payload — drafts are built lazily when rep clicks Preview.
    const payload = demos.map(d => ({
      lead_id: d.id, lead_name: d.name, phone: d.phone || d.whatsapp || '',
      demo_at: d.next_followup_at, has_phone: !!(d.phone || d.whatsapp)
    }));
    // Expires at end-of-day IST.
    await db.query(
      `INSERT INTO demo_reminder_cards (user_id, card_type, payload_json, expires_at)
       VALUES ($1, 'morning_batch', $2::jsonb,
         (NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '23 hours 59 minutes' AT TIME ZONE 'Asia/Kolkata')`,
      [userId, JSON.stringify(payload)]
    );
    dropped++;
    // Push notify the rep so they see it even if not logged in.
    try {
      const push = require('./push');
      if (push && push.sendPushToUser) {
        await push.sendPushToUser(userId, {
          title: '☀️ ' + demos.length + ' demos today',
          body: 'Open Copilot to confirm reminder messages',
          url: '#/dashboard',
          tag: 'demo-reminder-morning-' + userId
        }).catch(() => {});
      }
    } catch (_) {}
  }
  return { reps_scanned: reps.length, cards_dropped: dropped };
}

/* Drop a single-row pre_30min card per rep, per upcoming demo. */
async function dropPreDemoCardsForTenant() {
  await _ensureSchema();
  const s = await _getSettings();
  if (!s.enabled || !s.statusIds.length) return { skipped: true };
  // Find all upcoming demos in the next 30-40 min window across all reps.
  const r = await db.query(
    `SELECT l.id, l.name, l.phone, l.whatsapp, l.assigned_to, l.next_followup_at
     FROM leads l
     WHERE l.assigned_to IS NOT NULL
       AND l.status_id = ANY($1::int[])
       AND l.next_followup_at BETWEEN NOW() + INTERVAL '30 minutes'
                                  AND NOW() + INTERVAL '40 minutes'`,
    [s.statusIds]
  );
  let dropped = 0;
  for (const lead of r.rows) {
    // Skip if we already dropped a card OR already sent for this lead+demo.
    const dup = await db.query(
      `SELECT 1 FROM demo_reminder_cards
       WHERE user_id = $1 AND card_type = 'pre_30min'
         AND payload_json->0->>'lead_id' = $2::text
         AND created_at > NOW() - INTERVAL '2 hours' LIMIT 1`,
      [lead.assigned_to, String(lead.id)]
    );
    if (dup.rows.length) continue;
    const sent = await db.query(
      `SELECT 1 FROM demo_reminders_sent
       WHERE lead_id = $1 AND demo_at = $2 AND reminder_type = 'pre_30min'
         AND status = 'sent' LIMIT 1`,
      [lead.id, lead.next_followup_at]
    );
    if (sent.rows.length) continue;
    const payload = [{
      lead_id: lead.id, lead_name: lead.name,
      phone: lead.phone || lead.whatsapp || '',
      demo_at: lead.next_followup_at,
      has_phone: !!(lead.phone || lead.whatsapp)
    }];
    await db.query(
      `INSERT INTO demo_reminder_cards (user_id, card_type, payload_json, expires_at)
       VALUES ($1, 'pre_30min', $2::jsonb, $3::timestamptz)`,
      [lead.assigned_to, JSON.stringify(payload), lead.next_followup_at]
    );
    dropped++;
    try {
      const push = require('./push');
      if (push && push.sendPushToUser) {
        await push.sendPushToUser(lead.assigned_to, {
          title: '⏰ 30 min to ' + (lead.name || 'demo'),
          body: 'Copilot has a reminder ready — tap to review',
          url: '#/dashboard',
          tag: 'demo-reminder-pre30-' + lead.id
        }).catch(() => {});
      }
    } catch (_) {}
  }
  return { upcoming_count: r.rows.length, cards_dropped: dropped };
}

module.exports = {
  api_demoReminder_settingsGet,
  api_demoReminder_settingsSet,
  api_demoReminder_listTodayForMe,
  api_demoReminder_pendingCards,
  api_demoReminder_previewBatch,
  api_demoReminder_sendBatch,
  api_demoReminder_dismissCard,
  // workers (called from server.js)
  dropMorningCardsForTenant,
  dropPreDemoCardsForTenant
};
