package app.leadcrm.mobile;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * CALLLOG_AUTOSYNC_v1 — hourly background import of the device call log.
 *
 * Fully ISOLATED from the recording pipeline and the real-time PhoneStateReceiver.
 * Every ~1 hour (scheduled from MainActivity.scheduleCallLogAutoSync) this worker:
 *   1. reads CallLog.Calls for a rolling window (since last success, first run = 24h),
 *   2. keeps only the SIM(s) the rep selected (SharedPreferences "sim_sync_allow"),
 *   3. POSTs the rows to the tenant API (api_call_logSyncBatch), which de-dupes.
 *
 * Reuses the creds the SPA already saves after login (registerBgSyncCreds →
 * "rec_bg_base_url" tenant-scoped URL + "rec_bg_token"). If they aren't set yet,
 * or there are no new calls, it exits quietly. Touches nothing else.
 */
public class CallLogAutoSyncWorker extends Worker {

    private static final String TAG = "CallLogAutoSync";
    private static final String PREFS = "leadcrm";

    public CallLogAutoSyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        String base = prefs.getString("rec_bg_base_url", "");
        String token = prefs.getString("rec_bg_token", "");
        if (base == null || base.isEmpty() || token == null || token.isEmpty()) {
            Log.i(TAG, "skip: no creds yet (user not logged in)");
            return Result.success();
        }
        if (ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.READ_CALL_LOG)
                != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "skip: READ_CALL_LOG not granted");
            return Result.success();
        }

        long now = System.currentTimeMillis();
        long lastSince = prefs.getLong("calllog_autosync_since", 0);
        long since = (lastSince > 0) ? (lastSince - 15L * 60 * 1000) : (now - 24L * 60 * 60 * 1000);
        long minSince = now - 7L * 24 * 60 * 60 * 1000;   // never look back more than 7 days
        if (since < minSince) since = minSince;

        JSONArray rows;
        try {
            rows = readCallLog(ctx, prefs, since, now);
        } catch (Exception e) {
            Log.e(TAG, "read failed: " + e.getMessage());
            return Result.success();
        }
        if (rows.length() == 0) {
            prefs.edit().putLong("calllog_autosync_since", now).apply();
            Log.i(TAG, "no new calls in window");
            return Result.success();
        }

        try {
            JSONObject arg = new JSONObject();
            arg.put("rows", rows);
            JSONArray args = new JSONArray();
            args.put(token);
            args.put(arg);
            JSONObject body = new JSONObject();
            body.put("fn", "api_call_logSyncBatch");
            body.put("args", args);

            String url = base.replaceAll("/+$", "") + "/api";
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("x-auth-token", token);
            byte[] payload = body.toString().getBytes("UTF-8");
            DataOutputStream os = new DataOutputStream(conn.getOutputStream());
            os.write(payload);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            if (is != null) { try { while (is.read() != -1) {} } catch (Exception ignore) {} is.close(); }
            conn.disconnect();

            if (code >= 200 && code < 300) {
                prefs.edit().putLong("calllog_autosync_since", now).apply();
                Log.i(TAG, "synced " + rows.length() + " call(s), http " + code);
                return Result.success();
            }
            Log.w(TAG, "server http " + code + " — will retry");
            return Result.retry();
        } catch (Exception e) {
            Log.w(TAG, "post failed: " + e.getMessage() + " — will retry");
            return Result.retry();
        }
    }

    /** Read CallLog.Calls in [sinceMs, untilMs], filtered by the saved SIM selection. */
    private JSONArray readCallLog(Context ctx, SharedPreferences prefs, long sinceMs, long untilMs) throws Exception {
        String allow = prefs.getString("sim_sync_allow", "");
        java.util.Set<String> allowSet = new java.util.HashSet<>();
        if (allow != null) for (String s : allow.split(",")) { String t = s.trim(); if (!t.isEmpty()) allowSet.add(t); }

        java.util.HashMap<Integer, Integer> subToSlot = new java.util.HashMap<>();
        java.util.HashMap<Integer, String> slotLabel = new java.util.HashMap<>();
        try {
            if (ContextCompat.checkSelfPermission(ctx, android.Manifest.permission.READ_PHONE_STATE)
                    == PackageManager.PERMISSION_GRANTED) {
                android.telephony.SubscriptionManager sm =
                    (android.telephony.SubscriptionManager) ctx.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE);
                java.util.List<android.telephony.SubscriptionInfo> subs =
                    sm != null ? sm.getActiveSubscriptionInfoList() : null;
                if (subs != null) for (android.telephony.SubscriptionInfo si : subs) {
                    int slot = si.getSimSlotIndex();
                    subToSlot.put(si.getSubscriptionId(), slot);
                    String carrier = si.getCarrierName() != null ? si.getCarrierName().toString() : "";
                    slotLabel.put(slot, "SIM " + (slot + 1) + (carrier.isEmpty() ? "" : " · " + carrier));
                }
            }
        } catch (Exception ignored) {}

        JSONArray rows = new JSONArray();
        ContentResolver cr = ctx.getContentResolver();
        String[] proj = {
            android.provider.CallLog.Calls.NUMBER,
            android.provider.CallLog.Calls.TYPE,
            android.provider.CallLog.Calls.DATE,
            android.provider.CallLog.Calls.DURATION,
            android.provider.CallLog.Calls.PHONE_ACCOUNT_ID
        };
        String sel = android.provider.CallLog.Calls.DATE + " >= ? AND " + android.provider.CallLog.Calls.DATE + " <= ?";
        String[] args = { String.valueOf(sinceMs), String.valueOf(untilMs) };
        Cursor c = cr.query(android.provider.CallLog.Calls.CONTENT_URI, proj, sel, args,
                            android.provider.CallLog.Calls.DATE + " DESC");
        if (c != null) {
            int iNum = c.getColumnIndex(android.provider.CallLog.Calls.NUMBER);
            int iType = c.getColumnIndex(android.provider.CallLog.Calls.TYPE);
            int iDate = c.getColumnIndex(android.provider.CallLog.Calls.DATE);
            int iDur = c.getColumnIndex(android.provider.CallLog.Calls.DURATION);
            int iAcc = c.getColumnIndex(android.provider.CallLog.Calls.PHONE_ACCOUNT_ID);
            while (c.moveToNext()) {
                String number = iNum >= 0 ? c.getString(iNum) : "";
                int type = iType >= 0 ? c.getInt(iType) : 0;
                long date = iDate >= 0 ? c.getLong(iDate) : 0;
                int dur = iDur >= 0 ? c.getInt(iDur) : 0;
                String acc = iAcc >= 0 ? c.getString(iAcc) : null;

                Integer slot = null;
                if (acc != null) {
                    try {
                        int a = Integer.parseInt(acc.trim());
                        if (subToSlot.containsKey(a)) slot = subToSlot.get(a);
                        else if (a == 0 || a == 1) slot = a;
                    } catch (Exception ignore) {}
                }
                if (!allowSet.isEmpty()) {
                    if (slot == null || !allowSet.contains(String.valueOf(slot))) continue;
                }
                String direction = type == 2 ? "out" : (type == 3 || type == 5 ? "missed" : (type == 1 ? "in" : ""));
                if (direction.isEmpty()) continue;

                JSONObject o = new JSONObject();
                o.put("phone", number == null ? "" : number);
                o.put("direction", direction);
                o.put("type", type);
                o.put("ts", date);
                o.put("duration_s", dur);
                if (slot != null) {
                    o.put("sim_slot", (int) slot);
                    String lb = slotLabel.get(slot);
                    if (lb != null) o.put("sim_label", lb);
                }
                rows.put(o);
            }
            c.close();
        }
        return rows;
    }
}
