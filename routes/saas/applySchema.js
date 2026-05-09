/**
 * Super-admin: re-apply db/schema.sql to every active tenant DB.
 *
 * Why: smartcrm-saas only runs schema.sql at PROVISIONING time, so when
 * we add new tables / columns (e.g. the campaigns + campaign_agents
 * tables added 2026-05-08), existing tenants don't get them. The
 * schema is fully idempotent (CREATE TABLE / ADD COLUMN / CREATE INDEX
 * all use IF NOT EXISTS / DO-block guards), so it's safe to re-apply
 * to every tenant on demand. This endpoint walks active tenants, runs
 * schema.sql against each, and reports which ones succeeded vs failed.
 *
 * Usage from the super-admin panel:
 *
 *     POST /api/saas
 *     X-Auth-Token: <super_admin_token>
 *     { "fn": "api_saas_apply_schema_to_all_tenants", "args": [] }
 *
 * Returns:
 *   { ok: <int>, failed: <int>, details: [{ slug, ok, error? }] }
 *
 * IMPORTANT: this never DROPs anything in schema.sql. The current
 * file uses ALTER TABLE … DROP COLUMN IF EXISTS for legacy `tax`
 * columns — that's the only destructive op and it's a one-way clean
 * up of leftover columns from an old release. Re-running it on a
 * tenant that already had them dropped is a no-op.
 */

const fs = require('fs');
const path = require('path');
const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin } = require('./superAdminAuth');

async function api_saas_apply_schema_to_all_tenants(token) {
  await requireSuperAdmin(token);

  const sqlPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const sql     = fs.readFileSync(sqlPath, 'utf8');

  const tenants = await control.query(
    `SELECT id, slug FROM tenants
      WHERE status IN ('active','trial','past_due')
      ORDER BY id ASC`
  );

  const details = [];
  let ok = 0, failed = 0;

  for (const row of tenants.rows) {
    const slug = row.slug;
    let t;
    try { t = await tenantPool.findActiveTenant(slug); } catch (_) { t = null; }
    if (!t) { failed++; details.push({ slug, ok: false, error: 'tenant pool unavailable' }); continue; }
    const pool = tenantPool.poolFor(t);
    if (!pool) { failed++; details.push({ slug, ok: false, error: 'tenant pool unavailable' }); continue; }

    try {
      // Run the whole script as one transaction. Safer than statement-
      // splitting (DO $$ BEGIN ... END $$ blocks contain semicolons).
      await pool.query(sql);
      ok++;
      details.push({ slug, ok: true });
    } catch (e) {
      failed++;
      details.push({ slug, ok: false, error: (e.message || '').slice(0, 400) });
    }
  }

  return { ok, failed, details };
}



/**
 * One-time migration — drop kb_max_chars from 60000 (old default) to
 * 8000 for every tenant whose ai_bot_settings still has that value.
 * Doesn't touch tenants who explicitly chose any other value.
 *
 * Cuts AI Bot input token costs by ~85% for tenants using the old
 * default. Safe to re-run — the WHERE clause filters out rows already
 * migrated.
 */
async function api_saas_lower_aibot_kb_cap(token) {
  await requireSuperAdmin(token);

  const tenants = await control.query(
    `SELECT id, slug FROM tenants
      WHERE status IN ('active','trial','past_due')
      ORDER BY id ASC`
  );

  const details = [];
  let updated = 0, skipped = 0, failed = 0;
  for (const row of tenants.rows) {
    const slug = row.slug;
    let t;
    try { t = await tenantPool.findActiveTenant(slug); } catch (_) { t = null; }
    if (!t) { failed++; details.push({ slug, ok: false, error: 'tenant pool unavailable' }); continue; }
    const pool = tenantPool.poolFor(t);
    if (!pool) { failed++; details.push({ slug, ok: false, error: 'tenant pool unavailable' }); continue; }
    try {
      const r = await pool.query(
        `UPDATE ai_bot_settings SET kb_max_chars = 8000, updated_at = NOW()
          WHERE kb_max_chars = 60000
        RETURNING id`
      );
      if (r.rowCount > 0) {
        updated++;
        details.push({ slug, ok: true, action: 'lowered to 8000' });
      } else {
        skipped++;
        details.push({ slug, ok: true, action: 'already custom or table missing' });
      }
    } catch (e) {
      // Table missing on un-migrated tenants is OK — silently skip
      if (/relation .* does not exist/i.test(e.message || '')) {
        skipped++;
        details.push({ slug, ok: true, action: 'ai_bot_settings not yet migrated' });
      } else {
        failed++;
        details.push({ slug, ok: false, error: (e.message || '').slice(0, 400) });
      }
    }
  }
  return { updated, skipped, failed, details };
}



