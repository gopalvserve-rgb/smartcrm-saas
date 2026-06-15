/**
 * QNOTE_ROLLOUT_ALL_v1 — flip on the ✨ AI Quick Note row button for every
 * tenant.
 *
 * QNote was originally vserve-only, gated by either `AI_QUICKNOTE_ENABLED`
 * OR `COPILOT_ACTIONS_ENABLED` (legacy carve-out). tenantBootstrap was
 * updated to seed `AI_QUICKNOTE_ENABLED=1` on every NEW tenant. This
 * module is the one-shot bulk rollout for everything already provisioned.
 *
 * Simpler than the LS rollout — QNote has no schema, no per-lead state,
 * just a single config flag to flip. No recompute step needed.
 *
 * APIs (POST /api/saas with fn=…):
 *   api_saas_quickNote_rolloutPreview(token)
 *     → for each active tenant: is the flag already on? Returns counts.
 *   api_saas_quickNote_rolloutRun(token, { tenant_slug? })
 *     → ensureTenantReady → UPSERT config flag. Optionally per-tenant.
 */

const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin } = require('./superAdminAuth');

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
    const r1 = await pool.query(`SELECT value FROM config WHERE key = 'AI_QUICKNOTE_ENABLED'`);
    const r2 = await pool.query(`SELECT value FROM config WHERE key = 'COPILOT_ACTIONS_ENABLED'`);
    const flagOn = (r1.rows[0] && r1.rows[0].value === '1');
    const legacyOn = (r2.rows[0] && r2.rows[0].value === '1');
    return {
      slug: tenant.slug,
      org_name: tenant.org_name,
      flag_on: flagOn,
      legacy_carveout_on: legacyOn,
      effective_on: flagOn || legacyOn
    };
  } catch (e) {
    return { slug: tenant.slug, error: e.message };
  }
}

async function _rolloutTenant(tenant) {
  const pool = tenantPool.poolFor(tenant);
  if (!pool) return { slug: tenant.slug, error: 'no pool' };
  const out = { slug: tenant.slug, org_name: tenant.org_name, config_set: false };
  try {
    const { ensureTenantReady } = require('../../utils/tenantBootstrap');
    await ensureTenantReady(pool);
  } catch (e) { out.bootstrap_error = e.message; }
  try {
    await pool.query(
      `INSERT INTO config (key, value) VALUES ('AI_QUICKNOTE_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    out.config_set = true;
  } catch (e) { out.config_error = e.message; }
  return out;
}

async function api_saas_quickNote_rolloutPreview(token) {
  await requireSuperAdmin(token);
  const tenants = await _activeTenants();
  const rows = [];
  let onCount = 0;
  for (const t of tenants) {
    const r = await _previewTenant(t);
    if (r.effective_on) onCount++;
    rows.push(r);
  }
  return {
    tenants_scanned: tenants.length,
    tenants_already_on: onCount,
    tenants_to_enable: tenants.length - onCount,
    per_tenant: rows
  };
}

async function api_saas_quickNote_rolloutRun(token, payload) {
  await requireSuperAdmin(token);
  const onlySlug = payload && payload.tenant_slug;
  const all = await _activeTenants();
  const tenants = onlySlug ? all.filter(t => t.slug === onlySlug) : all;
  const results = [];
  let enabled = 0;
  for (const t of tenants) {
    const r = await _rolloutTenant(t);
    results.push(r);
    if (r.config_set) enabled++;
  }
  return {
    tenants_processed: tenants.length,
    tenants_enabled: enabled,
    per_tenant: results
  };
}

module.exports = {
  api_saas_quickNote_rolloutPreview,
  api_saas_quickNote_rolloutRun
};
