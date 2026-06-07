/**
 * routes/saas/demoTenant.js
 *
 * Super-admin endpoint that builds (or refreshes) a "showcase" demo tenant.
 *
 * What it does:
 *   1. If a tenant with slug='showcase' already exists → reuses its DB.
 *      Otherwise creates a fresh tenant via the signup → provisioning
 *      pipeline so schema, KB seed, admin user, invoice are all set.
 *   2. Connects to the tenant DB and seeds a rich "first-impression"
 *      dataset: users, products, sources, statuses, project stages,
 *      tags, custom fields, 30 leads (spread across stages + dates),
 *      remarks, follow-ups, 10 quotations (mixed states), 10 call
 *      recordings with pre-baked AI summaries / audits / ratings /
 *      insights — so the recording-audit + AI-rating + insight panels
 *      look populated without making any real Gemini API call.
 *   3. Sets nice brand colours + company name so the demo looks polished.
 *   4. Returns { url, email, password, slug } so the operator can hand
 *      the link out (or click through directly).
 *
 * Idempotent: calling it twice just refreshes the data inside the same
 * tenant DB. The admin user's password is RESET to the demo password
 * each run so you can always log in with the documented creds.
 *
 * Exposed as: api_saas_demo_seed (via routes/saas/saasApi.js dispatcher
 * — see registration in server.js).
 */
'use strict';

const bcrypt = require('bcryptjs');
const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const provisioning = require('./provisioning');
const { requireSuperAdmin } = require('./superAdminAuth');

const DEMO_SLUG = 'showcase';
const DEMO_EMAIL = 'demo@smartcrm.in';
const DEMO_PASSWORD = 'Showcase@123';

// ── Per-industry showcase tenants ────────────────────────────────
// Three separate tenants so each vertical has its own demo workspace
// with the right pack installed + appropriate seed data, not one
// shared tenant with toggles.
const INDUSTRY_SHOWCASES = {
  generic: {
    slug: 'showcase',
    email: 'demo@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'Showcase CRM (Generic)',
    pack: null
  },
  education: {
    slug: 'showcase-edu',
    email: 'demo-edu@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'Brilliant Coaching Institute (Demo)',
    pack: 'education'
  },
  realestate: {
    slug: 'showcase-re',
    email: 'demo-re@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'Skyline Developers (Demo)',
    pack: 'realestate'
  },
  finance: {
    slug: 'showcase-finance',
    email: 'demo-finance@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'TrustBridge Financial Services (Demo)',
    pack: 'finance'
  },
  solar: {
    slug: 'showcase-solar',
    email: 'demo-solar@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'SunBright Solar Solutions (Demo)',
    pack: 'solar'
  },
  manufacturer: {
    slug: 'showcase-mfg',
    email: 'demo-mfg@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'Precision Industries Pvt Ltd (Demo)',
    pack: 'manufacturer'
  },
  holiday: {
    slug: 'showcase-holiday',
    email: 'demo-holiday@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'WanderWise Travel & Tours (Demo)',
    pack: 'holiday'
  },
  ecommerce: {
    slug: 'showcase-ecommerce',
    email: 'demo-ecommerce@smartcrm.in',
    password: 'Showcase@123',
    org_name: 'KartFlow D2C Store (Demo)',
    pack: 'ecommerce'
  }
};
const DEMO_ORG_NAME = 'SmartCRM Showcase Co.';

// ---- Demo data dictionaries ------------------------------------------------

const DEMO_USERS = [
  { name: 'Riya Sharma',   email: 'riya.sharma@smartcrm.in',   role: 'manager',     designation: 'Sales Manager',     department: 'Sales' },
  { name: 'Arjun Mehta',   email: 'arjun.mehta@smartcrm.in',   role: 'team_leader', designation: 'Team Lead',         department: 'Sales' },
  { name: 'Priya Iyer',    email: 'priya.iyer@smartcrm.in',    role: 'sales',       designation: 'Account Executive', department: 'Sales' },
  { name: 'Karan Singh',   email: 'karan.singh@smartcrm.in',   role: 'sales',       designation: 'Sales Executive',   department: 'Sales' },
  { name: 'Anita Desai',   email: 'anita.desai@smartcrm.in',   role: 'sales',       designation: 'Sales Executive',   department: 'Sales' }
];

const DEMO_PRODUCTS = [
  { name: 'Starter Plan',         description: 'Up to 5 users, basic CRM features', price: 1499 },
  { name: 'Growth Plan',          description: '10 users, automations + WhatsApp',  price: 4999 },
  { name: 'Pro Plan',             description: '25 users, AI features + reports',   price: 9999 },
  { name: 'Enterprise Plan',      description: 'Unlimited users, dedicated support', price: 24999 },
  { name: 'AI Add-on',            description: 'Gemini-powered call summaries',     price: 2499 },
  { name: 'WhatsApp Add-on',      description: 'Official Cloud API + bot replies',  price: 1999 }
];

const DEMO_SOURCES = ['Website', 'Facebook Ads', 'Google Ads', 'Referral', 'WhatsApp', 'Cold Call'];

const DEMO_STATUSES = [
  { name: 'New',          color: '#3b82f6', sort_order: 10, is_final: 0 },
  { name: 'Contacted',    color: '#0ea5e9', sort_order: 20, is_final: 0 },
  { name: 'Qualified',    color: '#8b5cf6', sort_order: 30, is_final: 0 },
  { name: 'Proposal Sent',color: '#f59e0b', sort_order: 40, is_final: 0 },
  { name: 'Negotiation',  color: '#ef4444', sort_order: 50, is_final: 0 },
  { name: 'Won',          color: '#10b981', sort_order: 60, is_final: 1 },
  { name: 'Lost',         color: '#6b7280', sort_order: 70, is_final: 1 }
];

const DEMO_PROJECT_STAGES = [
  { name: 'Onboarding',         description: 'Initial setup + kickoff',  sort_order: 10, expected_days: 3 },
  { name: 'Requirements',       description: 'Gather and document needs', sort_order: 20, expected_days: 5 },
  { name: 'Design',             description: 'Mockups + wireframes',      sort_order: 30, expected_days: 7 },
  { name: 'Implementation',     description: 'Build + customise',         sort_order: 40, expected_days: 14 },
  { name: 'UAT + Go-Live',      description: 'Testing + launch',          sort_order: 50, expected_days: 5 }
];

const DEMO_TAGS = [
  { name: 'Hot',          color: '#ef4444' },
  { name: 'Warm',         color: '#f59e0b' },
  { name: 'Cold',         color: '#6b7280' },
  { name: 'Repeat',       color: '#10b981' },
  { name: 'VIP',          color: '#8b5cf6' },
  { name: 'Decision Maker', color: '#0ea5e9' },
  { name: 'Budget Holder', color: '#6366f1' },
  { name: 'Needs Demo',   color: '#ec4899' }
];

const DEMO_CUSTOM_FIELDS = [
  { key: 'company_size',  label: 'Company Size',  field_type: 'select', options: '1-10|11-50|51-200|201-500|500+', show_in_list: 1 },
  { key: 'budget_range',  label: 'Budget Range',  field_type: 'select', options: '<25k|25k-1L|1L-5L|5L-25L|25L+',  show_in_list: 1 },
  { key: 'decision_date', label: 'Decision Date', field_type: 'date',   options: '',                                show_in_list: 0 },
  { key: 'industry',      label: 'Industry',      field_type: 'select', options: 'SaaS|Manufacturing|Retail|Healthcare|Education|Real Estate|Other', show_in_list: 1 }
];

const DEMO_LEAD_NAMES = [
  'Rahul Kapoor', 'Sneha Patel', 'Vikram Joshi', 'Meera Reddy', 'Aditya Bose',
  'Pooja Nair', 'Sandeep Gupta', 'Divya Krishnan', 'Manish Verma', 'Kavya Pillai',
  'Rohit Choudhary', 'Ananya Banerjee', 'Nikhil Agarwal', 'Tara Menon', 'Suresh Yadav',
  'Ishita Roy', 'Arvind Sinha', 'Neha Malhotra', 'Tushar Khanna', 'Lakshmi Rao',
  'Akash Bhatia', 'Shreya Mathur', 'Devendra Pandey', 'Aishwarya Goel', 'Pranav Saxena',
  'Riddhi Shah', 'Mohit Sehgal', 'Sakshi Ahuja', 'Yash Tandon', 'Ritu Kohli'
];

const DEMO_COMPANIES = [
  'Bright Solutions Pvt Ltd', 'TechMatrix Systems', 'Lotus Logistics', 'Apex Manufacturing',
  'Indigo Healthcare', 'Skyline Realty', 'Saffron Retail Group', 'Quantum Learning',
  'Coral Hospitality', 'Pearl Pharma', 'Granite Constructions', 'Velocity Auto',
  'Harvest FoodCo', 'Marigold Media', 'Zenith Capital', 'Vertex Engineering',
  'Aurora Travels', 'Northstar IT', 'Crimson Outlets', 'Echo Communications'
];

const DEMO_CITIES = [
  ['Mumbai', 'Maharashtra'], ['Pune', 'Maharashtra'], ['Bengaluru', 'Karnataka'],
  ['Hyderabad', 'Telangana'], ['Chennai', 'Tamil Nadu'], ['Delhi', 'Delhi'],
  ['Gurugram', 'Haryana'], ['Noida', 'Uttar Pradesh'], ['Ahmedabad', 'Gujarat'],
  ['Kolkata', 'West Bengal']
];

const DEMO_REMARKS = [
  'Spoke briefly — wants more info on pricing',
  'Sent the proposal; awaiting response.',
  'Decision maker is on leave; follow up next week.',
  'Asked for a custom demo focused on automations.',
  'Budget approved internally — ready to move forward.',
  'Comparing 3 vendors; we are top pick on features.',
  'Concerned about data migration timeline.',
  'Wants a 14-day pilot before committing.',
  'Referred by an existing customer.',
  'Needs the WhatsApp module specifically.'
];

