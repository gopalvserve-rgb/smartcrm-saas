/**
 * routes/saas/ticketTriage.js — TICKET_AI_TRIAGE_v1 (2026-09-06)
 *
 * Classify each support ticket into ONE of three segments using ONLY the
 * Copilot knowledge base (copilot_kb: video guides, process guides, question
 * bank, help FAQ):
 *
 *   ai_answered      — the KB contains the answer. We draft that answer and
 *                      (when posting is on) reply, marking it "Answered by AI".
 *   ai_need_details  — the question is understood but cannot be answered without
 *                      more information from the customer. We draft a short
 *                      "need more details" reply listing exactly what to send.
 *   ai_unclear       — we cannot understand the query, OR the KB has no answer.
 *                      Left for a human ("AI not capable"). No customer reply.
 *
 * GROUNDING: the model is instructed to answer ONLY from the supplied KB
 * snippets. If the KB does not cover the question it MUST return ai_unclear —
 * it may not invent steps. That keeps AI replies safe to send to customers.
 *
 * The heavy lifting (KB search, Gemini) uses modules that already run on every
 * worker, so a standalone script can triage tickets without a deploy; the
 * api_* wrappers expose the same logic to the super-admin UI once deployed.
 */
'use strict';

const control = require('../../control/db');
const gemini = require('../../utils/geminiClient');
const kb = require('./copilotKb');
let requireSuperAdmin; try { ({ requireSuperAdmin } = require('./superAdminAuth')); } catch (_) { requireSuperAdmin = async () => ({}); }

const SEGMENTS = ['ai_answered', 'ai_need_details', 'ai_unclear'];

/* ---- schema (additive, idempotent) ---- */
let _cols = false;
async function ensureCols() {
  if (_cols) return;
  await control.query(
    `ALTER TABLE support_tickets
       ADD COLUMN IF NOT EXISTS ai_segment    TEXT,
       ADD COLUMN IF NOT EXISTS ai_reply       TEXT,
       ADD COLUMN IF NOT EXISTS ai_reason      TEXT,
       ADD COLUMN IF NOT EXISTS ai_confidence  INTEGER,
       ADD COLUMN IF NOT EXISTS ai_posted      INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS ai_at          TIMESTAMPTZ`);
  await control.query(`CREATE INDEX IF NOT EXISTS idx_support_tickets_aiseg ON support_tickets(ai_segment)`);
  _cols = true;
}

/* ---- gather KB context for a ticket ---- */
async function gatherContext(subject, description) {
  const q = (String(subject || '') + ' ' + String(description || '')).slice(0, 400);
  let hits = [];
  try { hits = await kb.lookupActive(q, 6); } catch (_) { hits = []; }
  return hits.map((h, i) =>
    '### KB ' + (i + 1) + ': ' + (h.title || '') + '\n' + String(h.body || '').slice(0, 1500)
  ).join('\n\n');
}

const SYSTEM = [
  'You are the support triage assistant for SmartCRM.',
  'You are given a customer support ticket and a set of KNOWLEDGE BASE (KB) snippets.',
  'Decide EXACTLY ONE segment and reply with STRICT JSON only, no prose, no markdown:',
  '{ "segment": "ai_answered" | "ai_need_details" | "ai_unclear",',
  '  "answer": "<the reply to send the customer, or empty>",',
  '  "reason": "<one short line on why you chose this segment>",',
  '  "confidence": <0-100> }',
  '',
  'RULES:',
  '1. "ai_answered" ONLY when the KB snippets clearly contain the solution. The',
  '   "answer" must be built STRICTLY from those snippets — do not invent steps,',
  '   settings, prices, URLs or features that are not in the KB. Write it as a',
  '   clear, polite, step-by-step reply to the customer. Keep it under 900 chars.',
  '2. "ai_need_details" when you understand the question but genuinely cannot',
  '   answer without more information from the customer. Put a short, specific',
  '   list of what they should send (e.g. screenshot of which screen, which',
  '   number, which step fails) into "answer".',
  '3. "ai_unclear" when you cannot understand the request OR the KB does not',
  '   cover it. Leave "answer" empty. Never guess an answer that is not in the KB.',
  'When unsure between answered and unclear, choose ai_unclear — a wrong answer',
  'to a customer is worse than escalating to a human.'
].join('\n');

