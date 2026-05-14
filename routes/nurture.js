/**
 * routes/nurture.js — Lead Nurturing System (Phase 1)
 *
 * A drip / sequence engine. Author a multi-step sequence once; enroll
 * leads manually (Phase 1) or auto-enroll on trigger events (Phase 2).
 * The worker (utils/nurtureWorker.js) wakes every 5 min, picks up
 * step_runs that are due, and executes them via the existing send paths:
 *
 *   - WhatsApp template  → routes/whatsbot._sendTemplate
 *   - Email              → utils/mailer._sendRaw
 *   - AI Bot trigger     → routes/aiBot maybeReplyToInbound (one-shot)
 *
 * Exit rules respected by the worker before each step:
 *   - Customer replied within last N hours → pause (resume after silence)
 *   - Lead status changed to a terminal status (Won / Lost) → exit
 *   - Manual unenroll → exit
 *
 * Phase 1 deliberately omits auto-enrollment triggers and conditional
 * branches; both can be added in Phase 2 without schema changes.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ──────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────
async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS nurture_sequences (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    exit_on_reply INTEGER NOT NULL DEFAULT 1,
    exit_on_status_id INTEGER,
    pause_on_reply_hours INTEGER NOT NULL DEFAULT 24,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_on_create INTEGER NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_on_status_id INTEGER`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_filter_sources TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_filter_campaign_id INTEGER`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_filter_product_id INTEGER`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_on_tag TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE nurture_sequences ADD COLUMN IF NOT EXISTS trigger_filter_tags TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE nurture_steps ADD COLUMN IF NOT EXISTS skip_if_status_id INTEGER`);

  await db.query(`CREATE TABLE IF NOT EXISTS nurture_steps (
    id SERIAL PRIMARY KEY,
    sequence_id INTEGER NOT NULL,
    step_no INTEGER NOT NULL,
    delay_days INTEGER NOT NULL DEFAULT 0,
    delay_hours INTEGER NOT NULL DEFAULT 0,
    channel TEXT NOT NULL,
    template_name TEXT,
    template_lang TEXT NOT NULL DEFAULT 'en_US',
    template_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
    email_subject TEXT,
    email_body TEXT,
    ai_prompt TEXT,
    body_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nurture_steps_seq ON nurture_steps(sequence_id, step_no)`);

  await db.query(`CREATE TABLE IF NOT EXISTS nurture_enrollments (
    id SERIAL PRIMARY KEY,
    sequence_id INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    current_step INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    paused_reason TEXT,
    ended_at TIMESTAMPTZ,
    ended_reason TEXT,
    enrolled_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nurture_enrolls_lead ON nurture_enrollments(lead_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nurture_enrolls_active ON nurture_enrollments(status) WHERE status = 'active'`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_nurture_enrolls_unique ON nurture_enrollments(sequence_id, lead_id) WHERE status IN ('active','paused')`);

  await db.query(`CREATE TABLE IF NOT EXISTS nurture_step_runs (
    id SERIAL PRIMARY KEY,
    enrollment_id INTEGER NOT NULL,
    sequence_id INTEGER NOT NULL,
    step_no INTEGER NOT NULL,
    lead_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending',
    error_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nurture_runs_due ON nurture_step_runs(scheduled_for) WHERE status = 'pending'`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_nurture_runs_enroll ON nurture_step_runs(enrollment_id, step_no)`);
}

// ──────────────────────────────────────────────────────────────────
// Public APIs
// ──────────────────────────────────────────────────────────────────
async function api_nurture_list(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`
    SELECT s.id, s.name, s.description, s.is_active, s.exit_on_reply, s.exit_on_status_id,
           s.pause_on_reply_hours, s.created_at, s.updated_at,
           (SELECT COUNT(*)::int FROM nurture_steps WHERE sequence_id = s.id) AS step_count,
           (SELECT COUNT(*)::int FROM nurture_enrollments WHERE sequence_id = s.id AND status IN ('active','paused')) AS active_count
      FROM nurture_sequences s
     ORDER BY s.is_active DESC, s.name ASC
  `);
  return r.rows;
}

async function api_nurture_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  const seqR = await db.query(`SELECT * FROM nurture_sequences WHERE id = $1`, [Number(id)]);
  if (!seqR.rows[0]) throw new Error('Sequence not found');
  const stepsR = await db.query(
    `SELECT * FROM nurture_steps WHERE sequence_id = $1 ORDER BY step_no ASC`,
    [Number(id)]
  );
  return { ...seqR.rows[0], steps: stepsR.rows };
}

async function api_nurture_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('Sequence name required');
  const seqId = Number(p.id) || null;

  let id = seqId;
  if (!id) {
    const ins = await db.query(
      `INSERT INTO nurture_sequences
         (name, description, is_active, exit_on_reply, exit_on_status_id, pause_on_reply_hours,
          trigger_on_create, trigger_on_status_id, trigger_filter_sources,
          trigger_filter_campaign_id, trigger_filter_product_id,
          trigger_on_tag, trigger_filter_tags, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [name, String(p.description || ''), p.is_active ? 1 : 0,
       p.exit_on_reply ? 1 : 0, p.exit_on_status_id || null,
       Math.max(1, Math.min(168, Number(p.pause_on_reply_hours || 24))),
       p.trigger_on_create ? 1 : 0,
       p.trigger_on_status_id || null,
       String(p.trigger_filter_sources || '').slice(0, 500),
       p.trigger_filter_campaign_id || null,
       p.trigger_filter_product_id || null,
       String(p.trigger_on_tag || '').slice(0, 200),
       String(p.trigger_filter_tags || '').slice(0, 500),
       me.id]
    );
    id = ins.rows[0].id;
  } else {
    await db.query(
      `UPDATE nurture_sequences SET name=$2, description=$3, is_active=$4, exit_on_reply=$5,
              exit_on_status_id=$6, pause_on_reply_hours=$7,
              trigger_on_create=$8, trigger_on_status_id=$9, trigger_filter_sources=$10,
              trigger_filter_campaign_id=$11, trigger_filter_product_id=$12,
              trigger_on_tag=$13, trigger_filter_tags=$14,
              updated_at=NOW() WHERE id=$1`,
      [id, name, String(p.description || ''), p.is_active ? 1 : 0,
       p.exit_on_reply ? 1 : 0, p.exit_on_status_id || null,
       Math.max(1, Math.min(168, Number(p.pause_on_reply_hours || 24))),
       p.trigger_on_create ? 1 : 0,
       p.trigger_on_status_id || null,
       String(p.trigger_filter_sources || '').slice(0, 500),
       p.trigger_filter_campaign_id || null,
       p.trigger_filter_product_id || null,
       String(p.trigger_on_tag || '').slice(0, 200),
       String(p.trigger_filter_tags || '').slice(0, 500)]
    );
  }

  // Replace steps wholesale — simpler than diffing
  const steps = Array.isArray(p.steps) ? p.steps : [];
  await db.query(`DELETE FROM nurture_steps WHERE sequence_id = $1`, [id]);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const channel = String(s.channel || 'wa_template').toLowerCase();
    if (!['wa_template', 'email', 'ai_bot'].includes(channel)) continue;
    await db.query(
      `INSERT INTO nurture_steps
         (sequence_id, step_no, delay_days, delay_hours, channel,
          template_name, template_lang, template_variables,
          email_subject, email_body, ai_prompt, body_text, skip_if_status_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
      [id, i + 1,
       Math.max(0, Math.min(365, Number(s.delay_days) || 0)),
       Math.max(0, Math.min(23, Number(s.delay_hours) || 0)),
       channel,
       String(s.template_name || '').slice(0, 200) || null,
       String(s.template_lang || 'en_US').slice(0, 20),
       JSON.stringify(Array.isArray(s.template_variables) ? s.template_variables : []),
       String(s.email_subject || '').slice(0, 300) || null,
       String(s.email_body || '').slice(0, 8000) || null,
       String(s.ai_prompt || '').slice(0, 2000) || null,
       String(s.body_text || '').slice(0, 2000) || null,
       s.skip_if_status_id || null]
    );
  }
  return { ok: true, id };
}

async function api_nurture_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  // Block delete if active enrollments exist
  const r = await db.query(
    `SELECT COUNT(*)::int AS c FROM nurture_enrollments WHERE sequence_id = $1 AND status IN ('active','paused')`,
    [Number(id)]
  );
  if (r.rows[0].c > 0) throw new Error(`Cannot delete — ${r.rows[0].c} active enrollments. Pause them first.`);
  await db.query(`DELETE FROM nurture_step_runs WHERE sequence_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM nurture_enrollments WHERE sequence_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM nurture_steps WHERE sequence_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM nurture_sequences WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_nurture_enroll(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  const sequenceId = Number(p.sequence_id);
  const leadIds = Array.isArray(p.lead_ids) ? p.lead_ids.map(Number).filter(Boolean) : [];
  if (!sequenceId) throw new Error('sequence_id required');
  if (!leadIds.length) throw new Error('At least one lead required');

  // Load sequence + steps
  const seqR = await db.query(`SELECT * FROM nurture_sequences WHERE id = $1`, [sequenceId]);
  if (!seqR.rows[0]) throw new Error('Sequence not found');
  if (!Number(seqR.rows[0].is_active)) throw new Error('Sequence is inactive');
  const stepsR = await db.query(
    `SELECT * FROM nurture_steps WHERE sequence_id = $1 ORDER BY step_no ASC`,
    [sequenceId]
  );
  if (!stepsR.rows.length) throw new Error('Sequence has no steps');

  const now = new Date();
  let enrolled = 0, skipped = 0;
  for (const leadId of leadIds) {
    // Skip if already enrolled and not ended
    const existing = await db.query(
      `SELECT 1 FROM nurture_enrollments WHERE sequence_id = $1 AND lead_id = $2 AND status IN ('active','paused')`,
      [sequenceId, leadId]
    );
    if (existing.rows.length) { skipped++; continue; }

    const ins = await db.query(
      `INSERT INTO nurture_enrollments (sequence_id, lead_id, started_at, current_step, status, enrolled_by)
       VALUES ($1, $2, $3, 0, 'active', $4) RETURNING id`,
      [sequenceId, leadId, now.toISOString(), me.id]
    );
    const enrollId = ins.rows[0].id;

    // Schedule all step_runs upfront — worker uses scheduled_for
    for (const step of stepsR.rows) {
      const due = new Date(now.getTime() + (Number(step.delay_days) * 86400 + Number(step.delay_hours) * 3600) * 1000);
      await db.query(
        `INSERT INTO nurture_step_runs (enrollment_id, sequence_id, step_no, lead_id, channel, scheduled_for, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [enrollId, sequenceId, step.step_no, leadId, step.channel, due.toISOString()]
      );
    }
    enrolled++;
  }
  return { ok: true, enrolled, skipped };
}

async function api_nurture_unenroll(token, payload) {
  const me = await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  const enrollId = Number(p.enrollment_id);
  const sequenceId = Number(p.sequence_id);
  const leadId = Number(p.lead_id);
  let target;
  if (enrollId) {
    target = await db.query(`SELECT id FROM nurture_enrollments WHERE id = $1`, [enrollId]);
  } else if (sequenceId && leadId) {
    target = await db.query(
      `SELECT id FROM nurture_enrollments WHERE sequence_id = $1 AND lead_id = $2 AND status IN ('active','paused')`,
      [sequenceId, leadId]
    );
  } else {
    throw new Error('enrollment_id OR (sequence_id + lead_id) required');
  }
  if (!target.rows.length) throw new Error('Enrollment not found');
  await db.query(
    `UPDATE nurture_enrollments SET status='exited', ended_at=NOW(), ended_reason=$2 WHERE id = $1`,
    [target.rows[0].id, String(p.reason || 'manual') ]
  );
  // Cancel pending step_runs
  await db.query(
    `UPDATE nurture_step_runs SET status='skipped', error_text='enrollment exited' WHERE enrollment_id = $1 AND status='pending'`,
    [target.rows[0].id]
  );
  return { ok: true };
}

async function api_nurture_lead_enrollments(token, leadId) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`
    SELECT e.*, s.name AS sequence_name,
           (SELECT COUNT(*)::int FROM nurture_steps WHERE sequence_id = e.sequence_id) AS total_steps,
           (SELECT MAX(step_no)::int FROM nurture_step_runs WHERE enrollment_id = e.id AND status='sent') AS sent_step
      FROM nurture_enrollments e
      JOIN nurture_sequences s ON s.id = e.sequence_id
     WHERE e.lead_id = $1
     ORDER BY e.started_at DESC
  `, [Number(leadId)]);
  return r.rows;
}

async function api_nurture_recent_runs(token, opts) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  const limit = Math.max(1, Math.min(500, Number((opts && opts.limit) || 100)));
  const r = await db.query(`
    SELECT r.id, r.enrollment_id, r.sequence_id, r.step_no, r.lead_id, r.channel,
           r.scheduled_for, r.sent_at, r.status, r.error_text,
           s.name AS sequence_name,
           l.name AS lead_name, l.phone AS lead_phone
      FROM nurture_step_runs r
      LEFT JOIN nurture_sequences s ON s.id = r.sequence_id
      LEFT JOIN leads l ON l.id = r.lead_id
     ORDER BY r.scheduled_for DESC
     LIMIT $1
  `, [limit]);
  return r.rows;
}


// ──────────────────────────────────────────────────────────────────
// Auto-enrollment — called from routes/leads.js on create + status change
// ──────────────────────────────────────────────────────────────────
async function _tryAutoEnroll(event, ctx) {
  try {
    await _ensureSchema();
    const lead = ctx && ctx.lead;
    if (!lead || !lead.id) return;

    // Find candidate sequences for this event
    let sql, params;
    if (event === 'lead_created') {
      sql = `SELECT * FROM nurture_sequences WHERE is_active = 1 AND trigger_on_create = 1`;
      params = [];
    } else if (event === 'status_changed') {
      sql = `SELECT * FROM nurture_sequences WHERE is_active = 1 AND trigger_on_status_id = $1`;
      params = [Number(lead.status_id) || 0];
    } else if (event === 'tag_added') {
      const tagsLower = String(ctx.added_tag || '').toLowerCase();
      sql = `SELECT * FROM nurture_sequences WHERE is_active = 1 AND LOWER(trigger_on_tag) = $1 AND trigger_on_tag <> ''`;
      params = [tagsLower];
    } else { return; }

    const candidates = (await db.query(sql, params)).rows;
    if (!candidates.length) return;

    for (const seq of candidates) {
      // Apply filters — source, campaign_id, product_id
      const sources = String(seq.trigger_filter_sources || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      if (sources.length) {
        const leadSrc = String(lead.source || '').trim().toLowerCase();
        if (!sources.includes(leadSrc)) continue;
      }
      if (Number(seq.trigger_filter_campaign_id) && Number(lead.campaign_id) !== Number(seq.trigger_filter_campaign_id)) continue;
      if (Number(seq.trigger_filter_product_id) && Number(lead.product_id) !== Number(seq.trigger_filter_product_id)) continue;
      // Tag filter — any of the lead's tags must overlap with the configured filter list
      const tagFilter = String(seq.trigger_filter_tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      if (tagFilter.length) {
        const leadTags = String(lead.tags || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        if (!leadTags.some(t => tagFilter.includes(t))) continue;
      }

      // Skip if already enrolled (active or paused)
      const existing = await db.query(
        `SELECT 1 FROM nurture_enrollments WHERE sequence_id = $1 AND lead_id = $2 AND status IN ('active','paused')`,
        [seq.id, lead.id]
      );
      if (existing.rows.length) continue;

      // Load steps + enroll inline
      const steps = (await db.query(
        `SELECT * FROM nurture_steps WHERE sequence_id = $1 ORDER BY step_no ASC`, [seq.id]
      )).rows;
      if (!steps.length) continue;

      const now = new Date();
      const ins = await db.query(
        `INSERT INTO nurture_enrollments (sequence_id, lead_id, started_at, current_step, status, enrolled_by)
         VALUES ($1, $2, $3, 0, 'active', $4) RETURNING id`,
        [seq.id, lead.id, now.toISOString(), (ctx.user && ctx.user.id) || null]
      );
      const enrollId = ins.rows[0].id;
      for (const step of steps) {
        const due = new Date(now.getTime() + (Number(step.delay_days) * 86400 + Number(step.delay_hours) * 3600) * 1000);
        await db.query(
          `INSERT INTO nurture_step_runs (enrollment_id, sequence_id, step_no, lead_id, channel, scheduled_for, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
          [enrollId, seq.id, step.step_no, lead.id, step.channel, due.toISOString()]
        );
      }
      console.log('[nurture] auto-enrolled lead', lead.id, 'into seq', seq.id, 'via', event);
    }
  } catch (e) {
    console.warn('[nurture] auto-enroll failed:', e.message);
  }
}

module.exports = {
  api_nurture_list, api_nurture_get, api_nurture_save, api_nurture_delete,
  api_nurture_enroll, api_nurture_unenroll,
  api_nurture_lead_enrollments, api_nurture_recent_runs,
  _ensureSchema,
  _tryAutoEnroll
};
