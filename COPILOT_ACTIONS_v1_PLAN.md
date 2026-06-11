# CRM Copilot Action Expansion — v1 Build Plan (CP_ACT_v1)

**Approved by user:** 2026-06-11
**Beta scope:** vserve tenant ONLY (other tenants stay read-only)
**Status:** Design locked, ready to execute Phase 0+1 next session

---

## Locked Design Rules

1. **Two-phase write, always.** Every write tool: (a) explain in plain language what's about to happen, (b) render a preview card showing exact changes, (c) wait for user Confirm tap. No write proceeds without explicit Confirm.
2. **Intent classification.** Copilot distinguishes:
   - **One-time action** ("transfer", "move", "reassign these to") → acts on existing leads NOW, no rule created
   - **Standing rule** ("set up rule", "auto assign", "always", "going forward") → creates rule, doesn't touch existing
   - **Ambiguous** → pick the safer one (rule), then offer the complementary action as a follow-up suggestion
3. **No clarifying chips for things Copilot can decide.** Pick sensible defaults (round-robin, the role-relevant person when names collide, oldest-first for transfers). User can correct in plain text after.
4. **Vserve-only beta gate.** Per-tenant config key `COPILOT_ACTIONS_ENABLED`. Default `'0'`. Set to `'1'` only on vserve. Other tenants get a polite "this is in beta, not enabled for your tenant" reply if they request an action.
5. **Audit log on every write.** Table `copilot_actions` captures actor user_id, tool name, args JSON, preview text shown, confirm timestamp, result, IP. Every production change is traceable to the exact chat turn.

---

## Phase 0 — Foundation (next session)

### Backend: `routes/crmCopilot.js`

Add to `_ensureTables()`:
```sql
CREATE TABLE IF NOT EXISTS copilot_actions (
  id              SERIAL PRIMARY KEY,
  confirm_token   VARCHAR(40) NOT NULL UNIQUE,
  user_id         INTEGER NOT NULL,
  tool_name       VARCHAR(80) NOT NULL,
  args_json       JSONB NOT NULL,
  preview_text    TEXT NOT NULL,
  preview_card    JSONB,          -- structured card (title/rows/scope)
  state           VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|confirmed|cancelled|expired|failed
  result_json     JSONB,
  error_text      TEXT,
  ip_addr         VARCHAR(64),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
);
CREATE INDEX IF NOT EXISTS idx_copilot_act_user_day
  ON copilot_actions(user_id, created_at DESC);
```

Add gate helper:
```javascript
async function _actionsEnabled() {
  const v = await db.getConfig('COPILOT_ACTIONS_ENABLED', '0');
  return String(v).trim() === '1';   // explicit === '1', avoid empty-string trap
}
```

Add preview-builder + confirm endpoint:
```javascript
async function _buildPreview(toolName, args, ctx) {
  // 1. Validate args, resolve entity names → IDs (e.g. "Amit" → user_id 47)
  // 2. Generate human-readable explain text
  // 3. Generate structured preview_card payload (title + rows)
  // 4. Insert into copilot_actions (state='pending'), return confirm_token
}

async function api_copilot_confirm(token, confirm_token) {
  // 1. authUser(token)
  // 2. Load copilot_actions row by confirm_token + user_id
  // 3. Check state==='pending' && expires_at > now
  // 4. Dispatch to the actual write function for tool_name
  // 5. Update row: state='confirmed', result_json, confirmed_at
  // 6. Return { ok, message, view_url? }
}
```

Wrap action tools in dispatcher:
```javascript
async function _runActionTool(name, args, ctx) {
  if (!await _actionsEnabled()) {
    return { _refuse: 'Copilot write actions are in beta and not yet enabled for your tenant. Contact support to opt in.' };
  }
  return _buildPreview(name, args, ctx);   // never executes — only previews
}
```

Update Gemini system prompt to teach intent classification + that "transfer" vs "set up rule" are different tools.

