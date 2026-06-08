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
        E'Super-admin can now install 5 new industry packs on any tenant:\n• Finance — insurance, loans, investments\n• Solar — rooftop survey, quotes, subsidy\n• Manufacturer — RFQ, production, dispatch\n• Holiday — packages, bookings, itineraries\n• Ecommerce — orders, returns, abandoned carts, loyalty\n\nEach pack seeds industry-specific statuses + custom fields + sample products and exposes a sidebar menu with the most-needed views. Open any tenant in super-admin → Industry Pack → Install.',
        'feature', NOW())
ON CONFLICT (version) DO NOTHING;

-- SHOWCASE_PHASE_2_v1 (2026-06-07) — Demo showcase tenants for 5 new packs
INSERT INTO control.changelog (version, title, body, kind, released_at)
VALUES ('SHOWCASE_PHASE_2_v1', '5 new showcase demo tenants with dummy data',
        E'Super-admin can now spin up 5 new fully-populated demo tenants from the Demo Seeder panel:\n• showcase-finance — TrustBridge Financial Services (8 policies, claims, premium schedule)\n• showcase-solar — SunBright Solar Solutions (6 site surveys, 6 quotes, 3 installations)\n• showcase-mfg — Precision Industries (8 RFQs, 4 production orders, 1 dispatch)\n• showcase-holiday — WanderWise Travel (8 bookings, day-wise itineraries, vouchers)\n• showcase-ecommerce — KartFlow D2C Store (10 orders, returns, 5 abandoned carts, loyalty tiers)\n\nEach demo tenant: shared admin login (demo-finance@smartcrm.in / Showcase@123 etc), seeded leads + users + statuses + custom fields + 30-day pack-specific transactions.',
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
