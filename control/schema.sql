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
