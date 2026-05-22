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
        private var ringStartMs: Long = 0
        private var offhookStartMs: Long = 0
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action == "android.intent.action.NEW_OUTGOING_CALL") {
            val n = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER) ?: ""
            if (n.isNotEmpty()) lastNumber = n
            return
        }

        if (action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        // EXTRA_INCOMING_NUMBER returns null on Android 10+ — see class doc.
        var number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: ""
        if (number.isEmpty()) number = lastNumber
        val now = System.currentTimeMillis()

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                ringStartMs = now
                // Try the call log too (often empty at RINGING but cheap to try)
                if (number.isEmpty()) {
                    val fromLog = readLastCallLogNumber(ctx, sinceMs = now - 15_000L)
                    if (fromLog.isNotEmpty()) number = fromLog
                }
                lastNumber = number
                if (number.isNotEmpty()) {
                    Log.i(TAG, "RINGING from $number → fire incoming_ringing")
                    safeCapacitor { CallerIdPlugin.instance?.emitRinging(number) }
                    sendCallEvent(ctx, "incoming_ringing", number, missed = false, durationSec = 0)
                    postNativeAsync(ctx, "incoming_ringing", number, direction = "in", missed = false, durationSec = 0)
                } else {
                    Log.w(TAG, "RINGING but number unavailable (Android 10+) — will retry at IDLE")
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                offhookStartMs = now
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                // Call has ended — the call log entry is now (or about to be)
                // written. Give it ~700 ms then re-resolve if we still
                // don't have a number.
                if (lastState == TelephonyManager.EXTRA_STATE_RINGING) {
                    // RINGING → IDLE without OFFHOOK = missed call
                    val n0 = lastNumber
                    fireWithDelayedLookup(ctx, n0, now) { resolved ->
                        val finalNumber = if (resolved.isNotEmpty()) resolved else n0
                        Log.i(TAG, "MISSED call from $finalNumber → fire call_ended (missed)")
                        safeCapacitor { CallerIdPlugin.instance?.emitEnded(finalNumber, 0, missed = true) }
                        sendCallEvent(ctx, "call_ended", finalNumber, missed = true, durationSec = 0)
                        postNativeAsync(ctx, "call_ended", finalNumber, direction = "missed", missed = true, durationSec = 0)
                        enqueueRecordingBgSync(ctx, "post-missed-call")
                    }
                } else if (lastState == TelephonyManager.EXTRA_STATE_OFFHOOK) {
                    val dur = (now - offhookStartMs) / 1000
                    val n0 = lastNumber
                    val ringHappened = ringStartMs > 0
                    fireWithDelayedLookup(ctx, n0, now) { resolved ->
                        val finalNumber = if (resolved.isNotEmpty()) resolved else n0
                        Log.i(TAG, "ENDED call with $finalNumber after ${dur}s → fire call_ended")
                        safeCapacitor { CallerIdPlugin.instance?.emitEnded(finalNumber, dur, missed = false) }
                        sendCallEvent(ctx, "call_ended", finalNumber, missed = false, durationSec = dur)
                        // Direction: if we saw RINGING before OFFHOOK it was inbound.
                        // Otherwise the call started via OFFHOOK directly — outbound.
                        val dir = if (ringHappened) "in" else "out"
                        postNativeAsync(ctx, "call_ended", finalNumber, direction = dir, missed = false, durationSec = dur)
                        enqueueRecordingBgSync(ctx, "post-ended-call")
                    }
                }
                ringStartMs = 0
                offhookStartMs = 0
            }
        }
        lastState = state
    }

    /**
     * Helper: if we already have a non-empty number, fire the callback
     * immediately. Otherwise wait ~700 ms (so Android can flush the
     * call log entry) on a worker thread, then query CallLog and
     * invoke the callback with whatever we found.
     */
    private fun fireWithDelayedLookup(
        ctx: Context,
        existingNumber: String,
        eventTimeMs: Long,
        cb: (String) -> Unit
    ) {
        if (existingNumber.isNotEmpty()) {
            cb(existingNumber)
            return
        }
        Thread {
            try { Thread.sleep(700) } catch (_: Throwable) {}
            // Look back ~30 s — the call we just ended started within that window.
            val n = readLastCallLogNumber(ctx, sinceMs = eventTimeMs - 30_000L)
            if (n.isNotEmpty()) {
                Log.i(TAG, "CallLog fallback resolved number: $n")
                lastNumber = n
            } else {
                Log.w(TAG, "CallLog fallback found no entry — phone will be empty")
            }
            cb(n)
        }.start()
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
