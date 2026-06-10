-- Add leave_type and half_day to the leaves table
-- Run once per tenant DB (apply via applySchema or manual migration)
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS leave_type TEXT    NOT NULL DEFAULT 'casual';
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS half_day   BOOLEAN NOT NULL DEFAULT FALSE;
