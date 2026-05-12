/**
 * utils/recordingDiag.js — per-tenant log of every transcode attempt.
 *
 * Writes to the recording_diag_log table in each tenant's pool (created
 * by the tenant bootstrap migration). Captures binary path + version +
 * byte counts + error so admins can debug playback issues without
 * needing server logs.
 *
 * All writes are fire-and-forget; transcoder errors must NOT block the
 * audio response.
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('./auth');
const cp = require('child_process');

const MAX_ROWS = 2000;

function _ffmpegVersion(bin) {
  try {
    const out = cp.execFileSync(bin || 'ffmpeg', ['-version'], { encoding: 'utf8', timeout: 3000 });
    return out.split('\n')[0].slice(0, 200);
  } catch (e) {
    return 'unavailable: ' + (e.message || e).toString().slice(0, 200);
  }
}

/**
 * Write one row to the diagnostic log. Caller fills in everything it
 * knows; we fill in ffmpeg binary + version automatically. Fire-and-
 * forget — errors are swallowed.
 */
async function log(entry) {
  setImmediate(async () => {
    try {
      const tx = require('./audioTranscode');
      const bin = tx.getFfmpegBinary && tx.getFfmpegBinary();
      await db.query(
        `INSERT INTO recording_diag_log
           (recording_id, action, result, ffmpeg_binary, ffmpeg_version,
            bytes_in, bytes_out, mime_in, mime_out, error_message, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          entry.recording_id || null,
          String(entry.action || ''),
          String(entry.result || ''),
          bin || null,
          _ffmpegVersion(bin),
          Number.isFinite(entry.bytes_in)  ? entry.bytes_in  : null,
          Number.isFinite(entry.bytes_out) ? entry.bytes_out : null,
          entry.mime_in || null,
          entry.mime_out || null,
          entry.error_message ? String(entry.error_message).slice(0, 2000) : null,
          Number.isFinite(entry.duration_ms) ? entry.duration_ms : null
        ]
      );
      await db.query(
        `DELETE FROM recording_diag_log WHERE id IN (
           SELECT id FROM recording_diag_log ORDER BY id DESC OFFSET $1
         )`, [MAX_ROWS]
      );
    } catch (e) {
      console.warn('[rec-diag] insert failed:', e.message);
    }
  });
}

async function api_admin_recordingDiag_list(token, opts) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin/manager only');
  const o = opts || {};
  const limit = Math.max(1, Math.min(500, Number(o.limit || 100)));
  try {
    const where = [];
    const vals = [];
    if (o.recording_id) { vals.push(Number(o.recording_id)); where.push('recording_id = $' + vals.length); }
    if (o.action)       { vals.push(String(o.action));       where.push('action = $' + vals.length); }
    if (o.result)       { vals.push(String(o.result));       where.push('result = $' + vals.length); }
    const wh = where.length ? 'WHERE ' + where.join(' AND ') : '';
    vals.push(limit);
    const r = await db.query(
      `SELECT id, recording_id, action, result, ffmpeg_binary, ffmpeg_version,
              bytes_in, bytes_out, mime_in, mime_out, error_message, duration_ms, created_at
         FROM recording_diag_log ${wh}
         ORDER BY id DESC LIMIT $${vals.length}`, vals);
    return { rows: r.rows };
  } catch (e) {
    return { rows: [], note: 'No diagnostics yet — try playing a recording first.' };
  }
}

module.exports = { log, api_admin_recordingDiag_list };