const DEMO_TRANSCRIPTS = [
  {
    transcript: 'Agent: Hi, this is Priya from SmartCRM. Is this a good time?\nLead: Yes, but only 5 minutes.\nAgent: I\'ll be quick. We help sales teams automate follow-ups. What\'s your team size?\nLead: We have 12 sales people. Currently using Excel.\nAgent: Got it. Most teams your size save 8-10 hours a week with us.\nLead: Send me a deck please.',
    summary: 'Initial discovery call. Lead has 12 salespeople using Excel. Showed interest after hearing time-saving stat. Asked for a deck.',
    action_items: '1. Email pitch deck within 24 hours\n2. Schedule 30-min demo for next week\n3. Add to nurture sequence',
    sentiment: 'positive',
    key_insight: 'Pain point: Excel-driven sales process. Strong fit for automation features.',
    next_followup_days: 2,
    rating: 4,
    ai_suggested_rating: 4,
    rating_notes: 'Good discovery, clear next steps captured.'
  },
  {
    transcript: 'Lead: I\'ve been waiting for someone to call me back!\nAgent: I\'m so sorry — let me help right away.\nLead: I asked about pricing 3 days ago.\nAgent: Our Growth plan is ₹4,999/month for 10 users.\nLead: That\'s within budget. What about implementation time?\nAgent: 2-3 days for a team your size.\nLead: OK, send me the proposal today.',
    summary: 'Lead frustrated by 3-day delay but reset by quick price discussion. Growth plan within budget. Wants proposal today.',
    action_items: '1. Send proposal TODAY (high priority)\n2. Apologise email for delay\n3. Move status to Proposal Sent',
    sentiment: 'mixed',
    key_insight: 'Recovery moment: agent\'s quick acknowledgment + concrete pricing turned a complaint into a closing opportunity.',
    next_followup_days: 1,
    rating: 5,
    ai_suggested_rating: 5,
    rating_notes: 'Excellent recovery from a complaint into a near-close.'
  },
  {
    transcript: 'Agent: Hi! I\'m calling from SmartCRM, are you free?\nLead: Not really. What\'s this about?\nAgent: Just 30 seconds. We help with lead management.\nLead: I\'m not interested.\nAgent: No problem. Can I send you something to look at later?\nLead: Sure, fine.',
    summary: 'Brush-off. Lead not engaged, agreed to email but no real interest signaled.',
    action_items: '1. Send a soft-touch one-pager\n2. Mark as cold, requeue in 60 days',
    sentiment: 'negative',
    key_insight: 'Low buying intent — should be requeued, not pursued aggressively.',
    next_followup_days: 60,
    rating: 2,
    ai_suggested_rating: 2,
    rating_notes: 'Agent should have qualified harder before pitching.'
  },
  {
    transcript: 'Lead: I want to see the WhatsApp bot working live.\nAgent: Sure, I can screen-share now if you have 10 minutes.\nLead: Perfect, go ahead.\nAgent: [demo] — see how it auto-replies based on the knowledge base?\nLead: This is exactly what we need. What\'s the cost?\nAgent: ₹1,999/month for the WhatsApp add-on on top of the Growth plan.\nLead: Done. Send the invoice.',
    summary: 'Live WhatsApp bot demo on call closed the deal. Lead committed to Growth + WA add-on. Asked for invoice.',
    action_items: '1. Generate quotation: Growth + WA add-on\n2. Mark status: Won\n3. Schedule onboarding call',
    sentiment: 'positive',
    key_insight: 'Live demo (vs. pre-recorded) is a high-conversion play for technical buyers.',
    next_followup_days: 1,
    rating: 5,
    ai_suggested_rating: 5,
    rating_notes: 'Textbook close — demo on demand, immediate buy decision.'
  },
  {
    transcript: 'Agent: Hi, following up on the proposal we sent on Monday.\nLead: Yes, we\'re reviewing internally. Some concern about data migration.\nAgent: We do free migration for plans Growth and above.\nLead: Even from Excel?\nAgent: Yes, our team handles it in 2 working days.\nLead: That removes my biggest concern. We\'ll get back by Friday.',
    summary: 'Follow-up on sent proposal. Migration concern resolved by mention of free migration service. Decision by Friday.',
    action_items: '1. Send a one-pager on migration process\n2. Add Friday calendar reminder\n3. Loop in CSM ahead of close',
    sentiment: 'positive',
    key_insight: 'Free migration is a deal-saver for Excel-based prospects. Surface it earlier in the cycle.',
    next_followup_days: 4,
    rating: 4,
    ai_suggested_rating: 4,
    rating_notes: 'Strong objection-handling on migration concern.'
  },
  {
    transcript: 'Lead: Your competitor offers it cheaper.\nAgent: Who are you comparing with?\nLead: Vendor X — ₹3,500 vs your ₹4,999.\nAgent: Vendor X doesn\'t include WhatsApp official API or AI summaries.\nLead: True, those are nice to have.\nAgent: For 12 salespeople, those features alone save you 6 hours a week.\nLead: I\'ll think about it.',
    summary: 'Price objection vs Vendor X. Agent reframed differentiation around WA + AI features. Lead non-committal.',
    action_items: '1. Send feature comparison doc\n2. Offer 14-day pilot\n3. Loop manager in for discount approval',
    sentiment: 'mixed',
    key_insight: 'Pure-price comparisons need apples-to-apples breakdowns. Send compare doc proactively.',
    next_followup_days: 3,
    rating: 3,
    ai_suggested_rating: 3,
    rating_notes: 'Reasonable defense, but did not close on a next step.'
  },
  {
    transcript: 'Agent: Just checking in — any update on the proposal?\nLead: Sorry, I\'ve been swamped.\nAgent: No worries. Anything I can clarify in the meantime?\nLead: Honestly, internal priorities shifted. We\'re holding off till Q3.\nAgent: Understood. Mind if I check in mid-July?\nLead: Sure, let\'s do that.',
    summary: 'Deal pushed to Q3 due to internal priority shift. Agent secured a future check-in.',
    action_items: '1. Move to nurture: re-engage mid-July\n2. Update status to On Hold (custom field)\n3. Add to monthly newsletter',
    sentiment: 'neutral',
    key_insight: 'Timing-based loss — preserve the relationship, do not push.',
    next_followup_days: 60,
    rating: 3,
    ai_suggested_rating: 3,
    rating_notes: 'Properly managed pause; could have probed harder for actual blocker.'
  },
  {
    transcript: 'Lead: I want to add 5 more users to my plan.\nAgent: Of course! That moves you from 10 to 15 users.\nLead: Same per-user pricing?\nAgent: Yes, ₹500 per additional user per month — total ₹2,500 extra.\nLead: Perfect. Do it from this billing cycle.',
    summary: 'Existing customer expansion: +5 users on Growth plan. Approved immediately.',
    action_items: '1. Process upgrade in billing\n2. Send confirmation\n3. Schedule onboarding for new users',
    sentiment: 'positive',
    key_insight: 'Account expansion is fastest revenue path — proactively check seat utilisation monthly.',
    next_followup_days: 7,
    rating: 5,
    ai_suggested_rating: 5,
    rating_notes: 'Smooth upsell, customer-driven.'
  },
  {
    transcript: 'Agent: Hi, do you have a moment?\nLead: Make it quick.\nAgent: We help sales teams automate follow-ups.\nLead: I\'m the founder. We don\'t have a sales team.\nAgent: Got it — would lead capture from your website still help?\nLead: Maybe. Send me a link.',
    summary: 'Cold call to founder of small co. Not a primary fit but light interest in lead-capture features.',
    action_items: '1. Send link to free trial\n2. Mark as low-priority lead\n3. Tag as Solo / Founder',
    sentiment: 'neutral',
    key_insight: 'Pivoted pitch to a relevant feature when initial pitch missed — good agility.',
    next_followup_days: 14,
    rating: 3,
    ai_suggested_rating: 3,
    rating_notes: 'Decent recovery but mismatched ICP — acceptable to deprioritise.'
  },
  {
    transcript: 'Lead: I tried logging in but the password didn\'t work.\nAgent: Sorry about that — let me reset it for you. What\'s your email?\nLead: rahul@brightsolutions.com\nAgent: Done. Check your inbox in 30 seconds.\nLead: Got it. Thanks!\nAgent: While I have you — anything you\'re struggling with in the platform?\nLead: Just need to set up the WhatsApp templates.\nAgent: I\'ll send you a quick how-to video.',
    summary: 'Support call: password reset. Used as opportunity to surface WhatsApp templates question.',
    action_items: '1. Send WA templates how-to video\n2. Schedule 15-min onboarding extension call',
    sentiment: 'positive',
    key_insight: 'Support tickets are CSM gold — every call should end with "anything else I can help with?"',
    next_followup_days: 2,
    rating: 5,
    ai_suggested_rating: 5,
    rating_notes: 'Great proactive question after the support task.'
  }
];

const DEMO_QUOTES = [
  { customer_idx: 0,  status: 'sent',     items: [['Growth Plan', 1, 4999], ['AI Add-on', 1, 2499]] },
  { customer_idx: 1,  status: 'accepted', items: [['Pro Plan', 1, 9999]] },
  { customer_idx: 2,  status: 'sent',     items: [['Starter Plan', 1, 1499], ['WhatsApp Add-on', 1, 1999]] },
  { customer_idx: 3,  status: 'draft',    items: [['Enterprise Plan', 1, 24999]] },
  { customer_idx: 4,  status: 'accepted', items: [['Growth Plan', 1, 4999]] },
  { customer_idx: 5,  status: 'rejected', items: [['Pro Plan', 1, 9999], ['AI Add-on', 1, 2499]] },
  { customer_idx: 6,  status: 'sent',     items: [['Growth Plan', 1, 4999], ['WhatsApp Add-on', 1, 1999], ['AI Add-on', 1, 2499]] },
  { customer_idx: 7,  status: 'sent',     items: [['Starter Plan', 1, 1499]] },
  { customer_idx: 8,  status: 'draft',    items: [['Pro Plan', 1, 9999]] },
  { customer_idx: 9,  status: 'rejected', items: [['Enterprise Plan', 1, 24999]] }
];

// ---- Helpers ---------------------------------------------------------------

function _rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function _randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function _phone() { return '+91 9' + String(_randInt(100000000, 999999999)); }
function _daysAgo(d) { const x = new Date(); x.setDate(x.getDate() - d); return x.toISOString(); }
function _daysFromNow(d) { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString(); }

async function _findOrCreateDemoTenant(operatorId, operatorEmail, conf) {
  // Default to the generic showcase config when not provided.
  conf = conf || INDUSTRY_SHOWCASES.generic;
  const targetSlug = conf.slug || DEMO_SLUG;
  const targetEmail = conf.email || DEMO_EMAIL;
  const targetOrg = conf.org_name || DEMO_ORG_NAME;
  // Look for existing showcase tenant first.
  const existing = await control.findOneBy('tenants', 'slug', targetSlug);
  if (existing) return existing;

  // Pick a default package — prefer one flagged is_default=1, else first.
  // If none exists at all, auto-create a free "Demo" package so the
  // operator doesn't have to bootstrap one manually before clicking
  // the showcase button.
  let pkgs = await control.query(
    `SELECT id FROM packages WHERE is_enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1`
  );
  if (!pkgs.rows.length) {
    console.log('[demo-seed] no package found — auto-creating free Demo package');
    await control.insert('packages', {
      name: 'Demo (auto-created)',
      description: 'Auto-created by Showcase demo seeder. Hidden from public pricing.',
      base_price_inr: 0, trial_days: 0,
      recurring_period: 'month', recurring_period_count: 1,
      is_lifetime: 1, tax_percent: 0,
      allowed_payment_modes: 'manual',
      is_enabled: 1, is_default: 0, is_private: 1, is_most_popular: 0,
      modules: 'leads,calls,catalog,reports,whatsbot,aibot,quotations,campaigns,knowledge,teamchat,hr,integrations,core',
      show_modules_on_card: 0, show_limits_on_card: 0
    });
    pkgs = await control.query(
      `SELECT id FROM packages WHERE is_enabled = 1 ORDER BY is_default DESC, id ASC LIMIT 1`
    );
    if (!pkgs.rows.length) throw new Error('Failed to auto-create demo package.');
  }
  const packageId = pkgs.rows[0].id;

  // Insert a synthetic signup so we can reuse the production provisioning
  // pipeline (creates DB, applies schema, seeds admin user + KB, generates
  // invoice, etc.).
  const signupId = await control.insert('signups', {
    name: 'Demo Admin',
    email: targetEmail,
    mobile: '+919999999999',
    org_name: targetOrg,
    package_id: packageId,
    desired_slug: targetSlug,
    status: 'pending',
    metadata: JSON.stringify({
      demo_seed: true, industry: conf.pack || 'generic',
      created_by: operatorEmail, created_by_id: operatorId
    })
  });
  await provisioning.provisionFromSignup(signupId);

  const t = await control.findOneBy('tenants', 'slug', targetSlug);
  if (!t) throw new Error('Provisioning succeeded but tenant row not found — please retry.');
  return t;
}

async function _resetAdminPassword(pool, emailOverride, passwordOverride) {
  const _email = emailOverride || DEMO_EMAIL;
  const _password = passwordOverride || DEMO_PASSWORD;
  const hash = bcrypt.hashSync(_password, 10);
  // Try to update by email; if no row, insert.
  const r = await pool.query(
    `UPDATE users SET name = 'Demo Admin', password_hash = $1, role = 'admin', is_active = 1, designation = 'Founder' WHERE email = $2 RETURNING id`,
    [hash, _email]
  );
  if (r.rows.length) return Number(r.rows[0].id);
  const ins = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, designation, created_at)
     VALUES ('Demo Admin', $1, $2, 'admin', 1, 'Founder', NOW())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [_email, hash]
  );
  return Number(ins.rows[0].id);
}

/**
 * Bring the showcase tenant DB up to the latest schema BEFORE seeding.
 * The showcase tenant was provisioned a long time ago and may be missing
 * columns the seed depends on (heat_*, additional_phone_ids, etc.). Each
 * ALTER TABLE ADD COLUMN IF NOT EXISTS is a no-op when the column exists,
 * so this is safe to run on every seed invocation.
 */
