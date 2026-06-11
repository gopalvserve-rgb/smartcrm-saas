-- CP_ACT_v1 — enable Copilot write actions ONLY on vserve tenant for beta.
-- Run this AFTER deploy. Other tenants stay read-only by default.
--
-- Apply on vserve tenant DB only:
--   INSERT INTO config (key, value) VALUES ('COPILOT_ACTIONS_ENABLED', '1')
--   ON CONFLICT (key) DO UPDATE SET value = '1';
--
-- To disable later (kill switch):
--   UPDATE config SET value = '0' WHERE key = 'COPILOT_ACTIONS_ENABLED';

-- Control DB changelog row (run on control schema)
INSERT INTO changelog (version, title, body, audience, created_at)
VALUES (
  'cp-act-v1',
  '✨ Copilot can now SET UP rules (beta on vserve)',
  'Ask Copilot in plain English: "set up auto assign for Meta leads to Amit and Rohan round robin", "transfer all Meta leads to Amit", "add status In-Progress", "add source LinkedIn". Copilot shows a preview card with a single Confirm button before any change is saved. Beta — enabled on vserve only.',
  'admin',
  NOW()
) ON CONFLICT (version) DO NOTHING;
