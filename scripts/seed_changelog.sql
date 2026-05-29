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
   '#/admin', '🎙', NOW())
) AS v(category, title, body, link, icon, created_at)
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE changelog.title = v.title);
