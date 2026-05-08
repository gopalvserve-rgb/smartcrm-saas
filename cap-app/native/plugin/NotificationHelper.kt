package app.leadcrm.mobile

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Builds + posts the caller-ID notification.
 *
 * Two render modes:
 *   showMinimal()  : called the instant the phone rings (no network).
 *                    Just shows the phone number — guarantees the rep
 *                    sees SOMETHING even if the API is slow / offline.
 *   showRich()     : called by JS after /api/calls/lookup resolves with
 *                    the lead's name, status, value, etc. Replaces the
 *                    minimal one (same notification id).
 */
object NotificationHelper {

    @Suppress("MissingPermission")
    fun showMinimal(ctx: Context, phone: String) {
        val pendingIntent = PendingIntent.getActivity(
            ctx, 0,
            Intent(ctx, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                action = Intent.ACTION_VIEW
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(ctx, CallerIdPlugin.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle("📞 Incoming call")
            .setContentText(phone)
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "$phone\n\nLooking up in your CRM…"
            ))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(false)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .build()
        try { NotificationManagerCompat.from(ctx).notify(CallerIdPlugin.NOTIFICATION_ID, n) }
        catch (_: SecurityException) { /* user revoked POST_NOTIFICATIONS */ }
    }

    @Suppress("MissingPermission")
    fun showRich(ctx: Context, title: String, body: String, deeplink: String) {
        val openIntent = Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            action = Intent.ACTION_VIEW
            // The native MainActivity reads this extra and navigates the
            // wrapped web view to the deeplink target after load.
            putExtra("deeplink", deeplink)
        }
        val pendingIntent = PendingIntent.getActivity(
            ctx, 1, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(ctx, CallerIdPlugin.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setContentTitle(title)
            .setContentText(body.lineSequence().firstOrNull() ?: body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .addAction(
                android.R.drawable.ic_menu_view,
                "Open lead",
                pendingIntent
            )
            .build()
        try { NotificationManagerCompat.from(ctx).notify(CallerIdPlugin.NOTIFICATION_ID, n) }
        catch (_: SecurityException) { }
    }
}
