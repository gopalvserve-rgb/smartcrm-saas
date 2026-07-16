# 🔒 LOCKED — do not edit without an explicit instruction naming the file

**Standing order from Gopal, 2026-07-15:** *"Insure There Should not Be Any Changes in Current,
Recording setup, Call Activity … better Make them Lock."*

These subsystems are **working and verified in production**. They took a week of live debugging
to get right (phantom calls, Doze delays, direction truth, SIM mapping, the partial-index insert,
lead mis-attachment). They are **off-limits** to incidental edits.

## The locked set

| File | What it owns | Verified |
|---|---|---|
| `routes/recordings.js` | recording upload/list/relink, `api_call_hasRecentEvent` (the upload gate), `maybeAutoCreateLeadFromCall` | 2026-07-15 |
| `routes/callLogSync.js` | `api_call_logSyncBatch`, dedup, repair, live-twin demote, autolead backfill | 2026-07-15 |
| `routes/reports.js` | `api_reports_callActivity` — the Call Activity page | 2026-07-14 |
| `routes/team.js` | Live Team Status (reads `call_events` RAW — zero `src` refs, keep it that way) | 2026-07-14 |
| `public/tenant/callSettings.js` | SIM 1/SIM 2 + direction checkboxes + Call Activity chips | 2026-07-13 |
| `public/tenant/callLogSync.js` | auto-sync on open, 3-day lookback (BACKSYNC_HEAL_v1) | 2026-07-13 |
| `cap-app/.../PhoneStateReceiver.kt` | live call events, CallLog truth | user-approved lock |
| `server.js` → `/api/recordings` | the multipart upload endpoint | 2026-07-14 |

## The rules

1. **Do not touch these to make an unrelated feature work.** If a change *seems* to need it,
   stop and ask — that instinct has been wrong every time so far.
2. **Recording auto-sync stays dead.** All four background triggers were killed by the user on
   2026-06-06. Manual sync only. Do not re-enable. (`rec_autosync_kill`)
3. **`team.js` must contain ZERO `src` references.** It reads `call_events` raw on purpose —
   Live Team Status needs the live rows the reports layer filters out. Only the *reporting*
   layer filters on `src`.
4. **Never delete a live row — demote it** (`src='live-dup'`). Deleting breaks Live Team Status
   and the recording gate. This was nearly shipped once; the user caught it.
5. **Additive only, if you must.** New method / new endpoint alongside. Never rewrite in place.
6. **Prove it, don't claim it.** Before AND after any nearby change, hash these files and diff.
   `md5sum` them and show the user the result.

## Why this file exists

Twice on 2026-07-14 a whole-file upload from a **stale local checkout** silently reverted work
that was already on main (TKT_AUTOCLOSE_v1, ERRLOG_RETENTION_v1, the saas/transactions route,
LEAD_UPLOAD_WORKSPACE_COL_v1, APK_UPDATE_FIX_v2, LEADS_CARD_SELECT_v1, WA_TEMPLATE_VIEW_v1).
Nothing errored. The features simply vanished.

**RULE: never upload a whole file from the local checkout without diffing it against `main`
first.** The mounted folder is not a git clone and drifts silently.

```bash
curl -s "https://raw.githubusercontent.com/gopalvserve-rgb/smartcrm-saas/main/<path>" -o /tmp/main.js
diff /tmp/main.js <path>     # expect ONLY your intended change
```
