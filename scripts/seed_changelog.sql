INSERT INTO control.changelog (title, body, kind, ship_date, is_published)
VALUES (
  'WA Campaign — direct Excel upload',
  'New "Upload Excel of recipients" section on the WhatsApp Campaign creator. Drop an .xlsx / .csv with columns phone, name, var1, var2, var3 — phones not already in Leads are auto-created with source "WA Campaign Upload", and var1/var2/var3 flow into the template variables for each recipient. A "Download template" button gives a pre-filled sample file.',
  'feature',
  CURRENT_DATE,
  1
)
ON CONFLICT DO NOTHING;

-- 2026-06-06 REC_AUTOSYNC_KILL_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'modify',
       'Recording auto-sync disabled',
       'Stopped the silent recording sweep that ran every time you opened the app (and the yellow "No NEW recordings since X min ago" alert). On Android, also disabled the 15-min background WorkManager and post-call auto-upload. Recordings now upload only when you press Sync now / Sync today / Sync yesterday / Sync last 7 days / Re-sync all on the Recordings page.',
       '🛑',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Recording auto-sync disabled');

-- 2026-06-06 TUTORIAL_PAGE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'SmartCRM Tutorial — built-in client training page',
       'New 5-module interactive tutorial covering every CRM feature: Onboarding · Lead Lifecycle · WhatsApp · Automation & AI · Daily Operations. Open it from Help & Support → SmartCRM Tutorial, or share the public link /tutorial with new team members. Print-to-PDF works in one click.',
       '📚',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'SmartCRM Tutorial — built-in client training page');

-- 2026-06-06 ATTENDANCE_OPTIONAL_DEFAULT_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'modify',
       'Attendance: selfie + meter reading are now optional',
       'Stopped the "Meter reading must be a number" error blocking field check-ins. Both selfie and meter reading are now OFF by default for every tenant. If you want either compulsory, turn it on from Settings → Attendance. We also loosened meter validation so non-numeric inputs (e.g. "ABC-1234", "123 km") are accepted.',
       '🟢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Attendance: selfie + meter reading are now optional');

-- 2026-06-06 CAMPAIGN_REPORT_CREATED_AT_AMBIG_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Campaign Report — fixed "column created_at is ambiguous" error',
       'The dedicated Campaign Report page was failing with "column reference created_at is ambiguous". Root cause: the shared WHERE clause joined leads with users + campaigns tables, both of which also have a created_at column. Now every column in the report SQL is qualified with the leads alias (l.created_at, l.assigned_to, etc).',
       '🐛',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Campaign Report — fixed "column created_at is ambiguous" error');

-- 2026-06-06 DASH_MOBILE_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Dashboard mobile UI — fixed donut, funnel, Sale Closure Stages overflow',
       'Three mobile dashboard fixes: (1) Distribution by status donut no longer pushed off-screen — legend moves below the chart on phones. (2) Sales pipeline funnel no longer clipped — right-side label panel is dropped on phones, count + value go inline in each band. (3) Sale Final Closure Stages cards now wrap to 2 columns on phones instead of getting clipped off the right edge.',
       '📱',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Dashboard mobile UI — fixed donut, funnel, Sale Closure Stages overflow');

-- 2026-06-07 META_MODULE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Meta Ads Manager + Facebook & Instagram polished',
       'New Marketing sidebar group surfaces Ads Manager, Facebook & Instagram DMs, Comments, and Post Publisher. Settings → Integrations now shows two clear cards for Meta Ads Manager (Marketing API badge, Sandbox Mode form, per-Page enable toggles, Reconnect/Disconnect) and Facebook & Instagram messaging (No Pages Connected empty state + Connect with Facebook). Ads Manager page polished with header buttons (Refresh, Meta Business Suite, Export All CSV, + Create) and 6-tile KPI strip (Spend, Impressions, Clicks, Reach, CTR, Avg CPC). When Meta connect fails with a permission error, a modal lists every required scope so admins can cross-check the Meta app dashboard.',
       '📣',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Meta Ads Manager + Facebook & Instagram polished');

