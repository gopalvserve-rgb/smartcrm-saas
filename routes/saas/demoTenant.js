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

async function _findOrCreateDemoTenant(operatorId, operatorEmail) {
  // Look for existing showcase tenant first.
  const existing = await control.findOneBy('tenants', 'slug', DEMO_SLUG);
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
    email: DEMO_EMAIL,
    mobile: '+919999999999',
    org_name: DEMO_ORG_NAME,
    package_id: packageId,
    desired_slug: DEMO_SLUG,
    status: 'pending',
    metadata: JSON.stringify({
      demo_seed: true, created_by: operatorEmail, created_by_id: operatorId
    })
  });
  await provisioning.provisionFromSignup(signupId);

  const t = await control.findOneBy('tenants', 'slug', DEMO_SLUG);
  if (!t) throw new Error('Provisioning succeeded but tenant row not found — please retry.');
  return t;
}

async function _resetAdminPassword(pool) {
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  // Try to update by email; if no row, insert.
  const r = await pool.query(
    `UPDATE users SET name = 'Demo Admin', password_hash = $1, role = 'admin', is_active = 1, designation = 'Founder' WHERE email = $2 RETURNING id`,
    [hash, DEMO_EMAIL]
  );
  if (r.rows.length) return Number(r.rows[0].id);
  const ins = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, is_active, designation, created_at)
     VALUES ('Demo Admin', $1, $2, 'admin', 1, 'Founder', NOW())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [DEMO_EMAIL, hash]
  );
  return Number(ins.rows[0].id);
}

async function _wipeAndSeed(pool, adminUserId) {
  // ---- 1. Wipe transactional data so re-running the seeder produces
  //         a clean dataset (preserves admin user, KB articles, config).
  const wipeOrder = [
    'quotation_items', 'quotations',
    'lead_recordings', 'remarks', 'followups', 'lead_actions',
    'lead_stage_log', 'tat_violations',
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

  // ---- 10. Recordings with FAKE AI summaries / audits / ratings
  // Pick the first 10 leads, attach one recording each.
  const audioPlaceholder = Buffer.from('demo'); // tiny non-empty placeholder
  for (let i = 0; i < Math.min(10, leadIds.length); i++) {
    const l = leadIds[i];
    const t = DEMO_TRANSCRIPTS[i % DEMO_TRANSCRIPTS.length];
    const dir = i % 3 === 0 ? 'in' : 'out';
    const dur = _randInt(45, 380);
    const startedDaysAgo = _randInt(0, 14);

    // Map "mixed/positive/negative/neutral" sentiment to suggested status
    let suggestedStatusId = null;
    if (t.sentiment === 'positive')      suggestedStatusId = statusIds['Qualified'];
    else if (t.sentiment === 'negative') suggestedStatusId = statusIds['Lost'];
    else if (l.status === 'Proposal Sent') suggestedStatusId = statusIds['Negotiation'];

    await pool.query(
      `INSERT INTO lead_recordings
        (lead_id, user_id, phone, direction, duration_s, device_path, mime_type, size_bytes, audio_bytes,
         started_at, created_at,
         transcript, summary, action_items, sentiment, suggested_status_id, next_followup_days, key_insight,
         ai_processed_at, ai_provider,
         rating, rating_by, rating_notes, rated_at, ai_suggested_rating)
       VALUES
        ($1, $2, $3, $4, $5, $6, 'audio/m4a', $7, $8,
         $9, $9,
         $10, $11, $12, $13, $14, $15, $16,
         $9, 'gemini-2.5-flash-lite (demo)',
         $17, $2, $18, $9, $19)`,
      [
        l.id, l.assignee, l.phone, dir, dur,
        '/storage/recordings/demo_' + i + '.m4a',
        audioPlaceholder.length, audioPlaceholder,
        _daysAgo(startedDaysAgo),
        t.transcript, t.summary, t.action_items, t.sentiment,
        suggestedStatusId, t.next_followup_days, t.key_insight,
        t.rating, t.rating_notes, t.ai_suggested_rating
      ]
    );
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
      recordings: Math.min(10, leadIds.length),
      quotations: DEMO_QUOTES.length
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

  const tenant = await _findOrCreateDemoTenant(me.id, me.email);
  const pool = tenantPool.poolFor(tenant);
  if (!pool) throw new Error('Could not connect to demo tenant DB');

  const adminUserId = await _resetAdminPassword(pool);
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
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    counts: summary.counts
  };
}

module.exports = {
  api_saas_demo_seed
};
