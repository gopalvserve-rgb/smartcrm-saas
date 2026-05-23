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
