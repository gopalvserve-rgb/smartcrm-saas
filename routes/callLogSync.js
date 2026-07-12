/**
 * routes/callLogSync.js — CALLLOG_SYNC_v1 (+ CALLLOG_REPAIR_v1)
 *
 * Self-contained batch import of the device's CallLog.Calls rows. The native
 * app reads the phone's call-log content provider over a chosen date range
 * (Today / Yesterday / 7d / 30d / 6mo / custom), respecting the rep's
 * persistent SIM selection, and POSTs the rows here.
 *
 * Deliberately ISOLATED in its own file so deploying this feature never
 * touches routes/recordings.js or db/pg.js. It:
 *   • maps each row to direction (in/out/missed),
 *   • matches the number to a lead (reuses _findLeadByPhone from recordings),
 *   • DE-DUPES against events already captured live by the receiver AND
 *     against previous syncs,
 *   • writes a call_events row via a RAW insert (so it doesn't depend on the
 *     db/pg.js column whitelist), with created_at = the real call time.
 *
 * Never touches recordings/audio. Rows are tagged src='calllog' (fresh import)
 * or src='calllog-fix' (repaired a broken live row).
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');
const { _findLeadByPhone } = require('./recordings');

// Lazy, idempotent column add. Runs once per process; safe on every tenant.
let _cols = false;
async function _ensureCols() {
  if (_cols) return;
  try {
    await db.query(
      `ALTER TABLE call_events
         ADD COLUMN IF NOT EXISTS sim_slot  INTEGER,
         ADD COLUMN IF NOT EXISTS sim_label TEXT,
         ADD COLUMN IF NOT EXISTS src       TEXT`
    );
  } catch (e) { /* best-effort */ }
  _cols = true;
}

/**
 * payload = {
 *   rows: [ { phone, direction?, type?, ts (epoch ms), duration_s,
 *             sim_slot?, sim_label? } ],
 *   leadOnly?: bool     // optional per-call override; else config default
 * }
 * returns { ok, received, inserted, repaired, skipped, matched }
 */
