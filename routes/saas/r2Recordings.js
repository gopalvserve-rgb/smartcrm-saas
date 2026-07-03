/* ============================================================================
 * R2_RECORDINGS_v2 (2026-06-29) — SaaS-side R2 status + backfill APIs
 *
 * Super-admin diagnostic + backfill for Cloudflare R2 call-recording storage.
 * The actual upload+playback wiring lives in server.js (see the /api/recordings
 * POST and /api/recordings/:id/audio GET handlers).
 * ============================================================================ */
'use strict';
const control = require('../../control/db');
const { requireFullAdmin } = require('./superAdminAuth');
const r2 = require('../../utils/r2');
const tenantPoolMod = require('../../utils/tenantPool');

/** Diagnostic: env-var status + optional bucket reachability test. */
async function api_saas_r2_status(token) {
  await requireFullAdmin(token);
  const cfg = r2._cfg();
  const enabled = r2.isEnabled();
  const status = {
    enabled,
    env_vars_set: {
      R2_ENDPOINT:          !!cfg.endpoint,
      R2_BUCKET:            !!cfg.bucket,
      R2_ACCESS_KEY_ID:     !!cfg.ak,
      R2_SECRET_ACCESS_KEY: !!cfg.sk
    },
    bucket_name: cfg.bucket || null,
    endpoint:    cfg.endpoint || null
  };
  if (enabled) {
    // Try a minimal HEAD-ish operation (list objects with limit 1)
    try {
      const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
      const s3 = r2._s3 ? r2._s3() : null;
      if (s3) {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
        status.bucket_reachable = true;
        status.sample_key_count = out.KeyCount || 0;
      }
    } catch (e) {
      status.bucket_reachable = false;
      status.bucket_error = String(e.message || e).slice(0, 200);
    }
  }
  return status;
}

/** Backfill: migrate up to N PG-stored recordings from a tenant DB to R2.
 *  Idempotent — skips recordings that already have r2_key. */
async function api_saas_r2_backfill(token, payload) {
  await requireFullAdmin(token);
  if (!r2.isEnabled()) throw new Error('R2 not configured — set R2_* env vars on Railway first');
  const p = payload || {};
  const tenantSlug = p.tenant_slug;
  if (!tenantSlug) throw new Error('tenant_slug required');
  const limit = Math.min(parseInt(p.limit || 50, 10) || 50, 200);

  const t = await control.findOneBy('tenants', 'slug', tenantSlug);
  if (!t) throw new Error('Tenant not found: ' + tenantSlug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('tenant pool unavailable for ' + tenantSlug);

  // First: ensure r2_key column exists
  await pool.query(`ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS r2_key TEXT`).catch(() => {});

  const rows = await pool.query(
    `SELECT id, mime_type, size_bytes, audio_bytes
       FROM lead_recordings
      WHERE (r2_key IS NULL OR r2_key = '')
        AND audio_bytes IS NOT NULL AND length(audio_bytes) > 0
      ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );

  const out = { tenant: tenantSlug, scanned: rows.rows.length, migrated: 0, skipped: 0, errors: [] };
  for (const row of rows.rows) {
    try {
      const key = `${tenantSlug}/${row.id}${_extFromMime(row.mime_type)}`;
      await r2.putObject(key, row.audio_bytes, row.mime_type || 'audio/mpeg');
      await pool.query(
        `UPDATE lead_recordings SET r2_key = $1, audio_bytes = NULL WHERE id = $2`,
        [key, row.id]
      );
      out.migrated++;
    } catch (e) {
      out.errors.push({ id: row.id, err: String(e.message || e).slice(0, 200) });
      out.skipped++;
    }
  }
  return out;
}

function _extFromMime(m) {
  const s = String(m || '').toLowerCase();
  if (s.includes('mp3') || s.includes('mpeg')) return '.mp3';
  if (s.includes('m4a') || s.includes('mp4'))  return '.m4a';
  if (s.includes('wav'))    return '.wav';
  if (s.includes('ogg'))    return '.ogg';
  if (s.includes('amr'))    return '.amr';
  if (s.includes('3gp'))    return '.3gp';
  return '.bin';
}

module.exports = {
  api_saas_r2_status,
  api_saas_r2_backfill
};
