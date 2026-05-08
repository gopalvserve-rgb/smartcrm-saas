-- Migration: Tag whatsapp_messages with the connected phone_number_id
-- 2026-05-08 — Phase 3 of multi-WhatsApp support.  Idempotent.
--
-- Until Phase 2 every tenant had ONE WhatsApp number, so it was safe to
-- group whatsapp_messages by counterpart phone alone.  Now a tenant may
-- own several numbers (Sales line, Support line, …) and the chat list
-- needs to know which of THEIR numbers each conversation belongs to.
--
-- We add a free-form text column (matches wa_phones.phone_number_id) and
-- backfill rows where we already know the answer:
--
--   * Outbound rows wrote `from_number` = `cfg.phoneId` (see _sendText /
--     _sendMedia / _sendTemplate).  We can copy it across so existing
--     conversations keep their threading.
--   * Inbound rows wrote `to_number` = the display phone (e.g.
--     "+91 98765 43210").  That isn't a phone_number_id, but we can
--     join on wa_phones.display_phone_number and pick up the id where
--     it matches, otherwise leave NULL.  NULL rows fall back to the
--     tenant default in api_wb_chat_threads.
--
-- An index on (phone_number_id, created_at) keeps the per-phone thread
-- list fast even on tenants with millions of historical rows.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS phone_number_id TEXT;

-- Backfill outbound rows from from_number (which we wrote as cfg.phoneId).
UPDATE whatsapp_messages m
   SET phone_number_id = m.from_number
 WHERE m.phone_number_id IS NULL
   AND m.direction       = 'out'
   AND m.from_number     IS NOT NULL
   AND m.from_number     <> ''
   AND EXISTS (
        SELECT 1 FROM wa_phones p
         WHERE p.phone_number_id = m.from_number
   );

-- Backfill inbound rows where to_number happens to match a known
-- display_phone_number on wa_phones (best-effort — the format may vary
-- between tenants, e.g. "+91 …" vs "91…").  Anything that doesn't match
-- stays NULL and falls back to the default.
UPDATE whatsapp_messages m
   SET phone_number_id = p.phone_number_id
  FROM wa_phones p
 WHERE m.phone_number_id IS NULL
   AND m.direction       = 'in'
   AND p.display_phone_number IS NOT NULL
   AND (
        regexp_replace(COALESCE(m.to_number, ''),                 '\D', '', 'g')
      = regexp_replace(COALESCE(p.display_phone_number, ''),      '\D', '', 'g')
   );

CREATE INDEX IF NOT EXISTS idx_wa_messages_phone_id
  ON whatsapp_messages(phone_number_id, created_at DESC);