async function _ensureShowcaseSchema(pool) {
  const stmts = [
    // wa_phones
    `CREATE TABLE IF NOT EXISTS wa_phones (
       id SERIAL PRIMARY KEY,
       phone_number_id TEXT NOT NULL UNIQUE,
       business_account_id TEXT,
       access_token TEXT NOT NULL DEFAULT 'PLACEHOLDER',
       display_phone_number TEXT,
       verified_name TEXT,
       label TEXT,
       quality_rating TEXT,
       status TEXT,
       messaging_limit_tier TEXT,
       is_default INTEGER NOT NULL DEFAULT 0,
       is_active INTEGER NOT NULL DEFAULT 1,
       last_seen_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE wa_phones ALTER COLUMN access_token DROP NOT NULL`,
    // whatsapp_messages — add phone_number_id if missing
    `CREATE TABLE IF NOT EXISTS whatsapp_messages (
       id SERIAL PRIMARY KEY,
       lead_id INTEGER,
       direction TEXT,
       from_number TEXT,
       to_number TEXT,
       body TEXT,
       message_type TEXT,
       status TEXT,
       wa_message_id TEXT,
       media_id TEXT,
       media_filename TEXT,
       phone_number_id TEXT,
       read_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS phone_number_id TEXT`,
    `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_id TEXT`,
    `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_filename TEXT`,
    // ai_chat_log
    `CREATE TABLE IF NOT EXISTS ai_chat_log (
       id SERIAL PRIMARY KEY,
       phone TEXT,
       lead_id INTEGER,
       inbound_msg_id TEXT,
       reply_text TEXT,
       draft_text TEXT,
       model TEXT,
       mode_used TEXT,
       status TEXT,
       suppressed_reason TEXT,
       error_text TEXT,
       input_tokens INTEGER,
       output_tokens INTEGER,
       cost_inr_billed NUMERIC,
       phone_number_id TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE ai_chat_log ADD COLUMN IF NOT EXISTS phone_number_id TEXT`,
    // ai_kb_documents
    `CREATE TABLE IF NOT EXISTS ai_kb_documents (
       id SERIAL PRIMARY KEY,
       source_type TEXT,
       title TEXT,
       raw_text TEXT,
       char_count INTEGER GENERATED ALWAYS AS (LENGTH(COALESCE(raw_text,''))) STORED,
       phone_number_id TEXT,
       additional_phone_ids JSONB DEFAULT '[]'::jsonb,
       is_active INTEGER NOT NULL DEFAULT 1,
       ingest_status TEXT DEFAULT 'ready',
       ingest_error TEXT,
       created_by INTEGER,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS additional_phone_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS phone_number_id TEXT`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS is_attachable INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS trigger_keywords TEXT`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_mime_type TEXT`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_name TEXT`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER`,
    `ALTER TABLE ai_kb_documents ADD COLUMN IF NOT EXISTS sent_count INTEGER NOT NULL DEFAULT 0`,
    // leads — heat columns
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_score INTEGER`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_label TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_signal TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_action_required TEXT`,
    `ALTER TABLE leads ADD COLUMN IF NOT EXISTS heat_updated_at TIMESTAMPTZ`,
    // notifications
    `CREATE TABLE IF NOT EXISTS notifications (
       id SERIAL PRIMARY KEY,
       user_id INTEGER NOT NULL,
       type TEXT,
       title TEXT,
       body TEXT,
       link TEXT,
       is_read INTEGER NOT NULL DEFAULT 0,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    // wa_chat_assignments
    `CREATE TABLE IF NOT EXISTS wa_chat_assignments (
       id SERIAL PRIMARY KEY,
       phone TEXT NOT NULL UNIQUE,
       assigned_to INTEGER,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    // ai_reengage_log
    `CREATE TABLE IF NOT EXISTS ai_reengage_log (
       id SERIAL PRIMARY KEY,
       phone TEXT NOT NULL,
       lead_id INTEGER,
       phone_number_id TEXT,
       last_outbound_at TIMESTAMPTZ NOT NULL,
       scheduled_for TIMESTAMPTZ NOT NULL,
       attempt_no INTEGER NOT NULL DEFAULT 1,
       status TEXT NOT NULL DEFAULT 'scheduled',
       sent_message TEXT,
       sent_at TIMESTAMPTZ,
       cancelled_reason TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  ];
  // Backfill: strip leading + from phone columns so historical seeded rows
  // match what api_wb_chat_messages queries by (digits-only).
  const fixups = [
    `UPDATE whatsapp_messages SET from_number = REGEXP_REPLACE(from_number, '[^0-9]', '', 'g') WHERE from_number ~ '[+ ]'`,
    `UPDATE whatsapp_messages SET to_number   = REGEXP_REPLACE(to_number,   '[^0-9]', '', 'g') WHERE to_number   ~ '[+ ]'`,
    `UPDATE ai_chat_log       SET phone       = REGEXP_REPLACE(phone,       '[^0-9]', '', 'g') WHERE phone       ~ '[+ ]'`
  ];
  for (const sql of fixups) { try { await pool.query(sql); } catch (_) {} }
  const out = { ran: 0, failed: [] };
  for (const sql of stmts) {
    try { await pool.query(sql); out.ran++; }
    catch (e) { out.failed.push({ sql: sql.split('\n')[0].slice(0, 80), err: e.message }); }
  }
  return out;
}

async function _wipeAndSeed(pool, adminUserId) {
  // ---- 0. Self-heal schema first — showcase tenant may be missing columns.
  const _schemaResult = await _ensureShowcaseSchema(pool);
  console.log('[demo] schema migrate ran=' + _schemaResult.ran + ' failed=' + _schemaResult.failed.length);
  if (_schemaResult.failed.length) console.warn('[demo] schema failures:', JSON.stringify(_schemaResult.failed).slice(0, 500));

  // ---- 1. Wipe transactional data so re-running the seeder produces
  //         a clean dataset (preserves admin user, KB articles, config).
  const wipeOrder = [
    'quotation_items', 'quotations',
    'lead_recordings', 'call_events', 'remarks', 'followups', 'lead_actions',
    'lead_stage_log', 'tat_violations',
    'whatsapp_messages', 'wa_phones', 'wa_chat_assignments',
    'ai_chat_log', 'ai_kb_documents', 'ai_reengage_log', 'notifications',
    'leads',
    'tag_library', 'custom_fields',
    'project_stages', 'statuses', 'sources',
    'products',
    'announcements'
  ];
  for (const t of wipeOrder) {
    try { await pool.query(`DELETE FROM ${t}`); } catch (_) {}
  }
  // Deactivate all non-admin demo users so we can re-seed cleanly.
  try { await pool.query(`UPDATE users SET is_active = 0 WHERE id <> $1`, [adminUserId]); } catch (_) {}

  // ---- 2. Users
  const userIds = [adminUserId];
  for (const u of DEMO_USERS) {
    const hash = bcrypt.hashSync('Demo@123', 10);
    const r = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, designation, department, parent_id, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW())
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name, role = EXCLUDED.role,
         designation = EXCLUDED.designation, department = EXCLUDED.department,
         parent_id = EXCLUDED.parent_id, is_active = 1
       RETURNING id`,
      [u.name, u.email, hash, u.role, u.designation, u.department, adminUserId]
    );
    userIds.push(Number(r.rows[0].id));
  }
  const salesUserIds = userIds.slice(2); // skip admin + manager when assigning leads

  // ---- 3. Products
  const productIds = [];
  for (const p of DEMO_PRODUCTS) {
    const r = await pool.query(
      `INSERT INTO products (name, description, price, is_active) VALUES ($1, $2, $3, 1) RETURNING id`,
      [p.name, p.description, p.price]
    );
    productIds.push({ id: Number(r.rows[0].id), name: p.name, price: Number(p.price) });
  }

  // ---- 4. Sources
  for (const s of DEMO_SOURCES) {
    await pool.query(`INSERT INTO sources (name, is_active) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET is_active = 1`, [s]);
  }

  // ---- 5. Statuses
  const statusIds = {};
  for (const s of DEMO_STATUSES) {
    const r = await pool.query(
      `INSERT INTO statuses (name, color, sort_order, is_final) VALUES ($1, $2, $3, $4) RETURNING id`,
      [s.name, s.color, s.sort_order, s.is_final]
    );
    statusIds[s.name] = Number(r.rows[0].id);
  }

  // ---- 6. Project stages
  for (const ps of DEMO_PROJECT_STAGES) {
    await pool.query(
      `INSERT INTO project_stages (name, description, sort_order, expected_days, is_active) VALUES ($1, $2, $3, $4, 1)`,
      [ps.name, ps.description, ps.sort_order, ps.expected_days]
    );
  }

  // ---- 7. Tags
  for (const t of DEMO_TAGS) {
    await pool.query(
      `INSERT INTO tag_library (name, color, is_active) VALUES ($1, $2, 1) ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color, is_active = 1`,
      [t.name, t.color]
    );
  }

  // ---- 8. Custom fields
  for (let i = 0; i < DEMO_CUSTOM_FIELDS.length; i++) {
    const f = DEMO_CUSTOM_FIELDS[i];
    await pool.query(
      `INSERT INTO custom_fields (key, label, field_type, options, is_required, show_in_list, sort_order, is_active)
       VALUES ($1, $2, $3, $4, 0, $5, $6, 1)
       ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, field_type = EXCLUDED.field_type,
         options = EXCLUDED.options, show_in_list = EXCLUDED.show_in_list`,
      [f.key, f.label, f.field_type, f.options, f.show_in_list || 0, (i + 1) * 10]
    );
  }

  // ---- 9. Leads (30) + remarks + followups
  const statusNames = Object.keys(statusIds);
  const sourceNames = DEMO_SOURCES;
  const leadIds = [];
  for (let i = 0; i < 30; i++) {
    const name = DEMO_LEAD_NAMES[i] || (`Demo Lead ${i + 1}`);
    const company = DEMO_COMPANIES[i % DEMO_COMPANIES.length];
    const [city, state] = DEMO_CITIES[i % DEMO_CITIES.length];
    const product = productIds[i % productIds.length];
    // Bias: first 5 = New, next 5 = Contacted, next 5 = Qualified, next 5 = Proposal Sent,
    // next 4 = Negotiation, next 3 = Won, last 3 = Lost
    const statusBucket = i < 5 ? 'New' : i < 10 ? 'Contacted' : i < 15 ? 'Qualified'
      : i < 20 ? 'Proposal Sent' : i < 24 ? 'Negotiation' : i < 27 ? 'Won' : 'Lost';
    const source = _rand(sourceNames);
    const assignee = _rand(salesUserIds);
    const createdDaysAgo = _randInt(1, 90);
    const updatedDaysAgo = Math.max(0, createdDaysAgo - _randInt(0, 5));
    const value = product.price * _randInt(1, 5);
    const phone = _phone();
    const email = name.toLowerCase().replace(/\s+/g, '.') + '@' + company.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12) + '.com';

    const r = await pool.query(
      `INSERT INTO leads (name, phone, email, source, product, product_id, status_id, assigned_to, created_by,
                          created_at, updated_at, last_status_change_at, next_followup_at,
                          city, state, country, company, value, currency, notes, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $11, $12,
               $13, $14, 'India', $15, $16, 'INR', $17, $18)
       RETURNING id`,
      [
        name, phone, email, source, product.name, product.id, statusIds[statusBucket], assignee, adminUserId,
        _daysAgo(createdDaysAgo), _daysAgo(updatedDaysAgo), _daysFromNow(_randInt(-2, 7)),
        city, state, company, value, _rand(DEMO_REMARKS),
        _rand(DEMO_TAGS).name + (Math.random() > 0.5 ? (',' + _rand(DEMO_TAGS).name) : '')
      ]
    );
    const leadId = Number(r.rows[0].id);
    leadIds.push({ id: leadId, name, phone, email, company, status: statusBucket, assignee, value });

    // 1-3 remarks per lead
    const remarkCount = _randInt(1, 3);
    for (let j = 0; j < remarkCount; j++) {
      await pool.query(
        `INSERT INTO remarks (lead_id, user_id, remark, status_id, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [leadId, _rand(salesUserIds), _rand(DEMO_REMARKS), statusIds[statusBucket], _daysAgo(_randInt(0, createdDaysAgo))]
      );
    }
    // 0-2 followups per lead (some pending, some done)
    const fuCount = _randInt(0, 2);
    for (let j = 0; j < fuCount; j++) {
      const isDone = Math.random() > 0.5 ? 1 : 0;
      await pool.query(
        `INSERT INTO followups (lead_id, user_id, due_at, note, is_done, done_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          leadId, assignee,
          isDone ? _daysAgo(_randInt(0, 5)) : _daysFromNow(_randInt(0, 7)),
          'Follow up on ' + (i % 2 === 0 ? 'pricing question' : 'demo feedback'),
          isDone, isDone ? _daysAgo(_randInt(0, 3)) : null,
          _daysAgo(_randInt(0, createdDaysAgo))
        ]
      );
    }
  }

  // ---- 10. Recordings with FAKE AI summaries / audits / ratings + call_events
  // 3-second silent AAC/m4a so the audio control on the dialer page
  // shows a real timeline / play button on the demo. ~1.9 KB per row.
  const _SILENT_M4A_B64 = 'AAAAHGZ0eXBNNEEgAAACAE00QSBpc29taXNvMgAAAAhmcmVlAAACJm1kYXTeBABMYXZjNTguMTM0LjEwMAACMEAOARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAABQdtb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAALuAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAEMXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAALuAAAAAAAAAAAAAAAAQEAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAC7gAAAQAAAEAAAAAA6ltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAKxEAAIEzFXEAAAAAAAtaGRscgAAAAAAAAAAc291bgAAAAAAAAAAAAAAAFNvdW5kSGFuZGxlcgAAAANUbWluZgAAABBzbWhkAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAMYc3RibAAAAGpzdHNkAAAAAAAAAAEAAABabXA0YQAAAAAAAAABAAAAAAAAAAAAAgAQAAAAAKxEAAAAAAA2ZXNkcwAAAAADgICAJQABAASAgIAXQBUAAAAAAPoAAAAFmgWAgIAFEghW5QAGgICAAQIAAAAgc3R0cwAAAAAAAAACAAAAggAABAAAAAABAAAAzAAAABxzdHNjAAAAAAAAAAEAAAABAAAAgwAAAAEAAAIgc3RzegAAAAAAAAAAAAAAgwAAABYAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAABAAAAAQAAAAEAAAAFHN0Y28AAAAAAAAAAQAAACwAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAAgwAAAAEAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjU4Ljc2LjEwMA==';
  const audioBytes = Buffer.from(_SILENT_M4A_B64, 'base64');

  // Seed up to 30 recordings spread across the first 30 leads with a
  // realistic mix of inbound, outbound and missed calls.
  const RECORDING_COUNT = Math.min(30, leadIds.length);
  for (let i = 0; i < RECORDING_COUNT; i++) {
    const l = leadIds[i];
    const t = DEMO_TRANSCRIPTS[i % DEMO_TRANSCRIPTS.length];
    // every 5th is missed, every 3rd inbound, rest outbound
    const isMissed = (i % 5 === 4);
    const dir = isMissed ? 'missed' : (i % 3 === 0 ? 'in' : 'out');
    const dur = isMissed ? 0 : _randInt(45, 380);
    const startedDaysAgo = _randInt(0, 21);
    const startedAt = _daysAgo(startedDaysAgo);

    let suggestedStatusId = null;
    if (t.sentiment === 'positive')        suggestedStatusId = statusIds['Qualified'];
    else if (t.sentiment === 'negative')   suggestedStatusId = statusIds['Lost'];
    else if (l.status === 'Proposal Sent') suggestedStatusId = statusIds['Negotiation'];

    let recordingId = null;
    if (!isMissed) {
      const r = await pool.query(
        `INSERT INTO lead_recordings
          (lead_id, user_id, phone, direction, duration_s, device_path, mime_type, size_bytes, audio_bytes,
           started_at, created_at,
           transcript, summary, action_items, sentiment, suggested_status_id, next_followup_days, key_insight,
           ai_processed_at, ai_provider,
           rating, rating_by, rating_notes, rated_at, ai_suggested_rating)
         VALUES
          ($1, $2, $3, $4, $5, $6, 'audio/mp4', $7, $8,
           $9, $9,
           $10, $11, $12, $13, $14, $15, $16,
           $9, 'gemini-2.5-flash-lite (demo)',
           $17, $2, $18, $9, $19)
         RETURNING id`,
        [
          l.id, l.assignee, l.phone, dir, dur,
          '/storage/recordings/demo_' + i + '.m4a',
          audioBytes.length, audioBytes,
          startedAt,
          t.transcript, t.summary, t.action_items, t.sentiment,
          suggestedStatusId, t.next_followup_days, t.key_insight,
          t.rating, t.rating_notes, t.ai_suggested_rating
        ]
      );
      recordingId = Number(r.rows[0].id);
    }

    // Always log a call_event so each call shows up in the Call
    // Activity report + dialer history feed + /api/call_history.
    try {
      const evtName = isMissed ? 'call_ended' : 'recording_saved';
      await pool.query(
        `INSERT INTO call_events
          (lead_id, user_id, phone, direction, event, duration_s, recording_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [l.id, l.assignee, l.phone, dir, evtName, dur, recordingId, startedAt]
      );
    } catch (_) { /* very old tenants may lack call_events */ }
  }

  // ---- 11. Quotations (10)
  for (let i = 0; i < DEMO_QUOTES.length; i++) {
    const q = DEMO_QUOTES[i];
    const lead = leadIds[q.customer_idx];
    if (!lead) continue;

    let subtotal = 0;
    for (const it of q.items) subtotal += Number(it[1]) * Number(it[2]);
    const discountPct = i % 4 === 0 ? 5 : 0;
    const discountAmt = Math.round((subtotal * discountPct / 100) * 100) / 100;
    const taxable = subtotal - discountAmt;
    const taxPct = 18;
    const taxAmt = Math.round((taxable * taxPct / 100) * 100) / 100;
    const total = Math.round((taxable + taxAmt) * 100) / 100;
    const number = `Q-2026-${String(i + 1).padStart(4, '0')}`;
    const token = Math.random().toString(36).slice(2, 18);

    const sentAt   = (q.status === 'sent' || q.status === 'accepted' || q.status === 'rejected') ? _daysAgo(_randInt(1, 14)) : null;
    const acceptedAt = q.status === 'accepted' ? _daysAgo(_randInt(0, 5)) : null;
    const rejectedAt = q.status === 'rejected' ? _daysAgo(_randInt(0, 5)) : null;

    const qr = await pool.query(
      `INSERT INTO quotations
        (number, lead_id, customer_name, customer_email, customer_phone,
         status, issue_date, valid_until, currency,
         subtotal, discount_pct, discount_amt, tax_pct, tax_amt, total,
         notes, terms, public_token, is_public,
         sent_at, sent_via, accepted_at, rejected_at, created_by, created_at, updated_at)
       VALUES
        ($1, $2, $3, $4, $5,
         $6, CURRENT_DATE, CURRENT_DATE + INTERVAL '14 days', 'INR',
         $7, $8, $9, $10, $11, $12,
         'Thank you for your interest. Pricing valid for 14 days.',
         'Payment 50% advance, 50% on delivery. GST as applicable.',
         $13, 1,
         $14, $15, $16, $17, $18, NOW(), NOW())
       RETURNING id`,
      [
        number, lead.id, lead.name, lead.email, lead.phone,
        q.status,
        subtotal, discountPct, discountAmt, taxPct, taxAmt, total,
        token,
        sentAt, sentAt ? 'email' : null, acceptedAt, rejectedAt, adminUserId
      ]
    );
    const qid = Number(qr.rows[0].id);
    for (let j = 0; j < q.items.length; j++) {
      const [pname, qty, price] = q.items[j];
      const prod = productIds.find(p => p.name === pname);
      const amount = Math.round(Number(qty) * Number(price) * 100) / 100;
      await pool.query(
        `INSERT INTO quotation_items (quotation_id, position, product_id, description, quantity, unit_price, amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [qid, j, prod ? prod.id : null, pname, qty, price, amount]
      );
    }
  }

  // ---- 11.5. WhatsApp demo data: 2 connected numbers + multiple conversations
  // Lets prospects see the WhatsApp tab populated, the AI Bot Activity / Hot leads /
  // Heat trace pages with content, and the lead detail panel showing chat history.
  // wa_phones.access_token is NOT NULL so we MUST provide it (a dummy value is fine
  // since this is a demo tenant — no real Meta calls are made from here).
  let _phoneA = 'demo_phone_111222';
  let _phoneB = 'demo_phone_333444';
  try {
    await pool.query(
      `INSERT INTO wa_phones (phone_number_id, business_account_id, access_token, display_phone_number, verified_name, label, quality_rating, status, messaging_limit_tier, is_default, is_active, created_at)
       VALUES ($1, 'demo_waba_1', 'DEMO_TOKEN_NOT_REAL', '+91 99988 77766', 'SmartCRM Demo', 'Sales Line', 'GREEN', 'CONNECTED', 'TIER_10K', 1, 1, NOW())
       ON CONFLICT (phone_number_id) DO UPDATE SET label = EXCLUDED.label, is_active = 1`,
      [_phoneA]
    );
    await pool.query(
      `INSERT INTO wa_phones (phone_number_id, business_account_id, access_token, display_phone_number, verified_name, label, quality_rating, status, messaging_limit_tier, is_default, is_active, created_at)
       VALUES ($1, 'demo_waba_1', 'DEMO_TOKEN_NOT_REAL', '+91 88877 66655', 'SmartCRM Demo', 'Support Line', 'GREEN', 'CONNECTED', 'TIER_1K', 0, 1, NOW())
       ON CONFLICT (phone_number_id) DO UPDATE SET label = EXCLUDED.label, is_active = 1`,
      [_phoneB]
    );
  } catch (e) { console.warn('[demo] wa_phones seed failed:', e.message); }

  // KB docs (text only — no real binary attachment needed)
  try {
    await pool.query(
      `INSERT INTO ai_kb_documents (source_type, title, raw_text, is_active, ingest_status, phone_number_id, created_by, created_at)
       VALUES ('text', 'Pricing & plans', 'Starter ₹4,999/mo for 5 users. Pro ₹9,999/mo for 25 users. Enterprise custom. All plans include WhatsApp Cloud API, AI bot, call recording sync, and 24x7 support.', 1, 'ready', NULL, $1, NOW())`,
      [adminUserId]
    );
    await pool.query(
      `INSERT INTO ai_kb_documents (source_type, title, raw_text, is_active, ingest_status, phone_number_id, created_by, created_at)
       VALUES ('text', 'Product overview', 'SmartCRM is an AI-powered CRM with WhatsApp engagement, real-time lead heat scoring, multi-bot architecture, and integrated call recording. Built for India-first sales teams.', 1, 'ready', NULL, $1, NOW())`,
      [adminUserId]
    );
    await pool.query(
      `INSERT INTO ai_kb_documents (source_type, title, raw_text, is_active, ingest_status, phone_number_id, created_by, created_at)
       VALUES ('text', 'Support FAQ', 'Q: How do I sync call recordings on Samsung? A: Open the app -> Settings -> Recording sync -> tap Sync now. Make sure storage permission is granted in Android settings.', 1, 'ready', NULL, $1, NOW())`,
      [adminUserId]
    );
  } catch (e) { console.warn('[demo] kb docs seed failed:', e.message); }

  // 8 sample conversations across the demo leads. Half on Sales line (_phoneA),
  // half on Support line (_phoneB). Mix of intents so the prospect sees the full
  // hot/warm/cold spread and the AI Bot Activity tab gets ~30+ replies logged.
  const _convoLeads = leadIds.slice(0, 12);
  const _SCRIPTS = [
    // Sales — hot, asking price + brochure + demo
    { phone: _phoneA, kind: 'hot', signal: 'asked about price + ready to buy', score: 85, msgs: [
      { dir: 'in',  body: 'Hi, I saw your ad. What is the pricing for 10 users?' },
      { dir: 'out', body: 'Hi! 👋 For 10 users the Pro plan at ₹9,999/mo fits well — includes AI bot, WhatsApp Cloud API, and call recording. Want a quick demo?', bot: true },
      { dir: 'in',  body: 'Yes please share brochure also' },
      { dir: 'out', body: 'Sharing the brochure + pricing sheet now. Would 4pm tomorrow work for the demo call?', bot: true },
      { dir: 'in',  body: 'Perfect. Schedule it.' },
      { dir: 'out', body: 'Booked for 4pm tomorrow. You will get the meeting link 30 mins before. Looking forward!', bot: true }
    ]},
    // Sales — very hot, callback + Hindi
    { phone: _phoneA, kind: 'very_hot', signal: 'wants a callback', score: 75, msgs: [
      { dir: 'in',  body: 'Interested in your CRM. Can you call me?' },
      { dir: 'out', body: 'Absolutely — what time today works for a 15-minute call?', bot: true },
      { dir: 'in',  body: 'After 5pm. Also kitne ka hai monthly?' },
      { dir: 'out', body: 'Plans start at ₹4,999/mo. Booking your callback for 5:30pm. Looking forward!', bot: true },
      { dir: 'in',  body: 'Done thanks 🙏' }
    ]},
    // Sales — comparison shopper
    { phone: _phoneA, kind: 'hot', signal: 'asked for comparison', score: 35, msgs: [
      { dir: 'in',  body: 'How is this different from TeleCRM?' },
      { dir: 'out', body: 'Great question! Three big differences: built-in AI WhatsApp bot with attachable KB, real-time hot-lead heat scoring on every inbound, and proper multi-tenant SaaS billing. Want a side-by-side comparison deck?', bot: true },
      { dir: 'in',  body: 'Yes please' },
      { dir: 'out', body: 'Sending the comparison deck. Any specific pain point you are trying to solve?', bot: true },
      { dir: 'in',  body: 'WhatsApp follow-ups are manual right now, want to automate' },
      { dir: 'out', body: 'Perfect fit. Our re-engagement engine pings silent customers automatically with the message you configure. Happy to show this on a demo call.', bot: true }
    ]},
    // Sales — demo request
    { phone: _phoneA, kind: 'very_hot', signal: 'wants a demo', score: 60, msgs: [
      { dir: 'in',  body: 'I want demo' },
      { dir: 'out', body: 'Perfect! 🎬 Demo takes 20 mins. What time slot today/tomorrow works?', bot: true },
      { dir: 'in',  body: 'Tomorrow 11am' },
      { dir: 'out', body: 'Booked for 11am tomorrow. You will get the meeting link 30 mins before. See you then!', bot: true }
    ]},
    // Sales — qualification (BANT)
    { phone: _phoneA, kind: 'warm', signal: 'asking for product details', score: 20, msgs: [
      { dir: 'in',  body: 'Tell me more about features' },
      { dir: 'out', body: 'Sure! Top features: AI WhatsApp bot, hot-lead detection, call recording sync, multi-WhatsApp number support, and custom dashboards. What is your team size?', bot: true },
      { dir: 'in',  body: '15 sales people' },
      { dir: 'out', body: 'Great — Pro plan covers up to 25 users. Want me to send the brochure + book a 20-min demo?', bot: true }
    ]},
    // Support — Samsung recording (resolved)
    { phone: _phoneB, kind: 'cold', signal: 'support resolved', score: 0, msgs: [
      { dir: 'in',  body: 'Hi, my recordings are not syncing on Samsung phone' },
      { dir: 'out', body: 'Sorry to hear that! Quick check: open SmartCRM app → Settings → Recording sync → tap Sync now. Does it list any files?', bot: true },
      { dir: 'in',  body: 'It says permission denied' },
      { dir: 'out', body: 'Got it. Long-press the app icon → App info → Permissions → enable Storage. Then retry the sync.', bot: true },
      { dir: 'in',  body: 'Working now! Thanks 🙏' }
    ]},
    // Support — billing question
    { phone: _phoneB, kind: 'warm', signal: 'asked about billing', score: 15, msgs: [
      { dir: 'in',  body: 'Question on my last invoice' },
      { dir: 'out', body: 'Happy to help! Can you share the invoice number or month? You can also see all invoices from CRM → Settings → Billing.', bot: true },
      { dir: 'in',  body: 'INV-2026-0432' },
      { dir: 'out', body: 'Pulling that up — I see ₹9,999 for the Pro plan + ₹450 for AI bot usage. Anything specific?', bot: true }
    ]},
    // Support — feature request
    { phone: _phoneB, kind: 'warm', signal: 'feature request', score: 12, msgs: [
      { dir: 'in',  body: 'Can the AI bot reply in Marathi too?' },
      { dir: 'out', body: 'Yes! Open AI Bot → Bot Settings → Reply languages → tick मराठी (Marathi). The bot auto-detects the customer language and replies in matching script.', bot: true },
      { dir: 'in',  body: 'Great, set that up. Thanks!' },
      { dir: 'out', body: 'Done. Ping me if anything else.', bot: true }
    ]}
  ];

  let _waMsgsInserted = 0, _aiLogsInserted = 0;
  for (let i = 0; i < Math.min(_convoLeads.length, _SCRIPTS.length); i++) {
    const lead = _convoLeads[i];
    const s = _SCRIPTS[i];
    // Normalize phone — strip everything except digits + (optional leading +).
    // api_wb_chat_messages queries by digits-only (strips +) — store digits-only
    // here so when the prospect clicks into a thread the strict equality match works.
    let phone = String(lead.phone || '').replace(/\D/g, '');
    if (!phone) continue;
    const baseTs = Date.now() - (i + 1) * 1800 * 1000; // staggered 30 min apart
    let stepTs = baseTs;
    for (let j = 0; j < s.msgs.length; j++) {
      const m = s.msgs[j];
      stepTs += 90 * 1000;
      const ts = new Date(stepTs).toISOString();
      try {
        await pool.query(
          `INSERT INTO whatsapp_messages
             (lead_id, direction, from_number, to_number, body, message_type, status, phone_number_id, created_at)
           VALUES ($1, $2, $3, $4, $5, 'text', $6, $7, $8)`,
          [
            lead.id, m.dir,
            m.dir === 'in' ? phone : s.phone,
            m.dir === 'in' ? s.phone : phone,
            m.body,
            m.dir === 'in' ? 'received' : 'sent',
            s.phone,
            ts
          ]
        );
        _waMsgsInserted++;
      } catch (e) { console.warn('[demo] wa msg insert failed:', e.message); }

      if (m.bot && m.dir === 'out') {
        try {
          await pool.query(
            `INSERT INTO ai_chat_log (phone, lead_id, reply_text, model, mode_used, status,
                                      input_tokens, output_tokens, cost_inr_billed, phone_number_id, created_at)
             VALUES ($1, $2, $3, 'gemini-2.0-flash-lite', 'always', 'sent', $4, $5, $6, $7, $8)`,
            [phone, lead.id, m.body, 120 + Math.floor(Math.random() * 80), 50 + Math.floor(Math.random() * 60), 0.025, s.phone, ts]
          );
          _aiLogsInserted++;
        } catch (e) { console.warn('[demo] ai_chat_log insert failed:', e.message); }
      }
    }

    // Heat label on the lead
    const _heatAction = s.kind === 'very_hot' ? 'send_quote' : (s.kind === 'hot' ? 'send_brochure' : (s.kind === 'warm' ? 'followup' : 'remove_or_pause'));
    try {
      await pool.query(
        `UPDATE leads SET heat_score = $1, heat_label = $2, heat_signal = $3, heat_action_required = $4, heat_updated_at = NOW() WHERE id = $5`,
        [s.score, s.kind, s.signal, _heatAction, lead.id]
      );
    } catch (_) {}

    // Notification for hot/very_hot — bell drawer + popup pattern
    if (s.kind === 'hot' || s.kind === 'very_hot') {
      const emoji = s.kind === 'very_hot' ? '🔥🔥' : '🔥';
      try {
        await pool.query(
          `INSERT INTO notifications (user_id, type, title, body, link, is_read, created_at)
           VALUES ($1, 'heat_alert', $2, $3, $4, 0, $5)`,
          [adminUserId, emoji + ' ' + s.kind.toUpperCase().replace('_', ' ') + ' — ' + lead.name, s.signal, '/#/leads/' + lead.id, new Date(stepTs).toISOString()]
        );
      } catch (_) {}
    }
  }
  console.log('[demo] WhatsApp seed: ' + _waMsgsInserted + ' messages, ' + _aiLogsInserted + ' AI replies logged');


  // ---- 12. Welcome announcement
  await pool.query(
    `INSERT INTO announcements (title, body, severity, is_active, is_dismissible, created_by, created_at)
     VALUES ('👋 Welcome to the SmartCRM Showcase!',
             'This is a demo workspace pre-loaded with sample data. Click the "📚 Take the tour" button (bottom-right) for a quick walkthrough.',
             'success', 1, 1, $1, NOW())`,
    [adminUserId]
  );

  // ---- 13. Brand theme + company name + tour flag
  const cfgRows = [
    ['COMPANY_NAME',         DEMO_ORG_NAME],
    ['BRAND_PRIMARY_COLOR',  '#6366f1'],
    ['BRAND_ACCENT_COLOR',   '#10b981'],
    ['BRAND_SIDEBAR_COLOR',  '#0f172a'],
    ['BRAND_TEXT_COLOR',     '#0f172a'],
    ['THEME_MODE',           'auto'],
    ['DEMO_TENANT',          '1'],
    ['DEMO_TOUR_ENABLED',    '1']
  ];
  for (const [k, v] of cfgRows) {
    await pool.query(
      `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [k, v]
    );
  }

  // Actual insert verification counts — pulled from the live tables so we
  // know whether the seed truly populated rows or silently failed.
  let _waPhonesCount = 0, _waMsgsCount = 0, _aiLogsCount = 0, _kbCount = 0, _heatCount = 0, _notifCount = 0;
  try { _waPhonesCount = (await pool.query(`SELECT COUNT(*)::int n FROM wa_phones`)).rows[0].n; } catch (_) {}
  try { _waMsgsCount   = (await pool.query(`SELECT COUNT(*)::int n FROM whatsapp_messages`)).rows[0].n; } catch (_) {}
  try { _aiLogsCount   = (await pool.query(`SELECT COUNT(*)::int n FROM ai_chat_log`)).rows[0].n; } catch (_) {}
  try { _kbCount       = (await pool.query(`SELECT COUNT(*)::int n FROM ai_kb_documents`)).rows[0].n; } catch (_) {}
  try { _heatCount     = (await pool.query(`SELECT COUNT(*)::int n FROM leads WHERE heat_label IS NOT NULL`)).rows[0].n; } catch (_) {}
  try { _notifCount    = (await pool.query(`SELECT COUNT(*)::int n FROM notifications WHERE type = 'heat_alert'`)).rows[0].n; } catch (_) {}
  return {
    counts: {
      users: userIds.length,
      products: productIds.length,
      sources: DEMO_SOURCES.length,
      statuses: DEMO_STATUSES.length,
      project_stages: DEMO_PROJECT_STAGES.length,
      tags: DEMO_TAGS.length,
      custom_fields: DEMO_CUSTOM_FIELDS.length,
      leads: leadIds.length,
      recordings: Math.min(30, leadIds.length),
      quotations: DEMO_QUOTES.length,
      whatsapp_phones_in_db:    _waPhonesCount,
      whatsapp_messages_in_db:  _waMsgsCount,
      ai_chat_log_rows_in_db:   _aiLogsCount,
      kb_docs_in_db:            _kbCount,
      leads_with_heat_in_db:    _heatCount,
      heat_alert_notifs_in_db:  _notifCount,
      schema_migration: _schemaResult
    }
  };
}

/**
 * api_saas_demo_seed(token, opts?)
 *
 * Super-admin only. Creates (or refreshes) the showcase demo tenant.
 * Returns { url, slug, email, password, counts } so the operator can
 * hand out the link.
 */
async function api_saas_demo_seed(token /*, opts */) {
  const me = await requireSuperAdmin(token);

  // Use the explicit Generic showcase conf so this stays in sync with
  // the per-industry seeders (and so the seeder works even after the
  // INDUSTRY_SHOWCASES refactor).
  const conf = INDUSTRY_SHOWCASES.generic;
  const tenant = await _findOrCreateDemoTenant(me.id, me.email, conf);
  const pool = tenantPool.poolFor(tenant);
  if (!pool) throw new Error('Could not connect to demo tenant DB');

  const adminUserId = await _resetAdminPassword(pool, conf.email, conf.password);

  // Make sure this tenant is PURE Generic — uninstall any industry packs
  // that may have been installed by previous test runs of the seedEducation
  // / seedRealEstate buttons on the same showcase tenant. Soft-uninstall
  // (data stays in re_* / edu_* tables but the SPA stops surfacing the
  // pack-specific tabs).
  await db.tenantStorage.run({ pool, slug: tenant.slug }, async () => {
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS installed_packs (
        pack_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        installed_by INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT ''
      )`);
      const r = await db.query(`UPDATE installed_packs SET is_active = 0 WHERE is_active = 1 RETURNING pack_id`);
      const off = (r.rows || []).map(x => x.pack_id);
      if (off.length) console.log('[demo-seed] Generic showcase — disabled industry packs:', off.join(', '));
    } catch (e) {
      console.warn('[demo-seed] Could not disable industry packs on Generic showcase:', e.message);
    }
  });

  const summary = await _wipeAndSeed(pool, adminUserId);

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const url = `${baseUrl}/t/${tenant.slug}/`;

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: tenant.id, event: 'tenant.demo_seeded',
    detail: JSON.stringify(summary.counts)
  });

  return {
    ok: true,
    slug: tenant.slug,
    url,
    email: conf.email,
    password: conf.password,
    counts: summary.counts
  };
}

