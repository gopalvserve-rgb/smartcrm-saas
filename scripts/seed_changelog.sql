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
