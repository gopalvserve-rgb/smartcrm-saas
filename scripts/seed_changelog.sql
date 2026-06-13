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
