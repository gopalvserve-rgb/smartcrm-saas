package app.leadcrm.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * FG_SVC_v1 (2026-05-25) — Always-on foreground service that mirrors Runo's
 * "Call tracking is enabled" persistent notification.
 *
 * WHY: On aggressive OEMs (Vivo, Oppo, Realme, OnePlus) Android kills
 * background WorkManager jobs and BroadcastReceivers as soon as the app
 * is swiped from Recents. A foreground service is the only documented
 * mechanism that keeps the process alive 24/7 so that:
 *   - PhoneStateReceiver fires on every call (existing locked file — untouched)
 *   - RecordingObserver / RecordingsBackgroundSyncWorker scan the SAF
 *     folder and POST new files (existing locked files — untouched)
 *   - FCM push notifications wake the app reliably
 *
 * This file does NOT touch any locked recording-pipeline file. It is a
 * pure ADDITION: spin up a Service with a low-priority ongoing
 * notification, otherwise sit silent.
 *
 * The notification:
 *   - silent channel (IMPORTANCE_MIN) → no sound, no vibration, no heads-up
 *   - setOngoing(true)               → cannot be swiped away
 *   - tap                            → opens MainActivity
 *
 * For Android 14 (targetSdk 34) we declare foregroundServiceType=dataSync
 * in the manifest and pass it to startForeground().
 */
class CallTrackingForegroundService : Service() {

    companion object {
        private const val TAG = "LeadCRM/FgSvc"
        private const val CHANNEL_ID = "leadcrm_call_tracking"
        private const val CHANNEL_NAME = "Call tracking"
        private const val NOTIF_ID = 8801

        /** Idempotent — calling this multiple times is fine. */
        @JvmStatic
        fun start(ctx: Context) {
            try {
                val i = Intent(ctx, CallTrackingForegroundService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    ctx.startForegroundService(i)
                } else {
                    ctx.startService(i)
                }
            } catch (e: Exception) {
                Log.e(TAG, "start() failed: ${e.message}", e)
            }
        }

        @JvmStatic
        fun stop(ctx: Context) {
            try {
                ctx.stopService(Intent(ctx, CallTrackingForegroundService::class.java))
            } catch (e: Exception) {
                Log.e(TAG, "stop() failed: ${e.message}", e)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        val notif = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIF_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NOTIF_ID, notif)
            }
            Log.d(TAG, "foreground service started")
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed: ${e.message}", e)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.d(TAG, "foreground service stopped")
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_MIN
        ).apply {
            description = "Keeps SmartCRM running so calls and recordings sync reliably."
            setShowBadge(false)
            setSound(null, null)
            enableVibration(false)
            enableLights(false)
            lockscreenVisibility = Notification.VISIBILITY_SECRET
        }
        nm.createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pi = PendingIntent.getActivity(this, 0, tapIntent, pendingFlags)

        val smallIcon = try {
            resources.getIdentifier("ic_stat_notify", "drawable", packageName).takeIf { it != 0 }
                ?: resources.getIdentifier("ic_launcher", "mipmap", packageName).takeIf { it != 0 }
                ?: android.R.drawable.stat_sys_data_bluetooth
        } catch (e: Exception) {
            android.R.drawable.stat_sys_data_bluetooth
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SmartCRM")
            .setContentText("Call tracking is enabled")
            .setSmallIcon(smallIcon)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build()
    }
}
