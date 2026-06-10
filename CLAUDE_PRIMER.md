# CLAUDE PRIMER — read me first every session

**One-shot bootstrap** for Claude (or any agent) working on the SmartCRM tenant project. Read this **once** at session start instead of re-scanning conversation history.

Last updated: 2026-06-09. Owner: Gopal (gopalvserve@gmail.com).

If you need depth, see the deep docs in the same folder:
- `SMARTCRM_SAAS_GUIDE.md` — 512-line codebase tour (the full guide)
- `RECORDING_ARCHITECTURE_AND_LOCKDOWN.md` — call+recording sync architecture, files that must not be touched
- `CALL_RECORDING_SYNC_ARCHITECTURE.md` — APK-side call/recording flow
- `META_CAPI_v1_ARCHITECTURE.md` — Meta CAPI build plan (scheduled Friday)
- `SmartCRM_Phone_Setup_Guide_v2.md` — per-OEM phone permission guide

---

## 1. The product universe

Three nearly-identical CRMs serve different brands:

| Repo | URL | Railway | Brand |
|---|---|---|---|
| `gopalvserve-rgb/smartcrm-saas` | https://crm.smartcrmsolution.com | project `intuitive-charm`, service `lead-crm` | SmartCRM (multi-tenant SaaS) |
| `gopalvserve-rgb/lead-crm-node` | https://crm.celesteabode.com | (Railway) | Celeste Abode (single-tenant) |
| `gopalvserve-rgb/lead-crm-stockbox` | https://crm.stockboxtech.com | (Railway) | Stockbox Technologies |

`smartcrm-saas` is the canonical multi-tenant codebase. Tenants live at `/t/<slug>/` and each has its own Postgres DB `tenant_<slug>`. Celeste + Stockbox are forks that started single-tenant and lag features.

**Stack everywhere:** Node 22, Express, vanilla-JS SPA (no framework), PostgreSQL. Mobile clients are Capacitor APKs (Android only).

---

## 2. Workflow: how a feature actually ships

1. `cd /tmp/<repo>` (cloned via PAT below; clone fresh if missing)
2. Edit code → `node --check <file>` to syntax check
3. **Bump `app.js?v=YYYY-MM-DD-feature-vN`** in `public/tenant/index.html` (smartcrm) or `public/index.html` (Celeste/Stockbox) so browsers fetch the new code. Critical — without this, the user keeps seeing old JS.
4. **Add a changelog row** to `scripts/seed_changelog.sql` per the CHANGELOG_v1 protocol (every user-visible push). Feeds the 🎁 What's New panel.
5. `git add -A && git commit -m "<TAG>_v1: ..."` (TAG style, mention symptom + root cause + fix)
6. `git push origin main` → Railway auto-deploys from `main` in ~2-3 min
7. Tell the user to **hard refresh** (Ctrl+Shift+R) once Railway is green.

**GitHub PAT** (no expiration, repo scope) is stored at `/sessions/keen-magical-fermat/mnt/tenant sass/.github-token`. Clone with `https://<PAT>@github.com/gopalvserve-rgb/<repo>.git`.

---

## 3. Top 8 landmines (the bugs I keep hitting)

These are the patterns that have burned us multiple times. **Check first** before assuming a fix worked.

### 3.1 `db/pg.js` SCHEMA cache silently drops new columns
`db.update(table, id, patch)` runs `_serialize(table, patch)` which filters every key through `SCHEMA[table].columns`. If you `ALTER TABLE ADD COLUMN` in `_ensureSchema()` but forget to add the column to the SCHEMA constant in `db/pg.js`, the column is silently stripped on every save and the column never changes in DB. Save returns OK, reads always show the old value. **Fix in same commit as the ALTER**. Bit us with GCONV_SHEETS_v1.

