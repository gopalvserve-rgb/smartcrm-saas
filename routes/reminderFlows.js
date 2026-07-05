/**
 * routes/reminderFlows.js  —  REMINDER_FLOWS_v1 (2026-07-05)
 *
 * Admin-facing CRUD for reusable follow-up reminder flows.
 *
 * Design (from REMINDER_FLOWS_v1_PLAN.md — v2 simplified):
 *   - A "flow" is a reusable template with:
 *       * shared WhatsApp template + email subject/body
 *       * shared "who receives it" (Lead / Owner)
 *       * up to 3 reminder "rungs" that each fire at a specific offset
 *         before the follow-up (e.g. -60m, -30m, -10m).
 *   - Reps pick a flow when setting a follow-up date/time.
 *   - The system materialises the flow into individual scheduled
 *     `followup_reminders` rows (see routes/followupReminders.js).
 *
 * APIs (all require admin):
 *   api_reminderFlows_list             → summary of every flow
 *   api_reminderFlows_get(id)          → flow + rungs
 *   api_reminderFlows_save({flow,rungs})
 *   api_reminderFlows_delete(id)
 *   api_reminderFlows_setDefault(id)   → mark one flow as default
 *   api_reminderFlows_preview({rungs, followup_at})
 *                                       → { schedule: [{fire_at, label, ...}] }
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

/* ── Schema (idempotent) ─────────────────────────────────────────── */
/* REMINDER_VARS_v1 (2026-07-05) — variable_map + header_image_url on flow */
/* PER_TENANT_SCHEMA_v1 (2026-07-05) — the previous module-level
 * `_schemaReady = true` flag was shared across ALL tenants in the
 * Node process. So if tenant A hit the API first (creating tables
 * in A's DB and flipping the flag), tenant B's request skipped
 * _ensureSchema entirely and errored with 'relation reminder_flows
 * does not exist'. Fix: cache per-tenant slug so each tenant
 * creates its own tables exactly once. */
