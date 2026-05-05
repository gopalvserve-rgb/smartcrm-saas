/**
 * Default knowledge-base seed for newly provisioned tenants.
 *
 * Why this exists:
 *   New tenants land in an empty CRM with zero documentation. The first-run
 *   tour walks them through the layout (where the Leads / WhatsBot / Reports
 *   tabs live), but they still need long-form how-to guides for the things
 *   they'll do every day — adding leads, importing CSVs, connecting WhatsApp,
 *   building automation rules. This module seeds that content as
 *   knowledge_base rows so it's discoverable from inside the product
 *   (Knowledge tab → search) instead of buried in an external help site.
 *
 * Idempotent: rows are tagged with `tags: 'system-seed'`. We delete any
 * existing system-seed rows and re-insert from `DEFAULT_ARTICLES` on every
 * call, which means upgrading the seed content just means redeploying — no
 * migration scripts.
 *
 * Admins can edit / pin / soft-delete these rows freely from the Knowledge
 * UI; only re-seeding (tenant→Re-seed help articles, or re-provisioning)
 * will overwrite their changes, and only for system-seed rows.
 */

// One-place catalog of starter articles. Markdown-friendly bodies; the
// Knowledge tab renders newlines and basic markdown via the existing
// _renderKbBody() helper in app.js. Keep titles snappy — they're shown
// in the search list as a one-liner.
const DEFAULT_ARTICLES = [
  {
    title: 'Welcome — how SmartCRM is organised',
    category: 'faq',
    is_pinned: 1,
    body:
`SmartCRM groups every screen into 5 sections in the left sidebar:

• **Sales** — Leads, Pipeline, Kanban, Follow-ups, Calendar, Targets, New leads, Overdue, Due today, Upcoming
• **Calls** — Dialer, Call insights, Call ratings, AI usage
• **Catalog** — Inventory, Projects (units / lots tracking)
• **Reports** — Reports, Report builder, TAT report
• **Workspace** — WhatsBot, Knowledge (this tab), Team chat
• **HR & Me** — Tasks, Attendance, Leaves, Salary, Bank
• **Admin** — Users, Settings (admin only)

The topbar always shows quick chips: ✨ New, ⚠️ Overdue, 📅 Due today, ⏰ Upcoming.

To re-watch the welcome tour: this tab → 🎬 Re-watch tour button.`
  },
  {
    title: 'How to add a new lead',
    category: 'faq',
    body:
`**Single lead — 30 seconds:**
1. Click **Leads** in the sidebar
2. Click **+ Add lead** (top right)
3. Fill in: name, phone, email, source, status, owner
4. Save — the lead appears at the top of the list

**Required vs. optional:** Phone is the only mandatory field by default. Admins can mark any custom field as required from Settings → Custom Fields.

**Auto-assignment:** if you've configured assignment rules (Settings → Rules), the system will route leads to a rep automatically — leave the Owner field blank to let the rule decide.

**Status colours:** the colour you pick when you create a status (Settings → Statuses) is what shows on the lead row, Kanban card, and dashboard funnel.`
  },
  {
    title: 'Bulk import leads from a CSV file',
    category: 'faq',
    body:
`Import dozens or thousands of leads at once.

**Steps:**
1. Click **Leads → Bulk upload** (top right)
2. Click **Download sample CSV** to see the exact column names
3. Open the sample in Excel / Google Sheets, fill in your rows
4. Save as **.csv (Comma delimited)** — not .xlsx
5. Drag the file onto the upload zone, click **Validate**
6. Review the preview: green rows will import, red rows show errors
7. Click **Import**

**Tips:**
• Phone numbers must be unique — duplicates either silently re-assign to the same owner (default) or are rejected, depending on your duplicate setting (Settings → Leads).
• If a custom field is missing in the CSV but marked required, the row is skipped.
• Bulk imports respect your monthly leads quota — see Settings → Plan.`
  },
  {
    title: 'Connect WhatsApp Business to SmartCRM',
    category: 'faq',
    body:
`SmartCRM uses the **Meta WhatsApp Cloud API** — official, no scraping, no banning. You need:
• A WhatsApp Business number (a fresh number works best)
• A Meta business account

**Steps:**
1. Open **Settings → WhatsApp** (admin only)
2. Click **Connect with Facebook**
3. In the popup: pick the business, the WhatsApp account, and the phone number
4. Verify the number (Meta sends a 6-digit code via SMS / call)
5. Approve the permissions — done

Once connected:
• **WhatsBot tab** lights up with your live chats
• Inbound messages auto-create leads (status = your default New status)
• You can build templates, run bulk campaigns, set up chatbot flows

**Forwarder note:** if multiple CRMs share one WhatsApp number, the central forwarder will route messages here automatically — no extra setup.`
  },
  {
    title: 'Send a bulk WhatsApp campaign',
    category: 'faq',
    body:
`Run a campaign to a saved filter or a CSV list.

**Steps:**
1. Open **WhatsBot → Campaigns**
2. Click **+ New campaign**
3. Pick the **template** (you must have an approved Meta template — create one at business.facebook.com/wa/manage/message-templates/)
4. Pick recipients: Saved filter, Status, Owner, Tag, or upload a CSV
5. Schedule it now or pick a date/time
6. Click **Send / Schedule**

**What happens:**
• The campaign queues messages 1-by-1 to respect Meta's pacing rules
• Each message counts against your **WhatsApp send quota** (Settings → Plan)
• Replies land in the chat thread for that lead, with a green "From campaign" badge
• You can pause / cancel a running campaign from the campaigns list`
  },
  {
    title: 'Connect Facebook / Instagram Lead Ads',
    category: 'faq',
    body:
`Pull leads from your Facebook & Instagram ad campaigns into SmartCRM in real time.

**Steps:**
1. **Settings → Facebook Lead Ads** (admin only)
2. Click **Connect with Facebook**
3. Approve permissions — pick the pages whose lead forms should sync
4. SmartCRM auto-subscribes to webhooks for those pages

**Leads land instantly:** when someone submits an ad lead form, you'll see them in the Leads list within a few seconds, with the source set to "Facebook" (or "Instagram") and a tag matching the form name.

**Auto-dial:** if you've turned on Auto-dial (Settings → Rules), the assigned rep gets a push notification + a dial intent on their phone the moment the lead arrives.

**Reconnect:** if you change ad accounts or revoke permissions in Facebook Business, just click **Reconnect** on the same page.`
  },
  {
    title: 'Set up call recording on Android',
    category: 'faq',
    body:
`The Android app auto-attaches your call recordings to the right lead, so you can replay the conversation later from the lead's page.

**Required:**
• Recording must already be enabled in your phone's call recorder app (Stock Recorder, Truecaller, ACR, etc.)
• You need to grant SmartCRM access to the folder where recordings are saved

**Steps (first run):**
1. Sign in on the SmartCRM Android app
2. The first-run modal asks you to **Pick recordings folder**
3. Pick the folder — common locations:
   - Stock Android → Recordings/Call
   - Samsung → Call
   - Xiaomi → MIUI/sound_recorder/call_rec
   - Truecaller → Truecaller folder
4. The app remembers it forever

**To change later:** Dialer → Settings → Pick recordings folder.

**AI Call Summary:** when enabled (Settings → AI), Gemini transcribes the recording and auto-fills the call summary, action items, and rating.`
  },
  {
    title: 'Manage users, roles and permissions',
    category: 'faq',
    body:
`SmartCRM has 4 built-in roles:

• **Admin** — full access, can change settings
• **Manager** — sees all leads, runs reports, no settings
• **Team leader** — sees their team's leads + reports
• **Agent** — sees only leads owned by them

**Add a user:**
1. **Users tab** (or Settings → Users)
2. Click **+ Add user**
3. Fill in name, email, mobile, role
4. The user receives a welcome email with a temporary password

**Each new user counts against your Users quota** — Settings → Plan shows current usage.

**Custom permissions:** Settings → Permissions lets admin override the defaults per-role (e.g. give Team leaders access to Reports, hide Salary from agents, etc.).`
  },
  {
    title: 'Build custom statuses, sources and products',
    category: 'faq',
    body:
`Tailor the dropdowns to match your business.

**Statuses** (Settings → Statuses):
• Add as many as you need — colour each one for the Kanban
• Mark as "live pipeline" (open) or "dead-end" (won/lost)
• 5 follow-up-required statuses (Follow Up, Visit Done, Visit Schedule, Re-visit, Not Pick) force users to set a follow-up date when they pick the status — admin is exempt

**Sources** (Settings → Sources):
• Where the lead came from — Facebook, Google, Walk-in, Reference, etc.
• Used in Reports → Source-wise conversion

**Products** (Settings → Products):
• What you're selling — service names, package SKUs
• Custom Products supports text input + dropdown wrappers (e.g. "Plot size: 600/900/1200/Custom")

These dropdowns drive every filter, report, and dashboard widget — set them up once, the rest of the system follows.`
  },
  {
    title: 'Create automation rules (auto-assignment, alerts)',
    category: 'faq',
    body:
`Rules run on lead create / update and can:
• Auto-assign to a specific rep (round-robin, by source, by tag)
• Send a WhatsApp template to the lead
• Notify a manager
• Set / change tags

**Create a rule:**
1. **Settings → Rules / Automations**
2. Click **+ New rule**
3. Pick the trigger: lead create / status change / no activity for N days
4. Pick the conditions: source = X, status = Y, tag contains Z
5. Pick the action: assign to / send WA template / notify / tag

**Example:** "When a Facebook lead arrives, assign to the rep with the fewest active leads, send the welcome WA template, and tag with 'fb-2025'."

Rules execute server-side — they fire even when no one is logged in.`
  },
  {
    title: 'Run reports and export data',
    category: 'faq',
    body:
`SmartCRM ships 3 reporting layers:

**1. Reports tab** — pre-built dashboards:
• Caller-wise performance (leads, conversions, talk-time, FU compliance)
• Source-wise / product-wise conversion funnel
• TAT violation report
• Monthly target achievement

**2. Report builder** — pivot any dimension by any metric, group / filter / chart:
• Pick rows (status, source, owner, tag)
• Pick columns (date bucket, status)
• Pick metric (count, sum of value, avg TAT)

**3. Custom export** — Leads tab → filter → "Export CSV / Excel" downloads exactly the rows you see.

All exports respect role permissions: agents can only export their own leads.`
  },
  {
    title: 'Mandatory follow-up dates explained',
    category: 'faq',
    body:
`When a non-admin user picks one of these 5 statuses, SmartCRM forces them to set a next follow-up date:

• Follow Up
• Visit Done
• Visit Schedule
• Re-visit
• Not Pick

**Why:** these are "live pipeline" statuses where the lead is still in play — without a follow-up date the lead silently rots. The forced date ensures it shows up on someone's Due / Overdue list.

**Where the prompt appears:**
• Lead modal — Save is disabled until a follow-up date is set
• Next-follow-up modal — date input is required
• Status quick-change from Kanban — opens the date picker first

**Admin exempt:** admins can save without a follow-up date (useful for bulk cleanup).

**Dead-end statuses** (Won / Lost / Junk) skip this entirely — once a lead closes, it doesn't need a follow-up.`
  },
  {
    title: 'Plan limits and quotas',
    category: 'faq',
    body:
`Your subscription has 3 quotas:

• **Total Users** — active user accounts (deactivate to free a seat)
• **Leads** — per-month or one-time, depending on plan
• **WhatsApp sends** — per-month outbound messages

**Where to check usage:**
Settings → Plan shows current usage vs. limit for each metric, with a progress bar.

**What happens when you hit a limit:**
• User-create is blocked with a 402 error → "Upgrade plan"
• Lead-create is blocked → CSV uploads halt at the limit
• WA send is blocked → campaigns pause

**To upgrade:** contact support — your billing admin can move you to a higher plan tier without losing data.`
  },
  {
    title: 'Webhook integration for third-party forms',
    category: 'faq',
    body:
`Push leads from website forms, landing pages, or other tools into SmartCRM via HTTP POST.

**Endpoint:** \`https://crm.smartcrmsolution.com/t/<your-slug>/api/webhooks/website\`

**Method:** POST · **Content-Type:** application/json

**Auth:** include either an \`x-api-key\` header or an \`Authorization: Bearer <key>\` header. Generate the key from Settings → Integrations → Webhooks.

**Body example:**
\`\`\`json
{
  "name": "Asha Kumar",
  "phone": "+919876543210",
  "email": "asha@example.com",
  "source": "Website",
  "remark": "Asked about premium plan",
  "tags": "homepage,demo-request"
}
\`\`\`

**Response:** \`{ "ok": true, "lead_id": 1234 }\`

The lead lands in your CRM instantly with the configured default status. Use the \`source\` field to attribute the campaign — it shows up in source-wise reports.`
  },
  {
    title: 'Where to find help / contact support',
    category: 'faq',
    is_pinned: 1,
    body:
`Stuck on something?

**Self-serve, in this order:**
1. **Knowledge tab** (this page) — search the title or any keyword
2. **Re-watch tour** button (top of this page) — replays the 60-second walkthrough
3. **Settings tooltips** — hover any ⓘ icon for inline help

**Contact support:**
• Email: support@smartcrmsolution.com
• Reply-time: under 4 business hours during weekdays
• Critical issue (live downtime): include the word "URGENT" in the subject — pages our on-call

**Before contacting support, please share:**
• Your tenant slug (the URL — \`/t/<slug>\`)
• The user role you're logged in as
• A screenshot of the error / behavior
• Browser + OS version (Chrome / Safari, Windows / Mac / iOS / Android)

That cuts our response time roughly in half.`
  }
];

/**
 * Re-seed the knowledge base of the given tenant DB.
 *
 * @param {Pool} pool — pg.Pool connected to the tenant DB
 * @param {{ adminUserId?: number }} opts
 *   - adminUserId: who to credit as `created_by` (defaults to id=1, the
 *     auto-seeded admin user from provisioning)
 */
async function seedTenantKnowledgeBase(pool, opts) {
  if (!pool) throw new Error('seedTenantKnowledgeBase requires a pg.Pool');
  const adminUserId = (opts && opts.adminUserId) || 1;

  // Wipe previous system-seed rows so re-seeding is idempotent.
  await pool.query(
    `DELETE FROM knowledge_base WHERE tags = 'system-seed'`
  );

  for (const a of DEFAULT_ARTICLES) {
    await pool.query(
      `INSERT INTO knowledge_base
         (title, category, body, url, tags, product_id,
          is_pinned, is_active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, '', 'system-seed', NULL,
               $4, 1, $5, NOW(), NOW())`,
      [a.title, a.category, a.body, a.is_pinned ? 1 : 0, adminUserId]
    );
  }
  return DEFAULT_ARTICLES.length;
}

module.exports = { seedTenantKnowledgeBase, DEFAULT_ARTICLES };
