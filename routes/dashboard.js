/**
 * routes/dashboard.js
 *
 * Custom Dashboard backend — load + save the user's widget layout.
 *
 * The actual widget DATA (KPI numbers, chart series, project-stage
 * counts, etc.) is fetched from the existing api_reports_*, api_tat_*,
 * api_projectStages_*, api_notifications_* endpoints. This module only
 * persists the user's chosen LAYOUT.
 *
 * Why a separate module: the layout is per-USER (vs. tenant-wide
 * config) so it lives in its own table (user_dashboard) keyed by
 * user_id. We don't want to bolt a JSONB column onto users(...) and
 * couple migrations.
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ----------------------------------------------------------------
// Default layout — what new users see before they customise.
// Mirrors the previous static Dashboard so backwards-compat is clean.
// ----------------------------------------------------------------
const DEFAULT_LAYOUT = [
  { id: 'def-kpi-total',    type: 'kpi_total_leads',  size: 'small' },
  { id: 'def-kpi-new',      type: 'kpi_new_today',    size: 'small' },
  { id: 'def-kpi-won',      type: 'kpi_won',          size: 'small' },
  { id: 'def-kpi-due',      type: 'kpi_due_today',    size: 'small' },
  { id: 'def-kpi-overdue',  type: 'kpi_overdue',      size: 'small' },
  { id: 'def-followups',    type: 'followups_panel',  size: 'medium' },
  { id: 'def-status-chart', type: 'chart_status',     size: 'medium' },
  { id: 'def-funnel',       type: 'funnel_pipeline',  size: 'wide'   },
  { id: 'def-tat',          type: 'tat_alerts',       size: 'wide'   },
  { id: 'def-projects',     type: 'project_stages',   size: 'wide'   },
  { id: 'def-source-chart', type: 'chart_source',     size: 'wide'   }
];

// ----------------------------------------------------------------
// API: load the current user's layout
// ----------------------------------------------------------------
async function api_dashboard_get(token) {
  const me = await authUser(token);
  let row;
  try {
    const r = await db.query(
      'SELECT widgets, updated_at FROM user_dashboard WHERE user_id = $1',
      [Number(me.id)]
    );
    row = r.rows[0];
  } catch (e) {
    // Table missing on tenants that haven't migrated yet — return defaults.
    return { widgets: DEFAULT_LAYOUT, is_default: true, missing_table: true };
  }
  if (!row || !row.widgets || (Array.isArray(row.widgets) && !row.widgets.length)) {
    return { widgets: DEFAULT_LAYOUT, is_default: true };
  }
  let widgets = row.widgets;
  if (typeof widgets === 'string') {
    try { widgets = JSON.parse(widgets); } catch (_) { widgets = DEFAULT_LAYOUT; }
  }
  if (!Array.isArray(widgets)) widgets = DEFAULT_LAYOUT;
  return { widgets, is_default: false, updated_at: row.updated_at };
}

// ----------------------------------------------------------------
// API: save the current user's layout
//   Each widget is { id, type, size?, title?, config? }
//   Unknown / extra fields are kept verbatim — JSONB is forward-compat.
// ----------------------------------------------------------------
async function api_dashboard_save(token, payload) {
  const me = await authUser(token);
  let widgets = (payload && payload.widgets) || [];
  if (!Array.isArray(widgets)) throw new Error('widgets must be an array');

  // Light validation — we don't want garbage to break later renders.
  widgets = widgets.map((w, i) => {
    if (!w || typeof w !== 'object') return null;
    return {
      id:     String(w.id     || ('w-' + Date.now() + '-' + i)),
      type:   String(w.type   || ''),
      size:   w.size   ? String(w.size)  : 'medium',
      title:  w.title  ? String(w.title) : null,
      config: w.config && typeof w.config === 'object' ? w.config : {}
    };
  }).filter(w => w && w.type);

  await db.query(
    `INSERT INTO user_dashboard (user_id, widgets, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (user_id) DO UPDATE
        SET widgets    = EXCLUDED.widgets,
            updated_at = NOW()`,
    [Number(me.id), JSON.stringify(widgets)]
  );

  return { ok: true, widgets };
}

// ----------------------------------------------------------------
// API: reset to default
// ----------------------------------------------------------------
async function api_dashboard_reset(token) {
  const me = await authUser(token);
  await db.query('DELETE FROM user_dashboard WHERE user_id = $1', [Number(me.id)]);
  return { ok: true, widgets: DEFAULT_LAYOUT };
}

module.exports = {
  api_dashboard_get,
  api_dashboard_save,
  api_dashboard_reset,
  // Exported for the SPA's "default layout" reference + unit tests.
  DEFAULT_LAYOUT
};
