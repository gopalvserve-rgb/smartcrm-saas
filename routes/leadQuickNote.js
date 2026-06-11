/* routes/leadQuickNote.js — QNOTE_v1
 *
 * AI Quick Note row action. Replaces the per-row 📅 Calendly icon on the
 * Leads list with a sparkly AI button when the tenant has
 * COPILOT_ACTIONS_ENABLED=1 (vserve beta).
 *
 * Flow:
 *   user types "/Follow up call 3pm tomorrow customer wants pricing"
 *   front-end slash-pick gives picked_status_id (Follow Up)
 *   free text remainder sent to Gemini Flash Lite
 *   Gemini extracts { followup_at, remark }
 *   Default time = 10:00 AM IST when day mentioned but no time
 *   Apply via api_leads_update + api_leads_addRemark so REASSIGN_LOG_v1,
 *   activity timeline, push notifs, all hooks fire normally.
 *
 * Vserve-only via config gate AI_QUICKNOTE_ENABLED (also accepts
 * COPILOT_ACTIONS_ENABLED for now since it's the same beta cohort).
 */

const db = require('../db/pg');
const { authUser, getVisibleUserIds } = require('../utils/auth');
const geminiClient = require('../utils/geminiClient');

/** Tenant gate — returns true only when explicitly enabled. */
async function _isEnabled() {
  try {
    const r1 = await db.findOneBy('config', 'key', 'AI_QUICKNOTE_ENABLED').catch(() => null);
    if (r1 && String(r1.value) === '1') return true;
    // QNOTE_v1 ships gated under the same key as CP_ACT_v1 so vserve gets it
    // automatically without a second flag flip. New tenants opt-in via either.
    const r2 = await db.findOneBy('config', 'key', 'COPILOT_ACTIONS_ENABLED').catch(() => null);
    return r2 && String(r2.value) === '1';
  } catch (_) { return false; }
}

/* GET /api status — SPA uses this on Leads page to decide whether to
 * render the ✨ icon at all. Cached at the tenant level (60s TTL via
 * SPA-side warmCache). Cheap call: no Gemini, just config read. */
async function api_leads_quickNote_status(token) {
  await authUser(token);
  const enabled = await _isEnabled();
  return { enabled, default_time_24h: '10:00' };
}

/* Build the Gemini system prompt from tenant context (statuses, today's
 * IST date). Kept short to stay under ~400 tokens for cost reasons. */
function _buildSystemPrompt(statuses, defaultTime24h) {
  const statusList = statuses.map(s => s.name).join(' | ');
  // Convert IST today + tomorrow to YYYY-MM-DD strings for the prompt
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const todayStr = nowIst.toISOString().slice(0, 10);
  const tom = new Date(nowIst.getTime() + 24 * 3600 * 1000);
  const tomorrowStr = tom.toISOString().slice(0, 10);

  return `You parse a short sales-rep note about ONE lead and extract a follow-up time + remark.

ALLOWED STATUSES (for context — user may have already picked one): ${statusList}
TODAY (IST): ${todayStr}
TOMORROW (IST): ${tomorrowStr}
DEFAULT TIME when day is mentioned without explicit time: ${defaultTime24h} IST

Rules:
- Output ONLY valid JSON, no markdown, no commentary.
- followup_at: ISO 8601 with +05:30 offset (IST). null if no follow-up implied.
- followup_time_was_default: true if you applied the default ${defaultTime24h} because user didn't say a time.
- remark: a clean one-sentence summary of what the rep said. Keep names verbatim. null if rep only mentioned a time.
- status_hint: if rep clearly signals a status name from the allowed list, return it; null otherwise.

JSON schema:
{
  "followup_at": "YYYY-MM-DDTHH:MM:SS+05:30" or null,
  "followup_time_was_default": true|false,
  "remark": "..." or null,
  "status_hint": "exact name from allowed list" or null
}

Examples:
"call 3pm tomorrow, customer wants pricing"
→ {"followup_at":"${tomorrowStr}T15:00:00+05:30","followup_time_was_default":false,"remark":"Customer wants pricing","status_hint":null}

"tomorrow he is interested"
→ {"followup_at":"${tomorrowStr}T${defaultTime24h}:00+05:30","followup_time_was_default":true,"remark":"Customer is interested","status_hint":"Follow Up"}

"won, closed deal"
→ {"followup_at":null,"followup_time_was_default":false,"remark":"Closed deal","status_hint":"Won"}

"not picked try again 6pm"
→ {"followup_at":"${todayStr}T18:00:00+05:30","followup_time_was_default":false,"remark":"Not picked, will retry","status_hint":"Not Picked"}`;
}

