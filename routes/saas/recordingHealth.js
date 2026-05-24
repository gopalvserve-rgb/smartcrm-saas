/**
 * DEVICE_DIAG_v1 — Recording Sync Health + Device Diagnostic
 *
 * Two surfaces:
 *   1. Super-admin "Device Health" view (Phase 1 — inferred):
 *        Reads existing tenant tables (recordings, call_events, users,
 *        fcm_tokens) and infers WHERE the recording-sync chain broke for
 *        each user.
 *
 *        Steps in the chain (in order, latest known status wins):
 *          0. App opened    — last_login_at from users (best proxy)
 *          1. Token live    — fcm_tokens.last_registered_at
 *          2. Call detected — most recent call_events row for this user
 *          3. Recording up  — most recent recordings.uploaded_at for this user
 *          4. Lead matched  — recordings.lead_id IS NOT NULL count vs total
 *
 *        Diagnosis rule (first failure walking backward from now):
 *          last_login_at  > 7d        → "App not opened in 7+ days"
 *          last_fcm       > 14d       → "Token stale — push won't reach"
 *          last_call_evt  > 3d        → "Call detection broken (Phone perm or PhoneStateReceiver killed)"
 *          last_recording > 3d but call_events fresh → "Recording sync broken (Sleeping Apps / storage)"
 *          unmatched/total > 0.5      → "Many uploads but lead-matching weak"
 *
 *   2. Phase 2 — explicit phone telemetry:
 *        - api_devicediag_ingest (tenant API, called by SPA's deviceDiag.js)
 *           Writes batched events into a per-tenant table device_diag_events.
 *           Self-heals schema on first call.
 *        - api_saas_devicediag_timeline (super-admin) — returns last N events
 *           per user for the drilldown panel.
 *
 * NOTHING in this file touches the recording sync pipeline. It is read-only
 * against existing tables and write-only into a new, isolated table.
 */
'use strict';

const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

const DAY = 24 * 60 * 60 * 1000;

