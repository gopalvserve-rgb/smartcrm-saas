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
