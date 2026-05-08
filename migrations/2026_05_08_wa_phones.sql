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
