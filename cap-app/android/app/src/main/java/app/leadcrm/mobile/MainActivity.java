package app.leadcrm.mobile;

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
import android.app.DownloadManager;
import androidx.core.content.FileProvider;
import java.io.File;
import android.webkit.WebView;
import android.webkit.WebChromeClient;
import android.webkit.GeolocationPermissions;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.BridgeActivity;

// REC_BG_SYNC_v1 — WorkManager for background recording sync
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.OneTimeWorkRequest;
import java.util.concurrent.TimeUnit;

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
        // REC_AUTOSYNC_KILL_v1 — disabled periodic 15-min WorkManager auto-sync per user request
        // scheduleRecordingBgSync();

        // PERM_ONBOARDING_v1: launch Runo-style permission onboarding on first run
        // or whenever critical perms (battery whitelist / MANAGE_EXTERNAL_STORAGE / recording folder)
        // are missing. Activity ships an upper-right Skip button so it's never a hard block.
        try {
            if (PermissionOnboardingActivity.shouldShow(this)) {
                startActivity(new Intent(this, PermissionOnboardingActivity.class));
            }
        } catch (Exception e) {
            Log.w(TAG, "PermissionOnboarding launch failed: " + e.getMessage());
        }

        // FG_SVC_v1: start the always-on foreground service so the OS can't
        // kill the app on aggressive OEMs (Vivo, Oppo, Realme). The service
        // shows a low-priority "Call tracking is enabled" notification and
        // does nothing else — it exists purely to keep the process alive
        // so the existing PhoneStateReceiver / RecordingObserver /
        // WorkManager pipeline keeps firing reliably.
        try {
            CallTrackingForegroundService.start(this);
        } catch (Exception e) {
            Log.w(TAG, "CallTrackingForegroundService.start failed: " + e.getMessage());
        }

        // Allow WebView to use navigator.geolocation. Without this the SPA's
        // getCurrentPosition() in checkInOut() is silently denied and
        // attendance check-in saves with no lat/lng.
        try {
            WebView wv = getBridge().getWebView();
            wv.getSettings().setGeolocationEnabled(true);
            wv.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                    callback.invoke(origin, true, true);
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "WebChromeClient install failed: " + e.getMessage());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleSharedIntent(intent);
    }

    @Override
    public void onResume() {
        super.onResume();
        // FG_SVC_v2: if the user swiped the persistent notification (or Vivo
        // killed it overnight), restart the foreground service so call/recording
        // sync stays bulletproof. start() is idempotent — safe to call on every
        // resume.
        try { CallTrackingForegroundService.start(this); } catch (Exception e) {}
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
                // CALL_PHONE_CAPTURE_v1: needed for the CallLog fallback in
                // PhoneStateReceiver. On Android 10+ EXTRA_INCOMING_NUMBER
                // returns null so the receiver queries CallLog.Calls for
                // the most recent number. Without this permission the
                // query throws SecurityException and phone stays empty.
                Manifest.permission.READ_CALL_LOG,
                Manifest.permission.READ_CONTACTS,
                Manifest.permission.POST_NOTIFICATIONS,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
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

        // PERM_ONBOARDING_v1: SPA-callable re-trigger for the onboarding screen
        // (e.g. from a "Fix permissions" button in Settings)
        @JavascriptInterface
        public void openRecordingSetup() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(MainActivity.this, PermissionOnboardingActivity.class);
                    startActivity(i);
                } catch (Exception e) {
                    Log.e(TAG, "openRecordingSetup: " + e.getMessage());
                }
            });
        }

        // PERM_ONBOARDING_SOFT_v1: snapshot for SPA top-banner. JS calls this
        // once per app boot and renders a small dismissable strip if
        // anyMissing is true. No more hard-blocking the user on the onboarding
        // screen — they keep using the CRM and can self-fix from a quiet hint.
        @JavascriptInterface
        public String getPermissionsStatus() {
            try {
                return PermissionOnboardingActivity.permissionsStatusJson(MainActivity.this);
            } catch (Exception e) {
                return "{\"anyMissing\":false}";
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
         * Save the API base URL + auth token so PhoneStateReceiver can
         * POST call events directly to /api/call_event_native, even if
         * the WebView is paused or the app is killed. JS calls this on
         * every login + on every app boot from the persisted token.
         */
        // INCOMING_CARD_v1: kill-switch for the Runo-style incoming-call card.
        // SPA flips this from the Settings page if the card misbehaves.
        @JavascriptInterface
        public void setIncomingCardEnabled(boolean enabled) {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                prefs.edit().putString("incoming_card_enabled", enabled ? "1" : "0").apply();
                Log.d(TAG, "incoming card -> " + (enabled ? "ON" : "OFF"));
            } catch (Exception e) {
                Log.e(TAG, "setIncomingCardEnabled failed: " + e.getMessage());
            }
        }

        // APK_AUTO_UPDATE_DIRECT_v1 (2026-06-03): true in-app download + install.
        // Downloads the APK via DownloadManager (silently, with notification),
        // then fires the PackageInstaller intent with a FileProvider URI when
        // complete. User taps "Install" once and the update goes in. No
        // browser detour, no "copy this URL" fallback. The old downloadApk
        // (browser launch) stays as a Plan B for very old Android quirks.
        @JavascriptInterface
        public void installApk(String url) {
            if (url == null || url.isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    String full = url;
                    if (full.startsWith("/")) {
                        String origin = "https://crm.smartcrmsolution.com";
                        try {
                            String webUrl = getBridge().getWebView().getUrl();
                            if (webUrl != null) {
                                java.net.URL u = new java.net.URL(webUrl);
                                origin = u.getProtocol() + "://" + u.getHost();
                                if (u.getPort() > 0) origin += ":" + u.getPort();
                            }
                        } catch (Exception ignored) {}
                        full = origin + url;
                    }
                    // Target file under app-private external dir so we don't
                    // need WRITE_EXTERNAL_STORAGE on modern Android.
                    File dir = new File(getExternalFilesDir(null), "apk_updates");
                    if (!dir.exists()) dir.mkdirs();
                    File outFile = new File(dir, "update.apk");
                    if (outFile.exists()) outFile.delete();
                    final Uri outUri = Uri.fromFile(outFile);

                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm == null) {
                        Log.w(TAG, "installApk: DownloadManager unavailable, falling back to browser");
                        downloadApk(url);
                        return;
                    }
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(full));
                    req.setTitle("SmartCRM update");
                    req.setDescription("Downloading new app version…");
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationUri(outUri);
                    req.setMimeType("application/vnd.android.package-archive");
                    final long downloadId = dm.enqueue(req);
                    Log.i(TAG, "installApk: enqueued download id=" + downloadId + " url=" + full);

                    final BroadcastReceiver receiver = new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context ctx, Intent intent) {
                            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                            if (id != downloadId) return;
                            try { ctx.unregisterReceiver(this); } catch (Exception ignored) {}
                            launchInstaller(outFile);
                        }
                    };
                    IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                    if (Build.VERSION.SDK_INT >= 33) {
                        registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
                    } else {
                        registerReceiver(receiver, filter);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "installApk failed: " + e.getMessage());
                    // Fall back to browser-launch path if anything blew up.
                    downloadApk(url);
                }
            });
        }

        private void launchInstaller(File apk) {
            try {
                Uri apkUri = FileProvider.getUriForFile(
                        getApplicationContext(),
                        getPackageName() + ".fileprovider",
                        apk);
                Intent installIntent = new Intent(Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(installIntent);
                Log.i(TAG, "launchInstaller: opened system installer for " + apk.getAbsolutePath());
            } catch (Exception e) {
                Log.e(TAG, "launchInstaller failed: " + e.getMessage());
            }
        }

        // APK_AUTO_UPDATE_v1.3 (legacy): fire Intent.ACTION_VIEW so Android's
        // browser downloads the APK. Kept as a fallback for the rare device
        // where DownloadManager is unusable.
        @JavascriptInterface
        public void downloadApk(String url) {
            if (url == null || url.isEmpty()) return;
            runOnUiThread(() -> {
                try {
                    String full = url;
                    if (full.startsWith("/")) {
                        String origin = "https://crm.smartcrmsolution.com";
                        try {
                            String webUrl = getBridge().getWebView().getUrl();
                            if (webUrl != null) {
                                java.net.URL u = new java.net.URL(webUrl);
                                origin = u.getProtocol() + "://" + u.getHost();
                                if (u.getPort() > 0) origin += ":" + u.getPort();
                            }
                        } catch (Exception ignored) {}
                        full = origin + url;
                    }
                    Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(full));
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                    Log.i(TAG, "downloadApk: launched browser for " + full);
                } catch (Exception e) {
                    Log.e(TAG, "downloadApk failed: " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public String getIncomingCardEnabled() {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                String v = prefs.getString("incoming_card_enabled", "1");
                return v == null ? "1" : v;
            } catch (Exception e) {
                return "1";
            }
        }

        @JavascriptInterface
        public void saveCallEventCreds(String apiBase, String token) {
            try {
                SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
                prefs.edit()
                        .putString("api_base", apiBase == null ? "" : apiBase)
                        .putString("auth_token", token == null ? "" : token)
                        .apply();
                Log.d(TAG, "saveCallEventCreds: base=" + apiBase + " tokenLen=" + (token == null ? 0 : token.length()));
            } catch (Exception e) {
                Log.e(TAG, "saveCallEventCreds failed: " + e.getMessage());
            }
        }

        /**
         * Persist the phone + leadId of the call the user just initiated through
         * the app. Used both as context for syncCallRecording and as a filter
         * source for "only my calls" mode.
         */
        @JavascriptInterface
        public void registerOutgoingCall(String phone, String leadId, double startedAtMs) {
            registerOutgoingCallWithContext(phone, leadId, startedAtMs, null);
        }

        // CALL_OVERLAY_v1: extended variant that also takes a leadJson blob the
        // SPA can pre-fill (name, status, last note, last call date). Old callers
        // keep working via the shim above.
        @JavascriptInterface
        public void registerOutgoingCallWithContext(String phone, String leadId, double startedAtMs, String leadJson) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit()
                    .putString("last_dialed_phone", phone == null ? "" : phone)
                    .putString("last_dialed_lead_id", leadId == null ? "" : leadId)
                    .putLong("last_dialed_at", (long) startedAtMs)
                    .apply();
            Log.d(TAG, "registered call → " + phone + " lead=" + leadId);
            // CALL_OVERLAY_REMOVE: overlay popup removed at user request — the
            // close-button never reliably dismissed on Vivo / OriginOS despite
            // 5 different iterations. We keep the registerOutgoingCallWithContext
            // bridge in place (the SPA still uses it for last_dialed_phone) but
            // do NOT show the floating card any more.
        }

        // CALL_OVERLAY_REMOVE: hideCallOverlay kept as a no-op so any
        // SPA code that still references it doesn't throw. The overlay
        // itself is no longer shown.
        @JavascriptInterface
        public void hideCallOverlay() { /* no-op — overlay removed */ }

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

        // REC_BG_SYNC_v1 — JS calls this once after login so the background
        // worker has the auth token + base URL it needs to upload while the
        // WebView is dead. Stored in SharedPreferences (NOT WorkData) so
        // the worker reads the same up-to-date values on every periodic run.
        @JavascriptInterface
        public void registerBgSyncCreds(String baseUrl, String token) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            prefs.edit()
                .putString("rec_bg_base_url", baseUrl == null ? "" : baseUrl)
                .putString("rec_bg_token", token == null ? "" : token)
                .apply();
            Log.i(TAG, "bg-sync creds saved (baseUrl=" + (baseUrl == null ? "?" : baseUrl.replaceAll("token=[^&]*", "token=***")) + ")");
            // Make sure the periodic worker is scheduled (idempotent — KEEP policy).
            // REC_AUTOSYNC_KILL_v1 — disabled periodic 15-min WorkManager auto-sync per user request
            // scheduleRecordingBgSync();
        }

        // REC_BG_SYNC_v1 — JS can trigger an immediate scan (e.g. right after
        // a call ends, or from the Sync Now button). Returns immediately;
        // WorkManager handles backoff/retry under the hood.
        @JavascriptInterface
        public void runBgSyncNow() {
            try {
                OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(RecordingsBackgroundSyncWorker.class).build();
                WorkManager.getInstance(MainActivity.this).enqueue(req);
                Log.i(TAG, "bg-sync one-shot enqueued");
            } catch (Exception e) {
                Log.w(TAG, "runBgSyncNow failed: " + e.getMessage());
            }
        }

        // ============================================================
        // WA_APP_TARGET_v1 (2026-06-09): open a WhatsApp chat in a
        // SPECIFIC installed app — Personal (com.whatsapp) vs Business
        // (com.whatsapp.w4b).
        //
        // WHY THIS EXISTS: the pure-JS path (intent:// URLs fired through
        // Capacitor App.openUrl) could never enforce the package, because
        // @capacitor/app openUrl parses the URL with Uri.parse(), NOT
        // Intent.parseUri(URI_INTENT_SCHEME). So the ";package=..." hint
        // was silently dropped and Android opened whichever WhatsApp is
        // the default handler (almost always Personal). On phones with
        // BOTH apps installed, picking "Business" still opened Personal.
        //
        // Here we build the ACTION_VIEW intent ourselves and call
        // setPackage() explicitly, which DOES force the chosen app. The
        // <queries> entries in AndroidManifest.xml grant package
        // visibility so this resolves on Android 11+.
        //
        // kind = "business" | "personal". callback(ok, detail) lets JS
        // fall back gracefully (e.g. targeted app not installed).
        // ============================================================
        @JavascriptInterface
        public void openWhatsApp(String phone, String text, String kind, String callback) {
            final String cb = callback == null ? "" : callback;
            runOnUiThread(() -> {
                try {
                    String digits = phone == null ? "" : phone.replaceAll("[^0-9]", "");
                    if (digits.isEmpty()) { invokeJsCallback(cb, false, "no_phone"); return; }
                    String pkg = "business".equalsIgnoreCase(kind) ? "com.whatsapp.w4b" : "com.whatsapp";
                    String encText = "";
                    try {
                        if (text != null && !text.isEmpty())
                            encText = java.net.URLEncoder.encode(text, "UTF-8");
                    } catch (Exception ignored) {}
                    // Try the canonical deep links in order — different
                    // WhatsApp builds register different ones.
                    String[] urls = new String[] {
                        "https://api.whatsapp.com/send?phone=" + digits + (encText.isEmpty() ? "" : "&text=" + encText),
                        "https://wa.me/" + digits + (encText.isEmpty() ? "" : "?text=" + encText),
                        "whatsapp://send?phone=" + digits + (encText.isEmpty() ? "" : "&text=" + encText)
                    };
                    for (String u : urls) {
                        try {
                            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(u));
                            i.setPackage(pkg);                       // <-- forces Personal vs Business
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(i);
                            Log.i(TAG, "openWhatsApp -> " + pkg + " via " + u);
                            invokeJsCallback(cb, true, pkg);
                            return;
                        } catch (Exception inner) {
                            // No activity for this URL in that package — try next candidate.
                        }
                    }
                    // None resolved — the targeted app isn't installed.
                    Log.w(TAG, "openWhatsApp: " + pkg + " not installed / no activity");
                    invokeJsCallback(cb, false, "not_installed");
                } catch (Exception e) {
                    Log.e(TAG, "openWhatsApp failed: " + e.getMessage());
                    invokeJsCallback(cb, false, e.getMessage() == null ? "error" : e.getMessage());
                }
            });
        }
    }

    /** Schedule the recordings background sync to run every ~15 min (Android minimum). */
    private void scheduleRecordingBgSync() {
        try {
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
            PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                    RecordingsBackgroundSyncWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .addTag("rec-bg-sync")
                .build();
            WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                "rec-bg-sync-periodic",
                ExistingPeriodicWorkPolicy.KEEP,
                req
            );
            Log.i(TAG, "scheduleRecordingBgSync: periodic 15-min worker enqueued");
        } catch (Exception e) {
            Log.w(TAG, "scheduleRecordingBgSync failed: " + e.getMessage());
        }
    }
}
