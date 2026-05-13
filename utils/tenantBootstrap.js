/**
 * utils/tenantBootstrap.js — single source of truth for "what every
 * tenant needs to have applied" before it serves traffic.
 *
 * WHY THIS EXISTS
 * ─────────────────
 * Over the lifetime of the SaaS we've shipped many features that each
 * need a new column / new table / new default config key. Historically
 * each route file owned its own `_ensureFooColumns()` helper, called
 * lazily on the first API hit. That works but is fragile:
 *
 *   • Easy to forget on the next feature.
 *   • Easy for a new tenant to hit a feature in an unusual order and
 *     find a migration that hasn't run yet → mysterious crashes.
 *   • Easy for an old tenant to have one column but not another
 *     because the upgrade order across deploys differed.
 *
 * This module fixes all three:
 *
 *   • Every schema delta lives HERE, in one ordered list.
 *   • Every config default lives HERE, in one ordered list.
 *   • The runner is idempotent — IF NOT EXISTS for schema, "skip if
 *     already set" for config — so it's safe to call on every boot.
 *   • Hooked into tenantPool.poolFor() — so the FIRST time any
 *     request lands on a tenant pool, the runner fires once. Result:
 *     existing tenants self-heal silently on first hit after a
 *     deploy; brand-new tenants get the full schema before their
 *     very first lead is created.
 *
 * HOW TO ADD A NEW MIGRATION
 * ──────────────────────────
 * Append an entry to SCHEMA_MIGRATIONS or CONFIG_DEFAULTS below.
 * Don't write a one-off _ensureXxx() helper in your route file.
 * Don't reorder existing entries (each is keyed by name so the runner
 * remembers which ones it has applied per tenant).
 */

'use strict';

// Per-pool ran-already memo so we only invoke once per process per pool.
const _appliedPools = new WeakSet();

/**
 * Idempotent schema deltas. Each one is plain SQL — keep it small and
 * obviously safe to re-run. The key is a stable name written into a
 * tracking table (_tenant_migrations) so future runs skip them.
 */
const SCHEMA_MIGRATIONS = [
  // ─────────────────────────────────────────────────────────────
  // Multi-WhatsApp
  // ─────────────────────────────────────────────────────────────
  { name: '2026_05_wa_phones_default_owner', sql: `
    ALTER TABLE wa_phones ADD COLUMN IF NOT EXISTS default_owner_user_id INTEGER;
  ` },

  // ─────────────────────────────────────────────────────────────
  // AI Bot
  // ─────────────────────────────────────────────────────────────
  { name: '2026_05_ai_bot_pause_after_human_handoff', sql: `
    ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS pause_after_human_handoff INTEGER NOT NULL DEFAULT 0;
  ` },

  // ─────────────────────────────────────────────────────────────
  // Products + Quotations
  // ─────────────────────────────────────────────────────────────
  { name: '2026_05_products_gst_image', sql: `
    ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_pct   NUMERIC(5,2) NOT NULL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
  ` },
  { name: '2026_05_quotation_items_gst_image_tax', sql: `
    ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS gst_pct           NUMERIC(5,2)  NOT NULL DEFAULT 0;
    ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS product_image_url TEXT;
    ALTER TABLE quotation_items ADD COLUMN IF NOT EXISTS tax_amt           NUMERIC(12,2) NOT NULL DEFAULT 0;
  ` },

  // ─────────────────────────────────────────────────────────────
  // Lead recordings (call audio)
  // ─────────────────────────────────────────────────────────────
  { name: '2026_05_lead_recordings_present', sql: `
    CREATE TABLE IF NOT EXISTS lead_recordings (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER,
      user_id     INTEGER,
      phone       TEXT,
      direction   TEXT,
      duration_s  INTEGER,
      device_path TEXT,
      mime_type   TEXT,
      size_bytes  INTEGER,
      audio_bytes BYTEA,
      started_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_recordings_lead ON lead_recordings(lead_id);
  ` },

  // ─────────────────────────────────────────────────────────────
  // Users — older tenants are missing updated_at, breaking the
  // super-admin password-reset feature.
  // ─────────────────────────────────────────────────────────────
  { name: '2026_05_users_updated_at', sql: `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  ` },

  // ─────────────────────────────────────────────────────────────
  // Push subscriptions + FCM tokens (mobile push notifications)
  // ─────────────────────────────────────────────────────────────
  { name: '2026_05_push_subscriptions_table', sql: `
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      endpoint    TEXT    NOT NULL,
      p256dh      TEXT    NOT NULL,
      auth        TEXT    NOT NULL,
      user_agent  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, endpoint)
    );
    CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
  ` },
  // Webhook event log — captures every /hook/* inbound for admin debugging.
  { name: '2026_05_users_ai_audit_enabled', sql: `
    -- Per-user toggle for auto AI call-summary processing. ON by default
    -- so existing tenants keep their current behaviour. Admin can flip
    -- to 0 for any user to skip auto-audit (manual button still works).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_audit_enabled INTEGER NOT NULL DEFAULT 1;
  ` },
    { name: '2026_05_webhook_logs_table', sql: `
    CREATE TABLE IF NOT EXISTS webhook_logs (
      id            SERIAL PRIMARY KEY,
      path          TEXT NOT NULL,
      method        TEXT NOT NULL,
      source_ip     TEXT,
      user_agent    TEXT,
      headers_json  TEXT,
      query_json    TEXT,
      body_text     TEXT,
      response_code INTEGER,
      response_text TEXT,
      duration_ms   INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_created ON webhook_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_logs_path    ON webhook_logs(path);
  ` },
  // Recording transcode diagnostic log — captures every transcode attempt
  // (upload-time, lazy on-play, manual /retranscode) so admins can see
  // exactly why playback fails for any specific recording.
  { name: '2026_05_recording_diag_log', sql: `
    CREATE TABLE IF NOT EXISTS recording_diag_log (
      id            SERIAL PRIMARY KEY,
      recording_id  INTEGER,
      action        TEXT NOT NULL,
      result        TEXT NOT NULL,
      ffmpeg_binary TEXT,
      ffmpeg_version TEXT,
      bytes_in      INTEGER,
      bytes_out     INTEGER,
      mime_in       TEXT,
      mime_out      TEXT,
      error_message TEXT,
      duration_ms   INTEGER,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rec_diag_created ON recording_diag_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rec_diag_rec_id  ON recording_diag_log(recording_id);
  ` },
  { name: '2026_05_fcm_tokens_table', sql: `
    CREATE TABLE IF NOT EXISTS fcm_tokens (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      token       TEXT NOT NULL UNIQUE,
      device_info TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id);
  ` },
];

