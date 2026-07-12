package app.leadcrm.mobile

/*
 * ============================================================
 * 🔒 LOCKED FILE — Recording & Call Sync Pipeline
 * ============================================================
 * This file is part of the call/recording sync pipeline. It is
 * mission-critical: any change here can stop recordings from
 * reaching the CRM, which is a customer-visible regression.
 *
 * BEFORE editing — read docs/LOCKED_FILES.md and
 * RECORDING_ARCHITECTURE_AND_LOCKDOWN.md (workspace root), then
 * ASK THE USER explicitly before making any change. No
 * "cleanups", no "refactors", no "fixes for unused imports"
 * without approval.
 * ============================================================
 */

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.CallLog
import android.telephony.TelephonyManager
import android.util.Log
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * Three-path call-event bridge so the chain doesn't break in any
 * device/app state:
 *
 *   1. CallerIdPlugin.instance?.emitRinging(...)  (Capacitor event)
 *   2. ctx.sendBroadcast("…CALL_EVENT")          (intra-app intent)
 *   3. HTTP POST to ${apiBase}/api/call_event_native with the saved
 *      auth token                                  (no WebView/JS
 *      dependency — works even if the app is fully killed)
 *
 * CALL_PHONE_CAPTURE_v1 (2026-05-22)
 * ----------------------------------
 * On Android 10+ (API 29+), `TelephonyManager.EXTRA_INCOMING_NUMBER`
 * and `Intent.EXTRA_PHONE_NUMBER` return null due to a privacy
 * change — apps can no longer read the phone number from the
 * PHONE_STATE broadcast. The fix: fall back to querying the
 * CallLog.Calls content provider for the most recent entry
 * (READ_CALL_LOG permission is already declared in the manifest).
 *
 * The call log entry isn't written until the call ends, so this
 * fallback is most reliable on the IDLE event. At RINGING the log
 * may or may not have the entry — we still try, and if empty the
 * subsequent IDLE pass will retry with the now-written entry.
 */
class PhoneStateReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PhoneStateReceiver"
        private const val ACTION_CALL_EVENT = "app.leadcrm.mobile.CALL_EVENT"
        private const val PREFS = "leadcrm"
        private const val KEY_API_BASE = "api_base"
        private const val KEY_TOKEN    = "auth_token"
        private var lastState: String = TelephonyManager.EXTRA_STATE_IDLE
        private var lastNumber: String = ""
        // CALL_CARD_STALE_v2: timestamp tracks when lastNumber was set.
        // Used to age out stale numbers between calls so the previous
        // caller can't leak into the next call's overlay.
        private var lastNumberSetAt: Long = 0L
        private const val LASTNUM_TTL_MS = 30_000L
        private var ringStartMs: Long = 0
        private var offhookStartMs: Long = 0
        // CALL_DIRECTION_TRUTH_v1: DATE of the last CallLog row we already
        // reported, so a replayed burst of queued broadcasts can't double-post.
        private var lastReportedLogDate: Long = 0L
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action == "android.intent.action.NEW_OUTGOING_CALL") {
            val n = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER) ?: ""
            if (n.isNotEmpty()) {
                lastNumber = n
                lastNumberSetAt = System.currentTimeMillis()
            }
            return
        }

        if (action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        // EXTRA_INCOMING_NUMBER returns null on Android 10+ — see class doc.
        var number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: ""
        // CALL_CARD_STALE_v2 (2026-05-31): do NOT blindly fall back to
        // `lastNumber` here — that static companion var holds the previous
        // call's number on Android 10+, which is exactly what was leaking
        // into the next call's overlay. Each state branch below now
        // resolves its own number (RINGING -> CallLog, OFFHOOK outgoing
        // -> fresh lastNumber within TTL).
        val now = System.currentTimeMillis()

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                ringStartMs = now
                // CALL_CARD_DIRECTION_FIX_v1 (2026-06-03): persist a "this call
                // is incoming" marker in SharedPreferences. The in-memory
                // companion `lastState` field can be lost when the broadcast
                // receiver process is killed between RINGING and OFFHOOK
                // (very common on Samsung/Vivo). When OFFHOOK fires later, we
                // read this persistent marker — if it's recent, we know the
                // OFFHOOK is an answered INCOMING call, not an outbound, and
                // we skip launching OutgoingCallActivity.
                try {
                    ctx.getSharedPreferences("call_card_state", Context.MODE_PRIVATE)
                        .edit()
                        .putLong("last_ringing_at", now)
                        .apply()
                } catch (_: Exception) {}
                // CALL_CARD_STALE_v2: try CallLog if the broadcast didn't carry
                // a number. We DO NOT use lastNumber here — it would be the
                // previous call's number on Android 10+.
                if (number.isEmpty()) {
                    val fromLog = readLastCallLogNumber(ctx, sinceMs = now - 15_000L)
                    if (fromLog.isNotEmpty()) number = fromLog
                }
                // Stamp lastNumber WITH timestamp so the later IDLE branch can
                // still resolve a missed-call number, but stale values can be
                // detected and skipped.
                lastNumber = number
                lastNumberSetAt = now
                if (number.isNotEmpty()) {
                    Log.i(TAG, "RINGING from $number → fire incoming_ringing")
                    // INCOMING_CARD_v2: launch the Activity DIRECTLY (Truecaller-style).
                    // FSI alone only auto-launches on lock screen; when screen is on with
                    // another app foreground (the dialer), Android queues the Activity and
                    // only shows it when our app comes to front. Direct startActivity is
                    // the only reliable way to overlay the dialer. We still fire the FSI
                    // notification below as a fallback (in case Activity start gets blocked
                    // by an OEM or by background-launch restrictions).
                    try {
                        if (IncomingCallActivity.isEnabled(ctx)) {
                            val act = IncomingCallActivity.newIntent(ctx, number)
                            // Make sure the Activity always launches as its own task on top.
                            act.addFlags(
                                Intent.FLAG_ACTIVITY_NEW_TASK
                                        or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                                        or Intent.FLAG_ACTIVITY_NO_ANIMATION
                            )
                            ctx.startActivity(act)
                            Log.i(TAG, "incoming card Activity launched directly")
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "direct startActivity failed (${e.message}) - relying on FSI fallback")
                    }
                    // FSI notification — still useful as fallback + as the heads-up notification.
                    try { NotificationHelper.showFullScreenForIncoming(ctx, number) } catch (e: Exception) { Log.w(TAG, "incoming card FSI failed: ${e.message}") }
                    safeCapacitor { CallerIdPlugin.instance?.emitRinging(number) }
                    sendCallEvent(ctx, "incoming_ringing", number, missed = false, durationSec = 0)
                    postNativeAsync(ctx, "incoming_ringing", number, direction = "in", missed = false, durationSec = 0)
                } else {
                    Log.w(TAG, "RINGING but number unavailable (Android 10+) — will retry at IDLE")
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                offhookStartMs = now
                // OUTGOING_CARD_v1 (2026-05-31): if we transitioned IDLE -> OFFHOOK
                // (no RINGING in between) this is an outbound call. Try the CallLog
                // fallback if EXTRA_PHONE_NUMBER wasn't captured by NEW_OUTGOING_CALL,
                // then launch the OutgoingCallActivity overlay.
                // CALL_CARD_DIRECTION_FIX_v1 (2026-06-03): read the persistent
                // RINGING marker as a SECOND guard. If we saw RINGING within
                // the last 60 seconds (even if the receiver process died and
                // restarted, so `lastState` is back to IDLE), this OFFHOOK is
                // an answered incoming call — DO NOT launch outgoing card.
                val lastRingingAt = try {
                    ctx.getSharedPreferences("call_card_state", Context.MODE_PRIVATE)
                        .getLong("last_ringing_at", 0L)
                } catch (_: Exception) { 0L }
                val recentRinging = lastRingingAt > 0 && (now - lastRingingAt) < 60_000L

                if (lastState != TelephonyManager.EXTRA_STATE_RINGING && !recentRinging) {
                    // CALL_CARD_STALE_v2: only trust lastNumber if it was set
                    // by NEW_OUTGOING_CALL within the TTL — otherwise it's
                    // stale and would show the previous caller.
                    var outNumber = if (now - lastNumberSetAt <= LASTNUM_TTL_MS) lastNumber else ""
                    if (outNumber.isEmpty()) {
                        val fromLog = readLastCallLogNumber(ctx, sinceMs = now - 15_000L)
                        if (fromLog.isNotEmpty()) outNumber = fromLog
                    }
                    if (outNumber.isNotEmpty()) {
                        try {
                            if (OutgoingCallActivity.isEnabled(ctx)) {
                                val act = OutgoingCallActivity.newIntent(ctx, outNumber)
                                act.addFlags(
                                    Intent.FLAG_ACTIVITY_NEW_TASK
                                            or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                                            or Intent.FLAG_ACTIVITY_NO_ANIMATION
                                )
                                ctx.startActivity(act)
                                Log.i(TAG, "outgoing card Activity launched for $outNumber")
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "outgoing card direct launch failed (${e.message}) - relying on FSI fallback")
                        }
                        // OUTGOING_CARD_v1.1: FSI notification fallback. Android 10+ silently
                        // blocks startActivity() from a broadcast receiver; the FSI notification
                        // is the bulletproof path that bypasses that restriction.
                        try { NotificationHelper.showFullScreenForOutgoing(ctx, outNumber) }
                        catch (e: Exception) { Log.w(TAG, "outgoing card FSI failed: ${e.message}") }
                    } else {
                        Log.w(TAG, "OFFHOOK (outgoing) but number unavailable - card skipped")
                    }
                }
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                // CALL_DIRECTION_TRUTH_v1 (2026-07-12)
                // ------------------------------------
                // The call has ended, so CallLog.Calls now holds the truth for it:
                // NUMBER, TYPE (1=in 2=out 3=missed 5=rejected) and DURATION.
                // We take all three from there.
                //
                // Why: direction used to be inferred from the in-memory flag
                // `ringStartMs > 0`, defaulting to "out". That flag is cleared on
                // every IDLE and is lost whenever the OEM battery optimiser freezes
                // the receiver (an 82-second broadcast delay was measured on a real
                // device). Any stray OFFHOOK/IDLE pair -- a rejected call, the dialer
                // opening, a replayed burst of queued broadcasts -- therefore
                // manufactured a phantom 0-second OUTGOING row for what was really an
                // incoming or missed call. CallLog cannot lie about direction; the
                // in-memory flag can.
                val wasRinging = lastState == TelephonyManager.EXTRA_STATE_RINGING
                val wasOffhook = lastState == TelephonyManager.EXTRA_STATE_OFFHOOK
                if (wasRinging || wasOffhook) {
                    val n0           = lastNumber
                    val ringHappened = ringStartMs > 0
                    val fallbackDur  = if (wasOffhook) (now - offhookStartMs) / 1000 else 0L
                    resolveFromCallLog(ctx, now) { entry ->
                        if (entry != null && entry.dateMs > 0L && entry.dateMs == lastReportedLogDate) {
                            Log.i(TAG, "CallLog entry ${entry.dateMs} already reported - suppressing duplicate")
                        } else {
                            var dir = if (entry != null) typeToDirection(entry.type) else ""
                            var dur = entry?.durationS ?: fallbackDur
                            val finalNumber =
                                if (entry != null && entry.number.isNotEmpty()) entry.number else n0
                            var emit = true

                            if (dir.isEmpty()) {
                                // CallLog gave us nothing usable. Fall back to the old
                                // in-memory inference -- but NEVER invent an outgoing
                                // call out of a 0-second OFFHOOK blip with no number.
                                // That was the phantom-row bug.
                                dur = fallbackDur
                                when {
                                    wasRinging   -> dir = "missed"
                                    ringHappened -> dir = "in"
                                    finalNumber.isEmpty() && fallbackDur <= 1L -> {
                                        Log.w(TAG, "IDLE: no CallLog match, no number, 0s - suppressing phantom event")
                                        emit = false
                                    }
                                    else -> dir = "out"
                                }
                            }

                            if (emit) {
                                val missed = dir == "missed"
                                if (missed) dur = 0L
                                if (entry != null && entry.dateMs > 0L) lastReportedLogDate = entry.dateMs

                                Log.i(TAG, "CALL END -> dir=$dir num=$finalNumber dur=${dur}s (callLogType=${entry?.type ?: -1})")
                                safeCapacitor { CallerIdPlugin.instance?.emitEnded(finalNumber, dur, missed = missed) }
                                sendCallEvent(ctx, "call_ended", finalNumber, missed = missed, durationSec = dur)
                                postNativeAsync(ctx, "call_ended", finalNumber, direction = dir, missed = missed, durationSec = dur)
                                // REC_AUTOSYNC_KILL_v1 -- post-call recording auto-sync stays DISABLED.
                                // enqueueRecordingBgSync(ctx, "post-call")
                            }
                        }
                    }
                }
                ringStartMs = 0
                offhookStartMs = 0
                // CALL_CARD_STALE_v2: clear the static fallback so the next
                // call can't accidentally inherit this one's number.
                lastNumber = ""
                lastNumberSetAt = 0L
                // CALL_CARD_DIRECTION_FIX_v1: clear the persistent RINGING
                // marker so a brand-new outbound call later isn't mis-skipped.
                try {
                    ctx.getSharedPreferences("call_card_state", Context.MODE_PRIVATE)
                        .edit()
                        .remove("last_ringing_at")
                        .apply()
                } catch (_: Exception) {}
            }
        }
        lastState = state
    }

    /** One row of CallLog.Calls -- the authoritative record of a finished call. */
    private data class LogEntry(
        val number: String,
        val type: Int,
        val durationS: Long,
        val dateMs: Long
    )

    /** CallLog.Calls.TYPE -> CRM direction. "" when the type is one we don't map
     *  (voicemail, blocked, answered-externally...) so the caller can decide. */
    private fun typeToDirection(type: Int): String = when (type) {
        1 -> "in"        // INCOMING_TYPE
        2 -> "out"       // OUTGOING_TYPE
        3 -> "missed"    // MISSED_TYPE
        5 -> "missed"    // REJECTED_TYPE
        else -> ""
    }

    /**
     * CALL_DIRECTION_TRUTH_v1 -- resolve the call that just ended from CallLog.
     *
     * Replaces fireWithDelayedLookup(), which only ever fetched the NUMBER and
     * left direction/duration to be guessed from volatile in-memory state.
     *
     * The row isn't written until the call ends and some OEMs are slow to flush
     * it, so we retry with backoff (~11s total) before giving up. Runs on a
     * worker thread; the callback gets the entry, or null if nothing landed.
     */
    private fun resolveFromCallLog(ctx: Context, eventTimeMs: Long, cb: (LogEntry?) -> Unit) {
        Thread {
            val backoff = longArrayOf(700L, 1_500L, 3_000L, 6_000L)
            var entry: LogEntry? = null
            for (waitMs in backoff) {
                try { Thread.sleep(waitMs) } catch (_: Throwable) {}
                // Look back far enough to cover any realistic call. CallLog.DATE is
                // the call START while eventTimeMs is the call END, so a narrow
                // window would exclude long calls by its own WHERE clause -- that was
                // the original blank-number bug. ORDER BY DATE DESC LIMIT 1 still
                // picks the call that just ended.
                entry = readLastCallLogEntry(ctx, sinceMs = eventTimeMs - 21_600_000L)
                if (entry != null && entry.number.isNotEmpty()) break
            }
            if (entry == null) Log.w(TAG, "CallLog: no entry after retries - falling back to in-memory state")
            cb(entry)
        }.start()
    }

    /** Read NUMBER + TYPE + DURATION + DATE of the newest CallLog row >= sinceMs. */
    private fun readLastCallLogEntry(ctx: Context, sinceMs: Long): LogEntry? {
        return try {
            val proj = arrayOf(
                CallLog.Calls.NUMBER,
                CallLog.Calls.TYPE,
                CallLog.Calls.DURATION,
                CallLog.Calls.DATE
            )
            val sel   = "${CallLog.Calls.DATE} >= ?"
            val args  = arrayOf(sinceMs.toString())
            val order = "${CallLog.Calls.DATE} DESC LIMIT 1"
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI, proj, sel, args, order
            )?.use { c ->
                if (c.moveToFirst()) {
                    val iN = c.getColumnIndex(CallLog.Calls.NUMBER)
                    val iT = c.getColumnIndex(CallLog.Calls.TYPE)
                    val iD = c.getColumnIndex(CallLog.Calls.DURATION)
                    val iX = c.getColumnIndex(CallLog.Calls.DATE)
                    LogEntry(
                        number    = if (iN >= 0) (c.getString(iN) ?: "") else "",
                        type      = if (iT >= 0) c.getInt(iT) else 0,
                        durationS = if (iD >= 0) c.getLong(iD) else 0L,
                        dateMs    = if (iX >= 0) c.getLong(iX) else 0L
                    )
                } else null
            }
        } catch (se: SecurityException) {
            Log.w(TAG, "CallLog read denied - READ_CALL_LOG not granted: ${se.message}")
            null
        } catch (e: Throwable) {
            Log.w(TAG, "CallLog read failed: ${e.message}")
            null
        }
    }

    /**
     * Read the NUMBER of the most recent CallLog entry with DATE >= sinceMs.
     * Returns "" if permission missing, no rows, or any failure.
     */
    private fun readLastCallLogNumber(ctx: Context, sinceMs: Long): String {
        return try {
            val proj = arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.TYPE)
            val sel  = "${CallLog.Calls.DATE} >= ?"
            val args = arrayOf(sinceMs.toString())
            val order = "${CallLog.Calls.DATE} DESC LIMIT 1"
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI, proj, sel, args, order
            )?.use { c ->
                if (c.moveToFirst()) {
                    val idx = c.getColumnIndex(CallLog.Calls.NUMBER)
                    if (idx >= 0) c.getString(idx) ?: "" else ""
                } else ""
            } ?: ""
        } catch (se: SecurityException) {
            Log.w(TAG, "CallLog read denied — READ_CALL_LOG not granted: ${se.message}")
            ""
        } catch (e: Throwable) {
            Log.w(TAG, "CallLog read failed: ${e.message}")
            ""
        }
    }

    private fun safeCapacitor(block: () -> Unit) {
        try { block() } catch (e: Throwable) { Log.w(TAG, "capacitor emit failed: ${e.message}") }
    }

    /** Fire intra-app broadcast → MainActivity → window.onLeadCRMCallEvent */
    private fun sendCallEvent(
        ctx: Context,
        event: String,
        number: String,
        missed: Boolean,
        durationSec: Long
    ) {
        try {
            val i = Intent(ACTION_CALL_EVENT).apply {
                setPackage(ctx.packageName)
                putExtra("event", event)
                putExtra("number", number)
                putExtra("missed", missed)
                putExtra("duration_s", durationSec)
                putExtra("ts", System.currentTimeMillis())
            }
            ctx.sendBroadcast(i)
        } catch (e: Throwable) {
            Log.e(TAG, "sendCallEvent failed: ${e.message}")
        }
    }

    /**
     * Path 3 — fire-and-forget HTTP POST. Read creds from
     * SharedPreferences (MainActivity.saveCallEventCreds() writes
     * them on app boot) and POST {phone, direction, event, ...} to
     * /api/call_event_native. The server resolves the tenant from
     * the token and persists exactly like api_call_logEvent.
     */
    private fun postNativeAsync(
        ctx: Context,
        event: String,
        number: String,
        direction: String,
        missed: Boolean,
        durationSec: Long
    ) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val base = prefs.getString(KEY_API_BASE, null)?.trimEnd('/')
        val tok  = prefs.getString(KEY_TOKEN, null)
        if (base.isNullOrEmpty() || tok.isNullOrEmpty()) {
            Log.w(TAG, "postNativeAsync skipped — no creds (base=${base != null}, tok=${tok != null})")
            return
        }
        Thread {
            try {
                val url = URL("$base/api/call_event_native")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5000
                    readTimeout = 8000
                    doInput = true
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("x-auth-token", tok)
                    setRequestProperty("Accept", "application/json")
                }
                val body = JSONObject().apply {
                    put("phone", number)
                    put("direction", direction)
                    put("event", event)
                    put("missed", missed)
                    put("duration_s", durationSec)
                }.toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val resp = stream?.bufferedReader()?.use { it.readText() } ?: ""
                Log.i(TAG, "POST /api/call_event_native → $code phone='$number' | $resp")

                if (event == "incoming_ringing" && code in 200..299 && resp.isNotEmpty()) {
                    try {
                        val root = JSONObject(resp)
                        val lookup = root.optJSONObject("lookup")
                        if (lookup != null && lookup.optBoolean("match", false)) {
                            buildRichNotification(ctx, number, lookup)
                        }
                    } catch (e: Throwable) {
                        Log.w(TAG, "rich notif parse failed: ${e.message}")
                    }
                }
            } catch (e: Throwable) {
                Log.e(TAG, "postNativeAsync failed: ${e.message}")
            }
        }.start()
    }

    /**
     * REC_POSTCALL_BG_SYNC_v1 — enqueue a one-shot background recording
     * sync 30 seconds after a call ends. The OEM dialer typically takes
     * 5-20 seconds to flush the .m4a file to disk after the call hangs
     * up; 30s is a safe margin. Uses ExpeditedWorkRequest where possible
     * so the system runs it in seconds (Doze-exempt) instead of queueing
     * for the next periodic window. Falls back to a normal one-time
     * request if the expedited quota is exhausted.
     *
     * Survives WebView death — runs purely in the native side. The
     * worker already lives in RecordingsBackgroundSyncWorker.kt and
     * reads its creds (rec_bg_base_url + rec_bg_token + rec_folder_uri)
     * from SharedPreferences, written on every SPA login.
     */
    private fun enqueueRecordingBgSync(ctx: Context, reason: String) {
        try {
            val req = OneTimeWorkRequest.Builder(RecordingsBackgroundSyncWorker::class.java)
                .setInitialDelay(30, TimeUnit.SECONDS)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .addTag("rec-bg-sync-postcall")
                .addTag(reason)
                .build()
            WorkManager.getInstance(ctx).enqueue(req)
            Log.i(TAG, "enqueued recording bg-sync ($reason) — runs in ~30s")
        } catch (e: Throwable) {
            Log.w(TAG, "enqueueRecordingBgSync failed: ${e.message}")
        }
    }

    private fun buildRichNotification(ctx: Context, phone: String, lookup: JSONObject) {
        try {
            val name = lookup.optString("name", "").ifEmpty { phone }
            val kind = lookup.optString("kind", "lead")
            val status = lookup.optString("status", "")
            val ownerName = lookup.optString("assigned_name", "")
            val value = lookup.optLong("value", 0L)
            val lifetimeValue = lookup.optLong("lifetime_value", 0L)
            val lastCallAt = lookup.optString("last_call_at", "")
            val lastCallDurationS = lookup.optLong("last_call_duration_s", 0L)
            val nextFollowupAt = lookup.optString("next_followup_at", "")

            val title = if (kind == "customer") {
                "📞 " + name + (if (status.isNotEmpty()) " · " + status else "")
            } else {
                "📞 " + name + (if (status.isNotEmpty()) " · " + status else "")
            }

            val lines = mutableListOf<String>()
            lines.add(phone)
            if (ownerName.isNotEmpty()) lines.add("Owner: $ownerName")
            if (kind == "customer") {
                if (lifetimeValue > 0L) lines.add("LTV: ₹" + lifetimeValue)
            } else {
                if (value > 0L) lines.add("Value: ₹" + value)
            }
            if (lastCallAt.isNotEmpty()) {
                val mins = if (lastCallDurationS > 0) " (" + (lastCallDurationS / 60) + "m " + (lastCallDurationS % 60) + "s)" else ""
                val dateOnly = lastCallAt.substring(0, kotlin.math.min(10, lastCallAt.length))
                lines.add("Last call: $dateOnly$mins")
            }
            if (nextFollowupAt.isNotEmpty()) {
                val dateOnly = nextFollowupAt.substring(0, kotlin.math.min(10, nextFollowupAt.length))
                lines.add("Next FU: $dateOnly")
            }

            val lastRemark = lookup.optJSONObject("last_remark")
            if (lastRemark != null) {
                val txt = lastRemark.optString("remark", "")
                if (txt.isNotEmpty()) {
                    lines.add("")
                    lines.add("📝 Last note:")
                    lines.add(txt.take(220))
                }
            } else {
                val recent = lookup.optJSONArray("recent_remarks")
                if (recent != null && recent.length() > 0) {
                    lines.add("")
                    lines.add("Recent notes:")
                    for (i in 0 until kotlin.math.min(2, recent.length())) {
                        val r = recent.optJSONObject(i)
                        val txt = r?.optString("remark", "") ?: ""
                        if (txt.isNotEmpty()) lines.add("• " + txt.take(140))
                    }
                }
            }

            val body = lines.joinToString("\n")
            val deeplink = lookup.optString("url", "/")

            android.os.Handler(ctx.mainLooper).post {
                try { NotificationHelper.showRich(ctx, title, body, deeplink) }
                catch (e: Throwable) { Log.e(TAG, "showRich failed: ${e.message}") }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "buildRichNotification failed: ${e.message}")
        }
    }
}
