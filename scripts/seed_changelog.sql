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
   '#/dashboard', '⇆', NOW())
) AS v(category, title, body, link, icon, created_at)
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE changelog.title = v.title);
