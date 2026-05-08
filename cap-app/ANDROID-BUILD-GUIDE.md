# Lead CRM — Native Android app build guide

This builds a Capacitor-wrapped APK with **caller-ID popup + auto-add
lead + auto-attach call recording**, replacing the Bubblewrap TWA APK
that's currently shipped.

The app loads the live CRM (`https://crm.celesteabode.com/`)
inside a WebView and adds three native superpowers:

1. **Caller-ID popup** — a high-priority Android notification with the
   lead/customer name + status + value + last remarks the moment the
   phone rings.
2. **Auto-add lead** — inbound calls from unknown numbers ≥ 5 seconds
   long auto-create a lead with `source = "Inbound Call"` and the rep
   as owner.
3. **Auto-attach call recording** — when the OEM dialer drops a fresh
   `.m4a` / `.amr` file in the recordings folder, the app uploads it
   to `/api/recordings` linked to the call's lead.

---

## Prerequisites

| | Version |
|---|---|
| Node.js | ≥ 18 |
| JDK | 17 (Temurin recommended) |
| Android SDK | API 34+ (`build-tools` 34.0.0+) |
| Capacitor CLI | ≥ 6 (`npm install -g @capacitor/cli`) |
| Existing Celeste keystore | `celeste-build-secrets/android.keystore` |

---

## Step 1 — install Capacitor and add Android platform

From the repo root:

```bash
cd cap-app
npm install
npx cap add android
```

This generates `cap-app/android/` with Capacitor's standard scaffolding.

---

## Step 2 — drop in the custom plugin

Copy the four Kotlin files from `cap-app/native/plugin/` into
`cap-app/android/app/src/main/java/app.leadcrm.mobile/`:

```bash
# from repo root
mkdir -p cap-app/android/app/src/main/java/app.leadcrm.mobile
cp cap-app/native/plugin/CallerIdPlugin.kt        cap-app/android/app/src/main/java/app.leadcrm.mobile/
cp cap-app/native/plugin/PhoneStateReceiver.kt    cap-app/android/app/src/main/java/app.leadcrm.mobile/
cp cap-app/native/plugin/RecordingObserver.kt     cap-app/android/app/src/main/java/app.leadcrm.mobile/
cp cap-app/native/plugin/NotificationHelper.kt    cap-app/android/app/src/main/java/app.leadcrm.mobile/
```

Replace the auto-generated `MainActivity.java` with the snippet from
`cap-app/native/MainActivity-snippet.java` (it adds
`registerPlugin(CallerIdPlugin.class)` and the deep-link handler).

---

## Step 3 — merge AndroidManifest permissions

Open `cap-app/android/app/src/main/AndroidManifest.xml` and merge the
contents of `cap-app/native/AndroidManifest-additions.xml`. In short:

- Add the `<uses-permission>` lines at the top of `<manifest>`.
- The receiver is registered dynamically from Kotlin — no manifest entry needed.

---

## Step 4 — Capacitor config

`cap-app/capacitor.config.json` should already point at the Celeste
live URL. Verify:

```json
{
  "appId": "app.leadcrm.mobile",
  "appName": "Lead CRM",
  "webDir": "www",
  "server": { "url": "https://crm.celesteabode.com", ... }
}
```

---

## Step 5 — sync + build

```bash
cd cap-app
npx cap sync android
cd android
./gradlew assembleRelease \
  -PstoreFile=../../../mnt/Downloads/celeste-build-secrets/android.keystore \
  -PstorePassword=LeadCRM2026 \
  -PkeyAlias=android \
  -PkeyPassword=LeadCRM2026
```

Output: `cap-app/android/app/build/outputs/apk/release/app-release.apk`

Sign + zipalign:

```bash
cd ../../../mnt/Downloads/celeste-build-secrets/
$ANDROID_HOME/build-tools/35.0.0/zipalign -p 4 \
  ../../../lead-crm-stockbox/cap-app/android/app/build/outputs/apk/release/app-release-unsigned.apk \
  LeadCRM-aligned.apk
$ANDROID_HOME/build-tools/35.0.0/apksigner sign \
  --ks android.keystore --ks-key-alias android \
  --ks-pass pass:LeadCRM2026 --key-pass pass:LeadCRM2026 \
  --out LeadCRM.apk \
  LeadCRM-aligned.apk
```

Drop `LeadCRM.apk` into `lead-crm-stockbox/public/` to replace the
old TWA APK; the in-app `📱 Get app` modal already serves it from there.

---

## Step 6 — Play Store submission

The caller-ID + auto-record functionality uses **sensitive permissions**
(`READ_PHONE_STATE`, `READ_CALL_LOG`). Google reviews these manually,
which adds 2-3 weeks to launch.

Required for the Play Console submission:

- **Privacy policy URL** linked in the listing — explain that:
  - phone numbers are sent to your server only when a call is in
    progress, and only to do the lead lookup
  - call recordings are read from the user's chosen folder and
    uploaded to the user's own CRM, not to a third party
  - the rep can revoke any of these permissions in Android Settings
    without breaking the app
- **Sensitive Permission Declaration** form filled out:
  - Use case: "CRM caller-ID for sales team — show the matching
    customer record when their phone rings"
  - Demo video: 30-second screencast of an inbound call → notification
    appears → rep taps → lead detail opens
- **Limited User Data Use disclosure** — phone state + call log are
  used only for the documented caller-ID + call-log features, never
  shared with advertisers or other third parties.

Google often asks for 1-2 rounds of clarification. Reply within 7 days
each time to keep the queue moving.

---

## Step 7 — testing checklist before shipping

- [ ] Inbound call from a known lead → notification shows lead name + status + last remark
- [ ] Inbound call from unknown number, answered for ≥ 5s → lead auto-created with phone as name
- [ ] Inbound call from unknown number, answered < 5s → no lead, just call_event row
- [ ] Missed call from known lead → followup scheduled, `missed_call_followup` WhatsApp template fires (if approved)
- [ ] Outbound call → call_event logged, no notification (rep already has context)
- [ ] OEM dialer drops `.m4a` in `Recordings/Calls/` → app uploads it to `/api/recordings` with the right `lead_id`
- [ ] Notification tap with deep-link → app opens at `/#/leads?id=X` directly
- [ ] Permissions revoked in Settings → app falls back gracefully, no crash

---

## Why we use the existing Bubblewrap APK alongside this Capacitor one

Some teams prefer the lighter TWA experience for general CRM use and
only need caller-ID on the rep's primary phone. Both APKs can coexist
on the device — they have different package names and they share the
same web app at the same URL, so the rep's session and data are unified.

If you'd rather replace the TWA entirely with the Capacitor APK, just
update the `📱 Get app` modal to point at the new APK file path.
