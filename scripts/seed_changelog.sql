-- CHANGELOG_v1 one-shot backfill (2026-05-28)
-- Idempotent: only inserts if the title doesn't already exist.
INSERT INTO changelog (category, title, body, link, icon, created_at)
SELECT * FROM (VALUES
  ('feature', 'What''s New panel',
   'Top-right gift icon now opens a timeline of every CRM update under three tabs: New Feature, Issue Resolved, and Upgrade / Modify. Stored for 1 year.',
   NULL, '🎁', NOW()),

  ('feature', 'Live Team Status widget',
   'Real-time caller-wise status of every employee on the dashboard: On Call · Just hung up · On Break · Idle · Checked out · Offline · Never logged in. Pinned to the top of the dashboard. Shows last call / last activity time per user. Refreshes every 20s.',
   '#/dashboard', '🎧', NOW() - INTERVAL '6 hours'),

  ('feature', 'Quick date-range presets everywhere',
   'A chip bar — Today / Yesterday / Last 7 days / Last 30 days / This month / Last month / All time + Custom — now sits above every date picker on Leads, Reports, Call Activity, Activity Report, TAT, Report Builder and the Dashboard. ⭐ Save as default per page.',
   '#/dashboard', '📅', NOW() - INTERVAL '12 hours'),

  ('modify', 'Custom Dashboard — drag & drop',
   'Customize mode replaces ▲/▼ move buttons with real drag-and-drop. Grab the ⋮⋮ handle on any card and drop it where you want; an indigo bar shows where it''ll land. Cards still resize (↔) and remove (🗑) on the same header strip.',
   '#/dashboard', '🪄', NOW() - INTERVAL '14 hours'),

  ('feature', 'Call Activity — Direction + Duration filters',
   'New chip bar above Recent calls lets you filter by Incoming / Outgoing / Missed and by duration buckets (No-answer, <30s, 30s-2m, 2-5m, 5m+). Combines with bulk-convert to add filtered subsets as leads.',
   '#/callactivity', '🔎', NOW() - INTERVAL '4 hours'),

  ('feature', 'Automation Condition — multi-operator rule builder',
   'Edit Automation modal now shows a proper rule builder with Field → Operator → Value. Operators: equals, not equals, contains, does not contain. Works on Status, Source, Product, Tag and every Custom Field.',
   '#/automation', '⚙️', NOW() - INTERVAL '20 hours'),

  ('feature', 'Permission onboarding — soft banner',
   'Mobile app no longer forces users back to the T&C / permissions screen if they skipped a permission. A small orange banner with a Fix button now appears at the top so users can still work.',
   NULL, '📱', NOW() - INTERVAL '22 hours'),

  ('feature', 'Tenant cap + extra-user pricing',
   'Super-admin Create Tenant modal now captures user cap, extra-user charge and billing period. Per-tenant gate ready for Users page.',
   NULL, '💰', NOW() - INTERVAL '26 hours'),

  ('fix', 'IndiaMART webhook diagnostics',
   'GET pings now log to error_logs with source=leadsource-ping; POST attempts log preview body + UA before auth so failed pushes are visible in the webhook log viewer.',
   NULL, '🔧', NOW() - INTERVAL '24 hours'),

  ('fix', 'Celeste Excel download capped at 100',
   'Lead export now correctly returns up to 100,000 rows when you ask for all — was silently truncating to 100 regardless of page size.',
   NULL, '📊', NOW() - INTERVAL '28 hours'),

  ('fix', 'Social Comments — Facebook tab crash',
   'Fixed ''operator does not exist: text = integer'' error on Social → Comments → Facebook. Platform filter now casts to text correctly.',
   '#/social', '🛠', NOW() - INTERVAL '30 hours'),

  ('fix', 'Live Team Status — all users showing Never logged in',
   'Fixed three root causes: column was ''event'' not ''event_type'' in call_events; api_login never wrote last_login_at; team route now treats lead_actions + attendance + call_events as effective login signals.',
   '#/dashboard', '🐛', NOW() - INTERVAL '1 hour'),

  ('fix', 'Custom Dashboard — Add widget didn''t stick',
   'When you picked a widget from + Add widget it appeared briefly then vanished because re-render re-fetched the server layout. Edit-mode now keeps an in-memory working copy until you click Done.',
   '#/dashboard', '🪛', NOW() - INTERVAL '16 hours'),

  ('modify', 'Recent Calls feed — toolbar polish',
   'Bulk-action toolbar now operates on the FILTERED subset, so filter Missed + 0s and click Select all unlinked to mass-convert misses as leads.',
   '#/callactivity', '✨', NOW() - INTERVAL '3 hours'),

  ('modify', 'Team Live — richer per-user lines',
   'Cards now show role next to name, plus a contextual tail line: ''with +911206...'' for active calls, ''Last activity 5:14 pm'' or ''Last dialed 5:19 pm'' for everyone else.',
   '#/dashboard', '📞', NOW() - INTERVAL '2 hours'),

  ('feature', 'Industry pack fields in Automation rules',
   'Edit Automation Condition rule-builder now exposes Enrollment status / Fee paid % / Has overdue fee / Parent phone when the Education pack is installed, and Booking stage / Has active booking / Unit type / Demand overdue when the Real Estate pack is installed. You can build automations that fire only for specific pack states.',
   '#/automation', '🧩', NOW() - INTERVAL '1 hour'),

  ('feature', 'Universal pipeline stages on every Status',
   'Settings → Statuses now has a 🚦 Stage column. Map each of your tenant statuses to one of 7 universal stages: Fresh Lead, Attempted / Contacted, Connected & Qualified, Negotiation, Proposal / Payment Link Sent, Won, Lost. Phase 2 (coming next) will use these to power a new funnel pipeline view + Dashboard widget that works the same across every tenant and pack.',
   '#/settings/statuses', '🚦', NOW() - INTERVAL '20 minutes'),

  ('fix', 'Status stage save now actually persists',
   'When you picked a Stage and clicked save, the toast said Saved but the value was silently dropped because db/pg.js _serialize() filters every column against a hard-coded whitelist that did not include the brand-new stage column. Fixed both layers — schema whitelist plus a raw SQL belt-and-braces UPDATE in the route. Existing mappings now stick across refresh.',
   '#/settings/statuses', '🐛', NOW() - INTERVAL '15 minutes'),

  ('feature', 'Sales pipeline funnel view + Dashboard widget',
   'Pipeline page now opens with a true funnel: a KPI strip (total leads, open value, win rate, avg cycle), 5 descending bands (Fresh → Attempted → Qualified → Negotiation → Proposal) with dashed connectors to right-side labels, and Won / Lost cards at the bottom. Click any band and you jump to a Leads list filtered by that stage. Same view is available as a Dashboard widget — pick it from + Add widget under the Pipeline group. The old card-grid Kanban is still there as a Switch-to-Kanban escape hatch.',
   '#/pipeline', '📈', NOW() - INTERVAL '10 minutes'),

  ('fix', 'Pipeline funnel — won_at column error',
   'Pipeline page was throwing Could not load funnel: column won_at does not exist because the new aggregator assumed a column the leads table never had. Switched the avg-cycle calculation to use last_status_change_at on won leads instead. Pipeline + Dashboard funnel widget now load cleanly.',
   '#/pipeline', '🐛', NOW() - INTERVAL '20 minutes'),

  ('modify', 'Pipeline funnel — redesigned to match reference',
   'Funnel is now compact and fits the page: connected SVG trapezoids whose widths are data-driven (top edge of each band = next band start), tighter stacking, smaller KPI strip, Won/Lost cards visible without scrolling. Right-side dashed connectors and X leads / value / advance labels now align with each band.',
   '#/pipeline', '🎨', NOW() - INTERVAL '5 minutes'),

  ('fix', 'Live Team widget — empty state',
   'On some tenants the Live Team widget showed only the header with an empty body. Now it renders one of three meaningful messages: an error pill if the API returns nothing, a setup hint if the route is missing, or a friendly No team activity right now message when no users have logged in or made a call recently.',
   '#/dashboard', '🌙', NOW() - INTERVAL '5 minutes'),

  ('fix', 'Live Team widget — restore on tenants where it disappeared',
   'After earlier dashboard edits some tenants (shipuncle, others) lost the Live Team widget because the auto-inject one-shot localStorage flag had already fired against the v4 key. Bumped to v5 so it re-runs once for every user — if your saved layout doesn''t already include team_live_status it gets prepended back to the top of the dashboard. Tenants that explicitly removed it can do so again after this re-add.',
   '#/dashboard', '🟢', NOW() - INTERVAL '15 minutes'),

  ('feature', 'Pipeline funnel — filter bar',
   'Pipeline page now has a filter bar above the funnel: Date From/To, Status, Source, Owner, Product and Campaign multi-select dropdowns plus an X Clear all button. Filters apply to KPIs, funnel bands and Won/Lost counts and are passed to the backend so the aggregator only counts matching leads.',
   '#/pipeline', '🔎', NOW() - INTERVAL '5 minutes'),

  ('fix', 'Pipeline — Switch back to Funnel view',
   'Once you clicked Switch to Kanban there was no way to switch back to the funnel — the button on the Kanban view still said Switch to Kanban which did nothing. Replaced it with 📈 Switch to Funnel view that clears the force flag and re-renders the funnel.',
   '#/pipeline', '🔄', NOW() - INTERVAL '2 minutes'),

  ('modify', 'Pipeline funnel — minimum band width for readability',
   'On heavily-skewed pipelines (e.g. 1072 New / 127 Contacted / 54 Qualified / 18 Negotiation / 15 Proposal) the lower bands were collapsing to under 100px wide and the labels were getting truncated. Raised the minimum band width to 38% so every label fits cleanly while the top band still renders at its real 100% so the funnel still narrows.',
   '#/pipeline', '📐', NOW() - INTERVAL '3 minutes'),

  ('feature', 'Pipeline funnel — date preset chips',
   'Filter bar on the pipeline funnel now includes one-click date presets: Today, Yesterday, Last 7 days, Last 30 days, This month, Last month, All time. Click a chip and the From/To inputs auto-fill and the funnel re-aggregates. The ⭐ Save default lets you pin one preset as your tenant''s default range.',
   '#/pipeline', '📅', NOW() - INTERVAL '5 minutes'),

  ('feature', 'Stage filter on Leads + Reports + Stage column on leads list',
   'Universal pipeline Stage is now a first-class filter on the Leads page and the Reports page. Pick one or more stages (Fresh / Attempted / Qualified / Negotiation / Proposal / Won / Lost) and the list/report scopes to leads whose status is mapped to those stages. The leads table also shows a coloured Stage pill on every row so you can see at a glance where each lead sits in the pipeline.',
   '#/leads', '🚦', NOW() - INTERVAL '5 minutes'),

  ('feature', 'Leads page — Filter rule button with exclude operators',
   'Added the + Filter rule button to the Leads page toolbar (already present on Reports, Report Builder, Pipeline, TAT, Follow-ups). Click it to build advanced rules with is not equal to, does not contain, is empty, has any value, is not one of, greater than, less than, between — across Name, Phone, Email, WhatsApp, Company, Source, Product, Status, Stage, Tag, City, Notes, Value, Assignee, and every custom field. Multiple rules combine with AND. Rules persist per device in crm.leads.rules.v1.',
   '#/leads', '🔍', NOW() - INTERVAL '5 minutes'),

  ('fix', 'Stage column now actually showing on Leads page',
   'Stage column was registered in the column catalog but existing users had a saved column list pre-dating it, so it never appeared. One-shot auto-injects Stage right after Status for every user; new tenants get it in the hard-coded default. Stage column can still be removed from the ☰ Columns picker.',
   '#/leads', '🚦', NOW() - INTERVAL '3 minutes'),

  ('feature', 'Sidebar collapse / expand toggle on desktop',
   'The ☰ icon in the topbar now collapses and expands the left sidebar on desktop too (it was mobile-only before). Click to hide the menu and get more horizontal room for the leads table, click again to bring it back. State persists per device in crm_sidebar_collapsed.',
   '#/dashboard', '⇆', NOW() - INTERVAL '5 minutes'),

  ('feature', 'What''s new tutorial — auto-shows once for admins + managers',
   'On first login today every admin and manager sees a one-time What''s new modal walking through Live Team Status, the new Pipeline funnel, and the action item to map their Statuses to universal Stages. Each step has a Take me there button that jumps to the right page. A ✨ New features pill is added to the topbar so the tour can be re-opened later. The red dot disappears after the user opens the tour once.',
   '#/dashboard', '✨', NOW() - INTERVAL '3 minutes'),

  ('feature', 'Dashboard — 🔄 Refresh button',
   'Added a Refresh button to the Dashboard header next to Customize. Click it to clear the cached summary / notifications / funnel / TAT data and re-fetch everything. Useful when you''ve just changed a status or made a call and want the KPI tiles + widgets to reflect it without having to hard-reload.',
   '#/dashboard', '🔄', NOW() - INTERVAL '15 minutes'),

  ('feature', 'Performance diagnostics (⚡ panel)',
   'New ⚡ icon in the topbar opens a Performance diagnostics panel. Captures every API call''s duration, flags anything over 1 second as slow with a red badge count, surfaces the top 15 slowest endpoints by average + top 20 slowest individual calls, plus long-task and memory snapshots. Hit Ctrl+Shift+P to open the panel any time. Use the 📋 Copy JSON button to grab a dump and send to support when the CRM feels sluggish — we''ll be able to pinpoint exactly which API or view is causing the hang.',
   '#/dashboard', '⚡', NOW() - INTERVAL '5 minutes'),

  ('feature', 'Performance diagnostics — Send to support button (APK-friendly)',
   'Mobile users can''t open DevTools so the ⚡ panel now has a 📤 Send to support button that uploads the diagnostic dump directly to the server in one tap. The dump also includes Capacitor / APK flags, network type, online state, viewport size, and lifecycle events (pause/resume/visibility) so we can spot APK-specific issues like the WebView pausing during a hang.',
   '#/dashboard', '📤', NOW() - INTERVAL '5 minutes'),

  ('feature', 'Performance diagnostics — server-side + auto-upload',
   'Two passive instruments added so we can see slowness WITHOUT the user reporting it. (1) Server side: the tenantApi dispatcher now times every handler. Anything >=1000ms gets logged into Railway as [PERF_SLOW_API] with fn, ms, tenant, user. An in-memory tally is exposed at /api/perf-summary returning the top-20 slowest endpoints and top-20 slowest tenants since the last redeploy. (2) Client side: the SPA now auto-POSTs the diagnostic dump to /api/perf-report once the user hits 3 slow calls or 1 very-slow (>=3s) call in a session, throttled to once per 10 minutes. No tap needed.',
   '#/dashboard', '📡', NOW() - INTERVAL '20 minutes'),

  ('feature', 'Live Team Status — admin-defined offline tasks (Demo, Meeting, Lunch…)',
   'Admins can now define their own offline statuses at Settings → Automation → 👥 Team statuses. Each one has an emoji icon, a colour and a label (default starter set: 🎤 In Demo, 👥 In Meeting, 🍽 On Lunch, 📚 In Training). Every employee sees an I\u2019m currently bar at the top of their dashboard with a chip per status — one click and the Live Team Status widget shows that label and colour next to their name, exactly like On Call. Click the chip again or Clear to come back to Idle. On-call calls still beat a manual task in the widget so an active phone call is always visible.',
   '#/dashboard', '🟣', NOW()),

  ('feature', 'Settings → 🩺 Backend health — see exactly which API is slow',
   'New tab in Settings for admins and managers. Shows top-20 slowest backend endpoints by average response time, top slow tenants, the last 100 ≥1-second calls, and every client-uploaded diagnostic dump (browser / APK) with the top slow APIs from that session, long-task count, memory usage and the view the user was on when they hit support. Auto-refreshes every 15 seconds. Now you can answer ''what was slow for Harsh just now'' without grep-ing Railway logs.',
   '#/admin', '🩺', NOW()),

  ('fix', 'WhatsApp campaigns — Delivered / Read counters now move + click "Failed" to see why',
   'Two long-standing campaign bugs fixed. (1) Even when WhatsApp confirmed the message was delivered and read, the campaign row stayed at Delivered 0 / Read 0. The Meta status webhook was updating each recipient row but never bumping the parent campaign counter — now it does, with idempotence so a target that goes delivered → read does not double-count. (2) When a campaign showed Failed 2 of 2, there was no way to see why. The Failed number is now a clickable red link that opens a modal listing the top 3 error reasons grouped by frequency, plus a cheat-sheet for the common Meta error codes (132001 = template language mismatch, 131026 = recipient not on WhatsApp, 132000 = template variable count mismatch, 100/190 = expired access token).',
   '#/whatsbot/campaigns', '📊', NOW()),

  ('fix', 'Automation — Send email on new lead now actually fires',
   'Automations with the Lead-created event were logging skipped — condition not met for every newly-created lead, even when the rule was Source equals Facebook or Status equals New. Cause: the lead context only had raw IDs (status_id, product_id) while the matcher reads names (status_name, product_name). The matcher now denormalizes IDs into names + merges extra_json so custom-field rules (cf_*) match too. The skipped log line also explains which clause failed and what the actual value was — e.g. skipped — condition not met — failed rule: status eq "New" — actual was "Follow Up".',
   '#/settings', '⚡', NOW() - INTERVAL '10 minutes'),

  ('fix', 'WhatsApp Inbox — back arrow now returns to the chat list',
   'The ← back button at the top of a WhatsApp Inbox conversation wasn''t doing anything. The list-of-threads renderer had a flicker-prevention optimization that early-returned when the cached signature hadn''t changed — and opening a thread doesn''t change the signature, so it stayed cached and the renderer never repainted on the way back. The back button now clears the cached signature and the thread view before re-rendering, so it actually slides you back to the inbox list.',
   '#/dashboard', '↩️', NOW()),

  ('fix', 'Recording sync — APK v1.9 fixes the "sync stops after a while" loop',
   'Employees were reporting recording sync would work right after picking the folder, then stop a few minutes later until they re-picked. Root cause: yesterday''s v1.8 fix (PERM_FOLDER_PERSIST_FIX_v1) saved the folder URI to prefs BEFORE trying to take a persistable permission. If the persistable-permission call silently failed (common on SD-card / scoped-storage / OEM-quirk folders), the URI was only valid for the current process. The moment Android killed the app and the background WorkManager spawned a fresh process, the folder couldn''t be re-opened and the worker exited. v1.9 inverts the order: take the persistable permission FIRST, save to prefs only if it succeeded. If it failed, show a clear toast telling the employee to pick a folder under Internal Storage (not SD card / not Recents). The background worker also self-heals — if it ever finds a stale unreachable URI in prefs, it clears it so the onboarding card honestly shows "not done" instead of pretending everything is fine.',
   '#/admin', '🎙', NOW()),

  ('feature', 'Recordings — manual Sync Today / Yesterday / Last 7 days',
   'Three new safety-net buttons on Settings → Call Recordings. Tap "📅 Sync today" to re-scan and upload every recording your phone made since midnight; "📆 Sync yesterday" for the previous full day; "📈 Sync last 7 days" to catch up after a long offline stretch. Each one ignores the auto-sync watermark and the upload-already-done markers, so even files the app thinks it has handled get re-uploaded; the server then matches them to leads by phone number / filename / timestamp as usual. Great evening or morning routine — pick a button, watch the progress count, done.',
   '#/dialer-settings', '📆', NOW()),

  ('fix', 'Performance — 14.7s WhatsApp unread-counter rewritten + pool freed',
   'The badge on the WhatsApp icon (and the bell-icon poll on every page navigation) was running api_chat_unreadCount which loaded EVERY row from chat_rooms + chat_room_members + chat_messages on every call, then filtered in JavaScript. On a busy tenant this averaged 14.7 seconds and stalled the entire postgres pool — every other API (recordings AI summary, leads list, notifications, IVR) waited behind it. Rewrote as a single indexed COUNT query that runs in under 50 ms even on tenants with 100K+ messages. Recording AI summary calls that previously took 5–10 seconds should now return in under 100 ms because they are not queueing behind chat anymore. Also added two indexes on chat_messages(room_id, created_at) and chat_room_members(user_id) for good measure.',
   '#/admin', '⚡', NOW()),

  ('fix', 'AI Call Summary — desktop only, skipped on mobile app',
   'The 🤖 AI Summary panel was polling the server every 10 seconds up to 18 times for EVERY recording rendered, even on the Android app where reps almost never read summaries (they are out making calls). On a busy session the APK was generating 150+ polls in a few minutes, hammering the database pool and burning Gemini quota for an audience that does not use the feature. From now on the panel is desktop-only. On the Android app you will still see "Rate this call" stars (so reps can flag good or bad calls from the phone) plus a small note that AI summary is on desktop. The server-side worker keeps processing recordings in the background, so when you open the same call on desktop later the summary is already ready — no waiting.',
   '#/recordings', '🖥', NOW()),

  ('fix', 'Team chat — every poll is now indexed SQL instead of full-table scan',
   'The internal team chat (sidebar list of rooms, the open conversation, and the "Recent unread" popup) was loading every row from chat_rooms, chat_room_members AND chat_messages on every poll — even though the average user only has a handful of rooms and reads the last 200 messages. On busy tenants this scaled badly and blocked the database pool for everyone else. Rewrote the three hot endpoints (api_chat_rooms_list, api_chat_messages_list, api_chat_recent_unread) as targeted indexed queries: rooms list runs a DISTINCT ON for the latest message per room + a tiny per-room COUNT for unread; the open conversation uses ORDER BY created_at DESC LIMIT 200; the popup uses one JOIN + LIMIT 10. Same behaviour from your point of view — just much faster, especially on the mobile app where the chat dock polls every few seconds.',
   '#/chat', '⚡', NOW()),

  ('feature', 'Attendance — admin can require selfie + meter reading on check-in/out',
   'New tab in Attendance → ⚙️ Settings (admin only) lets you turn on two optional capture steps for every check-in and check-out. (1) Selfie — opens the front camera, snaps a live photo. Stops time-fraud where an employee marks attendance from a friend or family member''s phone. (2) Meter reading — a numeric input you can label "Odometer (km)", "Electricity meter", "Water meter", or whatever fits your business. Useful for drivers, field staff, vehicle assignments. Both are off by default. Toggle either ON and every employee will see the capture step before their check-in completes; the system blocks check-in if the required value is missing. Existing GPS location requirement is unchanged.',
   '#/attendance', '📸', NOW()),

  ('feature', 'Location Tracking — Live team map + Day trail with replay',
   'New section in the sidebar under HR & Me: 🗺️ Location tracking. Two tools.

(1) 📍 Live team map — every employee currently checked in shown on a single map with a colour-coded status badge: 🚗 driving, ⏸ stopped (since X min), 💤 idle, 📴 offline. Click any pin to see their location, today''s km, last ping age, and a link to jump straight to their day trail. Auto-refreshes every 60 seconds.

(2) 🛣 Day trail — pick an employee and a date, get a full breakdown: total km driven, halt count and duration, max speed between pings, every halt longer than 5 minutes shown as a table (with Google Maps link) and as a pin on the route. ▶ Play replay button animates a 🚗 marker along the route so you can watch the day unfold like a video. Check-in pin (🟢) and check-out pin (🔴) anchor the start and end.

GPS pings now fire every 10 minutes while checked in (was 30 minutes) so the trail has enough resolution for the replay to feel smooth.

✨ Roadmap coming next: geofence around customer addresses → auto-log "visited lead X" when an employee stops at a known lead location; weekly distance summary email; reimbursement CSV export; idle alerts.',
   '#/tracking', '🗺️', NOW()),

  ('feature', 'Travel reimbursement — auto-calculated from GPS km × admin rate',
   'New tab on Location tracking → 💰 Reimbursement. Admin sets a per-kilometre rate (e.g. ₹1, ₹1.50, ₹3) and a master ON/OFF toggle. The system then takes the km already computed for the Day Trail and multiplies by the rate to give a cash amount per day, per employee, per month.

For admins / managers: a team table for the chosen month showing each employee''s total km and amount, sorted highest first, plus a total payable across the team. Click a row to drill into that employee''s per-day breakdown. One-click "Mark as paid" toggle records who you have already paid out for the month.

For employees (sales / regular users): a personal dashboard showing their own total km, the rate, the amount they have earned this month, and a day-by-day breakdown so they can verify each day was tracked correctly. Cannot edit, cannot mark paid — view only.

No new schema. Reuses the existing location_pings + attendance tables. Zero double-counting — the same haversine sum that powers Day Trail powers this number.',
   '#/tracking', '💰', NOW()),

  ('fix', 'Performance — recording-sync preflight no longer hangs the app',
   'After this morning''s chat fix landed, a different endpoint took over as the slowest one: api_recordings_filenamesPresent (the preflight that asks the server "which of these recording files are already uploaded?"). On busy tenants it was averaging 32.7 seconds per call, and a single mobile sync session was firing it 12 times — each one timing out at the Railway 71-second gateway limit. Every other API queued behind it: chat unread, leads list, notifications, announcements all topped out at the same 71-second mark. Root cause: the index on the original_filename column was created lazily by the upload handler, so tenants whose first upload predated the May-20 schema commit never got the index. The endpoint was sequential-scanning the whole lead_recordings table on every preflight, including its giant BYTEA audio_bytes column. Fix: module-level "ensure-once" guard runs CREATE INDEX IF NOT EXISTS on the very first call after restart, drops the redundant DISTINCT (the upload path already dedupes), and now throws on query error instead of returning empty (which would have triggered the APK to re-upload every file).',
   '#/admin', '🛣', NOW()),

  ('feature', 'Mobile app — bigger, friendlier Dashboard / Leads / Follow-ups',
   'Mobile app polish pass. Everything on the Dashboard, Leads and Follow-ups pages is now bigger and easier to tap. Specifically: KPI numbers grew from 1.45rem to 1.8rem and got bolder; lead and follow-up cards got more padding and a softer shadow; lead names jumped from 1rem to 1.12rem (700 weight); the row of action buttons (📞 Call / 🟢 WA / 💬 My WA / 📅 Meet / 📝 Note / ✎ Edit / 🚫 Whitelist) now meets the 44px tap-target minimum that Apple and Google recommend so fingers don''t fight to hit them; the green Call button got a subtle shadow so it stands out; filter dropdowns are now 42px tall instead of compact; status chips, pagination buttons, and section headings all sized up. The Filters bar already auto-hides on mobile behind a "🔍 Filters" toggle — that toggle is now a prominent indigo pill so it''s obvious it''s there, with a tiny scale-down animation on tap.',
   '#/leads', '📱', NOW()),

  ('modify', 'Real Estate pack — 3 generic stage names renamed to RE-friendly labels',
   'When you install (or re-install) the Real Estate industry pack, the three generic statuses left over from the default seed are now renamed to match your sales flow: "Negotiation" -> "Site Visit Schedule", "Proposal / Payment Link Sent" -> "Site Visit done", "Won" -> "Token Received". Existing leads sitting on those old statuses keep their FK link (we rename the row in place, not delete-recreate), so historical reports do not break. To apply to tenants that already have the RE pack installed: super-admin -> open the tenant -> Industry Pack -> Install Real Estate again. Idempotent — re-running is safe.',
   '#/admin', '🏠', NOW())
,

  ('fix', 'Recording sync — preflight now fails open under load, no more app hang',
   'Yesterday''s morning fix targeted recording-sync preflight (api_recordings_filenamesPresent) by adding an index and a 60-second cache. Two phones tested today still showed it was the slowest endpoint — 119 seconds average on a Samsung Fold, 53 seconds on a Vivo — and every other API queued behind it. The reason: the 8-second statement timeout the previous fix promised was only described in a comment, never actually applied; and any error from this endpoint caused the entire APK sync attempt to fail (which is why Harsh''s first sync did not pick up any new recording but his second one did). New behaviour: (1) hard 5-second Postgres-level statement_timeout via SET LOCAL inside a real transaction, so the connection is guaranteed back in the pool inside 5 seconds — no more pool starvation. (2) Belt-and-braces JS-side Promise.race at 6 seconds in case the client itself stalls. (3) Fail-open — if the preflight times out or errors, the server returns "no duplicates found" silently and the APK proceeds with the upload. The server''s existing per-tenant unique index on filename then rejects actual duplicates with ON CONFLICT, so no recording is ever stored twice. End-user effect: sync completes reliably the first time, and Leads / Notifications / WhatsApp threads stop freezing while a sync is in flight.',
   '#/admin', '🛠', NOW())
,

  ('fix', 'Mobile app — slimmer payloads and far fewer background calls',
   'Two-part overhaul aimed at the slowness Vserve testers (Harsh on Samsung Fold, Neetu on Vivo) hit today.

Backend trimming on four heavy APIs when the request comes from the APK: api_leads_list now returns 25 rows per page (was up to 500), skips the per-page lead-activity rollup and skips the campaign-name join (mobile card does not show those anyway), and pulls remarks for just the visible 25 rows instead of scanning the whole remarks table. api_wb_chat_threads now reads 300 messages upstream (was 1000) and caps the returned thread list to 20 — when you scroll the WhatsApp inbox the SPA will request more. api_announcements_active caps at 5 banners and truncates each body to 500 characters. api_notifications_mine now SQL-scopes the remarks load to referenced leads only, caps the unread-notifications list to 50 rows from the last 7 days, and slices overdue/due_today/upcoming to 20 each. Together this drops a typical mobile response from 200-500 KB down to 15-30 KB, and removes two full-table scans per call.

Background-poll cuts on the APK. Floating-WhatsApp chat dock is now disabled on mobile entirely (it was firing api_wb_chat_threads every 8 seconds even when the drawer was closed). The follow-up / new-lead / WA-badge background pollers are no longer armed on the APK at all because FCM push already delivers new lead, follow-up due, WA inbound, TAT alerts, and heat alerts — there is nothing left for those 30-second polls to discover. The Team-Chat unread poller drops from every 10 seconds to every 60 seconds. The announcements refresh drops from every minute to every ten minutes. The recording auto-sync WebView tick drops from every 90 seconds to every 5 minutes — the native WorkManager already runs every 15 minutes plus once after every call. Net effect: idle background API rate on the APK drops from about 26 calls/minute to roughly 1 per minute, freeing the connection pool that recording-sync preflight had been hogging. Desktop behaviour is unchanged.',
   '#/admin', '📱', NOW())
,

  ('modify', 'Mobile header — cleaned up the icon strip',
   'On the phone the top-bar was getting cramped. Removed three items on screens narrower than 780px: the Get-app / Download button (you already have the app installed if you are seeing this on the phone), the Due-today calendar chip, and the Upcoming calendar chip — those follow-ups are still one tap away from the bottom-nav or the sidebar. Kept ✨ New, ⚠️ Overdue, 📘 Help, 🎁 What is new, 🔔 Notifications. The WhatsApp inbox icon (💬) is now painted in WhatsApp-green so it stands out as the chat shortcut. Desktop view is unchanged.',
   NULL, '📱', NOW())
,

  ('feature', 'Share a lead with a second user (manual + auto)',
   'Until now every lead had exactly one assignee. You can now show the same lead to a second user in their My Leads, with both able to fully work it (change status, add remark, call, WhatsApp). Two ways to set it up. (1) Manual — on any lead modal a new 🤝 + Share button opens a user picker; the picked user instantly sees the lead under their My Leads with a 🤝 badge next to the name. Either side can remove the share with the X on the chip. (2) Automatic — when you create or edit a Campaign there is a new 🤝 Auto-share every new lead in this campaign with picker. Pick a user there and every new lead created under that campaign is automatically shared with them too. The primary owner relationship is unchanged; co-owners are an additive layer. New tables and columns are created automatically on next request (lead_co_owners join table, plus campaigns.auto_share_user_id and sources.auto_share_user_id columns) so no migration is required.',
   '#/leads', '🤝', NOW())
,

  ('feature', 'Share leads in bulk',
   'The selection toolbar above the Leads list now has a 🤝 Share button right next to 👤 Assign. Tick the leads you want, click 🤝 Share, pick the second user, hit Share — every selected lead is now visible to that user under their My Leads with the 🤝 badge, and they can fully work all of them. Already-shared leads are silently skipped. Per-lead 🤝 + Share on the modal and the campaign Auto-share dropdown still work the same as before — this just adds a fast path for batches.',
   '#/leads', '🤝', NOW())
,

  ('feature', 'Source filter now lists every Source actually on your leads',
   'Two related fixes on Reports and Report Builder. (1) The Source dimension drop-down was only listing Sources that an admin had added via Settings → Sources. Tenants that get most of their leads through webhooks (Pabbly, Make, FB Lead Ads, Sheet sync) often never add anything manually under Sources, so the filter looked empty even though the leads carried sources like "facebook" or "indiamart". The Source list now also includes every distinct non-empty source value that currently sits on a lead — admin entries first, then auto-collected lead-sources after. (2) Pie / donut / bar charts on Reports were showing "undefined" in their tooltip and legend because the chart datasets had no label. Charts now read "Leads" in the legend / tooltip, and the redundant top legend is hidden on non-pie charts to give the bars more room.',
   '#/reports', '📊', NOW())
,

  ('feature', '💬 WhatsApp Report — volume, delivery, per-user, per-template',
   'New report under the Reports group in the sidebar. KPI tiles at the top: Inbound, Outbound, Delivered, Read, Failed, unique Contacts, plus computed Delivered % and Read %. A donut chart breaks the outbound volume into Read / Delivered (not yet read) / Sent (not yet delivered) / Failed. A daily line chart plots inbound and outbound volume over the selected date range. Two tables follow. By User — for every team member, total Sent, Delivered, Read, Failed and the corresponding %s, so you can spot the agents who are sending but not getting delivery, or whose recipients are not reading. By Template — same breakdown per template name, so you can see which template is healthy and which is being silently failed. Date range defaults to yesterday and respects the same Today / Last 7 / Last 30 chips that Reports already has. Data is pulled from whatsapp_messages so it covers every connected number and every conversation type.',
   '#/whatsappreport', '💬', NOW())
) AS v(category, title, body, link, icon, created_at)
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE changelog.title = v.title);