/**
 * Diagnostic snapshot — returns per-table row counts on the showcase tenant.
 * Lets the super-admin verify whether the seed actually populated the DB
 * without needing direct DB access.
 */
async function api_saas_demo_snapshot(token) {
  const me = await requireSuperAdmin(token);
  const tenant = await control.findOneBy('tenants', 'slug', DEMO_SLUG);
  if (!tenant) return { ok: false, error: 'showcase tenant not found' };
  const pool = tenantPool.poolFor(tenant);
  if (!pool) return { ok: false, error: 'pool unavailable' };

  // Auto-run the phone-format backfill on every snapshot call. Cheap UPDATE
  // that only touches rows where the column actually has + or whitespace.
  // Means the user can run "Show snapshot" without needing a full re-seed
  // to fix historical seeded rows that had the + prefix.
  const fixups = [];
  for (const sql of [
    `UPDATE whatsapp_messages SET from_number = REGEXP_REPLACE(from_number, '[^0-9]', '', 'g') WHERE from_number ~ '[+ ]'`,
    `UPDATE whatsapp_messages SET to_number   = REGEXP_REPLACE(to_number,   '[^0-9]', '', 'g') WHERE to_number   ~ '[+ ]'`,
    `UPDATE ai_chat_log       SET phone       = REGEXP_REPLACE(phone,       '[^0-9]', '', 'g') WHERE phone       ~ '[+ ]'`
  ]) {
    try { const r = await pool.query(sql); fixups.push({ sql: sql.slice(0, 80), rowCount: r.rowCount }); }
    catch (e) { fixups.push({ sql: sql.slice(0, 80), error: e.message }); }
  }

  const tables = [
    'users', 'leads', 'products', 'sources', 'statuses',
    'wa_phones', 'whatsapp_messages', 'wa_chat_assignments',
    'ai_kb_documents', 'ai_chat_log', 'ai_reengage_log', 'ai_bot_settings',
    'lead_recordings', 'remarks', 'followups', 'quotations',
    'notifications'
  ];
  const counts = {};
  const errors = {};
  for (const t of tables) {
    try { counts[t] = (await pool.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n; }
    catch (e) { errors[t] = e.message; counts[t] = null; }
  }

  try {
    const r = await pool.query(`SELECT heat_label, COUNT(*)::int n FROM leads WHERE heat_label IS NOT NULL GROUP BY heat_label`);
    counts.leads_by_heat = r.rows.reduce((acc, x) => (acc[x.heat_label] = x.n, acc), {});
  } catch (e) { errors.leads_by_heat = e.message; }

  let phones = [];
  try { phones = (await pool.query(`SELECT phone_number_id, display_phone_number, label, is_default, is_active FROM wa_phones ORDER BY created_at DESC LIMIT 5`)).rows; }
  catch (e) { errors.wa_phones_sample = e.message; }

  let recentMsgs = [];
  try {
    const r = await pool.query(`SELECT id, lead_id, direction, from_number, to_number, body, phone_number_id, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 5`);
    recentMsgs = r.rows.map(m => ({ ...m, body: String(m.body || '').slice(0, 80) }));
  } catch (e) { errors.recent_messages_sample = e.message; }

  // SIMULATION: pick the most recent inbound from_number, then run the EXACT
  // query api_wb_chat_messages would run, and report the count + sample.
  // If this is 0, the floating-chat empty pane bug is data-related.
  // If it's > 0, the data is fine and the bug is in the SPA renderer.
  let chatSim = null;
  try {
    const inb = await pool.query(`SELECT from_number FROM whatsapp_messages WHERE direction = 'in' ORDER BY created_at DESC LIMIT 1`);
    if (inb.rows.length) {
      const raw = inb.rows[0].from_number;
      const digits = String(raw || '').replace(/[^0-9]/g, '');
      const sim = await pool.query(
        `SELECT COUNT(*)::int n FROM whatsapp_messages WHERE from_number = $1 OR to_number = $1`,
        [digits]
      );
      const sample = await pool.query(
        `SELECT id, direction, from_number, to_number, body, created_at FROM whatsapp_messages WHERE from_number = $1 OR to_number = $1 ORDER BY created_at ASC LIMIT 3`,
        [digits]
      );
      chatSim = {
        sample_thread_phone_raw: raw,
        digits_only: digits,
        api_wb_chat_messages_would_return: sim.rows[0].n,
        first_3_messages: sample.rows.map(r => ({ ...r, body: String(r.body || '').slice(0, 60) }))
      };
    }
  } catch (e) { chatSim = { error: e.message }; }

  return {
    ok: true,
    slug: tenant.slug,
    tenant_status: tenant.status,
    backfill_applied: fixups,
    counts,
    sample_phones: phones,
    sample_recent_messages: recentMsgs,
    chat_query_simulation: chatSim,
    errors
  };
}



// ═════════════════════════════════════════════════════════════════
// Industry pack showcase seeders
// ═════════════════════════════════════════════════════════════════
// Each one:
//   1. Ensures the showcase tenant exists (re-uses _findOrCreateDemoTenant)
//   2. Installs the industry pack into that tenant
//   3. Seeds rich, realistic demo data on top of the generic showcase
//   4. Returns the same login URL/credentials so sales can hand-off
//
// Calls run inside tenantStorage.run() so framework's installer + our
// own queries land in the showcase tenant DB (not control DB).

const db = require('../../db/pg');

async function _runInShowcase(pool, fn) {
  return db.tenantStorage.run({ pool, slug: DEMO_SLUG }, fn);
}

async function _seedEducationDemoData(pool, adminUserId, slugOverride) {
  const showcaseSlug = slugOverride || DEMO_SLUG;
  // Install the pack (idempotent — seeds 3 fee plans, 4 custom fields,
  // 7 statuses if not already there).
  await db.tenantStorage.run({ pool, slug: showcaseSlug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/education'); // ensure registered
    await fw.installPack('education', { userId: adminUserId });
  });

  // ── Seed a realistic Course catalog (mapped to the generic 'products' table)
  // Each course has price + auto-fills Token/EMI defaults via config.edu_course_extras
  // so the 📚 Courses page + 💰 Close Sale auto-fill flow are demo-ready.
  const DEMO_COURSES = [
    { name: 'JEE Advanced 2027',        price: 95000, token: 10000, emi: 8500,  count: 10, image_url: '' },
    { name: 'NEET Premium 2027',        price: 110000,token: 15000, emi: 9500,  count: 10, image_url: '' },
    { name: 'CAT Prep — Online',        price: 45000, token:  5000, emi: 5000,  count: 8,  image_url: '' },
    { name: 'IELTS Premium',            price: 35000, token:  5000, emi: 3000,  count: 10, image_url: '' },
    { name: 'GMAT Online',              price: 60000, token: 10000, emi: 5000,  count: 10, image_url: '' },
    { name: 'Class 11 Foundation',      price: 80000, token: 10000, emi: 7000,  count: 10, image_url: '' },
    { name: 'Class 12 Crash Course',    price: 50000, token:  5000, emi: 4500,  count: 10, image_url: '' }
  ];
  const courseExtras = {};
  for (const c of DEMO_COURSES) {
    let courseId;
    try {
      const existing = await pool.query(`SELECT id FROM products WHERE LOWER(name)=LOWER($1) LIMIT 1`, [c.name]);
      if (existing.rows && existing.rows[0]) {
        courseId = existing.rows[0].id;
        await pool.query(`UPDATE products SET price=$1, image_url=$2 WHERE id=$3`, [c.price, c.image_url, courseId]);
      } else {
        const r = await pool.query(
          `INSERT INTO products (name, description, price, gst_pct, image_url, is_active)
           VALUES ($1, $2, $3, 18, $4, 1) RETURNING id`,
          [c.name, c.name + ' — coaching programme', c.price, c.image_url]
        );
        courseId = r.rows[0].id;
      }
      courseExtras[String(courseId)] = { course_name: c.name, token: c.token, emi: c.emi, count: c.count };
    } catch (e) {
      console.warn('[demo-edu] could not seed course "' + c.name + '": ' + e.message);
    }
  }
  // Persist EMI defaults so the 💰 Close Sale picker auto-fills
  try {
    const cfgRow = await pool.query(`SELECT 1 FROM config WHERE key='edu_course_extras' LIMIT 1`);
    if (cfgRow.rows && cfgRow.rows.length) {
      await pool.query(`UPDATE config SET value=$1 WHERE key='edu_course_extras'`, [JSON.stringify(courseExtras)]);
    } else {
      await pool.query(`INSERT INTO config (key, value) VALUES ('edu_course_extras', $1)`, [JSON.stringify(courseExtras)]);
    }
  } catch (_) {}

  // Per-course margin defaults so the 💎 Revenue tab shows net revenue out of the box
  try {
    const marginExtras = {};
    Object.entries(courseExtras).forEach(([id, ex]) => {
      marginExtras[id] = Object.assign({}, ex, { margin_type: 'percent', margin_value: 65 });
    });
    await pool.query(`UPDATE config SET value=$1 WHERE key='edu_course_extras'`, [JSON.stringify(marginExtras)]);
  } catch (_) {}

  // Pull plan IDs we just seeded
  const plansR = await pool.query(`SELECT id, total_amount, num_installments, interval_days FROM edu_fee_plans ORDER BY id`);
  const plans = plansR.rows || [];
  if (!plans.length) throw new Error('Education pack: no fee plans found after install');

  // Pick 10 existing leads and create enrollments on each. Use existing
  // showcase leads so the lead-modal shows the 🎓 panel for known names.
  const leadsR = await pool.query(`SELECT id, name FROM leads ORDER BY id ASC LIMIT 10`);
  const leads = leadsR.rows || [];
  const courses = DEMO_COURSES.map(c => c.name);
  const batches = ['Morning · 8 AM', 'Afternoon · 2 PM', 'Evening · 6 PM', 'Weekend Only'];

  let enrolled = 0, installmentRows = 0, payments = 0;
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const plan = plans[i % plans.length];
    const course = courses[i % courses.length];
    const batch  = batches[i % batches.length];
    // Spread start dates across the last 12 months so installments fall
    // before AND after today — gives a realistic forecast + defaulters view.
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - (i % 12));
    const startIso = startDate.toISOString().slice(0, 10);

    const eR = await pool.query(
      `INSERT INTO edu_enrollments (lead_id, fee_plan_id, plan_snapshot, course_name, batch_name, start_date, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active') RETURNING id`,
      [lead.id, plan.id, JSON.stringify(plan), course, batch, startIso, plan.total_amount]
    );
    const enrollmentId = eR.rows[0].id;
    enrolled++;

    // Generate installments
    const n = Number(plan.num_installments || 1);
    const interval = Number(plan.interval_days || 30);
    const per = Math.round((Number(plan.total_amount) / n) * 100) / 100;
    for (let s = 0; s < n; s++) {
      const due = new Date(startDate.getTime());
      due.setDate(due.getDate() + (interval * s));
      const dueIso = due.toISOString().slice(0, 10);
      const isPaid  = due < new Date() && Math.random() < 0.75;
      const isPartial = !isPaid && due < new Date() && Math.random() < 0.15;
      const paidAmt = isPaid ? per : (isPartial ? Math.round(per * 0.5 * 100) / 100 : 0);
      const status  = isPaid ? 'paid' : (isPartial ? 'partial' : 'pending');

      const iR = await pool.query(
        `INSERT INTO edu_installments (enrollment_id, seq, due_date, amount, paid_amount, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, ${isPaid ? 'NOW()' : 'NULL'}) RETURNING id`,
        [enrollmentId, s + 1, dueIso, per, paidAmt, status]
      );
      installmentRows++;
      if (paidAmt > 0) {
        await pool.query(
          `INSERT INTO edu_payments (installment_id, enrollment_id, amount, mode, receipt_no, recorded_by)
           VALUES ($1, $2, $3, 'upi', $4, $5)`,
          [iR.rows[0].id, enrollmentId, paidAmt, 'DEMO-TXN-' + iR.rows[0].id, adminUserId]
        );
        payments++;
      }
    }
  }

  return { enrolled, installments: installmentRows, payments };
}

