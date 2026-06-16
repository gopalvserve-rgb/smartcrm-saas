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
  // QNOTE_v3_FIX (2026-06-16) — input cleanup:
  //   1) strip trailing '/' that user typed to trigger status menu but
  //      didn't actually pick (would confuse Gemini's parse).
  //   2) normalize "12 :00 pm" -> "12:00 pm" (extra space between hour
  //      and ':' breaks Gemini's time detection).
  let _rawText = String(p.text || '').trim();
  _rawText = _rawText.replace(/\/+\s*$/, '').trim();
  _rawText = _rawText.replace(/(\d{1,2})\s+(:)\s*(\d{2})/g, '$1:$3');
  const text = _rawText;
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
        feature: 'quick_note',  // SHOWCASE_AI_v2 — allowed on demo tenants
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
  // QNOTE_v3_FIX (2026-06-16) — added a keyword fallback. If Gemini
  // missed the status_hint but the rep clearly typed "follow up", "call
  // back", "not pick", etc., match to an existing status by keyword.
  const _statusKeywordMap = [
    { kw: ['follow up', 'followup', 'call back', 'callback'], target: 'follow' },
    { kw: ['not pick', 'not picked', 'no answer', 'no response'], target: 'not pick' },
    { kw: ['interested', 'qualified'], target: 'qualified' },
    { kw: ['not interested', 'not int'], target: 'not interested' },
    { kw: ['junk', 'spam', 'fake'], target: 'junk' },
    { kw: ['won', 'closed', 'deal done', 'converted'], target: 'won' },
    { kw: ['lost'], target: 'lost' },
    { kw: ['proposal', 'quote sent', 'sent quote'], target: 'proposal' }
  ];
  function _keywordStatusGuess() {
    const lower = String(text || '').toLowerCase();
    for (const ent of _statusKeywordMap) {
      if (ent.kw.some(k => lower.includes(k))) {
        const hit = _resolveStatusByName(statuses, ent.target);
        if (hit) return hit;
      }
    }
    return null;
  }
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
  } else {
    const guess = _keywordStatusGuess();
    if (guess) { patch.status_id = guess.id; statusUsed = guess; }
  }

  // Follow-up
  let usedDefaultTime = false;
  let followupISO = null;
  // QNOTE_v3_FIX — local fallback time parser if Gemini returned null.
  // Handles: "12 pm today", "3pm tomorrow", "5:30 pm today", "tomorrow 10am"
  function _localTimeParse(txt) {
    const lower = String(txt || '').toLowerCase();
    const today = lower.includes('today');
    const tomorrow = lower.includes('tomorrow') || lower.includes('tmrw');
    if (!today && !tomorrow) return null;
    // h(:mm)?\s*(am|pm)
    const m = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    let hh = 10, mm = 0;
    if (m) {
      hh = Number(m[1]); mm = Number(m[2] || 0);
      if (m[3] === 'pm' && hh < 12) hh += 12;
      if (m[3] === 'am' && hh === 12) hh = 0;
    } else {
      // 24h form like "14:30"
      const m2 = lower.match(/\b(\d{1,2}):(\d{2})\b/);
      if (m2) { hh = Number(m2[1]); mm = Number(m2[2]); }
    }
    const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
    const base = new Date(nowIst.getTime() + (tomorrow ? 24 * 3600 * 1000 : 0));
    const yyyy = base.getUTCFullYear();
    const mo = String(base.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(base.getUTCDate()).padStart(2, '0');
    const hhStr = String(hh).padStart(2, '0');
    const mmStr = String(mm).padStart(2, '0');
    return `${yyyy}-${mo}-${dd}T${hhStr}:${mmStr}:00+05:30`;
  }
  if (parsed.followup_at) {
    const d = new Date(parsed.followup_at);
    if (!isNaN(d.getTime()) && d.getTime() > Date.now() - 60_000) {
      followupISO = d.toISOString();
      patch.next_followup_at = followupISO;
      usedDefaultTime = !!parsed.followup_time_was_default;
    }
  }
  if (!followupISO && text) {
    const localIso = _localTimeParse(text);
    if (localIso) {
      const d = new Date(localIso);
      if (!isNaN(d.getTime()) && d.getTime() > Date.now() - 60_000) {
        followupISO = d.toISOString();
        patch.next_followup_at = followupISO;
      }
    }
  }

  // ----- Apply via existing leads API so all hooks fire normally -----
  // QNOTE_CLASH_FIX_v1 (2026-06-12) — if the patch includes a follow-up time
  // that clashes with another lead's existing follow-up slot, api_leads_update
  // throws "Follow-up clash...". Rather than fail the whole Quick Note save
  // (and lose the rep's remark + status update), we DROP the offending
  // next_followup_at, retry the update with just status, and append the
  // clash warning to the final message so the rep knows to pick a new time.
  const leadsRoute = require('./leads');
  let clashWarning = null;
  if (Object.keys(patch).length > 0) {
    try {
      await leadsRoute.api_leads_update(token, leadId, patch);
    } catch (e) {
      const msg = String(e && e.message || '');
      if (/follow-?up clash/i.test(msg) && patch.next_followup_at) {
        clashWarning = msg.replace(/^Follow-up clash:\s*/i, '');
        // Strip the conflicting follow-up time and retry — status + remark
        // should still land even if the time slot is taken.
        delete patch.next_followup_at;
        followupISO = null;
        usedDefaultTime = false;
        if (Object.keys(patch).length > 0) {
          try { await leadsRoute.api_leads_update(token, leadId, patch); }
          catch (e2) { throw e2; }
        }
      } else {
        throw e;
      }
    }
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
      // QNOTE_NOTES_SYNC_v1 (2026-06-16) — user feedback: when a rep adds
      // a remark via the AI Quick Note, the remark lands in remarks (and
      // activity timeline) but the Notes column on the leads list stays
      // blank. Reps expected the latest note to appear in the Notes col.
      // Fix: also append the remark to leads.notes (prepend so the
      // newest is on top, cap to ~4 KB to avoid runaway growth).
      try {
        const cur = await db.findById('leads', leadId).catch(() => null);
        const prev = (cur && cur.notes) ? String(cur.notes) : '';
        const stamp = new Date().toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
        });
        const newLine = '✨ ' + stamp + ' — ' + remarkText;
        const merged = (prev ? newLine + '\n' + prev : newLine).slice(0, 4096);
        await db.update('leads', leadId, { notes: merged });
      } catch (e) {
        console.warn('[leadQuickNote] notes mirror failed:', e.message);
      }
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
  // QNOTE_CLASH_FIX_v1 — warn the rep the follow-up time wasn't applied
  if (clashWarning) {
    message += ' ⚠ Follow-up time NOT set: ' + clashWarning;
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