-- META_MODULE_v1.1 — fix stuck Loading on /socialads
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('meta-module-v1.1', 'Marketing tabs — fixed stuck Loading',
        'Ads Manager, Facebook & Instagram, Comments and Post Publisher pages now actually load instead of getting stuck at "Loading…" after a fresh Facebook connection. Settings → Integrations Meta Ads card also now correctly counts ad accounts and pages.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- OUTBOUND_WH_CF_FIRE_v1 — webhook with custom field condition not firing
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('outbound-wh-cf-fire-v1', 'Outbound Webhooks — custom-field rules now fire',
        'Fixed bug where webhooks with a custom-field condition would Test successfully but never fire on real lead creation. Cause: rule key and lead extra_json key form did not match (one had cf_ prefix, the other did not). Both forms are now accepted.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- META_ADS_v1.2 — Ad Account filter + Custom date range + Account name column + Column picker
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('meta-ads-v1.2', 'Ads Manager — filters, custom date, and column picker',
        'Ads Manager now lets you (1) filter by one or more ad accounts, (2) pick a custom From/To date range, (3) see the human ad account name on every campaign row, and (4) customize visible columns with 20+ Meta metrics including Purchases, Cost per Purchase, ROAS, Reach, Frequency, ATC, Landing Page Views, ThruPlays, and Messaging Conversations. Click the new "⚙ Columns" button to choose. Click "🏢 All accounts" to filter.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- META_ADS_v1.2.1 — alerts collapsed default + sticky toolbar + drill-down + dedup fix
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('meta-ads-v1.2.1', 'Ads Manager — drill-down, collapsed alerts, sticky toolbar',
        'Three improvements: (1) Alerts panel is collapsed by default — click the 🚨 bar to expand/hide; preference persists. (2) Click any campaign row to drill down — a modal opens with daily breakdown showing Spend, Impressions, Clicks, CTR, CPC, Leads, CPL, Purchases, ROAS, ATC and LPV per day. (3) The toolbar (Refresh, Columns, + Create, Period selector) now sticks to the top when you scroll. Also fixed a race condition that caused alerts to render twice on first load.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- META_ADS_v1.3 — inline drill-down + totals row + pivot view + campaign creation
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('meta-ads-v1.3', 'Ads Manager — totals, pivot view, in-app campaign creation',
        'Three big additions: (1) Drill-down is now inline — click any campaign row and the daily breakdown expands BELOW it on the same page (no more modal popup). (2) Totals row at the bottom of the campaigns table aggregates spend, impressions, clicks, leads, purchases, ROAS and every other visible metric. (3) Pivot Table view groups campaigns by name with parent "All" totals + per-account sub-rows (auto-enabled when 2+ accounts selected). PLUS: real in-app campaign creation — the + Create button now opens a form where you pick a Name, Objective, Ad Account, Daily Budget, and start Status; the campaign is created directly via Meta Marketing API. First-time use prompts a one-click "Reconnect Facebook" to grant the ads_management permission.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- OUTBOUND_WH_v7 — operators on custom-field rules
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('outbound-wh-v7', 'Outbound Webhooks — Contains / Not equals / Exact operators on CF rules',
        'Custom-field rules in Outbound Webhooks now support operators. Each rule row has an operator dropdown next to the field: (1) Equals — case-insensitive match (default, same as before). (2) Exact — case-sensitive exact match. (3) Contains — fires when the field value contains your text anywhere (great for partial matches like "New Shop" matching "New Shop - Delhi"). (4) Not equals — fires only when the field value is NOT in your list. Multiple values per row still work as OR within the chosen operator. Existing rules continue working as Equals.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- MENU_REFACTOR_v1 — main + settings sidebar renames, reorder, search
INSERT INTO changelog (version, title, body, posted_at)
VALUES ('menu-refactor-v1', 'Sidebar refresh — cleaner categories, search box in both menus',
        'Big navigation cleanup. Main sidebar categories are now grouped by workflow: Dashboard, Sales CRM, Calls & Dialer, Marketing & Communication, Reports & Analytics, Products & Inventory, Billing & Accounts, HR & Team Management, Knowledge & Support, and Admin & Settings. Reports stay in one place (Reports & Analytics). Quotations and Sales Closure moved under Sales CRM. Marketing groups Ads Manager, Social, Campaigns, WhatsApp Bot, and AI Assistant. Settings is restructured too — Organization & Access, Lead Setup, Sales & Quotation Setup, Lead Routing, Channels & Integrations, Call & Chat Settings, Automation & SLA, UI & Menu Settings, System Monitoring, and Danger Zone. NEW: Both the main sidebar and Settings have a search box at the top. Type any old or new name (e.g. "WhatsBot", "Due today", "Sources", "Sale Final Closure") and the matching item appears instantly — no need to learn the new names. Existing routes and permissions are unchanged.',
        NOW())
ON CONFLICT (version) DO NOTHING;

-- PACK_PHASE_2_v1 (2026-06-07) — 5 new industry packs
INSERT INTO control.changelog (version, title, body, kind, released_at)
VALUES ('PACK_PHASE_2_v1', '5 new industry packs available',
        E'Super-admin can now install 5 new industry packs on any tenant:
• Finance — insurance, loans, investments
• Solar — rooftop survey, quotes, subsidy
• Manufacturer — RFQ, production, dispatch
• Holiday — packages, bookings, itineraries
• Ecommerce — orders, returns, abandoned carts, loyalty

Each pack seeds industry-specific statuses + custom fields + sample products and exposes a sidebar menu with the most-needed views. Open any tenant in super-admin → Industry Pack → Install.',
        'feature', NOW())
ON CONFLICT (version) DO NOTHING;

-- SHOWCASE_PHASE_2_v1 (2026-06-07) — Demo showcase tenants for 5 new packs
INSERT INTO control.changelog (version, title, body, kind, released_at)
VALUES ('SHOWCASE_PHASE_2_v1', '5 new showcase demo tenants with dummy data',
        E'Super-admin can now spin up 5 new fully-populated demo tenants from the Demo Seeder panel:
• showcase-finance — TrustBridge Financial Services (8 policies, claims, premium schedule)
• showcase-solar — SunBright Solar Solutions (6 site surveys, 6 quotes, 3 installations)
• showcase-mfg — Precision Industries (8 RFQs, 4 production orders, 1 dispatch)
• showcase-holiday — WanderWise Travel (8 bookings, day-wise itineraries, vouchers)
• showcase-ecommerce — KartFlow D2C Store (10 orders, returns, 5 abandoned carts, loyalty tiers)

Each demo tenant: shared admin login (demo-finance@smartcrm.in / Showcase@123 etc), seeded leads + users + statuses + custom fields + 30-day pack-specific transactions.',
        'feature', NOW())
ON CONFLICT (version) DO NOTHING;

-- 2026-06-08 WA_TPL_META_UPLOAD_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'WhatsApp template — image/PDF/video header upload fixed',
       'Creating a WhatsApp message template with an Image, PDF or Video header now works. The CRM uploads your sample file through Meta''s Resumable Upload API and sends the proper handle (previously we sent our own public URL and Meta rejected it with a "sample not provided" error).',
       '🖼️',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp template — image/PDF/video header upload fixed');

-- 2026-06-08 WA_PKG_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'WhatsApp — Business WA button now actually opens Business app',
       'On the mobile lead card, tapping "Business WA" was still opening Personal WhatsApp. The Android intent URL wasn''t matching either app''s manifest filter, so it fell back to the public URL and opened whichever WA was your system default. Fixed — Business WA now reliably routes to com.whatsapp.w4b and Personal WA to com.whatsapp.',
       '🟢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp — Business WA button now actually opens Business app');

-- 2026-06-08 WA_PKG_FIX_v2
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'WhatsApp Business button — v2 fix (Personal/Business routing)',
       'v1 still didn''t reliably route the "Business WA" button to WhatsApp Business. v2 switches to api.whatsapp.com — the URL host both apps definitively register — drops the silent fallback URL (so a missing Business app errors visibly instead of opening Personal), and uses location.href instead of an anchor click (Capacitor WebView sometimes intercepts anchor clicks before the intent system sees them).',
       '🟢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp Business button — v2 fix (Personal/Business routing)');

-- 2026-06-08 WA_TARGET_PICKER_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'WhatsApp picker — choose template AND app together',
       'On the mobile lead card''s 💬 button: you can now pick whether to open Default WhatsApp, Personal, or Business — and THEN tap a template. The template fires straight into the chosen app, pre-filled and ready to send. Previously, the Personal/Business buttons sent empty text, and the template list always used the system default. Your choice is remembered for next time.',
       '🟢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp picker — choose template AND app together');

-- 2026-06-08 WA_PKG_FIX_v3
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'WhatsApp Business launcher — visible-failure detection (v3)',
       'When tapping Business + a template, sometimes nothing happened at all. Reason: certain Android WebView builds silently swallow intent:// URLs that don''t match a perfect filter. v3 now tries THREE different URL formats (whatsapp://, https://api.whatsapp.com/send, https://wa.me) in succession, and if WhatsApp still doesn''t open within ~2s, copies the phone+message to your clipboard and tells you so you can paste it manually.',
       '🟢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp Business launcher — visible-failure detection (v3)');

-- 2026-06-08 WA_PKG_FIX_v4
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'WhatsApp Business launcher — use Capacitor App.openUrl + last-resort chooser (v4)',
       'v3 still couldn''t reliably pin to WhatsApp Business because Capacitor''s WebView silently rejects intent:// URLs on some OEM Android builds. v4 now uses Capacitor.Plugins.App.openUrl (bypasses WebView entirely → goes straight to Android''s intent system), with window.open(_system) and location.href as fallbacks. If all package-pinned attempts still fail, the last resort is to open the default WhatsApp chooser URL so the user always lands SOMEWHERE — plus a helpful toast: "couldn''t be pinned. To always use Business WA, set it as Android default in Settings → Apps → Default apps."',
       '🟢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp Business launcher — use Capacitor App.openUrl + last-resort chooser (v4)');

-- 2026-06-08 SHOWCASE_PACK_VISIBILITY_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Industry packs — Finance / Solar / Mfg / Travel / Ecommerce overview pages',
       'Showcase tenants with the Finance / Solar / Manufacturer / Holiday / Ecommerce pack now show a dedicated Overview page in the sidebar with KPI tiles pulled from the live pack APIs (sanctioned amount, quotes sent, RFQs open, bookings confirmed, orders 30d, etc). Previously these showcases looked identical to a Generic tenant. Full per-entity CRUD UIs ship in the next round.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Industry packs — Finance / Solar / Mfg / Travel / Ecommerce overview pages');

-- 2026-06-08 GCONV_SHEETS_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Google Ads Conversion Export — push to Google Sheet',
       'In addition to the CSV download / public URL, you can now push the same 7-column conversion data straight to a Google Sheet you own. Share your Sheet (Editor access) with sales@smartcrmsolution.com, paste the URL on Settings → Google Ads Export, and either click Push Now or enable Auto-push so the daily worker writes to it nightly. Google Ads can pull from the same Sheet URL — no CSV middleman needed.',
       '📊',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Google Ads Conversion Export — push to Google Sheet');

-- 2026-06-09 GCONV_SHEETS_BUG_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Google Sheet push — fix "No Sheet URL configured" error after save',
       'When you saved a Sheet URL on Google Ads Conversion Export and then clicked Push Now, the server would throw "No Sheet URL configured" even though the URL was correctly saved in the database. Root cause: _loadSettings() was reading the row from DB but stripping the sheet_url / sheet_tab / sheet_push_enabled columns out of the returned object. Now fixed — Push Now works first try after saving.',
       '🔧',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Google Sheet push — fix "No Sheet URL configured" error after save');

-- 2026-06-09 GCONV_SHEETS_AUTOSAVE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Google Sheet push — Push Now button now auto-saves your Sheet URL first',
       'There was no separate Save button inside the Google Sheet card, which made it confusing — clicking Push Now would error with "No Sheet URL configured" because the URL had not been saved yet. Now Push Now silently saves the Sheet URL, tab name, and auto-push toggle FIRST, then pushes. Just paste your sheet URL and click Push Now — no extra step.',
       '🔧',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Google Sheet push — Push Now button now auto-saves your Sheet URL first');

