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
