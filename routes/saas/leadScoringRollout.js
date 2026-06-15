/**
 * LS_ROLLOUT_ALL_v1 — flip on AI Lead Scoring for every tenant.
 *
 * Three things have to be true for an existing tenant to actually use it:
 *   1) config.LEAD_SCORING_ENABLED = '1' — gates the SPA-visible feature
 *   2) lead_score_settings.is_enabled = 1 — gates the engine itself
 *   3) leads have smart_score / smart_category populated for the visible
 *      column + bucket filters to mean anything
 *
 * tenantBootstrap was updated to set #1 and #2 as defaults so all new
 * tenants get it automatically. This module is the one-shot bulk rollout
 * for everything that's already provisioned. The recompute is paged so a
 * tenant with 100k leads doesn't blow up — default is 5000 most recent
 * leads, configurable via `recompute_limit`.
 *
 * APIs (POST /api/saas with fn=…):
 *   api_saas_leadScoring_rolloutPreview(token)
 *     → counts: tenants, leads with scores, leads without — no writes
 *   api_saas_leadScoring_rolloutRun(token, { tenant_slug?, recompute_limit? })
 *     → for each active tenant: ensureTenantReady → set config flag →
 *       set lead_score_settings.is_enabled=1 → recompute most-recent N leads.
 *       Returns per-tenant {enabled, scored} counts.
 */

const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin } = require('./superAdminAuth');

const DEFAULT_RECOMPUTE_LIMIT = 5000;

function _activeTenants() {
  return control.query(
    `SELECT id, slug, org_name, db_name, status
       FROM tenants
      WHERE status IN ('active','trial','past_due')
      ORDER BY id ASC`
  ).then(r => r.rows);
}

async function _previewTenant(tenant) {
  const pool = tenantPool.poolFor(tenant);
  if (!pool) return { slug: tenant.slug, error: 'no pool' };
  try {
    const cfg = await pool.query(
      `SELECT value FROM config WHERE key = 'LEAD_SCORING_ENABLED'`
    );
    let engineOn = false;
    try {
      const eng = await pool.query(`SELECT is_enabled FROM lead_score_settings WHERE id = 1`);
      engineOn = !!(eng.rows[0] && Number(eng.rows[0].is_enabled) === 1);
    } catch (_) { /* table not provisioned yet */ }
    const total = (await pool.query(`SELECT COUNT(*)::INT AS n FROM leads`)).rows[0].n;
    let scored = 0;
    try {
      scored = (await pool.query(
        `SELECT COUNT(*)::INT AS n FROM leads WHERE smart_score IS NOT NULL`
      )).rows[0].n;
    } catch (_) { /* smart_score column not added */ }
    return {
      slug: tenant.slug,
      org_name: tenant.org_name,
      config_on: cfg.rows[0] && cfg.rows[0].value === '1',
      engine_on: engineOn,
      total_leads: total,
      scored_leads: scored,
      unscored_leads: total - scored
    };
  } catch (e) {
    return { slug: tenant.slug, error: e.message };
  }
}

