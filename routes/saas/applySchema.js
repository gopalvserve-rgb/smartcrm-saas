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

module.exports = { api_saas_apply_schema_to_all_tenants };
