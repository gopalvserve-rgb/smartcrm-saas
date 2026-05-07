-- Migration: Custom roles (smartcrm-saas)
-- 2026-05-06 — idempotent. Run on EVERY tenant DB.
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

INSERT INTO roles (key, label, hierarchy_level, is_system, is_active) VALUES
  ('admin',       'Admin',       0, 1, 1),
  ('manager',     'Manager',     1, 1, 1),
  ('team_leader', 'Team Leader', 2, 1, 1),
  ('sales',       'Sales',       3, 1, 1)
ON CONFLICT (key) DO NOTHING;