async function _rolloutTenant(tenant, recomputeLimit) {
  const pool = tenantPool.poolFor(tenant);
  if (!pool) return { slug: tenant.slug, error: 'no pool' };
  const out = { slug: tenant.slug, org_name: tenant.org_name, config_set: false, engine_enabled: false, scored: 0 };

  // 1) ensureTenantReady — runs schema migrations + seeds CONFIG_DEFAULTS
  //    (the new LEAD_SCORING_ENABLED=1 entry will be auto-seeded here if
  //    config doesn't have it). Idempotent.
  try {
    const { ensureTenantReady } = require('../../utils/tenantBootstrap');
    await ensureTenantReady(pool);
  } catch (e) { out.bootstrap_error = e.message; }

  // 2) Explicitly UPSERT the config flag so already-bootstrapped tenants
  //    (which the bootstrap won't re-seed) also flip on.
  try {
    await pool.query(
      `INSERT INTO config (key, value) VALUES ('LEAD_SCORING_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    out.config_set = true;
  } catch (e) { out.config_error = e.message; }

  // 3) Make sure the leadScoring schema is materialised on this tenant
  //    then flip lead_score_settings.is_enabled=1.
  try {
    const leadScoring = require('../leadScoring');
    if (typeof leadScoring._ensureSchema === 'function') {
      await leadScoring._ensureSchema(pool);
    }
  } catch (e) { out.schema_error = e.message; }
  try {
    const u = await pool.query(
      `UPDATE lead_score_settings SET is_enabled = 1 WHERE id = 1`
    );
    out.engine_enabled = (u.rowCount > 0);
    if (!out.engine_enabled) {
      // Singleton row might not exist on a brand-new tenant — insert it.
      await pool.query(
        `INSERT INTO lead_score_settings (id, is_enabled) VALUES (1, 1)
         ON CONFLICT (id) DO UPDATE SET is_enabled = 1`
      );
      out.engine_enabled = true;
    }
  } catch (e) { out.engine_error = e.message; }

  // 4) Score the most-recent N leads. Pull just IDs, then call the
  //    engine one-by-one. Capped so a tenant with 100k leads can't
  //    blow up the rollout job. Older leads get scored on their next
  //    edit / event hook.
  try {
    const ids = (await pool.query(
      `SELECT id FROM leads ORDER BY id DESC LIMIT $1`,
      [Math.max(1, Number(recomputeLimit) || DEFAULT_RECOMPUTE_LIMIT)]
    )).rows;
    const leadScoring = require('../leadScoring');
    if (typeof leadScoring.recomputeLeadScore === 'function') {
      // Run in a tenant pool context so recomputeLeadScore uses the
      // right DB. We loop sequentially — recomputeLeadScore is single
      // SQL roundtrip per lead so this is fine for a few thousand.
      const { tenantStorage } = require('../../db/pg');
      await tenantStorage.run({ pool, tenant }, async () => {
        for (const row of ids) {
          try {
            await leadScoring.recomputeLeadScore(row.id, 'rollout');
            out.scored++;
          } catch (_) { /* per-lead failures skipped */ }
        }
      });
    }
  } catch (e) { out.score_error = e.message; }

  return out;
}

async function api_saas_leadScoring_rolloutPreview(token) {
  await requireSuperAdmin(token);
  const tenants = await _activeTenants();
  const rows = [];
  for (const t of tenants) {
    rows.push(await _previewTenant(t));
  }
  let totalLeads = 0, totalScored = 0, totalUnscored = 0, onCount = 0;
  for (const r of rows) {
    totalLeads += Number(r.total_leads) || 0;
    totalScored += Number(r.scored_leads) || 0;
    totalUnscored += Number(r.unscored_leads) || 0;
    if (r.config_on && r.engine_on) onCount++;
  }
  return {
    tenants_scanned: tenants.length,
    tenants_already_on: onCount,
    tenants_to_enable: tenants.length - onCount,
    total_leads: totalLeads,
    leads_already_scored: totalScored,
    leads_unscored: totalUnscored,
    per_tenant: rows
  };
}

async function api_saas_leadScoring_rolloutRun(token, payload) {
  await requireSuperAdmin(token);
  const recomputeLimit = Number(payload && payload.recompute_limit) || DEFAULT_RECOMPUTE_LIMIT;
  const onlySlug = payload && payload.tenant_slug;
  const all = await _activeTenants();
  const tenants = onlySlug ? all.filter(t => t.slug === onlySlug) : all;
  const results = [];
  let totalScored = 0, totalEnabled = 0;
  for (const t of tenants) {
    const r = await _rolloutTenant(t, recomputeLimit);
    results.push(r);
    if (r.engine_enabled) totalEnabled++;
    totalScored += Number(r.scored) || 0;
  }
  return {
    tenants_processed: tenants.length,
    tenants_enabled: totalEnabled,
    total_leads_scored: totalScored,
    recompute_limit_per_tenant: recomputeLimit,
    per_tenant: results
  };
}

module.exports = {
  api_saas_leadScoring_rolloutPreview,
  api_saas_leadScoring_rolloutRun
};