### 3.2 Modal CSS classes
Two patterns, easy to confuse:
- **Correct:** `class: 'modal-backdrop'` (outer, fixed positioning) wraps `class: 'modal'` (inner card)
- **Wrong:** `class: 'modal'` (outer) wraps `class: 'modal-content'` (which doesn't exist in CSS)

If a "modal" looks like it renders at the bottom of the page with no overlay, it's the wrong class set. CEL_TASK_VIEW_FIX_v1 + many editor modal fixes.

### 3.3 Click-outside-to-close on modals
User wants modals to **only** close via Close button (avoids losing typed data). Don't add `onclick: ev => { if (ev.target === backdrop) backdrop.remove(); }` to backdrops in Celeste. CEL_MODAL_STICKY_v1.

### 3.4 Per-tenant config cache (60s TTL) in `routes/recordings.js`
`_autoleadCfgByTenant` caches CALLS_AUTOLEAD_* for 60 seconds **keyed by tenant dbName** (was a singleton, fixed in SHIPUNCLE_CALL_LEAD_v1). When you add a config-mutating endpoint, **bust the cache** — see `_clearAutoleadCfgCache` exported from recordings.js, called by `api_admin_setConfig` in routes/admin.js. SC_CALL_LEAD_AUTOSAVE_v1.

### 3.4b The empty-string config trap — DON'T use `String(v || 'default')`
Older save paths sometimes wrote `""` to the config table when the SPA sent `false`/`0`/`undefined`. Reading code like `String(inb || '1')` flips `""` back to `'1'` (the default) — even though the user explicitly saved OFF. **SPA shows OFF, backend behaves as ON.** Bit us twice (Shipuncle 2026-06-02, then trinetra/sa-palss-prop 2026-06-10). **Always read config booleans with explicit comparison**: `(String(inb) === '1') ? '1' : '0'`. Never the `|| 'default'` fallback. Same trap applies to `Number(v) || default` (since `Number('')` is `0`). CALL_LEAD_EMPTYSTR_FIX_v1.

### 3.5 Save buttons that users miss
Cards with their own dedicated `💾 Save` button are forgotten by admins who think toggling = saving. **Prefer auto-save on `onchange`** with a clear `✓ Saved · HH:MM:SS` indicator. Keep a manual Save button as belt-and-braces. The Google Conv Export Sheet card and the Call→Lead card both got rebuilt this way.

### 3.6 Partial-save aware endpoints
When the SPA sends a subset of fields, the save endpoint must treat **every undefined field as "leave it alone"** — not as "reset to default". Otherwise an autosave that only ships `{sheet_url}` wipes `is_enabled` etc. GCONV_SHEETS_PARTIAL_SAVE_v1 pattern: each field gets `typeof p.X === 'boolean' ? p.X : undefined` or `p.X !== undefined ? Number(p.X) : undefined`, then `Object.keys(row).forEach(k => row[k]===undefined && delete row[k])` before `db.update`.

### 3.7 Cache bust the app.js cache key
Server-side fix not visible to user? They have stale `app.js` cached. Always bump `?v=...` in `public/tenant/index.html` (smartcrm) or `public/index.html` (Celeste/Stockbox) when changing SPA code. GCONV_CACHE_BUST_v1 + many.

### 3.8 Multi-tenant isolation
ALL DB reads/writes happen inside `db.tenantStorage.run({ pool, tenant, slug }, () => ...)`. If you write a background worker that iterates tenants, you MUST wrap each tenant's work in that storage block (see `_runGoogleConvForAllTenants` in server.js). Reading from `db.*` outside the storage talks to the control DB or errors out.

---

## 4. Key files — what to grep first

### smartcrm-saas
| File | What it has | When to open |
|---|---|---|
| `server.js` (~3500 lines) | ALL Express routes, webhook handlers, background workers | New endpoint, webhook bug, scheduler change |
| `routes/saas/tenantApi.js` | ROUTE_FILES list — register a new `routes/*.js` here | Adding `api_*` functions in a new file |
| `db/pg.js` | Tenant pool, SCHEMA cache, `getConfig/setConfig`, `tenantStorage` | Add a table/column, debug "value didn't save" |
| `control/db.js` + `control/schema.sql` | Control plane | Tenant/package/audit work |
| `utils/auth.js` | `authUser`, `getVisibleUserIds` (hierarchy), JWT | Permissions, "user can/can't see" bugs |
| `routes/recordings.js` | Call events, lead auto-create from calls, recording sync | Any call/recording bug |
| `routes/whatsbot.js` | WhatsApp Cloud API, templates, send paths, webhooks | WA template / send bugs |
| `routes/leads.js` | Lead CRUD, dedup, automation hooks | Lead create/edit/import |
| `routes/admin.js` | `api_admin_setConfig` (CONFIG_KEYS allow-list) | Any new tenant-config key — must be added to CONFIG_KEYS |
| `public/tenant/app.js` (~50K lines) | The single SPA. ALL views live here. | Any UI change |
| `public/tenant/index.html` | Cache key bump lives here on lines ~124 + ~165 | Every SPA push |
| `scripts/seed_changelog.sql` | Append a row per user-visible push | Every push |

### Celeste / Stockbox
Same structure but **single-tenant** (no `routes/saas/`, no `/t/<slug>/` prefix). SPA is `public/app.js` + `public/index.html`. Many features are **lagging** behind smartcrm-saas by days — when porting, diff the two.

---

## 5. SPA patterns (vanilla JS, no framework)

- **`h(tag, props, ...children)`** is the React-ish DOM helper. Don't import React.
- **`api(funcName, ...args)`** is the RPC client → POST `/t/<slug>/api/<funcName>` with `[args]` body.
- **`VIEWS.<name> = async (view) => { ... }`** is the page renderer. Routes are added to the sidebar via `MENU` config.
- **`navigateTo('users')`** re-renders the named view.
- **`CRM.cache.*`** holds warm caches (`users`, `statuses`, `sources`, `tags`, etc.). Populated by `warmCache()` on boot.
- **`CRM.user`** is the logged-in user (`role`, `id`, `name`).
- **`CRM.token`** is the JWT in localStorage as `crm_token` (key was `crm_token` not `token` — DEVICE_DIAG_TOKEN_KEY_FIX_v1).
- **`toast(msg, 'ok'|'err')`** for transient feedback.
- **`/api/wa-sample`** hosts a one-off file and returns `{ url }` — used for WA template media samples and now for Initiate Chat header upload.

---

## 6. The Call → Lead subsystem (revisit every few weeks)

**3 paths** in smartcrm-saas can auto-create a lead from a phone call. ALL must respect `CALLS_AUTOLEAD_INBOUND` / `CALLS_AUTOLEAD_OUTBOUND`:

1. `api_call_logEvent` (RING) — `routes/recordings.js:147`. Uses cached `_getAutoleadCfg`.
2. `api_call_handleEnded` (END) — `routes/recordings.js:868`. Reads directly via `db.getConfig`.
3. Recording upload — `routes/recordings.js:1376`. Reads directly.

**Plus** `api_call_events_convertToLeads` — the manual bulk-convert button. Intentionally bypasses the toggle (it's admin-triggered).

The user's checkbox is in `public/tenant/app.js` near line 27850, now auto-saves on toggle (SC_CALL_LEAD_AUTOSAVE_v1).

**Celeste has only 2 paths** (no logEvent ring autocreate) and **no cache** (getConfig hits DB every time). Already auto-saves. Don't re-port.

---

## 7. WhatsApp template send — 3 entry points

When the user reports "template send doesn't ask for image", check which modal:

1. **📋 in chat compose** → `openWaTemplatePicker` (`public/tenant/app.js:16798`) — rebuilt with category filter + media upload form (WA_TPL_SEND_v1)
2. **🟢 on lead row → "Initiate Chat"** → `openInitiateChatModal` (`public/tenant/app.js:16138`) — now shows file picker for media headers (WA_TPL_SEND_INITIATE_v1)
3. **Bulk WhatsApp campaign** → `api_wb_campaigns_create` — already collected image_url

**Backend send fn:** `_sendTemplate` in `routes/whatsbot.js:1041`. Looks up `wa_templates.header_type` and emits the right component shape: `{type: 'image'|'video'|'document', ...}`. Was hardcoded to image — fixed WA_TPL_SEND_v1.

---

## 8. Meta + FB + WhatsApp scope state

**Single Meta App for everything:** `PLATFORM_FB_APP_ID = 965594974738358`.

**Scopes in OAuth flow** (`routes/fb.js:670-677`) — already approved:
```
pages_show_list, pages_read_engagement, pages_read_user_content,
pages_manage_ads, leads_retrieval, ads_management, ads_read,
business_management
```

**Per-tenant tokens** live in:
- `social_pages.access_token` (page-level, for FB/IG/Messenger)
- `social_ad_accounts.access_token` (user-level w/ ads_management — used for Marketing API + Offline CAPI)
- WhatsApp uses its own `wa_phones.access_token` (per WABA phone number)

**Webhooks are independent** — FB Lead Ads (`/hook/meta` with `leadgen` field) vs Messenger/IG (`messenger` + `messages`) vs WhatsApp (`whatsapp_business_account`). Touching one never touches the others.

---

## 9. Custom roles & visibility

`utils/auth.js → getVisibleUserIds(me)` returns the set of user IDs a request can see leads/users for.

- `admin` (level 0) → everyone
- `manager` (level 1) → self + descendants depth 10
- `sales`/`employee` (level 3) → self only
- **Custom roles** (e.g. `rsm`, `sh`, `bdm` on trinetra) → look up `roles.hierarchy_level`:
  - 0 = admin-equivalent
  - 1 = depth 10 (whole subtree)
  - 2 = depth 2
  - 3+ = self only (falls through)

When user complains "X can see leads they shouldn't" — open Settings → Roles → check levels. TRINETRA_VISIBILITY_AUDIT.

---

## 10. Active tenants worth remembering

| Slug | Brand | Notes |
|---|---|---|
| `vserve` | Vserve / Bharat Fuel | Owner's main tenant — primary test bed |
| `trinetra` | Trinetra / Bharat Fuel | Custom hierarchy (bdm/rsm/sh roles) |
| `sa-palss-prop` | Palss Prop | Real Estate flavor |
| `learnimo` | Learnimo | Education pack |
| `shipuncle` | Shipuncle | Logistics, lots of call sync work |
| `bhumija` | Bhumija Organic | Marketing-heavy WA templates |
| `showcase-*` | demo tenants | Solar / Finance / Mfg / Holiday / Ecommerce / RE — used for sales demos |

Tenants run on the same Railway service, isolated by Postgres DB.

---

## 11. Recurring credential paths

| What | Path | Notes |
|---|---|---|
| GitHub PAT | `/sessions/keen-magical-fermat/mnt/tenant sass/.github-token` | No expiration, repo scope |
| Firebase service accounts | `.firebase/app-mobile-7f4c6.json` | The ACTIVE one for all 3 backends |
| GCONV Sheets shared OAuth | sales@smartcrmsolution.com (master account) | One-time consent already done |
| Railway env vars | Set via Railway dashboard or `railway` CLI | Most: `DATABASE_URL`, `JWT_SECRET`, `PLATFORM_FB_APP_*`, `META_ACCESS_TOKEN` |

---

## 12. Stuff the user has explicitly told me

These are **standing orders** — don't re-do or undo them:

- **`REC_AUTOSYNC_KILL_v1` (2026-06-06)** — All 4 recording auto-sync trigger points are disabled. User uploads via manual Sync buttons only. **Don't re-enable** without explicit confirmation.
- **`CHANGELOG_v1` protocol** — Every user-visible push MUST add a row to `scripts/seed_changelog.sql`. Non-negotiable.
- **`Don't do anything 1st tell me`** — when investigating bugs, REPORT first and wait for confirmation before making changes.
- **No emojis in files** unless explicitly requested (but emojis ARE used heavily in CRM UI strings already — keep that consistency).
- **AI Call Audit OFF by default** — task #930 still pending; don't enable globally.
- **`MEMORY_KB_UPDATE` (2026-06-10)** — Every new user prompt, update memory and/or this primer with anything newly learned (modules, permission rules, schema bumps, deferred work, bug patterns). Don't wait to be asked. See `memory_kb_update_protocol.md`.
- **`TEAM_LIVE_PERMS_v2` (2026-06-10)** — Live Team Status visibility is controlled by the role permissions matrix (Settings → Permissions row **"View Live Team Status (whole team)"**, key `dashboard.team_live_status`). Admins always pass. Defaults: admin/manager/team_leader = ON, sales = OFF, custom roles = OFF. Backend lookup in `routes/team.js` calls `_perms.can(me, 'dashboard.team_live_status')`. Catalog + DEFAULTS live in `routes/permissions.js`. When the user reports "X widget needs a permission", add it to the CATALOG + DEFAULTS — the Permissions UI auto-renders new rows.

---

## 13. Deferred work (don't touch unless user asks)

- **`META_CAPI_v1` — scheduled Friday 2026-06-12.** Full plan in `META_CAPI_v1_ARCHITECTURE.md`. User picks 1A/2A/3A. Don't start early.
- **`BILL-B` through `BILL-F`** — Tenant Billing pages + Cashfree integration. Still pending.
- **Help guide batches 2 & 3** — Pabbly/Meta/Google docs + Onboarding docs.
- **Help screenshots** via Chrome — pending capture pass.
- **Backfill tenant ai_chat_log → control.ai_usage_log** — task #146 pending.

---

## 14. Standard tactical playbooks

### "User says X feature is broken"
1. **Don't fix yet.** Investigate first.
2. Grep for the relevant `api_*` function in `routes/*.js` (smartcrm) or `routes/*.js` (Celeste/Stockbox).
3. Grep the SPA for where the action fires (`onclick`, `addEventListener`).
4. Look at the DB schema (`db/pg.js` SCHEMA cache + `_ensureSchema()` in the route).
5. Report findings; ask for confirmation before patching.

### "Need to add a new tenant config key"
1. Add to `CONFIG_KEYS` array in `routes/admin.js` (allow-list — otherwise `api_admin_setConfig` silently drops it).
2. Add to `api_admin_getConfig` exposure list if it should be readable.
3. Default value in `db.getConfig(key, defaultValue)` calls.
4. If it's read on a hot path with a per-tenant cache — wire a cache-bust in `api_admin_setConfig`.

### "Need to add a new column to a tenant table"
1. Add `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` in the relevant `_ensureSchema()` function.
2. **SAME COMMIT:** add the column name to the SCHEMA cache in `db/pg.js`. Otherwise silent drop.
3. If it's JSON, add to the `json: [...]` array too.

### "User wants to port feature from smartcrm-saas to Celeste/Stockbox"
1. Clone the destination repo (PAT path above).
2. Diff the relevant SPA section + route file.
3. Watch for: single-tenant routes don't have `tenantStorage`, modal CSS class names sometimes diverge, cache key location differs (`public/index.html` not `public/tenant/index.html`).
4. Bump cache key + add changelog row + push.

### "Railway hasn't deployed"
1. Open Railway dashboard for the relevant project (`intuitive-charm` for smartcrm-saas).
2. Check Deployments tab — failed builds show up red.
3. Common: orphan comment text causing JS syntax error (HOTFIX v4 pattern). Run `node --check public/tenant/app.js` locally before committing.

---

## 15. How to use this doc

- **At session start:** read this file (and only this file) to bootstrap.
- **When you learn something new** that future-you should know: edit this doc and commit it.
- **When this doc disagrees with the actual code:** trust the code, then fix this doc.
- **When this doc gets too long:** split a section into its own deep doc and link to it from here.

That's it. Go.
