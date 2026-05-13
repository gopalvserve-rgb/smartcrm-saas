package app.leadcrm.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log

/**
 * Catches the phone-state changes Android broadcasts to all eligible
 * receivers. Forwards them to JS via TWO paths so the bridge is
 * resilient:
 *
 *   1. CallerIdPlugin.instance?.emitRinging(...)   (Capacitor event —
 *      fires ONLY if a JS layer registered CallerId.addListener)
 *   2. ctx.sendBroadcast("app.leadcrm.mobile.CALL_EVENT")   (custom
 *      intent — MainActivity has a BroadcastReceiver for this and
 *      directly calls window.onLeadCRMCallEvent in the WebView)
 *
 * Path #2 is the one the SPA actually consumes today — it has
 * `window.onLeadCRMCallEvent = async (event, number) => { ... }` but
 * no Capacitor listener. Before 2026-05-13 only Path #1 was wired, so
 * the JS handler was never invoked and `api_call_logEvent` never ran.
 *
 * State machine:
 *   IDLE → RINGING        : an inbound call started     → event=incoming_ringing
 *   RINGING → OFFHOOK     : the rep answered            → (no event)
 *   RINGING → IDLE        : the rep didn't answer       → event=call_ended (missed)
 *   OFFHOOK → IDLE        : the call ended              → event=call_ended
 *   IDLE → OFFHOOK        : an outbound dial started    → (no number in this
 *                                                          broadcast)
 *   NEW_OUTGOING_CALL     : captures dialled number     → cached as lastNumber
 */
class PhoneStateReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PhoneStateReceiver"
        private const val ACTION_CALL_EVENT = "app.leadcrm.mobile.CALL_EVENT"
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
                    // Path 1 — Capacitor event (if any listener)
                    try { CallerIdPlugin.instance?.emitRinging(number) } catch (e: Throwable) {
                        Log.w(TAG, "emitRinging failed: ${e.message}")
                    }
                    // Path 2 — Broadcast for MainActivity → WebView bridge
                    sendCallEvent(ctx, "incoming_ringing", number)
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                offhookStartMs = now
                // No emit — JS already saw incoming_ringing; duration
                // surfaces on the IDLE transition below.
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                if (lastState == TelephonyManager.EXTRA_STATE_RINGING) {
                    // RINGING → IDLE without OFFHOOK = missed call
                    Log.i(TAG, "MISSED call from $lastNumber → fire call_ended (missed)")
                    try { CallerIdPlugin.instance?.emitEnded(lastNumber, 0, missed = true) } catch (e: Throwable) {
                        Log.w(TAG, "emitEnded(missed) failed: ${e.message}")
                    }
                    sendCallEvent(ctx, "call_ended", lastNumber, missed = true, durationSec = 0)
                } else if (lastState == TelephonyManager.EXTRA_STATE_OFFHOOK) {
                    val dur = (now - offhookStartMs) / 1000
                    Log.i(TAG, "ENDED call with $lastNumber after ${dur}s → fire call_ended")
                    try { CallerIdPlugin.instance?.emitEnded(lastNumber, dur, missed = false) } catch (e: Throwable) {
                        Log.w(TAG, "emitEnded failed: ${e.message}")
                    }
                    sendCallEvent(ctx, "call_ended", lastNumber, missed = false, durationSec = dur)
                }
                ringStartMs = 0
                offhookStartMs = 0
            }
        }
        lastState = state
    }

    /**
     * Fire the internal broadcast that MainActivity catches and
     * forwards into the WebView's window.onLeadCRMCallEvent(...).
     *
     * setPackage() restricts delivery to our own app — required on
     * Android 14+ for non-exported broadcasts. RECEIVER_NOT_EXPORTED
     * is also enforced on MainActivity's filter for API 33+.
     */
    private fun sendCallEvent(
        ctx: Context,
        event: String,
        number: String,
        missed: Boolean = false,
        durationSec: Long = 0
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
}
