/**
 * utils/aiCallSummary.js
 *
 * Gemini 2.5 Flash-powered call summary worker.
 *
 *   Recording uploaded to /api/recordings  →  audio_bytes stored in Postgres
 *                       │
 *                       ▼
 *   Background worker (60s tick) picks recordings WHERE ai_processed_at IS NULL
 *                       │
 *                       ▼
 *   Upload audio to Gemini Files API (or inline if <20MB)
 *                       │
 *                       ▼
 *   Single Gemini 2.5 Flash prompt: transcribe + summarize + extract action
 *   items + sentiment + suggest next status. Returns structured JSON.
 *                       │
 *                       ▼
 *   Save transcript, summary, action_items (JSON), sentiment,
 *   suggested_status_id, ai_processed_at to lead_recordings.
 *
 * Why Gemini direct-from-audio (instead of Whisper + Claude):
 *   - 130x cheaper (~₹0.02 per 5-min call vs ₹2.6 with Whisper+Claude)
 *   - Single API call, simpler infra
 *   - Generous free tier (1,500 requests/day for Flash)
 *
 * Demo-mode behaviour:
 *   - Returns mock data without hitting Gemini, so prospects can see
 *     the feature without burning the platform's API budget.
 */

const db = require('../db/pg');
let demo = { on: false };
try { demo = require('./demoGuard'); } catch (_) { /* not in demo build */ }

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

// ----- Cost model (Gemini 2.5 Flash, audio in / text out) -----
// Gemini 2.5 Flash pricing as of mid-2025:
//   - Input  (text/image/audio/video): $0.30 per 1M tokens
//   - Output (text):                   $2.50 per 1M tokens
//   - Audio is tokenised at 32 tokens / second (so 1 min = 1920 tokens).
//
// All numbers here are USD per 1M tokens. The 30% markup we charge
// clients is applied at report time (utils/aiUsage.js _withMarkup),
// so this constant stays the raw vendor cost.
const GEMINI_INPUT_USD_PER_M  = 0.30;
const GEMINI_OUTPUT_USD_PER_M = 2.50;
const USD_TO_INR              = Number(process.env.USD_TO_INR_RATE || 84);

function _estimateCost(promptTokens, candidateTokens) {
  const inputCostUsd  = (Number(promptTokens) || 0) / 1_000_000 * GEMINI_INPUT_USD_PER_M;
  const outputCostUsd = (Number(candidateTokens) || 0) / 1_000_000 * GEMINI_OUTPUT_USD_PER_M;
  const totalUsd = inputCostUsd + outputCostUsd;
  return {
    input_usd:  Number(inputCostUsd.toFixed(6)),
    output_usd: Number(outputCostUsd.toFixed(6)),
    total_usd:  Number(totalUsd.toFixed(6)),
    total_inr:  Number((totalUsd * USD_TO_INR).toFixed(4))
  };
}
let fetch = global.fetch;
if (!fetch) { try { fetch = require('node-fetch'); } catch (_) {} }

function _key() {
  return process.env.GEMINI_API_KEY || '';
}

/** Pull the audio bytes back out of Postgres + the file metadata. */
async function _loadRecording(id) {
  const { rows } = await db.query(
    `SELECT id, lead_id, user_id, phone, direction, duration_s,
            mime_type, size_bytes, audio_bytes, started_at, created_at
       FROM lead_recordings WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** Persist the AI result back onto the row. */
async function _saveResult(id, fields) {
  const cols = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = $${i++}`);
    vals.push(v);
  }
  vals.push(id);
  await db.query(
    `UPDATE lead_recordings SET ${cols.join(', ')} WHERE id = $${i}`,
    vals
  );
}

/** Build the structured-output prompt — Gemini returns strict JSON. */
function _buildPrompt(meta) {
  return `You are a sales-CRM call analyst. The audio attached is a sales call.

Listen to the entire call. Then return ONLY a JSON object with these exact keys:

{
  "transcript": "<full verbatim transcript, speaker-labelled if possible — Rep / Customer>",
  "summary": "<3-sentence summary of what happened on the call>",
  "action_items": ["<short action 1>", "<short action 2>", ...],
  "sentiment": "<one of: positive | neutral | negative>",
  "suggested_status": "<one of the existing CRM statuses that best fits where this lead is now>",
  "next_followup_in_days": <integer 0-30 — when should the rep call back? 0 = today>,
  "key_insight": "<one-sentence insight that would surprise a busy manager>",
  "suggested_rating": <integer 1-5 — rate the REP's performance on this call.
    1 = poor (no qualifying, no objection handling, no next step),
    2 = below average,
    3 = average,
    4 = good (clear pitch, qualifying questions, objection handling),
    5 = excellent (booked next step, customer enthusiastic, all bases covered)>
}

Notes:
- Calls are mostly Hindi-English code-mixed. Transcribe in the language spoken.
- If the call is too short or unclear to summarise (<10s of speech), set summary to "Call too short to summarise" and leave other fields empty arrays/strings.
- Action items are concrete next steps (e.g. "Send Lakeview brochure", "Schedule site visit Saturday 11am").
- Output ONLY the JSON object. No markdown fences, no commentary.

Lead context:
  - Phone: ${meta.phone || 'unknown'}
  - Direction: ${meta.direction || 'out'}
  - Duration: ${meta.duration_s || 0}s`;
}