/* Resolve a status NAME to an id with case-insensitive + fuzzy matching. */
function _resolveStatusByName(statuses, name) {
  if (!name) return null;
  const target = String(name).toLowerCase().trim();
  // Exact (case-insens)
  let hit = statuses.find(s => String(s.name).toLowerCase() === target);
  if (hit) return hit;
  // Starts-with
  hit = statuses.find(s => String(s.name).toLowerCase().startsWith(target));
  if (hit) return hit;
  // Contains
  hit = statuses.find(s => String(s.name).toLowerCase().includes(target));
  return hit || null;
}

/**
 * The main entrypoint.
 *
 * Payload: {
 *   lead_id: number,                    // required
 *   text:    string,                    // required, the rep's note
 *   picked_status_id: number | null     // optional, from slash-command picker
 * }
 *
 * Returns: {
 *   ok: true,
 *   applied: { status_id?, status_name?, followup_at?, remark? },
 *   used_default_time: boolean,
 *   message: "✓ Saved — Status → Follow Up · Follow-up tomorrow 10:00 AM (default) · Note added"
 * }
 */
async function api_leads_quickNote(token, payload) {
  const me = await authUser(token);
  if (!(await _isEnabled())) {
    throw new Error('AI Quick Note is in private beta. Not enabled for this tenant.');
  }
  const p = payload || {};
  const leadId = Number(p.lead_id);
  const text = String(p.text || '').trim();
  const pickedStatusId = p.picked_status_id ? Number(p.picked_status_id) : null;

  if (!leadId) throw new Error('lead_id required');
  if (!text && !pickedStatusId) throw new Error('Type something or pick a status first');
  if (text.length > 800) throw new Error('Note too long (max 800 chars)');

  const lead = await db.findById('leads', leadId);
  if (!lead) throw new Error('Lead not found');

  // Visibility — reuse same gate as api_leads_update so we never let a
  // user touch a lead they couldn't open via the modal.
  const visible = await getVisibleUserIds(me);
  const canSee = me.role === 'admin'
    || (lead.assigned_to && visible.includes(Number(lead.assigned_to)))
    || (lead.created_by != null && Number(lead.created_by) === Number(me.id));
  let isCoOwner = false;
  if (!canSee) {
    try {
      const co = await db.getAll('lead_co_owners', { lead_id: leadId });
      isCoOwner = (co || []).some(c => Number(c.user_id) === Number(me.id));
    } catch (_) {}
  }
  if (!canSee && !isCoOwner) throw new Error('Forbidden');

  // Load tenant statuses for prompt context + resolve
  const statuses = await db.getAll('statuses');

  // ----- Gemini call (skip if text is empty and only a status was picked) -----
  let parsed = { followup_at: null, followup_time_was_default: false, remark: null, status_hint: null };
  let geminiSucceeded = false;

  if (text) {
    const systemPrompt = _buildSystemPrompt(statuses, '10:00');
    let resp;
    try {
      resp = await geminiClient.generate({
        system: systemPrompt,
        prompt: text,
        model: 'gemini-2.5-flash-lite',     // cheapest, fastest, JSON-friendly
        maxOutputTokens: 250,
        temperature: 0.2,
      });
    } catch (e) {
      // Surface a clean error — rep can fall back to the manual lead modal
      throw new Error('AI parse failed: ' + (e.message || 'unknown'));
    }
    if (!resp || !resp.ok) {
      throw new Error('AI parse failed: ' + (resp && resp.error ? resp.error : 'no response'));
    }
    // Gemini sometimes wraps in ```json fences — strip them.
    let raw = String(resp.text || '').trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    try { parsed = Object.assign(parsed, JSON.parse(raw)); geminiSucceeded = true; }
    catch (_) {
      // Soft-fail: still save the remark verbatim even if Gemini's JSON is broken
      parsed.remark = text;
    }
    // Log usage so it shows in AI Costing (uses same crm_copilot_log path
    // as Copilot via geminiClient if available).
    try {
      if (geminiClient.logUsage) {
        await geminiClient.logUsage({
          user_id: me.id, feature: 'lead_quicknote',
          input_tokens: resp.input_tokens || 0, output_tokens: resp.output_tokens || 0,
          cost_inr: resp.cost_inr_billed || 0,
        });
      }
    } catch (_) {}
  }

  // ----- Build the patch (slash status wins over Gemini hint) -----
  const patch = {};
  let statusUsed = null;
  if (pickedStatusId) {
    const matched = statuses.find(s => Number(s.id) === pickedStatusId);
    if (matched) {
      patch.status_id = matched.id;
      statusUsed = matched;
    }
  } else if (parsed.status_hint) {
    const matched = _resolveStatusByName(statuses, parsed.status_hint);
    if (matched) {
      patch.status_id = matched.id;
      statusUsed = matched;
    }
  }

  // Follow-up
  let usedDefaultTime = false;
  let followupISO = null;
  if (parsed.followup_at) {
    const d = new Date(parsed.followup_at);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now() - 60_000) {
      followupISO = d.toISOString();
      patch.next_followup_at = followupISO;
      usedDefaultTime = !!parsed.followup_time_was_default;
    }
  }

  // ----- Apply via existing leads API so all hooks fire normally -----
  const leadsRoute = require('./leads');
  if (Object.keys(patch).length > 0) {
    await leadsRoute.api_leads_update(token, leadId, patch);
  }

  // Remark — write directly to the remarks table so we don't depend on
  // the cross-route call (which silently failed when status_id was empty).
  // QNOTE_v2_FIX (2026-06-12)
  let remarkText = null;
  if (text) {
    remarkText = (parsed.remark && parsed.remark.trim()) ? parsed.remark.trim() : text;
    try {
      await db.insert('remarks', {
        lead_id: leadId,
        user_id: me.id,
        remark: '✨ ' + remarkText,
        status_id: statusUsed ? statusUsed.id : null
      });
      // Also log to the lead activity timeline so the ✨ entry appears there
      try {
        await require('./tat').logAction(leadId, 'remark', me.id, {
          remark: remarkText.slice(0, 200), via: 'quick_note', source_text: text.slice(0, 240)
        });
      } catch (_) {}
    } catch (e) {
      console.warn('[leadQuickNote] direct remark insert failed:', e.message);
    }
  }

  // ----- Build the human-friendly message -----
  const parts = [];
  if (statusUsed) parts.push('Status → ' + statusUsed.name);
  if (followupISO) {
    const istLabel = new Date(followupISO).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    });
    parts.push('Follow-up ' + istLabel + (usedDefaultTime ? ' (default 10:00)' : ''));
  }
  if (remarkText) parts.push('Note added');

  let message = '✓ Saved' + (parts.length ? ' — ' + parts.join(' · ') : '');
  if (usedDefaultTime) {
    message += '. Set 10:00 AM since no time was given.';
  }

  return {
    ok: true,
    applied: {
      status_id: statusUsed ? statusUsed.id : null,
      status_name: statusUsed ? statusUsed.name : null,
      followup_at: followupISO,
      remark: remarkText
    },
    used_default_time: usedDefaultTime,
    via: geminiSucceeded ? 'gemini' : (text ? 'fallback' : 'manual'),
    message
  };
}

module.exports = { api_leads_quickNote, api_leads_quickNote_status };
