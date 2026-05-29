package app.leadcrm.mobile

/*
 * ============================================================
 * 🔒 LOCKED FILE — Recording & Call Sync Pipeline
 * ============================================================
 * This file is part of the call/recording sync pipeline. It is
 * mission-critical: any change here can stop recordings from
 * reaching the CRM, which is a customer-visible regression.
 *
 * BEFORE editing — read docs/LOCKED_FILES.md and
 * RECORDING_ARCHITECTURE_AND_LOCKDOWN.md (workspace root), then
 * ASK THE USER explicitly before making any change. No
 * "cleanups", no "refactors", no "fixes for unused imports"
 * without approval.
 * ============================================================
 */

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.BufferedReader
import java.io.DataOutputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * REC_BG_SYNC_v1 (2026-05-22) — Background recording sync.
 *
 * Runs every ~15 min (Android WorkManager minimum) AND right after every
 * call (one-shot from PhoneStateReceiver). Scans the user-selected
 * recordings folder for files modified since the last successful sync,
 * uploads each one to /api/recordings as multipart, then advances the
 * watermark in SharedPreferences.
 *
 * Why native (not JS): when Android kills the WebView (~5-15 min idle),
 * the JavaScript FileObserver + post-call rescan logic die with it. The
 * user's recordings then accumulate in the folder unread until they
 * reopen the app. This worker runs even when the WebView is dead —
 * WorkManager is part of androidx.work and survives process death,
 * Doze, and battery optimisation (with constraints relaxed).
 *
 * Stored prefs (set by MainActivity / JS-side):
 *   - rec_folder_uri   : SAF tree Uri of the recordings folder
 *   - rec_bg_base_url  : CRM base URL (e.g. https://crm.smartcrmsolution.com/t/vserve)
 *   - rec_bg_token     : x-auth-token
 *   - rec_bg_last_sync : ms epoch of last successful run (we sweep files modified after this)
 *   - rec_bg_uploaded  : JSON object { "file_uri": ts } to avoid re-uploads
 */
class RecordingsBackgroundSyncWorker(
    context: Context,
    params: WorkerParameters
) : Worker(context, params) {

    companion object {
        private const val TAG = "RecBgSync"
        const val PREFS = "leadcrm_prefs"
        const val KEY_FOLDER_URI = "rec_folder_uri"
        const val KEY_BASE_URL = "rec_bg_base_url"
        const val KEY_TOKEN = "rec_bg_token"
        const val KEY_LAST_SYNC = "rec_bg_last_sync"
        const val KEY_UPLOADED_MAP = "rec_bg_uploaded"
        // Sweep at most 7 days back so a fresh install with a year-old folder
        // doesn't try to upload every recording on the device.
        const val MAX_LOOKBACK_MS = 7L * 24 * 3600 * 1000
        // Skip files older than this (in seconds) since their last-modified —
        // some dialers create the file BEFORE writing data, so we wait until
        // the file has been "settled" for at least 10s before uploading.
        const val MIN_AGE_S = 10
    }

    override fun doWork(): Result {
        val ctx = applicationContext
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val folderUriStr = prefs.getString(KEY_FOLDER_URI, null)
        val baseUrl = prefs.getString(KEY_BASE_URL, null)
        val token = prefs.getString(KEY_TOKEN, null)
        // REC_DIAG_PING_v1 — always ping at the start, even before we know if
        // we can do useful work. This is THE diagnostic that tells us "the
        // worker ran" regardless of whether it found anything to upload.
        val trigger = inputData.getString("trigger") ?: tags.firstOrNull { it.startsWith("post-") || it == "rec-bg-sync-periodic" } ?: "unknown"
        pingDiagSafe(baseUrl, token, mapOf(
            "trigger" to trigger,
            "phase" to "start",
            "has_folder" to !folderUriStr.isNullOrEmpty(),
            "has_token" to !token.isNullOrEmpty(),
            "has_base" to !baseUrl.isNullOrEmpty(),
            "apk_version" to "1.7"
        ))
        if (folderUriStr.isNullOrEmpty() || baseUrl.isNullOrEmpty() || token.isNullOrEmpty()) {
            Log.i(TAG, "skip: missing folder/base/token — user hasn't completed setup yet")
            pingDiagSafe(baseUrl, token, mapOf(
                "trigger" to trigger,
                "phase" to "early-exit",
                "has_folder" to !folderUriStr.isNullOrEmpty(),
                "has_token" to !token.isNullOrEmpty(),
                "has_base" to !baseUrl.isNullOrEmpty(),
                "note" to "missing-setup"
            ))
            return Result.success()
        }

        val tree = try { Uri.parse(folderUriStr) } catch (e: Exception) {
            Log.e(TAG, "bad folder uri: ${e.message}")
            return Result.success()
        }
        val dir = DocumentFile.fromTreeUri(ctx, tree)
        if (dir == null || !dir.exists() || !dir.canRead()) {
            // REC_FOLDER_PERSIST_v2 — self-heal. The URI in prefs was either
            // never persistable (v1.8 bug) or its permission was revoked.
            // Clear the prefs entry so the onboarding card flips back to
            // "not done" and the next time the user opens the app they see
            // the "Recording folder needed" banner. Without this clear,
            // checkGranted() keeps lying about ✓ Done forever.
            Log.w(TAG, "folder unreachable — clearing stale prefs so user is re-prompted")
            try {
                prefs.edit().remove(KEY_FOLDER_URI).apply()
            } catch (e: Exception) {
                Log.e(TAG, "failed to clear stale folder uri: ${e.message}")
            }
            pingDiagSafe(baseUrl, token, mapOf(
                "trigger" to trigger,
                "phase" to "early-exit",
                "has_folder" to true,
                "folder_readable" to false,
                "note" to "folder-unreachable-cleared-stale-pref"
            ))
            return Result.success()
        }

        val nowMs = System.currentTimeMillis()
        val storedSince = prefs.getLong(KEY_LAST_SYNC, 0L)
        val floor = nowMs - MAX_LOOKBACK_MS
        val sinceMs = if (storedSince > 0) maxOf(storedSince - 5 * 60_000, floor) else floor

        // Load uploaded-uri map to skip files already done
        val uploadedMap = try {
            JSONObject(prefs.getString(KEY_UPLOADED_MAP, "{}") ?: "{}")
        } catch (_: Exception) { JSONObject() }

        val candidates = ArrayList<DocumentFile>()
        collectAudio(dir, sinceMs, candidates, 0)
        Log.i(TAG, "scan folder=${tree} since=${sinceMs} found ${candidates.size} candidate(s)")

        var newest = storedSince
        var uploaded = 0
        var skipped = 0
        var failed = 0
        for (f in candidates) {
            val uriKey = f.uri.toString()
            if (uploadedMap.has(uriKey)) { skipped++; continue }
            val mod = f.lastModified()
            // Wait at least MIN_AGE_S seconds since file last write to avoid uploading a half-written file.
            if (nowMs - mod < MIN_AGE_S * 1000L) { skipped++; continue }
            val name = (f.name ?: "recording.m4a")
            val phone = extractPhone(name)
            try {
                val ok = uploadOne(ctx, f.uri, name, phone, baseUrl, token)
                if (ok) {
                    uploaded++
                    uploadedMap.put(uriKey, nowMs)
                    if (mod > newest) newest = mod
                } else {
                    failed++
                }
            } catch (e: Exception) {
                Log.e(TAG, "upload error for $name: ${e.message}")
                failed++
            }
        }

        // Persist watermark + uploaded map. We advance watermark to newest
        // SUCCESSFUL upload's mtime, NOT nowMs — that way a failure at
        // T+now doesn't permanently skip a file we couldn't upload.
        val newWatermark = if (uploaded > 0) newest else storedSince
        prefs.edit()
            .putLong(KEY_LAST_SYNC, newWatermark)
            .putString(KEY_UPLOADED_MAP, uploadedMap.toString())
            .apply()

        Log.i(TAG, "done: uploaded=$uploaded skipped=$skipped failed=$failed watermark=$newWatermark")
        pingDiagSafe(baseUrl, token, mapOf(
            "trigger" to trigger,
            "phase" to "done",
            "has_folder" to true,
            "has_token" to true,
            "has_base" to true,
            "folder_readable" to true,
            "file_count" to candidates.size,
            "uploaded" to uploaded,
            "skipped" to skipped,
            "failed" to failed
        ))
        return Result.success()
    }

    /**
     * REC_DIAG_PING_v1 — fire-and-forget POST to /api/rec-diag carrying the
     * worker's current state. Lets us see in Railway logs what the worker
     * is doing without needing adb logcat on the device. Best-effort: any
     * network or JSON error is swallowed so it never breaks the upload flow.
     */
    private fun pingDiagSafe(baseUrl: String?, token: String?, fields: Map<String, Any?>) {
        // We still try when baseUrl is missing — fall back to the SAS host
        // we know is hard-coded (lets us diagnose freshly-installed devices
        // with no creds at all).
        val rawBase = baseUrl?.trimEnd('/')?.takeIf { it.isNotEmpty() }
            ?: "https://crm.smartcrmsolution.com"
        // Strip /t/<slug>/ since /api/rec-diag is tenant-agnostic.
        val baseClean = rawBase.replace(Regex("/t/[^/]+/?$"), "")
        Thread {
            try {
                val url = URL("$baseClean/api/rec-diag")
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 5_000
                    readTimeout = 5_000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    if (!token.isNullOrEmpty()) setRequestProperty("x-auth-token", token)
                }
                val body = JSONObject().apply {
                    fields.forEach { (k, v) -> put(k, v) }
                }.toString()
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                Log.d(TAG, "diag ping → $code")
                conn.disconnect()
            } catch (e: Throwable) {
                Log.w(TAG, "diag ping failed: ${e.message}")
            }
        }.start()
    }

        private fun collectAudio(dir: DocumentFile, sinceMs: Long, out: ArrayList<DocumentFile>, depth: Int) {
        if (depth > 3) return
        val kids = try { dir.listFiles() } catch (_: Exception) { return } ?: return
        for (f in kids) {
            try {
                if (f.isDirectory) { collectAudio(f, sinceMs, out, depth + 1); continue }
                if (!f.isFile) continue
                val name = f.name ?: continue
                if (!isAudio(name)) continue
                if (f.lastModified() < sinceMs) continue
                out.add(f)
            } catch (_: Exception) { /* skip unreadable entries */ }
        }
    }

    private fun isAudio(name: String): Boolean {
        val lower = name.lowercase()
        return lower.endsWith(".m4a") || lower.endsWith(".mp3") || lower.endsWith(".amr") ||
               lower.endsWith(".3gp") || lower.endsWith(".wav") || lower.endsWith(".aac") ||
               lower.endsWith(".ogg") || lower.endsWith(".flac") || lower.endsWith(".opus") ||
               lower.endsWith(".oga") || lower.endsWith(".mp4") || lower.endsWith(".3gpp")
    }

    private fun extractPhone(name: String): String {
        // Grab the longest run of digits (>=7) — typically the phone number.
        // If multiple, prefer the one that looks like a phone (10+ digits or starts with +91 etc.)
        val digits = Regex("[0-9]{7,}").findAll(name).map { it.value }.toList()
        if (digits.isEmpty()) return ""
        return digits.maxByOrNull { it.length } ?: ""
    }

    /**
     * Multipart upload. Matches the MainActivity#LeadCRMBridge#uploadFile
     * scheme exactly so server-side parsing is identical regardless of
     * whether the file came from the foreground bridge or this worker.
     */
    private fun uploadOne(ctx: Context, uri: Uri, name: String, phone: String,
                         baseUrl: String, token: String): Boolean {
        val cr = ctx.contentResolver
        var fname = name
        try {
            cr.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0) {
                        val n = c.getString(ni)
                        if (!n.isNullOrEmpty()) fname = n
                    }
                }
            }
        } catch (_: Exception) {}

        val mime = cr.getType(uri) ?: guessMime(fname)
        val boundary = "----LeadCRMBG" + System.currentTimeMillis()
        val url = URL(baseUrl.replace(Regex("/+$"), "") + "/api/recordings")
        val conn = url.openConnection() as HttpURLConnection
        conn.doOutput = true
        conn.requestMethod = "POST"
        conn.connectTimeout = 15_000
        conn.readTimeout = 180_000
        conn.setRequestProperty("Connection", "Keep-Alive")
        conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
        conn.setRequestProperty("x-auth-token", token)

        val out = DataOutputStream(BufferedOutputStream(conn.outputStream))
        writePart(out, boundary, "phone", phone)
        writePart(out, boundary, "direction", "out")
        writePart(out, boundary, "duration_s", "0")
        writePart(out, boundary, "device_path", uri.toString())
        writePart(out, boundary, "source", "bg_worker")

        out.writeBytes("--$boundary\r\n")
        out.writeBytes("Content-Disposition: form-data; name=\"audio\"; filename=\"$fname\"\r\n")
        out.writeBytes("Content-Type: $mime\r\n\r\n")
        cr.openInputStream(uri)?.use { ins ->
            val buf = ByteArray(8192)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                out.write(buf, 0, n)
            }
        } ?: throw Exception("cannot open input stream")
        out.writeBytes("\r\n")
        out.writeBytes("--$boundary--\r\n")
        out.flush()
        out.close()

        val code = conn.responseCode
        val body = StringBuilder()
        try {
            BufferedReader(InputStreamReader(
                if (code < 400) conn.inputStream else conn.errorStream, "UTF-8"
            )).use { r ->
                while (true) {
                    val line = r.readLine() ?: break
                    body.append(line)
                }
            }
        } catch (_: Exception) {}
        conn.disconnect()
        Log.d(TAG, "bg-upload $fname → $code :: $body")
        return code in 200..299
    }

    private fun writePart(out: DataOutputStream, boundary: String, name: String, value: String) {
        out.writeBytes("--$boundary\r\n")
        out.writeBytes("Content-Disposition: form-data; name=\"$name\"\r\n\r\n")
        out.write(value.toByteArray(Charsets.UTF_8))
        out.writeBytes("\r\n")
    }

    private fun guessMime(name: String): String {
        val l = name.lowercase()
        return when {
            l.endsWith(".m4a") || l.endsWith(".mp4") -> "audio/mp4"
            l.endsWith(".mp3") -> "audio/mpeg"
            l.endsWith(".amr") -> "audio/amr"
            l.endsWith(".3gp") || l.endsWith(".3gpp") -> "audio/3gpp"
            l.endsWith(".wav") -> "audio/wav"
            l.endsWith(".aac") -> "audio/aac"
            l.endsWith(".ogg") || l.endsWith(".oga") -> "audio/ogg"
            l.endsWith(".flac") -> "audio/flac"
            l.endsWith(".opus") -> "audio/opus"
            else -> "application/octet-stream"
        }
    }
}