-- 2026-06-09 USER_ACTIVE_TOGGLE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Users page — deactivate / reactivate a user without deleting them',
       'New Active column on Settings → Users with a 🟢 Active / 🔴 Inactive toggle button. Admins and managers can deactivate a team member to instantly block their login — their leads stay assigned (re-assign first if needed). Click again to reactivate. You cannot deactivate yourself.',
       '🛡️',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Users page — deactivate / reactivate a user without deleting them');

-- 2026-06-09 GCONV_SHEETS_SCHEMA_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Google Sheet push — actually save the Sheet URL to the database (root-cause fix)',
       'Previous fixes all guessed at the symptom. The real bug: db/pg.js has a hardcoded SCHEMA cache that lists which columns each table accepts. The Sheet push columns (sheet_url, sheet_tab, sheet_push_enabled, etc.) were added to Postgres via ALTER TABLE but never added to this in-memory cache. So every db.update silently dropped them BEFORE the SQL was even built. The save endpoint returned OK, the column never changed, and Push Now read sheet_url=null and threw the error. Now fixed by adding the 6 sheet_* columns to the SCHEMA registry.',
       '🛠️',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Google Sheet push — actually save the Sheet URL to the database (root-cause fix)');

-- 2026-06-09 SC_CALL_LEAD_AUTOSAVE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Call → Lead settings now auto-save the moment you toggle them',
       'The "Convert incoming/outgoing calls into leads" checkboxes had their own dedicated card-level Save button. Admins who unchecked the boxes but forgot to click that specific Save button kept getting incoming calls auto-converted to leads — because the UI changed but the DB did not. Now every change on the Call → Lead card auto-saves within 350ms and shows a clear ✓ Saved · HH:MM:SS indicator. The 60-second in-memory cache is also busted server-side the instant the config changes, so the new value takes effect on the very next call — not up to a minute later.',
       '🔧',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Call → Lead settings now auto-save the moment you toggle them');

-- 2026-06-09 WA_TPL_SEND_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Send a template — now with category filter + image/PDF upload + body variables',
       'The "📋 Send template" modal on every WhatsApp chat compose box used to be a flat one-click list — image-header templates failed at Meta because the SPA never asked for an image, and there was no way to scope the list to Marketing-only or Utility-only. Now: (1) Filter chips at top — All / 📢 Marketing / 🔔 Utility / 🔐 Authentication with live counts. (2) Search by name. (3) Per-template Send opens an inline form for any template that has an image/video/document header (upload a file and we host it for you, OR paste a public URL) AND collects body variables {{1}}, {{2}}… as text inputs. (4) Plain text-only templates still send in one click — no extra friction. Backend now also handles VIDEO and DOCUMENT header types correctly (was hardcoded to image, causing Meta rejections).',
       '📤',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Send a template — now with category filter + image/PDF upload + body variables');

-- 2026-06-09 WA_TPL_SEND_INITIATE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Initiate Chat — image/video/PDF upload now works for media-header templates',
       'The Initiate Chat modal (opened by clicking the 🟢 WhatsApp icon on a lead row) was missing an upload field for templates with an image/video/document header. Picking a template like "bag (gu)" showed "Currently, the variable is not available for this template" — and clicking Send produced a broken message at Meta because no header URL was supplied. Now picking a media-header template opens an inline file picker + URL input (we host the file for you via /api/wa-sample), validates that a URL is present before Send, and passes it to the backend as image_url. Backend was already extended yesterday to route IMAGE / VIDEO / DOCUMENT to the correct Meta parameter shape.',
       '📤',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Initiate Chat — image/video/PDF upload now works for media-header templates');

-- 2026-06-09 WA_APP_TARGET_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'WhatsApp chat — "Business" now actually opens WhatsApp Business (not your personal WhatsApp)',
       'When a phone had BOTH WhatsApp and WhatsApp Business installed, picking the 🟢 Business target in the chat picker still opened your personal WhatsApp. Root cause: the app tried to pin the target with an Android intent:// link fired through the web bridge, but that bridge parses the link with Uri.parse() and silently dropped the ";package=" hint — so Android just used whichever WhatsApp was the default. The Android app now opens the chosen app through a native handler that sets the package explicitly (com.whatsapp.w4b for Business, com.whatsapp for Personal). If the chosen app is not installed, you now get a clear message instead of the wrong app opening. NOTE: requires updating to the latest app version (Settings → Get app → Update) — the fix is in the native app, not just the web build.',
       '💬',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp chat — "Business" now actually opens WhatsApp Business (not your personal WhatsApp)');

-- 2026-06-09 LEAD_CARD_STACK_HEAD_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Lead cards — long names no longer cut off ("Sid…", "Khu…")',
       'On the mobile Leads list, a lead with a long status (e.g. "CALL NOT CONNECTED") used to squeeze the name on the same row until it was chopped to "Sid…" or "Khu…". The name and the status pill now stack: the full name gets its own line (never truncated) and the status badge sits on the line just below it. Cards also got a little more padding so the two-line header has room to breathe.',
       '🪪',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Lead cards — long names no longer cut off ("Sid…", "Khu…")');

-- 2026-06-10 TEAM_LIVE_PERMS_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'security',
       'Live Team Status — agents now see only their own row',
       'The Live Team Status panel on the dashboard used to show everyone — on-call, on-break, last-call time — to every logged-in user. From this release, only admins (and admin-equivalent custom roles) see the full team grid. Every other user — managers, team leaders, sales, employees, custom roles — now sees only their own row, and the summary chip counters reflect just that one row. Your task picker and ☕ break toggle still work exactly as before. No setting to change — the rule is applied per role at sign-in.',
       '🔒',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Live Team Status — agents now see only their own row');

-- 2026-06-10 TEAM_LIVE_PERMS_v2
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Live Team Status — now controlled from the Permissions matrix',
       'The earlier release locked the dashboard ''Live Team Status'' widget so only admins could see the whole team grid. That decision is now controllable per role. Go to Settings → Permissions → and look for the new row ''View Live Team Status (whole team)''. Default: admin / manager / team leader = ON · sales = OFF (sales agents only see their own row + their own summary counters). Custom roles default to OFF — flip them on if you want that role to see the team. Same matrix, same Save button, no other change.',
       '🔐',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Live Team Status — now controlled from the Permissions matrix');

-- 2026-06-10 QUOTE_SNO_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Quotations — line items now numbered (1, 2, 3, …)',
       'When a quote has multiple products it was easy to lose track of which row was which, especially on the printed PDF version. We''ve added a small S.No column on the very left of the items table — every product now gets a running number (1, 2, 3, …) in front of it. The PDF download path already had numbering. No setting to change — every new render of an existing or new quote shows the column.',
       '🔢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Quotations — line items now numbered (1, 2, 3, …)');

-- 2026-06-10 CALL_LEAD_EMPTYSTR_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Incoming calls — auto-create lead toggle now fully respected (empty-string trap)',
       'Some tenants saw incoming calls still creating new leads even when "Convert incoming calls into leads" was unchecked in Settings. Root cause: an older save path stored an empty string in the config instead of the literal "0". The 60-second per-tenant config cache treated the empty string as a falsy value and silently fell back to the default "on" state, so calls kept creating leads while the UI correctly showed the box as off. The cache now reads the value literally — only "1" means on, everything else (including empty) means off. No setting to change — fix takes effect on the very next call. If you still see auto-creation after the fix, toggle the box once and click Save now to overwrite the legacy value.',
       '📞',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Incoming calls — auto-create lead toggle now fully respected (empty-string trap)');

-- 2026-06-10 MOBILE_WA_FAB_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Mobile app — floating WhatsApp button on every screen',
       'Open the WhatsApp inbox from anywhere in the mobile app with a single tap. A green floating WhatsApp button now sits on every screen of the mobile / APK version (lower-left corner by default, alongside the Copilot sparkle on the lower-right). Tap it once to jump to the WhatsApp Bot view and start chatting with leads. Long-press and drag to move it wherever you like — the position is remembered per device. Doesn''t affect desktop, where the existing floating chat dock continues to handle the same job.',
       '💬',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Mobile app — floating WhatsApp button on every screen');