### SPA: `public/tenant/app.js`

In the Copilot widget's message renderer (around line 34427):

```javascript
// If response.action_preview is present, render preview card instead of plain text
if (response.action_preview) {
  const card = response.action_preview;
  appendMsg('assistant', card.explain);
  appendMsg('preview-card', {
    title: card.title,
    rows: card.rows,
    confirm_token: card.confirm_token,
    expires_at: card.expires_at
  });
}
```

New render path for `preview-card`:
- Title bar
- Rows table (label → value)
- Single `Confirm` button + `cancel` text link
- On Confirm: `api('api_copilot_confirm', confirm_token)` → render success message + optional "View →" link
- On cancel: just remove the card, post a "Cancelled" line

### Cache + Deploy

- Bump `<script src="/tenant/app.js?v=2026-06-11-copilot-actions-v1">` in `public/tenant/index.html`
- Bump SW cache key
- Commit message: `CP_ACT_v1 Phase 0: action foundation + vserve-gated beta`
- Add changelog row per the standing protocol (`scripts/seed_changelog.sql`)
- Set `COPILOT_ACTIONS_ENABLED=1` via super-admin SQL on vserve tenant only:
  ```sql
  INSERT INTO config (key, value) VALUES ('COPILOT_ACTIONS_ENABLED', '1')
  ON CONFLICT (key) DO UPDATE SET value = '1';
  ```

---

## Phase 1 — First Wave Action Tools (8)

Each follows the `_runActionTool` → `_buildPreview` → confirm pattern.

| Tool | Trigger | Preview shows | Writes to |
|------|---------|---------------|-----------|
| `create_autoassign_rule` | "set up auto assign", "any X lead should go to Y" | Rule name, when condition, assignees, distribution mode, scope (new/existing/both) | `auto_assign_rules` |
| `reassign_leads_bulk` | "transfer", "move", "reassign these leads" | Filter that selects leads, count, target user(s), method | `leads.assigned_to` (bulk UPDATE) |
| `create_user` | "add user", "create user for X" | Name, email, role, password (generated, shown once) | `users` |
| `create_status` | "add status X", "create new status" | Name, color, sort order, terminal flag | `statuses` |
| `create_source` | "add source X" | Name, sort order | `sources` |
| `create_custom_field` | "add field for X" | Label, key, type, options | `custom_fields` |
| `create_product` | "add product X with price Y" | Name, SKU, price, GST | `products` |
| `set_tat_rule` | "TAT for X should be Y hours" | Status, hours, escalation | `tat_rules` |

---

## Phase 2 — More Action Tools (later batches)

Sketched in earlier conversation: ~56 tools total across 10 domains. Build in batches of 6-8 after each batch proven on vserve.

Domains: Leads ops, User mgmt, CRM config, WhatsApp/Bot mgmt, Automation/Webhooks, Reporting, Campaigns, Integrations, Industry packs, Audit/Compliance.

---

## What NOT to do in Phase 0

- Don't enable on any tenant except vserve
- Don't add chips/buttons that Copilot could decide itself — the model picks defaults, user corrects in chat
- Don't skip the preview card for "obvious" writes — every write goes through the gate
- Don't combine multiple writes in one Confirm — one rule = one preview = one Confirm

---

## Acceptance criteria

On vserve only:
1. Type "set up auto assign rule: all Meta leads to Amit and Rohan round robin" → Copilot shows preview card with rule details → Confirm → rule appears in Settings → Auto-assign
2. Type "transfer all Meta leads to Amit and Rohan round robin" → Copilot shows preview card with count + filter + target → Confirm → leads reassigned, visible in lead list
3. Type "add user Priya, sales role" → preview card with generated password → Confirm → user appears in Users page
4. On any other tenant: same prompts return "this is in beta, not enabled for your tenant"
5. `copilot_actions` table has one row per Confirm with full audit trail