/* ---- classify one ticket (no DB writes, no posting) ---- */
async function classify(subject, description) {
  const ctx = await gatherContext(subject, description);
  const prompt =
    'KNOWLEDGE BASE SNIPPETS:\n' + (ctx || '(none found)') +
    '\n\n----\nCUSTOMER TICKET\nSubject: ' + String(subject || '') +
    '\nDescription: ' + String(description || '') +
    '\n\nReturn the strict JSON now.';
  let res;
  try {
    res = await gemini.generate({
      system: SYSTEM, prompt,
      feature: 'ticket_triage', call_kind: 'ticket_triage',
      maxOutputTokens: 700, temperature: 0.1
    });
  } catch (e) {
    return { segment: 'ai_unclear', answer: '', reason: 'AI error: ' + e.message, confidence: 0, ok: false };
  }
  if (!res || !res.ok) {
    return { segment: 'ai_unclear', answer: '', reason: 'AI unavailable' + (res && res.error ? ': ' + res.error : ''), confidence: 0, ok: false };
  }
  let j = null;
  try {
    const m = String(res.text || '').match(/\{[\s\S]*\}/);
    if (m) j = JSON.parse(m[0]);
  } catch (_) { j = null; }
  if (!j || !SEGMENTS.includes(j.segment)) {
    return { segment: 'ai_unclear', answer: '', reason: 'Could not parse AI decision', confidence: 0, ok: true, kb_used: !!ctx };
  }
  let answer = String(j.answer || '').trim().slice(0, 1000);
  // safety: answered MUST have a non-trivial answer AND some KB context to draw on
  if (j.segment === 'ai_answered' && (!answer || !ctx)) {
    return { segment: 'ai_unclear', answer: '', reason: 'Marked answered but no grounded answer', confidence: Number(j.confidence) || 0, ok: true, kb_used: !!ctx };
  }
  if (j.segment === 'ai_unclear') answer = '';
  return { segment: j.segment, answer, reason: String(j.reason || '').slice(0, 300), confidence: Math.max(0, Math.min(100, Number(j.confidence) || 0)), ok: true, kb_used: !!ctx };
}

/* ---- post an AI reply on a ticket (author_type 'admin', clearly marked) ---- */
async function _postReply(ticket, bodyText) {
  const body = bodyText.trim() + '\n\n— Answered by AI (SmartCRM Assistant). Reply here if you need more help.';
  await control.insert('support_ticket_replies', {
    ticket_id: ticket.id, author_type: 'admin', author_id: 0,
    author_name: 'SmartCRM AI', author_email: '', body, is_internal: 0
  });
  await control.query(
    `UPDATE support_tickets
        SET reply_count = reply_count + 1, last_reply_at = NOW(), last_reply_by = 'admin',
            status = CASE WHEN status IN ('open','reopened','in_progress') THEN 'waiting_customer' ELSE status END,
            updated_at = NOW()
      WHERE id = $1`, [ticket.id]);
}