function _daysAgo(iso) {
  if (!iso) return null;
  const t = (iso instanceof Date) ? iso.getTime() : Date.parse(String(iso));
  if (!t || isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

/**
 * Run an async function with tenant DB context. Mirrors the pattern used by
 * tenants.js / demoTenant.js for cross-tenant super-admin queries.
 */
async function withTenantDb(slug, fn) {
  const tenantDb = require('../../db/pg');
  const tenantPoolMod = require('../../utils/tenantPool');
  const t = await tenantPoolMod.findActiveTenant(slug);
  if (!t) throw new Error('Tenant not found: ' + slug);
  const pool = tenantPoolMod.poolFor(t);
  if (!pool) throw new Error('Tenant pool unavailable: ' + slug);
  return await tenantDb.tenantStorage.run({ pool, tenant: t, slug }, fn);
}

// -------------------------------------------------------------------------
// Phase 1 — INFERRED health, read from existing tables
// -------------------------------------------------------------------------

async function api_saas_recHealth_overview(token, opts) {
  await requireSuperAdmin(token);

  const tenants = await control.query(
    "SELECT id, slug, org_name AS name, status FROM tenants" +
    " WHERE status NOT IN ('deleted', 'suspended')" +
    " ORDER BY slug ASC"
  ).then(r => r.rows || []);

  const out = [];
  for (const t of tenants) {
    let snapshot = null, err = null;
    try {
      snapshot = await withTenantDb(t.slug, async () => {
        return await _tenantSnapshot();
      });
    } catch (e) {
      err = e.message || String(e);
    }
    out.push(Object.assign({
      slug: t.slug,
      name: t.name || t.slug,
      err: err,
    }, (snapshot || {})));
  }
  return { ok: true, tenants: out };
}

async function api_saas_recHealth_byTenant(token, opts) {
  await requireSuperAdmin(token);
  const slug = String((opts && opts.tenant_slug) || '').trim();
  if (!slug) return { ok: false, error: 'tenant_slug required' };

  try {
    const data = await withTenantDb(slug, async () => {
      const db = require('../../db/pg');
      let users;
      try {
        users = await db.query(
          "SELECT id, name, email, role, created_at," +
          " COALESCE(last_login_at, last_seen_at) AS last_login_at" +
          " FROM users WHERE COALESCE(is_active, true) = true ORDER BY name ASC"
        ).then(r => r.rows || []);
      } catch (_) {
        try {
          users = await db.query(
            "SELECT id, name, email, role, created_at, last_login_at" +
            " FROM users ORDER BY name ASC"
          ).then(r => r.rows || []);
        } catch (_e) {
          users = await db.query("SELECT id, name, email, role, created_at FROM users ORDER BY name ASC")
            .then(r => r.rows || []).catch(() => []);
        }
      }

      // DEVICE_DIAG_v1 lastseen: aggregate freshest activity across many tables.
      // Each table queried defensively so a missing one (industry-pack-only,
      // optional schemas) contributes zero rows instead of erroring the request.
      async function _maxByUser(sql) {
        try {
          const rows = await db.query(sql).then(r => r.rows || []);
          return rows;
        } catch (_e) { return []; }
      }
      const activityQueries = [
        "SELECT user_id, MAX(created_at)  AS ts FROM device_diag_events GROUP BY user_id",
        "SELECT user_id, MAX(created_at)  AS ts FROM call_events        GROUP BY user_id",
        "SELECT user_id, MAX(uploaded_at) AS ts FROM recordings         GROUP BY user_id",
        "SELECT user_id, MAX(created_at)  AS ts FROM lead_remarks       GROUP BY user_id",
        "SELECT user_id, MAX(updated_at)  AS ts FROM leads              WHERE updated_at > NOW() - INTERVAL '90 days' AND assigned_to IS NOT NULL GROUP BY assigned_to, user_id",
        "SELECT assigned_to AS user_id, MAX(updated_at) AS ts FROM leads WHERE updated_at > NOW() - INTERVAL '90 days' GROUP BY assigned_to",
        "SELECT user_id, MAX(created_at)  AS ts FROM attendance         GROUP BY user_id",
        "SELECT user_id, MAX(updated_at)  AS ts FROM whatsapp_messages  WHERE updated_at > NOW() - INTERVAL '90 days' GROUP BY user_id"
      ];
      const allRows = await Promise.all(activityQueries.map(q => _maxByUser(q)));
      const lastSeenByUser = new Map();
      for (const rows of allRows) {
        for (const r of rows) {
          const uid = Number(r.user_id) || null;
          if (!uid || !r.ts) continue;
          const t = (r.ts instanceof Date) ? r.ts.getTime() : Date.parse(String(r.ts));
          if (!t) continue;
          const cur = lastSeenByUser.get(uid) || 0;
          if (t > cur) lastSeenByUser.set(uid, t);
        }
      }

      const recRows = await db.query(
        "SELECT user_id, MAX(uploaded_at) AS last_uploaded_at," +
        " MAX(created_at) AS last_created_at," +
        " COUNT(*) AS total_count," +
        " COUNT(*) FILTER (WHERE lead_id IS NOT NULL) AS matched_count" +
        " FROM recordings WHERE COALESCE(uploaded_at, created_at) > NOW() - INTERVAL '60 days'" +
        " GROUP BY user_id"
      ).then(r => r.rows || []).catch(() => []);
      const recByUser = new Map(recRows.map(r => [Number(r.user_id) || null, r]));

      const callRows = await db.query(
        "SELECT user_id, MAX(created_at) AS last_event_at, COUNT(*) AS total_count" +
        " FROM call_events WHERE created_at > NOW() - INTERVAL '60 days' GROUP BY user_id"
      ).then(r => r.rows || []).catch(() => []);
      const callByUser = new Map(callRows.map(r => [Number(r.user_id) || null, r]));

      let fcmRows = [];
      try {
        fcmRows = await db.query("SELECT user_id, MAX(registered_at) AS last_registered_at FROM fcm_tokens GROUP BY user_id")
          .then(r => r.rows || []);
      } catch (_) {
        try {
          fcmRows = await db.query("SELECT user_id, MAX(created_at) AS last_registered_at FROM fcm_tokens GROUP BY user_id")
            .then(r => r.rows || []);
        } catch (_e) { fcmRows = []; }
      }
      const fcmByUser = new Map(fcmRows.map(r => [Number(r.user_id) || null, r]));

      // DEVICE_DIAG_v1.2: pull latest device_diag_events row per user to extract
      // device model / manufacturer / app version + last permission state. We use this
      // to populate the "Device" column on the super-admin Device Health view.
      let lastDiagByUser = new Map();
      try {
        const db2 = require('../../db/pg');
        await _ensureDiagTable();
        const rows = await db2.query(
          "SELECT DISTINCT ON (user_id) user_id, device_id, payload, created_at" +
          " FROM device_diag_events" +
          " WHERE user_id IS NOT NULL" +
          " ORDER BY user_id, created_at DESC"
        ).then(r => r.rows || []);
        lastDiagByUser = new Map(rows.map(r => [Number(r.user_id) || null, r]));
      } catch (_e) {}

      const perUser = users.map(u => {
        const r = recByUser.get(Number(u.id)) || {};
        const c = callByUser.get(Number(u.id)) || {};
        const f = fcmByUser.get(Number(u.id)) || {};
        // DEVICE_DIAG_v1 lastseen: prefer recent activity (heartbeats / calls /
        // recordings / lead edits) over the static last_login_at column. The
        // old behaviour fell back to created_at when last_login_at was null,
        // which made every user look "not opened in N days" on tenants that
        // don't write to users.last_login_at on each login.
        const lastSeenMs = lastSeenByUser.get(Number(u.id));
        const lastLoginIso = lastSeenMs
          ? new Date(lastSeenMs).toISOString()
          : (u.last_login_at || u.created_at);
        const lastRecIso = r.last_uploaded_at || r.last_created_at;
        const lastCallIso = c.last_event_at;
        const lastFcmIso  = f.last_registered_at;
        const total = Number(r.total_count) || 0;
        const matched = Number(r.matched_count) || 0;
        const matchedPct = total > 0 ? Math.round((matched / total) * 100) : null;

        let diag = { step: 'healthy', severity: 'green', message: 'All signals healthy' };
        const dLogin = _daysAgo(lastLoginIso);
        const dCall  = _daysAgo(lastCallIso);
        const dRec   = _daysAgo(lastRecIso);
        const dFcm   = _daysAgo(lastFcmIso);

        if (dLogin === null) {
          diag = { step: 'app_open', severity: 'red', message: 'User never logged in to mobile app' };
        } else if (dLogin > 7) {
          diag = { step: 'app_open', severity: 'red', message: 'App not opened in ' + dLogin + ' days — user may have uninstalled' };
        } else if (dFcm === null) {
          diag = { step: 'fcm_register', severity: 'yellow', message: 'Never registered FCM token — push won’t reach this device' };
        } else if (dFcm > 14) {
          diag = { step: 'fcm_register', severity: 'yellow', message: 'FCM token last refreshed ' + dFcm + 'd ago' };
        } else if (dCall === null) {
          diag = { step: 'call_detect', severity: 'red', message: 'No call events ever — Phone permission missing or PhoneStateReceiver not firing' };
        } else if (dCall > 3) {
          diag = { step: 'call_detect', severity: 'red', message: 'Last call event ' + dCall + 'd ago — likely Phone perm revoked OR app killed by Sleeping Apps / battery optimization' };
        } else if (dRec === null) {
          diag = { step: 'rec_upload', severity: 'red', message: 'Calls detected but no recording ever uploaded — Storage permission OR recording folder path wrong' };
        } else if (dRec > 3) {
          diag = { step: 'rec_upload', severity: 'red', message: 'Last recording ' + dRec + 'd ago while calls still flowing — Recording sync worker stopped (Sleeping Apps / All-Files-Access revoked)' };
        } else if (matchedPct !== null && matchedPct < 50 && total >= 4) {
          diag = { step: 'lead_match', severity: 'yellow', message: 'Only ' + matchedPct + '% of recordings matched to a lead — filename parser may be off' };
        }

        // Extract device info from the latest telemetry row (Phase 2 heartbeats).
        const dd = lastDiagByUser.get(Number(u.id));
        let device_info = null;
        if (dd && dd.payload) {
          try {
            const p = typeof dd.payload === 'string' ? JSON.parse(dd.payload) : dd.payload;
            const cap = p.capacitor || {};
            const dev = cap.device || {};
            const net = cap.network || {};
            const batt = cap.battery || {};
            device_info = {
              model: dev.model || null,
              manufacturer: dev.manufacturer || null,
              platform: dev.platform || null,
              os_version: dev.osVersion || null,
              app_version: dev.appVersion || null,
              app_build: dev.appBuild || null,
              network_type: net.connectionType || null,
              battery_pct: batt.batteryLevel != null ? Math.round(Number(batt.batteryLevel) * 100) : null,
              charging: batt.isCharging != null ? !!batt.isCharging : null,
              perm_mic: (p.perms && p.perms.microphone) || null,
              perm_geo: (p.perms && p.perms.geolocation) || null,
              perm_notif: (p.perms && p.perms.notifications) || null,
              breadcrumbs: p.breadcrumbs || null,
              last_diag_at: dd.created_at,
              device_id: dd.device_id,
            };
          } catch (_) {}
        }

        return {
          user_id: u.id,
          user_name: u.name || u.email,
          user_email: u.email,
          user_role: u.role,
          device_info: device_info,
          last_login_at: lastLoginIso,
          last_fcm_at: lastFcmIso,
          last_call_event_at: lastCallIso,
          last_recording_at: lastRecIso,
          days_since_login: dLogin,
          days_since_call:  dCall,
          days_since_recording: dRec,
          recordings_total: total,
          recordings_matched: matched,
          recordings_matched_pct: matchedPct,
          diagnosis: diag,
        };
      });

      const sevRank = { red: 0, yellow: 1, green: 2 };
      perUser.sort((a, b) =>
        (sevRank[a.diagnosis.severity] ?? 3) - (sevRank[b.diagnosis.severity] ?? 3)
        || (b.recordings_total || 0) - (a.recordings_total || 0));

      const summary = {
        users_total: perUser.length,
        users_red:    perUser.filter(u => u.diagnosis.severity === 'red').length,
        users_yellow: perUser.filter(u => u.diagnosis.severity === 'yellow').length,
        users_green:  perUser.filter(u => u.diagnosis.severity === 'green').length,
      };
      return { summary: summary, users: perUser };
    });
    return Object.assign({ ok: true }, data);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function _tenantSnapshot() {
  const db = require('../../db/pg');
  const r = await db.query(
    "SELECT" +
    " (SELECT COUNT(*) FROM users WHERE COALESCE(is_active,true)=true)::int AS users," +
    " (SELECT MAX(uploaded_at) FROM recordings) AS last_rec_at," +
    " (SELECT COUNT(*) FROM recordings WHERE uploaded_at > NOW() - INTERVAL '24 hours')::int AS recs_24h," +
    " (SELECT COUNT(*) FROM call_events WHERE created_at > NOW() - INTERVAL '24 hours')::int AS calls_24h"
  ).then(x => x.rows[0] || {}).catch(() => ({}));
  return r;
}

// -------------------------------------------------------------------------
// Phase 2 — explicit telemetry from the SPA
// -------------------------------------------------------------------------

async function _ensureDiagTable() {
  const db = require('../../db/pg');
  await db.query(
    "CREATE TABLE IF NOT EXISTS device_diag_events (" +
    "  id           BIGSERIAL PRIMARY KEY," +
    "  user_id      BIGINT," +
    "  device_id    TEXT," +
    "  event_type   TEXT NOT NULL," +
    "  severity     TEXT," +
    "  step         TEXT," +
    "  payload      JSONB," +
    "  created_at   TIMESTAMPTZ DEFAULT NOW()" +
    ")"
  ).catch(() => {});
  await db.query("CREATE INDEX IF NOT EXISTS idx_devicediag_user_created ON device_diag_events (user_id, created_at DESC)").catch(() => {});
  await db.query("CREATE INDEX IF NOT EXISTS idx_devicediag_step_created ON device_diag_events (step, created_at DESC)").catch(() => {});
  // DEVICE_DIAG_RETENTION_3D: drop events older than 3 days every time the table is touched.
  // Acts as a passive cron — every super-admin read or first-ingest call cleans up.
  await db.query("DELETE FROM device_diag_events WHERE created_at < NOW() - INTERVAL '3 days'").catch(() => {});
}

/* api_devicediag_ingest moved to routes/devicediag.js (tenant scope) — DEVICE_DIAG_INGEST_FIX_v1 */

async function api_saas_devicediag_timeline(token, opts) {
  await requireSuperAdmin(token);
  const slug   = String((opts && opts.tenant_slug) || '').trim();
  const userId = Number((opts && opts.user_id) || 0) || null;
  const limit  = Math.min(Number((opts && opts.limit) || 200), 500);
  if (!slug) return { ok: false, error: 'tenant_slug required' };

  try {
    const data = await withTenantDb(slug, async () => {
      await _ensureDiagTable();
      const db = require('../../db/pg');
      const where = userId ? 'WHERE user_id = $1' : '';
      const params = userId ? [userId, limit] : [limit];
      const sql = "SELECT id, user_id, device_id, event_type, severity, step, payload, created_at" +
                  " FROM device_diag_events " + where +
                  " ORDER BY created_at DESC LIMIT $" + params.length;
      const events = await db.query(sql, params).then(r => r.rows || []);
      // DEVICE_DIAG_INGEST_FIX_v1: include tenant-wide stats so the empty state
      // can tell the operator WHY they see nothing.
      const stats = await db.query(
        "SELECT" +
        " COUNT(*)::int AS tenant_total," +
        " COUNT(DISTINCT user_id)::int AS distinct_users," +
        " MAX(created_at) AS last_event_at" +
        " FROM device_diag_events"
      ).then(r => r.rows[0] || {}).catch(() => ({}));
      return { events, stats };
    });
    return { ok: true, events: data.events, stats: data.stats };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  api_saas_recHealth_overview: api_saas_recHealth_overview,
  api_saas_recHealth_byTenant: api_saas_recHealth_byTenant,
  /* api_devicediag_ingest exported from routes/devicediag.js — DEVICE_DIAG_INGEST_FIX_v1 */
  api_saas_devicediag_timeline: api_saas_devicediag_timeline,
};
