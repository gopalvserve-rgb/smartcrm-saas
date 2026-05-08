/**
 * routes/saas/crashReport.js
 *
 * Super-admin "🚨 Crashes" dashboard backend.
 *
 * The control DB already has `error_logs` (see control/schema.sql) where
 * every server / client / webhook error lands, severity-tagged and
 * fingerprint-deduped. The general-purpose Errors page lists them in
 * raw form — useful, but noisy when you just want to know "is the app
 * crashing right now?".
 *
 * This module exposes a single API the SPA's Crashes tab calls to
 * render an at-a-glance crash dashboard:
 *
 *     POST /api/saas
 *     X-Auth-Token: <super-admin-token>
 *     { "fn": "api_saas_crashReport_summary",
 *       "args": [{ "hours": 24, "severity": "fatal_and_error" }] }
 *
 * Severity filter values:
 *   'fatal'            — process-level crashes only (uncaughtException,
 *                        unhandledRejection, fatal startup errors).
 *                        These are the "the app crashed" signal.
 *   'error'            — Express handler / route errors. The app didn't
 *                        crash but a request 500'd.
 *   'fatal_and_error'  — both, default. What the dashboard shows for
 *                        "anything bad happened recently".
 *
 * Returns:
 *   {
 *     window: { hours, since },
 *     counts: {
 *       fatal_in_window, error_in_window, total_in_window,
 *       unresolved_total, last_crash_at, last_crash_minutes_ago
 *     },
 *     top: [
 *       { id, fingerprint, severity, source, message, occurrences,
 *         first_seen_at, last_seen_at, resolved, sample_stack_first_line }
 *     ],   // top 10 deduped by fingerprint, ordered by occurrences desc
 *     recent: [
 *       { id, severity, source, message, status_code, last_seen_at,
 *         tenant_slug, resolved }
 *     ]    // 20 most recent rows in the window
 *   }
 */

'use strict';

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

function _severityList(sev) {
  switch (String(sev || 'fatal_and_error')) {
    case 'fatal':           return ['fatal'];
    case 'error':           return ['error'];
    case 'fatal_and_error':
    default:                return ['fatal', 'error'];
  }
}

function _firstStackLine(stack) {
  if (!stack) return null;
  const lines = String(stack).split('\n').map(s => s.trim()).filter(Boolean);
  // skip the message line (first entry that doesn't start with "at "); return
  // the first frame instead, which is usually more diagnostic.
  for (const ln of lines) {
    if (ln.startsWith('at ')) return ln;
  }
  return lines[0] || null;
}

async function api_saas_crashReport_summary(token, options) {
  await requireSuperAdmin(token);

  const opts  = options || {};
  const hours = (opts.hours === 'all' || opts.hours === null) ? null
              : Math.max(1, Math.min(24 * 90, Number(opts.hours || 24)));
  const sevList = _severityList(opts.severity);

  // ---- counts -----------------------------------------------------
  const sinceClause = hours == null
    ? ''
    : `AND last_seen_at >= NOW() - INTERVAL '${Number(hours)} hour'`;

  const countsRes = await control.query(
    `SELECT
       SUM(CASE WHEN severity = 'fatal' ${hours == null ? '' : "AND last_seen_at >= NOW() - INTERVAL '" + Number(hours) + " hour'"} THEN occurrences ELSE 0 END)::int AS fatal_in_window,
       SUM(CASE WHEN severity = 'error' ${hours == null ? '' : "AND last_seen_at >= NOW() - INTERVAL '" + Number(hours) + " hour'"} THEN occurrences ELSE 0 END)::int AS error_in_window,
       SUM(CASE WHEN severity = ANY($1::text[]) ${sinceClause} THEN occurrences ELSE 0 END)::int AS total_in_window,
       SUM(CASE WHEN resolved = 0 AND severity = ANY($1::text[]) THEN 1 ELSE 0 END)::int AS unresolved_total,
       MAX(CASE WHEN severity = 'fatal' THEN last_seen_at END) AS last_crash_at
       FROM error_logs`,
    [sevList]
  );
  const counts = countsRes.rows[0] || {};
  const lastCrashAt = counts.last_crash_at || null;
  const lastCrashMinutesAgo = lastCrashAt
    ? Math.max(0, Math.floor((Date.now() - new Date(lastCrashAt).getTime()) / 60000))
    : null;

  // ---- top deduped stacks ----------------------------------------
  // We dedupe on fingerprint (already populated at insert time). Within
  // the chosen time window, sum occurrences across rows with the same
  // fingerprint and pick the most-recent row as the representative.
  const topRes = await control.query(
    `SELECT id, fingerprint, severity, source, message, occurrences,
            first_seen_at, last_seen_at, resolved, stack
       FROM (
         SELECT *,
                ROW_NUMBER() OVER (PARTITION BY fingerprint ORDER BY last_seen_at DESC) AS rn
           FROM error_logs
          WHERE severity = ANY($1::text[])
            ${sinceClause}
       ) t
      WHERE rn = 1
      ORDER BY occurrences DESC, last_seen_at DESC
      LIMIT 10`,
    [sevList]
  );
  const top = topRes.rows.map(r => ({
    id:                       Number(r.id),
    fingerprint:              r.fingerprint,
    severity:                 r.severity,
    source:                   r.source,
    message:                  r.message,
    occurrences:              Number(r.occurrences || 0),
    first_seen_at:            r.first_seen_at,
    last_seen_at:             r.last_seen_at,
    resolved:                 Number(r.resolved) === 1,
    sample_stack_first_line:  _firstStackLine(r.stack)
  }));

  // ---- recent rows (not deduped, raw) ----------------------------
  const recentRes = await control.query(
    `SELECT id, severity, source, message, status_code, last_seen_at,
            tenant_slug, resolved
       FROM error_logs
      WHERE severity = ANY($1::text[])
        ${sinceClause}
      ORDER BY last_seen_at DESC
      LIMIT 20`,
    [sevList]
  );
  const recent = recentRes.rows.map(r => ({
    id:           Number(r.id),
    severity:     r.severity,
    source:       r.source,
    message:      r.message,
    status_code:  r.status_code != null ? Number(r.status_code) : null,
    last_seen_at: r.last_seen_at,
    tenant_slug:  r.tenant_slug || null,
    resolved:     Number(r.resolved) === 1
  }));

  return {
    window: { hours, since: hours == null ? null : new Date(Date.now() - hours * 3600 * 1000).toISOString() },
    counts: {
      fatal_in_window:          Number(counts.fatal_in_window || 0),
      error_in_window:          Number(counts.error_in_window || 0),
      total_in_window:          Number(counts.total_in_window || 0),
      unresolved_total:         Number(counts.unresolved_total || 0),
      last_crash_at:            lastCrashAt,
      last_crash_minutes_ago:   lastCrashMinutesAgo
    },
    top,
    recent
  };
}

module.exports = { api_saas_crashReport_summary };