async function _seedRealEstateDemoData(pool, adminUserId, slugOverride) {
  const showcaseSlug = slugOverride || DEMO_SLUG;
  await db.tenantStorage.run({ pool, slug: showcaseSlug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/realestate'); // ensure registered
    await fw.installPack('realestate', { userId: adminUserId });
  });

  // The installer already seeds Sample Heights with 12 units + 2 partners.
  // Add a second project for variety, more channel partners, and 6 bookings
  // with varied demand-letter progression so the demo lights up everywhere.

  // 2nd project — Skyline Towers · Tower B (5 floors × 4 units = 20 units)
  let proj2Id = null;
  const existing2 = await pool.query(`SELECT id FROM re_projects WHERE name='Skyline Towers' LIMIT 1`);
  if (existing2.rows.length) {
    proj2Id = existing2.rows[0].id;
  } else {
    const p2 = await pool.query(
      `INSERT INTO re_projects (name, location, tower_code, total_floors, units_per_floor)
       VALUES ('Skyline Towers', 'Sector 17', 'B', 5, 4) RETURNING id`
    );
    proj2Id = p2.rows[0].id;
    for (let f = 1; f <= 5; f++) {
      for (let u = 1; u <= 4; u++) {
        const unitNo = `B-${f}0${u}`;
        const type = u <= 2 ? '3BHK' : '4BHK';
        const carpet = u <= 2 ? 1280 : 1650;
        const price  = u <= 2 ? 9500000 : 13500000;
        await pool.query(
          `INSERT INTO re_units (project_id, unit_no, floor, type, carpet_sqft, price) VALUES ($1,$2,$3,$4,$5,$6)`,
          [proj2Id, unitNo, f, type, carpet, price]
        );
      }
    }
  }

  // 2 more channel partners
  for (const pData of [
    { name: 'PropTiger',  pct: 1.5 },
    { name: '99acres Pro', pct: 2.5 }
  ]) {
    const have = await pool.query(`SELECT 1 FROM re_channel_partners WHERE name=$1`, [pData.name]);
    if (!have.rows.length) {
      await pool.query(
        `INSERT INTO re_channel_partners (name, commission_pct) VALUES ($1, $2)`,
        [pData.name, pData.pct]
      );
    }
  }

  // Pull resources for booking generation
  const unitsR = await pool.query(`SELECT id, project_id, price FROM re_units WHERE status='available' ORDER BY id ASC LIMIT 8`);
  const partnersR = await pool.query(`SELECT id, commission_pct FROM re_channel_partners ORDER BY id ASC`);
  const leadsR = await pool.query(`SELECT id, name FROM leads ORDER BY id ASC LIMIT 8 OFFSET 10`); // different from edu leads
  const buyers = ['Rajesh Kumar', 'Anita Sharma', 'Vikram Patel', 'Meera Singh', 'Arjun Reddy', 'Priya Iyer', 'Sanjay Gupta', 'Neha Kapoor'];

  const MILESTONES = [
    { code: 'token',        label: 'Token',        pct: 1,  offset_days:  0 },
    { code: 'agreement',    label: 'Agreement',    pct: 9,  offset_days: 30 },
    { code: 'excavation',   label: 'Excavation',   pct: 30, offset_days: 90 },
    { code: 'slab',         label: 'Slab',         pct: 30, offset_days: 180 },
    { code: 'registration', label: 'Registration', pct: 30, offset_days: 365 }
  ];

  let bookings = 0, demands = 0, demandPayments = 0, commissionRows = 0;
  for (let i = 0; i < Math.min(unitsR.rows.length, leadsR.rows.length); i++) {
    const unit = unitsR.rows[i];
    const lead = leadsR.rows[i];
    const partner = partnersR.rows[i % partnersR.rows.length];
    const buyerName = buyers[i % buyers.length];

    // Booking date: spread across last 10 months for varied progression
    const bookingDate = new Date();
    bookingDate.setMonth(bookingDate.getMonth() - (i + 1));
    const bookingIso = bookingDate.toISOString().slice(0, 10);

    const total = Number(unit.price);
    const cpPct = partner ? Number(partner.commission_pct) : 0;

    const bR = await pool.query(
      `INSERT INTO re_bookings (lead_id, unit_id, project_id, buyer_name, total_price, booking_date, channel_partner_id, commission_pct, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'booked') RETURNING id`,
      [lead.id, unit.id, unit.project_id, buyerName, total, bookingIso, partner ? partner.id : null, cpPct || null]
    );
    const bookingId = bR.rows[0].id;
    bookings++;

    await pool.query(`UPDATE re_units SET status='booked' WHERE id=$1`, [unit.id]);

    // Generate demands, mark earlier milestones paid based on age of booking
    const startMs = bookingDate.getTime();
    for (let m = 0; m < MILESTONES.length; m++) {
      const ms = MILESTONES[m];
      const due = new Date(startMs);
      due.setDate(due.getDate() + ms.offset_days);
      const dueIso = due.toISOString().slice(0,10);
      const amt = Math.round(total * (ms.pct / 100) * 100) / 100;

      // Pay milestones whose due date is past today (with some randomness on slab/registration)
      const isPast = due < new Date();
      const shouldPay = isPast && (ms.code !== 'registration' || Math.random() < 0.3);
      const status = shouldPay ? 'paid' : 'pending';
      const paid = shouldPay ? amt : 0;

      const dR = await pool.query(
        `INSERT INTO re_demands (booking_id, seq, code, label, due_date, amount, paid_amount, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${shouldPay ? 'NOW()' : 'NULL'}) RETURNING id`,
        [bookingId, m+1, ms.code, ms.label, dueIso, amt, paid, status]
      );
      demands++;
      if (shouldPay) {
        await pool.query(
          `INSERT INTO re_payments (demand_id, booking_id, amount, method, reference, received_by)
           VALUES ($1, $2, $3, 'bank', $4, $5)`,
          [dR.rows[0].id, bookingId, amt, 'NEFT-DEMO-' + dR.rows[0].id, adminUserId]
        );
        demandPayments++;
      }
    }

    // Commission accrual
    if (partner && cpPct > 0) {
      const commissionAmt = Math.round(total * (cpPct / 100) * 100) / 100;
      // Half the bookings have commission fully paid out
      const cpPaid = Math.random() < 0.5 ? commissionAmt : 0;
      const cpStatus = cpPaid >= commissionAmt ? 'paid' : 'pending';
      await pool.query(
        `INSERT INTO re_commission_ledger (booking_id, partner_id, amount_due, amount_paid, status, paid_at)
         VALUES ($1, $2, $3, $4, $5, ${cpPaid > 0 ? 'NOW()' : 'NULL'})`,
        [bookingId, partner.id, commissionAmt, cpPaid, cpStatus]
      );
      commissionRows++;
    }
  }

  return { bookings, demands, demand_payments: demandPayments, commission_rows: commissionRows };
}

