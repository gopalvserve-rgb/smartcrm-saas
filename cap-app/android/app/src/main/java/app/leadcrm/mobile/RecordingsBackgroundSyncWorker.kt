package app.leadcrm.mobile

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Environment
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
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * REC_BG_SYNC_v2 / REC_DIRECT_FILE_v1 (2026-05-25) — direct-File scan on
 * known OEM paths, with SAF as fallback.
 *
 * Why this rewrite:
 *   The v1 (SAF-only) worker silently broke a few hours after each app
 *   open. Root cause: DocumentFile.fromTreeUri depends on a per-URI
 *   ContentProvider grant that can lose its connection across
 *   WorkManager process restarts (Doze, app killed by OEM, low-memory
 *   reaper). When that happens canRead() returns false and the user
 *   has to re-pick the folder.
 *
 *   Competitors (Runo, TeleCRM) don't have this bug because they use
 *   direct java.io.File access via MANAGE_EXTERNAL_STORAGE on the
 *   well-known OEM call-recording folders. That permission survives
 *   process restarts because it's a manifest grant, not a SAF token.
 *
 *   We already have MANAGE_EXTERNAL_STORAGE in the manifest (task
 *   #208/215 shipped All-Files-Access). This rewrite uses it.
 *
 * Strategy on every run:
 *   1. If Environment.isExternalStorageManager() is true, scan each
 *      known OEM path under /storage/emulated/0 directly with
 *      java.io.File. Upload via FileInputStream. No SAF grant needed.
 *   2. If direct scan found NO files (rare OEM with a folder we don't
 *      know, or user picked a custom location), fall back to the
 *      legacy SAF tree at prefs[rec_folder_uri].
 *   3. Either way, dedup by absolute path/uri in rec_bg_uploaded map.
 *
 * Stored prefs (set by MainActivity / JS-side):
 *   - rec_folder_uri   : SAF tree Uri (fallback only)
 *   - rec_bg_base_url  : CRM base URL
 *   - rec_bg_token     : x-auth-token
 *   - rec_bg_last_sync : ms epoch of last successful run
 *   - rec_bg_uploaded  : JSON { "file://path" or "content://..." : ts }
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
        const val MAX_LOOKBACK_MS = 7L * 24 * 3600 * 1000
        const val MIN_AGE_S = 10

        /**
         * Known call-recording folder paths (relative to
         * /storage/emulated/0) across OEMs. We try every one and
         * accept all that exist — a single phone usually only has
         * files in one of these but doesn't hurt to scan all.
         *
         * Sourced from XDA / Runo / TeleCRM docs + community wikis.
         */
        val KNOWN_PATHS = listOf(
            // Samsung — modern OneUI 5+
            "Recordings/Call",
            // Samsung — older OneUI
            "Sounds/Call",
            // Samsung — alternate naming
            "Recordings/Call recordings",
            // Xiaomi / Redmi / POCO MIUI
            "MIUI/sound_recorder/call_rec",
            "MIUI/sound_recorder",
            // Vivo / iQOO
            "PhoneRecord",
            "Music/Recordings/Call",
            "Record/Call",
            // Oppo / Realme
            "Music/Recordings/Call Recordings",
            "Recordings/Call Recordings",
            // OnePlus / generic AOSP
            "Recordings",
            // Honor / Huawei
            "Sounds/CallRecord",
            "CallRecordings",
            // Motorola
            "Recordings/Call recordings",
            // Tecno / Infinix / Itel
            "Recorder/call"
        )
    }

    override fun doWork(): Result {
        val ctx = applicationContext
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val folderUriStr = prefs.getString(KEY_FOLDER_URI, null)
        val baseUrl = prefs.getString(KEY_BASE_URL, null)
        val token = prefs.getString(KEY_TOKEN, null)
        if (baseUrl.isNullOrEmpty() || token.isNullOrEmpty()) {
            Log.i(TAG, "skip: missing base/token — user hasn't completed setup yet")
            return Result.success()
        }

        val nowMs = System.currentTimeMillis()
        val storedSince = prefs.getLong(KEY_LAST_SYNC, 0L)
        val floor = nowMs - MAX_LOOKBACK_MS
        val sinceMs = if (storedSince > 0) maxOf(storedSince - 5 * 60_000, floor) else floor

        val uploadedMap = try {
            JSONObject(prefs.getString(KEY_UPLOADED_MAP, "{}") ?: "{}")
        } catch (_: Exception) { JSONObject() }

        // ───────────────────────── PRIMARY: direct File API ─────────────────────────
        val direct = ArrayList<File>()
        val afa = hasAllFilesAccess()
        val pathsHit = ArrayList<String>()
        if (afa) {
            val root = Environment.getExternalStorageDirectory()
            for (rel in KNOWN_PATHS.distinct()) {
                val dir = File(root, rel)
                if (!dir.exists() || !dir.isDirectory) continue
                if (!dir.canRead()) continue
                val before = direct.size
                collectAudioDirect(dir, sinceMs, direct, 0)
                if (direct.size > before) pathsHit.add(rel)
            }
            Log.i(TAG, "direct-scan: ${direct.size} candidate(s); paths hit=${pathsHit}")
            pingDiag(baseUrl, token, "scan_direct", "ok",
                JSONObject()
                    .put("paths_checked", KNOWN_PATHS.distinct().size)
                    .put("paths_hit", JSONArray(pathsHit))
                    .put("found", direct.size))
        } else {
            Log.w(TAG, "direct-scan: All-Files-Access NOT granted (api=${Build.VERSION.SDK_INT}) — SAF only")
            pingDiag(baseUrl, token, "scan_direct", "no_permission",
                JSONObject().put("api_level", Build.VERSION.SDK_INT))
        }

        // ───────────────────────── FALLBACK: SAF tree ──────────────────────────────
        // Run SAF fallback when:
        //   - direct found nothing (we don't know this OEM's folder), OR
        //   - we don't have All-Files-Access at all (below SDK 30 etc).
        // We use SAF in addition (not instead) so a user with custom
        // folder + known folder both gets all files.
        val saf = ArrayList<DocumentFile>()
        if (direct.isEmpty() && !folderUriStr.isNullOrEmpty()) {
            try {
                val tree = Uri.parse(folderUriStr)
                val dir = DocumentFile.fromTreeUri(ctx, tree)
                if (dir != null && dir.exists() && dir.canRead()) {
                    collectAudio(dir, sinceMs, saf, 0)
                    Log.i(TAG, "saf-scan: ${saf.size} candidate(s) from user-selected folder")
                    pingDiag(baseUrl, token, "scan_saf", "ok",
                        JSONObject().put("found", saf.size))
                } else {
                    Log.w(TAG, "saf-scan: folder unreachable (canRead=${dir?.canRead()})")
                    pingDiag(baseUrl, token, "scan_saf", "unreachable",
                        JSONObject().put("had_dir", dir != null))
                }
            } catch (e: Exception) {
                Log.e(TAG, "saf-scan error: ${e.message}")
                pingDiag(baseUrl, token, "scan_saf", "error",
                    JSONObject().put("err", e.message ?: "unknown"))
            }
        }

        // ───────────────────────── upload loop ────────────────────────────────────
        var newest = storedSince
        var uploaded = 0
        var skipped = 0
        var failed = 0

        for (f in direct) {
            val uriKey = "file://" + f.absolutePath
            if (uploadedMap.has(uriKey)) { skipped++; continue }
            val mod = f.lastModified()
            if (nowMs - mod < MIN_AGE_S * 1000L) { skipped++; continue }
            val name = f.name
            val phone = extractPhone(name)
            try {
                val ok = uploadDirect(f, name, phone, baseUrl, token)
                if (ok) {
                    uploaded++
                    uploadedMap.put(uriKey, nowMs)
                    if (mod > newest) newest = mod
                } else { failed++ }
            } catch (e: Exception) {
                Log.e(TAG, "direct-upload error for $name: ${e.message}")
                failed++
            }
        }

        for (f in saf) {
            val uriKey = f.uri.toString()
            if (uploadedMap.has(uriKey)) { skipped++; continue }
            val mod = f.lastModified()
            if (nowMs - mod < MIN_AGE_S * 1000L) { skipped++; continue }
            val name = (f.name ?: "recording.m4a")
            val phone = extractPhone(name)
            try {
                val ok = uploadOne(ctx, f.uri, name, phone, baseUrl, token)
                if (ok) {
                    uploaded++
                    uploadedMap.put(uriKey, nowMs)
                    if (mod > newest) newest = mod
                } else { failed++ }
            } catch (e: Exception) {
                Log.e(TAG, "saf-upload error for $name: ${e.message}")
                failed++
            }
        }

        val newWatermark = if (uploaded > 0) newest else storedSince
        prefs.edit()
            .putLong(KEY_LAST_SYNC, newWatermark)
            .putString(KEY_UPLOADED_MAP, uploadedMap.toString())
            .apply()

        Log.i(TAG, "done: uploaded=$uploaded skipped=$skipped failed=$failed " +
                "direct=${direct.size} saf=${saf.size} watermark=$newWatermark afa=$afa")
        pingDiag(baseUrl, token, "sync_done", if (failed > 0) "partial" else "ok",
            JSONObject()
                .put("uploaded", uploaded)
                .put("skipped", skipped)
                .put("failed", failed)
                .put("direct_found", direct.size)
                .put("saf_found", saf.size)
                .put("afa", afa))
        return Result.success()
    }

    private fun hasAllFilesAccess(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            Environment.isExternalStorageManager()
        } else {
            // Below SDK 30 — READ_EXTERNAL_STORAGE in manifest is enough.
            true
        }
    }

    private fun collectAudioDirect(dir: File, sinceMs: Long, out: ArrayList<File>, depth: Int) {
        if (depth > 3) return
        val kids = try { dir.listFiles() } catch (_: Exception) { return } ?: return
        for (f in kids) {
            try {
                if (f.isDirectory) { collectAudioDirect(f, sinceMs, out, depth + 1); continue }
                if (!f.isFile) continue
                val name = f.name ?: continue
                if (!isAudio(name)) continue
                if (f.lastModified() < sinceMs) continue
                out.add(f)
            } catch (_: Exception) { /* skip unreadable entries */ }
        }
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
        val digits = Regex("[0-9]{7,}").findAll(name).map { it.value }.toList()
        if (digits.isEmpty()) return ""
        return digits.maxByOrNull { it.length } ?: ""
    }

    /**
     * Direct-File upload — FileInputStream, no ContentResolver, no SAF grant.
     */
    private fun uploadDirect(file: File, name: String, phone: String,
                             baseUrl: String, token: String): Boolean {
        val mime = guessMime(name)
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
        writePart(out, boundary, "device_path", file.absolutePath)
        writePart(out, boundary, "source", "bg_worker_direct")

        out.writeBytes("--$boundary\r\n")
        out.writeBytes("Content-Disposition: form-data; name=\"audio\"; filename=\"$name\"\r\n")
        out.writeBytes("Content-Type: $mime\r\n\r\n")
        FileInputStream(file).use { ins ->
            val buf = ByteArray(8192)
            while (true) {
                val n = ins.read(buf)
                if (n <= 0) break
                out.write(buf, 0, n)
            }
        }
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
        Log.d(TAG, "direct-upload $name → $code :: $body")
        return code in 200..299
    }

    /**
     * SAF upload (legacy path). Unchanged from REC_BG_SYNC_v1.
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

    /**
     * Fire-and-forget telemetry ping to /api/rec-diag so the Super-admin
     * Device Health Timeline can see what the worker is doing per-run.
     * Errors are swallowed — diagnostics must never break the worker.
     */
    private fun pingDiag(baseUrl: String, token: String, step: String,
                         status: String, detail: JSONObject) {
        try {
            val url = URL(baseUrl.replace(Regex("/+$"), "") + "/api/rec-diag")
            val conn = url.openConnection() as HttpURLConnection
            conn.doOutput = true
            conn.requestMethod = "POST"
            conn.connectTimeout = 8_000
            conn.readTimeout = 8_000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("x-auth-token", token)
            val body = JSONObject()
                .put("step", step)
                .put("status", status)
                .put("source", "bg_worker_v2")
                .put("ts", System.currentTimeMillis())
                .put("detail", detail)
                .toString()
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            conn.responseCode  // touch the response so the request is sent
            conn.disconnect()
        } catch (_: Exception) { /* ignore — diagnostics must not break work */ }
    }
}
