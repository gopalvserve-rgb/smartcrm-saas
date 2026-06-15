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
  // PIPELINE_STAGE_HEAL_BOOTSTRAP_v1 (2026-06-04)
  // statuses.stage was added by PIPELINE_STAGE_v1 but the column heal
  // lived only inside routes/statuses.js gated by a module-level flag
  // that leaked across tenants in the same process. New tenants got
  // "column stage does not exist" the first time they tried to add a
  // status. Doing it here as part of the bootstrap runner means EVERY
  // tenant gets the column proactively on first connect — no per-call
  // heal needed.
  // ─────────────────────────────────────────────────────────────
  { name: '2026_06_statuses_stage', sql: `
    ALTER TABLE statuses ADD COLUMN IF NOT EXISTS stage TEXT;
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
  // PAUSED_FOR_LEADS_HEAL_v1 (2026-06-15) — older tenants are missing
  // users.paused_for_leads + the lead-cap columns and the user-create
  // form fails with: column "paused_for_leads" of relation "users"
  // does not exist. Heal them defensively. Also heal autodial_on +
  // calendly_url and the HR/onboarding columns referenced by users.js.
  // ─────────────────────────────────────────────────────────────
  { name: '2026_06_users_lead_pause_and_caps', sql: `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_for_leads  BOOLEAN     NOT NULL DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_lead_cap    INTEGER     NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_lead_cap  INTEGER     NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS autodial_on       INTEGER     NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS calendly_url      TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS father_name             TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email          TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address                 TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhaar_number          TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pan_number              TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_company            TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name  TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_name        TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_phone       TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_relation    TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_name        TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_phone       TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_relation    TEXT;
  ` },

  // ─────────────────────────────────────────────────────────────
  // COPILOT_v4 PROACTIVE COACH — tables for signal stream + cached
  // morning briefings + lead AI summaries.
  // ─────────────────────────────────────────────────────────────
  { name: '2026_06_copilot_proactive_v1', sql: `
    CREATE TABLE IF NOT EXISTS copilot_signals (
      id            SERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      lead_id       INTEGER,
      signal_kind   TEXT NOT NULL,                  -- hot_score_jump, old_customer_msg, missed_call, promise_overdue, reengage_window, quote_viewed
      severity      INTEGER NOT NULL DEFAULT 2,     -- 1=info 2=normal 3=urgent
      title         TEXT,
      reason        TEXT,
      payload_json  JSONB,
      fired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dismissed_at  TIMESTAMPTZ,
      acted_on_at   TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_copilot_signals_user_active
      ON copilot_signals(user_id, fired_at DESC)
      WHERE dismissed_at IS NULL AND acted_on_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_copilot_signals_dedup
      ON copilot_signals(user_id, lead_id, signal_kind, fired_at);

    CREATE TABLE IF NOT EXISTS copilot_briefings (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      for_date    DATE NOT NULL,
      payload_json JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, for_date)
    );

    CREATE TABLE IF NOT EXISTS copilot_lead_summaries (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER NOT NULL UNIQUE,
      summary     TEXT,
      next_action TEXT,
      draft_msg   TEXT,
      payload_json JSONB,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  ` },

  // ─────────────────────────────────────────────────────────────
  // LS_ROLLOUT_ALL_v1 (2026-06-15) — flip on AI Lead Scoring engine for
  // every tenant. lead_score_settings is a singleton row (id=1) created
  // by routes/leadScoring.js _ensureSchema with is_enabled=0. This
  // migration flips it to 1 so scoring actually runs.
  //
  // Guarded with IF EXISTS so it's a no-op on tenants where the
  // leadScoring schema hasn't been materialised yet (routes/leadScoring.js
  // will create + auto-enable on first call once the config flag is on).
  // ─────────────────────────────────────────────────────────────
  { name: '2026_06_lead_scoring_default_enable', sql: `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
         WHERE table_name = 'lead_score_settings'
      ) THEN
        UPDATE lead_score_settings SET is_enabled = 1 WHERE id = 1;
      END IF;
    END $$;
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_audit_enabled INTEGER NOT NULL DEFAULT 0;
  ` },
  // AI_AUDIT_HARD_OFF_v2 (2026-06-06): explicit, irreversible policy —
  // AI Call Audit is OFF by default for every user, every tenant, going
  // forward. Original migration above defaulted ON which crept costs up
  // and was switched OFF after admin asked twice. This migration:
  //   1. Forces the column default to 0 so any new user row created from
  //      this point forward starts with ai_audit_enabled = 0.
  //   2. UPDATEs every existing user row to 0, regardless of prior state.
  //   3. Runs exactly once per tenant (tracked in _tenant_migrations) so
  //      admin can still toggle individual users back ON afterwards
  //      without this migration re-flipping them.
  { name: '2026_06_users_ai_audit_hard_off_v2', sql: `
    ALTER TABLE users ALTER COLUMN ai_audit_enabled SET DEFAULT 0;
    UPDATE users SET ai_audit_enabled = 0;
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
      platform    TEXT,
      ua          TEXT,
      device_info TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      registered_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_user ON fcm_tokens(user_id);
  ` },
  // FCM_TOKENS_HEAL_v2 — for older tenants whose fcm_tokens table was
  // created BEFORE the platform/ua columns existed. ALTER ADD COLUMN
  // IF NOT EXISTS is idempotent — no-op on healthy tenants, heals
  // the rest. Runs on every tenant bootstrap so it catches drift.
  { name: '2026_05_fcm_tokens_add_cols', sql: `
    ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS platform TEXT;
    ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS ua TEXT;
    ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS device_info TEXT;
    ALTER TABLE fcm_tokens ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ DEFAULT NOW();
  ` },

  // SHARE_LEAD_v1 (2026-05-30) — co-owner join table.
  // Lets a lead appear under multiple users' "My leads" simultaneously
  // while keeping a single primary owner in leads.assigned_to. Both can
  // fully work the lead (change status, add remarks, call, WhatsApp).
  // 'source' tells us whether it was added manually or by an auto-rule.
  { name: '2026_05_30_lead_co_owners', sql: `
    CREATE TABLE IF NOT EXISTS lead_co_owners (
      id          SERIAL PRIMARY KEY,
      lead_id     INTEGER NOT NULL,
      user_id     INTEGER NOT NULL,
      added_by    INTEGER,
      added_at    TIMESTAMPTZ DEFAULT NOW(),
      source      TEXT DEFAULT 'manual',
      UNIQUE (lead_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lead_co_owners_user ON lead_co_owners(user_id);
    CREATE INDEX IF NOT EXISTS idx_lead_co_owners_lead ON lead_co_owners(lead_id);

    -- Auto-share rules live on existing tables:
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS auto_share_user_id INTEGER;
    ALTER TABLE sources   ADD COLUMN IF NOT EXISTS auto_share_user_id INTEGER;

    -- CAMPAIGN_ATTACH_PERSIST_v1 — persist the "Apply to which leads?" radio
    -- and the backfill filter so reopening the campaign editor shows what
    -- the admin picked. backfill_filters is JSON: { match_mode, assigned_to,
    -- status_id, source, also_unassign }. apply_mode is one of:
    -- 'future' | 'existing' | 'both'.
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS apply_mode      TEXT    DEFAULT 'future';
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS backfill_filters JSONB;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS last_backfilled_at TIMESTAMP;
  ` },

  // WA_CAMPAIGN_EXCEL_v1 + WA_REPORT_CAMPAIGN_v1 + WA_REPORT_BUTTON_CLICK_v1
  // ----
  // - wa_campaign_targets gets a JSON vars column so per-recipient
  //   variable substitution (Excel uploads) survives across the queue.
  // - whatsapp_messages gets a campaign_id tag so the WA Report can
  //   slice by campaign and the drill-down can list per-campaign leads.
  // - wa_button_clicks is the new table that records inbound button
  //   replies attributed to the most-recent campaign for that phone.
  { name: '2026_06_05_wa_campaign_excel_and_report', sql: `
    ALTER TABLE wa_campaign_targets ADD COLUMN IF NOT EXISTS vars_json JSONB;
    ALTER TABLE whatsapp_messages   ADD COLUMN IF NOT EXISTS campaign_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_wa_msgs_campaign ON whatsapp_messages(campaign_id) WHERE campaign_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS wa_button_clicks (
      id            SERIAL PRIMARY KEY,
      campaign_id   INTEGER,
      lead_id       INTEGER,
      phone         TEXT NOT NULL,
      button_payload TEXT,
      button_title  TEXT,
      button_index  INTEGER,
      template_name TEXT,
      wa_message_id TEXT,
      clicked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wa_btn_clicks_campaign ON wa_button_clicks(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_wa_btn_clicks_lead     ON wa_button_clicks(lead_id);
    CREATE INDEX IF NOT EXISTS idx_wa_btn_clicks_phone    ON wa_button_clicks(phone);
  ` },

  // 2026-06-05 — Extend wa_button_clicks with `source` so AI Bot /
  // Bot Flow button taps can be distinguished from template/campaign
  // button taps in the WA Report. Default 'campaign' for old rows.
  { name: '2026_06_05_wa_button_clicks_source', sql: `
    ALTER TABLE wa_button_clicks ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'campaign';
    UPDATE wa_button_clicks SET source = 'campaign' WHERE source IS NULL;
    CREATE INDEX IF NOT EXISTS idx_wa_btn_clicks_source ON wa_button_clicks(source);
  ` },

  // ATTENDANCE_OPTIONAL_DEFAULT_v1 (2026-06-06) — flip selfie + meter
  // requirement OFF for every existing tenant. User reported the
  // "Meter reading must be a number" validation was blocking real
  // check-ins on field-staff phones. Going forward both flags are
  // OFF by default in routes/hr.js too. Admin can re-enable from
  // Settings → Attendance any time. Runs once per tenant — config
  // table holds the current value, this UPDATE just resets it.
  { name: '2026_06_06_attendance_optional_default', sql: `
    UPDATE config SET value = '0' WHERE key = 'ATTENDANCE_REQUIRE_SELFIE';
    UPDATE config SET value = '0' WHERE key = 'ATTENDANCE_REQUIRE_METER';
  ` },

  // ─────────────────────────────────────────────────────────────
  // OPPORTUNITIES_v1 (2026-06-13) — multi-opportunity + multi-pipeline
  // Tables are also created idempotently from inside routes/opportunities.js
  // (_ensureSchema). We mirror them here so the first connect provisions
  // them up-front even if no opportunities API is hit.
  // ─────────────────────────────────────────────────────────────
  { name: '2026_06_13_opportunities_tables', sql: `
    CREATE TABLE IF NOT EXISTS opportunity_types (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, default_pipeline_id INTEGER,
      default_amount NUMERIC(12,2) DEFAULT 0, default_probability INTEGER DEFAULT 0,
      default_close_days INTEGER DEFAULT 30, icon TEXT NOT NULL DEFAULT '💼',
      color TEXT NOT NULL DEFAULT '#3b82f6', is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pipelines (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id SERIAL PRIMARY KEY, pipeline_id INTEGER NOT NULL, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL, win_probability INTEGER DEFAULT 0,
      is_terminal_win INTEGER NOT NULL DEFAULT 0, is_terminal_loss INTEGER NOT NULL DEFAULT 0,
      expected_days INTEGER DEFAULT 7, color TEXT, icon TEXT,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline ON pipeline_stages(pipeline_id, sort_order);
    CREATE TABLE IF NOT EXISTS opportunities (
      id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL, name TEXT NOT NULL,
      opportunity_type_id INTEGER, pipeline_id INTEGER NOT NULL, stage_id INTEGER NOT NULL,
      owner_user_id INTEGER, amount NUMERIC(12,2) DEFAULT 0, currency TEXT NOT NULL DEFAULT 'INR',
      probability INTEGER DEFAULT 0, expected_close_date DATE, actual_close_date DATE,
      closed_won INTEGER NOT NULL DEFAULT 0, closed_lost INTEGER NOT NULL DEFAULT 0,
      lost_reason TEXT, source TEXT, campaign_id INTEGER, description TEXT,
      next_followup_at TIMESTAMPTZ, meta_json JSONB, created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_opportunities_lead ON opportunities(lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_opportunities_owner_stage ON opportunities(owner_user_id, stage_id);
    CREATE INDEX IF NOT EXISTS idx_opportunities_pipeline_stage ON opportunities(pipeline_id, stage_id);
    CREATE TABLE IF NOT EXISTS opportunity_stage_history (
      id SERIAL PRIMARY KEY, opportunity_id INTEGER NOT NULL,
      from_stage_id INTEGER, to_stage_id INTEGER NOT NULL,
      duration_in_prev_stage_s INTEGER, changed_by INTEGER, note TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_opp_stage_hist_opp ON opportunity_stage_history(opportunity_id, changed_at);
    CREATE TABLE IF NOT EXISTS opportunity_line_items (
      id SERIAL PRIMARY KEY, opportunity_id INTEGER NOT NULL, product_id INTEGER,
      description TEXT, qty NUMERIC(10,2) DEFAULT 1, unit_price NUMERIC(12,2) DEFAULT 0,
      discount_pct NUMERIC(5,2) DEFAULT 0, gst_pct NUMERIC(5,2) DEFAULT 0,
      line_total NUMERIC(12,2) DEFAULT 0, sort_order INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_opp_line_opp ON opportunity_line_items(opportunity_id);
    CREATE TABLE IF NOT EXISTS opportunity_activities (
      id SERIAL PRIMARY KEY, opportunity_id INTEGER NOT NULL, user_id INTEGER,
      activity_type TEXT NOT NULL, summary TEXT, scheduled_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, outcome TEXT, duration_min INTEGER, meta_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_opp_act_opp ON opportunity_activities(opportunity_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS opportunity_docs (
      id SERIAL PRIMARY KEY, opportunity_id INTEGER NOT NULL, name TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
      uploaded_by INTEGER, uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_opp_docs_opp ON opportunity_docs(opportunity_id);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS opp_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE statuses ADD COLUMN IF NOT EXISTS creates_opportunity INTEGER NOT NULL DEFAULT 0;
  ` },
  { name: '2026_06_13_lead_scoring_tables_v2', sql: `
    CREATE TABLE IF NOT EXISTS lead_score_rules (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      bucket TEXT NOT NULL,
      label TEXT NOT NULL,
      why TEXT,
      pack TEXT NOT NULL DEFAULT 'universal',
      weight INTEGER NOT NULL DEFAULT 0,
      decay_days INTEGER DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      meta_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_lsr_pack_bucket ON lead_score_rules(pack, bucket, is_active);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_lsr_code_pack ON lead_score_rules(code, pack);

    -- lead_score_settings is a singleton row with thresholds + SLA + decay knobs
    CREATE TABLE IF NOT EXISTS lead_score_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      hot_threshold INTEGER NOT NULL DEFAULT 80,
      warm_threshold INTEGER NOT NULL DEFAULT 60,
      nurture_threshold INTEGER NOT NULL DEFAULT 40,
      hot_sla_minutes INTEGER NOT NULL DEFAULT 5,
      warm_sla_minutes INTEGER NOT NULL DEFAULT 60,
      nurture_sla_hours INTEGER NOT NULL DEFAULT 24,
      decay_7d_points INTEGER NOT NULL DEFAULT 10,
      decay_15d_points INTEGER NOT NULL DEFAULT 25,
      decay_30d_points INTEGER NOT NULL DEFAULT 40,
      recompute_on_every_event INTEGER NOT NULL DEFAULT 1,
      is_enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO lead_score_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- score-change log
    CREATE TABLE IF NOT EXISTS lead_score_log (
      id SERIAL PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      old_score INTEGER,
      new_score INTEGER NOT NULL,
      delta INTEGER NOT NULL,
      trigger_event TEXT,
      breakdown_json JSONB,
      reason_text TEXT,
      changed_by INTEGER,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- heal v1 schema (drop legacy created_at-only schema if it exists)
    ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS delta INTEGER;
    ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS trigger_event TEXT;
    ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS breakdown_json JSONB;
    ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS reason_text TEXT;
    ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS changed_by INTEGER;
    ALTER TABLE lead_score_log ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS idx_lslog_lead ON lead_score_log(lead_id, changed_at DESC);

    CREATE TABLE IF NOT EXISTS lead_score_overrides (
      lead_id INTEGER PRIMARY KEY,
      override_category TEXT,
      reason TEXT NOT NULL,
      set_by INTEGER NOT NULL,
      set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    );
    ALTER TABLE lead_score_overrides ADD COLUMN IF NOT EXISTS override_category TEXT;
    ALTER TABLE lead_score_overrides ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

    ALTER TABLE leads ADD COLUMN IF NOT EXISTS smart_score INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS smart_category TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_reason TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_breakdown_json JSONB;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS score_updated_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_leads_smart_score ON leads(smart_score DESC) WHERE smart_score > 0;
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
  // LS_ROLLOUT_ALL_v1 — AI Lead Scoring ON for every tenant by default.
  // Gates the SPA-visible feature: column, filter, mode toggle, dashboard.
  { key: 'LEAD_SCORING_ENABLED', value: '1' },
  // QNOTE_ROLLOUT_ALL_v1 — ✨ Quick Note row button ON for every tenant.
  // Gates the row-level AI note widget (slash menu: /note, /status, /followup).
  { key: 'AI_QUICKNOTE_ENABLED', value: '1' },
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
