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
   '#/settings/statuses', '🚦', NOW())
) AS v(category, title, body, link, icon, created_at)
WHERE NOT EXISTS (SELECT 1 FROM changelog WHERE changelog.title = v.title);
