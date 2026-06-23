/**
 * LEADS_VIEW_V2_ROLLOUT_v1 (2026-06-24) — flip on the "Modern" (LEADS_VIEW_V2)
 * leads theme for every tenant. Originally vserve-only beta gated by
 * LEADS_VIEW_V2_ENABLED='1'. Enabling the flag makes the ✨ View toggle
 * (Classic / Modern / Inbox) available to all users on the tenant; each
 * user's chosen style is remembered per device (default Classic).
 *
 * Mirrors copilotProactiveRollout — single config flag, no schema change.
 * New tenants get it via tenantBootstrap CONFIG_DEFAULTS; this module is
 * the one-shot bulk rollout for everything already provisioned, run once
 * automatically at boot (idempotent).
 *
 * APIs (POST /api/saas with fn=…):
 *   api_saas_leadsViewV2_rolloutPreview(token)
 *   api_saas_leadsViewV2_rolloutRun(token, { tenant_slug? })
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
    const r = await pool.query(`SELECT value FROM config WHERE key = 'LEADS_VIEW_V2_ENABLED'`);
    const flagOn = (r.rows[0] && r.rows[0].value === '1');
    return {
      slug: tenant.slug,
      org_name: tenant.org_name,
      flag_on: flagOn,
      effective_on: flagOn
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
      `INSERT INTO config (key, value) VALUES ('LEADS_VIEW_V2_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    out.config_set = true;
  } catch (e) { out.config_error = e.message; }
  return out;
}

async function api_saas_leadsViewV2_rolloutPreview(token) {
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

async function api_saas_leadsViewV2_rolloutRun(token, payload) {
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

/**
 * Boot-time auto-rollout. Idempotent: only writes the flag for tenants
 * that don't already have it. Skips silently on errors so a single
 * misconfigured tenant doesn't block startup.
 */
async function autoRolloutAtBoot() {
  try {
    const tenants = await _activeTenants();
    let enabled = 0, alreadyOn = 0, errors = 0;
    for (const t of tenants) {
      const preview = await _previewTenant(t);
      if (preview.error) { errors++; continue; }
      if (preview.effective_on) { alreadyOn++; continue; }
      const r = await _rolloutTenant(t);
      if (r.config_set) enabled++;
      else errors++;
    }
    console.log(`[LEADS_VIEW_V2_ROLLOUT] boot rollout — scanned:${tenants.length} alreadyOn:${alreadyOn} enabled:${enabled} errors:${errors}`);
  } catch (e) {
    console.error('[LEADS_VIEW_V2_ROLLOUT] boot rollout failed:', e.message);
  }
}

module.exports = {
  api_saas_leadsViewV2_rolloutPreview,
  api_saas_leadsViewV2_rolloutRun,
  autoRolloutAtBoot
};