-- 2026-06-10 HR_LEAVE_TYPE_HALFDAY_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'HR Leaves — Leave Type and Half Day options',
       'You can now select a Leave Type (Casual, Sick, Earned, or Unpaid) when applying for leave. A new Half Day checkbox lets staff apply for just half a day — tick it and the end date auto-fills to match the start date. Managers see the leave type in the Pending Approvals list so they have full context before approving. Admins see the same in the All Leaves view.',
       '🏖️',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'HR Leaves — Leave Type and Half Day options');

-- 2026-06-12 META_CAPI_LEADGEN_ID_v1 + META_CAPI_HIDE_CRM_MODE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'improvement',
       'Meta Conversions API — perfect Lead Ad matching',
       'When you fire a conversion event for a lead that originated from a Facebook Lead Ad, we now include the exact leadgen_id alongside the hashed phone/email. Meta uses this to tie the conversion directly back to the Lead Ad form click — much stronger optimisation signal than PII-only matching, equivalent to what the CRM data source would provide. The separate yellow "CRM mode" card has been removed from the Settings → Meta Conversions API page because Meta gates that data source behind their CRM Partner Program (only ~30 platforms allowed), which means most tenants can''t complete the setup. The Offline data source now delivers the same benefit on its own.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Meta Conversions API — perfect Lead Ad matching');

-- 2026-06-12 META_CAPI_LOG_VIEWER_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Meta Conversions API — Event log viewer',
       'A new Event Log section now sits at the bottom of Settings → Meta Conversions API. See every conversion event we attempted to send to Meta over the last 1, 3 or 7 days, filter by Sent / Failed / Queued, and click any row to expand and see the exact payload + Meta''s response. Great for debugging when a status change does not produce the expected ad-platform conversion.',
       '📋',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Meta Conversions API — Event log viewer');

-- 2026-06-12 LEADS_RULE_CF_NCONTAINS_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'Lead filter rules — custom-field operators now work',
       'The Leads page Filter Rule modal (+ Filter rule button) now correctly evaluates rules built on custom fields. Previously a rule like "Page Name does not contain New Shop" silently let every lead through because the value was being read from the wrong place. The filter now reads the custom-field value from extra_json (lead form / CSV upload / website API), meta_json (Facebook Lead Ads), and the legacy extra map — whichever has the value — so equals / not equals / contains / does not contain / starts with / ends with / is empty / is not empty all work consistently on custom fields the same way they already worked on built-in columns.',
       '🔍',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Lead filter rules — custom-field operators now work');

-- 2026-06-12 WMS_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Webhook Mapping Studio — see what comes in, transform values, test',
       'The Field Mapping screen is now a 3-tab Webhook Mapping Studio. The Field Mapping tab keeps the existing key→CRM field configuration. The new Value Rules tab lets you transform values without code — e.g. "IF page_name contains New Shop THEN set Source = Meta". Rules support equals / not equals / contains / regex / starts with / ends with / is one of / is empty etc., evaluated top-down with first-match-wins per target field. The new Live Payloads tab shows the last 30 webhooks that arrived, lets you expand the JSON, and adds one-click + Map and Rule buttons on every key so you no longer guess the field names. A 🧪 Test button runs your current mapping + rules end-to-end against any real payload and shows a before/after preview with green-highlighted changes. Works for Website API, Pabbly, Make.com, IndiaMART, Facebook Lead Ads and every other connected webhook source.',
       '🛠',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Webhook Mapping Studio — see what comes in, transform values, test');

-- 2026-06-13 STU360_LIVE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Student 360 — full single-page view for every student (Education pack)',
       'Education-pack tenants now get a brand-new Student 360 view whenever they click a lead. The standard Lead modal is replaced with a rich single-screen profile covering everything you need to manage a student: a hero with photo + risk score + 4 KPI tiles (Attendance, Avg Score, Fee Due, Study Hours), an AI insight banner that calls out what needs attention, the pre-enrolment Lead History journey funnel, full Profile (DOB, blood group, address, emergency, enrollment #, batch, grade, language…), Courses + Fees (every enrollment with the installment schedule and overdue highlights), Attendance heatmap of the last 60 days, Test Scores with auto-graded %, Assignments tracker with status pills, weekly Schedule grid, Skills cloud, Scholarships, Family + Mentors + Goals + Achievements + a verified Documents Vault, and a Communications hub for the last 100 touchpoints. Every section is inline-editable via mini-modals. Backed by 12 new student_* tables that are created automatically on first open; the Recompute button derives the risk score from real attendance, assignment, fee and engagement data. Generic, Real Estate, and other packs see no change — they stay on the standard lead modal.',
       '🎓',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Student 360 — full single-page view for every student (Education pack)');

-- 2026-06-13 OPPORTUNITIES_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Opportunities & Multiple Pipelines — track every deal a lead can give you',
       'Big release for sales teams that sell more than one thing per customer. Every lead can now have multiple Opportunities — separate deals with their own name, type, owner, amount, expected close date, probability and stage. Each opportunity moves through its own Pipeline, and admins can run multiple pipelines side-by-side (e.g. New Business, Renewal, Upsell, Service Booking, Channel Partner) — each with its own custom stages, win probabilities and terminal Won/Lost rules. Stage changes are auto-logged to a history timeline so you can see exactly how long a deal sat in every stage. Line items (with GST + discounts), activities, documents and won/lost reasons all attach to the opportunity, not the lead. Includes 5 reports — Funnel by stage, Weighted Forecast, Win/Loss with top loss reasons, Velocity (avg time in each stage), and Aging (deals stuck longer than the stage''s expected days). Disabled by default — admins enable per tenant via Settings (OPPORTUNITIES_ENABLED). Your existing single-pipeline workflow keeps working untouched — opportunities are purely additive.',
       '💼',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Opportunities & Multiple Pipelines — track every deal a lead can give you');

-- LEAD_SCORING_v1 P1
INSERT INTO changelog (version, title, body, icon, created_at)
SELECT 'ls-v1-p1',
       'Smart Lead Scoring — every lead gets a Hot/Warm/Cold score automatically',
       'A new AI-style scoring engine looks at every lead and assigns a 0–100 Smart Score, bucketed into Hot / Warm / Nurture / Cold / Invalid. It scores six things — Source quality, Fit (industry/budget/role), Engagement (opens, clicks, replies, site visits, attendance), Communication (responsiveness, no-shows, ghosting), Application/Payment intent (tokens, brochure downloads, demo requests), and Negative signals (spam keywords, fake numbers, opt-outs). Includes a universal base layer plus deep per-pack rule sets for Education (parent-meet, fee-talk, application-form, brochure), Real Estate (site-visit booked/done, EOI, token), and Generic (demo, quote, contract). 110+ rules ship pre-seeded — admins can tune weights, thresholds and decay later. Each lead modal shows a Score Card with the live score, category, top contributing factors, and a per-rule breakdown. A new High-Intent Leads dashboard surfaces every Hot lead across the org, sorted by score. Override flow lets admins manually pin a score with reason. Disabled by default — enable per tenant via Settings → Lead Scoring (LEAD_SCORING_ENABLED).',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Smart Lead Scoring — every lead gets a Hot/Warm/Cold score automatically');

-- LEAD_SCORING_v1 P1.5
INSERT INTO changelog (version, title, body, icon, created_at)
SELECT 'ls-v1-p15',
       'Smart Lead Scoring — see scores on the Leads page',
       'Lead rows are now shaded by Smart Score bucket — Hot, Warm, Nurture, Cold each get their own colour wash + a thick left rail so the right leads stand out at a glance. A new Smart Score column shows the 0–100 score with a coloured bucket chip. The filter toolbar gains five Score chips (Hot / Warm / Nurture / Cold / Invalid — multi-select) and a Score ≥ slider so you can say "show me everyone above 70". A new sort option "🎯 Score — highest first" lets reps work the strongest leads first. Only renders when Lead Scoring is enabled.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Smart Lead Scoring — see scores on the Leads page');

-- LEAD_SCORING_v1 P1.6
INSERT INTO changelog (version, title, body, icon, created_at)
SELECT 'ls-v1-p16',
       'Smart Score now infers from lead status',
       'Earlier the Smart Score only fired when there was tracked event evidence (form fill, WA reply, call answered) — so legacy leads all looked Cold. The engine now also infers from the leads current status: Payment Link / Sale Done / Booked → Hot, Demo Done / Proposal Sent / Site Visit Done → Hot-leaning, Demo Scheduled / Site Visit Planned → Warm, Qualified / Follow Up / Interested → Warm-leaning, Attempted / Connected → Nurture, Not Interested / Junk / Lost → Invalid, Not Picking / Language Problem → score penalty. Re-run backfill once after deploy to refresh all existing leads.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Smart Score now infers from lead status');