async function api_call_logSyncBatch(token, payload) {
  const me = await authUser(token);
  const p  = payload || {};
  const rows = Array.isArray(p.rows) ? p.rows : [];
  await _ensureCols();

  // USER_CALL_PREFS_v1 (2026-07-12) — PER USER, not per company. Resolves this
  // rep's own choice, falling back to the company default if they haven't set one.
  // Default OFF → sync every call (TeleCRM "Work" behaviour).
  let leadOnlyCfg = false;
  try {
    const pref = await require('./userCallPrefs').resolveCallPrefs(me.id);
    leadOnlyCfg = !!pref.sync_lead_only;
  } catch (e) {
    leadOnlyCfg = String(await db.getConfig('CALLS_SYNC_LEAD_ONLY', '0')) === '1';
  }
  const leadOnly = (typeof p.leadOnly === 'boolean') ? p.leadOnly : leadOnlyCfg;

  const W  = 90;   // de-dup window, seconds
  const RW = 150;  // repair window, seconds — wider than W because Doze can delay a
                   // live row's created_at by a minute or more (82s measured on a
                   // real device).
  let inserted = 0, repaired = 0, skipped = 0, matched = 0;

  for (const r of rows) {
    const phone  = String(r.phone || '').trim();
    const digits = phone.replace(/\D/g, '');
    if (!digits) { skipped++; continue; }

    // Prefer device-derived direction; else fall back to CallLog.Calls TYPE
    // (1=in, 2=out, 3=missed, 5=rejected).
    let direction = String(r.direction || '').toLowerCase();
    if (!['in', 'out', 'missed'].includes(direction)) {
      const t = Number(r.type);
      direction = t === 2 ? 'out' : (t === 3 || t === 5 ? 'missed' : 'in');
    }
    const duration = Math.max(0, Number(r.duration_s) || 0);
    const event    = direction === 'missed' ? 'missed' : (duration > 0 ? 'ended' : 'no_answer');
    const startMs  = Number(r.ts) || Date.now();
    const whenIso  = new Date(startMs).toISOString();
    // A live row's created_at is ~the call END. CallLog gives START, so END =
    // START + DURATION. Used to line a CallLog row up with its broken live twin.
    const endIso   = new Date(startMs + duration * 1000).toISOString();

    let lead = null;
    try { lead = await _findLeadByPhone(phone); } catch (_) { lead = null; }
    if (lead) matched++;
    if (leadOnly && !lead) { skipped++; continue; }

    // De-dupe. CallLog ts is the call START. A live-captured row's created_at
    // is ~the call END (start+duration); a previously-synced row's created_at
    // IS the start. Accept a match on either interpretation, within ±90s, for
    // the same user + direction + last-10 digits.
    const tail = '%' + digits.slice(-10);
    // DEDUP_RINGING_FIX_v1 (2026-07-12) — `event <> 'incoming_ringing'` is load
    // bearing. The receiver logs TWO rows per inbound call: a RINGING row and an
    // ENDED row. A CallLog row corresponds to the ENDED one. Without this filter
    // the RINGING row counted as "already logged", we skipped early, and the
    // BROKEN ended-twin (direction='unknown' / blank phone) never reached the
    // repair block below — which is exactly why those rows kept surviving.
    const { rows: dup } = await db.query(
      `SELECT 1 FROM call_events
         WHERE user_id = $1 AND direction = $2
           AND event NOT IN ('incoming_ringing', 'dial_requested')
           AND regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE $3
           AND ( ABS(EXTRACT(EPOCH FROM (created_at - $4::timestamptz))) < ${W}
              OR ABS(EXTRACT(EPOCH FROM ((created_at - (COALESCE(duration_s,0) * interval '1 second')) - $4::timestamptz))) < ${W} )
         LIMIT 1`,
      [me.id, direction, tail, whenIso]
    );
    if (dup.length) { skipped++; continue; }

    const simSlot  = (r.sim_slot === undefined || r.sim_slot === null) ? null : Number(r.sim_slot);
    const simLabel = r.sim_label ? String(r.sim_label).slice(0, 60) : null;

    // CALLLOG_REPAIR_v1 (2026-07-12) — before inserting a NEW row, see if this
    // call is already in the table as a BROKEN live row and fix it in place.
    // PhoneStateReceiver produces two broken shapes, both of which used to
    // survive as junk sitting next to a correct synced row:
    //   (a) BLANK PHONE — Android 10+ hands the receiver no number, so the row
    //       lands with phone='' (the "—" rows in Call Activity).
    //   (b) WRONG DIRECTION — the receiver inferred direction from an in-memory
    //       flag that Doze had already cleared, and defaulted to 'out'. Result:
    //       phantom 0-second "Outgoing" rows that were really incoming/missed.
    //   (c) direction='unknown' — the post-fix server refuses to guess.
    // CallLog is the source of truth, so UPDATE the offender instead of
    // inserting a duplicate beside it.
    //
    // Safety rails: only rows the receiver wrote (src IS NULL) are ever touched
    // — never a row a previous sync inserted. recording_id is left alone, so a
    // repaired row keeps its recording.
    const { rows: fix } = await db.query(
      `SELECT id FROM call_events
         WHERE user_id = $1
           AND src IS NULL
           AND (
                 regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') = ''
                 OR ( regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE $2
                      AND ( direction = 'unknown'
                            -- DIAL_REQUESTED_HIDE_v1: a 'dial_requested' row is a
                            -- 0-second INTENT written when the rep tapped Call. If the
                            -- call really happened, absorb it here so the row carries the
                            -- real talk time instead of staying at 0s.
                            OR ( COALESCE(duration_s,0) = 0 AND event = 'dial_requested' )
                            OR ( COALESCE(duration_s,0) = 0 AND direction <> $3 ) ) )
               )
           AND ABS(EXTRACT(EPOCH FROM (created_at - $4::timestamptz))) < ${RW}
         ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $4::timestamptz))) ASC
         LIMIT 1`,
      [me.id, tail, direction, endIso]
    );
    if (fix.length) {
      await db.query(
        `UPDATE call_events
            SET phone = $1, direction = $2, event = $3, duration_s = $4,
                lead_id = COALESCE(lead_id, $5), sim_slot = $6, sim_label = $7,
                src = 'calllog-fix', created_at = $8
          WHERE id = $9`,
        [phone, direction, event, duration, lead ? lead.id : null,
         simSlot, simLabel, whenIso, fix[0].id]
      );
      repaired++;
      await _demoteLiveTwins(me.id, tail, startMs, duration, fix[0].id);
      continue;
    }

    await db.query(
      `INSERT INTO call_events
         (lead_id, user_id, phone, direction, event, duration_s, recording_id, sim_slot, sim_label, src, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 'calllog', $9)`,
      [lead ? lead.id : null, me.id, phone, direction, event, duration, simSlot, simLabel, whenIso]
    );
    inserted++;
    await _demoteLiveTwins(me.id, tail, startMs, duration, null);
  }

  return { ok: true, received: rows.length, inserted, repaired, skipped, matched };
}

