/**
 * DEVICE_DIAG_INGEST_v1 — tenant-side ingest endpoint for phone telemetry.
 *
 * Lives at routes/devicediag.js (NOT routes/saas/) because the tenant
 * /api JSON dispatcher only loads files via ROUTE_FILES → require('../<name>').
 *
 * The super-admin read endpoints (api_saas_recHealth_*, api_saas_devicediag_*)
 * stay in routes/saas/recordingHealth.js. This file is purely the write path
 * for the SPA's deviceDiag.js heartbeats.
 */
'use strict';

const db = require('../db/pg');

async function _ensureDiagTable() {
  await db.query(
    "CREATE TABLE IF NOT EXISTS device_diag_events (" +
    "  id BIGSERIAL PRIMARY KEY, user_id BIGINT, device_id TEXT," +
    "  event_type TEXT NOT NULL, severity TEXT, step TEXT," +
    "  payload JSONB, created_at TIMESTAMPTZ DEFAULT NOW())"
  ).catch(() => {});
  await db.query("CREATE INDEX IF NOT EXISTS idx_devicediag_user_created ON device_diag_events (user_id, created_at DESC)").catch(() => {});
  await db.query("CREATE INDEX IF NOT EXISTS idx_devicediag_step_created  ON device_diag_events (step, created_at DESC)").catch(() => {});
}

function _decodeUser(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(String(token || '').replace(/^Bearer\s+/i, ''));
    return decoded && decoded.id ? Number(decoded.id) || null : null;
  } catch (e) { return null; }
}

async function api_devicediag_ingest(token, payload) {
  const userId = _decodeUser(token);
  await _ensureDiagTable();

  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  const deviceId = String((payload && payload.device_id) || '').slice(0, 64) || null;
  if (!events.length) return { ok: true, written: 0 };

  const batch = events.slice(0, 50);
  let written = 0;
  for (const ev of batch) {
    try {
      const created = ev && ev.created_at_ms && Number(ev.created_at_ms)
                       ? new Date(Number(ev.created_at_ms)) : new Date();
      await db.query(
        "INSERT INTO device_diag_events (user_id, device_id, event_type, severity, step, payload, created_at)" +
        " VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          userId, deviceId,
          String(ev.event_type || 'unknown').slice(0, 64),
          String(ev.severity || 'info').slice(0, 16),
          String(ev.step || '').slice(0, 32) || null,
          ev.payload && typeof ev.payload === 'object' ? JSON.stringify(ev.payload) : JSON.stringify({ raw: ev.payload }),
          created,
        ]
      );
      written++;
    } catch (_e) {}
  }
  // DEVICE_DIAG_RETENTION_3D: keep only events from the last 3 days.
  // Runs on every ingest call (cheap because of the (created_at DESC) index),
  // so the table self-heals continuously without a separate cron.
  try {
    await db.query("DELETE FROM device_diag_events WHERE created_at < NOW() - INTERVAL '3 days'");
  } catch (_e) {}

  return { ok: true, written: written };
}

module.exports = { api_devicediag_ingest };
