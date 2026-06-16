/* COPILOT_v4 — Proactive Sales Coach (2026-06-15)
 * Phase 1 Morning Briefing + Phase 2 Lead AI Summary + Phase 3 Signal Engine
 * + Phase 4 Proactive Chips + Phase 5 EOD Recap + Phase 6 Lead Timeline.
 * Gated behind COPILOT_PROACTIVE_ENABLED config flag (vserve-only beta).
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const gemini = (() => { try { return require('../utils/geminiClient'); } catch { return null; } })();

async function _requireUser(token) {
  const u = await authUser(token);
  if (!u || !(u.uid || u.id)) throw new Error('Not signed in');
  // Normalize uid (some auth backends return id, others uid)
  if (!u.uid) u.uid = u.id;
  return u;
}

async function _enabled() {
  try {
    const r = await db.query(`SELECT value FROM config WHERE key='COPILOT_PROACTIVE_ENABLED' LIMIT 1`);
    const v = r.rows[0] && r.rows[0].value;
    return String(v || '0') === '1';
  } catch { return false; }
}

function _todayIST() {
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  return ist.toISOString().slice(0, 10);
}
function _safeName(s) { return String(s || '').trim() || 'Unknown'; }
function _daysAgo(ts) { return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400e3)); }
function _hoursAgo(ts) { return Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 3600e3)); }
// LEAD_AI_HUB_v2 (2026-06-17) — IST-formatted date/time for human-friendly
// follow-up + activity timestamps. Sales reads in IST, not UTC.
function _istWhen(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const istMs = d.getTime() + 5.5 * 3600 * 1000;
    const z = new Date(istMs);
    const pad = (n) => String(n).padStart(2, '0');
    return z.getUTCFullYear() + '-' + pad(z.getUTCMonth() + 1) + '-' + pad(z.getUTCDate())
         + ' ' + pad(z.getUTCHours()) + ':' + pad(z.getUTCMinutes()) + ' IST';
  } catch { return ''; }
}
function _agoLabel(ts) {
  if (!ts) return '';
  const hrs = _hoursAgo(ts);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return hrs + 'h ago';
  return _daysAgo(ts) + 'd ago';
}
function _hoursAgo(ts) { return Math.max(1, Math.floor((Date.now() - new Date(ts).getTime()) / 3600e3)); }

function _actionLabelFor(kind) {
  switch (kind) {
    case 'missed_call': return 'Call back';
    case 'old_customer_msg': return 'Open chat';
    case 'followup_due': return 'Open lead';
    case 'promise_overdue': return 'Open lead';
    case 'inactive_hot': return 'Re-engage';
    case 'hot_score_jump': return 'Open lead';
    default: return 'Open';
  }
}

// ── Signal detection (cheap SQL, no LLM) ─────────────────────────────
async function _detectSignals(userId) {
  const out = [];

  // 1. Hot leads untouched 5+ days
  try {
    const r = await db.query(`
      SELECT l.id, l.name, l.smart_score, l.smart_category, l.updated_at
        FROM leads l
       WHERE l.assigned_to = $1
         AND l.smart_category IN ('Hot','Warm')
         AND l.updated_at < NOW() - INTERVAL '5 days'
       ORDER BY l.smart_score DESC NULLS LAST
       LIMIT 6`, [userId]);
    for (const row of r.rows) {
      out.push({
        kind: 'inactive_hot', lead_id: row.id,
        title: `${row.smart_category} lead "${_safeName(row.name)}" not touched in ${_daysAgo(row.updated_at)} days`,
        reason: `Score ${row.smart_score || '?'} — don't let them cool off.`,
        severity: 2
      });
    }
  } catch (e) {}

  // 2. Missed calls in last 24h with no return
  try {
    const r = await db.query(`
      SELECT ce.id AS event_id, ce.lead_id, ce.phone, ce.created_at,
             l.name AS lead_name
        FROM call_events ce
        LEFT JOIN leads l ON l.id = ce.lead_id
       WHERE ce.direction = 'in'
         AND COALESCE(ce.duration_s, 0) = 0
         AND ce.created_at > NOW() - INTERVAL '24 hours'
         AND (l.assigned_to = $1)
       ORDER BY ce.created_at DESC
       LIMIT 6`, [userId]);
    for (const row of r.rows) {
      out.push({
        kind: 'missed_call', lead_id: row.lead_id,
        title: `Missed call from ${_safeName(row.lead_name || row.phone)}`,
        reason: `${_hoursAgo(row.created_at)}h ago — no return call.`,
        severity: 3,
        payload: { phone: row.phone, event_id: row.event_id }
      });
    }
  } catch (e) {}

  // 3. Inbound WA > 2h old, no reply
  try {
    const r = await db.query(`
      SELECT wm.id, wm.lead_id, wm.from_number, wm.body, wm.created_at,
             l.name AS lead_name
        FROM whatsapp_messages wm
        LEFT JOIN leads l ON l.id = wm.lead_id
       WHERE wm.direction = 'in'
         AND wm.created_at > NOW() - INTERVAL '48 hours'
         AND wm.created_at < NOW() - INTERVAL '2 hours'
         AND l.assigned_to = $1
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_messages reply
            WHERE reply.lead_id = wm.lead_id
              AND reply.direction = 'out'
              AND reply.created_at > wm.created_at
         )
       ORDER BY wm.created_at DESC
       LIMIT 6`, [userId]);
    for (const row of r.rows) {
      out.push({
        kind: 'old_customer_msg', lead_id: row.lead_id,
        title: `${_safeName(row.lead_name)} messaged you`,
        reason: `"${String(row.body || '').slice(0, 80)}" — ${_hoursAgo(row.created_at)}h ago, no reply yet.`,
        severity: 3,
        payload: { phone: row.from_number }
      });
    }
  } catch (e) {}

  // 4. Follow-ups due today
  try {
    const r = await db.query(`
      SELECT l.id, l.name, l.next_followup_at, l.smart_category
        FROM leads l
       WHERE l.assigned_to = $1
         AND l.next_followup_at IS NOT NULL
         AND l.next_followup_at::date = CURRENT_DATE
       ORDER BY l.smart_score DESC NULLS LAST
       LIMIT 6`, [userId]);
    for (const row of r.rows) {
      out.push({
        kind: 'followup_due', lead_id: row.id,
        title: `Follow-up due: ${_safeName(row.name)}`,
        reason: `Scheduled for today${row.smart_category ? ` · ${row.smart_category}` : ''}.`,
        severity: 2
      });
    }
  } catch (e) {}

  return out;
}

async function _persistSignals(userId, signals) {
  const saved = [];
  for (const sig of signals) {
    try {
      const dup = await db.query(`
        SELECT id FROM copilot_signals
         WHERE user_id = $1 AND COALESCE(lead_id, 0) = COALESCE($2, 0)
           AND signal_kind = $3
           AND fired_at > NOW() - INTERVAL '12 hours'
           AND dismissed_at IS NULL AND acted_on_at IS NULL
         LIMIT 1`, [userId, sig.lead_id || null, sig.kind]);
      if (dup.rows.length) { saved.push({ ...sig, id: dup.rows[0].id, deduped: true }); continue; }
      const ins = await db.query(`
        INSERT INTO copilot_signals (user_id, lead_id, signal_kind, severity, title, reason, payload_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, fired_at`,
        [userId, sig.lead_id || null, sig.kind, sig.severity || 2, sig.title, sig.reason, JSON.stringify(sig.payload || {})]);
      saved.push({ ...sig, id: ins.rows[0].id, fired_at: ins.rows[0].fired_at });
    } catch (e) {}
  }
  return saved;
}

// ── PHASE 1 — Morning Briefing ───────────────────────────────────────
async function api_copilot_briefing(token, payload) {
  const u = await _requireUser(token);
  const date = (payload && payload.date) || _todayIST();
  const force = !!(payload && payload.force);

  if (!force) {
    try {
      const c = await db.query(`SELECT payload_json FROM copilot_briefings WHERE user_id=$1 AND for_date=$2 LIMIT 1`, [u.uid, date]);
      if (c.rows.length) {
        const p = c.rows[0].payload_json || {};
        if (p.items && p.items.length) return { ok: true, cached: true, ...p };
      }
    } catch {}
  }

  const fresh = await _detectSignals(u.uid);
  const persisted = await _persistSignals(u.uid, fresh);

  if (persisted.length < 3) {
    try {
      const r = await db.query(`
        SELECT id, name, smart_score, smart_category FROM leads
         WHERE assigned_to = $1 AND smart_category IN ('Hot','Warm')
         ORDER BY smart_score DESC NULLS LAST LIMIT 5`, [u.uid]);
      for (const row of r.rows) {
        persisted.push({
          id: null, kind: 'hot_score_jump', lead_id: row.id,
          title: `${row.smart_category}: ${_safeName(row.name)}`,
          reason: `Score ${row.smart_score || 0}. Worth a call today.`,
          severity: 2
        });
      }
    } catch {}
  }

  persisted.sort((a, b) => (b.severity || 2) - (a.severity || 2));
  const items = persisted.slice(0, 8).map((s, i) => ({
    rank: i + 1, signal_id: s.id, kind: s.kind, lead_id: s.lead_id,
    title: s.title, reason: s.reason, severity: s.severity || 2,
    action_label: _actionLabelFor(s.kind),
    action_url: s.lead_id ? `#/leads/${s.lead_id}` : '#/leads'
  }));

  const hour = new Date(Date.now() + 5.5 * 3600e3).getUTCHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const headline = items.length === 0
    ? 'You are all caught up. No urgent signals.'
    : `${items.length} thing${items.length === 1 ? '' : 's'} to focus on today`;

  const out = {
    greeting: `${greeting}, ${u.name || ''}`.trim(),
    headline, generated_at: new Date().toISOString(), items
  };

  try {
    await db.query(`
      INSERT INTO copilot_briefings (user_id, for_date, payload_json)
      VALUES ($1,$2,$3)
      ON CONFLICT (user_id, for_date) DO UPDATE SET payload_json=EXCLUDED.payload_json, created_at=NOW()`,
      [u.uid, date, JSON.stringify(out)]);
  } catch {}

  return { ok: true, ...out };
}

// ── PHASE 2 — Lead AI Summary ────────────────────────────────────────
async function api_copilot_lead_summary(token, payload) {
  await _requireUser(token);
  const leadId = Number(payload && payload.lead_id);
  if (!leadId) return { ok: false, error: 'lead_id required' };
  const force = !!(payload && payload.force);

  // ── LEAD_AI_HUB_v3 (2026-06-17) — every fact below is pulled
  // fresh, even on cache hits, so the activity recap and the missed-
  // follow-up alarm are always accurate. Only the 3 Gemini text
  // fields are cached (30 min).
  let lead = null;
  try {
    const r = await db.query(`
      SELECT l.id, l.name, l.phone, l.source, l.created_at, l.updated_at,
             l.smart_score, l.smart_category, l.score_reason,
             l.next_followup_at, l.last_status_change_at, l.notes,
             s.name AS status_name
        FROM leads l LEFT JOIN statuses s ON s.id = l.status_id
       WHERE l.id = $1 LIMIT 1`, [leadId]);
    lead = r.rows[0] || null;
  } catch {}
  if (!lead) return { ok: false, error: 'Lead not found' };

  // Latest remark with author — the rep's own most recent note.
  let lastRemark = null;
  try {
    const r = await db.query(`
      SELECT r.remark, r.created_at, u.name AS by_name
        FROM remarks r LEFT JOIN users u ON u.id = r.user_id
       WHERE r.lead_id = $1 ORDER BY r.created_at DESC LIMIT 1`, [leadId]);
    lastRemark = r.rows[0] || null;
  } catch {}

  // LAST INCOMING TEXT — skip empty/sticker/"Unsupported" entries
  // so we surface the actual most recent message the customer typed.
  let lastInWa = null;
  try {
    const r = await db.query(`
      SELECT body, created_at FROM whatsapp_messages
       WHERE lead_id = $1 AND direction = 'in'
         AND COALESCE(body, '') <> ''
         AND body NOT ILIKE '%unsupported%'
         AND body NOT ILIKE '%sticker%'
       ORDER BY created_at DESC LIMIT 1`, [leadId]);
    lastInWa = r.rows[0] || null;
  } catch {}

  // Also pull the very-most-recent inbound (any kind) to detect
  // sticker/media replies the customer DID send recently.
  let lastInAny = null;
  try {
    const r = await db.query(`
      SELECT body, created_at FROM whatsapp_messages
       WHERE lead_id = $1 AND direction = 'in'
       ORDER BY created_at DESC LIMIT 1`, [leadId]);
    lastInAny = r.rows[0] || null;
  } catch {}

  // Recent thread for Gemini context.
  let recentMsgs = [];
  try {
    const r = await db.query(`
      SELECT direction, body, created_at FROM whatsapp_messages
       WHERE lead_id = $1 AND COALESCE(body, '') <> ''
       ORDER BY created_at DESC LIMIT 8`, [leadId]);
    recentMsgs = r.rows.reverse();
  } catch {}

  // LAST CALL ATTEMPT — most recent row regardless of duration.
  // We classify: connected (duration > 30s), short (<30s), missed (0s
  // or direction='missed'). This tells the rep "you tried to call X
  // hours ago but it didn't connect" — a fact the previous version
  // hid because it only looked at completed calls.
  let lastCallAttempt = null;
  try {
    const r = await db.query(`
      SELECT ce.direction, ce.event, ce.duration_s, ce.created_at,
             u.name AS agent_name
        FROM call_events ce LEFT JOIN users u ON u.id = ce.user_id
       WHERE ce.lead_id = $1
       ORDER BY ce.created_at DESC LIMIT 1`, [leadId]);
    lastCallAttempt = r.rows[0] || null;
  } catch {}

  // LAST CONNECTED CALL — most recent with real duration.
  let lastCallConnected = null;
  try {
    const r = await db.query(`
      SELECT ce.direction, ce.duration_s, ce.created_at,
             u.name AS agent_name
        FROM call_events ce LEFT JOIN users u ON u.id = ce.user_id
       WHERE ce.lead_id = $1 AND COALESCE(ce.duration_s, 0) > 0
       ORDER BY ce.created_at DESC LIMIT 1`, [leadId]);
    lastCallConnected = r.rows[0] || null;
  } catch {}

  // MISSED FOLLOW-UP detection. Fire when:
  //   - next_followup_at is in the past
  //   - AND no remark or call_event has happened since the due time
  //   - AND status didn't change since the due time
  let missedFollowup = null;
  if (lead.next_followup_at) {
    const dueAt = new Date(lead.next_followup_at);
    if (dueAt.getTime() < Date.now()) {
      let acted = false;
      try {
        const r = await db.query(`
          SELECT 1 FROM remarks WHERE lead_id = $1 AND created_at > $2 LIMIT 1`,
          [leadId, lead.next_followup_at]);
        if (r.rows.length) acted = true;
      } catch {}
      if (!acted) {
        try {
          const r = await db.query(`
            SELECT 1 FROM call_events WHERE lead_id = $1 AND created_at > $2 LIMIT 1`,
            [leadId, lead.next_followup_at]);
          if (r.rows.length) acted = true;
        } catch {}
      }
      if (!acted && lead.last_status_change_at &&
          new Date(lead.last_status_change_at).getTime() > dueAt.getTime()) {
        acted = true;
      }
      if (!acted) {
        const hrs = _hoursAgo(dueAt);
        missedFollowup = {
          due_at: lead.next_followup_at,
          due_at_ist: _istWhen(lead.next_followup_at),
          hours_overdue: hrs,
          ago: _agoLabel(dueAt)
        };
      }
    }
  }

  // Build the structured "last activity" recap that the UI renders
  // verbatim. Each bullet is one fact.
  const activityBits = [];
  if (missedFollowup) {
    activityBits.push('🔴 MISSED FOLLOW-UP — due ' + missedFollowup.due_at_ist
      + ' (' + missedFollowup.ago + '). No call, no remark, no status change since.');
  }
  if (lead.smart_score != null) {
    const cat = lead.smart_category || '';
    activityBits.push('🌡 Lead score: ' + lead.smart_score + '/100'
      + (cat ? ' (' + cat + ')' : '')
      + (lead.score_reason ? ' — ' + String(lead.score_reason).slice(0, 140) : ''));
  }
  if (lastRemark) {
    activityBits.push('💬 Last remark by ' + (lastRemark.by_name || 'someone')
      + ' (' + _agoLabel(lastRemark.created_at) + '): "'
      + String(lastRemark.remark || '').slice(0, 160) + '"');
  }
  if (lead.next_followup_at && !missedFollowup) {
    activityBits.push('⏰ Next follow-up: ' + _istWhen(lead.next_followup_at));
  }
  // Two separate WA bullets when relevant
  if (lastInWa) {
    activityBits.push('📥 Last customer message ('
      + _agoLabel(lastInWa.created_at) + '): "'
      + String(lastInWa.body || '').slice(0, 200) + '"');
  } else if (lastInAny) {
    activityBits.push('📥 Last inbound from customer ('
      + _agoLabel(lastInAny.created_at) + '): (media / non-text — no caption)');
  }
  // Call: prefer last attempt; show connected separately if different
  if (lastCallAttempt) {
    const dur = Number(lastCallAttempt.duration_s || 0);
    const isMissed = (lastCallAttempt.direction === 'missed') || dur === 0;
    const isShort = dur > 0 && dur < 30;
    const status = isMissed ? 'NOT CONNECTED' : (isShort ? 'short ' + dur + 's' : Math.floor(dur / 60) + 'm ' + (dur % 60) + 's');
    activityBits.push('📞 Last call ATTEMPT: ' + (lastCallAttempt.agent_name || 'someone')
      + ' ' + (lastCallAttempt.direction === 'in' ? 'received call' : (lastCallAttempt.direction === 'missed' ? 'missed' : 'called'))
      + ' — ' + status + ' (' + _agoLabel(lastCallAttempt.created_at) + ')');
    if (lastCallConnected && lastCallAttempt.created_at !== lastCallConnected.created_at) {
      const cdur = Number(lastCallConnected.duration_s || 0);
      activityBits.push('   └ Last actually CONNECTED: ' + (lastCallConnected.agent_name || '?')
        + ' · ' + Math.floor(cdur / 60) + 'm ' + (cdur % 60) + 's · '
        + _agoLabel(lastCallConnected.created_at));
    }
  }
  const lastActivityLine = activityBits.join('\n');

  // Draft suggested only when an unanswered text from customer is fresh.
  const showDraft = !!(lastInWa && _hoursAgo(lastInWa.created_at) < 48);

  // Cache check — return with FRESH activity facts even when Gemini text is cached.
  if (!force) {
    try {
      const c = await db.query(`
        SELECT summary, next_action, draft_msg, generated_at
          FROM copilot_lead_summaries
         WHERE lead_id = $1 AND generated_at > NOW() - INTERVAL '30 minutes'
         LIMIT 1`, [leadId]);
      if (c.rows.length) {
        const row = c.rows[0];
        return {
          ok: true, cached: true,
          summary: row.summary, next_action: row.next_action,
          draft_msg: showDraft ? row.draft_msg : '',
          show_draft: showDraft,
          last_activity_line: lastActivityLine,
          missed_followup: missedFollowup,
          smart_score: lead.smart_score,
          smart_category: lead.smart_category,
          generated_at: row.generated_at
        };
      }
    } catch {}
  }

  // Build the Gemini context — verbose, factual, instructive.
  const ctxLines = [
    `Lead: ${_safeName(lead.name)} (phone: ${lead.phone || 'unknown'})`,
    `Status: ${lead.status_name || 'unknown'}, Source: ${lead.source || 'unknown'}`,
    `Lead AI Score: ${lead.smart_score || 'n/a'}/100 (${lead.smart_category || 'uncategorised'}). ${lead.score_reason || ''}`,
    `Created ${_daysAgo(lead.created_at)}d ago, last touched ${_daysAgo(lead.updated_at)}d ago.`
  ];
  if (missedFollowup) {
    ctxLines.push('🚨 MISSED FOLLOW-UP: was scheduled for ' + missedFollowup.due_at_ist
      + ' (' + missedFollowup.hours_overdue + 'h overdue). The rep DID NOT take action — no call, no remark, no status change since the due time. This is a P0 problem you MUST call out.');
  } else if (lead.next_followup_at) {
    ctxLines.push('Next follow-up scheduled: ' + _istWhen(lead.next_followup_at));
  } else {
    ctxLines.push('No follow-up scheduled.');
  }
  if (lastRemark) {
    ctxLines.push(`Latest rep remark by ${lastRemark.by_name || 'rep'} (${_agoLabel(lastRemark.created_at)}): "${String(lastRemark.remark || '').slice(0, 250)}"`);
  }
  if (lead.notes) {
    ctxLines.push(`Lead notes field: ${String(lead.notes).slice(0, 250)}`);
  }
  if (lastCallAttempt) {
    const dur = Number(lastCallAttempt.duration_s || 0);
    const isMissed = (lastCallAttempt.direction === 'missed') || dur === 0;
    ctxLines.push(`Last call attempt by ${lastCallAttempt.agent_name || 'agent'}: ${isMissed ? 'NOT CONNECTED' : dur + 's connected'} (${_agoLabel(lastCallAttempt.created_at)})`);
  } else {
    ctxLines.push('No call activity logged for this lead.');
  }
  if (lastInWa) {
    ctxLines.push(`LATEST INCOMING WHATSAPP from customer (${_agoLabel(lastInWa.created_at)}): "${String(lastInWa.body || '').slice(0, 300)}"`);
  } else if (lastInAny) {
    ctxLines.push(`Customer's latest inbound was media/sticker only (${_agoLabel(lastInAny.created_at)}) — no text to quote.`);
  } else {
    ctxLines.push('No incoming WhatsApp from customer.');
  }
  if (recentMsgs.length) {
    ctxLines.push('Recent WhatsApp thread:');
    recentMsgs.forEach(m => ctxLines.push(`  ${m.direction === 'in' ? 'Customer' : 'Rep'}: ${String(m.body || '').slice(0, 140)}`));
  }

  const system = `You are a tough, factual sales coach for an Indian sales rep.
RULES — output STRICT JSON only, exactly this shape:
{
  "summary": "2-3 sentences. MUST include: the AI score (X/100, category), the current status, the latest remark in quotes, AND either the missed follow-up alarm OR the next scheduled follow-up datetime OR a direct quote of the latest customer message. No greetings, no marketing fluff. Be specific with names and IST times.",
  "next_action": "ONE concrete action with a verb and timing. If a MISSED FOLLOW-UP alarm is present in the context, the next action MUST start with 'Call now — you missed the follow-up at <time>'. Otherwise use the freshest unanswered signal. NEVER write a chat message in this field. NEVER say 'follow up soon' without specifics.",
  "draft_msg": "Optional. 1-2 sentence WhatsApp draft for the customer. Only fill if there is an unanswered text from the customer in the last 48 hours. Otherwise return empty string."
}
No preamble. Output ONLY the JSON object.`;

  let summary = null, nextAction = null, draftMsg = null;
  if (gemini) {
    try {
      const res = await gemini.generate({
        prompt: ctxLines.join('\n'),
        system, temperature: 0.35, maxOutputTokens: 450,
        model: 'gemini-2.5-flash-lite'
      });
      if (res && res.ok && res.text) {
        const m = res.text.match(/\{[\s\S]*\}/);
        if (m) {
          const j = JSON.parse(m[0]);
          summary = j.summary || null;
          nextAction = j.next_action || null;
          draftMsg = j.draft_msg || null;
        }
        try { await gemini.logUsage({ feature: 'copilot_lead_summary', model: res.model,
              input_tokens: res.input_tokens, output_tokens: res.output_tokens, cost_usd: res.cost_usd }); } catch {}
      }
    } catch (e) {}
  }

  // Deterministic fallback when Gemini is down.
  if (!summary) {
    const scoreTxt = lead.smart_score != null ? `Score ${lead.smart_score}/100 (${lead.smart_category || '?'})` : '';
    summary = `${scoreTxt}. Status: ${lead.status_name || '?'}.`
      + (lastRemark ? ` Latest remark: "${String(lastRemark.remark || '').slice(0, 100)}".` : '');
    if (missedFollowup) {
      nextAction = `Call now — you missed the follow-up at ${missedFollowup.due_at_ist} (${missedFollowup.hours_overdue}h overdue). No action taken since.`;
    } else if (lead.next_followup_at) {
      nextAction = `Follow up at ${_istWhen(lead.next_followup_at)}.`;
    } else {
      nextAction = 'Schedule a follow-up — no next step on calendar.';
    }
    draftMsg = showDraft
      ? `Hi ${(lead.name || '').split(' ')[0] || 'there'}, just saw your message — getting back to you shortly.`
      : '';
  }

  try {
    await db.query(`
      INSERT INTO copilot_lead_summaries (lead_id, summary, next_action, draft_msg, payload_json)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (lead_id) DO UPDATE SET summary=EXCLUDED.summary, next_action=EXCLUDED.next_action,
          draft_msg=EXCLUDED.draft_msg, payload_json=EXCLUDED.payload_json, generated_at=NOW()`,
      [leadId, summary, nextAction, draftMsg || '', JSON.stringify({ ctx: ctxLines })]);
  } catch {}

  return {
    ok: true,
    summary, next_action: nextAction,
    draft_msg: showDraft ? (draftMsg || '') : '',
    show_draft: showDraft,
    last_activity_line: lastActivityLine,
    missed_followup: missedFollowup,
    smart_score: lead.smart_score,
    smart_category: lead.smart_category,
    generated_at: new Date().toISOString()
  };
}


// ── PHASE 3 — Signals list / dismiss / act ────────────────────────────
async function api_copilot_signals_list(token, payload) {
  const u = await _requireUser(token);
  // CP4_BACKEND_GATE_DROP (2026-06-16): same as briefing/summary —
  // the SPA already gates on brand.COPILOT_PROACTIVE_ENABLED before
  // polling this. The broken backend gate was returning empty signals
  // even on vserve where the flag is set, hiding the 🔔 badge.
  const limit = Math.min(20, Number((payload && payload.limit) || 12));

  try {
    const fresh = await _detectSignals(u.uid);
    await _persistSignals(u.uid, fresh);
  } catch {}

  let rows = [];
  try {
    const r = await db.query(`
      SELECT id, lead_id, signal_kind, severity, title, reason, payload_json, fired_at
        FROM copilot_signals
       WHERE user_id = $1 AND dismissed_at IS NULL AND acted_on_at IS NULL
       ORDER BY severity DESC, fired_at DESC LIMIT ${limit}`, [u.uid]);
    rows = r.rows;
  } catch {}

  const chips = rows.slice(0, 4).map(r => ({
    signal_id: r.id, label: r.title, kind: r.signal_kind, lead_id: r.lead_id
  }));
  return { ok: true, signals: rows, chips };
}

async function api_copilot_signal_dismiss(token, payload) {
  const u = await _requireUser(token);
  const id = Number(payload && payload.id);
  if (!id) return { ok: false, error: 'id required' };
  try { await db.query(`UPDATE copilot_signals SET dismissed_at=NOW() WHERE id=$1 AND user_id=$2`, [id, u.uid]); } catch {}
  return { ok: true };
}

async function api_copilot_signal_act(token, payload) {
  const u = await _requireUser(token);
  const id = Number(payload && payload.id);
  if (!id) return { ok: false, error: 'id required' };
  try { await db.query(`UPDATE copilot_signals SET acted_on_at=NOW() WHERE id=$1 AND user_id=$2`, [id, u.uid]); } catch {}
  return { ok: true };
}

// ── PHASE 5 — End-of-day recap ───────────────────────────────────────
async function api_copilot_eod_recap(token, payload) {
  const u = await _requireUser(token);
  const today = (payload && payload.date) || _todayIST();

  let plan = null;
  try {
    const r = await db.query(`SELECT payload_json FROM copilot_briefings WHERE user_id=$1 AND for_date=$2 LIMIT 1`, [u.uid, today]);
    plan = r.rows[0] && r.rows[0].payload_json;
  } catch {}

  let done = 0, total = (plan && plan.items && plan.items.length) || 0;
  if (plan && plan.items) {
    for (const it of plan.items) {
      if (it.signal_id) {
        try {
          const r = await db.query(`SELECT acted_on_at, dismissed_at FROM copilot_signals WHERE id=$1`, [it.signal_id]);
          if (r.rows[0] && (r.rows[0].acted_on_at || r.rows[0].dismissed_at)) done++;
        } catch {}
      }
    }
  }

  let newHot = 0;
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS n FROM leads
       WHERE assigned_to=$1 AND smart_category IN ('Hot','Warm') AND created_at::date = $2::date`,
      [u.uid, today]);
    newHot = (r.rows[0] && r.rows[0].n) || 0;
  } catch {}

  let tomorrowFu = 0;
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS n FROM leads
       WHERE assigned_to=$1 AND next_followup_at::date = ($2::date + INTERVAL '1 day')`,
      [u.uid, today]);
    tomorrowFu = (r.rows[0] && r.rows[0].n) || 0;
  } catch {}

  return {
    ok: true, date: today, planned: total, done,
    missed: Math.max(0, total - done),
    new_hot_today: newHot, followups_tomorrow: tomorrowFu,
    headline: `${done}/${total} done · ${newHot} new hot today · ${tomorrowFu} follow-up${tomorrowFu === 1 ? '' : 's'} tomorrow`
  };
}

// ── PHASE 6 — Unified lead timeline ──────────────────────────────────
async function api_copilot_lead_timeline(token, payload) {
  await _requireUser(token);
  const leadId = Number(payload && payload.lead_id);
  if (!leadId) return { ok: false, error: 'lead_id required' };
  const limit = Math.min(80, Number((payload && payload.limit) || 50));
  const events = [];

  try {
    const r = await db.query(`SELECT direction, body, media_type, created_at FROM whatsapp_messages WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 30`, [leadId]);
    for (const row of r.rows) events.push({ kind: 'wa', at: row.created_at, dir: row.direction, text: row.body, media: row.media_type });
  } catch {}
  try {
    const r = await db.query(`SELECT direction, duration_s, recording_url, created_at FROM call_events WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 30`, [leadId]);
    for (const row of r.rows) events.push({ kind: 'call', at: row.created_at, dir: row.direction, duration: row.duration_s, recording: row.recording_url });
  } catch {}
  try {
    const r = await db.query(`SELECT body, created_by_name, created_at FROM remarks WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 30`, [leadId]);
    for (const row of r.rows) events.push({ kind: 'remark', at: row.created_at, text: row.body, by: row.created_by_name });
  } catch {}
  try {
    const r = await db.query(`SELECT old_score, new_score, delta, trigger_event, reason_text, changed_at FROM lead_score_log WHERE lead_id=$1 ORDER BY changed_at DESC LIMIT 20`, [leadId]);
    for (const row of r.rows) events.push({ kind: 'score', at: row.changed_at, old: row.old_score, new: row.new_score, delta: row.delta, why: row.reason_text });
  } catch {}

  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return { ok: true, events: events.slice(0, limit) };
}

module.exports = {
  api_copilot_briefing,
  api_copilot_lead_summary,
  api_copilot_signals_list,
  api_copilot_signal_dismiss,
  api_copilot_signal_act,
  api_copilot_eod_recap,
  api_copilot_lead_timeline
};
