INSERT INTO control.changelog (title, body, kind, ship_date, is_published)
VALUES (
  'WA Report v2 — campaigns, button clicks, drill-down',
  'WhatsApp Report upgraded: 1) Campaign filter chip + new "By campaign" card with per-campaign sent/delivered/read/failed/clicked. 2) "Template button clicks" card — see who clicked each Quick Reply / URL button, per campaign. 3) Every numeric cell (KPI tiles, By Campaign rows, Button Click counts) is now clickable — opens a list of the underlying leads. Click a row in that list → opens that lead''s WhatsApp chat. Campaigns are now stamped on every outbound WA message so attribution survives reporting.',
  'feature',
  CURRENT_DATE,
  1
)
ON CONFLICT DO NOTHING;