-- LEAD_SCORING_v1 P1.7
INSERT INTO changelog (version, title, body, icon, created_at)
SELECT 'ls-v1-p17',
       'Smart Score anchored to lead status',
       'Status now sets a guaranteed score floor: Sale Done / Payment Link / Booked → Hot, Demo Done / Proposal Sent / Site Visit Done → Hot, Negotiation → Warm+, Demo Scheduled / Site Visit Planned → Warm, Qualified / Interested → Warm-, Follow Up → Nurture+. Not Interested / Junk / Lost → forced Invalid (score 0). Inference output now matches sales-team expectations. Backfill again to refresh existing leads.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Smart Score anchored to lead status');

-- LEAD_SCORING_v1 P1.8b
INSERT INTO changelog (version, title, body, icon, created_at)
SELECT 'ls-v1-p18b',
       'Smart Score filter — now a single compact dropdown',
       'Replaced the five-chip score filter strip with one tidy "🎯 Score" dropdown. Open it to multi-select Hot / Warm / Nurture / Cold / Invalid and set a minimum score. The button shows what is active at a glance, the filter row gets a lot of space back, and clicking Clear inside the dropdown wipes both bucket and min-score in one shot. Backend filter logic unchanged — just a tighter UI.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Smart Score filter — now a single compact dropdown');

-- LEAD_SCORING_v1 P1.9 — Focus mode
INSERT INTO changelog (version, title, body, icon, created_at)
SELECT 'ls-v1-p19',
       'Focus mode on the Leads page — group leads by Smart Score',
       'A new Mode dropdown next to the Score filter. Stay in Normal (the flat list you already use) or switch to Focus, which keeps every column exactly the same but splits the rows into four colour-coded sections: Hot, Warm, Nurture, Cold. Each section has its own header bar with a count pill. All your filters — date, status, source, tag, campaign, custom field, score range — still apply across every section. Invalid leads are hidden in Focus mode. Up to 50 rows per section, with a Show more link to load the rest. Selecting checkboxes across sections still feeds the existing bulk-action toolbar.',
       '🎯',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Focus mode on the Leads page — group leads by Smart Score');

-- LS_SCHEMA_FIX_v1 (2026-06-18) — AI Score column showed "–" on every lead
INSERT INTO changelog (slug, title, body, area, published_at, is_published)
VALUES (
  'ls-schema-fix-v1-2026-06-18',
  'AI Score column now shows real values',
  'Fixed: the AI Score column on the Leads page was blank for every lead. Root cause was that the database SCHEMA cache didn''t include the smart_score / smart_category columns, so they were silently stripped from every lead-list query. Scores were being computed and stored correctly all along — they just weren''t being read back. Now every lead row shows its 0–100 AI Score and Hot/Warm/Cold bucket.',
  'leads',
  NOW(),
  TRUE
) ON CONFLICT (slug) DO NOTHING;

-- AI_MGR_v1 Phase 0 (2026-06-18) — foundation only, no user-facing change yet
INSERT INTO changelog (slug, title, body, area, published_at, is_published)
VALUES (
  'ai-manager-phase0-foundation-2026-06-18',
  'AI Manager — Phase 0 foundation (beta, Vserve only)',
  'Installed the foundation for AI Manager — your virtual CRM admin and sales supervisor. Phase 0 ships the database schema (6 new tables), config flag, route scaffolding, and an empty sidebar tab. Detection logic, rule builder, idle detection, and nudges ship in Phase 1. Currently enabled only on Vserve as a beta. Full plan: AI_MANAGER_v1_BUILD_PLAN.md.',
  'ai',
  NOW(),
  TRUE
) ON CONFLICT (slug) DO NOTHING;

-- AI_MGR_v1 Phase 1 (2026-06-18) — MVP
INSERT INTO changelog (slug, title, body, area, published_at, is_published)
VALUES (
  'ai-manager-phase1-mvp-2026-06-18',
  'AI Manager — Phase 1 MVP shipped',
  'AI Manager Phase 1 is live (Vserve beta). Type rules in plain English ("If a user is idle for more than 20 minutes during working hours, ask the team leader"), the system parses them with Gemini. A detection cycle runs every 2 minutes catching idle users and new-lead SLA misses; users get an in-app "Ask Reason" popup demanding an explanation. Three tabs in the AI Manager sidebar: Rules / Violations / Reports.',
  'ai', NOW(), TRUE
) ON CONFLICT (slug) DO NOTHING;

-- AI_MGR_v1 Phase 2 (2026-06-18) — Advanced detection
INSERT INTO changelog (slug, title, body, area, published_at, is_published)
VALUES (
  'ai-manager-phase2-advanced-2026-06-18',
  'AI Manager — Phase 2 Advanced Detection',
  'AI Manager now catches the trickier slip-ups: weak/blank remarks ("ok", "done", "call later"), fake activity (status changed without a real call), ignored WhatsApp replies (>30 min), and ageing high-value leads. Two new tabs in the AI Manager sidebar — Lead Risk (which interested/hot leads are slipping) and 🏆 Scorecard (daily 0-100 score per user combining calls, follow-ups, connect rate, and violations). 5-level escalation tracker now bumps repeat offenders automatically.',
  'ai', NOW(), TRUE
) ON CONFLICT (slug) DO NOTHING;

-- AI_MGR_v1 Phase 3 (2026-06-18) — AI Coaching
INSERT INTO changelog (slug, title, body, area, published_at, is_published)
VALUES (
  'ai-manager-phase3-coaching-2026-06-18',
  'AI Manager — Phase 3 AI Coaching',
  'AI Manager is complete. Every sales rep now gets a personalised weekly Coaching digest (Gemini-written summary + 3 actionable tips, refreshed every 24h). Admin sees a Manager Digest with team KPIs, top performers and who needs attention. Conversion Probability scoring uses your AI Rate + activity + status to predict close %. Revenue Leakage Report surfaces ageing high-value leads. Next Best Action gives per-lead suggestions.',
  'ai', NOW(), TRUE
) ON CONFLICT (slug) DO NOTHING;

-- AI_MGR_v1 Phase 4 (2026-06-18) — Complete feature set
INSERT INTO changelog (slug, title, body, area, published_at, is_published)
VALUES (
  'ai-manager-phase4-complete-2026-06-18',
  'AI Manager — Phase 4: 100% feature complete',
  'Every feature from the original spec is now live. 13 detectors running every 2 min (idle, SLA, fake activity, WA ignored, interested-no-quotation, FU pre-due, FU-done-no-call, repeated short calls, copied remarks, hot-to-cold, lost-no-reason, quoted-no-FU, min daily calls). 5-level escalation now actually routes to team leader (Level 3) and admin (Level 4) via push + in-app. Real-time alerts feed. Natural-language admin Q&A ("who is idle?", "overdue follow-ups", "pending hot leads"). Daily Plan auto-pushed at 9am IST. EOD prompt at 7pm + team summary. Remark Quality hooks into QNote + add-remark. Rule parser handles 12+ patterns.',
  'ai', NOW(), TRUE
) ON CONFLICT (slug) DO NOTHING;

-- 2026-06-20 LEAD_MODAL_REDESIGN_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'modify',
       'Edit Lead form — new top-of-modal layout',
       'Opening a lead now puts Name, Phone, Status, Next follow-up and a Remark box right at the top — each with a coloured dot so the essentials jump out. Type what happened on the call into the Remark box and it lands in the Notes column and remark timeline automatically. Every other field still sits below, unchanged.',
       '🎨',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Edit Lead form — new top-of-modal layout');

-- 2026-06-20 WA_THREADS_SCAN_v1 + WA_THREADS_TABS_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'modify',
       'WhatsApp Chats — Recent / History tabs + 10x more threads',
       'The WhatsApp Chats list now opens with two tabs — Recent (last 30 days) and History (older) — so you can find that old conversation without scrolling forever. Under the hood we also raised the thread-scan window from 1,000 to 10,000 messages, which means tenants with high inbound volume will see every thread they used to lose. Active tab is remembered across reloads.',
       '💬',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp Chats — Recent / History tabs + 10x more threads');