/**
 * api_saas_demo_seedEducationPack — install Education pack + rich demo data
 * on the showcase tenant. Idempotent — running it twice is safe (existing
 * enrollments/installments stay; new ones get added only on a fresh wipe).
 */
async function api_saas_demo_seedEducationPack(token) {
  const me = await requireSuperAdmin(token);
  const conf = INDUSTRY_SHOWCASES.education;
  const tenant = await _findOrCreateDemoTenant(me.id, me.email, conf);
  const pool = tenantPool.poolFor(tenant);
  if (!pool) throw new Error('Could not connect to demo tenant DB');

  const adminUserId = await _resetAdminPassword(pool, conf.email, conf.password);

  // Always seed the generic base (leads, calls, recordings, WA threads) so the
  // Education showcase has rich enrollable leads even on a fresh tenant.
  const baseSummary = await _wipeAndSeed(pool, adminUserId);
  const eduSummary  = await _seedEducationDemoData(pool, adminUserId, conf.slug);
  const summary = Object.assign({}, baseSummary && baseSummary.counts || {}, eduSummary || {});

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const url = `${baseUrl}/t/${tenant.slug}/#/edufees`;

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: tenant.id, event: 'tenant.demo_seeded_education',
    detail: JSON.stringify(summary)
  });

  return {
    ok: true,
    slug: tenant.slug,
    url,
    email: conf.email,
    password: conf.password,
    pack: 'education',
    counts: summary,
    showcase_links: {
      fee_collection: `${baseUrl}/t/${tenant.slug}/#/edufees`,
      leads:          `${baseUrl}/t/${tenant.slug}/#/leads`,
      settings_packs: `${baseUrl}/t/${tenant.slug}/#/admin`
    }
  };
}