/**
 * One-time backfill — walk control.ai_usage_log rows where tenant_slug
 * is empty/null, and try to attribute each to the right tenant by
 * matching on (phone, created_at within ±5 min) against each tenant's
 * ai_chat_log. Idempotent — re-running is safe (rows already attributed
 * are filtered out by the WHERE clause).
 *
 * Caused by an earlier bug where the WhatsApp webhook handlers in
 * server.js called whatsbotRoute.expressEvent directly without wrapping
 * in tenantStorage.run(). Without that scope, db.tenantStorage.getStore()
 * returned null inside _handleInbound → tenantSlug='' → orphan rows.
 * Fixed forward in commit e23a9b4; this endpoint cleans up the past.
 */
async function api_saas_backfill_aiusage_orphans(token) {
  await requireSuperAdmin(token);

  // Pull every empty-slug row
  const orphans = await control.query(
    `SELECT id, phone, created_at FROM ai_usage_log
      WHERE (tenant_slug IS NULL OR tenant_slug = '')
        AND phone IS NOT NULL AND phone <> ''
        AND created_at > NOW() - INTERVAL '60 days'
      ORDER BY created_at DESC`
  );
  if (!orphans.rows.length) {
    return { ok: true, total_orphans: 0, attributed: 0, unmatched: 0, by_tenant: {} };
  }

  const tenants = await control.query(
    `SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC`
  );

  // For each tenant, fetch their ai_chat_log rows that have a phone +
  // created_at within the last 60 days, then build a lookup keyed by
  // 'phone|YYYY-MM-DDTHH:MM' (minute granularity). Orphan rows match
  // if their (phone, minute) appears.
  const matchByKey = new Map(); // key → tenant_slug
  for (const trow of tenants.rows) {
    const slug = trow.slug;
    let t; try { t = await tenantPool.findActiveTenant(slug); } catch (_) { t = null; }
    if (!t) continue;
    const pool = tenantPool.poolFor(t);
    if (!pool) continue;
    try {
      const r = await pool.query(
        `SELECT phone, created_at
           FROM ai_chat_log
          WHERE phone IS NOT NULL
            AND created_at > NOW() - INTERVAL '60 days'`
      );
      r.rows.forEach(row => {
        if (!row.phone) return;
        const minute = new Date(row.created_at).toISOString().slice(0, 16);
        matchByKey.set(row.phone + '|' + minute, slug);
        // Also key with phone-tail (last 10) since a few rows might have
        // diff country-code formats.
        const tail = String(row.phone).replace(/\D/g, '').slice(-10);
        if (tail.length === 10) matchByKey.set(tail + '|' + minute, slug);
      });
    } catch (_) { /* ai_chat_log table missing on this tenant — skip */ }
  }

  let attributed = 0, unmatched = 0;
  const byTenant = {};
  for (const o of orphans.rows) {
    const minute = new Date(o.created_at).toISOString().slice(0, 16);
    const slug = matchByKey.get(o.phone + '|' + minute)
      || matchByKey.get(String(o.phone).replace(/\D/g, '').slice(-10) + '|' + minute);
    if (slug) {
      await control.query(
        `UPDATE ai_usage_log SET tenant_slug = $1
          WHERE id = $2 AND (tenant_slug IS NULL OR tenant_slug = '')`,
        [slug, o.id]
      );
      attributed++;
      byTenant[slug] = (byTenant[slug] || 0) + 1;
    } else {
      unmatched++;
    }
  }

  return {
    ok: true,
    total_orphans: orphans.rows.length,
    attributed,
    unmatched,
    by_tenant: byTenant
  };
}

module.exports = { api_saas_apply_schema_to_all_tenants, api_saas_lower_aibot_kb_cap, api_saas_backfill_aiusage_orphans };
