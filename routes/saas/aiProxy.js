/**
 * routes/saas/aiProxy.js
 *
 * Cross-deployment Gemini proxy. Lets Stockbox / Celeste (or any other
 * downstream CRM) call Gemini THROUGH smartcrm-saas instead of using
 * their own API key. The proxy:
 *
 *   1. Auths the caller with a shared secret (AI_PROXY_TOKEN env)
 *   2. Runs the Gemini request using smartcrm-saas's own key
 *      (utils/geminiClient.loadSettings)
 *   3. Logs the usage to the control-plane ai_usage_log with the
 *      caller's tenant slug — so the super-admin AI Costing board
 *      shows tenant-by-tenant breakdown
 *   4. Returns Gemini's response payload to the caller
 *
 * Endpoint:
 *   POST /ai/proxy/generate
 *     headers: Authorization: Bearer <AI_PROXY_TOKEN>
 *     body:    {
 *       tenant_slug, call_kind ('reply'|'audit'|'kb_qa'|'copilot'),
 *       system, history, prompt, model,
 *       maxOutputTokens, temperature
 *     }
 *     returns: { ok, text, model, input_tokens, output_tokens,
 *                cost_usd, cost_inr_real, cost_inr_billed, error }
 */

'use strict';

const geminiClient = require('../../utils/geminiClient');
const controlDb    = require('../../control/db');

async function expressGenerate(req, res) {
  const expected = String(process.env.AI_PROXY_TOKEN || '').trim();
  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: 'AI proxy disabled — set AI_PROXY_TOKEN env on smartcrm-saas to enable.'
    });
  }
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (got !== expected) return res.status(401).json({ ok: false, error: 'Bad token' });

  const b = req.body || {};
  const tenantSlug = String(b.tenant_slug || '').trim().toLowerCase();
  if (!tenantSlug) return res.status(400).json({ ok: false, error: 'tenant_slug required' });
  if (!b.prompt && !(b.history && b.history.length)) {
    return res.status(400).json({ ok: false, error: 'prompt or history required' });
  }

  // Run Gemini using smartcrm-saas's stored key
  try {
    const result = await geminiClient.generate({
      system:          b.system || '',
      history:         Array.isArray(b.history) ? b.history : [],
      prompt:          b.prompt || '',
      model:           b.model || undefined,
      maxOutputTokens: Number(b.maxOutputTokens) || undefined,
      temperature:     Number.isFinite(b.temperature) ? b.temperature : undefined,
    });

    // Log to control-plane ai_usage_log with the caller's tenant
    try {
      const callKind = String(b.call_kind || 'reply').slice(0, 32);
      await controlDb.query(
        `INSERT INTO ai_usage_log
           (tenant_slug, call_kind, model, input_tokens, output_tokens,
            cost_usd, cost_inr_real, cost_inr_billed, phone, lead_id,
            error_text, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())`,
        [
          tenantSlug, callKind, result.model || '',
          result.input_tokens || 0, result.output_tokens || 0,
          result.cost_usd || 0, result.cost_inr_real || 0, result.cost_inr_billed || 0,
          b.phone || null, b.lead_id || null,
          result.ok ? null : String(result.error || '').slice(0, 500)
        ]
      );
    } catch (e) {
      console.warn('[ai-proxy] usage log failed:', e.message);
    }
    return res.json(result);
  } catch (e) {
    console.error('[ai-proxy] generate failed:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { expressGenerate };