/**
 * LIVE_TWIN_DEMOTE_v1 (2026-07-12)
 * -------------------------------
 * The phone's call log is the truth. The live PhoneStateReceiver is not — on
 * Android 10+ it can't see outgoing numbers, Doze wipes the state it uses to
 * guess direction, and a missed OFFHOOK makes an answered call look "Missed".
 * Every duplicate/ghost row in Call Activity came from it.
 *
 * So once the call log has given us the real row for a call, we DEMOTE the live
 * receiver's row(s) for that same call: src = 'live-dup'. We do NOT delete them,
 * and that is deliberate:
 *
 *   • Live Team Status (routes/team.js) reads call_events raw. It needs the live
 *     'incoming_ringing' / 'dial_requested' row to show a rep as ON CALL (with the
 *     number), and the live 'call_ended' row to detect the HANG-UP. Deleting them
 *     would strand reps on "On call" for the full 20-minute safety cap.
 *   • The recording upload gate (api_call_hasRecentEvent) also reads the raw table.
 *
 * Neither filters on src, so both keep working exactly as before. Only the
 * call-facing views (Call Activity + the call KPIs in routes/reports.js) exclude
 * 'live-dup'. Reversible: clearing src back to NULL restores the old behaviour.
 */
async function _demoteLiveTwins(userId, tail, startMs, durationS, keepId) {
  const startIso = new Date(startMs - 300 * 1000).toISOString();
  const endIso   = new Date(startMs + (durationS * 1000) + 300 * 1000).toISOString();
  try {
    await db.query(
      `UPDATE call_events
          SET src = 'live-dup'
        WHERE user_id = $1
          AND src IS NULL
          AND ($2::int IS NULL OR id <> $2::int)
          AND regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') <> ''
          AND regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') LIKE $3
          AND created_at >= $4::timestamptz
          AND created_at <= $5::timestamptz`,
      [userId, keepId, tail, startIso, endIso]
    );
  } catch (e) { /* best-effort: never fail a sync over cosmetics */ }
}

/**
 * LIVE_TWIN_CLEANUP_v1 — one-off backfill of LIVE_TWIN_DEMOTE_v1 over history.
 *
 * api_call_cleanupGhosts(token, { apply?: bool })
 *   apply=false (default) -> DRY RUN. Counts what would be demoted, changes nothing.
 *   apply=true            -> marks them src='live-dup'.
 *
 * A row is a ghost only if ALL of these hold:
 *   - the live receiver wrote it        (src IS NULL)
 *   - it has a number                   (blank-phone rows are handled by the repair pass)
 *   - the phone's call log has the SAME call for the SAME user, within +/-5 min
 *   - it carries no recording           (paranoia; recording_id is never set today,
 *                                        but if that ever changes we must not hide one)
 *
 * NOTHING IS DELETED. The rows stay so Live Team Status and the recording gate --
 * which read call_events raw and do not filter on src -- keep working untouched.
 * Reversible: UPDATE call_events SET src=NULL WHERE src='live-dup'.
 */
async function api_call_cleanupGhosts(token, payload) {
  const me = await authUser(token);
  if (String(me.role || '') !== 'admin') throw new Error('Admins only');
  const apply = !!(payload && payload.apply);

  const WHERE = `
      FROM call_events ce
     WHERE ce.src IS NULL
       AND ce.recording_id IS NULL
       AND regexp_replace(COALESCE(ce.phone,''), '[^0-9]', '', 'g') <> ''
       AND EXISTS (
             SELECT 1 FROM call_events t
              WHERE t.src IN ('calllog', 'calllog-fix')
                AND t.user_id = ce.user_id
                AND t.id <> ce.id
                AND RIGHT(regexp_replace(COALESCE(t.phone,''),  '[^0-9]', '', 'g'), 10)
                  = RIGHT(regexp_replace(COALESCE(ce.phone,''), '[^0-9]', '', 'g'), 10)
                AND ce.created_at BETWEEN t.created_at - INTERVAL '5 minutes'
                                      AND t.created_at + (COALESCE(t.duration_s,0) * INTERVAL '1 second') + INTERVAL '5 minutes'
           )`;

  const { rows: preview } = await db.query(
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE ce.direction = 'out')::int    AS ghost_out,
            COUNT(*) FILTER (WHERE ce.direction = 'missed')::int AS ghost_missed,
            COUNT(*) FILTER (WHERE ce.direction = 'in')::int     AS ghost_in,
            COUNT(*) FILTER (WHERE ce.direction = 'unknown')::int AS ghost_unknown
       ${WHERE}`
  );
  const found = preview[0] || { n: 0 };
  if (!apply) return { dry_run: true, would_demote: found.n, breakdown: found };

  const { rowCount } = await db.query(
    `UPDATE call_events SET src = 'live-dup'
      WHERE id IN (SELECT ce.id ${WHERE})`
  );
  return { dry_run: false, demoted: rowCount, breakdown: found };
}

module.exports = { api_call_logSyncBatch, api_call_cleanupGhosts, _demoteLiveTwins };