/**
 * Default config keys — applied IFF the key doesn't already have a
 * value. Lets us ship sensible defaults that older tenants pick up,
 * while still respecting any explicit choice an admin has made.
 */
const CONFIG_DEFAULTS = [
  // Meta Coexistence flow ON by default — keeps the WA Business mobile
  // app working alongside the Cloud API on the same number.
  { key: 'WHATSAPP_COEXISTENCE_MODE', value: '1' },
];

async function _ensureMigrationsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _tenant_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function _ensureConfigTable(pool) {
  // Some brand-new tenants might not have the config table yet —
  // schema.sql normally creates it, but a safety net is cheap.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

/**
 * Run pending migrations + apply config defaults on this tenant pool.
 * Safe to call repeatedly — idempotent and remembers what's already
 * applied via the _tenant_migrations table.
 *
 * Returns { applied: [names], defaultsSet: [keys], errors: [] }.
 */
async function ensureTenantReady(pool) {
  if (!pool) return { applied: [], defaultsSet: [], errors: ['no pool'] };
  if (_appliedPools.has(pool)) return { applied: [], defaultsSet: [], errors: [], cached: true };

  const errors = [];
  const applied = [];
  const defaultsSet = [];

  try {
    await _ensureMigrationsTable(pool);

    // Read which migrations have already been recorded for this tenant
    const seen = new Set();
    try {
      const r = await pool.query(`SELECT name FROM _tenant_migrations`);
      r.rows.forEach(row => seen.add(row.name));
    } catch (e) {
      // Table might not exist yet on first run — _ensureMigrationsTable
      // above should have created it, but be defensive.
      console.warn('[tenant-bootstrap] read migrations failed:', e.message);
    }

    for (const m of SCHEMA_MIGRATIONS) {
      if (seen.has(m.name)) continue;
      try {
        await pool.query(m.sql);
        await pool.query(
          `INSERT INTO _tenant_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [m.name]
        );
        applied.push(m.name);
      } catch (e) {
        // Don't abort the whole run — record + continue. Most migrations
        // are independent. ALTER TABLE ... IF NOT EXISTS is forgiving so
        // failures here usually mean the referenced table itself doesn't
        // exist yet on a brand-new tenant.
        errors.push({ migration: m.name, error: e.message });
        console.warn('[tenant-bootstrap] migration ' + m.name + ' failed (continuing):', e.message);
      }
    }

    await _ensureConfigTable(pool);
    for (const d of CONFIG_DEFAULTS) {
      try {
        // Only seed when missing — never overwrite an explicit value.
        await pool.query(
          `INSERT INTO config (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO NOTHING`,
          [d.key, d.value]
        );
        defaultsSet.push(d.key);
      } catch (e) {
        errors.push({ config: d.key, error: e.message });
      }
    }

    _appliedPools.add(pool);
  } catch (e) {
    errors.push({ stage: 'bootstrap', error: e.message });
    console.error('[tenant-bootstrap] failed:', e && e.stack || e);
  }

  if (applied.length || defaultsSet.length) {
    console.log('[tenant-bootstrap] applied=' + applied.length +
                ' defaults=' + defaultsSet.length +
                ' errors=' + errors.length);
  }
  return { applied, defaultsSet, errors };
}

module.exports = { ensureTenantReady, SCHEMA_MIGRATIONS, CONFIG_DEFAULTS };
