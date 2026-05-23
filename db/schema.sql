-- ============================================================
-- Lead CRM — PostgreSQL schema
-- ============================================================
-- Run with:  psql $DATABASE_URL -f db/schema.sql
-- or via:    npm run migrate
-- ============================================================

-- ---- users --------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  phone           TEXT,
  role            TEXT NOT NULL DEFAULT 'sales',  -- admin|manager|team_leader|sales
  password_hash   TEXT NOT NULL,
  parent_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  department      TEXT,
  designation     TEXT,
  photo_url       TEXT,
  monthly_salary  NUMERIC(14,2) DEFAULT 0,
  joining_date    DATE,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_role    ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_parent  ON users(parent_id);

-- ---- statuses -----------------------------------------------
CREATE TABLE IF NOT EXISTS statuses (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6b7280',
  sort_order  INTEGER NOT NULL DEFAULT 10,
  is_final    INTEGER NOT NULL DEFAULT 0
);

-- ---- sources ------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id         SERIAL PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1
);

-- ---- products -----------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  price        NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ---- custom_fields ------------------------------------------
CREATE TABLE IF NOT EXISTS custom_fields (
  id             SERIAL PRIMARY KEY,
  key            TEXT UNIQUE NOT NULL,
  label          TEXT NOT NULL,
  field_type     TEXT NOT NULL DEFAULT 'text',  -- text|number|date|select|multiselect|checkbox|textarea
  options        TEXT,                          -- pipe-separated for select/multiselect
  is_required    INTEGER NOT NULL DEFAULT 0,
  show_in_list   INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 10,
  is_active      INTEGER NOT NULL DEFAULT 1
);

-- ---- leads --------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id                     SERIAL PRIMARY KEY,
  name                   TEXT NOT NULL,
  phone                  TEXT,
  alt_phone              TEXT,
  whatsapp               TEXT,
  email                  TEXT,
  source                 TEXT,
  source_ref             TEXT,
  product                TEXT,
  product_id             INTEGER REFERENCES products(id) ON DELETE SET NULL,
  status_id              INTEGER REFERENCES statuses(id) ON DELETE SET NULL,
  assigned_to            INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  created_by             INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_status_change_at  TIMESTAMPTZ,
  next_followup_at       TIMESTAMPTZ,
  is_duplicate           INTEGER NOT NULL DEFAULT 0,
  duplicate_of           INTEGER,
  tags                   TEXT,
  notes                  TEXT,
  address                TEXT,
  city                   TEXT,
  state                  TEXT,
  pincode                TEXT,
  country                TEXT,
  company                TEXT,
  value                  NUMERIC(14,2),
  currency               TEXT,
  meta_json              JSONB,
  extra_json             JSONB
);
CREATE INDEX IF NOT EXISTS idx_leads_phone    ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_email    ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_status   ON leads(status_id);
CREATE INDEX IF NOT EXISTS idx_leads_created  ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_source   ON leads(source);

-- ---- remarks ------------------------------------------------
CREATE TABLE IF NOT EXISTS remarks (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id)           ON DELETE SET NULL,
  remark     TEXT NOT NULL,
  status_id  INTEGER REFERENCES statuses(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_remarks_lead ON remarks(lead_id);

-- ---- followups ----------------------------------------------
CREATE TABLE IF NOT EXISTS followups (
  id         SERIAL PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at     TIMESTAMPTZ,
  note       TEXT,
  is_done    INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_followups_user ON followups(user_id);
CREATE INDEX IF NOT EXISTS idx_followups_lead ON followups(lead_id);
CREATE INDEX IF NOT EXISTS idx_followups_due  ON followups(due_at);

-- ---- assignment_rules ---------------------------------------
CREATE TABLE IF NOT EXISTS assignment_rules (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  field        TEXT NOT NULL,
  operator     TEXT NOT NULL,
  value        TEXT NOT NULL,
  assigned_to  TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 100,
  is_active    INTEGER NOT NULL DEFAULT 1
);

-- ---- notifications ------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT,
  title      TEXT,
  body       TEXT,
  link       TEXT,
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- ---- attendance ---------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  check_in         TIMESTAMPTZ,
  check_out        TIMESTAMPTZ,
  check_in_lat     NUMERIC(10,6),
  check_in_lng     NUMERIC(10,6),
  check_out_lat    NUMERIC(10,6),
  check_out_lng    NUMERIC(10,6),
  status           TEXT,  -- present|half_day|leave|absent
  notes            TEXT,
  UNIQUE (user_id, date)
);

-- ---- leaves -------------------------------------------------
CREATE TABLE IF NOT EXISTS leaves (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- tasks --------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id            SERIAL PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT,
  assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_at        TIMESTAMPTZ,
  priority      TEXT DEFAULT 'normal',
  status        TEXT DEFAULT 'open',  -- open|in_progress|done|cancelled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to, status);

-- ---- salaries -----------------------------------------------
CREATE TABLE IF NOT EXISTS salaries (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month       TEXT NOT NULL,  -- 'YYYY-MM'
  base        NUMERIC(14,2) NOT NULL DEFAULT 0,
  allowances  NUMERIC(14,2) NOT NULL DEFAULT 0,
  deductions  NUMERIC(14,2) NOT NULL DEFAULT 0,
  net_pay     NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, month)
);

