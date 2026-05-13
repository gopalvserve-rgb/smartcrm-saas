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

    /**
     * One-shot scan of the watched folder: returns absolute paths of audio
     * files modified within the last maxAgeMs milliseconds, newest first.
     * Used by the JS post-call rescan logic to catch recordings that landed
     * after the WebView was killed by Android (FileObserver fires to a dead
     * listener in that case; this scan recovers them when JS comes back).
     */
    fun scanRecent(ctx: Context, maxAgeMs: Long): List<String> {
        val dir = resolveDir()
        if (dir == null || !dir.isDirectory) return emptyList()
        val cutoff = System.currentTimeMillis() - maxAgeMs
        return dir.listFiles { f ->
            f.isFile && isAudioFile(f.name) && f.lastModified() >= cutoff
        }?.sortedByDescending { it.lastModified() }
         ?.map { it.absolutePath }
         ?: emptyList()
    }

    /** Resolve the watched folder even if startIfPossible hasn't run yet. */
    fun resolveDir(): File? {
        val external = Environment.getExternalStorageDirectory()
        return candidatePaths.map { File(external, it) }
            .firstOrNull { it.exists() && it.isDirectory }
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
        CallerIdPlugin.instance?.fire("recordingAvailable", data)
    }

    private fun isAudioFile(name: String): Boolean {
        // Different phone brands record in different containers. Cover all
        // the common ones — server side handles the MIME mapping per ext.
        val lower = name.lowercase()
        return lower.endsWith(".m4a")  || lower.endsWith(".mp3")  ||
               lower.endsWith(".amr")  || lower.endsWith(".3gp")  ||
               lower.endsWith(".wav")  || lower.endsWith(".aac")  ||
               lower.endsWith(".ogg")  || lower.endsWith(".flac") ||
               lower.endsWith(".opus") || lower.endsWith(".oga")  ||
               lower.endsWith(".mp4")  || lower.endsWith(".3gpp")
    }
}