/* ---- triage one ticket: classify, store, optionally post ---- */
// AI only replies while the ticket is OPEN/NEW and the ball is in our court —
// never on waiting_customer (we already replied), resolved or closed.
const POSTABLE_STATUS = ['open', 'reopened', 'in_progress'];
async function triageOne(ticketId, opts) {
  await ensureCols();
  const post = !!(opts && opts.post);
  const t = await control.findById('support_tickets', Number(ticketId));
  if (!t) throw new Error('Ticket not found');
  const c = await classify(t.subject, t.description);

  let posted = 0;
  const canPost = post
    && POSTABLE_STATUS.includes(String(t.status))
    && (c.segment === 'ai_answered' || c.segment === 'ai_need_details')
    && c.answer;
  if (canPost) {
    try { await _postReply(t, c.answer); posted = 1; } catch (e) { c.reason += ' | post failed: ' + e.message; }
  }
  await control.query(
    `UPDATE support_tickets
        SET ai_segment=$1, ai_reply=$2, ai_reason=$3, ai_confidence=$4, ai_posted=$5, ai_at=NOW()
      WHERE id=$6`,
    [c.segment, c.answer || '', c.reason || '', c.confidence || 0, posted, t.id]);
  return { ticket_id: t.id, ticket_number: t.ticket_number, segment: c.segment,
           confidence: c.confidence, posted: !!posted, answer: c.answer, reason: c.reason };
}

/* ---- batch: triage tickets that need it ---- */
async function triageBatch(opts) {
  await ensureCols();
  const o = opts || {};
  const post = !!o.post;
  const limit = Math.max(1, Math.min(Number(o.limit) || 50, 500));
  // Default scope = OPEN / NEW tickets (open, reopened, in_progress). When
  // posting, these are also the only statuses triageOne will reply on.
  const statusFilter = o.all ? '' : `AND status IN ('open','reopened','in_progress')`;
  const redo = o.redo ? '' : 'AND ai_segment IS NULL';
  const rows = (await control.query(
    `SELECT id FROM support_tickets WHERE 1=1 ${statusFilter} ${redo}
      ORDER BY created_at DESC LIMIT ${limit}`)).rows;
  const out = { total: rows.length, ai_answered: 0, ai_need_details: 0, ai_unclear: 0, posted: 0, results: [] };
  for (const r of rows) {
    try {
      const res = await triageOne(r.id, { post });
      out[res.segment] = (out[res.segment] || 0) + 1;
      if (res.posted) out.posted++;
      out.results.push(res);
    } catch (e) { out.results.push({ ticket_id: r.id, segment: 'error', reason: e.message }); }
  }
  return out;
}

/* ---- super-admin API wrappers ---- */
async function api_saas_tk_admin_aiTriage(token, payload) {
  await requireSuperAdmin(token);
  const p = payload || {};
  if (!p.ticket_id) throw new Error('ticket_id required');
  return await triageOne(p.ticket_id, { post: !!p.post });
}
async function api_saas_tk_admin_aiTriageBatch(token, payload) {
  await requireSuperAdmin(token);
  return await triageBatch(payload || {});
}
/* counts per segment, for the filter chips */
async function api_saas_tk_admin_aiCounts(token) {
  await requireSuperAdmin(token);
  await ensureCols();
  const r = (await control.query(
    `SELECT COALESCE(ai_segment,'untriaged') AS seg, COUNT(*)::int AS n
       FROM support_tickets GROUP BY 1`)).rows;
  const out = { ai_answered: 0, ai_need_details: 0, ai_unclear: 0, untriaged: 0 };
  r.forEach(x => { out[x.seg] = x.n; });
  return out;
}

/* Fire-and-forget triage for a brand-new ticket: classify and, if AI Capable or
 * Need-more-details, reply immediately. Never throws into the caller. */
function autoTriageNewTicket(ticketId) {
  setImmediate(() => {
    triageOne(ticketId, { post: true })
      .then(r => console.log('[ticket-triage] #' + (r.ticket_number||ticketId) + ' -> ' + r.segment + (r.posted?' (replied)':'')))
      .catch(e => console.warn('[ticket-triage] auto failed for ' + ticketId + ': ' + e.message));
  });
}

module.exports = {
  ensureCols, classify, triageOne, triageBatch,
  api_saas_tk_admin_aiTriage, api_saas_tk_admin_aiTriageBatch, api_saas_tk_admin_aiCounts,
  autoTriageNewTicket
};