-- ---- bank_details -------------------------------------------
CREATE TABLE IF NOT EXISTS bank_details (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bank_name       TEXT,
  account_holder  TEXT,
  account_number  TEXT,
  ifsc            TEXT,
  branch          TEXT,
  upi_id          TEXT,
  notes           TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- config -------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  id          SERIAL PRIMARY KEY,
  key         TEXT UNIQUE NOT NULL,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- whatsapp_messages --------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id             SERIAL PRIMARY KEY,
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  direction      TEXT NOT NULL,  -- in|out
  from_number    TEXT,
  to_number      TEXT,
  body           TEXT,
  wa_message_id  TEXT,
  status         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_lead ON whatsapp_messages(lead_id);

-- ---- webhook_log --------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_log (
  id           SERIAL PRIMARY KEY,
  source       TEXT NOT NULL,  -- meta|whatsapp|website
  payload      JSONB,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed    INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhook_source ON webhook_log(source, processed);

-- ---- idempotent column additions for existing DBs -----------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS tags TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_status_change_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_duplicate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS duplicate_of INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_salary NUMERIC(14,2) DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS joining_date DATE;
ALTER TABLE remarks ADD COLUMN IF NOT EXISTS status_id INTEGER;
ALTER TABLE custom_fields ADD COLUMN IF NOT EXISTS show_in_list INTEGER NOT NULL DEFAULT 0;

-- ---- automations --------------------------------------------
CREATE TABLE IF NOT EXISTS automations (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  event        TEXT NOT NULL,          -- lead_created | status_changed | lead_assigned | followup_due | source_is
  condition    TEXT,                   -- e.g. status_id=3 OR source=Website OR tag:vip
  channel      TEXT NOT NULL,          -- email | whatsapp | webhook
  recipient    TEXT,                   -- 'lead' | 'assignee' | 'admin' | specific email/phone
  subject      TEXT,
  template     TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS automation_log (
  id            SERIAL PRIMARY KEY,
  automation_id INTEGER REFERENCES automations(id) ON DELETE SET NULL,
  lead_id       INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  event         TEXT,
  channel       TEXT,
  recipient     TEXT,
  status        TEXT,   -- sent | failed | skipped
  detail        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_log_lead ON automation_log(lead_id);

-- v6: device + IP columns for attendance
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS device_info TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS ip TEXT;
-- Human-readable address resolved from lat/lng at check-in/out time.
-- Populated client-side via reverse-geocoding so admins see "Sector 18,
-- Noida" instead of a "20.123, 78.456" pair of numbers.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_in_location_name TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS check_out_location_name TEXT;

-- v6: role permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  id         SERIAL PRIMARY KEY,
  role       TEXT NOT NULL,
  permission TEXT NOT NULL,
  scope      TEXT,          -- 'global' | 'team' | 'self' | null
  is_granted INTEGER NOT NULL DEFAULT 1,
  UNIQUE (role, permission)
);

-- v7: in-app dialer + call recordings
CREATE TABLE IF NOT EXISTS lead_recordings (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone        TEXT,
  direction    TEXT,             -- 'out' | 'in' | 'missed'
  duration_s   INTEGER DEFAULT 0,
  device_path  TEXT,              -- original path on the device
  mime_type    TEXT,               -- e.g. audio/m4a
  size_bytes   INTEGER DEFAULT 0,
  audio_bytes  BYTEA,              -- the actual audio file (stored inline in PG)
  started_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_rec_lead    ON lead_recordings(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_rec_user    ON lead_recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_lead_rec_created ON lead_recordings(created_at);

-- Call events timeline (every call_start / call_end logged, even without audio)
CREATE TABLE IF NOT EXISTS call_events (
  id           SERIAL PRIMARY KEY,
  lead_id      INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  phone        TEXT,
  direction    TEXT,            -- out | in | missed
  event        TEXT,            -- outgoing_call | incoming_ringing | call_answered | call_ended
  duration_s   INTEGER DEFAULT 0,
  recording_id INTEGER REFERENCES lead_recordings(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_events_lead ON call_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_events_user ON call_events(user_id, created_at);

-- v8: editable email templates (one row per event_type)
CREATE TABLE IF NOT EXISTS email_templates (
  id           SERIAL PRIMARY KEY,
  event_type   TEXT UNIQUE NOT NULL,    -- new_lead | lead_assigned | new_device_login | morning_followups | day_end
  name         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body_html    TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track which devices each user has signed in from. Drives the
-- new_device_login email — fires only when an unfamiliar fingerprint shows up.
CREATE TABLE IF NOT EXISTS user_devices (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,            -- sha256 of UA + IP
  user_agent    TEXT,
  ip            TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);

-- ---- v10: admin-managed tag library --------------------------------
-- Tags are now centrally managed by admins. Non-admin users can only
-- choose from this list, not create new tags freeform. The leads.tags
-- column stays as a comma-separated string (back-compat) but now only
-- contains values from this table when set via the UI.
CREATE TABLE IF NOT EXISTS tag_library (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- v10: qualified flag --------------------------------
-- Separate from status — answers "did this lead pass our minimum
-- qualification?" regardless of where they are in the pipeline.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- ---- v11: TAT (Turn-Around Time) tracking ----------------------------
-- A lead's lifecycle is recorded as two parallel logs:
--   1. lead_stage_log — every time the status changes, log from→to + when.
--   2. lead_actions   — every "action" the user takes on the lead
--      (created, status_change, remark, call, followup_set). The first
--      such action AFTER `created_at` is the "1st action"; the next is
--      the "2nd action", etc. Used by the action-timeline report.
CREATE TABLE IF NOT EXISTS lead_stage_log (
  id              SERIAL PRIMARY KEY,
  lead_id         INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_status_id  INTEGER,
  to_status_id    INTEGER,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  duration_s      INTEGER,                  -- seconds spent in from_status (filled when leaving it)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stage_log_lead ON lead_stage_log(lead_id, created_at);

CREATE TABLE IF NOT EXISTS lead_actions (
  id            SERIAL PRIMARY KEY,
  lead_id       INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,             -- created | status_change | remark | call | followup_set | assigned
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  meta_json     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_actions_lead ON lead_actions(lead_id, created_at);

-- TAT threshold per status (admin-configured). If absent, no TAT enforcement.
CREATE TABLE IF NOT EXISTS tat_thresholds (
  id                 SERIAL PRIMARY KEY,
  status_id          INTEGER UNIQUE REFERENCES statuses(id) ON DELETE CASCADE,
  threshold_minutes  INTEGER NOT NULL DEFAULT 60,
  is_active          INTEGER NOT NULL DEFAULT 1,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per lead-stage breach. Escalation level walks up: 1=employee,
-- 2=manager, 3=admin. resolved_at populated when the lead leaves the stage.
CREATE TABLE IF NOT EXISTS tat_violations (
  id                 SERIAL PRIMARY KEY,
  lead_id            INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status_id          INTEGER,
  user_id            INTEGER,                  -- the assigned salesperson
  threshold_minutes  INTEGER,
  triggered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  escalation_level   INTEGER NOT NULL DEFAULT 1,
  last_escalated_at  TIMESTAMPTZ,
  notes              TEXT
);
CREATE INDEX IF NOT EXISTS idx_tat_v_open ON tat_violations(lead_id) WHERE resolved_at IS NULL;

-- ---- v12: WhatsBot module ------------------------------------
-- Enrich whatsapp_messages with media + reply tracking
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS user_id      INTEGER;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS message_type TEXT;       -- text|image|video|audio|document|template|button|interactive
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_url    TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_id     TEXT;       -- WhatsApp media id (for retrieval)
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS reply_to     TEXT;       -- wa_message_id of the message being replied to
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS read_at      TIMESTAMPTZ;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_wa_msg_phone ON whatsapp_messages(from_number, to_number, created_at);
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS error_text TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS template_name TEXT;

-- ---- Multi-WhatsApp Phase 3 (2026-05-08) ----------------------------
-- Tag every row with which of OUR connected phones it belongs to so the
-- chat-threads list can filter by inbox + auto-route inbound replies
-- back via the same number the customer originally messaged. NULL
-- (legacy data pre-migration) falls back to the tenant default.
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wa_messages_phone_id
  ON whatsapp_messages(phone_number_id, created_at DESC);

-- ---- v13: Google Ads / UTM attribution as first-class columns ------
-- The webhook handler already stores these in meta_json, but as columns
-- they're filterable / reportable / displayable in the leads list.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gclid          TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS gad_campaignid TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_source     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_medium     TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_campaign   TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term       TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content    TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_gclid    ON leads(gclid);
CREATE INDEX IF NOT EXISTS idx_leads_utm      ON leads(utm_source, utm_campaign);

-- ---- v14: HR fields on users -------------------------------
-- Onboarding info admins / HR want to capture per employee.
ALTER TABLE users ADD COLUMN IF NOT EXISTS father_name           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address               TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS aadhaar_number        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pan_number            TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_company          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_name      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_phone     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_1_relation  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_name      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_phone     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reference_2_relation  TEXT;

-- Pause incoming leads for this user. Independent of is_active (which
-- gates login). When paused_for_leads = TRUE, every future-lead routing
-- decision skips the user: auto-assign rules, campaign distribution
-- (round_robin / equal / percentage / conditional / on_demand pull),
-- WhatsApp inbound auto-routing, bulk-assign loops. Existing leads stay
-- with the user; un-pausing simply resumes future routing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS paused_for_leads BOOLEAN NOT NULL DEFAULT FALSE;

-- Cached approved templates from Meta (refreshed periodically)
CREATE TABLE IF NOT EXISTS wa_templates (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  language        TEXT NOT NULL,
  status          TEXT,                       -- APPROVED | PENDING | REJECTED
  category        TEXT,                       -- MARKETING | UTILITY | AUTHENTICATION
  body_text       TEXT,
  components_json JSONB,
  body_params     INTEGER NOT NULL DEFAULT 0,
  header_type     TEXT,
  has_buttons     INTEGER NOT NULL DEFAULT 0,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, language)
);

-- Outbound campaigns (broadcast a template to many recipients)
CREATE TABLE IF NOT EXISTS wa_campaigns (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  relation_type    TEXT NOT NULL DEFAULT 'leads',  -- leads|users (for now leads)
  template_name    TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  variables_json   JSONB,                      -- [{var:'V1', value:'@{name}'}, ...]
  image_url        TEXT,
  filter_json      JSONB,                      -- {status_id, source, assigned_to, tag, ids[]}
  scheduled_at     TIMESTAMPTZ,
  send_now         INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'draft',  -- draft|queued|sending|paused|completed|failed
  recipients_total INTEGER NOT NULL DEFAULT 0,
  recipients_sent  INTEGER NOT NULL DEFAULT 0,
  recipients_failed INTEGER NOT NULL DEFAULT 0,
  recipients_delivered INTEGER NOT NULL DEFAULT 0,
  recipients_read  INTEGER NOT NULL DEFAULT 0,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wa_camp_status ON wa_campaigns(status);

-- Per-recipient row of a campaign (so we can resume / track / show progress)
CREATE TABLE IF NOT EXISTS wa_campaign_targets (
  id            SERIAL PRIMARY KEY,
  campaign_id   INTEGER NOT NULL REFERENCES wa_campaigns(id) ON DELETE CASCADE,
  lead_id       INTEGER,
  phone         TEXT NOT NULL,
  name          TEXT,
  rendered_message TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|delivered|read|failed
  wa_message_id TEXT,
  error         TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_camp_targets ON wa_campaign_targets(campaign_id, status);

-- Message bots — when an incoming message matches `trigger`, send `reply_text`
CREATE TABLE IF NOT EXISTS wa_message_bots (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  relation_type   TEXT NOT NULL DEFAULT 'leads',
  reply_text      TEXT NOT NULL,
  reply_type      TEXT NOT NULL DEFAULT 'contains',   -- exact | contains
  trigger_text    TEXT NOT NULL,                       -- comma-separated keywords
  header          TEXT,
  footer          TEXT,
  buttons_json    JSONB,                               -- option 1: reply buttons
  cta_button_json JSONB,                               -- option 2: CTA button
  image_url       TEXT,                                -- option 3: image
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Template bots — when an incoming message matches `trigger`, send a template
CREATE TABLE IF NOT EXISTS wa_template_bots (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  relation_type   TEXT NOT NULL DEFAULT 'leads',
  template_name   TEXT NOT NULL,
  template_language TEXT NOT NULL DEFAULT 'en_US',
  variables_json  JSONB,
  reply_type      TEXT NOT NULL DEFAULT 'exact',
  trigger_text    TEXT NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Activity log — every Meta API request we make
CREATE TABLE IF NOT EXISTS wa_activity_log (
  id              SERIAL PRIMARY KEY,
  category        TEXT NOT NULL,    -- campaign|template_bot|message_bot|chat|template_sync
  name            TEXT,
  template_name   TEXT,
  response_code   INTEGER,
  type            TEXT,             -- leads|users
  request_json    JSONB,
  response_json   JSONB,
  recorded_on     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_act_cat ON wa_activity_log(category, recorded_on DESC);

-- ---- v15: Knowledge base -------------------------------------
-- Admin-curated reference content for the sales team — scripts, FAQs,
-- offers, brochures, pricing sheets, and any URL the team needs at hand
-- when talking to a customer. Everyone can read; only admin can write.
CREATE TABLE IF NOT EXISTS knowledge_base (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'other',
                 -- script | faq | offer | brochure | pricing | video | link | other
  body         TEXT,                                -- main content (markdown / plain text)
  url          TEXT,                                -- optional external link (Drive / Box / YouTube / etc.)
  tags         TEXT,                                -- comma-separated for filtering
  product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
  is_pinned    INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kb_active_pinned ON knowledge_base(is_active, is_pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_category ON knowledge_base(category);

-- ---- v16: Announcements --------------------------------------
-- Top-of-screen banner posted by admin, visible to everyone until they
-- dismiss (per-user) or admin deactivates / it expires.
CREATE TABLE IF NOT EXISTS announcements (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,
  body            TEXT,
  severity        TEXT NOT NULL DEFAULT 'info', -- info | success | warning | danger
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_dismissible  INTEGER NOT NULL DEFAULT 1,
  expires_at      TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  dismissed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, announcement_id)
);

-- ---- v17: Internal team chat ---------------------------------
-- Two flavours of room:
--   channel — public, everyone implicitly a member (the org-wide "team" room)
--   dm      — direct message, exactly two members
CREATE TABLE IF NOT EXISTS chat_rooms (
  id          SERIAL PRIMARY KEY,
  type        TEXT NOT NULL,      -- channel | dm
  name        TEXT,               -- for channels e.g. 'team'; null for DMs
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_room_members (
  id            SERIAL PRIMARY KEY,
  room_id       INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at  TIMESTAMPTZ,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id          SERIAL PRIMARY KEY,
  room_id     INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_msg_room ON chat_messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_member_user ON chat_room_members(user_id);

-- Seed the org-wide "team" channel so every CRM has one out of the box
INSERT INTO chat_rooms (type, name)
SELECT 'channel', 'team'
WHERE NOT EXISTS (SELECT 1 FROM chat_rooms WHERE type = 'channel' AND name = 'team');

-- ---- v18: Attendance work mode + 30-min location pings -----------
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS work_mode TEXT;
                         -- office | home | on_site
CREATE TABLE IF NOT EXISTS location_pings (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_id  INTEGER REFERENCES attendance(id) ON DELETE SET NULL,
  lat            NUMERIC(10,6),
  lng            NUMERIC(10,6),
  location_name  TEXT,
  accuracy_m     NUMERIC(10,1),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_location_pings_user_date ON location_pings(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_location_pings_attendance ON location_pings(attendance_id);

-- ---- v11: TOTP 2FA (Google Authenticator compatible) ------------------
-- totp_secret is the user's base32-encoded HMAC secret. Stored plaintext
-- here for simplicity; if you need defense-in-depth later, encrypt at
-- rest via app-level AES-GCM with a key in env. totp_enabled gates the
-- check on login — set to 1 only after the user has scanned the QR and
-- successfully verified one OTP, so a half-set-up account can still log in.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_verified_at TIMESTAMPTZ;

-- ---- v12: saved filter presets per user --------------------------------
-- Lets users save named combinations of leads-list filters (status,
-- assignee, source, qualified, etc.) and re-apply them with one click.
CREATE TABLE IF NOT EXISTS saved_filters (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  view         TEXT NOT NULL DEFAULT 'leads',
  filter_json  JSONB NOT NULL,
  is_shared    INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_filters_user ON saved_filters(user_id);

-- ===========================================================
-- Customers — post-sale lifecycle (Stockbox-specific, but the
-- tables are tenant-neutral so Celeste can opt in later).
-- ===========================================================
-- Why a separate `customers` table instead of flagging leads:
--   1. A customer can buy multiple products over time — leads are
--      single-funnel objects, customers compound.
--   2. Customer status (active/lapsed/churned) is independent of the
--      original lead's funnel status. Once a deal is won, the lead
--      stays in "Won" forever; the customer can churn next year.
--   3. KYC + risk-profile + lifetime-value live here, not on the lead.
CREATE TABLE IF NOT EXISTS customers (
  id                SERIAL PRIMARY KEY,
  from_lead_id      INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  phone             TEXT,
  alt_phone         TEXT,
  whatsapp          TEXT,
  email             TEXT,
  pan               TEXT,
  date_of_birth     DATE,
  gender            TEXT,
  occupation        TEXT,
  income_range      TEXT,
  risk_profile      TEXT,                              -- low|medium|high (Stockbox)
  address           TEXT,
  city              TEXT,
  state             TEXT,
  pincode           TEXT,
  country           TEXT DEFAULT 'India',
  company           TEXT,
  customer_since    DATE NOT NULL DEFAULT CURRENT_DATE,
  status            TEXT NOT NULL DEFAULT 'active',    -- active|lapsed|churned|inactive
  tags              TEXT,
  notes             TEXT,
  assigned_to       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lifetime_value    NUMERIC(14,2) DEFAULT 0,
  total_purchases   INTEGER DEFAULT 0,
  last_purchase_at  TIMESTAMPTZ,
  next_renewal_at   TIMESTAMPTZ,
  extra_json        JSONB,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customers_assigned ON customers(assigned_to);
CREATE INDEX IF NOT EXISTS idx_customers_status   ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_phone    ON customers(phone);

-- Every transaction (initial sale, renewal, upsell, cross-sell). One
-- customer, many rows. lifetime_value, total_purchases, last_purchase_at
-- on the customers row are kept in sync from this table by the
-- application code so reports stay fast.
CREATE TABLE IF NOT EXISTS customer_sales (
  id                 SERIAL PRIMARY KEY,
  customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id         INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name       TEXT,                                 -- snapshot
  sale_type          TEXT NOT NULL DEFAULT 'new',          -- new|renewal|upgrade|cross_sell
  sold_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sold_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount             NUMERIC(14,2),
  currency           TEXT DEFAULT 'INR',
  payment_status     TEXT DEFAULT 'paid',                  -- paid|pending|partial|refunded
  payment_method     TEXT,                                 -- razorpay|upi|bank|cash|other
  payment_reference  TEXT,
  subscription_start DATE,
  subscription_end   DATE,
  status             TEXT DEFAULT 'active',                -- active|expired|cancelled
  notes              TEXT,
  invoice_url        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_sales_customer ON customer_sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_sales_subend   ON customer_sales(subscription_end);
CREATE INDEX IF NOT EXISTS idx_customer_sales_status   ON customer_sales(status);

-- Free-form remarks per customer — like lead remarks but separate, since
-- the customer's post-sale conversation continues long after the lead is
-- closed and we don't want it polluting the lead's audit trail.
CREATE TABLE IF NOT EXISTS customer_remarks (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  remark       TEXT NOT NULL,
  remark_type  TEXT DEFAULT 'note',     -- note|call|whatsapp|email|meeting|upsell|complaint
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customer_remarks_customer ON customer_remarks(customer_id, created_at DESC);

-- ---- v13: monthly targets per user (or org-wide) -----------------------
-- One row per (user_id, month). user_id = NULL → org-wide target.
-- Used by the Monthly Target dashboard to compute Achievement %,
-- Required Daily Target, Forecast etc.
CREATE TABLE IF NOT EXISTS monthly_targets (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  month           TEXT NOT NULL,           -- 'YYYY-MM'
  target_revenue  NUMERIC(14,2) DEFAULT 0,
  target_leads    INTEGER DEFAULT 0,
  target_sales    INTEGER DEFAULT 0,
  target_calls    INTEGER DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_targets_unique ON monthly_targets(COALESCE(user_id, 0), month);
CREATE INDEX IF NOT EXISTS idx_monthly_targets_month ON monthly_targets(month);

-- ---- v14: lead caps per user --------------------------------------
-- Daily / monthly caps on how many leads a rep can be assigned. 0 = no
-- cap (default). Enforced by the auto-assignment path (round-robin,
-- assignment rules, website webhook). Admin manual assigns bypass.
ALTER TABLE users ADD COLUMN IF NOT EXISTS daily_lead_cap   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_lead_cap INTEGER NOT NULL DEFAULT 0;

-- ---- Calendly scheduling --------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendly_url TEXT;

-- ---- Inventory ------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  item_type       TEXT,
  price           NUMERIC(14,2) DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'available',
  location        TEXT,
  description     TEXT,
  attributes      JSONB DEFAULT '{}'::jsonb,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_status ON inventory(status);
CREATE INDEX IF NOT EXISTS idx_inventory_type   ON inventory(item_type);
CREATE INDEX IF NOT EXISTS idx_inventory_price  ON inventory(price);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS budget_max        NUMERIC(14,2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS requirement_type  TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS requirement_notes TEXT;

-- ---- Post-sale project stages ---------------------------------
CREATE TABLE IF NOT EXISTS project_stages (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 10,
  expected_days INTEGER NOT NULL DEFAULT 7,
  assignee_role TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_project_stages_sort ON project_stages(sort_order);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS project_stage_id         INTEGER REFERENCES project_stages(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS project_stage_started_at TIMESTAMPTZ;

-- ---- Personal WhatsApp templates -------------------------------
CREATE TABLE IF NOT EXISTS personal_wa_templates (
  id          SERIAL PRIMARY KEY,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  body        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pwa_templates_owner ON personal_wa_templates(owner_id);

-- ---- Calendly per-rep webhook ----------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS calendly_webhook_token TEXT;
CREATE INDEX IF NOT EXISTS idx_users_calendly_token ON users(calendly_webhook_token);

-- ---- Google Sheet sync ----------------------------------------
CREATE TABLE IF NOT EXISTS sheet_integrations (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  sheet_id            TEXT NOT NULL,
  sheet_gid           TEXT DEFAULT '0',
  default_source      TEXT DEFAULT 'Google Sheet',
  default_assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  poll_interval_min   INTEGER NOT NULL DEFAULT 15,
  last_synced_at      TIMESTAMPTZ,
  last_synced_count   INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sheet_imported_rows (
  integration_id INTEGER NOT NULL REFERENCES sheet_integrations(id) ON DELETE CASCADE,
  row_hash       TEXT NOT NULL,
  imported_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  PRIMARY KEY (integration_id, row_hash)
);
CREATE INDEX IF NOT EXISTS idx_sheet_imported_rows_int ON sheet_imported_rows(integration_id);

-- ---- Sheet integration push token -----------------------------
ALTER TABLE sheet_integrations ADD COLUMN IF NOT EXISTS webhook_token TEXT;
CREATE INDEX IF NOT EXISTS idx_sheet_int_token ON sheet_integrations(webhook_token);
-- Allow empty sheet_id so an integration can run in push-only mode
-- (Apps Script POSTs new rows to /hook/sheet/{webhook_token}, no CSV
-- pull required). The legacy NOT NULL constraint blocked admins from
-- switching an existing integration over to push mode.
ALTER TABLE sheet_integrations ALTER COLUMN sheet_id DROP NOT NULL;

-- ===========================================================
-- v15: AI call summary (Gemini 2.5 Flash powered)
-- Columns added to lead_recordings to hold the AI-generated
-- transcript, summary, action items, sentiment, and a suggested
-- next status. The background worker (utils/aiCallSummary.js)
-- picks up rows where ai_processed_at IS NULL and fills these in.
-- ===========================================================
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS transcript          TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS summary             TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS action_items        TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS sentiment           TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS suggested_status_id INTEGER REFERENCES statuses(id) ON DELETE SET NULL;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS next_followup_days  INTEGER;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS key_insight         TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_processed_at     TIMESTAMPTZ;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_provider         TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_model            TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_error            TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_rec_ai_processed ON lead_recordings(ai_processed_at);

-- ===========================================================
-- v16: Call rating (1-5 stars)
-- Reps + managers can rate every call recording, AI also
-- suggests a rating during summarisation.
-- ===========================================================
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS rating              INTEGER;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS rating_by           INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS rating_notes        TEXT;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS rated_at            TIMESTAMPTZ;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_suggested_rating INTEGER;
CREATE INDEX IF NOT EXISTS idx_lead_rec_rating ON lead_recordings(rating);
CREATE INDEX IF NOT EXISTS idx_lead_rec_rating_by ON lead_recordings(rating_by);

-- ===========================================================
-- v17: AI usage + cost tracking per recording
-- ===========================================================
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_input_tokens   INTEGER;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_output_tokens  INTEGER;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_cost_usd       NUMERIC(10,6);
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS ai_cost_inr       NUMERIC(10,4);
CREATE INDEX IF NOT EXISTS idx_lead_rec_ai_cost ON lead_recordings(ai_cost_usd);

-- ===========================================================
-- v18: WhatsApp attachments — files reps upload to send via WA
-- ===========================================================
CREATE TABLE IF NOT EXISTS wa_attachments (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  filename       TEXT,
  mime_type      TEXT,
  size_bytes     INTEGER,
  bytes          BYTEA,
  wa_media_id    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_attach_user ON wa_attachments(user_id);
CREATE INDEX IF NOT EXISTS idx_wa_attach_created ON wa_attachments(created_at);

-- ===========================================================
-- v19: WhatsApp chat assignment (à la WATI / Interakt)
-- ===========================================================
CREATE TABLE IF NOT EXISTS wa_chat_assignments (
  phone        TEXT PRIMARY KEY,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_chat_assigned_to ON wa_chat_assignments(assigned_to);

CREATE TABLE IF NOT EXISTS wa_chat_assignment_log (
  id           SERIAL PRIMARY KEY,
  phone        TEXT NOT NULL,
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_chat_log_phone ON wa_chat_assignment_log(phone);

-- Pull Leads audit log
CREATE TABLE IF NOT EXISTS lead_pull_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  pulled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_first    INTEGER NOT NULL DEFAULT 0,
  source      TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_pull_log_user ON lead_pull_log(user_id, pulled_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_pull_log_lead ON lead_pull_log(lead_id);

-- Per-tenant custom roles
CREATE TABLE IF NOT EXISTS roles (
  id              SERIAL PRIMARY KEY,
  key             TEXT UNIQUE NOT NULL,
  label           TEXT NOT NULL,
  hierarchy_level INTEGER NOT NULL DEFAULT 3,
  is_system       INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roles_key    ON roles(key);
CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active);

-- ---- v20: drop legacy tax columns (unused by the CRM) --------
-- These were added manually to some tenant DBs and are not part
-- of the schema. IF NOT EXISTS / IF EXISTS makes this idempotent
-- so it is safe to re-run on any tenant (new or old).
ALTER TABLE leads          DROP COLUMN IF EXISTS tax;
ALTER TABLE customer_sales DROP COLUMN IF EXISTS tax;
ALTER TABLE products       DROP COLUMN IF EXISTS tax;
ALTER TABLE customers      DROP COLUMN IF EXISTS tax;
-- Migration: Campaigns (smartcrm-saas)
-- 2026-05-08 — idempotent. Run on EVERY tenant DB.
--
-- Adds two tables:
--   campaigns        — one row per pre-sales / sales campaign an admin
--                       defines (name, pipeline, manager, distribution
--                       mode, pull batch size, removed-user policy).
--   campaign_agents  — junction: which users belong to which campaigns,
--                       with their distribution weight (for percentage
--                       mode) and round-robin position cursor.
--
-- Distribution modes:
--   on_demand    — leads stay unassigned until an agent calls Pull.
--   equal        — every new lead is round-robin'd across active agents
--                   so totals stay balanced over time.
--   round_robin  — same as equal but uses rr_position as a strict cursor
--                   so order is deterministic across server restarts.
--   percentage   — each agent's weight_pct is the % of new leads they
--                   receive (must sum to 100 across active agents).
--   conditional  — JSON rule list in conditional_rules decides per-lead
--                   (matches by source / city / product / custom-field).
--
-- Removed-user actions (when an agent is taken off a campaign):
--   pool      — their open leads go back to the unassigned pool for
--                redistribution by the campaign's distribution mode.
--   hidden    — leads stay assigned to the (now-removed) user but are
--                hidden from every agent's list view; an admin must
--                manually reassign them to surface them again.
--   manager   — leads are reassigned to the campaign's manager_user_id.

CREATE TABLE IF NOT EXISTS campaigns (
  id                            SERIAL PRIMARY KEY,
  name                          TEXT    NOT NULL,
  -- Optional pipeline scope. NULL = applies to leads in any pipeline.
  -- We don't FK this because the existing CRM doesn't have a pipelines
  -- table per se; pipeline is a soft string label. Stored as text.
  pipeline                      TEXT,
  -- The user who oversees the campaign. Used as the fallback assignee
  -- when removed_user_action='manager'. Nullable so admin-less setups
  -- still work; the admin user is the implicit fallback then.
  manager_user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  distribution_mode             TEXT    NOT NULL DEFAULT 'on_demand'
                                  CHECK (distribution_mode IN
                                    ('on_demand','equal','round_robin','percentage','conditional')),
  -- For on_demand: how many leads each Pull dispenses.
  pull_batch_size               INTEGER NOT NULL DEFAULT 10,
  -- For on_demand: the user's first pull can be larger (matches the
  -- existing LEAD_PULL_INITIAL_COUNT pattern).
  pull_initial_count            INTEGER NOT NULL DEFAULT 10,
  -- If true, an agent can only pull a new batch once they've updated
  -- (status change OR follow-up logged) every previously-pulled lead
  -- that's older than pull_old_threshold_minutes.
  pull_require_old_updated      INTEGER NOT NULL DEFAULT 0,
  pull_old_threshold_minutes    INTEGER NOT NULL DEFAULT 60,
  -- What to do with an agent's open leads when they're removed from
  -- this campaign. See header comment.
  removed_user_action           TEXT    NOT NULL DEFAULT 'pool'
                                  CHECK (removed_user_action IN ('pool','hidden','manager')),
  -- Free-form JSON for the conditional distribution rule editor.
  -- Shape: [{ "if": { "source": "Website" }, "then": { "user_id": 12 } }, ...]
  conditional_rules             JSONB,
  is_active                     INTEGER NOT NULL DEFAULT 1,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaigns_active   ON campaigns(is_active) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_campaigns_pipeline ON campaigns(pipeline);

CREATE TABLE IF NOT EXISTS campaign_agents (
  id           SERIAL PRIMARY KEY,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  -- For percentage mode. Sum across active rows in a campaign should
  -- equal 100 — enforced at the API layer (a CHECK can't span rows).
  weight_pct   INTEGER NOT NULL DEFAULT 100,
  -- For round_robin mode. Cursor used by the assigner; bump each time
  -- this agent receives a lead. The agent with the lowest rr_position
  -- among active members is the next pick.
  rr_position  INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_campaign_agents_user     ON campaign_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_agents_campaign ON campaign_agents(campaign_id, is_active);

-- Add lead → campaign reverse pointer so we can:
--   • filter the Leads list by campaign
--   • implement removed_user_action='hidden' (filter out leads whose
--     assignee is no longer in the lead's campaign)
--   • route status-change events to the right campaign's automations
ALTER TABLE leads ADD COLUMN IF NOT EXISTS campaign_id INTEGER;
DO $$ BEGIN
  -- Foreign key only if not already there. Wrap in DO so re-runs don't error.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_campaign_id_fkey'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id) WHERE campaign_id IS NOT NULL;

-- Same hidden flag we'll use for removed_user_action='hidden'. NOT a
-- soft-delete — the lead is fully alive, it's just filtered out of
-- agent list views until an admin reassigns it.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS is_hidden INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_leads_hidden ON leads(is_hidden) WHERE is_hidden = 1;
-- Migration: Custom Dashboard Widgets (smartcrm-saas)
-- 2026-05-08 — idempotent. Run on EVERY tenant DB.
--
-- One row per user, holding the JSON list of widgets that user has
-- pinned to their personal Dashboard. The dashboard loads this row
-- on render and walks the array, mapping each entry's `type` to a
-- renderer + the existing Reports API endpoints. New widgets can be
-- added in the SPA without changing this schema — the JSONB is
-- forward-compatible.
--
-- Widget shape:
--   {
--     "id":     "unique string per row in this user's grid",
--     "type":   "kpi_total_leads"|"chart_status"|"funnel_pipeline"|...,
--     "title":  "optional override label (default = widget's built-in title)",
--     "size":   "small"|"medium"|"wide" (CSS class hint),
--     "config": { ...widget-specific options, e.g. user_id, date_range, source }
--   }
--
-- A NULL or empty widgets list means "user hasn't customised yet" — the
-- SPA falls back to a sensible default layout (the same widgets the
-- previous static dashboard rendered).

CREATE TABLE IF NOT EXISTS user_dashboard (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  widgets    JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Migration: Multiple WhatsApp Phone Numbers per tenant (smartcrm-saas)
-- 2026-05-08 — idempotent. Run on EVERY tenant DB.
--
-- Today the CRM stores ONE WhatsApp connection in the config table:
--   WHATSAPP_PHONE_NUMBER_ID  · WHATSAPP_BUSINESS_ACCOUNT_ID
--   WHATSAPP_ACCESS_TOKEN     · WHATSAPP_VERIFY_TOKEN
--
-- This migration adds wa_phones, a per-row store so a tenant can connect
-- many numbers at once (different WABAs allowed). The config keys above
-- continue to reflect the DEFAULT phone for backwards compat — anywhere
-- the old _cfg() helper reads them, behaviour is unchanged when there's
-- only one phone connected.
--
-- The SPA uses wa_phones for its "Connected numbers" admin table. The
-- central PHP forwarder (smartcrmsolution.com/whatsbot_webhook_all.php)
-- routes inbound events by phone_number_id, so each row in wa_phones
-- needs to register itself once via whatsbot_register.php (the existing
-- _registerWithCentralForwarder helper). After Phase 1 ships, the
-- inbound webhook handler can switch the lookup from "single config"
-- to "wa_phones row WHERE phone_number_id = ?" without breaking
-- existing tenants — every row is keyed identically.

CREATE TABLE IF NOT EXISTS wa_phones (
  id                    SERIAL  PRIMARY KEY,
  phone_number_id       TEXT    NOT NULL UNIQUE,    -- the WhatsApp Cloud API phone_number_id
  business_account_id   TEXT,                       -- WABA owning this phone
  access_token          TEXT    NOT NULL,           -- system user token for this WABA
  display_phone_number  TEXT,                       -- "+91 98765 43210" — for the UI
  verified_name         TEXT,                       -- the green-tick name Meta returned
  label                 TEXT,                       -- admin-friendly label, e.g. "Sales line", "Support"
  quality_rating        TEXT,                       -- 'GREEN' | 'YELLOW' | 'RED' | '' — last seen
  status                TEXT,                       -- 'CONNECTED' etc. — last seen
  messaging_limit_tier  TEXT,                       -- 'TIER_1K' | 'TIER_10K' | …
  is_default            INTEGER NOT NULL DEFAULT 0, -- only one row should have is_default=1
  is_active             INTEGER NOT NULL DEFAULT 1,
  last_seen_at          TIMESTAMPTZ,                -- last time we refreshed metadata from Meta
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_phones_default ON wa_phones(is_default) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_wa_phones_active  ON wa_phones(is_active)  WHERE is_active  = 1;

-- ============================================================
-- WhatsApp AI Bot — per-tenant tables (added 2026-05-08)
-- ============================================================
-- Each tenant has its own AI bot powered by Gemini (key managed
-- centrally on the control plane — see control/schema.sql →
-- ai_settings).  These tables hold the per-tenant config + KB +
-- per-conversation log.  All idempotent, safe to re-apply.

-- ---- ai_bot_settings (singleton row per tenant) -----------------
CREATE TABLE IF NOT EXISTS ai_bot_settings (
  id                          INTEGER PRIMARY KEY DEFAULT 1,
  is_enabled                  INTEGER NOT NULL DEFAULT 0,
  bot_name                    TEXT NOT NULL DEFAULT 'Assistant',
  business_name               TEXT,
  language                    TEXT NOT NULL DEFAULT 'en',
  system_prompt               TEXT,
  welcome_message             TEXT,
  reply_modes                 JSONB NOT NULL DEFAULT '["always"]'::jsonb,
  business_hours              JSONB NOT NULL DEFAULT '{"tz":"Asia/Kolkata","days":[1,2,3,4,5],"start":"09:00","end":"19:00"}'::jsonb,
  trigger_keywords            TEXT,
  off_keywords                TEXT,
  active_phone_number_ids     JSONB DEFAULT '[]'::jsonb,
  resume_after_idle_minutes   INTEGER NOT NULL DEFAULT 1440,
  max_replies_per_thread      INTEGER NOT NULL DEFAULT 0,
  escalation_keywords         TEXT,
  model_override              TEXT,
  use_kb                      INTEGER NOT NULL DEFAULT 1,
  kb_max_chars                INTEGER NOT NULL DEFAULT 60000,
  history_messages            INTEGER NOT NULL DEFAULT 8,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_bot_settings_singleton CHECK (id = 1)
);
INSERT INTO ai_bot_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---- ai_kb_documents --------------------------------------------
CREATE TABLE IF NOT EXISTS ai_kb_documents (
  id              SERIAL PRIMARY KEY,
  source_type     TEXT NOT NULL DEFAULT 'text',
  title           TEXT NOT NULL,
  raw_text        TEXT NOT NULL,
  source_url      TEXT,
  file_path       TEXT,
  file_size       INTEGER,
  is_active       INTEGER NOT NULL DEFAULT 1,
  ingest_status   TEXT NOT NULL DEFAULT 'ready',
  ingest_error    TEXT,
  char_count      INTEGER GENERATED ALWAYS AS (LENGTH(raw_text)) STORED,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_kb_active ON ai_kb_documents(is_active) WHERE is_active = 1;

-- ---- ai_chat_log ------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_chat_log (
  id                SERIAL PRIMARY KEY,
  phone             TEXT NOT NULL,
  lead_id           INTEGER,
  inbound_msg_id    INTEGER REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  outbound_msg_id   INTEGER REFERENCES whatsapp_messages(id) ON DELETE SET NULL,
  draft_text        TEXT,
  reply_text        TEXT,
  model             TEXT,
  mode_used         TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_inr_billed   DECIMAL(12,4) NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'sent',
  suppressed_reason TEXT,
  error_text        TEXT,
  phone_number_id   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_phone   ON ai_chat_log(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_status  ON ai_chat_log(status);
CREATE INDEX IF NOT EXISTS idx_ai_chat_created ON ai_chat_log(created_at DESC);

-- ai_bot_settings: switch idle window from minutes to seconds (2026-05-08)
-- Lets tenants set 10s / 20s for fast testing of the resume rule.
ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS resume_after_idle_seconds INTEGER NOT NULL DEFAULT 86400;
UPDATE ai_bot_settings
   SET resume_after_idle_seconds = COALESCE(resume_after_idle_minutes, 1440) * 60
 WHERE resume_after_idle_seconds = 86400 AND resume_after_idle_minutes IS NOT NULL;

-- ============================================================
-- Quotations (2026-05-08)
-- ============================================================
-- Author quotations directly in the CRM, send to customer via email
-- and/or WhatsApp, share a public link the customer can view in the
-- browser. Each quotation has a header (number, dates, totals, terms)
-- and N line items.
--
-- Public access: a per-quote 'public_token' (random string). The
-- public viewer at /q/<token> renders an HTML page using the same
-- styles — customer-print-to-PDF works without us shipping a PDF
-- generator. Tokens are revocable; setting is_public = 0 hides the
-- public page even if someone has the URL.

CREATE TABLE IF NOT EXISTS quotations (
  id              SERIAL PRIMARY KEY,
  number          TEXT NOT NULL UNIQUE,         -- e.g. Q-2026-0001
  lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  customer_id     INTEGER,                       -- optional FK to customers if present
  customer_name   TEXT NOT NULL,
  customer_email  TEXT,
  customer_phone  TEXT,
  customer_address TEXT,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | sent | accepted | rejected | expired
  issue_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until     DATE,
  currency        TEXT NOT NULL DEFAULT 'INR',
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  discount_amt    NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_pct         NUMERIC(5,2)  NOT NULL DEFAULT 18,
  tax_amt         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  terms           TEXT,
  public_token    TEXT UNIQUE,                   -- random; used by /q/<token>
  is_public       INTEGER NOT NULL DEFAULT 1,
  sent_at         TIMESTAMPTZ,
  sent_via        TEXT,                          -- 'email' | 'whatsapp' | 'email+whatsapp'
  accepted_at     TIMESTAMPTZ,
  rejected_at     TIMESTAMPTZ,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_quotations_lead     ON quotations(lead_id);
CREATE INDEX IF NOT EXISTS idx_quotations_status   ON quotations(status);
CREATE INDEX IF NOT EXISTS idx_quotations_token    ON quotations(public_token);
CREATE INDEX IF NOT EXISTS idx_quotations_created  ON quotations(created_at DESC);

CREATE TABLE IF NOT EXISTS quotation_items (
  id              SERIAL PRIMARY KEY,
  quotation_id    INTEGER NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL DEFAULT 0,
  product_id      INTEGER,                       -- optional FK to products
  description     TEXT NOT NULL,
  quantity        NUMERIC(12,3) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_qitems_quote ON quotation_items(quotation_id, position);


-- ============================================================
-- Lead-source field mapping (2026-05-09)
-- ============================================================
-- Per-source override table. The default _adaptLeadSourcePayload
-- mappers in routes/integrations.js are still applied as a fallback,
-- but if a row exists here for a given source, its mapping takes
-- precedence.
--
-- mapping JSONB format: { "<incoming_key>": "<crm_field>", ... }
--   <crm_field> can be: name | phone | email | company | city | state |
--                       address | source | source_ref | notes | product |
--                       value | tags | cf_<custom_key>
--
-- last_payload JSONB stores the most recent received payload so the
-- mapping UI can show real keys the operator can drag-and-map.

CREATE TABLE IF NOT EXISTS lead_source_mapping (
  source        TEXT PRIMARY KEY,
  mapping       JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_payload  JSONB,
  last_seen_at  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- One-time data migration (2026-05-09)
-- Lower AI Bot kb_max_chars from the old 60000 default to 8000
-- for tenants who never explicitly customised it. Cuts input
-- token cost ~85% with negligible answer-quality loss.
-- Idempotent: only matches rows still at the old default.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_bot_settings') THEN
    UPDATE ai_bot_settings
       SET kb_max_chars = 8000,
           updated_at   = NOW()
     WHERE kb_max_chars = 60000;
  END IF;
END $$;


-- ============================================================
-- 2026-05-10: AI Bot per-number scoping
-- Empty list (default) = bot replies on every connected number.
-- Non-empty list = bot only auto-replies when the inbound's
-- phone_number_id is in the list.
-- ============================================================
ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS active_phone_number_ids JSONB NOT NULL DEFAULT '[]'::jsonb;


-- ============================================================
-- 2026-05-10: WhatsApp Bot Flows (visual canvas builder)
-- Each tenant can define multiple guided flows triggered by
-- inbound keyword. Engine in routes/waBotFlows.js advances
-- a session per (phone, flow) until the customer reaches an
-- end / handoff / ai_handoff node.
-- ============================================================
CREATE TABLE IF NOT EXISTS wa_bot_flows (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  trigger       TEXT,
  trigger_match TEXT NOT NULL DEFAULT 'exact',
  is_active     INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 100,
  nodes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  start_node_id TEXT,
  created_by    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_bot_flow_sessions (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL,
  phone_number_id TEXT,
  flow_id         INTEGER NOT NULL REFERENCES wa_bot_flows(id) ON DELETE CASCADE,
  current_node_id TEXT NOT NULL,
  vars            JSONB NOT NULL DEFAULT '{}'::jsonb,
  lead_id         INTEGER,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_completed    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (phone)
);
CREATE INDEX IF NOT EXISTS idx_wa_bot_flow_sessions_phone ON wa_bot_flow_sessions(phone);


-- ============================================================
-- 2026-05-10: Per-number AI Bot configs
-- One row per WhatsApp number that wants its own training. The
-- legacy id=1 row keeps phone_number_id = NULL and acts as the
-- fallback when an inbound arrives on a phone with no specific
-- config. Partial unique index lets multiple per-phone rows
-- coexist while preventing duplicates per phone.
-- ============================================================
ALTER TABLE ai_bot_settings ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_bot_settings_phone
  ON ai_bot_settings(phone_number_id) WHERE phone_number_id IS NOT NULL;


-- ============================================================
-- 2026-05-10: KB doc per-phone scoping
-- NULL = global (every bot reads it). Specific phone_number_id =
-- only that phone's bot reads it. Lets a tenant with multiple
-- businesses keep their KBs separate per number.
-- ============================================================
ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ai_kb_documents_phone ON ai_kb_documents(phone_number_id);

-- ============================================================
-- IVR / Cloud Calling integration (2026-05-17)
-- ============================================================
-- Per-tenant config rows for any IVR vendor (Exotel, MyOperator,
-- Knowlarity, Tata Tele, Servetel, Ozonetel, Twilio, or Generic).
-- Inbound webhook URL: /t/<slug>/hook/ivr/<vendor_key>?secret=<webhook_secret>
-- Outbound click-to-call dispatched via the vendor's API by routes/ivr.js.
CREATE TABLE IF NOT EXISTS ivr_configs (
  id                SERIAL PRIMARY KEY,
  vendor_key        TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  is_default        INTEGER NOT NULL DEFAULT 0,
  api_base_url      TEXT,
  account_sid       TEXT,
  api_key           TEXT,
  api_token         TEXT,
  caller_id         TEXT,
  webhook_secret    TEXT,
  field_mapping     JSONB,
  auto_create_lead  INTEGER NOT NULL DEFAULT 1,
  default_status_id INTEGER REFERENCES statuses(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ivr_active ON ivr_configs(is_active);
CREATE INDEX IF NOT EXISTS idx_ivr_vendor ON ivr_configs(vendor_key);

ALTER TABLE users ADD COLUMN IF NOT EXISTS ivr_agent_id  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ivr_extension TEXT;

ALTER TABLE call_events ADD COLUMN IF NOT EXISTS ivr_call_id   TEXT;
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS ivr_vendor    TEXT;
ALTER TABLE call_events ADD COLUMN IF NOT EXISTS recording_url TEXT;

-- PROMISE_TRACK_v1 (2026-05-18) — promised vs actual callback tracking
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS committed_callback_at TIMESTAMPTZ;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS actual_followup_at    TIMESTAMPTZ;
ALTER TABLE lead_recordings ADD COLUMN IF NOT EXISTS callback_gap_minutes  INTEGER;
-- ============================================================
-- Invoicing (GST) — per-tenant migration
-- ============================================================
-- Ported from the single-tenant Google Apps Script "GST Invoice System".
-- Lives inside EACH tenant database (tenant_<slug>) so every workspace
-- has fully isolated sellers / customers / items / invoices.
--
-- Module is OPT-IN: super-admin enables it for a tenant via
-- /admin → Tenants → Modules ("invoicing" key in moduleCatalog.js).
-- The tables are created here so the schema is always present; if the
-- module is disabled the API endpoints just 403 and the SPA hides the
-- nav. That way enabling/disabling is instant and free of migrations.
--
-- Indian GST regime defaults:
--   * Intra-state seller↔customer → CGST(½) + SGST(½)
--   * Inter-state seller↔customer → IGST(full)
--   * INR amounts, NUMERIC(14,2)
--   * GSTIN regex enforced at the application layer, not here
-- ============================================================

-- ---- inv_companies (sellers / "My Companies") --------------------
CREATE TABLE IF NOT EXISTS inv_companies (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  legal_name     TEXT,
  gstin          TEXT,
  pan            TEXT,
  state          TEXT,                  -- e.g. 'Delhi', drives intra/inter-state split
  state_code     TEXT,                  -- 2-digit GST state code
  address        TEXT,
  city           TEXT,
  pincode        TEXT,
  phone          TEXT,
  email          TEXT,
  website        TEXT,
  upi_id         TEXT,                  -- printed on invoice / used for QR
  bank_name      TEXT,
  bank_account   TEXT,
  bank_ifsc      TEXT,
  bank_branch    TEXT,
  logo_url       TEXT,
  signature_url  TEXT,
  prefix         TEXT NOT NULL DEFAULT 'INV',
  next_no        INTEGER NOT NULL DEFAULT 1,    -- atomic via row lock
  no_padding     INTEGER NOT NULL DEFAULT 6,    -- INV000001 padding
  default_terms  TEXT,
  default_notes  TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  is_default     INTEGER NOT NULL DEFAULT 0,    -- pre-selected in new-invoice form
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_companies_active ON inv_companies(is_active);

-- ---- inv_customers (bill-to entities) ----------------------------
CREATE TABLE IF NOT EXISTS inv_customers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  legal_name     TEXT,
  gstin          TEXT,                  -- blank = B2C, else B2B
  customer_type  TEXT NOT NULL DEFAULT 'B2C',   -- 'B2B' | 'B2C' | 'EXPORT' | 'SEZ'
  state          TEXT,
  state_code     TEXT,
  place_of_supply TEXT,                 -- for B2C/Export edge cases
  country        TEXT NOT NULL DEFAULT 'India',
  billing_address  TEXT,
  shipping_address TEXT,
  city           TEXT,
  pincode        TEXT,
  phone          TEXT,
  email          TEXT,
  notes          TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_customers_gstin  ON inv_customers(gstin);
CREATE INDEX IF NOT EXISTS idx_inv_customers_active ON inv_customers(is_active);

-- ---- inv_items (catalog of goods / services) ---------------------
CREATE TABLE IF NOT EXISTS inv_items (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  hsn_sac        TEXT,                  -- HSN for goods, SAC for services
  unit           TEXT NOT NULL DEFAULT 'PCS',   -- PCS / KG / HRS / NOS …
  rate           NUMERIC(14,2) NOT NULL DEFAULT 0,
  gst_pct        NUMERIC(5,2)  NOT NULL DEFAULT 18.00,
  is_service     INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_items_active ON inv_items(is_active);

-- ---- invoices (header) -------------------------------------------
CREATE TABLE IF NOT EXISTS invoices_inv (
  id               SERIAL PRIMARY KEY,
  invoice_no       TEXT NOT NULL UNIQUE,                 -- e.g. INV000123
  invoice_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date         DATE,
  company_id       INTEGER NOT NULL REFERENCES inv_companies(id) ON DELETE RESTRICT,
  customer_id      INTEGER REFERENCES inv_customers(id) ON DELETE SET NULL,
  -- Snapshot of customer (so changes to master don't rewrite history)
  customer_name    TEXT NOT NULL,
  customer_gstin   TEXT,
  customer_state   TEXT,
  customer_state_code TEXT,
  bill_to_address  TEXT,
  ship_to_address  TEXT,
  place_of_supply  TEXT,
  -- Snapshot of seller
  company_name     TEXT,
  company_gstin    TEXT,
  company_state    TEXT,
  -- Computed totals
  subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0,     -- sum(taxable_value)
  discount         NUMERIC(14,2) NOT NULL DEFAULT 0,
  cgst             NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst             NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst             NUMERIC(14,2) NOT NULL DEFAULT 0,
  cess             NUMERIC(14,2) NOT NULL DEFAULT 0,
  round_off        NUMERIC(14,2) NOT NULL DEFAULT 0,
  total            NUMERIC(14,2) NOT NULL DEFAULT 0,     -- grand total payable
  amount_in_words  TEXT,
  -- Lifecycle
  status           TEXT NOT NULL DEFAULT 'finalized',    -- draft | finalized | cancelled
  paid_status      TEXT NOT NULL DEFAULT 'unpaid',       -- unpaid | partial | paid
  amount_paid      NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Free-form
  notes            TEXT,
  terms            TEXT,
  pdf_drive_id     TEXT,                                 -- last cached PDF (optional)
  is_reverse_charge INTEGER NOT NULL DEFAULT 0,
  -- Audit
  created_by       INTEGER,                              -- references users(id) loosely
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_invoices_inv_date     ON invoices_inv(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_inv_company  ON invoices_inv(company_id);
CREATE INDEX IF NOT EXISTS idx_invoices_inv_customer ON invoices_inv(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_inv_status   ON invoices_inv(status);
CREATE INDEX IF NOT EXISTS idx_invoices_inv_paid     ON invoices_inv(paid_status);

-- ---- invoice_lines (line items) ----------------------------------
CREATE TABLE IF NOT EXISTS invoice_lines_inv (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES invoices_inv(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  item_id         INTEGER REFERENCES inv_items(id) ON DELETE SET NULL,
  description     TEXT NOT NULL,
  hsn_sac         TEXT,
  unit            TEXT,
  qty             NUMERIC(14,3) NOT NULL DEFAULT 1,
  rate            NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_pct    NUMERIC(5,2)  NOT NULL DEFAULT 0,
  gst_pct         NUMERIC(5,2)  NOT NULL DEFAULT 0,
  taxable_value   NUMERIC(14,2) NOT NULL DEFAULT 0,      -- qty*rate - discount
  cgst            NUMERIC(14,2) NOT NULL DEFAULT 0,
  sgst            NUMERIC(14,2) NOT NULL DEFAULT 0,
  igst            NUMERIC(14,2) NOT NULL DEFAULT 0,
  cess            NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total      NUMERIC(14,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invlines_invoice ON invoice_lines_inv(invoice_id);

-- ---- invoice_payments --------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_payments_inv (
  id              SERIAL PRIMARY KEY,
  invoice_id      INTEGER NOT NULL REFERENCES invoices_inv(id) ON DELETE CASCADE,
  pay_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  amount          NUMERIC(14,2) NOT NULL,
  mode            TEXT NOT NULL DEFAULT 'UPI',           -- UPI | Bank | Cash | Cheque | Other
  reference       TEXT,                                  -- UPI ref / cheque # / UTR
  notes           TEXT,
  created_by      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invpay_invoice ON invoice_payments_inv(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invpay_date    ON invoice_payments_inv(pay_date);

-- ---- inv_settings (singleton row) --------------------------------
-- Per-tenant invoicing knobs (default GST %, currency symbol, financial-
-- year prefix style, B2CL threshold, etc.). Singleton id=1.
CREATE TABLE IF NOT EXISTS inv_settings (
  id                INTEGER PRIMARY KEY DEFAULT 1,
  default_gst_pct   NUMERIC(5,2)  NOT NULL DEFAULT 18.00,
  currency_symbol   TEXT NOT NULL DEFAULT '₹',
  currency_code     TEXT NOT NULL DEFAULT 'INR',
  date_format       TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  b2cl_threshold    NUMERIC(14,2) NOT NULL DEFAULT 250000,  -- B2C-Large > ₹2.5L (inter-state)
  fy_start_month    INTEGER NOT NULL DEFAULT 4,             -- April
  default_terms     TEXT,
  default_notes     TEXT,
  invoice_footer    TEXT,
  enable_qr         INTEGER NOT NULL DEFAULT 1,             -- UPI QR on invoice
  enable_round_off  INTEGER NOT NULL DEFAULT 1,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT inv_settings_singleton CHECK (id = 1)
);
INSERT INTO inv_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---- inv_audit_log (per-tenant lightweight audit) ----------------
CREATE TABLE IF NOT EXISTS inv_audit_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER,
  user_email  TEXT,
  action      TEXT NOT NULL,         -- invoice.create | invoice.cancel | payment.add | ...
  entity      TEXT NOT NULL,         -- invoice | payment | company | customer | item
  entity_id   INTEGER,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inv_audit_entity ON inv_audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_inv_audit_created ON inv_audit_log(created_at DESC);