/**
 * api_saas_demo_seedRealEstatePack — install Real Estate pack + rich demo data.
 */
async function api_saas_demo_seedRealEstatePack(token) {
  const me = await requireSuperAdmin(token);
  const conf = INDUSTRY_SHOWCASES.realestate;
  const tenant = await _findOrCreateDemoTenant(me.id, me.email, conf);
  const pool = tenantPool.poolFor(tenant);
  if (!pool) throw new Error('Could not connect to demo tenant DB');

  const adminUserId = await _resetAdminPassword(pool, conf.email, conf.password);

  // Same flow as Education — base wipe+seed first, then RE pack data on top.
  const baseSummary = await _wipeAndSeed(pool, adminUserId);
  const reSummary   = await _seedRealEstateDemoData(pool, adminUserId, conf.slug);
  const summary = Object.assign({}, baseSummary && baseSummary.counts || {}, reSummary || {});

  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const url = `${baseUrl}/t/${tenant.slug}/#/reinventory`;

  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: tenant.id, event: 'tenant.demo_seeded_realestate',
    detail: JSON.stringify(summary)
  });

  return {
    ok: true,
    slug: tenant.slug,
    url,
    email: conf.email,
    password: conf.password,
    pack: 'realestate',
    counts: summary,
    showcase_links: {
      inventory:    `${baseUrl}/t/${tenant.slug}/#/reinventory`,
      commissions:  `${baseUrl}/t/${tenant.slug}/#/recommissions`,
      leads:        `${baseUrl}/t/${tenant.slug}/#/leads`
    }
  };
}



// ─────────────────────────────────────────────────────────────────
// PACK_PHASE_2_v1 — 5 new showcase packs (Finance/Solar/Mfg/Holiday/Ecommerce)
// Each helper: installs pack, then seeds a handful of pack-specific
// transactions linked to the base demo leads.
// ─────────────────────────────────────────────────────────────────