const _schemaReady = new Set();
function _tenantKey() {
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    return (store && store.slug) || 'default';
  } catch (_) { return 'default'; }
}
async function _ensureSchema() {
  const key = _tenantKey();
  if (_schemaReady.has(key)) return;
  await db.query(`CREATE TABLE IF NOT EXISTS reminder_flows (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(120) NOT NULL,
    description         TEXT,
    is_active           SMALLINT     NOT NULL DEFAULT 1,
    is_default          SMALLINT     NOT NULL DEFAULT 0,
    channel_wa          SMALLINT     NOT NULL DEFAULT 1,
    channel_email       SMALLINT     NOT NULL DEFAULT 0,
    wa_template_id      INTEGER,
    wa_template_name    VARCHAR(120),
    wa_language         VARCHAR(20)  DEFAULT 'en',
    email_subject       TEXT,
    email_body_html     TEXT,
    send_to_lead        SMALLINT     NOT NULL DEFAULT 1,
    send_to_owner       SMALLINT     NOT NULL DEFAULT 0,
    created_by          INTEGER,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS reminder_flow_rungs (
    id                  SERIAL PRIMARY KEY,
    flow_id             INTEGER NOT NULL,
    offset_minutes      INTEGER NOT NULL,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS reminder_flow_rungs_flow_idx
                  ON reminder_flow_rungs(flow_id, sort_order)`).catch(()=>{});
  // Idempotent evolution: add columns for old installs
  await db.query(`ALTER TABLE reminder_flows ADD COLUMN IF NOT EXISTS wa_language VARCHAR(20) DEFAULT 'en'`).catch(()=>{});
  /* REMINDER_VARS_v1 (2026-07-05) — per-flow WA template config */
  await db.query(`ALTER TABLE reminder_flows ADD COLUMN IF NOT EXISTS variable_map JSONB DEFAULT '[]'::jsonb`).catch(()=>{});
  await db.query(`ALTER TABLE reminder_flows ADD COLUMN IF NOT EXISTS header_image_url TEXT`).catch(()=>{});
  await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS reminder_flow_id INTEGER`).catch(()=>{});
  _schemaReady.add(key);
}

async function _requireAdmin(token) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'super_admin') {
    throw new Error('Only admins can manage reminder flows');
  }
  return me;
}

/* ── 1. LIST ── */
async function api_reminderFlows_list(token) {
  await authUser(token);
  await _ensureSchema();
  const flows = (await db.query(`SELECT * FROM reminder_flows ORDER BY is_default DESC, name ASC`)).rows;
  const rungs = (await db.query(`SELECT * FROM reminder_flow_rungs ORDER BY flow_id, sort_order`)).rows;
  const byFlow = {};
  rungs.forEach(r => { (byFlow[r.flow_id] = byFlow[r.flow_id] || []).push(r); });
  return {
    items: flows.map(f => ({
      ...f,
      rungs: byFlow[f.id] || [],
      rung_count: (byFlow[f.id] || []).length
    }))
  };
}

/* ── 2. GET ONE ── */
async function api_reminderFlows_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  const f = (await db.query(`SELECT * FROM reminder_flows WHERE id=$1`, [Number(id)])).rows[0];
  if (!f) throw new Error('Flow not found');
  const rungs = (await db.query(
    `SELECT * FROM reminder_flow_rungs WHERE flow_id=$1 ORDER BY sort_order ASC, offset_minutes DESC`,
    [Number(id)]
  )).rows;
  return { flow: f, rungs };
}

/* ── 3. SAVE (create or update) ── */
async function api_reminderFlows_save(token, payload) {
  const me = await _requireAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const flow = p.flow || {};
  const rungs = Array.isArray(p.rungs) ? p.rungs : [];
  if (!flow.name || !String(flow.name).trim()) throw new Error('Flow name is required');
  if (!rungs.length) throw new Error('Pick at least 1 reminder time');
  if (rungs.length > 3) throw new Error('Max 3 reminders per flow');
  if (!Number(flow.channel_wa) && !Number(flow.channel_email)) {
    throw new Error('Pick at least one channel — WhatsApp or Email');
  }
  if (!Number(flow.send_to_lead) && !Number(flow.send_to_owner)) {
    throw new Error('Pick at least one recipient — Lead or Owner');
  }
  if (Number(flow.channel_email) && (!flow.email_subject || !flow.email_subject.trim())) {
    throw new Error('Email subject is required when Email is enabled');
  }

  const record = {
    name:             String(flow.name).trim().slice(0, 120),
    description:      String(flow.description || '').slice(0, 500),
    is_active:        Number(flow.is_active) === 0 ? 0 : 1,
    is_default:       Number(flow.is_default) === 1 ? 1 : 0,
    channel_wa:       Number(flow.channel_wa) === 1 ? 1 : 0,
    channel_email:    Number(flow.channel_email) === 1 ? 1 : 0,
    wa_template_id:   flow.wa_template_id ? Number(flow.wa_template_id) : null,
    wa_template_name: String(flow.wa_template_name || '').slice(0, 120),
    wa_language:      String(flow.wa_language || 'en').slice(0, 20),
    email_subject:    String(flow.email_subject || '').slice(0, 500),
    email_body_html:  String(flow.email_body_html || '').slice(0, 8000),
    send_to_lead:     Number(flow.send_to_lead) === 1 ? 1 : 0,
    send_to_owner:    Number(flow.send_to_owner) === 1 ? 1 : 0,
    variable_map:     Array.isArray(flow.variable_map) ? JSON.stringify(flow.variable_map) : (typeof flow.variable_map === 'string' ? flow.variable_map : '[]'),
    header_image_url: String(flow.header_image_url || '').slice(0, 800),
    updated_at:       new Date()
  };

  let flowId;
  if (flow.id) {
    // Update existing
    flowId = Number(flow.id);
    await db.query(
      `UPDATE reminder_flows SET
        name=$1, description=$2, is_active=$3, is_default=$4,
        channel_wa=$5, channel_email=$6, wa_template_id=$7, wa_template_name=$8, wa_language=$9,
        email_subject=$10, email_body_html=$11, send_to_lead=$12, send_to_owner=$13,
        variable_map=$14::jsonb, header_image_url=$15, updated_at=NOW()
       WHERE id=$16`,
      [record.name, record.description, record.is_active, record.is_default,
       record.channel_wa, record.channel_email, record.wa_template_id, record.wa_template_name, record.wa_language,
       record.email_subject, record.email_body_html, record.send_to_lead, record.send_to_owner,
       record.variable_map, record.header_image_url, flowId]
    );
    // Replace rungs
    await db.query(`DELETE FROM reminder_flow_rungs WHERE flow_id=$1`, [flowId]);
  } else {
    const r = await db.query(
      `INSERT INTO reminder_flows
       (name, description, is_active, is_default, channel_wa, channel_email,
        wa_template_id, wa_template_name, wa_language,
        email_subject, email_body_html, send_to_lead, send_to_owner,
        variable_map, header_image_url, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16) RETURNING id`,
      [record.name, record.description, record.is_active, record.is_default,
       record.channel_wa, record.channel_email, record.wa_template_id, record.wa_template_name, record.wa_language,
       record.email_subject, record.email_body_html, record.send_to_lead, record.send_to_owner,
       record.variable_map, record.header_image_url, me.id]
    );
    flowId = r.rows[0].id;
  }

  // If this flow is marked default, un-default every other flow
  if (record.is_default) {
    await db.query(`UPDATE reminder_flows SET is_default=0 WHERE id<>$1`, [flowId]);
  }

  // Insert rungs (sorted by offset — earliest reminder first)
  const uniqueOffsets = new Set();
  const cleaned = rungs
    .map(r => ({ offset_minutes: Number(r.offset_minutes) || 0 }))
    .filter(r => {
      if (uniqueOffsets.has(r.offset_minutes)) return false;
      uniqueOffsets.add(r.offset_minutes);
      return true;
    })
    .sort((a, b) => a.offset_minutes - b.offset_minutes);   // most-negative first

  for (let i = 0; i < cleaned.length; i++) {
    await db.query(
      `INSERT INTO reminder_flow_rungs (flow_id, offset_minutes, sort_order)
       VALUES ($1,$2,$3)`,
      [flowId, cleaned[i].offset_minutes, i]
    );
  }

  return { ok: true, id: flowId };
}

/* ── 4. DELETE ── */
async function api_reminderFlows_delete(token, id) {
  await _requireAdmin(token);
  await _ensureSchema();
  await db.query(`DELETE FROM reminder_flow_rungs WHERE flow_id=$1`, [Number(id)]);
  await db.query(`DELETE FROM reminder_flows WHERE id=$1`, [Number(id)]);
  // Detach from any leads that referenced it — no cascade, just null out
  await db.query(`UPDATE leads SET reminder_flow_id = NULL WHERE reminder_flow_id=$1`, [Number(id)])
    .catch(()=>{});
  return { ok: true };
}

/* ── 5. SET DEFAULT ── */
async function api_reminderFlows_setDefault(token, id) {
  await _requireAdmin(token);
  await _ensureSchema();
  await db.query(`UPDATE reminder_flows SET is_default=0`);
  if (id) await db.query(`UPDATE reminder_flows SET is_default=1 WHERE id=$1`, [Number(id)]);
  return { ok: true };
}

/* ── 6. PREVIEW — compute the concrete schedule if this flow were applied ── */
async function api_reminderFlows_preview(token, payload) {
  await authUser(token);
  const p = payload || {};
  const rungs = Array.isArray(p.rungs) ? p.rungs : [];
  const followupAt = p.followup_at ? new Date(p.followup_at) : new Date(Date.now() + 3 * 3600_000);
  const now = new Date();
  const schedule = rungs
    .map(r => Number(r.offset_minutes) || 0)
    .sort((a, b) => a - b)
    .map(off => {
      const fire = new Date(followupAt.getTime() + off * 60000);
      const inPast = fire < now;
      return {
        offset_minutes: off,
        label: (off === 0)
          ? 'At follow-up time'
          : Math.abs(off) + ' min ' + (off < 0 ? 'before' : 'after'),
        fire_at: fire.toISOString(),
        will_fire: !inPast,
        in_past: inPast
      };
    });
  return { followup_at: followupAt.toISOString(), schedule };
}

module.exports = {
  api_reminderFlows_list,
  api_reminderFlows_get,
  api_reminderFlows_save,
  api_reminderFlows_delete,
  api_reminderFlows_setDefault,
  api_reminderFlows_preview,
  _ensureSchema
};
