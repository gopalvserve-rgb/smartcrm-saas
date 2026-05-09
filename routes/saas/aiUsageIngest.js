/**
 * routes/saas/aiUsageIngest.js
 *
 * Cross-deployment AI usage ingester.
 *
 * Other CRM deployments (Stockbox, Celeste, ad-hoc clones) call our
 * Gemini key under the operator's account. We want a SINGLE costing
 * dashboard that aggregates spend across all of them. This module
 * exposes a public POST endpoint:
 *
 *   POST /ai-usage/ingest
 *     headers: { Authorization: 'Bearer <AI_USAGE_INGEST_TOKEN>' }
 *     body: {
 *       tenant_slug:     'stockbox' | 'celeste' | ...      // required
 *       call_kind:       'reply' | 'copilot' | ...
 *       model:           'gemini-2.5-flash-lite'
 *       input_tokens:    Number
 *       output_tokens:   Number
 *       cost_usd:        Number
 *       cost_inr_real:   Number
 *       cost_inr_billed: Number  (already-marked-up figure for the customer)
 *       phone:           optional string
 *       lead_id:         optional number
 *       wa_message_id:   optional string
 *       error_text:      optional string (set when call failed)
 *     }
 *
 * Auth: a single shared secret in process.env.AI_USAGE_INGEST_TOKEN.
 * Rotate it occasionally; both this and every reporting deployment
 * read the same value from their respective env.
 *
 * The row lands in control.ai_usage_log with tenant_slug populated,
 * which the existing /admin/ AI Costing dashboard already groups by —
 * so stockbox / celeste / showcase / vserve all appear side-by-side
 * with no UI change.
 */
'use strict';

const control = require('../../control/db');

/**
 * Express handler — mounted at app.post('/ai-usage/ingest', ...) in server.js.
 */
async function expressIngest(req, res) {
  // ---- Auth ---------------------------------------------------------
  const expected = String(process.env.AI_USAGE_INGEST_TOKEN || '').trim();
  if (!expected) {
    // Deployment hasn't set the secret yet — refuse loudly so the
    // operator notices in logs and configures it.
    return res.status(503).json({
      error: 'ingest_disabled',
      detail: 'Set AI_USAGE_INGEST_TOKEN in env to enable this endpoint.'
    });
  }
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const got = m ? m[1].trim() : '';
  // Constant-time-ish comparison
  if (!got || got.length !== expected.length || got !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // ---- Validate body ------------------------------------------------
  const b = req.body || {};
  const slug = String(b.tenant_slug || '').toLowerCase().trim();
  if (!slug || !/^[a-z0-9_-]{1,64}$/.test(slug)) {
    return res.status(400).json({ error: 'invalid_tenant_slug' });
  }
  const callKind = String(b.call_kind || 'reply').slice(0, 32);
  const model    = String(b.model || '').slice(0, 80);
  const numI     = (k) => { const v = Number(k); return Number.isFinite(v) ? v : 0; };
  const inTok    = Math.max(0, Math.floor(numI(b.input_tokens)));
  const outTok   = Math.max(0, Math.floor(numI(b.output_tokens)));
  const costUsd  = Math.max(0, numI(b.cost_usd));
  const costInr  = Math.max(0, numI(b.cost_inr_real));
  const costBil  = Math.max(0, numI(b.cost_inr_billed));
  const phone    = b.phone ? String(b.phone).slice(0, 32) : null;
  const leadId   = b.lead_id != null ? Math.floor(Number(b.lead_id)) || null : null;
  const waMsgId  = b.wa_message_id ? String(b.wa_message_id).slice(0, 128) : null;
  const errText  = b.error_text ? String(b.error_text).slice(0, 500) : null;

  // ---- Optional tenant_id resolution -------------------------------
  // If the slug matches a tenant in the control DB (e.g. an actual
  // SaaS tenant), link it. Otherwise leave tenant_id NULL — the slug
  // is enough for the dashboard's GROUP BY.
  let tenantId = null;
  try {
    const r = await control.query(`SELECT id FROM tenants WHERE slug = $1 LIMIT 1`, [slug]);
    if (r.rows[0]) tenantId = Number(r.rows[0].id);
  } catch (_) {}

  // ---- Insert -------------------------------------------------------
  try {
    await control.query(
      `INSERT INTO ai_usage_log
         (tenant_id, tenant_slug, call_kind, model, input_tokens, output_tokens,
          cost_usd, cost_inr_real, cost_inr_billed,
          phone, lead_id, wa_message_id, error_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [tenantId, slug, callKind, model, inTok, outTok, costUsd, costInr, costBil, phone, leadId, waMsgId, errText]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.warn('[ai-usage-ingest]', e.message);
    return res.status(500).json({ error: 'insert_failed', detail: e.message });
  }
}

module.exports = { expressIngest };
