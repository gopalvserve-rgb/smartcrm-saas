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
        private const val CHANNEL_ID = "leadcrm_call_tracking_v3"  // FG_SVC_v3: bumped to DEFAULT importance (silent via setSilent)   // FG_SVC_v2: v2 forces fresh LOW channel on existing installs
        private const val OLD_CHANNEL_ID = "leadcrm_call_tracking"
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

    // FG_SVC_v2: when user swipes the app from Recents, Android calls this.
    // We restart ourselves with a delayed PendingIntent so we come back ~2s
    // later — this is the standard "don't die on swipe" pattern.
    override fun onTaskRemoved(rootIntent: Intent?) {
        try {
            val restart = android.app.PendingIntent.getService(
                this, 1,
                Intent(applicationContext, CallTrackingForegroundService::class.java),
                android.app.PendingIntent.FLAG_ONE_SHOT or android.app.PendingIntent.FLAG_IMMUTABLE
            )
            val alarm = getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
            alarm.set(android.app.AlarmManager.ELAPSED_REALTIME, android.os.SystemClock.elapsedRealtime() + 2_000L, restart)
            Log.d(TAG, "task removed → service self-restart scheduled in 2s")
        } catch (e: Exception) {
            Log.w(TAG, "self-restart schedule failed: ${e.message}")
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        Log.d(TAG, "foreground service stopped")
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // FG_SVC_v2: clean up the obsolete v1 MIN channel so Settings doesn't
        // show two "Call tracking" entries side by side.
        try {
            if (nm.getNotificationChannel(OLD_CHANNEL_ID) != null) {
                nm.deleteNotificationChannel(OLD_CHANNEL_ID)
            }
        } catch (e: Exception) { /* ignore */ }
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        // FG_SVC_v2: IMPORTANCE_LOW (not MIN) — LOW is still silent + no
        // heads-up + no vibration, but on aggressive OEMs (Vivo, Oppo,
        // Realme) the user CANNOT swipe a LOW foreground-service
        // notification away. MIN was swipeable and the user killed the
        // service by accident.
        val ch = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_DEFAULT  // FG_SVC_v3: DEFAULT not LOW — Vivo still swiped LOW
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
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)  // FG_SVC_v3
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build().apply {
                // FG_SVC_v3: explicit FLAG_NO_CLEAR — some OEMs (Vivo, Realme,
                // OriginOS) still let users swipe even FG-service notifications.
                // FLAG_NO_CLEAR is a stronger signal than setOngoing alone.
                flags = flags or Notification.FLAG_NO_CLEAR or Notification.FLAG_ONGOING_EVENT
            }
    }
}
