package app.leadcrm.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * FG_SVC_v2 (2026-05-25) — Start the CallTrackingForegroundService on
 * device boot. Without this, after a phone reboot the FG service is
 * dead until the user opens the CRM app — meaning call tracking and
 * recording sync silently break overnight.
 *
 * RECEIVE_BOOT_COMPLETED permission is already in the manifest.
 * Registered in AndroidManifest as a receiver for BOOT_COMPLETED.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action == Intent.ACTION_BOOT_COMPLETED ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "com.htc.intent.action.QUICKBOOT_POWERON") {
            try {
                CallTrackingForegroundService.start(context.applicationContext)
                Log.d("LeadCRM/Boot", "FG service started on boot")
            } catch (e: Exception) {
                Log.e("LeadCRM/Boot", "failed to start service on boot: ${e.message}")
            }
        }
    }
}