-- 2026-06-20 AI_ASSIST_ROLLOUT_v1 + AI_ASSIST_TUTORIAL_POPUP_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'AI Assist — now on every tenant',
       'The smart Lead summary panel (Last Activity, AI Summary, Next Best Action) that was previously vserve-only is now active on every CRM. Open any lead to see it at the top of the Edit Lead modal. A friendly intro popup appears once-per-day on your first morning login until you click "Got it" — or snooze it for 7 days.',
       '✨',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'AI Assist — now on every tenant');

-- 2026-06-20 WA_THREADS_v2
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'WhatsApp Chats — Recent / Historic tabs + 10× more threads',
       'The Chats list now splits into two tabs: Recent (last 30 days) and Historic (older). Switch between them to keep your active inbox uncluttered while still being able to dig up old conversations. Under the hood, the message scan window jumped from 1,000 to 10,000 — so tenants with heavy inbound volume can see every thread, not just yesterday''s.',
       '💬',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp Chats — Recent / Historic tabs + 10× more threads');

-- 2026-06-20 AI_ASSIST_ADMIN_TOGGLE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'AI Assist — on/off toggle for tenant admins',
       'Admins can now turn the AI Assist (Lead Diagnosis) panel ON or OFF for their whole CRM from Settings → AI Features → AI Assist. Disabling hides the smart summary at the top of the Edit Lead modal for all users — no AI data is lost, just the panel is hidden. Re-enable any time. Changes apply on the next page reload.',
       '🎛️',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'AI Assist — on/off toggle for tenant admins');

-- 2026-06-20 AI_MGR_PUSH_NOTIFY_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'AI Manager — phone notifications when prompts fire',
       'Sales reps now get a phone push notification the moment an AI Manager prompt is created (idle nudge, new-lead SLA miss, WA reply waiting, hot lead waiting, copy-paste remarks, etc). Before this fix, prompts only showed up if the rep happened to be looking at the CRM browser tab — so 127 of them piled up unanswered on vserve. Tapping the notification opens the AI Manager prompts inbox directly.',
       '🔔',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'AI Manager — phone notifications when prompts fire');

-- 2026-06-20 DEMO_REMINDER_v1 (vserve beta)
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Copilot Demo Reminders (beta on vserve)',
       'Every morning at 10 AM IST, each sales rep gets a Copilot card listing today''s demos with a one-tap "Send WhatsApp reminders to all" button. 30 minutes before each demo, the rep also gets a single-row reminder with a polite message draft. If the customer has not replied on WhatsApp in 24 hours, an approved template is used; if they have, AI composes a custom message in the tone you pick. Admin sets which statuses count as "demo scheduled" and the template name in Settings → AI Features → Demo Reminders.',
       '📅',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Copilot Demo Reminders (beta on vserve)');

-- 2026-06-23 LEAD_POOL_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Lead Pool — recycle leads by status',
       'New "Lead Pool" page under Sales CRM. An admin picks which statuses (e.g. NP) release a lead into a shared pool from Lead Pool → Pool Settings. The moment a lead is set to a pool status it drops into the pool — the original owner keeps the lead and sees it as before. Users granted "Lead Pool — Pull" can browse the pool, see a date-wise count of available leads, and pull any lead to start working it. Pulling makes them a co-owner (🤝): the original owner keeps the lead too, and the pull is logged. Grant pool access per role in Settings → Permissions (pool.view / pool.pull).',
       '🔄',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Lead Pool — recycle leads by status');

-- 2026-06-23 LEAD_POOL_v2
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Lead Pool — one-click batch pull',
       'The Lead Pool now works as a recycling pool. In Lead Pool -> Pool Settings an admin picks which statuses pool a lead (e.g. NP), then picks each user and how many leads they get per pull (e.g. Rep A = 5, Rep B = 10). Allowed users just see a live count of available leads and one Pull button — clicking hands them their batch of the newest pooled leads, shared with them (the original owner keeps them too). No browsing or picking individual leads. A lead stays in the pool until its status changes off a pool status.',
       '🔄',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Lead Pool — one-click batch pull');

-- 2026-06-24 LEADS_VIEW_V2_ROLLOUT_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'New Modern leads theme for everyone',
       'The Leads page now has a ✨ View switcher in the top-right with three styles: Classic (the familiar table), Modern (a cleaner card-style layout) and Inbox. Pick whichever you like — your choice is remembered on each device. Previously a vserve-only beta, now available on every workspace.',
       '✨',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'New Modern leads theme for everyone');

-- 2026-06-24 WA_SENDER_PICK_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'WhatsApp inbox — see & choose the sending number',
       'In the WhatsApp inbox the chat header now shows which of your numbers a conversation is on ("on +91…"), and a "Sending from" line above the message box shows the number your reply will go from. If you have more than one WhatsApp number connected, you can switch the sending number from there before replying. Replies default to the number the customer originally messaged.',
       '📤',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'WhatsApp inbox — see & choose the sending number');

-- 2026-06-24 PROFORMA_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Proforma Invoice support',
       'You can now create a Proforma Invoice. In Accounts -> Invoices -> New Invoice, pick "Proforma Invoice" under Document Type. Proforma invoices use a separate PI- number series (so your tax-invoice numbering stays unbroken), print with a "PROFORMA INVOICE / Not a tax invoice" heading, and are excluded from GSTR-1. Tax Invoice remains the default.',
       '📄',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Proforma Invoice support');

-- 2026-06-24 INV_INLINE_ITEM_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Create items while making an invoice',
       'In the invoice line items, the item dropdown now has a "➕ Create new item…" option. Pick it to add a reusable item (name, HSN/SAC, unit, default rate, GST%) on the spot — it saves to your item master and is filled into the line automatically. The Document Type chooser (Tax Invoice / Proforma Invoice) is now a clearly highlighted bar at the top of the invoice form.',
       '🧾',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Create items while making an invoice');

-- 2026-06-24 FIN_PACK_v2
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Finance pack: loan DSA tools + insurance renewals',
       'The Finance pack now has loan-DSA tooling on every lead (Finance — Loan File panel): a multi-lender submission tracker (submit one file to several banks and track each one as submitted/login/approved/rejected/disbursed with ROI & ref no), a commission/payout tracker (commission % auto-calculated, mark payout received), and a loan document checklist (KYC/income/property docs with pending/received/verified). Insurance renewals now support one-click "Renew" which marks the policy renewed and auto-creates the next-period policy with a fresh premium schedule. New rollups on the Finance Overview show commission pending/received and active lender files.',
       '🏦',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Finance pack: loan DSA tools + insurance renewals');

-- 2026-06-24 CA_LEAD_ONLY_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Call Activity: show CRM-lead calls only',
       'Call Activity now has a "📋 CRM leads only" toggle in the toolbar. Turn it on to hide personal / unknown-number calls and see only calls matched to a CRM lead. Each user can flip it for their own view; admins get a "Set as default" button to make it the default for the whole workspace.',
       '📞',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Call Activity: show CRM-lead calls only');

-- 2026-06-24 CALL_CAPTURE_LEAD_ONLY_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Capture CRM-lead calls only (privacy)',
       'New admin option on the Call Activity page: "🔒 Capture CRM-lead calls only". When turned on, the CRM stops storing personal / unknown-number calls (and their recordings) entirely — only calls that match an existing CRM lead are captured. It applies to new calls going forward and is OFF by default, so nothing changes unless you switch it on. Different from the per-view "CRM leads only" filter, which only hides calls in the report while still storing them.',
       '🔒',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Capture CRM-lead calls only (privacy)');

-- 2026-06-24 AIBOT_AFTERHOURS_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'AI Bot — after-hours replies now work + clearer timing',
       'Fixed: a bot set to "Only after business hours" could stay silent if its Business Hours weren''t fully filled in — it now falls back to a sensible window (Mon–Fri 9–7, your timezone) so after-hours replies actually fire. Also simplified the "When should the bot reply?" setting: timing is now a single choice — Anytime (24×7), Only during business hours, or Only after business hours — instead of confusing checkboxes where "Always" silently overrode the rest. Keyword / number / draft-approval options remain as optional extras.',
       '🤖',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'AI Bot — after-hours replies now work + clearer timing');

