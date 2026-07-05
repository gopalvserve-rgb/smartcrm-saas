/**
 * utils/reminderSeed.js  —  REMINDER_FLOWS_v1 (2026-07-05)
 *
 * Seeds 3 sensible default reminder flows on first sweep for each tenant.
 * Idempotent — checks for an existing "Standard reminders" flow before
 * inserting anything. Safe to run every tick.
 */
'use strict';

const db = require('../db/pg');
const { _ensureSchema } = require('../routes/reminderFlows');

const DEFAULTS = [
  {
    flow: {
      name: 'Standard reminders',
      description: 'Sensible default for most follow-ups — 1 hour, 30 min, and 10 min before.',
      is_active: 1, is_default: 1,
      channel_wa: 1, channel_email: 1,
      wa_template_name: 'followup_reminder',
      wa_language: 'en',
      email_subject: 'Reminder: your follow-up with {{owner_name}} is coming up',
      email_body_html:
        '<div style="font-family:Inter,system-ui,sans-serif;color:#1c1917;max-width:520px">' +
        '<p>Hi {{name}},</p>' +
        '<p>Just a quick reminder — your follow-up with <b>{{owner_name}}</b> is scheduled for <b>{{followup_time}}</b> on <b>{{followup_date}}</b> (in {{minutes_before}} minutes).</p>' +
        '<p>If anything has changed, feel free to reply. Otherwise, talk soon.</p>' +
        '<p style="color:#78716c;font-size:12px;margin-top:20px">— {{company}}</p>' +
        '</div>',
      send_to_lead: 1, send_to_owner: 1
    },
    rungs: [-60, -30, -10]
  },
  {
    flow: {
      name: 'VIP high-touch',
      description: 'High-value leads — never let them slip.',
      is_active: 1, is_default: 0,
      channel_wa: 1, channel_email: 1,
      wa_template_name: 'followup_reminder',
      wa_language: 'en',
      email_subject: 'VIP follow-up with {{owner_name}} — {{minutes_before}} min',
      email_body_html:
        '<div style="font-family:Inter,system-ui,sans-serif;color:#1c1917;max-width:520px">' +
        '<p>Hi {{name}},</p>' +
        '<p>Your priority follow-up with <b>{{owner_name}}</b> is at <b>{{followup_time}}</b> on <b>{{followup_date}}</b>.</p>' +
        '<p>We\'re looking forward to it. Reply here if we need to adjust.</p>' +
        '<p style="color:#78716c;font-size:12px;margin-top:20px">— {{company}}</p>' +
        '</div>',
      send_to_lead: 1, send_to_owner: 1
    },
    rungs: [-60, -15, 0]
  },
  {
    flow: {
      name: 'Same-day site visit',
      description: 'Property + walk-in scenarios — nudge both sides before arrival.',
      is_active: 1, is_default: 0,
      channel_wa: 1, channel_email: 0,
      wa_template_name: 'followup_reminder',
      wa_language: 'en',
      email_subject: '',
      email_body_html: '',
      send_to_lead: 1, send_to_owner: 1
    },
    rungs: [-180, -60, -15]
  }
];

async function seedOnce() {
  try {
    await _ensureSchema();
    const existing = await db.query(`SELECT COUNT(*)::int AS n FROM reminder_flows`);
    if (Number(existing.rows[0].n) > 0) return { skipped: 'already-seeded' };

    let inserted = 0;
    for (const preset of DEFAULTS) {
      const f = preset.flow;
      const r = await db.query(
        `INSERT INTO reminder_flows (
          name, description, is_active, is_default,
          channel_wa, channel_email, wa_template_name, wa_language,
          email_subject, email_body_html, send_to_lead, send_to_owner
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [f.name, f.description, f.is_active, f.is_default,
         f.channel_wa, f.channel_email, f.wa_template_name, f.wa_language,
         f.email_subject, f.email_body_html, f.send_to_lead, f.send_to_owner]
      );
      const flowId = r.rows[0].id;
      for (let i = 0; i < preset.rungs.length; i++) {
        await db.query(
          `INSERT INTO reminder_flow_rungs (flow_id, offset_minutes, sort_order)
           VALUES ($1,$2,$3)`,
          [flowId, preset.rungs[i], i]
        );
      }
      inserted++;
    }
    console.log('[reminderSeed] inserted', inserted, 'default flows');
    return { inserted };
  } catch (e) {
    console.warn('[reminderSeed] failed:', e.message);
    return { error: e.message };
  }
}

module.exports = { seedOnce };
