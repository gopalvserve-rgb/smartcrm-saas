// build-stamp: 2026-05-11 v1.2 — APK refresh to ship MANAGE_EXTERNAL_STORAGE + auto-prompt flow
package app.leadcrm.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.telephony.TelephonyManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission

/**
 * CallerIdPlugin — Capacitor bridge between Android phone-state events
 * and the CRM web view.
 *
 *  JS API:
 *     CallerId.start({ apiBase, token })        // begin listening
 *     CallerId.stop()                           // stop listening
 *     CallerId.addListener('callRinging', cb)
 *     CallerId.addListener('callEnded', cb)
 *
 *  When the native side detects phone state changes, it does TWO things:
 *    1. Renders a high-priority notification IMMEDIATELY (no network) so
 *       the rep sees the phone-number ID even on a flaky connection.
 *    2. Notifies the JS layer which calls the CRM /api/calls/lookup
 *       endpoint and re-renders the notification with the rich lead /
 *       customer summary (name, status, value, last remarks).
 *
 *  This double-render means the rep ALWAYS gets a popup the moment the
 *  phone rings, even if the lookup is slow or offline.
 */
@CapacitorPlugin(
    name = "CallerId",
    permissions = [
        Permission(strings = [Manifest.permission.READ_PHONE_STATE], alias = "phoneState"),
        Permission(strings = [Manifest.permission.READ_CALL_LOG],   alias = "callLog"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
        // Recording sync — needs storage perms. Android 13+ uses
        // READ_MEDIA_AUDIO; older versions use READ_EXTERNAL_STORAGE.
        Permission(
            strings = [
                Manifest.permission.READ_MEDIA_AUDIO,
                Manifest.permission.READ_EXTERNAL_STORAGE
            ],
            alias = "mediaAudio"
        )
    ]
)
class CallerIdPlugin : Plugin() {

    private var receiver: PhoneStateReceiver? = null
    private var recordingObserver: RecordingObserver? = null

    companion object {
        const val CHANNEL_ID  = "callerid_channel"
        const val NOTIFICATION_ID = 7401
        var instance: CallerIdPlugin? = null
    }

    override fun load() {
        super.load()
        instance = this
        ensureNotificationChannel()
    }

    // Public wrapper so sibling classes (RecordingObserver,
    // PhoneStateReceiver) can fire JS events. notifyListeners is
    // protected on Plugin so we have to expose it explicitly.
    fun fire(event: String, data: JSObject) {
        notifyListeners(event, data)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        val needed = mutableListOf<String>()
        val ctx = context
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            needed.add("phoneState")
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed.add("notifications")
        }
        // Recording observer needs audio-file read access. On Android 13+
        // ask for READ_MEDIA_AUDIO; older versions use READ_EXTERNAL_STORAGE.
        val storagePerm = if (Build.VERSION.SDK_INT >= 33)
            Manifest.permission.READ_MEDIA_AUDIO
        else
            Manifest.permission.READ_EXTERNAL_STORAGE
        if (ContextCompat.checkSelfPermission(ctx, storagePerm) != PackageManager.PERMISSION_GRANTED) {
            needed.add("mediaAudio")
        }
        if (needed.isNotEmpty()) {
            requestPermissionForAliases(needed.toTypedArray(), call, "permissionCallback")
            return
        }
        beginListening()
        val ret = JSObject(); ret.put("ok", true); ret.put("listening", true)
        ret.put("phoneState", true)
        ret.put("notifications", true)
        ret.put("mediaAudio", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        endListening()
        val ret = JSObject(); ret.put("ok", true); ret.put("listening", false)
        call.resolve(ret)
    }

    /**
     * Returns whether the user has granted MANAGE_EXTERNAL_STORAGE
     * ("All files access"). Required on Android 11+ to read OEM call-
     * recording folders (Samsung Recordings/Call, Xiaomi MIUI/..., etc.)
     * because they live in scoped storage owned by the stock dialer.
     */
    /**
     * Scan the watched call-recordings folder for audio files modified in
     * the last maxAgeMs milliseconds. Returns an array of absolute paths
     * newest-first so JS can compare against its uploaded-paths set and
     * upload anything new. Used by the post-call auto-sync rescan flow.
     */
    @PluginMethod
    fun scanRecentRecordings(call: PluginCall) {
        val maxAge = call.getString("maxAgeMs")?.toLongOrNull() ?: 300_000L
        val files = RecordingObserver.scanRecent(context, maxAge)
        val arr = JSArray()
        files.forEach { arr.put(it) }
        val ret = JSObject()
        ret.put("files", arr)
        ret.put("count", files.size)
        call.resolve(ret)
    }

    @PluginMethod
    fun hasAllFilesAccess(call: PluginCall) {
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            Environment.isExternalStorageManager()
        else
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
        val ret = JSObject(); ret.put("granted", granted); call.resolve(ret)
    }

    /**
     * Opens the system Settings screen where the user can toggle
     * "All files access" for our app. Required because MANAGE_EXTERNAL_STORAGE
     * cannot be granted via the normal runtime permission dialog — it's a
     * special-purpose setting users must enable manually.
     */
    @PluginMethod
    fun requestAllFilesAccess(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // Pre-Android 11: use the normal runtime permission flow.
            val ret = JSObject(); ret.put("ok", true); ret.put("opened_settings", false); call.resolve(ret); return
        }
        if (Environment.isExternalStorageManager()) {
            val ret = JSObject(); ret.put("ok", true); ret.put("already_granted", true); call.resolve(ret); return
        }
        try {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
            intent.data = Uri.parse("package:" + context.packageName)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (e: Exception) {
            // Fallback to the global all-files-access screen if the per-app one isn't available.
            try {
                val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (e2: Exception) {
                call.reject("Could not open settings: " + e2.message)
                return
            }
        }
        val ret = JSObject(); ret.put("ok", true); ret.put("opened_settings", true); call.resolve(ret)
    }

        @com.getcapacitor.annotation.PermissionCallback
    private fun permissionCallback(call: PluginCall) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED
        if (granted) beginListening()
        val ret = JSObject(); ret.put("ok", granted); ret.put("listening", granted)
        call.resolve(ret)
    }

    /**
     * Native → JS bridge. Called from PhoneStateReceiver when the phone
     * starts ringing. JS responds by calling /api/calls/lookup and
     * either updating the notification with rich data or leaving the
     * minimal "phone number" popup if the lookup fails.
     */
    fun emitRinging(phone: String) {
        val data = JSObject()
        data.put("phone", phone)
        data.put("ts", System.currentTimeMillis())
        notifyListeners("callRinging", data)
        // Render a minimal notification immediately. The JS layer will
        // overwrite this with rich content once /api/calls/lookup returns.
        NotificationHelper.showMinimal(context, phone)
    }

    fun emitEnded(phone: String, durationSec: Long, missed: Boolean) {
        val data = JSObject()
        data.put("phone", phone)
        data.put("duration_s", durationSec)
        data.put("direction", if (missed) "missed" else "in")
        data.put("ts", System.currentTimeMillis())
        notifyListeners("callEnded", data)
    }

    /**
     * JS calls this AFTER /api/calls/lookup resolves to overwrite the
     * minimal notification with the rich lead/customer card.
     */
    @PluginMethod
    fun showLeadNotification(call: PluginCall) {
        val title = call.getString("title") ?: "Incoming call"
        val body  = call.getString("body")  ?: ""
        val deeplink = call.getString("deeplink") ?: "/"
        NotificationHelper.showRich(context, title, body, deeplink)
        call.resolve()
    }

    private fun beginListening() {
        if (receiver != null) return
        val r = PhoneStateReceiver()
        val filter = IntentFilter().apply {
            addAction(TelephonyManager.ACTION_PHONE_STATE_CHANGED)
            addAction("android.intent.action.NEW_OUTGOING_CALL")
        }
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(r, filter, Context.RECEIVER_EXPORTED)
        } else {
            context.registerReceiver(r, filter)
        }
        receiver = r
        // Start watching the recordings folder so freshly-finished call
        // recordings auto-upload to the CRM with the matching lead_id.
        // On Android 11+ this needs MANAGE_EXTERNAL_STORAGE ("All files access")
        // because OEM dialer folders are in scoped storage. We start it
        // optimistically; if the grant isn't there, the observer's exists()
        // check will silently return null and we emit a needsAllFilesAccess
        // event so the JS layer can render a "tap to enable" banner.
        val hasAccess = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
            Environment.isExternalStorageManager()
        else
            true
        if (!hasAccess) {
            val data = JSObject()
            data.put("reason", "MANAGE_EXTERNAL_STORAGE not granted")
            notifyListeners("needsAllFilesAccess", data)
        }
        recordingObserver = RecordingObserver.startIfPossible(context)
    }

    private fun endListening() {
        receiver?.let { try { context.unregisterReceiver(it) } catch (_: Exception) {} }
        receiver = null
        recordingObserver?.stopWatching()
        recordingObserver = null
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID, "Caller ID",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Shows the matching lead/customer when a call comes in"
            enableVibration(true)
            setShowBadge(false)
        }
        mgr.createNotificationChannel(ch)
    }
}