-- 2026-06-24 AIBOT_AFTERHOURS_HANDOFF_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'After-hours bot no longer muted by daytime agent chats',
       'When the bot is set to "Only after business hours", it was being silenced by the human-handoff guard — if any agent had messaged that customer earlier (default window 24 hours), the bot stayed quiet even at night. Now, while it is genuinely after hours, the bot ignores those daytime-agent guards (the whole point is to cover when the team is offline) and only respects a short 30-minute "someone is actively chatting" safety. You can see exactly why any message was skipped in the AI Bot Activity log (suppressed reason).',
       '🤖',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'After-hours bot no longer muted by daytime agent chats');

-- 2026-06-24 AIBOT_MODEL_FIX_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'fix',
       'AI Bot replies failing — retired Gemini model',
       'Some AI Bot replies were failing with "model gemini-2.0-flash is no longer available" because Google retired that model and a few bots (and the overload-fallback) still pointed at it. The system now automatically rewrites any retired Gemini model name to a current equivalent (e.g. gemini-2.0-flash → gemini-2.5-flash) at send time, so the bot replies again without you needing to change anything.',
       '🤖',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'AI Bot replies failing — retired Gemini model');

-- 2026-06-24 MANUAL_BOT_PAUSE_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Pause the AI bot on a chat with one tap',
       'In the WhatsApp inbox, each conversation now has a "🤖 Bot on" button in the chat header. Tap it to pause the AI bot on that chat so you can take over — choose 15 minutes, 1 hour, or until you resume. The button shows "⏸ Bot paused · Xm" with the time remaining, and the bot auto-resumes when the window ends (or tap Resume now). This replaces guessing whether a human took over — the bot only pauses when you tell it to.',
       '🤖',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Pause the AI bot on a chat with one tap');

-- 2026-06-25 CALL_CAPTURE_LEAD_ONLY_USER_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Capture only your CRM-lead calls (per-user)',
       'You can now choose, from Settings → Security, to capture only your CRM-lead calls. When ON, your calls to numbers that aren''t a CRM lead — and their recordings — aren''t captured at all. It''s your own setting and affects only you; other users'' calls are unchanged. This is separate from the workspace-wide admin switch on the Call Activity page.',
       '📞',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Capture only your CRM-lead calls (per-user)');

-- 2026-06-25 TENANT_LIST_v2 + TENANT_EDIT_BILLING_v1 (super-admin)
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Tenants page: summary, filter, list view + billing edit',
       'The super-admin Tenants page now has a summary strip (Registered today / Total active / Total suspended / Total), a search + status filter, and a Cards/List view toggle that remembers your choice. The tenant Edit modal now lets you change billing (total amount, amount paid with auto pending balance, payment reminder date) and the plan (package + user cap) in one place.',
       '🏢',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Tenants page: summary, filter, list view + billing edit');

-- 2026-06-25 REC_RETENTION_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'feature',
       'Call recordings auto-delete after 30 days',
       'To save storage, call recordings are now automatically deleted after 30 days. A nightly job removes recordings older than the limit across the workspace, and the Call Activity page shows a notice of the current retention window. Admins can change the number of days (or set 0 to keep recordings forever) from the Call Activity page.',
       '🗑',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Call recordings auto-delete after 30 days');

-- 2026-06-25 R2_RECORDINGS_v1
INSERT INTO changelog (category, title, body, icon, created_at)
SELECT 'improvement',
       'Faster, cheaper call-recording storage',
       'Call recordings are now stored in zero-egress object storage and streamed straight to your browser, which cuts hosting bandwidth costs and speeds up playback. Existing recordings are migrated automatically in the background. No change to how you record or play calls.',
       '🎙️',
       now()
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE title = 'Faster, cheaper call-recording storage');

-- PERF_FIX_v7 (2026-06-26)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('PERF_FIX_v7', 'Background sweeps tightened',
 'AI Manager detection + weekly coaching now run for Vserve only (allowlist gate); Google Conv export defaults to the test tenant only. Super-admin can opt-in other tenants via Settings → Performance.',
 'super_admin', NOW())
ON CONFLICT DO NOTHING;

-- PERF_FIX_v8 (2026-06-26)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('PERF_FIX_v8', 'R2 recording backfill paused',
 'The R2 backfill sweep that migrates legacy Postgres-stored recordings to R2 is now PAUSED by default (was running every 15 min across every tenant). Playback of legacy recordings still works via the Postgres fallback. Super-admin can opt-in a tenant via Settings → Performance → SWEEP_R2BACKFILL_TENANTS when ready to migrate.',
 'super_admin', NOW())
ON CONFLICT DO NOTHING;

