package app.leadcrm.mobile;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.BridgeActivity;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "LeadCRM/Main";
    private static final int REQ_PERMISSIONS = 101;
    private static final int REQ_PICK_FOLDER = 202;
    private static final String PREFS = "leadcrm";
    private static final String KEY_REC_FOLDER = "recording_folder_uri";

    private BroadcastReceiver callReceiver;
    private String pendingPickerCallback = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestPermissions();
        registerCallReceiver();
        getBridge().getWebView().addJavascriptInterface(new LeadCRMBridge(), "LeadCRMNative");
        handleSharedIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSharedIntent(intent);
    }

    private void handleSharedIntent(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())
                && "text/plain".equals(intent.getType())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null && !shared.isEmpty()) {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                prefs.edit().putString("shared_lead_text", shared).apply();
                getBridge().getWebView().postDelayed(() -> {
                    String js = "window.LeadCRMShared = " + jsStr(shared) +
                            "; if (window.onLeadCRMSharedLead) window.onLeadCRMSharedLead(" + jsStr(shared) + ");";
                    getBridge().getWebView().evaluateJavascript(js, null);
                }, 2500);
            }
        }
    }

    private void requestPermissions() {
        String[] perms = {
                Manifest.permission.READ_PHONE_STATE,
                Manifest.permission.CALL_PHONE,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.POST_NOTIFICATIONS
        };
        boolean need = false;
        for (String p : perms) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                need = true;
                break;
            }
        }
        if (need) {
            ActivityCompat.requestPermissions(this, perms, REQ_PERMISSIONS);
        }
    }

    private void registerCallReceiver() {
        callReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String event = intent.getStringExtra("event");
                String number = intent.getStringExtra("number");
                if (event == null) return;
                Log.d(TAG, "call event: " + event + " " + number);
                forwardToWebview(event, number);
            }
        };
        IntentFilter f = new IntentFilter("app.leadcrm.mobile.CALL_EVENT");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(callReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(callReceiver, f);
        }
    }

    private void forwardToWebview(String event, String number) {
        WebView wv = getBridge().getWebView();
        if (wv == null) return;
        String js = "window.onLeadCRMCallEvent && window.onLeadCRMCallEvent(" +
                jsStr(event) + "," + jsStr(number) + ");";
        wv.post(() -> wv.evaluateJavascript(js, null));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_FOLDER) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri tree = data.getData();
                int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION;
                try {
                    getContentResolver().takePersistableUriPermission(tree, flags);
                } catch (Exception e) {
                    Log.e(TAG, "takePersistableUriPermission: " + e.getMessage());
                }
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                prefs.edit().putString(KEY_REC_FOLDER, tree.toString()).apply();
                String displayName = humanFolderName(tree);
                invokeJsCallback(pendingPickerCallback, true, displayName);
            } else {
                invokeJsCallback(pendingPickerCallback, false, "cancelled");
            }
            pendingPickerCallback = null;
        }
    }

    private static String humanFolderName(Uri tree) {
        String enc = tree.getLastPathSegment();
        if (enc == null) return "Selected folder";
        try { enc = URLDecoder.decode(enc, "UTF-8"); } catch (Exception ignored) {}
        if (enc.startsWith("primary:")) enc = "/" + enc.substring("primary:".length());
        return enc;
    }

    private void invokeJsCallback(String cb, boolean ok, String detail) {
        if (cb == null || cb.isEmpty()) return;
        WebView wv = getBridge().getWebView();
        if (wv == null) return;
        String js = "try{" + cb + "(" + (ok ? "true" : "false") + "," + jsStr(detail) + ");}catch(e){console.error(e);}";
        new Handler(Looper.getMainLooper()).post(() -> wv.evaluateJavascript(js, null));
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (callReceiver != null) {
            try { unregisterReceiver(callReceiver); } catch (Exception ignored) {}
        }
    }

    private static String jsStr(String s) {
        if (s == null) return "null";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "") + "\"";
    }

    private static boolean isAudioFile(String n) {
        if (n == null) return false;
        String lower = n.toLowerCase();
        return lower.endsWith(".m4a") || lower.endsWith(".mp3") || lower.endsWith(".wav")
                || lower.endsWith(".amr") || lower.endsWith(".aac") || lower.endsWith(".ogg")
                || lower.endsWith(".3gp") || lower.endsWith(".mpeg") || lower.endsWith(".opus");
    }

    private static String guessMime(String n) {
        String lower = n == null ? "" : n.toLowerCase();
        if (lower.endsWith(".m4a")) return "audio/m4a";
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".amr")) return "audio/amr";
        if (lower.endsWith(".aac")) return "audio/aac";
        if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
        if (lower.endsWith(".3gp")) return "audio/3gpp";
        return "audio/mpeg";
    }

    /**
     * Walk the folder tree (3 levels deep) looking for the most recently-modified
     * audio file whose filename digits include the given tail (last 7 digits of
     * the dialed phone). Files modified before sinceMs are skipped.
     */
    private DocumentFile findBestMatch(DocumentFile dir, String tail, long sinceMs, int depth, DocumentFile bestSoFar) {
        if (depth > 3) return bestSoFar;
        DocumentFile[] kids;
        try { kids = dir.listFiles(); } catch (Exception e) { return bestSoFar; }
        if (kids == null) return bestSoFar;
        DocumentFile best = bestSoFar;
        long bestMod = best != null ? best.lastModified() : 0;
        for (DocumentFile f : kids) {
            try {
                if (f.isDirectory()) {
                    DocumentFile sub = findBestMatch(f, tail, sinceMs, depth + 1, best);
                    if (sub != null && sub.lastModified() > bestMod) {
                        best = sub;
                        bestMod = sub.lastModified();
                    }
                    continue;
                }
                if (!f.isFile()) continue;
                String name = f.getName();
                if (!isAudioFile(name)) continue;
                long mod = f.lastModified();
                if (sinceMs > 0 && mod < sinceMs) continue;
                if (tail != null && !tail.isEmpty()) {
                    String fileDigits = name.replaceAll("[^0-9]", "");
                    if (!fileDigits.contains(tail)) continue;
                }
                if (mod > bestMod) {
                    best = f;
                    bestMod = mod;
                }
            } catch (Exception ignored) {}
        }
        return best;
    }

    /* ---------------- JS-facing bridge ---------------- */
    public class LeadCRMBridge {

        @JavascriptInterface
        public void pickRecordingFolder(String callback) {
            pendingPickerCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                startActivityForResult(i, REQ_PICK_FOLDER);
            } catch (Exception e) {
                Log.e(TAG, "pickRecordingFolder: " + e.getMessage());
                invokeJsCallback(callback, false, e.getMessage());
                pendingPickerCallback = null;
            }
        }

        @JavascriptInterface
        public String getRecordingFolder() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String s = prefs.getString(KEY_REC_FOLDER, null);
            if (s == null) return "";
            try { return humanFolderName(Uri.parse(s)); } catch (Exception e) { return s; }
        }

        @JavascriptInterface
        public void clearRecordingFolder() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit().remove(KEY_REC_FOLDER).apply();
        }

        /**
         * Persist the phone + leadId of the call the user just initiated through
         * the app. Used both as context for syncCallRecording and as a filter
         * source for "only my calls" mode.
         */
        @JavascriptInterface
        public void registerOutgoingCall(String phone, String leadId, double startedAtMs) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit()
                    .putString("last_dialed_phone", phone == null ? "" : phone)
                    .putString("last_dialed_lead_id", leadId == null ? "" : leadId)
                    .putLong("last_dialed_at", (long) startedAtMs)
                    .apply();
            Log.d(TAG, "registered call → " + phone + " lead=" + leadId);
        }

        @JavascriptInterface
        public String getLastDialedCall() {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            try {
                JSONObject o = new JSONObject();
                o.put("phone", prefs.getString("last_dialed_phone", ""));
                o.put("leadId", prefs.getString("last_dialed_lead_id", ""));
                o.put("dialedAt", prefs.getLong("last_dialed_at", 0));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public String listRecordings(double sinceMs) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String s = prefs.getString(KEY_REC_FOLDER, null);
            if (s == null) return "[]";
            try {
                Uri tree = Uri.parse(s);
                DocumentFile dir = DocumentFile.fromTreeUri(MainActivity.this, tree);
                if (dir == null || !dir.exists() || !dir.canRead()) return "[]";
                JSONArray arr = new JSONArray();
                listRecursive(dir, (long) sinceMs, arr, 0);
                return arr.toString();
            } catch (Exception e) {
                Log.e(TAG, "listRecordings: " + e.getMessage());
                return "[]";
            }
        }

        private void listRecursive(DocumentFile dir, long sinceMs, JSONArray arr, int depth) {
            if (depth > 3) return;
            DocumentFile[] kids;
            try { kids = dir.listFiles(); } catch (Exception e) { return; }
            if (kids == null) return;
            for (DocumentFile f : kids) {
                try {
                    if (f.isDirectory()) { listRecursive(f, sinceMs, arr, depth + 1); continue; }
                    if (!f.isFile()) continue;
                    String name = f.getName();
                    if (!isAudioFile(name)) continue;
                    long modified = f.lastModified();
                    if (sinceMs > 0 && modified < sinceMs) continue;
                    JSONObject o = new JSONObject();
                    o.put("name", name);
                    o.put("uri", f.getUri().toString());
                    o.put("size", f.length());
                    o.put("modified", modified);
                    o.put("mime", f.getType() != null ? f.getType() : guessMime(name));
                    arr.put(o);
                } catch (Exception ignored) {}
            }
        }

        /**
         * Find the single best-matching recording for one specific call (the
         * call the user just made through the app) and upload it. Used right
         * after call_ended fires so the recording shows up in the after-call
         * modal.
         *
         * Matching rule: most recently-modified audio file in the folder
         * whose filename digits include the last 7 digits of `phone`, modified
         * after `sinceMs` (typically the call start time minus a 60s buffer).
         */
        @JavascriptInterface
        public void syncCallRecording(String phone, String leadId, double sinceMs,
                                      String baseUrl, String token, String callback) {
            new Thread(() -> {
                final String cb = callback == null ? "" : callback;
                try {
                    SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                    String folderUriStr = prefs.getString(KEY_REC_FOLDER, null);
                    if (folderUriStr == null) {
                        invokeJsCallback(cb, false, "no_folder");
                        return;
                    }
                    Uri tree = Uri.parse(folderUriStr);
                    DocumentFile dir = DocumentFile.fromTreeUri(MainActivity.this, tree);
                    if (dir == null || !dir.exists() || !dir.canRead()) {
                        invokeJsCallback(cb, false, "folder_unreachable");
                        return;
                    }
                    String digits = phone == null ? "" : phone.replaceAll("[^0-9]", "");
                    String tail = digits.length() >= 7 ? digits.substring(digits.length() - 7) : digits;

                    // Try once, retry once after 4s (recorder needs time to finalise the file)
                    DocumentFile best = findBestMatch(dir, tail, (long) sinceMs, 0, null);
                    if (best == null) {
                        Thread.sleep(4000);
                        best = findBestMatch(dir, tail, (long) sinceMs, 0, null);
                    }
                    if (best == null) {
                        invokeJsCallback(cb, false, "no_match");
                        return;
                    }

                    long durationGuess = Math.max(0, (System.currentTimeMillis() - (long) sinceMs) / 1000);
                    uploadFile(best.getUri(), best.getName() != null ? best.getName() : "recording.m4a",
                            phone, "out", (int) durationGuess, leadId, String.valueOf((long) sinceMs),
                            baseUrl, token, cb);
                } catch (Exception e) {
                    Log.e(TAG, "syncCallRecording: " + e.getMessage());
                    invokeJsCallback(cb, false, e.getMessage() == null ? "error" : e.getMessage());
                }
            }).start();
        }

        @JavascriptInterface
        public void uploadRecordingByUri(String uriStr, String baseUrl, String token,
                                         String phone, String direction, int durationS,
                                         String leadId, String startedAt,
                                         String filename, String callback) {
            new Thread(() -> {
                try {
                    Uri uri = Uri.parse(uriStr);
                    uploadFile(uri, filename, phone, direction, durationS, leadId, startedAt,
                            baseUrl, token, callback);
                } catch (Exception e) {
                    Log.e(TAG, "uploadByUri failed: " + e.getMessage());
                    invokeJsCallback(callback, false, e.getMessage() == null ? "error" : e.getMessage());
                }
            }).start();
        }

        /** Streams a SAF Uri up to /api/recordings as multipart form-data. */
        private void uploadFile(Uri uri, String filename, String phone, String direction,
                                int durationS, String leadId, String startedAt,
                                String baseUrl, String token, String callback) {
            try {
                ContentResolver cr = getContentResolver();
                String name = filename;
                if (name == null || name.isEmpty()) name = "recording.m4a";
                String mime = guessMime(name);
                try (Cursor c = cr.query(uri, null, null, null, null)) {
                    if (c != null && c.moveToFirst()) {
                        int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (ni >= 0) {
                            String n = c.getString(ni);
                            if (n != null && !n.isEmpty()) name = n;
                        }
                    }
                }
                String t = cr.getType(uri);
                if (t != null) mime = t;

                String boundary = "----LeadCRM" + System.currentTimeMillis();
                URL url = new URL(baseUrl.replaceAll("/+$", "") + "/api/recordings");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setDoOutput(true);
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(180_000);
                conn.setRequestProperty("Connection", "Keep-Alive");
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
                conn.setRequestProperty("x-auth-token", token == null ? "" : token);

                DataOutputStream out = new DataOutputStream(new BufferedOutputStream(conn.getOutputStream()));
                writePart(out, boundary, "phone", phone == null ? "" : phone);
                writePart(out, boundary, "direction", direction == null ? "out" : direction);
                writePart(out, boundary, "duration_s", String.valueOf(durationS));
                writePart(out, boundary, "device_path", uri.toString());
                if (startedAt != null && !startedAt.isEmpty())
                    writePart(out, boundary, "started_at", startedAt);
                if (leadId != null && !leadId.isEmpty() && !leadId.equals("null"))
                    writePart(out, boundary, "lead_id", leadId);

                out.writeBytes("--" + boundary + "\r\n");
                out.writeBytes("Content-Disposition: form-data; name=\"audio\"; filename=\"" + name + "\"\r\n");
                out.writeBytes("Content-Type: " + mime + "\r\n\r\n");
                try (InputStream in = cr.openInputStream(uri)) {
                    if (in == null) throw new Exception("cannot open input stream");
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                out.writeBytes("\r\n");
                out.writeBytes("--" + boundary + "--\r\n");
                out.flush();
                out.close();

                int code = conn.getResponseCode();
                StringBuilder body = new StringBuilder();
                try (BufferedReader r = new BufferedReader(new InputStreamReader(
                        code < 400 ? conn.getInputStream() : conn.getErrorStream(), "UTF-8"))) {
                    String line;
                    while ((line = r.readLine()) != null) body.append(line);
                }
                conn.disconnect();
                Log.d(TAG, "upload " + name + " → " + code + " :: " + body);
                invokeJsCallback(callback, code >= 200 && code < 300, body.toString());
            } catch (Exception e) {
                Log.e(TAG, "uploadFile: " + e.getMessage());
                invokeJsCallback(callback, false, e.getMessage() == null ? "error" : e.getMessage());
            }
        }

        private void writePart(DataOutputStream out, String boundary, String name, String value) throws Exception {
            out.writeBytes("--" + boundary + "\r\n");
            out.writeBytes("Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n");
            out.write(value.getBytes("UTF-8"));
            out.writeBytes("\r\n");
        }
    }
}
