-- Migration: Pull Leads (smartcrm-saas)
-- 2026-05-06 — idempotent. Run on EVERY tenant DB.
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

INSERT INTO config (key, value, updated_at) VALUES
  ('LEAD_PULL_ENABLED',          '1',                              NOW()),
  ('LEAD_PULL_INITIAL_COUNT',    '20',                             NOW()),
  ('LEAD_PULL_SUBSEQUENT_COUNT', '5',                              NOW()),
  ('LEAD_PULL_ENABLED_ROLES',    'sales,team_leader,manager',      NOW()),
  ('LEAD_PULL_ORDER',            'oldest',                         NOW())
ON CONFLICT (key) DO NOTHING;