/**
 * Send a recording to Gemini and return the parsed AI response.
 *
 * Strategy:
 *   - For files <20 MB (≈25 min @ 12 KB/sec) — send inline base64
 *   - For larger files — upload to Files API first, then reference
 *
 * The single prompt asks Gemini to transcribe + summarise + extract
 * action items + sentiment + suggest next status, all in one shot.
 */
async function _callGemini(audioBytes, mimeType, meta) {
  const key = _key();
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const inline = audioBytes.length < 20 * 1024 * 1024;
  let parts;

  if (inline) {
    parts = [
      { inline_data: { mime_type: mimeType || 'audio/mp3', data: audioBytes.toString('base64') } },
      { text: _buildPrompt(meta) }
    ];
  } else {
    // Files API path — upload first, get a URI, reference it
    const uploadRes = await fetch(`${GEMINI_API}/files?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': mimeType || 'audio/mp3' },
      body: audioBytes
    });
    const upJson = await uploadRes.json();
    if (!uploadRes.ok || !upJson.file) {
      throw new Error('Gemini file upload failed: ' + JSON.stringify(upJson).slice(0, 200));
    }
    parts = [
      { file_data: { mime_type: mimeType || 'audio/mp3', file_uri: upJson.file.uri } },
      { text: _buildPrompt(meta) }
    ];
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
      maxOutputTokens: 4096
    }
  };

  const url = `${GEMINI_API}/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Gemini API failed: ' + JSON.stringify(j).slice(0, 300));

  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) throw new Error('Gemini returned empty response');

  let parsed;
  try {
    // Strip any accidental markdown fence
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error('Could not parse Gemini JSON: ' + text.slice(0, 200));
  }
  // Pull token usage out of the response so we can log per-tenant cost.
  const usage = j.usageMetadata || {};
  parsed.__tokens = {
    prompt: Number(usage.promptTokenCount) || 0,
    candidates: Number(usage.candidatesTokenCount) || 0,
    total: Number(usage.totalTokenCount) || 0
  };
  return parsed;
}

/** Look up the status_id by name (suggested_status from Gemini → real status_id). */
async function _statusIdByName(name) {
  if (!name) return null;
  try {
    const r = await db.findOneBy('statuses', 'name', String(name).trim());
    if (r) return r.id;
    // Fuzzy: try lowercase contains
    const all = await db.getAll('statuses').catch(() => []);
    const norm = String(name).toLowerCase().trim();
    const hit = all.find(s => String(s.name || '').toLowerCase().trim() === norm)
             || all.find(s => String(s.name || '').toLowerCase().includes(norm))
             || all.find(s => norm.includes(String(s.name || '').toLowerCase()));
    return hit ? hit.id : null;
  } catch (_) { return null; }
}

/** Process a single recording. Idempotent — re-running on a row that's
 * already been processed will overwrite the previous summary. */
async function processRecording(id) {
  const rec = await _loadRecording(id);
  if (!rec) throw new Error('Recording not found: ' + id);

  // Admin can disable AI transcription per-tenant.
  // Skip silently — the row stays unprocessed but the worker won't loop.
  try {
    const enabled = await db.getConfig('AI_TRANSCRIPTION_ENABLED', '1');
    if (String(enabled) === '0') {
      // Mark as processed-with-skip so the worker doesn't keep retrying.
      await _saveResult(id, {
        ai_processed_at: db.nowIso(),
        ai_provider: 'disabled',
        ai_model: 'none',
        ai_error: 'AI transcription disabled by admin'
      });
      return { ok: false, skipped: 'disabled', id };
    }
  } catch (_) {}

  // Demo mode — return mock data so the UI shows the feature working
  // without burning the platform's API quota.
  if (demo.on) {
    const mock = {
      transcript: '[DEMO] Rep: Hi sir, this is Priya from Celeste Abode. I\'m calling about the 3BHK at Skyview Towers...\nCustomer: Hello, yes I had enquired. Tell me about the price.\nRep: It\'s ₹1.25 crore including parking, GST extra...',
      summary: 'Rep introduced the 3BHK Skyview Tower unit at ₹1.25Cr. Customer confirmed interest, asked about parking + amenities, agreed to a site visit on Saturday.',
      action_items: ['Send Skyview brochure on WhatsApp', 'Schedule site visit Saturday 11 AM', 'Share parking floor-plan'],
      sentiment: 'positive',
      suggested_status: 'Site Visit Scheduled',
      next_followup_in_days: 5,
      key_insight: 'Customer\'s spouse has final say — Rep should arrange both partners on the site visit.',
      suggested_rating: 4
    };
    await _saveResult(id, {
      transcript: mock.transcript,
      summary: mock.summary,
      action_items: JSON.stringify(mock.action_items),
      sentiment: mock.sentiment,
      suggested_status_id: await _statusIdByName(mock.suggested_status),
      ai_suggested_rating: mock.suggested_rating,
      ai_processed_at: db.nowIso(),
      ai_provider: 'gemini-demo',
      ai_model: 'mock',
      ai_error: null
    });
    return { ok: true, demo: true, id };
  }

  if (!_key()) throw new Error('GEMINI_API_KEY not configured');
  if (!rec.audio_bytes || rec.audio_bytes.length === 0) {
    throw new Error('Recording has no audio bytes');
  }

  const ai = await _callGemini(rec.audio_bytes, rec.mime_type, {
    phone: rec.phone, direction: rec.direction, duration_s: rec.duration_s
  });

  const suggested_status_id = await _statusIdByName(ai.suggested_status);

  let suggestedRating = Number(ai.suggested_rating);
  if (!Number.isFinite(suggestedRating) || suggestedRating < 1 || suggestedRating > 5) {
    suggestedRating = null;
  }

  // Per-call usage + cost from Gemini's usageMetadata. Saved on the
  // recording row so the AI Usage report can aggregate per-tenant /
  // per-rep / per-month spend without us hitting Google's billing API.
  const tk = ai.__tokens || { prompt: 0, candidates: 0, total: 0 };
  const cost = _estimateCost(tk.prompt, tk.candidates);

  await _saveResult(id, {
    transcript: ai.transcript || '',
    summary: ai.summary || '',
    action_items: JSON.stringify(ai.action_items || []),
    sentiment: ai.sentiment || null,
    suggested_status_id,
    ai_processed_at: db.nowIso(),
    ai_provider: 'gemini',
    ai_model: GEMINI_MODEL,
    ai_error: null,
    next_followup_days: Number(ai.next_followup_in_days) || null,
    key_insight: ai.key_insight || null,
    ai_suggested_rating: suggestedRating,
    ai_input_tokens:  tk.prompt,
    ai_output_tokens: tk.candidates,
    ai_cost_usd: cost.total_usd,
    ai_cost_inr: cost.total_inr
  });

  return { ok: true, id, summary: ai.summary };
}

/** Background worker — finds unprocessed recordings and runs them. */
let _workerTimer = null;
let _processing = false;

async function _tick() {
  if (_processing) return;
  if (!_key() && !demo.on) return; // No key + not demo — nothing to do
  _processing = true;
  try {
    const { rows } = await db.query(
      `SELECT id FROM lead_recordings
       WHERE ai_processed_at IS NULL
         AND (ai_error IS NULL OR ai_error = '')
       ORDER BY created_at ASC
       LIMIT 5`
    );
    for (const r of rows) {
      try {
        console.log('[ai-summary] processing recording', r.id);
        await processRecording(r.id);
        console.log('[ai-summary] ✓ recording', r.id, 'done');
      } catch (e) {
        console.error('[ai-summary] ✗ recording', r.id, ':', e.message);
        await _saveResult(r.id, { ai_error: String(e.message).slice(0, 500), ai_processed_at: db.nowIso() }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[ai-summary] worker error:', e.message);
  } finally {
    _processing = false;
  }
}

function startWorker() {
  if (_workerTimer) return;
  // First tick after 30s (let server settle), then every 60s
  setTimeout(_tick, 30_000);
  _workerTimer = setInterval(_tick, 60_000);
  console.log('[ai-summary] worker started — Gemini', _key() ? 'configured' : (demo.on ? 'demo-mock' : 'NOT configured'));
}

module.exports = { processRecording, startWorker, GEMINI_MODEL };
