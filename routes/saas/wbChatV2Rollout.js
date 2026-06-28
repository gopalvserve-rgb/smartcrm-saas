/**
 * WB_CHAT_V2_ROLLOUT_v1 (2026-06-25) — flip on the new 3-column WhatsApp
 * chat (WB_CHAT_V2_ENABLED='1') for every tenant.
 *
 * Originally vserve-only (utils/wbChatV2VserveAutoEnable.js). User wants
 * every existing tenant to get the new UI immediately, and every NEW
 * tenant to receive it on provision via tenantBootstrap CONFIG_DEFAULTS.
 *
 * Mirrors copilotProactiveRollout exactly — single config flag, no schema
 * migration, no per-lead recompute. Just UPSERT the flag and let the SPA
 * delegate to wbChatV2.js when the page renders.
 *
 * APIs (POST /api/saas with fn=…):
 *   api_saas_wbChatV2_rolloutPreview(token)
 *     → for each active tenant: is the flag already on? Returns counts.
 *   api_saas_wbChatV2_rolloutRun(token, { tenant_slug? })
 *     → ensureTenantReady → UPSERT config flag. Optionally per-tenant.
 *
 * The same APIs are called automatically once on server boot (idempotent)
 * so existing tenants get the feature without manual super-admin click.
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
    const r = await pool.query(`SELECT value FROM config WHERE key = 'WB_CHAT_V2_ENABLED'`);
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
  // WB_CHAT_V2_ALLTENANTS_v1 (2026-06-27) — turn the new 3-column WhatsApp
  // chat ON ('1') for every tenant. Idempotent UPSERT.
  const pool = tenantPool.poolFor(tenant);
  if (!pool) return { slug: tenant.slug, error: 'no pool' };
  const out = { slug: tenant.slug, org_name: tenant.org_name, config_set: false };
  try {
    await pool.query(
      `INSERT INTO config (key, value) VALUES ('WB_CHAT_V2_ENABLED', '1')
       ON CONFLICT (key) DO UPDATE SET value = '1'`
    );
    out.config_set = true;
  } catch (e) { out.config_error = e.message; }
  return out;
}

async function api_saas_wbChatV2_rolloutPreview(token) {
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

async function api_saas_wbChatV2_rolloutRun(token, payload) {
  await requireSuperAdmin(token);
  const tenants = await _activeTenants();
  const filter = payload && payload.tenant_slug;
  const targets = filter ? tenants.filter(t => t.slug === filter) : tenants;
  const results = [];
  let enabled = 0;
  for (const t of targets) {
    const r = await _rolloutTenant(t);
    results.push(r);
    if (r.config_set) enabled++;
  }
  return {
    tenants_processed: targets.length,
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
  // WB_CHAT_V2_ALLTENANTS_v1 — flip ON for every tenant that isn't already on.
  // Idempotent: tenants already on are skipped fast.
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
      await new Promise(res => setTimeout(res, 250));
    }
    console.log(`[WB_CHAT_V2_ROLLOUT] boot rollout — scanned:${tenants.length} alreadyOn:${alreadyOn} enabled:${enabled} errors:${errors}`);
  } catch (e) {
    console.error('[WB_CHAT_V2_ROLLOUT] boot rollout failed:', e.message);
  }
}

module.exports = {
  api_saas_wbChatV2_rolloutPreview,
  api_saas_wbChatV2_rolloutRun,
  autoRolloutAtBoot
};
