/* ============================================================================
 * REC_RETENTION_EXEC_v1 — completes the REC_RETENTION_v1 feature.
 *
 * The config (RECORDING_RETENTION_DAYS, default 30), the admin UI, the per-tenant
 * default, and the user-facing notice all already exist. The nightly purge JOB
 * that actually deletes old recordings was lost when server.js was gutted in June
 * (same incident as the Google-conversion worker). This module restores it.
 *
 * SAFETY:
 *  - report() is READ-ONLY: counts what WOULD be deleted, deletes nothing.
 *  - purge() deletes lead_recordings rows older than N days (and their R2 object),
 *    per tenant, batched. It ONLY runs when explicitly asked, and is gated by a
 *    global env flag in server.js so the daily cron stays off until enabled.
 *  - Scope is strictly lead_recordings. call_events are NEVER touched (locked).
 * ========================================================================== */
'use strict';
const control = require('../../control/db');
const r2 = require('../../utils/r2');
const tenantPoolMod = require('../../utils/tenantPool');

async function _activeTenantSlugs() {
  const r = await control.query(
    "SELECT slug FROM tenants WHERE status IN ('active','trial','past_due') ORDER BY id ASC LIMIT 2000");
  return r.rows.map(x => x.slug);
}

/** READ-ONLY. Count recordings older than `days` per tenant + Postgres bytes. Deletes nothing. */
async function report(days) {
  days = Math.max(1, parseInt(days, 10) || 30);
  const slugs = await _activeTenantSlugs();
  const per = []; let totMatched = 0, totBytes = 0; const errors = [];
  for (const slug of slugs) {
    try {
      const t = await control.findOneBy('tenants', 'slug', slug);
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      const q = await pool.query(
        `SELECT COUNT(*)::int AS matched,
                COALESCE(SUM(octet_length(audio_bytes)),0)::bigint AS pg_bytes,
                MIN(created_at) AS oldest, MAX(created_at) AS newest_over_window
           FROM lead_recordings
          WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(days)]);
      const row = q.rows[0] || {};
      const matched = row.matched | 0, pgb = Number(row.pg_bytes) || 0;
      if (matched > 0) per.push({
        tenant: slug, matched, pg_mb: +(pgb / 1048576).toFixed(2),
        oldest: row.oldest, newest_over_window: row.newest_over_window,
      });
      totMatched += matched; totBytes += pgb;
    } catch (e) { errors.push({ tenant: slug, err: String(e.message || e).slice(0, 140) }); }
  }
  per.sort((a, b) => b.pg_mb - a.pg_mb);
  return {
    mode: 'DRY-RUN (nothing deleted)', window_days: days,
    tenants_scanned: slugs.length,
    total_recordings_over_window: totMatched,
    total_postgres_mb: +(totBytes / 1048576).toFixed(2),
    tenants_with_matches: per.length,
    per_tenant: per.slice(0, 100),
    errors: errors.slice(0, 25),
  };
}

/** READ-ONLY. Count + Postgres MB of recordings older than `days` for ONE tenant. */
async function measureTenant(slug, days) {
  days = Math.max(1, parseInt(days, 10) || 30);
  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('tenant not found: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('pool unavailable: ' + slug);
  const q = await pool.query(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(octet_length(audio_bytes)),0)::bigint AS b
       FROM lead_recordings WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(days)]);
  return { count: q.rows[0].c | 0, mb: +((Number(q.rows[0].b) || 0) / 1048576).toFixed(2) };
}

/** DESTRUCTIVE. Delete recordings older than `days` for ONE tenant (R2 object + row). Batched. */
async function purgeTenant(slug, days, limit) {
  days = Math.max(1, parseInt(days, 10) || 30);
  limit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
  const t = await control.findOneBy('tenants', 'slug', slug);
  if (!t) throw new Error('tenant not found: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('pool unavailable: ' + slug);
  // r2_key may not exist on every tenant DB — add defensively (additive, idempotent)
  await pool.query(`ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});
  const rows = (await pool.query(
    `SELECT id, r2_key FROM lead_recordings
      WHERE created_at < NOW() - ($1 || ' days')::interval
      ORDER BY created_at ASC LIMIT $2`, [String(days), limit])).rows;
  let deleted = 0, r2Deleted = 0; const errs = [];
  for (const row of rows) {
    try {
      if (row.r2_key && r2.isEnabled()) { try { await r2.deleteObject(row.r2_key); r2Deleted++; } catch (_) {} }
      await pool.query('DELETE FROM lead_recordings WHERE id = $1', [row.id]);
      deleted++;
    } catch (e) { errs.push({ id: row.id, err: String(e.message || e).slice(0, 120) }); }
  }
  const remaining = (await pool.query(
    `SELECT COUNT(*)::int AS c FROM lead_recordings WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)])).rows[0].c;
  return { tenant: slug, window_days: days, deleted_rows: deleted, r2_objects_deleted: r2Deleted, remaining, errors: errs };
}

/** Daily cron entry: purge every tenant using its own RECORDING_RETENTION_DAYS.
 *  Blank/missing → 30 (the documented default). '0' → keep forever (skip). */
async function runDailyForAllTenants() {
  const slugs = await _activeTenantSlugs();
  const summary = { tenantsProcessed: 0, totalDeleted: 0, perTenant: [] };
  for (const slug of slugs) {
    try {
      const t = await control.findOneBy('tenants', 'slug', slug);
      if (!t) continue;
      const pool = tenantPoolMod.poolFor(t);
      if (!pool) continue;
      let days = 30; // documented default
      try {
        const c = await pool.query("SELECT value FROM config WHERE key = 'RECORDING_RETENTION_DAYS' LIMIT 1");
        if (c.rows.length && String(c.rows[0].value).trim() !== '') days = parseInt(c.rows[0].value, 10);
      } catch (_) {}
      if (!Number.isFinite(days) || days <= 0) continue; // 0/invalid = keep forever
      let del = 0;
      for (let i = 0; i < 50; i++) {
        const r = await purgeTenant(slug, days, 500);
        del += r.deleted_rows;
        if (r.deleted_rows === 0 || r.remaining === 0) break;
      }
      if (del > 0) summary.perTenant.push({ tenant: slug, deleted: del, window_days: days });
      summary.totalDeleted += del; summary.tenantsProcessed++;
    } catch (e) { console.warn('[rec-retention]', slug, e.message); }
  }
  return summary;
}

module.exports = { report, measureTenant, purgeTenant, runDailyForAllTenants };
