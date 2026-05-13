package app.leadcrm.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Three-path call-event bridge so the chain doesn't break in any
 * device/app state:
 *
 *   1. CallerIdPlugin.instance?.emitRinging(...)  (Capacitor event —
 *      fires ONLY if JS calls CallerId.addListener)
 *   2. ctx.sendBroadcast("…CALL_EVENT")          (intra-app intent —
 *      MainActivity's receiver pushes into the WebView via
 *      evaluateJavascript("window.onLeadCRMCallEvent(…)"))
 *   3. HTTP POST to ${apiBase}/api/call_event_native with the saved
 *      auth token                                  (no WebView/JS
 *      dependency — works even if the app is fully killed)
 *
 * Path 3 is what the SPA's `api_call_logEvent` does, but bypasses the
 * round-trip through the WebView. The server endpoint resolves the
 * tenant from the token and runs the same logic, so an incoming call
 * lands in CRM in well under a second regardless of app state.
 *
 * SharedPreferences keys (set by JS on login / app boot):
 *   "api_base"     — e.g. "https://crm.example.com" (NO trailing slash, NO /t/<slug>)
 *   "auth_token"   — the JWT
 *
 * If either key is missing the HTTP path is a silent no-op; paths 1
 * and 2 still try to fire so the previous WebView-bridge fix still
 * works for foregrounded apps with a fresh login.
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
        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: lastNumber
        val now = System.currentTimeMillis()

        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                ringStartMs = now
                lastNumber = number
                if (number.isNotEmpty()) {
                    Log.i(TAG, "RINGING from $number → fire incoming_ringing")
                    safeCapacitor { CallerIdPlugin.instance?.emitRinging(number) }
                    sendCallEvent(ctx, "incoming_ringing", number, missed = false, durationSec = 0)
                    postNativeAsync(ctx, "incoming_ringing", number, direction = "in", missed = false, durationSec = 0)
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                offhookStartMs = now
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                if (lastState == TelephonyManager.EXTRA_STATE_RINGING) {
                    // RINGING → IDLE without OFFHOOK = missed call
                    Log.i(TAG, "MISSED call from $lastNumber → fire call_ended (missed)")
                    safeCapacitor { CallerIdPlugin.instance?.emitEnded(lastNumber, 0, missed = true) }
                    sendCallEvent(ctx, "call_ended", lastNumber, missed = true, durationSec = 0)
                    postNativeAsync(ctx, "call_ended", lastNumber, direction = "missed", missed = true, durationSec = 0)
                } else if (lastState == TelephonyManager.EXTRA_STATE_OFFHOOK) {
                    val dur = (now - offhookStartMs) / 1000
                    Log.i(TAG, "ENDED call with $lastNumber after ${dur}s → fire call_ended")
                    safeCapacitor { CallerIdPlugin.instance?.emitEnded(lastNumber, dur, missed = false) }
                    sendCallEvent(ctx, "call_ended", lastNumber, missed = false, durationSec = dur)
                    // direction unknown at this layer — outbound calls flow through here too.
                    // Fall back to 'in' for inbound completed (we know last RINGING happened
                    // because OFFHOOK can only come after RINGING for inbound) — but to be
                    // safe leave as null so the server's default kicks in.
                    postNativeAsync(ctx, "call_ended", lastNumber, direction = "in", missed = false, durationSec = dur)
                }
                ringStartMs = 0
                offhookStartMs = 0
            }
        }
        lastState = state
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
        // Network I/O off the main thread. Use a plain Thread — no
        // need for a queue, this fires a handful of times per call.
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
                Log.i(TAG, "POST /api/call_event_native → $code | $resp")

                // On a successful RINGING call, parse the lead context out of
                // the response and fire a HEADS-UP notification so the rep
                // sees the lead name + last note while their phone is still
                // ringing. Notifications draw OVER the native dialer screen,
                // unlike the WebView's in-app overlay.
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
     * Build a rich Android notification with the lead's name, status,
     * last call date and the last remark — pulled from the lookup
     * sub-object of /api/call_event_native's response. Android shows
     * this as a heads-up banner over whatever's on screen, including
     * the native dialer.
     */
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
                // Show just the date portion — full ISO is too long
                val dateOnly = lastCallAt.substring(0, kotlin.math.min(10, lastCallAt.length))
                lines.add("Last call: $dateOnly$mins")
            }
            if (nextFollowupAt.isNotEmpty()) {
                val dateOnly = nextFollowupAt.substring(0, kotlin.math.min(10, nextFollowupAt.length))
                lines.add("Next FU: $dateOnly")
            }

            // Last remark — the headline detail the rep needs RIGHT NOW
            val lastRemark = lookup.optJSONObject("last_remark")
            if (lastRemark != null) {
                val txt = lastRemark.optString("remark", "")
                if (txt.isNotEmpty()) {
                    lines.add("")
                    lines.add("📝 Last note:")
                    lines.add(txt.take(220))
                }
            } else {
                // Fall back to recent_remarks if no last_remark
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

            // Hand off to the existing NotificationHelper. Run on main
            // thread because NotificationManagerCompat would prefer it.
            android.os.Handler(ctx.mainLooper).post {
                try { NotificationHelper.showRich(ctx, title, body, deeplink) }
                catch (e: Throwable) { Log.e(TAG, "showRich failed: ${e.message}") }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "buildRichNotification failed: ${e.message}")
        }
    }
}
