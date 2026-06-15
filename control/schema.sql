-- ============================================================
-- SmartCRM SaaS — control-plane schema
-- ============================================================
-- This database (smartcrm_control) is shared across ALL tenants and
-- holds the platform-wide registry: packages, tenant accounts, invoices,
-- payments, super-admins, platform announcements, custom-requirement
-- tickets, audit log.
--
-- Each tenant gets its OWN database (tenant_<slug>) that runs the same
-- schema as the existing CRM (db/schema.sql). This file is only the
-- control plane.
--
-- Convention: every table has id + created_at; mutable rows also have
-- updated_at. Soft-deletes via is_active = 0 instead of DELETE so we
-- never lose billing history.
-- ============================================================

-- ---- super_admins -----------------------------------------------
-- Platform-level admins (the SaaS owner + their staff). Can log into
-- /admin/* and manage every tenant. NOT the same as tenant admins.
CREATE TABLE IF NOT EXISTS super_admins (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'admin',  -- admin | assistant | viewer
  is_active       INTEGER NOT NULL DEFAULT 1,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_super_admins_email ON super_admins(email);

-- ---- packages ---------------------------------------------------
-- Plans that customers buy. Mirrors the structure shown in your
-- screenshots: base price + recurring period + per-module quotas +
-- feature flags + hide-tabs list. Quotas are stored as JSONB for
-- flexibility — we don't want to migrate the schema every time we
-- add a new metric.
CREATE TABLE IF NOT EXISTS packages (
  id                       SERIAL PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT,
  base_price_inr           NUMERIC(10,2) NOT NULL DEFAULT 0,
  trial_days               INTEGER NOT NULL DEFAULT 0,
  recurring_period         TEXT NOT NULL DEFAULT 'month',  -- month|quarter|year|lifetime
  recurring_period_count   INTEGER NOT NULL DEFAULT 1,     -- e.g. "Every 3 months" => period=month, count=3
  is_lifetime              INTEGER NOT NULL DEFAULT 0,
  tax_percent              NUMERIC(5,2) NOT NULL DEFAULT 18.00,  -- GST default
  allowed_payment_modes    TEXT NOT NULL DEFAULT 'cashfree',  -- CSV: cashfree|bank|upi|manual
  is_enabled               INTEGER NOT NULL DEFAULT 1,
  is_default               INTEGER NOT NULL DEFAULT 0,
  is_private               INTEGER NOT NULL DEFAULT 0,        -- if 1, hidden from public pricing page
  is_most_popular          INTEGER NOT NULL DEFAULT 0,        -- shows the gold badge

  -- Modules included (CSV of module ids, e.g. "leads,whatsbot,facebook")
  modules                  TEXT NOT NULL DEFAULT '',
  show_modules_on_card     INTEGER NOT NULL DEFAULT 1,
  show_limits_on_card      INTEGER NOT NULL DEFAULT 1,
  disabled_default_modules TEXT,   -- CSV — modules to disable by default for tenants on this plan

  -- Hide tabs (CSV of sidebar nav ids the tenant should NOT see)
  hidden_tabs              TEXT,

  -- Quotas — JSONB { users: {limit:5, extra_inr:50}, leads: {...}, ... }
  -- limit = -1 means unlimited. Limitation period stored as one-time | per_month
  quotas                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  limitation_period        TEXT NOT NULL DEFAULT 'one_time',  -- one_time | per_month

  -- Multi-instance support (a tenant can run multiple sub-instances)
  max_instances            INTEGER NOT NULL DEFAULT 1,
  extra_instance_inr       NUMERIC(10,2) NOT NULL DEFAULT 0,

  sort_order               INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_packages_enabled ON packages(is_enabled);
CREATE INDEX IF NOT EXISTS idx_packages_sort ON packages(sort_order);

-- ---- tenants ----------------------------------------------------
-- One row per customer org. Each tenant has its own Postgres database
-- (db_name) and a URL slug ("/t/<slug>").
CREATE TABLE IF NOT EXISTS tenants (
  id                   SERIAL PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,           -- /t/<slug>
  org_name             TEXT NOT NULL,                  -- "ACME Realty"
  contact_name         TEXT NOT NULL,
  contact_email        TEXT NOT NULL,
  contact_mobile       TEXT NOT NULL,
  db_name              TEXT NOT NULL UNIQUE,           -- "tenant_<slug>" — actual Postgres DB
  package_id           INTEGER REFERENCES packages(id) ON DELETE SET NULL,

  -- Lifecycle status:
  --   pending_payment — signed up, not yet paid
  --   trial           — trial active, no payment yet
  --   active          — paid + running
  --   past_due        — payment failed, in grace period
  --   suspended       — manually frozen by admin
  --   pending_delete  — cancelled, in deletion-window countdown
  --   deleted         — DB dropped, only invoice history remains
  status               TEXT NOT NULL DEFAULT 'pending_payment',
  trial_ends_at        TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end   TIMESTAMPTZ,
  pending_delete_at    TIMESTAMPTZ,                    -- when the deletion countdown started

  -- Per-tenant module overrides (CSV of module ids enabled even if not in plan)
  extra_modules        TEXT,
  -- Per-tenant module overrides (CSV of module ids disabled even if in plan)
  blocked_modules      TEXT,

  -- Per-tenant SMTP — falls back to admin SMTP if blank
  smtp_host            TEXT,
  smtp_port            INTEGER,
  smtp_user            TEXT,
  smtp_password        TEXT,
  smtp_from            TEXT,
  smtp_secure          INTEGER DEFAULT 1,

  -- Branding
  brand_logo_url       TEXT,
  brand_primary_color  TEXT,

  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(contact_email);
CREATE INDEX IF NOT EXISTS idx_tenants_pkg ON tenants(package_id);
CREATE INDEX IF NOT EXISTS idx_tenants_pending_delete ON tenants(pending_delete_at);

-- ---- invoices ---------------------------------------------------
-- Every billing event (subscription period, custom request, extra
-- units) creates an invoice row. Status transitions: pending → paid |
-- failed | refunded.
CREATE TABLE IF NOT EXISTS invoices (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  number          TEXT NOT NULL UNIQUE,        -- e.g. INV-2026-000123
  package_id      INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  description     TEXT,
  subtotal_inr    NUMERIC(10,2) NOT NULL DEFAULT 0,
  tax_inr         NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_inr       NUMERIC(10,2) NOT NULL DEFAULT 0,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|failed|refunded|void
  paid_at         TIMESTAMPTZ,
  payment_id      INTEGER,                          -- FK to payments(id), set after paid
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

-- ---- payments ---------------------------------------------------
-- Each Cashfree (or manual) attempt. Webhook updates the matching row.
CREATE TABLE IF NOT EXISTS payments (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id      INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  gateway         TEXT NOT NULL DEFAULT 'cashfree',
  gateway_order_id TEXT,                  -- cashfree order_id
  gateway_txn_id  TEXT,                   -- cashfree cf_payment_id
  amount_inr      NUMERIC(10,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'created', -- created|pending|paid|failed|refunded
  raw_response    JSONB,                  -- full gateway response for debugging
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(gateway_order_id);

-- ---- saas_settings ----------------------------------------------
-- Platform-wide knobs (key/value). Admin-only. e.g. CASHFREE_APP_ID,
-- ADMIN_SMTP_HOST, INSTANCE_PENDING_DELETION_DAYS, currency, etc.
CREATE TABLE IF NOT EXISTS saas_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---- platform_announcements -------------------------------------
-- Banners shown inside every tenant CRM (Updates feature).
CREATE TABLE IF NOT EXISTS platform_announcements (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',  -- info|warn|critical|new_feature
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at     TIMESTAMPTZ,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pa_active ON platform_announcements(is_active);

-- ---- custom_requirements ----------------------------------------
-- Tenants submit "I'd like X feature for ₹Y", admin replies + charges.
CREATE TABLE IF NOT EXISTS custom_requirements (
  id              SERIAL PRIMARY KEY,
  tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  submitted_by    TEXT,                              -- email of tenant user who submitted
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',      -- open|quoted|approved|in_progress|done|rejected
  quote_inr       NUMERIC(10,2),
  admin_reply     TEXT,
  invoice_id      INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cr_tenant ON custom_requirements(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cr_status ON custom_requirements(status);

-- ---- audit_log --------------------------------------------------
-- Every important event (signup, payment, plan change, deletion, etc.).
CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  actor_type   TEXT,            -- super_admin | tenant | system | webhook
  actor_id     INTEGER,
  actor_email  TEXT,
  tenant_id    INTEGER,
  event        TEXT NOT NULL,   -- tenant.created | tenant.suspended | invoice.paid | ...
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ---- signups ----------------------------------------------------
-- Pre-tenant rows: someone filled the signup form but hasn't paid yet.
-- Once payment confirms, we promote signup → tenant + drop the row here.
CREATE TABLE IF NOT EXISTS signups (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  mobile          TEXT NOT NULL,
  org_name        TEXT,
  package_id      INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  desired_slug    TEXT,
  cashfree_order_id TEXT,                     -- the order we created on Cashfree
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|abandoned|provisioned
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signups_email ON signups(email);
CREATE INDEX IF NOT EXISTS idx_signups_order ON signups(cashfree_order_id);
CREATE INDEX IF NOT EXISTS idx_signups_status ON signups(status);

-- ============================================================
-- Cashfree webhook logs — dedicated audit trail for /hook/cashfree
-- ============================================================
-- Every inbound webhook hit (success, failed, refund, abandoned,
-- whatever) gets one row here so admin can see exactly what came in,
-- when, with what amount, and what the server did with it. Separate
-- from the generic audit_log because finance support staff often need
-- to look up a specific payment without combing through everything.
-- ============================================================
CREATE TABLE IF NOT EXISTS cashfree_webhook_logs (
  id              SERIAL PRIMARY KEY,
  webhook_type    TEXT,                    -- PAYMENT_SUCCESS_WEBHOOK | PAYMENT_FAILED_WEBHOOK | REFUND_STATUS_WEBHOOK | …
  entity_type     TEXT,                    -- payment | refund | order
  status          TEXT,                    -- SUCCESS | FAILED | PENDING | USER_DROPPED | …
  amount_inr      NUMERIC(10,2),
  order_id        TEXT,                    -- Cashfree order_id (matches our SCO-… orders)
  cf_payment_id   TEXT,                    -- Cashfree's internal payment id
  payment_method  TEXT,                    -- UPI | NETBANKING | CARD | WALLET | …
  customer_email  TEXT,
  customer_phone  TEXT,
  raw_payload     JSONB,                   -- the full body, for debugging
  signature_ok    INTEGER,                 -- 1=verified, 0=failed verify, -1=skipped (verification disabled)
  processed       INTEGER,                 -- 1=we acted on it, 0=ignored / no matching signup
  result_message  TEXT,                    -- "tenant provisioned" / "duplicate" / error message
  signup_id       INTEGER,                 -- if matched, which signup row
  tenant_id       INTEGER,                 -- if a tenant was provisioned, which one
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cf_webhook_order   ON cashfree_webhook_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_cf_webhook_status  ON cashfree_webhook_logs(status);
CREATE INDEX IF NOT EXISTS idx_cf_webhook_created ON cashfree_webhook_logs(created_at DESC);

-- ============================================================
-- error_logs — central error sink for the whole SaaS
-- ============================================================
-- Anything that throws or rejects on the server (Express middleware)
-- and any uncaught error/promise rejection on the client (window.error
-- + window.unhandledrejection handlers) lands here. Admin reads this
-- table on /admin → Errors and marks rows resolved when fixed.
--
-- A short hash of (source + first line of stack) is computed at insert
-- time so we can dedupe — if the same error fires 1000 times, we
-- bump occurrences instead of creating 1000 rows.
-- ============================================================
CREATE TABLE IF NOT EXISTS error_logs (
  id              SERIAL PRIMARY KEY,
  source          TEXT NOT NULL,                 -- 'server' | 'client' | 'webhook' | 'cron' | 'signup' …
  severity        TEXT NOT NULL DEFAULT 'error', -- 'error' | 'warn' | 'fatal'
  message         TEXT NOT NULL,
  stack           TEXT,
  url             TEXT,                          -- request URL (server) or page URL (client)
  method          TEXT,                          -- HTTP method (server only)
  status_code     INTEGER,                       -- HTTP status (server only)
  ua              TEXT,                          -- user agent (client only)
  user_id         INTEGER,                       -- super-admin id if known
  user_email      TEXT,
  tenant_slug     TEXT,                          -- /t/<slug> if applicable
  fingerprint     TEXT,                          -- hash for dedupe (source + first stack line)
  occurrences     INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved        INTEGER NOT NULL DEFAULT 0,    -- 1 = admin clicked "Mark resolved"
  resolved_at     TIMESTAMPTZ,
  resolved_by     INTEGER,                       -- super_admin id
  resolution_note TEXT,
  context         JSONB                          -- request body, headers, anything extra
);
CREATE INDEX IF NOT EXISTS idx_error_logs_resolved  ON error_logs(resolved);
CREATE INDEX IF NOT EXISTS idx_error_logs_source    ON error_logs(source);
CREATE INDEX IF NOT EXISTS idx_error_logs_lastseen  ON error_logs(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_fingerprint ON error_logs(fingerprint);

-- ============================================================
-- AI Bot — control-plane tables (added 2026-05-08)
-- ============================================================

-- ---- ai_settings (singleton id=1) -------------------------------
CREATE TABLE IF NOT EXISTS ai_settings (
  id                    INTEGER PRIMARY KEY DEFAULT 1,
  gemini_api_key_enc    TEXT,
  gemini_default_model  TEXT NOT NULL DEFAULT 'gemini-2.0-flash-lite',
  gemini_embedding_model TEXT NOT NULL DEFAULT 'text-embedding-004',
  price_input_usd_per_m  DECIMAL(10,6) NOT NULL DEFAULT 0.075,
  price_output_usd_per_m DECIMAL(10,6) NOT NULL DEFAULT 0.30,
  exchange_rate_inr      DECIMAL(10,4) NOT NULL DEFAULT 84.0000,
  markup_pct             DECIMAL(6,2)  NOT NULL DEFAULT 30.00,
  is_active              INTEGER NOT NULL DEFAULT 0,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_settings_singleton CHECK (id = 1)
);
INSERT INTO ai_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---- ai_usage_log -----------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id                SERIAL PRIMARY KEY,
  tenant_id         INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
  tenant_slug       TEXT NOT NULL,
  call_kind         TEXT NOT NULL,
  model             TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cost_usd          DECIMAL(12,8) NOT NULL DEFAULT 0,
  cost_inr_real     DECIMAL(12,4) NOT NULL DEFAULT 0,
  cost_inr_billed   DECIMAL(12,4) NOT NULL DEFAULT 0,
  phone             TEXT,
  lead_id           INTEGER,
  wa_message_id     TEXT,
  error_text        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_day ON ai_usage_log(tenant_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created    ON ai_usage_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_kind       ON ai_usage_log(call_kind);

-- ============================================================
-- Per-tenant module toggles (2026-05-09)
-- ============================================================
-- Each tenant can have any subset of platform modules turned on. When
-- modules_json is NULL or '[]' = all modules enabled (sane default).
-- Super-admin sets this from the Tenants page; the tenant SPA filters
-- its sidebar + Settings rail to only show enabled modules.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS modules_json JSONB;

-- ============================================================

-- ============================================================
-- Support tickets (2026-05-17)
-- ============================================================
-- Cross-tenant ticket system. Tenants raise tickets through their CRM
-- (Help & Support sidebar item), super-admin handles them through
-- /admin → Tickets. Lives in the control DB so super-admin can list
-- everyone's tickets in one place without round-tripping each tenant
-- DB. Email notifications fire on every state change via saasMailer.
CREATE TABLE IF NOT EXISTS support_tickets (
  id                  SERIAL PRIMARY KEY,
  ticket_number       TEXT NOT NULL UNIQUE,
  tenant_id           INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  tenant_slug         TEXT NOT NULL,
  contact_name        TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  created_by_user_id  INTEGER,
  category            TEXT NOT NULL,
  priority            TEXT NOT NULL DEFAULT 'normal',
  subject             TEXT NOT NULL,
  description         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  assignee_id         INTEGER REFERENCES super_admins(id) ON DELETE SET NULL,
  reply_count         INTEGER NOT NULL DEFAULT 0,
  last_reply_at       TIMESTAMPTZ,
  last_reply_by       TEXT,
  closed_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant  ON support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status  ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id           SERIAL PRIMARY KEY,
  ticket_id    INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_type  TEXT NOT NULL,
  author_id    INTEGER,
  author_name  TEXT,
  author_email TEXT,
  body         TEXT NOT NULL,
  is_internal  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_replies_ticket ON support_ticket_replies(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS support_ticket_attachments (
  id               SERIAL PRIMARY KEY,
  ticket_id        INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  reply_id         INTEGER REFERENCES support_ticket_replies(id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  mime_type        TEXT,
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  file_bytes       BYTEA,
  uploaded_by_type TEXT NOT NULL,
  uploaded_by_id   INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_attach_ticket ON support_ticket_attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_support_attach_reply  ON support_ticket_attachments(reply_id);

-- ---- changelog --------------------------------------------------
-- CHANGELOG_v1 (2026-05-28) — global What's New timeline shown to every
-- tenant via the top-right 🎁 icon in the tenant SPA. Lives in the
-- control DB so the platform owner can publish once and every tenant
-- sees the same updates. Per-user "last seen" is kept in the tenant DB
-- so unread badges work per-user without cross-tenant chatter.
CREATE TABLE IF NOT EXISTS changelog (
  id          SERIAL PRIMARY KEY,
  category    TEXT NOT NULL,           -- 'feature' | 'fix' | 'modify'
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT,                    -- optional deep-link inside the app (e.g. #/dashboard)
  icon        TEXT,                    -- optional emoji or text override
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_changelog_created ON changelog(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_changelog_category ON changelog(category);

-- GCONV_SHEETS_v1 — single shared Google account that pushes conversion data
-- to every tenant's chosen Sheet. One-row table; user_email and refresh_token
-- captured during super-admin OAuth flow (sales@smartcrmsolution.com).
CREATE TABLE IF NOT EXISTS google_sheets_master (
  id              SERIAL PRIMARY KEY,
  user_email      TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ,
  scope           TEXT,
  connected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════
-- WL_BILLING_v1 (2026-06-15) — White-Label Customer billing.
-- These are agencies/companies that bought the white-label CRM
-- from SmartCRM Solution. Completely separate from tenant billing.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS wl_customers (
  id              SERIAL PRIMARY KEY,
  company_name    TEXT NOT NULL,
  contact_name    TEXT,
  phone           TEXT NOT NULL,           -- E.164-ish, used for WhatsApp
  email           TEXT,
  product_name    TEXT,                    -- e.g. 'SmartCRM White Label', 'Adbullet CRM'
  total_users     INTEGER NOT NULL DEFAULT 0,
  monthly_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,    -- MRR they owe per month
  total_paid      NUMERIC(12,2) NOT NULL DEFAULT 0,    -- lifetime sum of payments
  balance         NUMERIC(12,2) NOT NULL DEFAULT 0,    -- current outstanding
  currency        TEXT NOT NULL DEFAULT 'INR',
  billing_day     INTEGER NOT NULL DEFAULT 1,          -- 1-28, day of month invoice generates
  status          TEXT NOT NULL DEFAULT 'active',      -- active|paused|churned
  portal_token    TEXT UNIQUE NOT NULL,                -- public URL slug for /wl/portal/:token
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wl_customers_status ON wl_customers(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wl_customers_portal_token ON wl_customers(portal_token);

CREATE TABLE IF NOT EXISTS wl_invoices (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES wl_customers(id) ON DELETE CASCADE,
  invoice_no      TEXT UNIQUE NOT NULL,                -- WL-2026-06-0001
  period_month    TEXT NOT NULL,                       -- '2026-06'
  amount          NUMERIC(12,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',     -- pending|sent|paid|overdue|void
  due_date        DATE,
  cashfree_order_id TEXT,
  cashfree_link   TEXT,                                -- the Pay Now URL
  paid_at         TIMESTAMPTZ,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wl_inv_customer ON wl_invoices(customer_id, period_month);
CREATE INDEX IF NOT EXISTS idx_wl_inv_status ON wl_invoices(status);

CREATE TABLE IF NOT EXISTS wl_payments (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES wl_customers(id) ON DELETE CASCADE,
  invoice_id      INTEGER REFERENCES wl_invoices(id) ON DELETE SET NULL,
  amount          NUMERIC(12,2) NOT NULL,
  paid_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  method          TEXT,                                -- cashfree|bank|upi|cash|other
  reference       TEXT,                                -- tx id, UTR, etc.
  notes           TEXT,
  recorded_by     TEXT,                                -- super-admin email
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wl_pay_customer ON wl_payments(customer_id);

CREATE TABLE IF NOT EXISTS wl_wa_log (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES wl_customers(id) ON DELETE CASCADE,
  invoice_id      INTEGER REFERENCES wl_invoices(id) ON DELETE SET NULL,
  phone           TEXT NOT NULL,
  message_body    TEXT,
  wa_message_id   TEXT,
  status          TEXT NOT NULL DEFAULT 'sent',        -- sent|failed
  error           TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wl_wa_customer ON wl_wa_log(customer_id);
