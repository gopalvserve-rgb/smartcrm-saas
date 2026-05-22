# 🔒 LOCKED FILES — Recording & Call Sync Pipeline

**Status:** Working. Repo state at commit `cc1ce49` (2026-05-22).
**Reference doc:** `../RECORDING_ARCHITECTURE_AND_LOCKDOWN.md` (workspace root)

These files are mission-critical for call event ingestion and recording
upload. Any change to them can stop recordings from reaching the CRM,
which is a customer-visible regression.

## The rule

**Before editing any file below, the developer (or AI assistant) MUST:**

1. Read `RECORDING_ARCHITECTURE_AND_LOCKDOWN.md` at the workspace root.
2. Ask the user explicitly: *"This touches the recording sync pipeline.
   Are you sure you want to change it?"*
3. Make the smallest possible patch — one file at a time.
4. Bump APK `versionCode` if a native file changed.
5. Bump cache-bust `?v=` in `index.html` if app.js / caller-id-native.js changed.
6. End-to-end test with a real call before declaring done.

**Do NOT** clean up imports, "refactor for readability", reorder branches,
add new validation, or tighten dedup logic on these files without explicit
user approval. The current behaviour is the result of multiple iterations
and OEM-specific workarounds; small changes have outsized impact.

## Protected files

### Android / APK
- `cap-app/android/app/src/main/java/app/leadcrm/mobile/PhoneStateReceiver.kt`
- `cap-app/android/app/src/main/java/app/leadcrm/mobile/RecordingsBackgroundSyncWorker.kt`
- `cap-app/android/app/src/main/java/app/leadcrm/mobile/CallerIdPlugin.kt`
- `cap-app/android/app/src/main/java/app/leadcrm/mobile/LeadCRMNativePlugin.kt`
- `cap-app/android/app/src/main/java/app/leadcrm/mobile/MainActivity.java`
- `cap-app/android/app/src/main/AndroidManifest.xml`
- `cap-app/android/app/build.gradle` (versionCode / versionName / WorkManager deps)

### Server
- `server.js` — `/api/recordings` POST handler block (~line 1022-1340)
- `server.js` — AI Call Summary worker (~line 2480-2517)
- `server.js` — `/api/recordings/:id/audio` playback / `/verify` / `/info` (~line 1345-1700)
- `routes/recordings.js` (entire file)
- `routes/call.js` (if present)
- `utils/audioTranscode.js`
- `utils/aiCallSummary.js`

### SPA
- `public/tenant/app.js` — `syncRecordings()`, `_silentSyncRecordings()`,
  `startRecordingAutoSync()`, `_kickRecordingSyncSoon()`, `_recDiagLog()`,
  `parseRecordingFilename()`, the `recordingsBlock()` UI
- `public/tenant/caller-id-native.js` (entire file)
- `public/tenant/index.html` — script-injection block + cache-bust versions

### Database tables (don't drop / rename / re-type columns)
- `lead_recordings`
- `call_events`
- `leads.phone`, `leads.whatsapp`, `leads.extra_phones`

### Tenant config keys (don't rename)
- `AI_TRANSCRIPTION_ENABLED`
- `CALLS_AUTOLEAD_INBOUND` / `CALLS_AUTOLEAD_OUTBOUND` / `CALLS_AUTOLEAD_STATUS_ID`

### Android SharedPreferences keys (don't rename)
- `rec_folder_uri` (SAF tree URI)
- `rec_bg_base_url` (upload server)
- `rec_bg_token` (upload JWT)
- `crm_token` (logged-in user JWT)

## What "touching" means

You "touch" a locked file by any of:
- Adding / removing / renaming a function or variable
- Changing a string / regex used in matching
- Adding / removing an import
- Changing a numeric constant (timeout, delay, watermark, retry count, etc.)
- Reordering branches in an `if` / `when` block
- Modifying a SQL query
- Changing a permission entry in AndroidManifest
- Bumping a dependency version that includes a recording-relevant library

If you must change something here, do so as a tiny, targeted, well-tested
diff — and add an entry to the change log in
`RECORDING_ARCHITECTURE_AND_LOCKDOWN.md`.

