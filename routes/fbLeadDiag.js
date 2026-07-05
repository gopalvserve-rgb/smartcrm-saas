/**
 * routes/fbLeadDiag.js  —  FB_LEAD_DIAG_v1 (2026-07-05)
 *
 * Diagnostic endpoint for admins to figure out WHY a specific FB lead's
 * Q&A didn't show up in Notes. Returns:
 *   - the lead's current notes / remark count
 *   - the closest matching `webhook_log` row for that lead (Meta ingest)
 *   - what `field_data` Meta actually sent for the form submission
 *   - what got mapped (via admin field mapping) vs left unmapped
 *   - a rebuilt "Form answers:" block from the raw field_data — so we can
 *     compare it to what's actually in the lead's notes right now
 *
 * Admin-only. Read-only.
 *
 * Usage from browser console:
 *   await window.api('api_fbLead_diagnose', <lead_id>)
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function api_fbLead_diagnose(token, leadId) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  if (!leadId) throw new Error('lead_id required');

  const lead = await db.findById('leads', Number(leadId));
  if (!lead) throw new Error('Lead not found');

  const out = {
    lead: {
      id: lead.id, name: lead.name, phone: lead.phone, email: lead.email,
      source: lead.source, created_at: lead.created_at,
      notes_length: (lead.notes || '').length,
      notes_preview: String(lead.notes || '').slice(0, 800),
      contains_form_answers: /Form answers:/.test(String(lead.notes || '')),
      contains_qa_remark: false
    },
    remarks_count: 0,
    remark_previews: [],
    webhook_log: null,
    field_data_raw: null,
    field_data_summary: [],
    would_appear_in_notes: [],
    mapping_used: null,
    diagnosis: []
  };

  // 1. Remarks — did the timeline get a "📋 Facebook form answers:" row?
  try {
    const rem = await db.query(
      `SELECT id, remark, created_at FROM remarks WHERE lead_id = $1 ORDER BY id ASC LIMIT 20`,
      [lead.id]
    );
    out.remarks_count = rem.rows.length;
    out.remark_previews = rem.rows.slice(0, 5).map(r => ({
      id: r.id, preview: String(r.remark || '').slice(0, 200)
    }));
    out.lead.contains_qa_remark = rem.rows.some(r => /Facebook form answers:/.test(String(r.remark || '')));
  } catch (_) {}

  // 2. Find the closest webhook_log entry — Meta ingest around lead's created_at.
  //    Look for an fb_map_diag entry that matches the lead's phone in the raw payload.
  try {
    const phoneDigits = String(lead.phone || '').replace(/\D/g, '').slice(-10);
    const around = await db.query(
      `SELECT id, source, payload, error, created_at
         FROM webhook_log
        WHERE source = 'meta'
          AND created_at >= $1::timestamptz - INTERVAL '5 minutes'
          AND created_at <= $1::timestamptz + INTERVAL '5 minutes'
        ORDER BY created_at ASC LIMIT 100`,
      [lead.created_at]
    );

    // Prefer the fb_map_diag entry that mentions our phone in payload_keys/values
    let hit = null;
    for (const row of around.rows) {
      let p; try { p = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch (_) { p = {}; }
      const flat = JSON.stringify(p || {});
      if (phoneDigits && flat.indexOf(phoneDigits) >= 0) { hit = { row, parsed: p }; break; }
      if (p && p.kind === 'fb_map_diag' && !hit) hit = { row, parsed: p };
    }
    if (hit) {
      out.webhook_log = {
        id: hit.row.id, source: hit.row.source, created_at: hit.row.created_at,
        kind: hit.parsed && hit.parsed.kind || 'raw',
        payload_summary: {
          leadgen_id: hit.parsed.leadgen_id,
          form_id:    hit.parsed.form_id,
          page_id:    hit.parsed.page_id,
          diag:       hit.parsed.diag || null
        }
      };
      if (hit.parsed.diag) {
        out.mapping_used = {
          map_source:        hit.parsed.diag.map_source,
          map_keys:          hit.parsed.diag.map_keys || [],
          applied_overrides: hit.parsed.diag.applied_overrides || [],
          applied_extras:    hit.parsed.diag.applied_extras || [],
          reason:            hit.parsed.diag.reason
        };
      }
    }
  } catch (e) {
    out.diagnosis.push('webhook_log lookup failed: ' + e.message);
  }

  // 3. Look for the raw field_data. It's stored in leads.meta_json for FB leads
  try {
    let mj = lead.meta_json;
    if (typeof mj === 'string') { try { mj = JSON.parse(mj); } catch (_) { mj = null; } }
    if (mj && mj.raw && Array.isArray(mj.raw.field_data)) {
      out.field_data_raw = mj.raw.field_data;
      out.field_data_summary = mj.raw.field_data.map(f => ({
        name: f && f.name,
        values: Array.isArray(f && f.values) ? f.values : [f && f.values].filter(Boolean),
        empty: !Array.isArray(f && f.values) || !f.values.filter(Boolean).length
      }));

      // Rebuild what the Q&A block WOULD be right now, using the current mapping keys
      const consumed = new Set(['full_name','name','phone_number','phone','email','whatsapp']);
      const mappedKeys = new Set((out.mapping_used && out.mapping_used.map_keys) || []);
      for (const f of out.field_data_summary) {
        if (!f.name) continue;
        const ans = (f.values || []).filter(Boolean).join(', ');
        if (!ans) continue;
        if (consumed.has(f.name)) continue;
        if (mappedKeys.has(f.name)) continue;
        const q = String(f.name).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        out.would_appear_in_notes.push(q + ': ' + ans);
      }
    }
  } catch (e) {
    out.diagnosis.push('meta_json parse failed: ' + e.message);
  }

  // 4. Verdict
  if (out.lead.contains_qa_remark) {
    out.diagnosis.push('✓ Q&A remark already present in timeline');
  }
  if (out.lead.contains_form_answers) {
    out.diagnosis.push('✓ "Form answers:" block found inside the lead.notes field');
  } else if (out.would_appear_in_notes.length) {
    out.diagnosis.push('⚠ Q&A was NOT appended to notes even though ' +
      out.would_appear_in_notes.length + ' unmapped questions exist in field_data. ' +
      'Lead pre-dates FB_META_QNA_NOTES_v2 (2026-07-03) OR notes were overwritten later.');
  } else if (!out.field_data_raw) {
    out.diagnosis.push('⚠ No raw field_data captured — either this lead did NOT come from Facebook Lead Ads (source was set manually), or meta_json is empty. Check webhook_log around the created_at for the actual FB webhook payload.');
  } else if (out.field_data_raw && out.field_data_summary.every(f => f.empty)) {
    out.diagnosis.push('⚠ Meta returned field_data but every value is empty. This is a Meta permission / access-token issue — the form was submitted but Meta declined to share the answers with our page token.');
  } else if (out.field_data_summary.length && !out.would_appear_in_notes.length) {
    out.diagnosis.push('ℹ Every form question was mapped to a custom field, so nothing was left over for the Q&A dump. This is correct behaviour. Check the custom-field values on the lead — the answers landed in cf_* fields, not notes.');
  }

  return out;
}

module.exports = { api_fbLead_diagnose };