async function _seedFinanceDemoData(pool, adminUserId, slugOverride) {
  const slug = slugOverride || 'showcase-finance';
  await db.tenantStorage.run({ pool, slug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/finance');
    await fw.installPack('finance', { userId: adminUserId });
  });
  // Pull product + lead refs
  const prods = await pool.query(`SELECT id, name, category FROM fin_products ORDER BY id LIMIT 4`);
  const leads = await pool.query(`SELECT id, name FROM leads ORDER BY id LIMIT 12`);
  let policies = 0, premiums = 0, claims = 0;
  // Create 8 policies (4 loans + 4 insurance), each with auto premium schedule
  for (let i = 0; i < Math.min(8, leads.rows.length); i++) {
    const lead = leads.rows[i];
    const prod = prods.rows[i % prods.rows.length];
    const isLoan = prod.category === 'loan';
    const policyNo = `${isLoan ? 'LN' : 'POL'}-2026-${1000 + i}`;
    const tenure = isLoan ? 60 : 12;
    const sumAssured = isLoan ? 0 : 500000 + i * 200000;
    const sanctioned = isLoan ? 500000 + i * 100000 : 0;
    const emi = isLoan ? Math.round(sanctioned * 0.022) : 0;
    const premium = isLoan ? 0 : Math.round(sumAssured * 0.01);
    const startDate = new Date(); startDate.setMonth(startDate.getMonth() - i);
    const maturityDate = new Date(startDate); maturityDate.setMonth(maturityDate.getMonth() + tenure);
    const polR = await pool.query(
      `INSERT INTO fin_policies (lead_id,product_id,policy_no,sum_assured,sanctioned_amount,disbursed_amount,tenure_months,interest_rate,emi_amount,premium_amount,premium_frequency,start_date,maturity_date,status,pan,cibil,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [lead.id, prod.id, policyNo, sumAssured, sanctioned, isLoan ? sanctioned : 0,
       tenure, isLoan ? 9.5 : 0, emi, premium,
       isLoan ? 'monthly' : 'annual',
       startDate.toISOString().slice(0,10), maturityDate.toISOString().slice(0,10),
       isLoan ? 'disbursed' : 'sanctioned',
       'ABCDE' + (1000 + i) + 'F', 720 + i * 8, adminUserId]
    );
    policies++;
    // Auto-create premium schedule (3-5 installments)
    const freq = isLoan ? 1 : 12;
    const count = isLoan ? 5 : 3;
    for (let j = 0; j < count; j++) {
      const due = new Date(startDate); due.setMonth(due.getMonth() + j * freq);
      const paid = j < count - 1; // last one pending
      await pool.query(
        `INSERT INTO fin_premiums (policy_id,seq,due_date,amount,status,paid_at,paid_amount,payment_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [polR.rows[0].id, j+1, due.toISOString().slice(0,10),
         isLoan ? emi : premium,
         paid ? 'paid' : 'pending',
         paid ? new Date() : null,
         paid ? (isLoan ? emi : premium) : 0,
         paid ? 'NEFT' : '']
      );
      premiums++;
    }
  }
  // 2 sample claims
  for (let i = 0; i < 2; i++) {
    await pool.query(
      `INSERT INTO fin_claims (lead_id,claim_no,claim_type,incident_date,claim_amount,approved_amount,status,docs_status,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [leads.rows[i].id, `CLM-2026-${100+i}`, 'Hospitalization',
       new Date().toISOString().slice(0,10),
       50000 + i * 25000, i === 0 ? 45000 : 0,
       i === 0 ? 'approved' : 'under_review',
       i === 0 ? 'complete' : 'pending',
       i === 0 ? 'Discharge summary submitted' : 'Awaiting bill copies']
    );
    claims++;
  }
  return { policies, premiums, claims };
}

async function _seedSolarDemoData(pool, adminUserId, slugOverride) {
  const slug = slugOverride || 'showcase-solar';
  await db.tenantStorage.run({ pool, slug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/solar');
    await fw.installPack('solar', { userId: adminUserId });
  });
  const leads = await pool.query(`SELECT id, name FROM leads ORDER BY id LIMIT 10`);
  const STATES = ['Maharashtra','Karnataka','Gujarat','Tamil Nadu','Delhi'];
  const DISCOMS = ['MSEDCL','BESCOM','DGVCL','TANGEDCO','BSES Rajdhani'];
  let sites = 0, quotes = 0, installs = 0, subsidies = 0;
  for (let i = 0; i < Math.min(8, leads.rows.length); i++) {
    const lead = leads.rows[i];
    const kw = 3 + i;
    const rooftop = 200 + i * 50;
    const bill = 4000 + i * 1500;
    const siteR = await pool.query(
      `INSERT INTO solar_sites (lead_id,address,pincode,state,rooftop_area_sqft,monthly_bill_inr,monthly_units_kwh,roof_type,shadow_pct,discom,sanctioned_load_kw,survey_done,survey_at,survey_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [lead.id, `Plot ${100+i}, Sector ${10+i}`, '4' + (10000+i),
       STATES[i % STATES.length], rooftop, bill, Math.round(bill / 8),
       'rcc', 5 + i, DISCOMS[i % DISCOMS.length], 5,
       i < 6 ? 1 : 0, i < 6 ? new Date() : null, i < 6 ? adminUserId : null]
    );
    sites++;
    if (i < 6) {
      const ratePerKw = 55000;
      const subtotal = kw * ratePerKw;
      const gst = subtotal * 0.138;
      const total = subtotal + gst;
      const subsidyEst = Math.min(78000, kw * 14588);
      await pool.query(
        `INSERT INTO solar_quotes (lead_id,site_id,quote_no,system_kw,panel_brand,panel_count,inverter_brand,structure_type,on_grid,rate_per_kw,subtotal,gst,total,subsidy_estimated,valid_till,status,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [lead.id, siteR.rows[0].id, `Q-2026-${500+i}`, kw,
         'Adani Solar', kw * 3, 'Growatt', 'standard', 1, ratePerKw,
         subtotal, gst, total, subsidyEst,
         new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10),
         i < 4 ? 'sent' : 'draft', adminUserId]
      );
      quotes++;
    }
    if (i < 3) {
      const startD = new Date(); startD.setDate(startD.getDate() - 60 + i * 15);
      const endD = new Date(startD); endD.setDate(endD.getDate() + 7);
      const commD = new Date(endD); commD.setDate(commD.getDate() + 14);
      await pool.query(
        `INSERT INTO solar_installations (lead_id,system_kw,material_ordered_at,material_delivered_at,installation_start,installation_end,net_meter_applied_at,net_meter_installed_at,commissioned_at,installer_name,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [lead.id, kw, startD.toISOString().slice(0,10), startD.toISOString().slice(0,10),
         startD.toISOString().slice(0,10), endD.toISOString().slice(0,10),
         endD.toISOString().slice(0,10), commD.toISOString().slice(0,10),
         i === 0 ? commD.toISOString().slice(0,10) : null,
         'Local Installer Pvt Ltd', i === 0 ? 'commissioned' : 'in_progress']
      );
      installs++;
      if (i === 0) {
        await pool.query(
          `INSERT INTO solar_subsidies (lead_id,dso_app_no,subsidy_amount,application_at,status,notes)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [lead.id, `DSO-2026-${800+i}`, 14588 * kw,
           endD.toISOString().slice(0,10), 'applied', 'Awaiting DISCOM approval']
        );
        subsidies++;
      }
    }
  }
  return { sites, quotes, installs, subsidies };
}

async function _seedManufacturerDemoData(pool, adminUserId, slugOverride) {
  const slug = slugOverride || 'showcase-mfg';
  await db.tenantStorage.run({ pool, slug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/manufacturer');
    await fw.installPack('manufacturer', { userId: adminUserId });
  });
  const leads = await pool.query(`SELECT id, name FROM leads ORDER BY id LIMIT 10`);
  const ITEMS_SAMPLES = [
    [{name:'Bolt M10', qty:1000, rate:8.5}, {name:'Nut M10', qty:1000, rate:4.2}],
    [{name:'CNC Bracket', qty:500, rate:120}],
    [{name:'Steel Plate 6mm', qty:50, rate:850}, {name:'Welding rod', qty:200, rate:25}],
    [{name:'Aluminum profile', qty:300, rate:175}]
  ];
  let rfqs = 0, quotes = 0, orders = 0, prods = 0, dispatches = 0;
  for (let i = 0; i < Math.min(8, leads.rows.length); i++) {
    const lead = leads.rows[i];
    const inqR = await pool.query(
      `INSERT INTO mfg_inquiries (lead_id,rfq_no,product_specs,quantity,material_grade,expected_delivery_date,payment_terms,shipping_terms,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [lead.id, `RFQ-2026-${300+i}`,
       'Custom steel components per drawing', 500 + i * 100,
       'IS 2062 E250', new Date(Date.now() + (30 + i * 7) * 86400000).toISOString().slice(0,10),
       '30% advance, 70% on dispatch', 'Ex-Works',
       i < 4 ? 'quoted' : 'received']
    );
    rfqs++;
    if (i < 6) {
      const items = ITEMS_SAMPLES[i % ITEMS_SAMPLES.length];
      const subtotal = items.reduce((s, x) => s + x.qty * x.rate, 0);
      const gst = subtotal * 0.18;
      const total = subtotal + gst;
      const qR = await pool.query(
        `INSERT INTO mfg_quotes (lead_id,inquiry_id,quote_no,items_json,subtotal,gst,total,hsn_code,payment_terms,delivery_terms,valid_till,status,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [lead.id, inqR.rows[0].id, `Q-2026-${500+i}`, JSON.stringify(items),
         subtotal, gst, total, '7308',
         '30% advance, 70% on dispatch', 'Ex-Works Mumbai',
         new Date(Date.now() + 15 * 86400000).toISOString().slice(0,10),
         i < 4 ? 'sent' : 'draft', adminUserId]
      );
      quotes++;
      if (i < 4) {
        const advance = total * 0.3;
        const balance = total - advance;
        const oR = await pool.query(
          `INSERT INTO mfg_orders (lead_id,quote_id,po_number,po_date,order_value,advance_amount,balance_amount,delivery_date,status,payment_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [lead.id, qR.rows[0].id, `PO-${5000+i}`,
           new Date(Date.now() - i * 5 * 86400000).toISOString().slice(0,10),
           total, advance, balance,
           new Date(Date.now() + 30 * 86400000).toISOString().slice(0,10),
           i < 2 ? 'in_production' : 'received',
           i === 0 ? 'partial' : 'unpaid']
        );
        orders++;
        if (i < 2) {
          await pool.query(
            `INSERT INTO mfg_production (order_id,work_order_no,start_date,expected_end_date,qc_status,status,progress_pct)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [oR.rows[0].id, `WO-${7000+i}`,
             new Date().toISOString().slice(0,10),
             new Date(Date.now() + 20 * 86400000).toISOString().slice(0,10),
             'pending', 'in_progress', 30 + i * 35]
          );
          prods++;
        }
        if (i === 0) {
          await pool.query(
            `INSERT INTO mfg_dispatches (order_id,dispatch_no,dispatch_date,courier,awb,invoice_no,invoice_amount,eway_bill,vehicle_no,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [oR.rows[0].id, `DSP-${9000+i}`,
             new Date().toISOString().slice(0,10),
             'VRL Logistics', 'AWB' + (40000+i),
             `INV-${i+100}`, total, 'EWB' + (50000+i), 'MH-12-AB-1234',
             'dispatched']
          );
          dispatches++;
        }
      }
    }
  }
  return { rfqs, quotes, orders, production: prods, dispatches };
}

async function _seedHolidayDemoData(pool, adminUserId, slugOverride) {
  const slug = slugOverride || 'showcase-holiday';
  await db.tenantStorage.run({ pool, slug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/holiday');
    await fw.installPack('holiday', { userId: adminUserId });
  });
  // Packages already seeded by install()
  const pkgs = await pool.query(`SELECT id, name, base_price_per_adult FROM tour_packages ORDER BY id LIMIT 4`);
  const leads = await pool.query(`SELECT id, name FROM leads ORDER BY id LIMIT 12`);
  let bookings = 0, itin = 0, payments = 0, vouchers = 0;
  for (let i = 0; i < Math.min(8, leads.rows.length); i++) {
    const lead = leads.rows[i];
    const pkg = pkgs.rows[i % pkgs.rows.length];
    const adults = 2 + (i % 3);
    const children = i % 2;
    const totalAmount = adults * Number(pkg.base_price_per_adult) + children * 5000;
    const advance = Math.round(totalAmount * 0.3);
    const travelStart = new Date(Date.now() + (30 + i * 7) * 86400000);
    const travelEnd = new Date(travelStart); travelEnd.setDate(travelEnd.getDate() + 5);
    const bR = await pool.query(
      `INSERT INTO tour_bookings (lead_id,package_id,booking_no,destination,travel_start_date,travel_end_date,pax_adults,pax_children,total_amount,advance_amount,balance_amount,visa_status,docs_status,status,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [lead.id, pkg.id, `BK-2026-${600+i}`, pkg.name,
       travelStart.toISOString().slice(0,10), travelEnd.toISOString().slice(0,10),
       adults, children, totalAmount, advance, totalAmount - advance,
       i % 2 === 0 ? 'approved' : 'not_required',
       i < 5 ? 'complete' : 'pending',
       i < 6 ? 'confirmed' : 'in_progress', adminUserId]
    );
    bookings++;
    // 3-day itinerary sample
    const days = [
      ['Arrival + Welcome dinner', 'Beachfront resort check-in', 'Dinner'],
      ['Sightseeing + Local market', 'Same hotel', 'Breakfast + Lunch'],
      ['Departure', 'Checkout', 'Breakfast']
    ];
    for (let d = 0; d < 3; d++) {
      const dt = new Date(travelStart); dt.setDate(dt.getDate() + d);
      await pool.query(
        `INSERT INTO tour_itineraries (booking_id,day_no,date,title,activities,hotel_name,meals,transport)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [bR.rows[0].id, d+1, dt.toISOString().slice(0,10),
         `Day ${d+1} — ${pkg.name.split(' ')[0]}`, days[d][0], days[d][1], days[d][2],
         d === 0 ? 'Airport pickup' : (d === 2 ? 'Airport drop' : 'Private cab')]
      );
      itin++;
    }
    // Advance payment
    await pool.query(
      `INSERT INTO tour_payments (booking_id,amount,payment_mode,payment_ref,payment_type,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [bR.rows[0].id, advance, 'UPI', `TXN${100000+i}`, 'advance', adminUserId]
    );
    payments++;
    if (i < 3) {
      await pool.query(
        `INSERT INTO tour_vouchers (booking_id,voucher_type,voucher_no,vendor,valid_from,valid_till,amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [bR.rows[0].id, 'hotel', `HV-${800+i}`, 'BookingPartner.com',
         travelStart.toISOString().slice(0,10), travelEnd.toISOString().slice(0,10),
         totalAmount * 0.5]
      );
      vouchers++;
    }
  }
  return { bookings, itineraries: itin, payments, vouchers };
}

async function _seedEcommerceDemoData(pool, adminUserId, slugOverride) {
  const slug = slugOverride || 'showcase-ecommerce';
  await db.tenantStorage.run({ pool, slug }, async () => {
    const fw = require('../packs/_framework');
    require('../packs/ecommerce');
    await fw.installPack('ecommerce', { userId: adminUserId });
  });
  // Products already seeded by install
  const prods = await pool.query(`SELECT id, sku, name, sale_price FROM ec_products ORDER BY id LIMIT 4`);
  const leads = await pool.query(`SELECT id, name, phone FROM leads ORDER BY id LIMIT 15`);
  const COURIERS = ['Delhivery','Blue Dart','Xpressbees','Shadowfax'];
  const STATUSES = ['delivered','shipped','packed','placed'];
  let orders = 0, returns = 0, carts = 0;
  for (let i = 0; i < Math.min(10, leads.rows.length); i++) {
    const lead = leads.rows[i];
    const prod = prods.rows[i % prods.rows.length];
    const qty = 1 + (i % 3);
    const items = [{ sku: prod.sku, name: prod.name, qty, price: Number(prod.sale_price) }];
    const subtotal = qty * Number(prod.sale_price);
    const orderValue = subtotal + 49;  // shipping ₹49
    const placedAt = new Date(Date.now() - (i * 3 + 1) * 86400000);
    const status = STATUSES[Math.min(Math.floor(i / 3), STATUSES.length - 1)];
    const oR = await pool.query(
      `INSERT INTO ec_orders (lead_id,order_id,items_json,subtotal,discount,shipping,tax,order_value,payment_mode,payment_status,shipping_address,pincode,state,courier_partner,awb,tracking_url,placed_at,shipped_at,delivered_at,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [lead.id, `ORD-2026-${10000+i}`, JSON.stringify(items),
       subtotal, 0, 49, 0, orderValue,
       i % 3 === 0 ? 'cod' : 'prepaid',
       (status === 'delivered' || status === 'shipped') ? 'paid' : 'unpaid',
       `Flat ${i+1}, Sector ${(i%20)+1}`, '400' + (100+i), 'Maharashtra',
       COURIERS[i % COURIERS.length], 'AWB' + (60000+i),
       `https://track.example.com/AWB${60000+i}`,
       placedAt,
       (status !== 'placed') ? new Date(placedAt.getTime() + 86400000) : null,
       status === 'delivered' ? new Date(placedAt.getTime() + 3 * 86400000) : null,
       status]
    );
    orders++;
    // Loyalty auto-bumped by trigger? No — pack does it in api_ec_order_create.
    // Replicate manually for demo seed.
    await pool.query(
      `INSERT INTO ec_loyalty (lead_id, points, lifetime_value, order_count, last_order_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (lead_id) DO UPDATE SET
         points = ec_loyalty.points + EXCLUDED.points,
         lifetime_value = ec_loyalty.lifetime_value + EXCLUDED.lifetime_value,
         order_count = ec_loyalty.order_count + 1,
         last_order_at = NOW(),
         tier = CASE
           WHEN ec_loyalty.lifetime_value + EXCLUDED.lifetime_value >= 50000 THEN 'gold'
           WHEN ec_loyalty.lifetime_value + EXCLUDED.lifetime_value >= 15000 THEN 'silver'
           ELSE 'bronze' END,
         updated_at = NOW()`,
      [lead.id, Math.floor(orderValue / 100), orderValue]
    );
    if (i === 0 || i === 4) {
      await pool.query(
        `INSERT INTO ec_returns (order_id,lead_id,return_no,items_json,return_reason,refund_amount,refund_status,refund_mode,pickup_awb,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [oR.rows[0].id, lead.id, `RET-2026-${700+i}`, JSON.stringify(items),
         i === 0 ? 'Size too small' : 'Defective product',
         orderValue, i === 0 ? 'refunded' : 'pending', 'UPI',
         'PAWB' + (70000+i), i === 0 ? 'refunded' : 'received']
      );
      returns++;
    }
  }
  // Abandoned carts
  for (let i = 10; i < Math.min(15, leads.rows.length); i++) {
    const lead = leads.rows[i];
    const prod = prods.rows[i % prods.rows.length];
    const items = [{ sku: prod.sku, name: prod.name, qty: 1 + (i%2), price: Number(prod.sale_price) }];
    const value = items.reduce((s,x)=>s+x.qty*x.price,0);
    await pool.query(
      `INSERT INTO ec_abandoned_carts (lead_id, cart_id, items_json, cart_value, abandoned_at, status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [lead.id, `CART-2026-${800+i}`, JSON.stringify(items), value,
       new Date(Date.now() - (i - 9) * 3600000), 'abandoned']
    );
    carts++;
  }
  return { orders, returns, abandoned_carts: carts };
}

// ─────────────────────────────────────────────────────────────────
// API wrappers — super-admin entry points
// ─────────────────────────────────────────────────────────────────

async function _genericPackSeed(token, packKey, seedFn) {
  const me = await requireSuperAdmin(token);
  const conf = INDUSTRY_SHOWCASES[packKey];
  const tenant = await _findOrCreateDemoTenant(me.id, me.email, conf);
  const pool = tenantPool.poolFor(tenant);
  if (!pool) throw new Error('Could not connect to demo tenant DB');
  const adminUserId = await _resetAdminPassword(pool, conf.email, conf.password);
  const baseSummary = await _wipeAndSeed(pool, adminUserId);
  const packSummary = await seedFn(pool, adminUserId, conf.slug);
  const summary = Object.assign({}, baseSummary && baseSummary.counts || {}, packSummary || {});
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/, '');
  const url = `${baseUrl}/t/${tenant.slug}/`;
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: tenant.id, event: `tenant.demo_seeded_${packKey}`,
    detail: JSON.stringify(summary)
  });
  return {
    ok: true, slug: tenant.slug, url,
    email: conf.email, password: conf.password,
    pack: packKey, counts: summary
  };
}

async function api_saas_demo_seedFinancePack(token)      { return _genericPackSeed(token, 'finance',      _seedFinanceDemoData); }
async function api_saas_demo_seedSolarPack(token)        { return _genericPackSeed(token, 'solar',        _seedSolarDemoData); }
async function api_saas_demo_seedManufacturerPack(token) { return _genericPackSeed(token, 'manufacturer', _seedManufacturerDemoData); }
async function api_saas_demo_seedHolidayPack(token)      { return _genericPackSeed(token, 'holiday',      _seedHolidayDemoData); }
async function api_saas_demo_seedEcommercePack(token)    { return _genericPackSeed(token, 'ecommerce',    _seedEcommerceDemoData); }

module.exports = {
  api_saas_demo_seed,
  api_saas_demo_snapshot,
  api_saas_demo_seedEducationPack,
  api_saas_demo_seedRealEstatePack,
  api_saas_demo_seedFinancePack,
  api_saas_demo_seedSolarPack,
  api_saas_demo_seedManufacturerPack,
  api_saas_demo_seedHolidayPack,
  api_saas_demo_seedEcommercePack
};
