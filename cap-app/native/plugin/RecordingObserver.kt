package app.leadcrm.mobile

import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.FileObserver
import android.util.Log
import com.getcapacitor.JSObject
import java.io.File

/**
 * Watches the directory where the user's stock dialer drops .m4a / .amr
 * call recordings. The instant a new file appears (CLOSE_WRITE), bubble
 * the path up to JS, which uploads the bytes via /api/recordings with
 * the lead_id from the most recent matching call_event.
 *
 * Android 10+ blocks third-party apps from RECORDING calls (without
 * being the default dialer) — but reading recordings the user's stock
 * dialer / OEM dialer creates is allowed. We rely on the OEM having
 * call recording enabled (most Indian OEMs — MIUI, Realme UI, ColorOS,
 * One UI — do).
 *
 * Watched paths (try in order, first that exists wins):
 *   /sdcard/Recordings/Call/                — Pixel
 *   /sdcard/MIUI/sound_recorder/call_rec/   — Xiaomi (older MIUI)
 *   /sdcard/Recordings/Calls/               — newer Xiaomi/Redmi
 *   /sdcard/PhoneRecord/                    — Realme / Oppo / OnePlus
 *   /sdcard/CallRecordings/                 — Vivo, generic
 *   /sdcard/Music/Recordings/Call/          — fallback
 */
object RecordingObserver {
    private const val TAG = "RecordingObserver"
    private val candidatePaths = listOf(
        "Recordings/Call",
        "MIUI/sound_recorder/call_rec",
        "Recordings/Calls",
        "PhoneRecord",
        "CallRecordings",
        "Music/Recordings/Call"
    )

    private var observer: FileObserver? = null
    private var watchedPath: String? = null

    fun startIfPossible(ctx: Context): RecordingObserver? {
        val external = Environment.getExternalStorageDirectory()
        val target = candidatePaths.map { File(external, it) }.firstOrNull { it.exists() && it.isDirectory }
        if (target == null) {
            Log.w(TAG, "No call-recording folder found — observer not started")
            return null
        }
        watchedPath = target.absolutePath
        observer = createObserver(target)
        observer?.startWatching()
        Log.i(TAG, "Watching $watchedPath for new call recordings")
        return this
    }

    fun stopWatching() {
        observer?.stopWatching()
        observer = null
        watchedPath = null
    }

    private fun createObserver(dir: File): FileObserver {
        val mask = FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            object : FileObserver(dir, mask) {
                override fun onEvent(event: Int, path: String?) { handle(dir, path) }
            }
        } else {
            @Suppress("DEPRECATION")
            object : FileObserver(dir.absolutePath, mask) {
                override fun onEvent(event: Int, path: String?) { handle(dir, path) }
            }
        }
    }

    private fun handle(dir: File, name: String?) {
        if (name.isNullOrEmpty()) return
        if (!isAudioFile(name)) return
        val abs = File(dir, name).absolutePath
        Log.i(TAG, "New recording detected: $abs")
        val data = JSObject()
        data.put("path", abs)
        data.put("name", name)
        data.put("ts", System.currentTimeMillis())
        // Fan out to JS, which has the rep's auth token + most-recent-call
        // metadata to associate the file with the right lead.
        CallerIdPlugin.instance?.notifyListeners("recordingAvailable", data)
    }

    private fun isAudioFile(name: String): Boolean {
        val lower = name.lowercase()
        return lower.endsWith(".m4a") || lower.endsWith(".mp3") ||
               lower.endsWith(".amr") || lower.endsWith(".3gp") ||
               lower.endsWith(".wav") || lower.endsWith(".aac") ||
               lower.endsWith(".ogg")
    }
}