-- CALL_ACTIVITY_HOURLY_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('CALL_ACTIVITY_HOURLY_v1', 'New Hourly Productivity panel on Call Activity',
 'Below the existing Daily call activity chart, a new section shows hour-of-day breakdown: 4 insight cards (Peak hour / Quietest working hour / Top performer at peak / Active reps), a 24-hour stacked bar chart (Incoming/Outgoing/Missed), a User × Hour heatmap (rows = reps, cols = 0-23, color = call intensity), and a per-rep summary table with Total / Peak hour / Talk time / Coverage 9–18. Quick presets: Today, Yesterday, Last 7 days. Purely additive — no existing chart or table was removed.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;

-- LEADS_V2_HEADER_v4 (2026-06-27) — vserve only
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_V2_HEADER_v4', 'New compact sticky header on Modern Leads (beta)',
 'Vserve beta: the Modern Leads view now has a single-row sticky header — title+count, search, inline chips (Hot/Overdue/Due today/New/Mine with counts), Status/Date/Owner dropdowns always visible, "+ Filters (N)" popover for the rest, Refresh + New Lead + ⋮ menu on right. Saves ~200px vertical = 2.5× more leads visible. Active filters persist across refresh; the filter popover always opens closed on hard refresh. Toggle via super-admin config LEADS_V2_HEADER_V4_ENABLED.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;

-- POOL_EVICT_RACE_FIX_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('POOL_EVICT_RACE_FIX_v1', 'Fixed intermittent "pool after end" login/API errors',
 'Root-caused the recurring "Cannot use a pool after calling end on the pool" 500s some tenants saw the last few days. A tenant DB connection pool could be evicted by the LRU cleanup in the brief window after it was handed to a request but before that request issued its first query, crashing the request. The eviction pass now skips any pool handed out within a 30s grace window and defers the actual close by 15s so in-flight requests drain cleanly. No UI change.',
 'super_admin', NOW())
ON CONFLICT DO NOTHING;

-- FIN_RENEWAL_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('FIN_RENEWAL_v1', 'Finance pack: Renewal & Collection workflow',
 'New 🔄 Renewals section on Finance Overview page. KPI strip (Due 30d / Overdue / Renewed / Lapsed / Collected), 6 status tabs (Upcoming / Due 30 / Overdue / Renewed / Lapsed / Collected), live renewal list with per-row actions: 💬 send WA reminder, 📧 send email reminder, 💰 mark collected, mark lapsed. Monthly Collection Report below shows collection % per month with color-coded health. Reminder history tracked in fin_renewal_reminders table.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- WB_CHAT_V2_RESTORE_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('WB_CHAT_V2_RESTORE_v1', 'WhatsApp chat: 3-column redesign restored',
 'The redesigned 3-column WhatsApp chat (thread list + chat + live lead panel with AI Score, AI Summary, status change, add-remark and activity timeline) is back. Its loader had been accidentally dropped when the industry pack scripts were added, causing a fallback to the old 2-column view. Re-enabled for the vserve beta tenant only.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- WB_CHAT_V2_RESTORE_v1b (2026-06-27) — restore remaining dropped feature loaders
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('FEATURE_LOADERS_RESTORE_v1', 'Restored: AI features + Modern Leads theme',
 'Several feature modules had their script loaders accidentally dropped from index.html when the industry pack scripts were added, making them disappear: Modern/Inbox Leads page theme (leadsV2), Proactive AI Assist (copilotProactive), Smart AI Lead Score (leadScoring), Opportunities tab, Student 360, and AI Call (VAPI) config. All loaders restored; each feature returns to its prior rollout state.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_VIEW_TOGGLE_RELOCATE_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_VIEW_TOGGLE_RELOCATE_v1', 'Leads: View switcher moved into the page header',
 'The Classic / Modern / Inbox view switcher was a floating pill that overlapped the top toolbar buttons. It now sits inline inside the Leads page header, next to the Hide button, so it no longer covers anything.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- PACK_GLOBALS_FIX_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('PACK_GLOBALS_FIX_v1', 'Fix: Solar / Real Estate / Education pack features restored',
 'The Solar, Real Estate, Education and Holiday pack screens were not loading because the page was missing an internal hook (window.VIEWS) the pack modules wait for before they register. All pack features (overview dashboards, site survey, pricing calculator, listings, deal pipeline, admission pipeline, enrollment, etc.) now load correctly again.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- SALE_CLOSURE_VIEWS_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('SALE_CLOSURE_VIEWS_v1', 'Sale Closure: List view, stage chart & auto-show converted',
 'The Sale Final Closure page (Projects) now (1) automatically shows Won / converted customers in the pipeline first stage without manual adding, badged as Converted; (2) has a List view in addition to Kanban (toggle at the top); and (3) shows a Records-by-stage bar chart at the top with a quick KPI strip (In pipeline / Converted / Stalled).',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- SALE_CLOSURE_VIEWS_v2 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('SALE_CLOSURE_VIEWS_v2', 'Sale Closure: graph options, compact filters, smarter Won detection',
 'Three improvements on the Sale Closure page: (1) the stage graph now has a type selector — Bar, Funnel or Donut; (2) the filter bar is collapsed by default behind a compact Filters toggle so it no longer fills the page; (3) converted-customer detection now matches any final Won-type status (Won / Converted / Sale Closed / Enrolled / Paid) and not only statuses explicitly mapped to the won stage, while excluding Lost / Junk / Not Interested.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_VIEW_V2_ALLTENANTS_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_VIEW_V2_ALLTENANTS_v1', 'Leads: Classic / Modern / Inbox view switcher on every tenant',
 'The Leads page view switcher (Classic / Modern / Inbox) now appears for all tenants, not just the beta tenant. Classic remains the default. Admins who want the old behaviour can turn it off by setting LEADS_VIEW_V2_ENABLED to 0.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_VIEW_TOGGLE_ALWAYS_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_VIEW_TOGGLE_ALWAYS_v1', 'Leads: view switcher always visible',
 'The Classic / Modern / Inbox view switcher now shows whether the Leads header is expanded or hidden, so it can no longer disappear.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- WACHAT_ALLTENANTS_STAGECHART_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('WACHAT_ALLTENANTS_v1', 'WhatsApp 3-column chat for everyone',
 'The redesigned 3-column WhatsApp chat (thread list + chat + live lead panel) is now enabled for all tenants, current and future. Admins can opt out by setting WB_CHAT_V2_ENABLED to 0.',
 'tenant_admin', NOW()),
('SALE_CLOSURE_FIXES_v1', 'Sale Closure: date presets fixed + stage flow chart',
 'On the Sale Closure page the date presets (Today / Yesterday / Last 7 days etc.) now actually filter the board. The stage graph also gained a Stages flow style (connected colored arrow segments) and uses it by default.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- TENANT_INDEX_NOCACHE_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('TENANT_INDEX_NOCACHE_v1', 'Fix: new updates now show up without stale cache',
 'The CRM page shell was being cached by the browser, so new releases sometimes did not appear until a hard refresh (or at all). It is now served with no-cache headers so the latest version always loads.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_V2_RENDER_GUARD_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_V2_RENDER_GUARD_v1', 'Leads: no more blank page on Modern/Inbox',
 'If the Modern or Inbox leads view fails to load, the page now automatically falls back to the Classic view instead of showing a blank screen.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_V2_FIT_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_V2_FIT_v1', 'Leads: Modern/Inbox view now fits the screen',
 'The Modern and Inbox leads views could render below the visible area on some layouts (appearing blank). They now size to the available space so the list shows correctly and scrolls inside the page.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_VIEW_TOGGLE_TOPBAR_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_VIEW_TOGGLE_TOPBAR_v1', 'Leads: view switcher moved into the top header',
 'The Classic / Modern / Inbox switcher now sits in the top header bar (only on the Leads page) instead of its own row, freeing the space below so the leads list shows in full.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- OPS_MENU_GROUP_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('OPS_MENU_GROUP_v1', 'Sidebar: HR, Billing, Payments & Inventory grouped under Operations',
 'The HR & Team Management, Billing & Accounts, Payments, and Products & Inventory sections are now grouped under a single collapsible Operations menu. Click Operations to reveal each sub-menu, then click a sub-menu to open its items.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- LEADS_V2_FOCUS_FIX_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('LEADS_V2_FOCUS_FIX_v1', 'Modern leads: Focus mode now works',
 'The Focus mode button in the Modern leads view did nothing when the compact header was on. It now activates Focus mode (Hot / Warm / Nurture buckets) and always shows an Exit Focus control so you can switch back.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- EDU_FUNNEL_LABELS_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('EDU_FUNNEL_LABELS_v1', 'Education pack: admissions funnel stage names',
 'On tenants with the Education pack, the pipeline funnel now shows admissions terms: Inquiry, Follow-up, Counselling Done, Form Submitted, Fee/Offer Sent, plus Admitted (won) and Dropped (lost). Other tenants keep the default sales names.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- PACK_FUNNEL_LABELS_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('PACK_FUNNEL_LABELS_v1', 'Industry-specific pipeline funnel stage names',
 'The pipeline funnel now uses industry terms based on the active pack. Real Estate: New Enquiry / Contacted / Site Visit / Negotiation / Booking (Booked, Lost). Holiday: Enquiry / Contacted / Itinerary Shared / Negotiation / Quote Sent (Booked, Lost). Finance: New Lead / Contacted / Eligibility Check / Docs Collected / Submitted to Lender (Disbursed, Rejected). Education stays Inquiry to Admitted. Others keep default sales names.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- PACK_FUNNEL_LABELS_SOLAR_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('PACK_FUNNEL_LABELS_SOLAR_v1', 'Solar pack: funnel stage names',
 'The pipeline funnel on Solar tenants now reads: New Enquiry / Contacted / Site Survey / Negotiation / Quotation, with Installed (won) and Lost.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- CALL_DIAL_COUNT_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('CALL_DIAL_COUNT_v1', 'Leads: number of times a number was dialed',
 'Each lead now shows how many times its number has been dialed (outgoing calls). It appears as a 📞 badge on the lead row in the Modern view, and in the lead detail panel (header next to the name and in the Recent Activity section).',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- CALL_DIAL_COUNT_v2 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('CALL_DIAL_COUNT_v2', 'Dial count now includes older calls',
 'The "times dialed" count on leads now also reflects historical calls (completed outgoing calls and recordings made before dial tracking was added), not just new dials.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- CALL_DIAL_COUNT_v3 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('CALL_DIAL_COUNT_v3', 'Dial count now matches call activity (per number)',
 'The times-dialed count is taken directly from the call activity data and now counts every outgoing call to that phone number (matched by lead and by number), including calls logged under duplicate leads.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- CALL_DIAL_COUNT_CLASSIC_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('CALL_DIAL_COUNT_CLASSIC_v1', 'Dial count badge now on Classic leads view too',
 'The 📞 times-dialed badge now also appears on the Classic leads list (it was previously only on the Modern view).',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- CALL_DIAL_COUNT_v4 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('CALL_LAST_DIALED_v1', 'Leads: Last Dialed date & time',
 'Leads now show when the number was last dialed. A new Last Dialed column appears on the Classic leads list (date + time), and the last-dialed time also shows in the lead detail panel and the dial badge tooltip.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;


-- MODERN_COL_PICKER_v1 (2026-06-27)
INSERT INTO changelog (tag, title, body, audience, created_at) VALUES
('MODERN_COL_PICKER_v1', 'Modern leads: column picker + Last Dialed column',
 'The Modern leads view now has a Columns option in the ⋮ menu to show/hide columns, and a new Last Dialed column (date + time) is available there too.',
 'tenant_admin', NOW())
ON CONFLICT DO NOTHING;
