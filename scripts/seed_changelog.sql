INSERT INTO control.changelog (title, body, kind, ship_date, is_published)
VALUES (
  'SALES_REASSIGN_USERLIST_v1',
  'Sales users with the Reassign-own-leads permission now actually see other users in the Lead "Assigned To" dropdown. Previously the dropdown only listed the sales user themselves (hierarchy-scoped) so there was nobody to reassign to. The write-side guard still ensures Sales can only reassign leads they currently own.',
  'fix',
  CURRENT_DATE,
  1
)
ON CONFLICT DO NOTHING;
