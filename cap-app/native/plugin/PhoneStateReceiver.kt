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
            } catch (e: Throwable) {
                Log.e(TAG, "postNativeAsync failed: ${e.message}")
            }
        }.start()
    }
}
