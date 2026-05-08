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
