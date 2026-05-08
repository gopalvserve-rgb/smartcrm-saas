package app.leadcrm.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log

/**
 * Catches the phone-state changes Android broadcasts to all eligible
 * receivers. Forwards them to CallerIdPlugin which bridges to JS.
 *
 * State machine:
 *   IDLE → RINGING        : an inbound call started
 *   RINGING → OFFHOOK     : the rep answered (call connected)
 *   RINGING → IDLE        : the rep didn't answer = MISSED CALL
 *   OFFHOOK → IDLE        : the call ended (we know duration from this)
 *   IDLE → OFFHOOK        : an outbound dial started (no number in this
 *                           broadcast — captured separately via
 *                           NEW_OUTGOING_CALL action)
 *
 * NEW_OUTGOING_CALL is deprecated on API 29+ but the kernel still
 * delivers it on all current devices we care about. If Google ever
 * actually removes it, we fall back to InCallService.
 */
class PhoneStateReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PhoneStateReceiver"
        private var lastState: String = TelephonyManager.EXTRA_STATE_IDLE
        private var lastNumber: String = ""
        private var ringStartMs: Long = 0
        private var offhookStartMs: Long = 0
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        val action = intent.action ?: return

        if (action == "android.intent.action.NEW_OUTGOING_CALL") {
            // Outbound dial — capture the dialled number for later
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
                    Log.i(TAG, "RINGING from $number")
                    CallerIdPlugin.instance?.emitRinging(number)
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                offhookStartMs = now
                // No emit — the JS layer will still see the previous
                // 'callRinging' event. We surface duration on IDLE.
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                if (lastState == TelephonyManager.EXTRA_STATE_RINGING) {
                    // RINGING → IDLE without OFFHOOK = missed call
                    Log.i(TAG, "MISSED call from $lastNumber")
                    CallerIdPlugin.instance?.emitEnded(lastNumber, 0, missed = true)
                } else if (lastState == TelephonyManager.EXTRA_STATE_OFFHOOK) {
                    val dur = (now - offhookStartMs) / 1000
                    Log.i(TAG, "ENDED call with $lastNumber after ${dur}s")
                    CallerIdPlugin.instance?.emitEnded(lastNumber, dur, missed = false)
                }
                ringStartMs = 0
                offhookStartMs = 0
            }
        }
        lastState = state
    }
}
