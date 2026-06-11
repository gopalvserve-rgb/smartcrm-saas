/**
 * routes/crmCopilot.js  —  v2 (expanded tool catalog)
 *
 * In-app "Ask CRM" assistant. Wraps Gemini with a function-calling
 * layer that exposes a curated set of CRM data tools so users can ask
 * natural-language questions and the model fetches REAL data via tools
 * instead of hallucinating.
 *
 * Public surface (auto-loaded by tenantApi.js):
 *   api_copilot_ask(token, message, history?)
 *     -> { text, tools_called, daily_used, daily_limit, cost_inr_billed }
 *   api_copilot_usage(token)
 *     -> { today, daily_limit, recent: [...] }
 *
 * Tool catalog covers:
 *   - count_leads, list_leads, search_leads, get_lead_detail
 *   - report_summary, employee_performance, top_performers, conversion_rate
 *   - pipeline_funnel, source_breakdown, lead_aging
 *   - my_tasks_today, followups_summary, todays_calls, recent_activity
 *   - quotation_summary, recordings_summary
 *   - tat_violations, list_employees, list_products, list_statuses, list_sources
 *
 * Daily limit per user, defaults to 50, override via tenant config
 * COPILOT_DAILY_LIMIT_PER_USER. The limit counts api_copilot_ask calls
 * in the current UTC date for this user.
 */

'use strict';

const db = require('../db/pg');
const { authUser, hashPassword } = require('../utils/auth');
const gemini = require('../utils/geminiClient');
const setupGuide = require('../utils/setupGuide');

// ---- Per-pool schema bootstrap --------------------------------------
const _ensuredPools = new WeakSet();
async function _ensureTables() {
  let pool = null;
  try {
    const store = db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore();
    pool = store && store.pool;
  } catch (_) {}
  if (pool && _ensuredPools.has(pool)) return;
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS crm_copilot_log (
      id              SERIAL PRIMARY KEY,
      user_id         INTEGER,
      question        TEXT NOT NULL,
      answer          TEXT,
      tools_called    JSONB,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cost_inr_billed NUMERIC(12,4) NOT NULL DEFAULT 0,
      error_text      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_copilot_log_user_day
                    ON crm_copilot_log(user_id, created_at DESC)`);
    // CP_ACT_v1: audit table for two-phase write actions
    await db.query(`CREATE TABLE IF NOT EXISTS copilot_actions (
      id              SERIAL PRIMARY KEY,
      confirm_token   VARCHAR(48) NOT NULL UNIQUE,
      user_id         INTEGER NOT NULL,
      tool_name       VARCHAR(80) NOT NULL,
      args_json       JSONB NOT NULL,
      preview_text    TEXT NOT NULL,
      preview_card    JSONB,
      state           VARCHAR(20) NOT NULL DEFAULT 'pending',
      result_json     JSONB,
      error_text      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at    TIMESTAMPTZ,
      expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_copilot_act_user_day
                    ON copilot_actions(user_id, created_at DESC)`);
    if (pool) _ensuredPools.add(pool);
  } catch (e) { console.warn('[copilot] ensureTables failed:', e.message); }
}

// ---- Tool catalog ---------------------------------------------------
const TOOLS = [
  // ---- LEADS -----------------------------------------------------
  { name: 'count_leads',
    description: "Count leads matching filters. Use for 'how many leads', 'won this month', 'leads from <source>'. Leave from/to OUT for ALL-TIME totals.",
    parameters: { type: 'object', properties: {
      from: { type: 'string', description: 'ISO date (YYYY-MM-DD) lower bound on created_at — only set when user gives a date range' },
      to:   { type: 'string', description: 'ISO date (YYYY-MM-DD) upper bound on created_at' },
      status: { type: 'string', description: 'Status name e.g. New / Contacted / Won / Lost' },
      source: { type: 'string', description: 'Source name e.g. Website / Facebook / Inbound Call' },
      assigned_to: { type: 'string', description: 'User name to filter by' }
    } } },
  { name: 'list_leads',
    description: "List recent leads matching filters (max 20). Use for 'show me 3 fresh leads', 'leads from <source>', 'leads assigned to <name>'. Returns name, phone, status, assignee, source, value, created_at.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' },
      status: { type: 'string' }, source: { type: 'string' },
      assigned_to: { type: 'string' },
      tat_breached: { type: 'boolean', description: 'Only return leads whose TAT is breached' },
      limit: { type: 'number', description: 'Default 5; max 20' }
    } } },
  { name: 'list_hot_leads',
    description: "List leads sorted by AI heat score (highest first). Use for 'show hot leads', 'who's most likely to convert', 'hottest prospects'. Returns leads with heat_score and heat_label (warm/hot/very_hot/on_fire).",
    parameters: { type: 'object', properties: {
      min_score: { type: 'number', description: 'Minimum heat_score (default 1 — i.e., any lead with a heat signal)' },
      level: { type: 'string', description: 'Filter by heat_label: warm, hot, very_hot, or on_fire' },
      assigned_to: { type: 'string' },
      limit: { type: 'number', description: 'Default 10; max 25' }
    } } },
  { name: 'search_leads',
    description: "Free-text search across leads by name, phone, email, or company. Use for 'find lead Rahul', 'search Bright Solutions', 'lookup 9876543210'.",
    parameters: { type: 'object', properties: {
      q: { type: 'string', description: 'The search term — name, phone, email, or company' },
      limit: { type: 'number', description: 'Default 10; max 25' }
    }, required: ['q'] } },
  { name: 'get_lead_detail',
    description: "Full profile of a single lead by id (or name+phone if id unknown). Returns contact info, status, assignee, recent remarks, follow-ups, recordings count.",
    parameters: { type: 'object', properties: {
      lead_id: { type: 'number' },
      name: { type: 'string', description: 'Lead name (if id not known)' },
      phone: { type: 'string', description: 'Lead phone (if id not known)' }
    } } },
  { name: 'lead_aging',
    description: "Oldest open (non-final-status) leads. Use for 'leads stuck in pipeline', 'oldest unactioned leads'.",
    parameters: { type: 'object', properties: {
      limit: { type: 'number', description: 'Default 10; max 30' },
      min_age_days: { type: 'number', description: 'Only leads older than N days' }
    } } },

  // ---- REPORTS / KPIs -------------------------------------------
  { name: 'report_summary',
    description: "High-level KPI snapshot for a period: total leads, won, lost, breakdown by status + by source. Defaults to last 30 days when no dates given.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },
  { name: 'pipeline_funnel',
    description: "Lead counts grouped by status, in pipeline order. ALL-TIME totals when no dates given (matches the dashboard).",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },
  { name: 'source_breakdown',
    description: "Leads + total value grouped by source (Website, Facebook, etc.) with conversion rates. Use for 'where do leads come from', 'best performing source'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },
  { name: 'conversion_rate',
    description: "Win rate (won leads / total leads * 100). Optionally split by source or by assignee. Use for 'what is our conversion rate', 'conversion by rep'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' },
      group_by: { type: 'string', description: "'source' | 'assigned_to' | overall" }
    } } },
  { name: 'employee_performance',
    description: "Per-rep counts (total, new, open, won, lost) over a period. Defaults to last 30 days.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },
  { name: 'leads_status_by_employee',
    description: "Lead-status breakdown per employee — returns a matrix of how many leads each sales rep has in each status (New, In Progress, Won, Lost, etc.). Use for 'employee-wise lead status', 'status breakdown by sales rep', 'who has how many leads in each stage'. Defaults to ALL TIME if no dates given.",
    parameters: { type: 'object', properties: {
      from: { type: 'string', description: 'YYYY-MM-DD start date (optional — all time if omitted)' },
      to:   { type: 'string', description: 'YYYY-MM-DD end date' },
      assigned_to: { type: 'string', description: 'Optional: filter to one employee name' }
    } } },
  { name: 'top_performers',
    description: "Top N sales reps ranked by won leads, lead value, or remarks count. Use for 'best performer this month', 'top 3 reps'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' },
      metric: { type: 'string', description: "'won' | 'value' | 'remarks' (default 'won')" },
      limit: { type: 'number', description: 'Default 5; max 20' }
    } } },

  // ---- TASKS / FOLLOW-UPS ---------------------------------------
  { name: 'my_tasks_today',
    description: 'Tasks + follow-ups due today for the calling user.',
    parameters: { type: 'object', properties: {} } },
  { name: 'followups_summary',
    description: "Counts of overdue / due-today / upcoming follow-ups across the org with a sample. Use for 'how many follow-ups due', 'overdue follow-ups'.",
    parameters: { type: 'object', properties: {
      assigned_to: { type: 'string', description: 'Optional — only this rep' }
    } } },

  // ---- CALLS / RECORDINGS ---------------------------------------
  { name: 'todays_calls',
    description: 'Calls logged today (incoming, outgoing, missed) — counts + sample.',
    parameters: { type: 'object', properties: {} } },
  { name: 'recordings_summary',
    description: "Recordings stats: total count, average AI rating, sentiment split, top action items. Use for 'how many calls recorded', 'average call quality', 'AI sentiment breakdown'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },

  // ---- QUOTATIONS -----------------------------------------------
  { name: 'quotation_summary',
    description: "Quotation counts and total value grouped by status (draft, sent, accepted, rejected). Use for 'how many quotes', 'pipeline value in quotations'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },

  // ---- TAT ------------------------------------------------------
  { name: 'tat_violations',
    description: "Leads currently breaching TAT thresholds. Use for 'leads out of TAT', 'TAT violators'.",
    parameters: { type: 'object', properties: {
      limit: { type: 'number', description: 'Default 10; max 30' }
    } } },

  // ---- ACTIVITY -------------------------------------------------
  { name: 'recent_activity',
    description: "Latest N actions across leads (status changes, remarks, follow-ups). Use for 'what happened today', 'recent activity'.",
    parameters: { type: 'object', properties: {
      limit: { type: 'number', description: 'Default 15; max 50' },
      kind: { type: 'string', description: "Optional: 'status_change' | 'remark' | 'followup'" }
    } } },

  // ---- DICTIONARY (the bot uses these to resolve names) ---------
  { name: 'list_employees',
    description: "List all active users / employees with role, designation, department. Use for 'who are the sales reps', 'list employees', 'tell me about <name>'.",
    parameters: { type: 'object', properties: {
      role: { type: 'string', description: "Optional filter: 'admin' | 'manager' | 'team_leader' | 'sales'" }
    } } },
  { name: 'list_products',
    description: 'List products / plans with prices.',
    parameters: { type: 'object', properties: {} } },
  { name: 'list_statuses',
    description: 'List all statuses in the pipeline (with sort order + final flag).',
    parameters: { type: 'object', properties: {} } },
  { name: 'list_sources',
    description: 'List all lead sources.',
    parameters: { type: 'object', properties: {} } },

  // ---- DIMENSIONAL BREAKDOWNS (v3) ----------------------------
  { name: 'leads_by_product',
    description: "Lead counts + total value grouped by product. Use for 'leads by product', 'which product gets most leads', 'product-wise pipeline'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },
  { name: 'leads_by_project_stage',
    description: "Lead counts grouped by Sale Final Closure Stage (post-sale closure pipeline). Use for 'sale closure stage wise data', 'where are leads in final closure', 'closure stage breakdown', and legacy phrasing 'project stages'.",
    parameters: { type: 'object', properties: {} } },
  { name: 'leads_by_custom_field',
    description: "Lead counts grouped by a custom field value. Use for 'leads by industry', 'leads by company size', 'breakdown by <custom field>'.",
    parameters: { type: 'object', properties: {
      field_key: { type: 'string', description: 'The custom_fields.key to group by (e.g. industry, company_size, budget_range)' },
      from: { type: 'string' }, to: { type: 'string' }
    }, required: ['field_key'] } },

  // ---- PERFORMERS / TARGETS (v3) ------------------------------
  { name: 'bottom_performers',
    description: "Lowest-performing reps — use to identify NON-performers. Same metrics as top_performers (won, value, remarks).",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' },
      metric: { type: 'string' },
      limit: { type: 'number' }
    } } },
  { name: 'monthly_target_status',
    description: "Per-rep monthly target progress: target vs current vs shortfall. Use for 'monthly target', 'shortfall', 'how much remaining', 'target achievement'.",
    parameters: { type: 'object', properties: {
      month: { type: 'string', description: "YYYY-MM. Defaults to current month." },
      assigned_to: { type: 'string', description: 'Optional rep name' }
    } } },

  // ---- CALLS / RECORDINGS (v3) --------------------------------
  { name: 'call_ratings_breakdown',
    description: "Call quality ratings grouped by rep. Use for 'who has best call ratings', 'rep with worst call quality', 'call rating per agent'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },
  { name: 'call_insights_recent',
    description: "Recent AI 'key insights' extracted from call recordings, plus action items + sentiment. Use for 'recent call insights', 'what did we learn from calls', 'AI takeaways'.",
    parameters: { type: 'object', properties: {
      limit: { type: 'number' }
    } } },

  // ---- WHATSAPP (v3) ------------------------------------------
  { name: 'wa_unattended_chats',
    description: "WhatsApp threads where the latest customer message has not been replied to by the agent. Use for 'unattended chats', 'pending whatsapp', 'who is waiting for a reply'.",
    parameters: { type: 'object', properties: {
      hours: { type: 'number', description: 'How many hours back to scan (default 48)' },
      limit: { type: 'number' }
    } } },
  { name: 'wa_response_delays',
    description: "Average and worst-case time between an inbound WhatsApp message and the next outbound reply, per rep. Use for 'WhatsApp response time', 'who is slow on WA'.",
    parameters: { type: 'object', properties: {
      from: { type: 'string' }, to: { type: 'string' }
    } } },

  // ---- ATTENDANCE / LOGIN (v3) --------------------------------
  { name: 'attendance_today',
    description: "Today's attendance: who is present, who is absent, and who came LATE (after the configured WORK_START time). Use for 'attendance today', 'who came late', 'who is absent today'.",
    parameters: { type: 'object', properties: {} } },
  { name: 'login_locations',
    description: "Recent device logins per user — IP, user agent, last seen. Use for 'where did <name> log in from', 'login locations', 'unusual login'.",
    parameters: { type: 'object', properties: {
      user: { type: 'string', description: 'Optional user name to filter' },
      limit: { type: 'number' }
    } } },,

  // ---- PLATFORM HELP / SETUP GUIDE -------------------------------
  { name: 'lookup_setup_guide',
    description: "Look up step-by-step setup instructions from the SmartCRM Setup Guide. Use whenever the user asks 'how do I...', 'how to set up...', 'where do I configure...', 'is there a guide for...', or anything about Pabbly / Make / Zapier / Meta Lead Ads / Google Ads / WhatsApp / AI Bot / SMTP / push notifications / mobile app / custom fields / campaigns / TAT / auto-assign rules / permissions / Calendly / CSV import. Returns the matching guide section with steps + a deep-link URL the user can open.",
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'The user setup question, eg. "set up Pabbly", "WhatsApp embedded sign in", "create a custom field"' }
    }, required: ['query'] } },

  // ---- CP_ACT_v1: Write/action tools (vserve-only beta) -------------
  // These NEVER execute directly. They build a preview card + confirm_token
  // and return it. SPA shows the preview; user taps Confirm; SPA calls
  // api_copilot_confirm to actually run the write. Audit log on every step.
  { name: 'create_autoassign_rule',
    description: "Create a STANDING auto-assign rule for FUTURE incoming leads. Use when user says 'set up rule', 'auto assign', 'always', 'going forward', 'from now on', or 'any X lead should go to Y'. Do NOT use this when user wants to move existing leads - that's reassign_leads_bulk. If ambiguous, prefer this (safer - doesn't touch existing). Pick sensible defaults: distribution='round_robin' unless user says least-loaded; scope='future' unless they say apply to existing too.",
    parameters: { type: 'object', properties: {
      name:         { type: 'string', description: 'Rule name shown in Settings, e.g. "Meta to Amit & Rohan"' },
      when_source:  { type: 'string', description: 'Lead source to match. Optional.' },
      when_status:  { type: 'string', description: 'Lead status to match. Optional.' },
      assignees:    { type: 'array', items: { type: 'string' }, description: 'User name(s) to assign to. E.g. ["Amit", "Rohan"]' },
      distribution: { type: 'string', description: 'round_robin | least_loaded | random. Default round_robin.' },
      scope:        { type: 'string', description: 'future | existing | both. Default future.' }
    }, required: ['name', 'assignees'] }
  },
  { name: 'reassign_leads_bulk',
    description: "ONE-TIME action: transfer LEAD OWNERSHIP from one user to another (or split among users). Use ONLY when the target is a PERSON / USER NAME. Trigger phrases: 'transfer to Amit', 'move to Rohan', 'reassign these to Pallabhi', 'give them to Neetu', 'distribute to Amit and Rohan'. Do NOT use this for STATUS CHANGES — phrases like 'change to Contacted', 'NP to Not Reachable', 'mark as Closed', 'all X to Y where Y is a status' belong to change_lead_status_bulk. Do NOT use for standing rules — that's create_autoassign_rule.",
    parameters: { type: 'object', properties: {
      filter_source: { type: 'string' }, filter_status: { type: 'string' },
      filter_from:   { type: 'string', description: 'YYYY-MM-DD' },
      filter_to:     { type: 'string', description: 'YYYY-MM-DD' },
      assignees:     { type: 'array', items: { type: 'string' } },
      distribution:  { type: 'string', description: 'round_robin | even_split | all_to_first. Default round_robin.' }
    }, required: ['assignees'] }
  },
  { name: 'create_status',
    description: "Create a new lead status. Use when user says 'add status X', 'create status', 'I need a new status called Y'.",
    parameters: { type: 'object', properties: {
      name:     { type: 'string' },
      color:    { type: 'string', description: 'Hex color like #3b82f6. Pick a sensible default if missing.' },
      is_final: { type: 'boolean', description: 'Whether this is a terminal status (Won/Lost-style). Default false.' }
    }, required: ['name'] }
  },
  { name: 'create_source',
    description: "Create a new lead source. Use when user says 'add source X', 'create new source called Y'.",
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  { name: 'create_user',
    description: "Create a new CRM user (employee). Use when admin says 'add user', 'create user', 'add employee', 'invite X as sales rep'. The system generates a secure 12-char password and surfaces it ONCE in the success message so admin can share it.",
    parameters: { type: 'object', properties: {
      name:  { type: 'string' },
      email: { type: 'string' },
      role:  { type: 'string', description: 'admin | manager | sales. Default sales.' },
      phone: { type: 'string' },
      department:  { type: 'string' },
      designation: { type: 'string' }
    }, required: ['name', 'email'] }
  },
  { name: 'update_status',
    description: "Update an EXISTING lead status — rename, change color, or mark as terminal. Use when admin says 'rename status X to Y', 'change color of X to red', 'make X a final status'.",
    parameters: { type: 'object', properties: {
      current_name: { type: 'string' },
      new_name:     { type: 'string' },
      color:        { type: 'string' },
      is_final:     { type: 'boolean' }
    }, required: ['current_name'] }
  },
  { name: 'change_lead_status_bulk',
    description: "ONE-TIME action: change STATUS on existing leads matching a filter. Use whenever the target value is a STATUS NAME (not a user). Strong trigger patterns: 'change X to Y', 'mark X as Y', 'NP to Not Reachable', 'today's NP to Closed', 'all New leads to Contacted', 'set Meta leads to In-Progress', 'move all X status to Y status'. If the phrase 'X to Y' has Y as a status name (Not Reachable, Closed, Contacted, In-Progress, Junk, Hot, Cold, Won, Lost, Follow Up, NP, etc.), this is the correct tool — NOT reassign_leads_bulk (which is only for changing the assigned USER). Date filters supported: 'today', 'yesterday', specific dates.",
    parameters: { type: 'object', properties: {
      to_status:     { type: 'string' },
      from_status:   { type: 'string' },
      filter_source: { type: 'string' },
      filter_from:   { type: 'string' },
      filter_to:     { type: 'string' }
    }, required: ['to_status'] }
  },
  { name: 'create_product',
    description: "Add a new product to the catalog. Use when admin says 'add product', 'create product called X', 'new product X at price Y'.",
    parameters: { type: 'object', properties: {
      name:        { type: 'string' },
      description: { type: 'string' },
      price:       { type: 'number' },
      gst_pct:     { type: 'number', description: 'GST % (0-100). Default 0.' }
    }, required: ['name'] }
  },
  { name: 'create_custom_field',
    description: "Add a new custom field to leads. Use when admin says 'add custom field', 'create custom field for X', 'add a field called Company GST'.",
    parameters: { type: 'object', properties: {
      label:        { type: 'string', description: 'Display label, e.g. "Company GST"' },
      key:          { type: 'string', description: 'Storage key (lowercase, underscores). Auto-generated from label if missing.' },
      field_type:   { type: 'string', description: 'text | number | dropdown | date | boolean. Default text.' },
      options:      { type: 'array', items: { type: 'string' }, description: 'For dropdown fields' },
      is_required:  { type: 'boolean' },
      show_in_list: { type: 'boolean' }
    }, required: ['label'] }
  },
  { name: 'set_tat_rule',
    description: "Set or update the TAT (turnaround time) threshold for a lead status. Use when admin says 'set TAT for X to N hours/minutes', 'change TAT of Follow Up to 24 hours'.",
    parameters: { type: 'object', properties: {
      status_name: { type: 'string' },
      minutes:     { type: 'number', description: 'Threshold in minutes. Use 60 for 1 hour, 1440 for 1 day.' },
      is_active:   { type: 'boolean', description: 'Whether the threshold is enabled. Default true.' }
    }, required: ['status_name', 'minutes'] }
  },
  { name: 'create_campaign',
    description: "Create a new campaign for organizing leads. Use when admin says 'create campaign', 'add campaign called X', 'new campaign for Meta leads'.",
    parameters: { type: 'object', properties: {
      name:              { type: 'string' },
      distribution_mode: { type: 'string', description: 'on_demand | round_robin | conditional. Default on_demand.' },
      manager_name:      { type: 'string', description: 'Manager user name. Optional.' }
    }, required: ['name'] }
  },
  { name: 'set_lead_followup',
    description: "Set a follow-up date for a specific lead. Use when admin says 'set follow-up for lead X to tomorrow', 'remind me about Amit on Friday', 'schedule follow-up with lead 42'.",
    parameters: { type: 'object', properties: {
      lead_id:    { type: 'number', description: 'Lead ID. Either lead_id OR lead_phone required.' },
      lead_phone: { type: 'string', description: 'Lead phone to match. Optional alternative to lead_id.' },
      due_at:     { type: 'string', description: 'ISO date or natural string like "2026-06-12 14:00". Required.' },
      note:       { type: 'string' }
    }, required: ['due_at'] }
  },
  { name: 'bulk_edit_custom_field',
    description: "BULK EDIT: set a custom field value on multiple EXISTING leads matching a filter. Use when admin says 'set Company GST to Pending for all Meta leads', 'mark Source Type as Direct for all New leads', 'bulk update custom field X to Y'. Acts on existing leads NOW.",
    parameters: { type: 'object', properties: {
      cf_key:        { type: 'string', description: 'Custom field key (the storage key, e.g. company_gst).' },
      cf_value:      { type: 'string', description: 'New value to set.' },
      filter_status: { type: 'string' },
      filter_source: { type: 'string' },
      filter_from:   { type: 'string' },
      filter_to:     { type: 'string' }
    }, required: ['cf_key', 'cf_value'] }
  },
  { name: 'bulk_add_tag',
    description: "BULK ACTION: add a tag to multiple EXISTING leads matching a filter. Use when admin says 'tag all Meta leads as hot', 'add tag VIP to all leads from Pallabhi', 'mark these as priority'. Tag must already exist in tag library.",
    parameters: { type: 'object', properties: {
      tag_name:      { type: 'string', description: 'Tag to add (e.g. hot, vip, priority). Case-insensitive.' },
      filter_status: { type: 'string' },
      filter_source: { type: 'string' },
      filter_owner:  { type: 'string', description: 'Lead owner name to filter by.' },
      filter_from:   { type: 'string' },
      filter_to:     { type: 'string' }
    }, required: ['tag_name'] }
  },
  { name: 'bulk_assign_campaign',
    description: "BULK ACTION: assign multiple EXISTING leads to a campaign. Use when admin says 'add all New Meta leads to campaign Q3 push', 'put these leads in campaign X', 'attach all unassigned leads to campaign Meta Drive'.",
    parameters: { type: 'object', properties: {
      campaign_name: { type: 'string' },
      filter_status: { type: 'string' },
      filter_source: { type: 'string' },
      filter_owner:  { type: 'string' },
      filter_from:   { type: 'string' },
      filter_to:     { type: 'string' }
    }, required: ['campaign_name'] }
  }

];

// ---- Helpers --------------------------------------------------------
function _todayBounds() {
  const now = new Date();
  const offsetMs = 5.5 * 3600 * 1000;
  const local = new Date(now.getTime() + offsetMs);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, d) - offsetMs);
  const endUtc   = new Date(Date.UTC(y, m, d + 1) - offsetMs);
  return { from: startUtc.toISOString(), to: endUtc.toISOString() };
}

function _resolveBounds(args, opts) {
  const a = args || {};
  const o = opts || {};
  if (a.from || a.to) {
    return {
      from: a.from ? new Date(a.from).toISOString() : new Date(0).toISOString(),
      to:   a.to   ? new Date(new Date(a.to).getTime() + 24*3600*1000).toISOString() : new Date().toISOString(),
      explicit: true
    };
  }
  if (o.defaultDays) {
    return {
      from: new Date(Date.now() - o.defaultDays * 86400 * 1000).toISOString(),
      to:   new Date().toISOString(),
      explicit: false
    };
  }
  return {
    from: new Date(0).toISOString(),
    to:   new Date(Date.now() + 86400 * 1000).toISOString(),
    explicit: false
  };
}

async function _resolveStatusId(name) {
  if (!name) return null;
  try {
    const r = await db.query(`SELECT id FROM statuses WHERE LOWER(name) = LOWER($1) LIMIT 1`, [String(name)]);
    return r.rows[0]?.id || null;
  } catch (_) { return null; }
}
async function _resolveUserId(name) {
  if (!name) return null;
  try {
    const r = await db.query(
      `SELECT id FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1`, [String(name)]
    );
    return r.rows[0]?.id || null;
  } catch (_) { return null; }
}

// ---- CP_ACT_v1: action layer (vserve-only beta) ---------------------
const ACTION_TOOLS = new Set([
  'create_autoassign_rule',
  'reassign_leads_bulk',
  'create_status',
  'create_source',
  'create_user',
  'update_status',
  'change_lead_status_bulk',
  'create_product',
  'create_custom_field',
  'set_tat_rule',
  'create_campaign',
  'set_lead_followup',
  'bulk_edit_custom_field',
  'bulk_add_tag',
  'bulk_assign_campaign',
]);

async function _actionsEnabled() {
  try {
    const v = await db.getConfig('COPILOT_ACTIONS_ENABLED', '0');
    return String(v).trim() === '1';  // explicit; avoid empty-string trap
  } catch (_) { return false; }
}

function _newConfirmToken() {
  return 'cp_' + Date.now().toString(36) + '_' +
         Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 10);
}

async function _resolveUsersByName(names) {
  const out = [];
  for (const n of (Array.isArray(names) ? names : [])) {
    const s = String(n || '').trim();
    if (!s) continue;
    try {
      const r = await db.query(
        `SELECT id, name FROM users
          WHERE LOWER(name) = LOWER($1)
             OR LOWER(name) LIKE LOWER($1) || ' %'
             OR LOWER(email) = LOWER($1)
          ORDER BY (CASE WHEN LOWER(name) = LOWER($1) THEN 0 ELSE 1 END)
          LIMIT 1`,
        [s]
      );
      if (r.rows[0]) out.push({ id: r.rows[0].id, name: r.rows[0].name, asked: s });
      else out.push({ id: null, name: null, asked: s });
    } catch (_) { out.push({ id: null, name: null, asked: s }); }
  }
  return out;
}

async function _buildPreview(toolName, args, ctx) {
  const a = args || {};
  let title = '', rows = [], explain = '';

  if (toolName === 'create_autoassign_rule') {
    const assignees = await _resolveUsersByName(a.assignees);
    const known     = assignees.filter(u => u.id);
    const unknown   = assignees.filter(u => !u.id).map(u => u.asked);
    const dist      = (a.distribution || 'round_robin').toLowerCase();
    const scope     = (a.scope || 'future').toLowerCase();
    title = 'New auto-assign rule';
    rows = [
      { label: 'Rule name',    value: a.name || '(unnamed)' },
      { label: 'When',         value: [
          a.when_source ? 'source = ' + a.when_source : null,
          a.when_status ? 'status = ' + a.when_status : null,
        ].filter(Boolean).join(' AND ') || 'any incoming lead' },
      { label: 'Assign to',    value: known.length ? known.map(u => u.name).join(', ') : '(no matching users found)' },
      { label: 'Distribution', value: dist.replace('_', ' ') },
      { label: 'Applies to',   value: scope === 'both' ? 'new leads + existing matching leads' :
                                       scope === 'existing' ? 'existing matching leads only' :
                                       'new leads going forward' },
    ];
    if (unknown.length) rows.push({ label: 'Not found', value: unknown.join(', ') + ' - check spelling' });
    explain = 'Got it. Here is the rule I will create:';
  }
  else if (toolName === 'reassign_leads_bulk') {
    const assignees = await _resolveUsersByName(a.assignees);
    const known     = assignees.filter(u => u.id);
    const params = [];
    let where = '1=1';
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_from) { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)   { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    let count = 0;
    try {
      const r = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE ${where}`, params);
      count = Number(r.rows[0]?.c || 0);
    } catch (_) {}
    title = 'Reassign existing leads';
    rows = [
      { label: 'Matches',      value: count.toLocaleString('en-IN') + ' lead(s)' },
      { label: 'Filter',       value: [
          a.filter_source ? 'source = ' + a.filter_source : null,
          a.filter_status ? 'status = ' + a.filter_status : null,
          a.filter_from   ? 'from ' + a.filter_from : null,
          a.filter_to     ? 'to ' + a.filter_to : null,
        ].filter(Boolean).join(' / ') || 'ALL leads (no filter set)' },
      { label: 'Assign to',    value: known.length ? known.map(u => u.name).join(', ') : '(no matching users found)' },
      { label: 'Distribution', value: (a.distribution || 'round_robin').replace('_', ' ') },
    ];
    explain = count === 0
      ? 'No leads match those filters - nothing to reassign. Double-check the filter and try again.'
      : 'Got it. Here is the reassignment I will run:';
  }
  else if (toolName === 'create_status') {
    title = 'New lead status';
    rows = [
      { label: 'Name',     value: a.name || '(missing)' },
      { label: 'Color',    value: a.color || '#6b7280 (default grey)' },
      { label: 'Terminal', value: a.is_final ? 'Yes - counts as Won/Lost-style' : 'No' },
    ];
    explain = 'Got it. Here is the status I will add:';
  }
  else if (toolName === 'create_source') {
    title = 'New lead source';
    rows = [{ label: 'Name', value: a.name || '(missing)' }];
    explain = 'Got it. Here is the source I will add:';
  }
  else if (toolName === 'create_user') {
    const role = String(a.role || 'sales').toLowerCase();
    title = 'New CRM user';
    rows = [
      { label: 'Name', value: a.name || '(missing)' },
      { label: 'Email', value: a.email || '(missing)' },
      { label: 'Role', value: role },
      { label: 'Phone', value: a.phone || '—' },
      { label: 'Department', value: a.department || '—' },
      { label: 'Designation', value: a.designation || '—' },
      { label: 'Password', value: 'auto-generated (shown after Confirm)' },
    ];
    explain = 'Got it. Here is the user I will add:';
  }
  else if (toolName === 'update_status') {
    const cur = String(a.current_name || '').trim();
    let existing = null;
    try {
      const r = await db.query(`SELECT id, name, color, is_final FROM statuses WHERE LOWER(name) = LOWER($1) LIMIT 1`, [cur]);
      existing = r.rows[0] || null;
    } catch (_) {}
    title = 'Update lead status';
    if (!existing) {
      rows = [{ label: 'Find', value: '⚠ No status named "' + cur + '" exists.' }];
    } else {
      rows = [
        { label: 'Current', value: existing.name + ' (id ' + existing.id + ')' },
        { label: 'Rename', value: a.new_name && a.new_name !== existing.name ? ('→ ' + a.new_name) : '(no change)' },
        { label: 'Color', value: a.color ? ('→ ' + a.color) : ('keep ' + (existing.color || '#6b7280')) },
        { label: 'Terminal', value: typeof a.is_final === 'boolean' ? ('→ ' + (a.is_final ? 'Yes' : 'No')) : ('keep ' + (Number(existing.is_final) ? 'Yes' : 'No')) },
      ];
    }
    explain = existing ? 'Got it. Here are the changes I will apply:' : 'No matching status found — please check the name.';
  }
  else if (toolName === 'change_lead_status_bulk') {
    const toName = String(a.to_status || '').trim();
    let toSid = null;
    try { toSid = await _resolveStatusId(toName); } catch (_) {}
    const params = [];
    let where = '1=1';
    if (a.from_status) {
      const fSid = await _resolveStatusId(a.from_status);
      if (fSid) { params.push(fSid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    let count = 0;
    try {
      const r = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE ${where}`, params);
      count = Number(r.rows[0]?.c || 0);
    } catch (_) {}
    title = 'Bulk change lead status';
    rows = [
      { label: 'Matches', value: count.toLocaleString('en-IN') + ' lead(s)' },
      { label: 'From filter', value: [
          a.from_status ? 'status = ' + a.from_status : null,
          a.filter_source ? 'source = ' + a.filter_source : null,
          a.filter_from ? 'from ' + a.filter_from : null,
          a.filter_to ? 'to ' + a.filter_to : null,
        ].filter(Boolean).join(' / ') || 'ALL leads' },
      { label: 'New status', value: toSid ? toName : ('⚠ "' + toName + '" does not exist as a status') },
    ];
    explain = (!toSid || count === 0)
      ? (!toSid ? 'Target status not found.' : 'No leads match — nothing to change.')
      : 'Got it. Here is the bulk update I will run:';
  }
  else if (toolName === 'create_product') {
    title = 'New product';
    rows = [
      { label: 'Name', value: a.name || '(missing)' },
      { label: 'Description', value: a.description || '—' },
      { label: 'Price', value: '₹' + (Number(a.price) || 0).toLocaleString('en-IN') },
      { label: 'GST', value: (Number(a.gst_pct) || 0) + '%' },
    ];
    explain = 'Got it. Here is the product I will add:';
  }
  else if (toolName === 'create_custom_field') {
    const label = String(a.label || '').trim();
    const key = String(a.key || label).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    title = 'New custom field';
    rows = [
      { label: 'Label', value: label || '(missing)' },
      { label: 'Key (storage)', value: key || '(invalid)' },
      { label: 'Type', value: a.field_type || 'text' },
      { label: 'Options', value: Array.isArray(a.options) && a.options.length ? a.options.join(' | ') : '—' },
      { label: 'Required', value: a.is_required ? 'Yes' : 'No' },
      { label: 'Show in list', value: a.show_in_list ? 'Yes' : 'No' },
    ];
    explain = 'Got it. Here is the custom field I will add:';
  }
  else if (toolName === 'set_tat_rule') {
    const sName = String(a.status_name || '').trim();
    let sid = null;
    try { sid = await _resolveStatusId(sName); } catch (_) {}
    const mins = Math.max(1, Number(a.minutes) || 0);
    const hours = (mins / 60).toFixed(1);
    title = 'Set TAT threshold';
    rows = [
      { label: 'Status', value: sid ? sName : '⚠ "' + sName + '" not found' },
      { label: 'Threshold', value: mins + ' minutes (~' + hours + ' hours)' },
      { label: 'Active', value: (a.is_active === false) ? 'No' : 'Yes' },
    ];
    explain = sid ? 'Got it. Here is the TAT rule I will save:' : 'Status not found — please check the name.';
  }
  else if (toolName === 'create_campaign') {
    let mgrId = null, mgrName = null;
    if (a.manager_name) {
      const [u] = await _resolveUsersByName([a.manager_name]);
      if (u && u.id) { mgrId = u.id; mgrName = u.name; }
    }
    title = 'New campaign';
    rows = [
      { label: 'Name', value: a.name || '(missing)' },
      { label: 'Distribution', value: (a.distribution_mode || 'on_demand').replace('_', ' ') },
      { label: 'Manager', value: mgrName || (a.manager_name ? '⚠ "' + a.manager_name + '" not found' : '— (none)') },
    ];
    explain = 'Got it. Here is the campaign I will create:';
  }
  else if (toolName === 'set_lead_followup') {
    let lead = null;
    if (a.lead_id) {
      try { const r = await db.query(`SELECT id, name, phone FROM leads WHERE id = $1 LIMIT 1`, [Number(a.lead_id)]); lead = r.rows[0] || null; } catch (_) {}
    } else if (a.lead_phone) {
      try { const r = await db.query(`SELECT id, name, phone FROM leads WHERE phone LIKE '%' || $1 || '%' LIMIT 1`, [String(a.lead_phone).replace(/\D/g, '').slice(-10)]); lead = r.rows[0] || null; } catch (_) {}
    }
    let due = null;
    try { due = new Date(a.due_at); if (isNaN(due.getTime())) due = null; } catch (_) {}
    title = 'Set follow-up reminder';
    rows = [
      { label: 'Lead', value: lead ? (lead.name + ' · ' + lead.phone + ' (id ' + lead.id + ')') : '⚠ Lead not found' },
      { label: 'Due', value: due ? due.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '⚠ Invalid date "' + a.due_at + '"' },
      { label: 'Note', value: a.note || '—' },
    ];
    explain = (lead && due) ? 'Got it. Here is the follow-up I will schedule:' : 'Missing required info — please retry.';
  }
  else if (toolName === 'bulk_edit_custom_field') {
    const params = []; let where = '1=1';
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    let count = 0;
    try { const r = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE ${where}`, params); count = Number(r.rows[0]?.c || 0); } catch (_) {}
    const key = String(a.cf_key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    title = 'Bulk edit custom field';
    rows = [
      { label: 'Matches', value: count.toLocaleString('en-IN') + ' lead(s)' },
      { label: 'Filter', value: [
          a.filter_status ? 'status = ' + a.filter_status : null,
          a.filter_source ? 'source = ' + a.filter_source : null,
          a.filter_from ? 'from ' + a.filter_from : null,
          a.filter_to ? 'to ' + a.filter_to : null,
        ].filter(Boolean).join(' / ') || 'ALL leads' },
      { label: 'Field', value: key || '(missing)' },
      { label: 'New value', value: a.cf_value || '(empty)' },
    ];
    explain = (count === 0) ? 'No leads match — nothing to update.' : 'Got it. Here is the bulk custom-field edit I will run:';
  }
  else if (toolName === 'bulk_add_tag') {
    const params = []; let where = '1=1';
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_owner) {
      const [u] = await _resolveUsersByName([a.filter_owner]);
      if (u && u.id) { params.push(u.id); where += ` AND assigned_to = $${params.length}`; }
    }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    let count = 0;
    try { const r = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE ${where}`, params); count = Number(r.rows[0]?.c || 0); } catch (_) {}
    const tagName = String(a.tag_name || '').trim();
    let tagExists = false;
    try { const r = await db.query(`SELECT 1 FROM tag_library WHERE LOWER(name) = LOWER($1) LIMIT 1`, [tagName]); tagExists = r.rowCount > 0; } catch (_) {}
    title = 'Bulk add tag';
    rows = [
      { label: 'Matches', value: count.toLocaleString('en-IN') + ' lead(s)' },
      { label: 'Filter', value: [
          a.filter_status ? 'status = ' + a.filter_status : null,
          a.filter_source ? 'source = ' + a.filter_source : null,
          a.filter_owner ? 'owner = ' + a.filter_owner : null,
          a.filter_from ? 'from ' + a.filter_from : null,
          a.filter_to ? 'to ' + a.filter_to : null,
        ].filter(Boolean).join(' / ') || 'ALL leads' },
      { label: 'Tag', value: tagExists ? tagName : ('⚠ "' + tagName + '" not in tag library — add it to Settings → Tags first') },
    ];
    explain = (!tagExists || count === 0) ? (!tagExists ? 'Tag not found in library.' : 'No leads match — nothing to tag.') : 'Got it. Here is the bulk tag action I will run:';
  }
  else if (toolName === 'bulk_assign_campaign') {
    let campId = null, campName = null;
    try {
      const r = await db.query(`SELECT id, name FROM campaigns WHERE LOWER(name) = LOWER($1) LIMIT 1`, [String(a.campaign_name || '').trim()]);
      if (r.rows[0]) { campId = r.rows[0].id; campName = r.rows[0].name; }
    } catch (_) {}
    const params = []; let where = '1=1';
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_owner) {
      const [u] = await _resolveUsersByName([a.filter_owner]);
      if (u && u.id) { params.push(u.id); where += ` AND assigned_to = $${params.length}`; }
    }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    let count = 0;
    try { const r = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE ${where}`, params); count = Number(r.rows[0]?.c || 0); } catch (_) {}
    title = 'Bulk assign to campaign';
    rows = [
      { label: 'Matches', value: count.toLocaleString('en-IN') + ' lead(s)' },
      { label: 'Filter', value: [
          a.filter_status ? 'status = ' + a.filter_status : null,
          a.filter_source ? 'source = ' + a.filter_source : null,
          a.filter_owner ? 'owner = ' + a.filter_owner : null,
          a.filter_from ? 'from ' + a.filter_from : null,
          a.filter_to ? 'to ' + a.filter_to : null,
        ].filter(Boolean).join(' / ') || 'ALL leads' },
      { label: 'Campaign', value: campId ? (campName + ' (#' + campId + ')') : ('⚠ "' + a.campaign_name + '" not found') },
    ];
    explain = (!campId || count === 0) ? (!campId ? 'Campaign not found.' : 'No leads match — nothing to assign.') : 'Got it. Here is the bulk campaign assignment I will run:';
  }
  else {
    return { _refuse: 'Unknown action tool: ' + toolName };
  }

  const token = _newConfirmToken();
  const card = { title, rows };
  try {
    await db.query(
      `INSERT INTO copilot_actions
         (confirm_token, user_id, tool_name, args_json, preview_text, preview_card, state)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, 'pending')`,
      [ token, ctx.userId, toolName, JSON.stringify(a), explain, JSON.stringify(card) ]
    );
  } catch (e) {
    return { _refuse: 'Could not stage action: ' + e.message };
  }

  return { _preview: true, confirm_token: token, title, rows, explain, expires_in_minutes: 15 };
}

async function _runActionTool(name, args, ctx) {
  if (!await _actionsEnabled()) {
    return { _refuse: 'Copilot write actions are in beta and not yet enabled for this tenant. Contact support to opt in.' };
  }
  // CP_ACT_v1 SECURITY: admin-only — Copilot write actions touch tenant
  // config (rules, statuses, sources, bulk lead reassignment). Sales and
  // manager users get a polite refuse so they can't escalate via Copilot.
  if (ctx.userRole !== 'admin') {
    return { _refuse: 'This change can only be made by an admin. Please ask an admin to do it for you.' };
  }
  return _buildPreview(name, args, ctx);
}

async function _executePendingAction(row, ctx) {
  const tool = row.tool_name;
  const a    = row.args_json || {};

  if (tool === 'create_autoassign_rule') {
    // SCHEMA_FIX_v1: real lead-routing table is `assignment_rules`
    // (single-condition: field/operator/value/assigned_to/priority).
    // The SPA's Settings -> Auto-Assign Rules tab reads from THIS table,
    // not the ghost `auto_assign_rules` we used earlier.
    const assignees = await _resolveUsersByName(a.assignees);
    const ids       = assignees.filter(u => u.id).map(u => u.id);
    if (!ids.length) throw new Error('No valid assignees');
    // Pick the primary condition. Schema only supports ONE field/op/value
    // per rule — multi-condition would need a separate rule per condition.
    let field, operator, value;
    if (a.when_source)      { field = 'source'; operator = 'contains'; value = String(a.when_source); }
    else if (a.when_status) { field = 'status'; operator = 'equals';   value = String(a.when_status); }
    else                    { field = 'name';   operator = 'is_not_empty'; value = ''; }
    const payload = {
      name: a.name || 'Untitled rule',
      field, operator, value,
      assigned_to: ids.join(','),
      priority: 100,
      is_active: 1
    };
    const id = await db.insert('assignment_rules', payload);
    const names = assignees.filter(u => u.id).map(u => u.name).join(' / ');
    return {
      ok: true,
      rule_id: id,
      message: 'Rule active. Matching leads route to ' + names + ' (round-robin if multiple).'
    };
  }

  if (tool === 'reassign_leads_bulk') {
    const assignees = await _resolveUsersByName(a.assignees);
    const ids       = assignees.filter(u => u.id).map(u => u.id);
    if (!ids.length) throw new Error('No valid assignees');
    const params = [];
    let where = '1=1';
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_from) { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)   { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    const targets = await db.query(`SELECT id FROM leads WHERE ${where} ORDER BY created_at ASC`, params);
    let i = 0;
    const counts = ids.map(() => 0);
    for (const lead of targets.rows) {
      const target = ids[i % ids.length];
      await db.query(`UPDATE leads SET assigned_to = $1 WHERE id = $2`, [target, lead.id]);
      counts[i % ids.length]++;
      i++;
    }
    const summary = assignees.filter(u => u.id).map((u, k) => u.name + ': ' + counts[k]).join(', ');
    return { ok: true, reassigned: i, message: 'Reassigned ' + i + ' lead(s) - ' + summary };
  }

  if (tool === 'create_status') {
    const name = String(a.name || '').trim();
    if (!name) throw new Error('Name required');
    // Use same payload shape as api_statuses_save so the SPA list-render matches.
    let nextSort = 10;
    try { const r = await db.query('SELECT COALESCE(MAX(sort_order),0)+10 AS s FROM statuses'); nextSort = Number(r.rows[0]?.s) || 10; } catch (_) {}
    const id = await db.insert('statuses', {
      name,
      color: a.color || '#6b7280',
      sort_order: nextSort,
      is_final: a.is_final ? 1 : 0
    });
    return { ok: true, status_id: id, message: 'Status "' + name + '" added.' };
  }

  if (tool === 'create_source') {
    const name = String(a.name || '').trim();
    if (!name) throw new Error('Name required');
    // Match api_sources_save payload so the SPA list shows it correctly.
    let nextSort = 0;
    try { const r = await db.query('SELECT COALESCE(MAX(sort_order),0)+10 AS s FROM sources'); nextSort = Number(r.rows[0]?.s) || 0; } catch (_) {}
    // Reactivate if already exists (soft-deleted)
    try {
      const existing = await db.findOneBy('sources', 'name', name);
      if (existing) {
        await db.update('sources', existing.id, { is_active: 1 });
        return { ok: true, source_id: existing.id, message: 'Source "' + name + '" reactivated.' };
      }
    } catch (_) {}
    const id = await db.insert('sources', {
      name, color: '#6b7280', sort_order: nextSort, is_active: 1
    });
    return { ok: true, source_id: id, message: 'Source "' + name + '" added.' };
  }

  if (tool === 'create_user') {
    const name = String(a.name || '').trim();
    const email = String(a.email || '').toLowerCase().trim();
    const role = String(a.role || 'sales').toLowerCase();
    if (!name || !email) throw new Error('Name and email required');
    if (!['admin', 'manager', 'sales'].includes(role)) throw new Error('Role must be admin / manager / sales');
    if (await db.findOneBy('users', 'email', email)) throw new Error('Email already registered');
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let pw = '';
    for (let i = 0; i < 12; i++) pw += alpha[Math.floor(Math.random() * alpha.length)];
    const id = await db.insert('users', {
      name, email, phone: a.phone || '',
      password_hash: hashPassword(pw), role,
      parent_id: ctx.userId,
      department: a.department || '',
      designation: a.designation || '',
      is_active: 1
    });
    return { ok: true, user_id: id,
      message: 'User "' + name + '" created.\n\nLogin email: ' + email + '\nTemporary password: ' + pw + '\n\nShare this password securely. The user can change it after first login.' };
  }

  if (tool === 'update_status') {
    const cur = String(a.current_name || '').trim();
    const r = await db.query(`SELECT id, name, color, is_final FROM statuses WHERE LOWER(name) = LOWER($1) LIMIT 1`, [cur]);
    const existing = r.rows[0];
    if (!existing) throw new Error('Status "' + cur + '" not found');
    const patch = {};
    if (a.new_name && a.new_name !== existing.name) patch.name = String(a.new_name).trim();
    if (a.color) patch.color = String(a.color);
    if (typeof a.is_final === 'boolean') patch.is_final = a.is_final ? 1 : 0;
    if (!Object.keys(patch).length) return { ok: true, status_id: existing.id, message: 'No changes to apply.' };
    await db.update('statuses', existing.id, patch);
    return { ok: true, status_id: existing.id, message: 'Status updated: ' + Object.keys(patch).map(k => k + '=' + patch[k]).join(', ') + '.' };
  }

  if (tool === 'change_lead_status_bulk') {
    const toName = String(a.to_status || '').trim();
    const toSid = await _resolveStatusId(toName);
    if (!toSid) throw new Error('Target status "' + toName + '" not found');
    const params = [toSid];
    let where = '1=1';
    if (a.from_status) {
      const fSid = await _resolveStatusId(a.from_status);
      if (fSid) { params.push(fSid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    const r = await db.query(`UPDATE leads SET status_id = $1, last_status_change_at = NOW() WHERE ${where} RETURNING id`, params);
    return { ok: true, updated: r.rowCount, message: 'Status changed for ' + r.rowCount + ' lead(s) → ' + toName + '.' };
  }

  if (tool === 'create_product') {
    const name = String(a.name || '').trim();
    if (!name) throw new Error('Name required');
    const id = await db.insert('products', {
      name,
      description: a.description || '',
      price: Number(a.price) || 0,
      gst_pct: Math.max(0, Math.min(100, Number(a.gst_pct) || 0)),
      is_active: 1
    });
    return { ok: true, product_id: id, message: 'Product "' + name + '" added.' };
  }

  if (tool === 'create_custom_field') {
    const label = String(a.label || '').trim();
    if (!label) throw new Error('Label required');
    const key = String(a.key || label).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    if (!key) throw new Error('Could not derive valid key');
    if (await db.findOneBy('custom_fields', 'key', key)) throw new Error('Field key already exists: ' + key);
    const id = await db.insert('custom_fields', {
      key, label,
      field_type: a.field_type || 'text',
      options: Array.isArray(a.options) ? a.options.join('|') : '',
      sort_order: 0,
      show_in_list: a.show_in_list ? 1 : 0,
      is_required: a.is_required ? 1 : 0,
      is_active: 1
    });
    return { ok: true, field_id: id, message: 'Custom field "' + label + '" (key: ' + key + ') added.' };
  }

  if (tool === 'set_tat_rule') {
    const sName = String(a.status_name || '').trim();
    const sid = await _resolveStatusId(sName);
    if (!sid) throw new Error('Status "' + sName + '" not found');
    const minutes = Math.max(1, Number(a.minutes) || 60);
    const isAct = (a.is_active === false) ? 0 : 1;
    const existing = (await db.getAll('tat_thresholds')).find(r => Number(r.status_id) === sid);
    if (existing) {
      await db.update('tat_thresholds', existing.id, { threshold_minutes: minutes, is_active: isAct, updated_at: db.nowIso() });
      return { ok: true, threshold_id: existing.id, message: 'TAT for "' + sName + '" updated to ' + minutes + ' minutes.' };
    }
    const id = await db.insert('tat_thresholds', { status_id: sid, threshold_minutes: minutes, is_active: isAct, updated_at: db.nowIso() });
    return { ok: true, threshold_id: id, message: 'TAT rule created: "' + sName + '" → ' + minutes + ' minutes.' };
  }

  if (tool === 'create_campaign') {
    const name = String(a.name || '').trim();
    if (!name) throw new Error('Name required');
    let mgrId = null;
    if (a.manager_name) {
      const [u] = await _resolveUsersByName([a.manager_name]);
      if (u && u.id) mgrId = u.id;
    }
    const id = await db.insert('campaigns', {
      name,
      distribution_mode: a.distribution_mode || 'on_demand',
      manager_user_id: mgrId,
      is_active: 1
    });
    return { ok: true, campaign_id: id, message: 'Campaign "' + name + '" created.' };
  }

  if (tool === 'set_lead_followup') {
    let leadId = a.lead_id ? Number(a.lead_id) : null;
    if (!leadId && a.lead_phone) {
      const r = await db.query(`SELECT id FROM leads WHERE phone LIKE '%' || $1 || '%' LIMIT 1`, [String(a.lead_phone).replace(/\D/g, '').slice(-10)]);
      leadId = r.rows[0]?.id || null;
    }
    if (!leadId) throw new Error('Lead not found — provide lead_id or lead_phone');
    const due = new Date(a.due_at);
    if (isNaN(due.getTime())) throw new Error('Invalid due date');
    // Clear any other pending followups (lead-level convention)
    const existing = (await db.getAll('followups')).filter(f =>
      Number(f.lead_id) === leadId && Number(f.is_done) === 0);
    for (const f of existing) {
      await db.update('followups', f.id, { is_done: 1, done_at: db.nowIso() });
    }
    const id = await db.insert('followups', {
      lead_id: leadId,
      user_id: ctx.userId,
      due_at: due.toISOString(),
      note: a.note || '',
      is_done: 0
    });
    await db.query(`UPDATE leads SET next_followup_at = $1 WHERE id = $2`, [due.toISOString(), leadId]);
    return { ok: true, followup_id: id, message: 'Follow-up scheduled for lead #' + leadId + ' on ' + due.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + '.' };
  }

  if (tool === 'bulk_edit_custom_field') {
    const key = String(a.cf_key || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key) throw new Error('cf_key required');
    const params = []; let where = '1=1';
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    const lr = await db.query(`SELECT id, extra_json FROM leads WHERE ${where}`, params);
    let n = 0;
    for (const ld of lr.rows) {
      let curr = {};
      try { curr = ld.extra_json ? JSON.parse(ld.extra_json) : {}; } catch (_) {}
      curr[key] = String(a.cf_value == null ? '' : a.cf_value);
      await db.update('leads', ld.id, { extra_json: JSON.stringify(curr) });
      n++;
    }
    return { ok: true, updated: n, message: 'Custom field "' + key + '" set to "' + a.cf_value + '" on ' + n + ' lead(s).' };
  }

  if (tool === 'bulk_add_tag') {
    const tagName = String(a.tag_name || '').trim();
    if (!tagName) throw new Error('tag_name required');
    const tr = await db.query(`SELECT name FROM tag_library WHERE LOWER(name) = LOWER($1) LIMIT 1`, [tagName]);
    if (!tr.rows[0]) throw new Error('Tag "' + tagName + '" not found. Add it under Settings → Tags first.');
    const canonical = tr.rows[0].name;
    const params = []; let where = '1=1';
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_owner) {
      const [u] = await _resolveUsersByName([a.filter_owner]);
      if (u && u.id) { params.push(u.id); where += ` AND assigned_to = $${params.length}`; }
    }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    const lr = await db.query(`SELECT id, tags FROM leads WHERE ${where}`, params);
    let n = 0;
    for (const ld of lr.rows) {
      const existing = String(ld.tags || '').split(',').map(t => t.trim()).filter(Boolean);
      if (existing.some(t => t.toLowerCase() === canonical.toLowerCase())) continue;
      existing.push(canonical);
      await db.update('leads', ld.id, { tags: existing.join(',') });
      n++;
    }
    return { ok: true, tagged: n, message: 'Tag "' + canonical + '" added to ' + n + ' lead(s) (skipped any that already had it).' };
  }

  if (tool === 'bulk_assign_campaign') {
    const cr = await db.query(`SELECT id, name FROM campaigns WHERE LOWER(name) = LOWER($1) LIMIT 1`, [String(a.campaign_name || '').trim()]);
    if (!cr.rows[0]) throw new Error('Campaign "' + a.campaign_name + '" not found');
    const campId = cr.rows[0].id;
    const params = [campId]; let where = '1=1';
    if (a.filter_status) {
      const sid = await _resolveStatusId(a.filter_status);
      if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
    }
    if (a.filter_source) { params.push(a.filter_source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
    if (a.filter_owner) {
      const [u] = await _resolveUsersByName([a.filter_owner]);
      if (u && u.id) { params.push(u.id); where += ` AND assigned_to = $${params.length}`; }
    }
    if (a.filter_from)   { params.push(new Date(a.filter_from).toISOString()); where += ` AND created_at >= $${params.length}`; }
    if (a.filter_to)     { params.push(new Date(new Date(a.filter_to).getTime() + 86400000).toISOString()); where += ` AND created_at < $${params.length}`; }
    const r = await db.query(`UPDATE leads SET campaign_id = $1 WHERE ${where} RETURNING id`, params);
    return { ok: true, assigned: r.rowCount, message: r.rowCount + ' lead(s) assigned to campaign "' + cr.rows[0].name + '".' };
  }

  throw new Error('Unknown tool: ' + tool);
}

// ---- Tool dispatcher ------------------------------------------------
async function _runTool(name, args, ctx) {
  // CP_ACT_v1: route action tools to preview-only dispatcher
  if (ACTION_TOOLS.has(name)) {
    return _runActionTool(name, args || {}, ctx);
  }
  switch (name) {
    case 'lookup_setup_guide': {
      const q = String((args && args.query) || '').trim();
      if (!q) return { results: [], note: 'No query provided.' };
      const hits = setupGuide.lookup(q, 3);
      if (!hits.length) {
        return { results: [], note: "No matching guide section. Tell the user that and offer to email support@smartcrmsolution.com or browse https://crm.smartcrmsolution.com/saas/help/" };
      }
      return {
        results: hits.map(h => ({ section_id: h.id, title: h.title, url: h.url, content: h.body })),
        note: 'Cite the section title and include the URL in the answer so the user can read the full guide.'
      };
    }
    // ---- LEADS ---------------------------------------------------
    case 'count_leads': {
      const r = _resolveBounds(args);
      const params = [r.from, r.to];
      let where = `created_at >= $1 AND created_at < $2`;
      if (args.status) {
        const sid = await _resolveStatusId(args.status);
        if (sid) { params.push(sid); where += ` AND status_id = $${params.length}`; }
      }
      if (args.source) { params.push(args.source); where += ` AND LOWER(source) = LOWER($${params.length})`; }
      if (args.assigned_to) {
        const uid = await _resolveUserId(args.assigned_to);
        if (uid) { params.push(uid); where += ` AND assigned_to = $${params.length}`; }
      }
      const q = await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE ${where}`, params);
      return { count: Number(q.rows[0]?.c || 0), filters_used: args, period: r };
    }
    case 'list_leads': {
      const r = _resolveBounds(args);
      const limit = Math.max(1, Math.min(20, Number(args.limit || 5)));
      const params = [r.from, r.to];
      let where = `l.created_at >= $1 AND l.created_at < $2`;
      if (args.status) {
        const sid = await _resolveStatusId(args.status);
        if (sid) { params.push(sid); where += ` AND l.status_id = $${params.length}`; }
      }
      if (args.source) { params.push(args.source); where += ` AND LOWER(l.source) = LOWER($${params.length})`; }
      if (args.assigned_to) {
        const uid = await _resolveUserId(args.assigned_to);
        if (uid) { params.push(uid); where += ` AND l.assigned_to = $${params.length}`; }
      }
      params.push(limit);
      const q = await db.query(
        `SELECT l.id, l.name, l.phone, l.email, l.company, l.source, l.value, l.created_at,
                s.name AS status_name, u.name AS assignee_name
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
           LEFT JOIN users u   ON u.id = l.assigned_to
          WHERE ${where}
          ORDER BY l.created_at DESC
          LIMIT $${params.length}`,
        params
      );
      return { rows: q.rows, count_returned: q.rows.length };
    }
    case 'list_hot_leads': {
      const limit = Math.max(1, Math.min(25, Number(args.limit || 10)));
      const params = [];
      let where = `(l.heat_score IS NOT NULL AND l.heat_score > 0)`;
      const minScore = Number(args.min_score || 1);
      if (Number.isFinite(minScore) && minScore > 0) {
        params.push(minScore); where += ` AND l.heat_score >= $${params.length}`;
      }
      if (args.level) {
        params.push(String(args.level).toLowerCase());
        where += ` AND LOWER(l.heat_label) = $${params.length}`;
      }
      if (args.assigned_to) {
        const uid = await _resolveUserId(args.assigned_to);
        if (uid) { params.push(uid); where += ` AND l.assigned_to = $${params.length}`; }
      }
      params.push(limit);
      let q;
      try {
        q = await db.query(
          `SELECT l.id, l.name, l.phone, l.email, l.source, l.value, l.heat_score, l.heat_label,
                  l.heat_signal, l.created_at,
                  s.name AS status_name, u.name AS assignee_name
             FROM leads l
             LEFT JOIN statuses s ON s.id = l.status_id
             LEFT JOIN users u   ON u.id = l.assigned_to
            WHERE ${where}
            ORDER BY l.heat_score DESC, l.created_at DESC
            LIMIT $${params.length}`,
          params
        );
      } catch (e) {
        // heat_* columns might not exist on un-migrated tenants
        return { rows: [], count_returned: 0,
                 note: 'AI heat detection not migrated on this tenant yet — open Settings → AI Bot to enable.' };
      }
      return { rows: q.rows, count_returned: q.rows.length };
    }
    case 'search_leads': {
      const q = String(args.q || '').trim();
      if (!q) return { rows: [], count_returned: 0 };
      const limit = Math.max(1, Math.min(25, Number(args.limit || 10)));
      const like = '%' + q.toLowerCase() + '%';
      const digits = q.replace(/\D/g, '');
      const r = await db.query(
        `SELECT l.id, l.name, l.phone, l.email, l.company, l.source, l.value,
                s.name AS status_name, u.name AS assignee_name, l.created_at
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
           LEFT JOIN users u   ON u.id = l.assigned_to
          WHERE LOWER(l.name)    LIKE $1
             OR LOWER(l.email)   LIKE $1
             OR LOWER(l.company) LIKE $1
             OR regexp_replace(COALESCE(l.phone, ''),    '\\D', '', 'g') LIKE $2
             OR regexp_replace(COALESCE(l.whatsapp, ''), '\\D', '', 'g') LIKE $2
          ORDER BY l.created_at DESC
          LIMIT $3`,
        [like, '%' + (digits || '___') + '%', limit]
      );
      return { rows: r.rows, count_returned: r.rows.length, query: q };
    }
    case 'get_lead_detail': {
      let leadId = Number(args.lead_id) || null;
      if (!leadId && (args.name || args.phone)) {
        const params = [];
        const conds = [];
        if (args.name)  { params.push('%' + String(args.name).toLowerCase() + '%'); conds.push(`LOWER(name) LIKE $${params.length}`); }
        if (args.phone) { params.push('%' + String(args.phone).replace(/\D/g, '') + '%'); conds.push(`regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') LIKE $${params.length}`); }
        if (conds.length) {
          const r = await db.query(`SELECT id FROM leads WHERE ${conds.join(' OR ')} ORDER BY created_at DESC LIMIT 1`, params);
          leadId = r.rows[0]?.id || null;
        }
      }
      if (!leadId) return { error: 'Lead not found — provide lead_id or name/phone' };
      const lead = (await db.query(
        `SELECT l.*, s.name AS status_name, u.name AS assignee_name
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
           LEFT JOIN users u   ON u.id = l.assigned_to
          WHERE l.id = $1 LIMIT 1`, [leadId]
      )).rows[0];
      if (!lead) return { error: 'Lead not found' };
      const remarks = (await db.query(
        `SELECT r.remark, r.created_at, u.name AS user_name
           FROM remarks r LEFT JOIN users u ON u.id = r.user_id
          WHERE r.lead_id = $1 ORDER BY r.created_at DESC LIMIT 5`, [leadId]
      )).rows;
      const followups = (await db.query(
        `SELECT id, due_at, note, is_done FROM followups WHERE lead_id = $1 ORDER BY due_at DESC LIMIT 5`, [leadId]
      ).catch(() => ({ rows: [] }))).rows;
      const recCount = Number((await db.query(
        `SELECT COUNT(*)::int AS c FROM lead_recordings WHERE lead_id = $1`, [leadId]
      ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0]?.c || 0);
      return {
        lead: {
          id: lead.id, name: lead.name, phone: lead.phone, email: lead.email,
          company: lead.company, city: lead.city, source: lead.source,
          status: lead.status_name, assignee: lead.assignee_name,
          value: lead.value, currency: lead.currency,
          created_at: lead.created_at, next_followup_at: lead.next_followup_at,
          tags: lead.tags, notes: lead.notes
        },
        recent_remarks: remarks,
        followups,
        recordings_count: recCount
      };
    }
    case 'lead_aging': {
      const limit = Math.max(1, Math.min(30, Number(args.limit || 10)));
      const minAge = Math.max(0, Number(args.min_age_days || 0));
      const r = await db.query(
        `SELECT l.id, l.name, l.phone, l.created_at, l.last_status_change_at,
                s.name AS status_name, u.name AS assignee_name,
                EXTRACT(DAY FROM NOW() - l.created_at)::int AS age_days
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
           LEFT JOIN users u   ON u.id = l.assigned_to
          WHERE COALESCE(s.is_final, 0) = 0
            AND l.created_at < NOW() - ($1 || ' days')::interval
          ORDER BY l.created_at ASC LIMIT $2`,
        [String(minAge), limit]
      );
      return { rows: r.rows, count_returned: r.rows.length, min_age_days: minAge };
    }

    // ---- REPORTS / KPIs -----------------------------------------
    case 'report_summary': {
      const r = _resolveBounds(args, { defaultDays: 30 });
      const total = (await db.query(
        `SELECT COUNT(*)::int AS c FROM leads WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]
      )).rows[0]?.c || 0;
      const byStatus = (await db.query(
        `SELECT s.name, COUNT(l.*)::int AS c FROM statuses s
           LEFT JOIN leads l ON l.status_id = s.id AND l.created_at >= $1 AND l.created_at < $2
           GROUP BY s.id, s.name, s.sort_order ORDER BY s.sort_order ASC NULLS LAST, s.name ASC`,
        [r.from, r.to]
      )).rows;
      const bySource = (await db.query(
        `SELECT COALESCE(source, '—') AS source, COUNT(*)::int AS c FROM leads
           WHERE created_at >= $1 AND created_at < $2 GROUP BY source ORDER BY c DESC LIMIT 10`,
        [r.from, r.to]
      )).rows;
      const won  = byStatus.find(s => /^won$/i.test(s.name))?.c || 0;
      const lost = byStatus.find(s => /^lost$/i.test(s.name))?.c || 0;
      return { total, won, lost, by_status: byStatus, by_source: bySource, period: r };
    }
    case 'pipeline_funnel': {
      const r = _resolveBounds(args);
      const q = (await db.query(
        `SELECT s.name, s.color, COUNT(l.*)::int AS c
           FROM statuses s
           LEFT JOIN leads l ON l.status_id = s.id AND l.created_at >= $1 AND l.created_at < $2
          GROUP BY s.id, s.name, s.color, s.sort_order
          ORDER BY s.sort_order ASC NULLS LAST`,
        [r.from, r.to]
      )).rows;
      return { stages: q, period: r };
    }
    case 'source_breakdown': {
      const r = _resolveBounds(args);
      const q = (await db.query(
        `SELECT COALESCE(l.source, 'Unknown') AS source,
                COUNT(*)::int AS leads,
                SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won,
                COALESCE(SUM(l.value), 0)::numeric AS total_value
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
          WHERE l.created_at >= $1 AND l.created_at < $2
          GROUP BY l.source
          ORDER BY leads DESC`,
        [r.from, r.to]
      )).rows;
      const enriched = q.map(row => ({
        ...row,
        conversion_pct: row.leads > 0 ? Math.round((row.won / row.leads) * 1000) / 10 : 0
      }));
      return { rows: enriched, period: r };
    }
    case 'conversion_rate': {
      const r = _resolveBounds(args);
      const groupBy = String(args.group_by || 'overall').toLowerCase();
      if (groupBy === 'source') {
        const rows = (await db.query(
          `SELECT COALESCE(l.source, 'Unknown') AS source,
                  COUNT(*)::int AS total,
                  SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won
             FROM leads l LEFT JOIN statuses s ON s.id = l.status_id
            WHERE l.created_at >= $1 AND l.created_at < $2
            GROUP BY l.source ORDER BY total DESC`, [r.from, r.to]
        )).rows.map(x => ({ ...x, rate_pct: x.total ? Math.round((x.won / x.total) * 1000) / 10 : 0 }));
        return { group_by: 'source', rows, period: r };
      }
      if (groupBy === 'assigned_to' || groupBy === 'rep') {
        const rows = (await db.query(
          `SELECT u.name AS user_name,
                  COUNT(l.*)::int AS total,
                  SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won
             FROM users u
             LEFT JOIN leads l ON l.assigned_to = u.id AND l.created_at >= $1 AND l.created_at < $2
             LEFT JOIN statuses s ON s.id = l.status_id
            WHERE u.is_active = 1
            GROUP BY u.id, u.name
            ORDER BY total DESC`, [r.from, r.to]
        )).rows.map(x => ({ ...x, rate_pct: x.total ? Math.round((x.won / x.total) * 1000) / 10 : 0 }));
        return { group_by: 'assigned_to', rows, period: r };
      }
      const total = (await db.query(
        `SELECT COUNT(*)::int AS c FROM leads WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]
      )).rows[0]?.c || 0;
      const won = (await db.query(
        `SELECT COUNT(*)::int AS c FROM leads l JOIN statuses s ON s.id = l.status_id
          WHERE s.name = 'Won' AND l.created_at >= $1 AND l.created_at < $2`, [r.from, r.to]
      )).rows[0]?.c || 0;
      return {
        group_by: 'overall',
        total, won,
        rate_pct: total ? Math.round((won / total) * 1000) / 10 : 0,
        period: r
      };
    }
    case 'employee_performance': {
      const r = _resolveBounds(args, { defaultDays: 30 });
      const q = (await db.query(
        `SELECT u.id, u.name,
           COUNT(l.*)::int AS total,
           SUM(CASE WHEN s.name = 'New' THEN 1 ELSE 0 END)::int AS new_leads,
           SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won,
           SUM(CASE WHEN s.name = 'Lost' THEN 1 ELSE 0 END)::int AS lost,
           SUM(CASE WHEN COALESCE(s.is_final, 0) = 0 THEN 1 ELSE 0 END)::int AS open
         FROM users u
         LEFT JOIN leads l ON l.assigned_to = u.id AND l.created_at >= $1 AND l.created_at < $2
         LEFT JOIN statuses s ON s.id = l.status_id
         WHERE u.is_active = 1
         GROUP BY u.id, u.name
         ORDER BY total DESC`, [r.from, r.to]
      )).rows;
      return { rows: q, period: r };
    }
    case 'leads_status_by_employee': {
      // Returns rows of { employee, status, count }. The LLM can format this
      // as a per-employee bullet list or a table.
      const r = _resolveBounds(args || {});
      const params = [];
      let where = '1=1';
      // Only constrain by date if user explicitly asked
      if (args && (args.from || args.to)) {
        params.push(r.from, r.to);
        where = `l.created_at >= $1 AND l.created_at < $2`;
      }
      if (args && args.assigned_to) {
        const uid = await _resolveUserId(args.assigned_to);
        if (uid) { params.push(uid); where += ` AND l.assigned_to = $${params.length}`; }
      }
      const q = await db.query(
        `SELECT COALESCE(u.name, '(unassigned)') AS employee,
                COALESCE(s.name, '(no status)') AS status,
                COUNT(*)::int AS count
           FROM leads l
           LEFT JOIN users u    ON u.id = l.assigned_to
           LEFT JOIN statuses s ON s.id = l.status_id
          WHERE ${where}
          GROUP BY employee, status
          ORDER BY employee ASC, count DESC`,
        params
      );
      return { rows: q.rows, count_returned: q.rows.length, period: (args && (args.from || args.to)) ? r : 'all-time' };
    }
    case 'top_performers': {
      const r = _resolveBounds(args, { defaultDays: 30 });
      const metric = String(args.metric || 'won').toLowerCase();
      const limit = Math.max(1, Math.min(20, Number(args.limit || 5)));
      let order = 'won DESC';
      if (metric === 'value')   order = 'total_value DESC';
      if (metric === 'remarks') order = 'remarks_count DESC';
      const rows = (await db.query(
        `SELECT u.id, u.name,
                COUNT(l.*)::int AS total,
                SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won,
                COALESCE(SUM(CASE WHEN s.name = 'Won' THEN l.value END), 0)::numeric AS total_value,
                (SELECT COUNT(*)::int FROM remarks r WHERE r.user_id = u.id AND r.created_at >= $1 AND r.created_at < $2) AS remarks_count
           FROM users u
           LEFT JOIN leads l ON l.assigned_to = u.id AND l.created_at >= $1 AND l.created_at < $2
           LEFT JOIN statuses s ON s.id = l.status_id
          WHERE u.is_active = 1
          GROUP BY u.id, u.name
          ORDER BY ${order}
          LIMIT $3`, [r.from, r.to, limit]
      )).rows;
      return { rows, metric, period: r };
    }

    // ---- TASKS / FOLLOW-UPS -------------------------------------
    case 'my_tasks_today': {
      const t = _todayBounds();
      const tasks = (await db.query(
        `SELECT id, title, due_at, is_done FROM tasks
          WHERE user_id = $1 AND COALESCE(is_done, 0) = 0
          ORDER BY due_at ASC NULLS LAST LIMIT 20`, [ctx.userId]
      ).catch(() => ({ rows: [] }))).rows;
      const followups = (await db.query(
        `SELECT f.id, f.due_at, f.note, l.id AS lead_id, l.name AS lead_name
           FROM followups f LEFT JOIN leads l ON l.id = f.lead_id
          WHERE f.user_id = $1 AND COALESCE(f.is_done, 0) = 0
            AND f.due_at >= $2 AND f.due_at < $3
          ORDER BY f.due_at ASC LIMIT 20`, [ctx.userId, t.from, t.to]
      ).catch(() => ({ rows: [] }))).rows;
      return { tasks, followups };
    }
    case 'followups_summary': {
      const t = _todayBounds();
      const params = [];
      let userClause = '';
      if (args.assigned_to) {
        const uid = await _resolveUserId(args.assigned_to);
        if (uid) { params.push(uid); userClause = ` AND f.user_id = $${params.length}`; }
      }
      const overdueParams = params.slice(); overdueParams.push(t.from);
      const overdue = Number((await db.query(
        `SELECT COUNT(*)::int AS c FROM followups f
          WHERE COALESCE(f.is_done, 0) = 0 AND f.due_at < $${overdueParams.length}${userClause}`,
        overdueParams
      ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0]?.c || 0);
      const todayParams = params.slice(); todayParams.push(t.from); todayParams.push(t.to);
      const today = Number((await db.query(
        `SELECT COUNT(*)::int AS c FROM followups f
          WHERE COALESCE(f.is_done, 0) = 0 AND f.due_at >= $${todayParams.length-1} AND f.due_at < $${todayParams.length}${userClause}`,
        todayParams
      ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0]?.c || 0);
      const upcomingParams = params.slice(); upcomingParams.push(t.to);
      const upcoming = Number((await db.query(
        `SELECT COUNT(*)::int AS c FROM followups f
          WHERE COALESCE(f.is_done, 0) = 0 AND f.due_at >= $${upcomingParams.length}${userClause}`,
        upcomingParams
      ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0]?.c || 0);
      const sample = (await db.query(
        `SELECT f.id, f.due_at, f.note, l.id AS lead_id, l.name AS lead_name, u.name AS user_name
           FROM followups f
           LEFT JOIN leads l ON l.id = f.lead_id
           LEFT JOIN users u ON u.id = f.user_id
          WHERE COALESCE(f.is_done, 0) = 0${userClause}
          ORDER BY f.due_at ASC LIMIT 10`, params
      ).catch(() => ({ rows: [] }))).rows;
      return { overdue, today, upcoming, sample };
    }

    // ---- CALLS / RECORDINGS -------------------------------------
    case 'todays_calls': {
      const t = _todayBounds();
      const q = (await db.query(
        `SELECT direction, event, phone, lead_id, duration_s, created_at FROM call_events
          WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 50`,
        [t.from, t.to]
      ).catch(() => ({ rows: [] }))).rows;
      const counts = q.reduce((a, x) => {
        const k = x.direction || 'unknown';
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {});
      return { counts, sample: q.slice(0, 10) };
    }
    case 'recordings_summary': {
      const r = _resolveBounds(args);
      const total = Number((await db.query(
        `SELECT COUNT(*)::int AS c FROM lead_recordings WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to]
      ).catch(() => ({ rows: [{ c: 0 }] }))).rows[0]?.c || 0);
      let avgRating = null, sentimentCounts = {}, recent = [];
      try {
        const rt = await db.query(
          `SELECT AVG(rating)::numeric AS avg FROM lead_recordings
            WHERE rating IS NOT NULL AND created_at >= $1 AND created_at < $2`, [r.from, r.to]
        );
        avgRating = rt.rows[0]?.avg ? Math.round(Number(rt.rows[0].avg) * 10) / 10 : null;
      } catch (_) {}
      try {
        const ss = await db.query(
          `SELECT COALESCE(sentiment, 'unknown') AS sentiment, COUNT(*)::int AS c
             FROM lead_recordings
            WHERE created_at >= $1 AND created_at < $2
            GROUP BY sentiment`, [r.from, r.to]
        );
        ss.rows.forEach(x => { sentimentCounts[x.sentiment] = x.c; });
      } catch (_) {}
      try {
        recent = (await db.query(
          `SELECT lr.id, lr.created_at, lr.duration_s, lr.direction, lr.sentiment, lr.rating,
                  lr.summary, l.name AS lead_name
             FROM lead_recordings lr LEFT JOIN leads l ON l.id = lr.lead_id
            WHERE lr.created_at >= $1 AND lr.created_at < $2
            ORDER BY lr.created_at DESC LIMIT 5`, [r.from, r.to]
        )).rows;
      } catch (_) {}
      return { total, avg_rating: avgRating, sentiment: sentimentCounts, recent_sample: recent, period: r };
    }

    // ---- QUOTATIONS ---------------------------------------------
    case 'quotation_summary': {
      const r = _resolveBounds(args);
      try {
        const rows = (await db.query(
          `SELECT status, COUNT(*)::int AS c, COALESCE(SUM(total), 0)::numeric AS total_value
             FROM quotations
            WHERE created_at >= $1 AND created_at < $2
            GROUP BY status ORDER BY c DESC`, [r.from, r.to]
        )).rows;
        const grand = rows.reduce((a, x) => a + Number(x.total_value || 0), 0);
        return { rows, grand_total_value: grand, period: r };
      } catch (e) {
        return { rows: [], grand_total_value: 0, error: 'Quotations table missing or query failed', period: r };
      }
    }

    // ---- TAT ----------------------------------------------------
    case 'tat_violations': {
      const limit = Math.max(1, Math.min(30, Number(args.limit || 10)));
      try {
        const rows = (await db.query(
          `SELECT v.id, v.lead_id, v.kind, v.violated_at, v.threshold_minutes,
                  l.name AS lead_name, l.phone, u.name AS assignee_name
             FROM tat_violations v
             LEFT JOIN leads l ON l.id = v.lead_id
             LEFT JOIN users u ON u.id = l.assigned_to
            WHERE COALESCE(v.is_resolved, 0) = 0
            ORDER BY v.violated_at DESC LIMIT $1`, [limit]
        )).rows;
        return { rows, count_returned: rows.length };
      } catch (e) {
        return { rows: [], count_returned: 0, error: 'TAT not configured' };
      }
    }

    // ---- ACTIVITY -----------------------------------------------
    case 'recent_activity': {
      const limit = Math.max(1, Math.min(50, Number(args.limit || 15)));
      const kind = String(args.kind || '').toLowerCase();
      try {
        const rows = (await db.query(
          `SELECT la.id, la.action, la.lead_id, la.created_at, la.detail,
                  l.name AS lead_name, u.name AS user_name
             FROM lead_actions la
             LEFT JOIN leads l ON l.id = la.lead_id
             LEFT JOIN users u ON u.id = la.user_id
            ${kind ? `WHERE la.action ILIKE '%' || $2 || '%'` : ''}
            ORDER BY la.created_at DESC LIMIT $1`,
          kind ? [limit, kind] : [limit]
        )).rows;
        return { rows, count_returned: rows.length };
      } catch (e) {
        // Fallback: pull latest remarks if lead_actions isn't available
        const rows = (await db.query(
          `SELECT r.id, 'remark' AS action, r.lead_id, r.created_at, r.remark AS detail,
                  l.name AS lead_name, u.name AS user_name
             FROM remarks r
             LEFT JOIN leads l ON l.id = r.lead_id
             LEFT JOIN users u ON u.id = r.user_id
            ORDER BY r.created_at DESC LIMIT $1`, [limit]
        ).catch(() => ({ rows: [] }))).rows;
        return { rows, count_returned: rows.length, fallback: 'remarks_only' };
      }
    }

    // ---- DICTIONARY ---------------------------------------------
    case 'list_employees': {
      const params = [];
      let where = `is_active = 1`;
      if (args.role) { params.push(String(args.role)); where += ` AND role = $${params.length}`; }
      const rows = (await db.query(
        `SELECT id, name, email, phone, role, designation, department
           FROM users WHERE ${where}
          ORDER BY name ASC`, params
      )).rows;
      return { rows, count: rows.length };
    }
    case 'list_products': {
      const rows = (await db.query(
        `SELECT id, name, description, price FROM products WHERE COALESCE(is_active, 1) = 1 ORDER BY id ASC`
      ).catch(() => ({ rows: [] }))).rows;
      return { rows };
    }
    case 'list_statuses': {
      const rows = (await db.query(
        `SELECT id, name, color, sort_order, is_final FROM statuses ORDER BY sort_order ASC, name ASC`
      )).rows;
      return { rows };
    }
    case 'list_sources': {
      const rows = (await db.query(
        `SELECT id, name FROM sources WHERE COALESCE(is_active, 1) = 1 ORDER BY name ASC`
      ).catch(() => ({ rows: [] }))).rows;
      return { rows };
    }


    // ---- DIMENSIONAL (v3) -------------------------------------
    case 'leads_by_product': {
      const r = _resolveBounds(args);
      const rows = (await db.query(
        `SELECT COALESCE(p.name, l.product, 'Unspecified') AS product,
                COUNT(*)::int AS leads,
                SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won,
                COALESCE(SUM(l.value), 0)::numeric AS total_value
           FROM leads l
           LEFT JOIN products p ON p.id = l.product_id
           LEFT JOIN statuses s ON s.id = l.status_id
          WHERE l.created_at >= $1 AND l.created_at < $2
          GROUP BY product
          ORDER BY leads DESC`, [r.from, r.to]
      )).rows;
      return { rows, period: r };
    }
    case 'leads_by_project_stage': {
      const rows = (await db.query(
        `SELECT COALESCE(ps.name, 'No stage') AS stage, COUNT(l.*)::int AS leads
           FROM leads l
           LEFT JOIN project_stages ps ON ps.id = l.project_stage_id
          GROUP BY ps.id, ps.name, ps.sort_order
          ORDER BY ps.sort_order ASC NULLS LAST, leads DESC`
      ).catch(() => ({ rows: [] }))).rows;
      return { rows };
    }
    case 'leads_by_custom_field': {
      const r = _resolveBounds(args);
      const fieldKey = String(args.field_key || '').toLowerCase().trim();
      if (!fieldKey) return { error: 'field_key is required' };
      try {
        const rows = (await db.query(
          `SELECT COALESCE(l.meta_json->>$3, l.extra_json->>$3, 'Unspecified') AS value,
                  COUNT(*)::int AS leads
             FROM leads l
            WHERE l.created_at >= $1 AND l.created_at < $2
            GROUP BY value
            ORDER BY leads DESC`, [r.from, r.to, fieldKey]
        )).rows;
        return { field_key: fieldKey, rows, period: r };
      } catch (e) {
        return { field_key: fieldKey, rows: [], error: e.message };
      }
    }

    // ---- PERFORMERS / TARGETS (v3) ----------------------------
    case 'bottom_performers': {
      const r = _resolveBounds(args, { defaultDays: 30 });
      const metric = String(args.metric || 'won').toLowerCase();
      const limit = Math.max(1, Math.min(20, Number(args.limit || 5)));
      let order = 'won ASC';
      if (metric === 'value')   order = 'total_value ASC';
      if (metric === 'remarks') order = 'remarks_count ASC';
      const rows = (await db.query(
        `SELECT u.id, u.name,
                COUNT(l.*)::int AS total,
                SUM(CASE WHEN s.name = 'Won' THEN 1 ELSE 0 END)::int AS won,
                COALESCE(SUM(CASE WHEN s.name = 'Won' THEN l.value END), 0)::numeric AS total_value,
                (SELECT COUNT(*)::int FROM remarks rm WHERE rm.user_id = u.id AND rm.created_at >= $1 AND rm.created_at < $2) AS remarks_count
           FROM users u
           LEFT JOIN leads l ON l.assigned_to = u.id AND l.created_at >= $1 AND l.created_at < $2
           LEFT JOIN statuses s ON s.id = l.status_id
          WHERE u.is_active = 1 AND u.role IN ('sales', 'team_leader')
          GROUP BY u.id, u.name
          ORDER BY ${order}
          LIMIT $3`, [r.from, r.to, limit]
      )).rows;
      return { rows, metric, period: r };
    }
    case 'monthly_target_status': {
      const month = String(args.month || (new Date()).toISOString().slice(0, 7));
      const monthStart = new Date(month + '-01T00:00:00Z').toISOString();
      const nextMonth = new Date(new Date(monthStart).setUTCMonth(new Date(monthStart).getUTCMonth() + 1)).toISOString();
      const params = [month, monthStart, nextMonth];
      let userClause = '';
      if (args.assigned_to) {
        const uid = await _resolveUserId(args.assigned_to);
        if (uid) { params.push(uid); userClause = ` AND u.id = $${params.length}`; }
      }
      const rows = (await db.query(
        `SELECT u.id, u.name,
                COALESCE(mt.target_revenue, 0)::numeric AS target_revenue,
                COALESCE(mt.target_leads,   0)::int     AS target_leads,
                COALESCE(mt.target_sales,   0)::int     AS target_sales,
                COALESCE(SUM(CASE WHEN s.name = 'Won' THEN l.value END), 0)::numeric AS current_revenue,
                SUM(CASE WHEN l.created_at >= $2 AND l.created_at < $3 THEN 1 ELSE 0 END)::int AS current_leads,
                SUM(CASE WHEN s.name = 'Won' AND l.created_at >= $2 AND l.created_at < $3 THEN 1 ELSE 0 END)::int AS current_sales
           FROM users u
           LEFT JOIN monthly_targets mt ON mt.user_id = u.id AND mt.month = $1
           LEFT JOIN leads l ON l.assigned_to = u.id AND l.created_at >= $2 AND l.created_at < $3
           LEFT JOIN statuses s ON s.id = l.status_id
          WHERE u.is_active = 1${userClause}
          GROUP BY u.id, u.name, mt.target_revenue, mt.target_leads, mt.target_sales
          ORDER BY u.name ASC`, params
      ).catch(() => ({ rows: [] }))).rows;
      const enriched = rows.map(x => ({
        ...x,
        revenue_pct: x.target_revenue > 0 ? Math.round((x.current_revenue / x.target_revenue) * 1000) / 10 : null,
        leads_pct:   x.target_leads > 0 ? Math.round((x.current_leads / x.target_leads) * 1000) / 10 : null,
        sales_pct:   x.target_sales > 0 ? Math.round((x.current_sales / x.target_sales) * 1000) / 10 : null,
        revenue_shortfall: Math.max(0, Number(x.target_revenue) - Number(x.current_revenue))
      }));
      return { month, rows: enriched };
    }

    // ---- CALLS / RECORDINGS (v3) ------------------------------
    case 'call_ratings_breakdown': {
      const r = _resolveBounds(args);
      try {
        const rows = (await db.query(
          `SELECT u.id, u.name,
                  COUNT(lr.*)::int AS total_calls,
                  AVG(lr.rating)::numeric AS avg_rating,
                  SUM(CASE WHEN lr.rating >= 4 THEN 1 ELSE 0 END)::int AS good_calls,
                  SUM(CASE WHEN lr.rating <= 2 THEN 1 ELSE 0 END)::int AS poor_calls
             FROM users u
             LEFT JOIN lead_recordings lr ON lr.user_id = u.id AND lr.created_at >= $1 AND lr.created_at < $2
            WHERE u.is_active = 1
            GROUP BY u.id, u.name
            HAVING COUNT(lr.*) > 0
            ORDER BY avg_rating DESC NULLS LAST`, [r.from, r.to]
        )).rows.map(x => ({
          ...x,
          avg_rating: x.avg_rating != null ? Math.round(Number(x.avg_rating) * 10) / 10 : null
        }));
        return { rows, period: r };
      } catch (e) { return { rows: [], error: e.message, period: r }; }
    }
    case 'call_insights_recent': {
      const limit = Math.max(1, Math.min(30, Number(args.limit || 10)));
      try {
        const rows = (await db.query(
          `SELECT lr.id, lr.created_at, lr.duration_s, lr.sentiment, lr.rating,
                  lr.key_insight, lr.action_items, lr.summary,
                  l.name AS lead_name, u.name AS user_name
             FROM lead_recordings lr
             LEFT JOIN leads l ON l.id = lr.lead_id
             LEFT JOIN users u ON u.id = lr.user_id
            WHERE lr.key_insight IS NOT NULL AND lr.key_insight <> ''
            ORDER BY lr.created_at DESC LIMIT $1`, [limit]
        )).rows;
        return { rows };
      } catch (e) { return { rows: [], error: e.message }; }
    }

    // ---- WHATSAPP (v3) ----------------------------------------
    case 'wa_unattended_chats': {
      const hours = Math.max(1, Math.min(24*30, Number(args.hours || 48)));
      const limit = Math.max(1, Math.min(50, Number(args.limit || 15)));
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      try {
        const rows = (await db.query(
          `WITH last_msg AS (
             SELECT DISTINCT ON (LEAST(from_number, to_number) || GREATEST(from_number, to_number))
                    id, lead_id, from_number, to_number, body, direction, created_at,
                    CASE WHEN direction = 'in' THEN from_number ELSE to_number END AS contact
               FROM whatsapp_messages
              WHERE created_at >= $1
              ORDER BY LEAST(from_number, to_number) || GREATEST(from_number, to_number), created_at DESC
           )
           SELECT lm.contact AS phone, lm.body AS last_inbound_body, lm.created_at AS last_inbound_at,
                  l.id AS lead_id, l.name AS lead_name,
                  u.name AS assigned_user
             FROM last_msg lm
             LEFT JOIN leads l ON l.id = lm.lead_id
             LEFT JOIN wa_chat_assignments a ON a.phone = lm.contact
             LEFT JOIN users u ON u.id = a.assigned_to
            WHERE lm.direction = 'in'
            ORDER BY lm.created_at ASC
            LIMIT $2`, [since, limit]
        )).rows;
        return { rows, hours_scanned: hours, count: rows.length };
      } catch (e) { return { rows: [], error: e.message, hours_scanned: hours }; }
    }
    case 'wa_response_delays': {
      const r = _resolveBounds(args, { defaultDays: 7 });
      try {
        const rows = (await db.query(
          `WITH paired AS (
             SELECT m_in.id AS in_id, m_in.from_number, m_in.created_at AS in_at,
                    (SELECT m_out.created_at FROM whatsapp_messages m_out
                       WHERE m_out.to_number = m_in.from_number
                         AND m_out.direction = 'out'
                         AND m_out.created_at > m_in.created_at
                       ORDER BY m_out.created_at ASC LIMIT 1) AS reply_at,
                    (SELECT a.assigned_to FROM wa_chat_assignments a WHERE a.phone = m_in.from_number) AS user_id
               FROM whatsapp_messages m_in
              WHERE m_in.direction = 'in'
                AND m_in.created_at >= $1 AND m_in.created_at < $2
           )
           SELECT u.name AS rep_name,
                  COUNT(*)::int AS total_msgs,
                  AVG(EXTRACT(EPOCH FROM (reply_at - in_at)))::numeric AS avg_secs,
                  MAX(EXTRACT(EPOCH FROM (reply_at - in_at)))::numeric AS worst_secs
             FROM paired p LEFT JOIN users u ON u.id = p.user_id
            WHERE reply_at IS NOT NULL
            GROUP BY u.id, u.name
            ORDER BY avg_secs DESC NULLS LAST
            LIMIT 20`, [r.from, r.to]
        )).rows.map(x => ({
          rep_name: x.rep_name || '(unassigned)',
          total_msgs: x.total_msgs,
          avg_minutes: x.avg_secs != null ? Math.round(Number(x.avg_secs) / 6) / 10 : null,
          worst_minutes: x.worst_secs != null ? Math.round(Number(x.worst_secs) / 6) / 10 : null
        }));
        return { rows, period: r };
      } catch (e) { return { rows: [], error: e.message, period: r }; }
    }

    // ---- ATTENDANCE / LOGIN (v3) ------------------------------
    case 'attendance_today': {
      const t = _todayBounds();
      let workStart = '09:30';
      try { workStart = (await db.getConfig('WORK_START', '09:30')) || '09:30'; } catch (_) {}
      try {
        const rows = (await db.query(
          `SELECT u.id, u.name, u.role, a.check_in, a.check_out, a.status
             FROM users u
             LEFT JOIN attendance a ON a.user_id = u.id AND a.date = CURRENT_DATE
            WHERE u.is_active = 1
            ORDER BY u.name ASC`
        )).rows;
        const present = rows.filter(r => r.check_in);
        const absent  = rows.filter(r => !r.check_in);
        const [hH, hM] = workStart.split(':').map(Number);
        const late = present.filter(r => {
          if (!r.check_in) return false;
          const ci = new Date(r.check_in);
          const local = new Date(ci.getTime() + 5.5 * 3600 * 1000);
          return (local.getUTCHours() > hH) || (local.getUTCHours() === hH && local.getUTCMinutes() > hM);
        });
        return {
          work_start: workStart,
          counts: { present: present.length, absent: absent.length, late: late.length },
          present, absent, late
        };
      } catch (e) { return { error: e.message, counts: {} }; }
    }
    case 'login_locations': {
      const limit = Math.max(1, Math.min(50, Number(args.limit || 15)));
      const params = [];
      let where = '1=1';
      if (args.user) {
        const uid = await _resolveUserId(args.user);
        if (uid) { params.push(uid); where += ` AND ud.user_id = $${params.length}`; }
      }
      params.push(limit);
      try {
        const rows = (await db.query(
          `SELECT ud.user_id, u.name, ud.ip, ud.user_agent, ud.first_seen_at, ud.last_seen_at
             FROM user_devices ud
             LEFT JOIN users u ON u.id = ud.user_id
            WHERE ${where}
            ORDER BY ud.last_seen_at DESC LIMIT $${params.length}`, params
        )).rows;
        return { rows };
      } catch (e) { return { rows: [], error: e.message }; }
    }

    default:
      return { error: 'Unknown tool: ' + name };
  }
}

// ---- Daily-limit enforcement ---------------------------------------
async function _resolveDailyLimit() {
  let limit = 50;
  try {
    const v = await db.getConfig('COPILOT_DAILY_LIMIT_PER_USER', '50');
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) limit = n;
  } catch (_) {}
  // SHOWCASE_AI_v2 — hard-cap Copilot at 30 per user per day on demo tenants
  // so a prospect mashing the Ask CRM box during a demo can't burn budget.
  try {
    const demo = await db.findOneBy('config', 'key', 'DEMO_TENANT').catch(() => null);
    if (demo && String(demo.value) === '1') limit = Math.min(limit, 30);
  } catch (_) {}
  return limit;
}
async function _todaysCount(userId) {
  try {
    const t = _todayBounds();
    const r = await db.query(
      `SELECT COUNT(*)::int AS c FROM crm_copilot_log
        WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [userId, t.from, t.to]
    );
    return Number(r.rows[0]?.c || 0);
  } catch (_) { return 0; }
}

// ---- Tool-result -> text fallback ----------------------------------
function _formatToolFallback(toolsCalled, question) {
  const lines = [];
  for (const t of toolsCalled) {
    const name = t.name;
    const r = t.result || {};
    if (r && r.error) { lines.push('⚠ ' + name + ': ' + r.error); continue; }
    if (name === 'count_leads') {
      lines.push('📊 You have **' + Number(r.count || 0).toLocaleString('en-IN') + '** matching lead(s).');
    } else if (name === 'pipeline_funnel') {
      const stages = Array.isArray(r.stages) ? r.stages : [];
      const total = stages.reduce((a, s) => a + Number(s.c || 0), 0);
      lines.push('📊 **Pipeline funnel** (' + total.toLocaleString('en-IN') + ' leads total):');
      for (const s of stages) lines.push('• ' + s.name + ': ' + Number(s.c || 0).toLocaleString('en-IN'));
    } else if (name === 'list_leads' || name === 'search_leads' || name === 'lead_aging') {
      const rows = Array.isArray(r.rows) ? r.rows : [];
      if (!rows.length) lines.push('No matching leads found.');
      else {
        lines.push('📋 ' + rows.length + ' lead(s):');
        for (const l of rows.slice(0, 15)) {
          const bits = [l.name, l.company, l.status_name || l.status, l.assignee_name].filter(Boolean);
          lines.push('• ' + bits.join(' — '));
        }
      }
    } else if (name === 'get_lead_detail') {
      const l = r.lead || {};
      lines.push('👤 **' + (l.name || 'Lead') + '** (' + (l.status || '—') + ')');
      lines.push('• Phone: ' + (l.phone || '—') + ' · Email: ' + (l.email || '—'));
      lines.push('• Company: ' + (l.company || '—') + ' · Assignee: ' + (l.assignee || '—'));
      lines.push('• Source: ' + (l.source || '—') + ' · Value: ₹' + Number(l.value || 0).toLocaleString('en-IN'));
      lines.push('• Recordings: ' + (r.recordings_count || 0));
      if (Array.isArray(r.recent_remarks) && r.recent_remarks.length) {
        lines.push('Recent remarks:');
        r.recent_remarks.slice(0, 3).forEach(rm => lines.push('  - ' + (rm.remark || '').slice(0, 120)));
      }
    } else if (name === 'employee_performance' || name === 'top_performers') {
      const rows = Array.isArray(r.rows) ? r.rows : [];
      if (!rows.length) lines.push('No performance data found.');
      else {
        lines.push('👥 **' + (name === 'top_performers' ? 'Top performers' : 'Employee performance') + '**:');
        for (const e of rows) {
          const bits = [e.name || e.user_name, 'leads:' + (e.total || 0), 'won:' + (e.won || 0)];
          if (e.total_value) bits.push('₹' + Number(e.total_value).toLocaleString('en-IN'));
          lines.push('• ' + bits.join(' · '));
        }
      }
    } else if (name === 'report_summary') {
      lines.push('📊 **Report summary** — total: ' + (r.total || 0) + ', won: ' + (r.won || 0) + ', lost: ' + (r.lost || 0));
    } else if (name === 'source_breakdown') {
      const rows = Array.isArray(r.rows) ? r.rows : [];
      lines.push('📥 **Source breakdown**:');
      for (const s of rows) lines.push('• ' + s.source + ': ' + s.leads + ' leads, ' + s.won + ' won, ₹' + Number(s.total_value || 0).toLocaleString('en-IN') + ' (' + s.conversion_pct + '% conversion)');
    } else if (name === 'conversion_rate') {
      if (r.group_by === 'overall') lines.push('🎯 Overall conversion: ' + r.rate_pct + '% (' + r.won + ' / ' + r.total + ')');
      else {
        lines.push('🎯 **Conversion by ' + r.group_by + '**:');
        (r.rows || []).forEach(x => lines.push('• ' + (x.user_name || x.source) + ': ' + x.rate_pct + '% (' + x.won + ' / ' + x.total + ')'));
      }
    } else if (name === 'my_tasks_today') {
      const tasks = r.tasks || [], fus = r.followups || [];
      lines.push('✅ **Today** — ' + tasks.length + ' task(s), ' + fus.length + ' follow-up(s)');
      tasks.slice(0, 5).forEach(t => lines.push('• Task: ' + (t.title || '(untitled)')));
      fus.slice(0, 5).forEach(f => lines.push('• Follow-up #' + (f.lead_id || '?') + ' — ' + (f.lead_name || '') + ': ' + (f.note || '')));
    } else if (name === 'followups_summary') {
      lines.push('📅 Follow-ups — overdue: ' + r.overdue + ', today: ' + r.today + ', upcoming: ' + r.upcoming);
      (r.sample || []).slice(0, 5).forEach(f => lines.push('• ' + (f.lead_name || '?') + ' (' + (f.user_name || '') + '): ' + (f.note || '')));
    } else if (name === 'todays_calls') {
      const c = r.counts || {};
      lines.push('📞 **Today’s calls** — ' + (Object.entries(c).map(([k, v]) => k + ': ' + v).join(' · ') || 'none yet'));
    } else if (name === 'recordings_summary') {
      lines.push('🎤 **Recordings** — total: ' + (r.total || 0) + ', avg rating: ' + (r.avg_rating != null ? r.avg_rating + '/5' : '—'));
      const sk = r.sentiment || {};
      const sentLine = Object.entries(sk).map(([k, v]) => k + ': ' + v).join(' · ');
      if (sentLine) lines.push('Sentiment — ' + sentLine);
    } else if (name === 'quotation_summary') {
      lines.push('💰 **Quotations**:');
      (r.rows || []).forEach(x => lines.push('• ' + x.status + ': ' + x.c + ' (₹' + Number(x.total_value || 0).toLocaleString('en-IN') + ')'));
      lines.push('Grand total: ₹' + Number(r.grand_total_value || 0).toLocaleString('en-IN'));
    } else if (name === 'tat_violations') {
      const rows = r.rows || [];
      if (!rows.length) lines.push('✅ No active TAT violations.');
      else {
        lines.push('⚠ **TAT violations** (' + rows.length + '):');
        rows.slice(0, 10).forEach(v => lines.push('• ' + (v.lead_name || '?') + ' (' + (v.assignee_name || '') + ') — ' + v.kind));
      }
    } else if (name === 'recent_activity') {
      const rows = r.rows || [];
      if (!rows.length) lines.push('No recent activity.');
      else {
        lines.push('📝 **Recent activity**:');
        rows.slice(0, 15).forEach(a => lines.push('• ' + (a.user_name || '') + ' ' + (a.action || '') + ' on ' + (a.lead_name || '#' + a.lead_id)));
      }
    } else if (name === 'list_employees') {
      const rows = r.rows || [];
      lines.push('👥 **Employees** (' + rows.length + '):');
      rows.forEach(u => lines.push('• ' + u.name + ' — ' + (u.designation || u.role) + (u.department ? ' (' + u.department + ')' : '')));
    } else if (name === 'list_products') {
      const rows = r.rows || [];
      lines.push('📦 **Products**:');
      rows.forEach(p => lines.push('• ' + p.name + ' — ₹' + Number(p.price || 0).toLocaleString('en-IN')));
    } else if (name === 'list_statuses') {
      const rows = r.rows || [];
      lines.push('🎯 **Statuses**:');
      rows.forEach(s => lines.push('• ' + s.name + (s.is_final ? ' (final)' : '')));
    } else if (name === 'list_sources') {
      const rows = r.rows || [];
      lines.push('📥 **Sources**:');
      rows.forEach(s => lines.push('• ' + s.name));
    } else if (name === 'leads_by_product') {
      const rows = r.rows || [];
      lines.push('📦 **Leads by product**:');
      rows.forEach(x => lines.push('• ' + x.product + ': ' + x.leads + ' leads, ' + x.won + ' won, ₹' + Number(x.total_value || 0).toLocaleString('en-IN')));
    } else if (name === 'leads_by_project_stage') {
      const rows = r.rows || [];
      lines.push('🚚 **Leads by Sale Final Closure Stage**:');
      rows.forEach(x => lines.push('• ' + x.stage + ': ' + x.leads + ' lead(s)'));
    } else if (name === 'leads_by_custom_field') {
      const rows = r.rows || [];
      lines.push('🎛 **Leads by ' + (r.field_key || 'custom field') + '**:');
      rows.forEach(x => lines.push('• ' + x.value + ': ' + x.leads));
    } else if (name === 'bottom_performers') {
      const rows = r.rows || [];
      lines.push('🐢 **Bottom performers** (' + (r.metric || 'won') + '):');
      rows.forEach(e => lines.push('• ' + (e.name || e.user_name) + ' — leads:' + (e.total || 0) + ' · won:' + (e.won || 0) + (e.total_value ? ' · ₹' + Number(e.total_value).toLocaleString('en-IN') : '')));
    } else if (name === 'monthly_target_status') {
      const rows = r.rows || [];
      lines.push('🎯 **Monthly target — ' + r.month + '**:');
      rows.forEach(t => {
        const bits = [t.name];
        if (t.target_revenue > 0) bits.push('₹ ' + Number(t.current_revenue).toLocaleString('en-IN') + ' / ' + Number(t.target_revenue).toLocaleString('en-IN') + ' (' + (t.revenue_pct ?? 0) + '%)');
        if (t.target_sales > 0)   bits.push('sales: ' + t.current_sales + '/' + t.target_sales);
        if (t.target_leads > 0)   bits.push('leads: ' + t.current_leads + '/' + t.target_leads);
        if (t.revenue_shortfall > 0) bits.push('shortfall ₹' + Number(t.revenue_shortfall).toLocaleString('en-IN'));
        lines.push('• ' + bits.join(' · '));
      });
    } else if (name === 'call_ratings_breakdown') {
      const rows = r.rows || [];
      lines.push('🎤 **Call ratings by rep**:');
      rows.forEach(x => lines.push('• ' + x.name + ': avg ' + (x.avg_rating ?? '—') + '/5 across ' + x.total_calls + ' calls (👍 ' + x.good_calls + ' / 👎 ' + x.poor_calls + ')'));
    } else if (name === 'call_insights_recent') {
      const rows = r.rows || [];
      lines.push('💡 **Recent call insights**:');
      rows.slice(0, 10).forEach(c => {
        lines.push('• ' + (c.lead_name || '(unknown lead)') + ' (' + (c.user_name || '') + ', ' + (c.sentiment || '—') + ', ' + (c.rating ? c.rating + '/5' : 'unrated') + ')');
        if (c.key_insight) lines.push('  💡 ' + String(c.key_insight).slice(0, 200));
      });
    } else if (name === 'wa_unattended_chats') {
      const rows = r.rows || [];
      if (!rows.length) lines.push('✅ No unattended WhatsApp chats in the last ' + (r.hours_scanned || 48) + ' hours.');
      else {
        lines.push('💬 **Unattended WhatsApp chats** (' + rows.length + '):');
        rows.forEach(c => lines.push('• ' + c.phone + ' (' + (c.lead_name || 'no lead') + ', assigned: ' + (c.assigned_user || 'unassigned') + ') — "' + String(c.last_inbound_body || '').slice(0, 80) + '"'));
      }
    } else if (name === 'wa_response_delays') {
      const rows = r.rows || [];
      lines.push('⏱ **WhatsApp response delays** (avg minutes):');
      rows.forEach(x => lines.push('• ' + x.rep_name + ': ' + (x.avg_minutes ?? '—') + ' min avg, worst ' + (x.worst_minutes ?? '—') + ' min over ' + x.total_msgs + ' msgs'));
    } else if (name === 'attendance_today') {
      const c = r.counts || {};
      lines.push('🕘 **Attendance today** — ✅ present: ' + (c.present ?? 0) + ', ❌ absent: ' + (c.absent ?? 0) + ', 🐢 late: ' + (c.late ?? 0) + ' (work start: ' + r.work_start + ')');
      if (r.late && r.late.length) {
        lines.push('Late arrivals:');
        r.late.forEach(u => lines.push('• ' + u.name + ' — checked in at ' + new Date(u.check_in).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })));
      }
      if (r.absent && r.absent.length && r.absent.length < 10) {
        lines.push('Absent:');
        r.absent.forEach(u => lines.push('• ' + u.name));
      }
    } else if (name === 'login_locations') {
      const rows = r.rows || [];
      lines.push('🌐 **Recent logins**:');
      rows.forEach(x => lines.push('• ' + x.name + ' from ' + (x.ip || 'unknown') + ' (last seen ' + new Date(x.last_seen_at).toLocaleString() + ')'));
    } else {
      try {
        const s = JSON.stringify(r, null, 2);
        if (s.length < 1500) lines.push('```\n' + s + '\n```');
      } catch (_) {}
    }
  }
  if (!lines.length) return '';
  return lines.join('\n');
}

// ---- Public API -----------------------------------------------------
async function api_copilot_ask(token, message, history) {
  const me = await authUser(token);
  await _ensureTables();
  const text = String(message || '').trim();
  if (!text) throw new Error('Empty question');

  const limit = await _resolveDailyLimit();
  const used  = await _todaysCount(me.id);
  if (used >= limit) {
    throw new Error('Daily limit reached for AI Copilot (' + limit + ' questions/day). Try again tomorrow or ask your admin to raise the limit.');
  }

  const company = (await db.getConfig('COMPANY_NAME', '').catch(() => '')) || 'this CRM';
  const actionsOn = await _actionsEnabled();
  const cpActBlock = actionsOn ? `

WRITE ACTIONS (beta - enabled for this tenant):
You can SET UP RULES and RUN OPERATIONS using these write tools. NEVER ask the user for confirmation yourself — the SYSTEM always shows a preview card with a Confirm button after you call any write tool. Act decisively with sensible defaults.

INTENT CLASSIFICATION — pick the correct tool by reading what TYPE of target the user named:
- Target = a USER NAME (person) → reassign_leads_bulk. Phrases: "transfer to Amit", "move to Rohan", "give them to Pallabhi", "distribute to Amit and Rohan".
- Target = a STATUS NAME → change_lead_status_bulk. Phrases: "change X to Y", "mark as Y", "NP to Not Reachable", "today's leads all NP to not reachable", "all New to Contacted". CRITICAL: if Y is a status (Not Reachable, Closed, Won, Lost, NP, Follow Up, Junk, Hot, Cold, etc.), this is the right tool — never reassign_leads_bulk.
- Target = a TAG → bulk_add_tag. Phrases: "tag as hot", "mark as VIP", "add tag priority to all Meta leads".
- Target = a CUSTOM FIELD value → bulk_edit_custom_field. Phrases: "set Company GST to Pending for all", "update custom field X to Y".
- Target = a CAMPAIGN → bulk_assign_campaign. Phrases: "add to campaign Q3 push", "put in campaign Meta Drive".
- "set up rule" / "auto assign" / "going forward" / "from now on" / "any future X" → create_autoassign_rule (FUTURE only).
- "add user" / "create user" / "invite X as sales" → create_user.
- "add status X" / "create status" → create_status. "rename status X" / "change color of status" → update_status.
- "add source X" → create_source. "add product X" → create_product. "add custom field X" → create_custom_field.
- "create campaign X" → create_campaign.
- "set TAT for X to Y hours" → set_tat_rule.
- "set follow-up for lead X to Y" / "remind me about lead X" → set_lead_followup.

DISAMBIGUATION RULES:
- "X to Y" pattern: look at Y. If Y is a person → reassign. If Y is a status → change_lead_status_bulk. If Y is a tag → bulk_add_tag.
- If the user says "today's leads" or "today's X" — pass filter_from = today's date.
- If ambiguous between standing-rule vs one-time, prefer the SAFER one (standing rule, which doesn't touch existing leads).
- Status names are often short ("NP", "FU", "Hot", "Won") — these are NOT user names. Pattern: lowercase abbreviations or 2-3 word descriptors map to status, full proper nouns (Amit, Rohan, Pallabhi) map to users.

Pick sensible defaults without asking: distribution=round_robin, scope=future. Honor user's stated preference if given.

When you call a write tool the result will contain {_preview: true, ...}. Write ONE short acknowledgement sentence like "Got it - here's the change I'll make:" then STOP. The SPA renders the preview card below your text with the Confirm button. DO NOT enumerate preview rows yourself.` : `

WRITE ACTIONS are NOT enabled for this tenant. If the user asks to create a rule, reassign leads, add a status, etc, politely tell them write-actions are in private beta and not yet enabled here.`;
  const system = `You are the CRM data assistant for ${company}.${cpActBlock}

Your job: answer the user's question by calling ONE OR MORE of the provided tools to fetch real data, then summarising the result in clear bullet-style English. Today is ${new Date().toISOString().slice(0, 10)} (UTC). The user is in IST. Calling user: ${me.name} (role: ${me.role}).

DATA AVAILABLE TO YOU:
• Leads — full pipeline (name, phone, email, company, source, status, assignee, value, custom fields, follow-ups, remarks, recordings, TAT violations).
• Users / employees — name, role, designation, department.
• Statuses, sources, products, Sale Final Closure Stages (a.k.a. project stages — internal id), tags, custom fields.
• Quotations — draft/sent/accepted/rejected with totals.
• Recordings — call recordings with AI summaries, sentiment, ratings, action items.
• Activity log — status changes, remarks, follow-ups.
• KPIs — pipeline funnel, conversion rate, source breakdown, top performers, employee performance.

PICKING THE RIGHT TOOL — examples:
• "How many new leads today?" → count_leads(from=today, to=today)
• "Total leads in CRM" → count_leads (NO from/to → ALL TIME)
• "Pipeline funnel" → pipeline_funnel (no dates → ALL TIME)
• "Top 3 performers this month" → top_performers(metric='won', limit=3)
• "Best source for leads" → source_breakdown
• "What's our conversion rate?" → conversion_rate(group_by='overall')
• "Conversion by source" → conversion_rate(group_by='source')
• "Find lead Rahul" → search_leads(q='Rahul')
• "Tell me about lead Sneha Patel" → get_lead_detail(name='Sneha Patel')
• "List all sales reps" → list_employees(role='sales')
• "What products do we sell?" → list_products
• "Recent activity" → recent_activity
• "Leads by product" → leads_by_product
• "Project stage wise data" → leads_by_project_stage
• "Leads by industry" → leads_by_custom_field(field_key='industry')
• "Identify non performers" / "weakest reps" → bottom_performers
• "Monthly target status" / "shortfall" → monthly_target_status
• "Call ratings by rep" → call_ratings_breakdown
• "Recent call insights" → call_insights_recent
• "Unattended WhatsApp chats" → wa_unattended_chats
• "WhatsApp response time" / "who is slow on WA" → wa_response_delays
• "Who came late today" / "attendance today" → attendance_today
• "Where did <name> log in from" → login_locations(user='<name>')
• "Calls today" → todays_calls
• "Average call rating" → recordings_summary
• "How many quotes sent" → quotation_summary
• "Leads out of TAT" → tat_violations
• "Oldest open leads" → lead_aging
• "Overdue follow-ups" → followups_summary
• "What's on my plate today?" → my_tasks_today
• "Report for last week" → report_summary(from=..., to=...)
• "Performance of Priya Iyer" → employee_performance + filter by name in your summary

PLATFORM HELP / SETUP QUESTIONS:
For ANY question about how to set up, configure, install, or troubleshoot a feature - call lookup_setup_guide first. Examples:
• "How do I set up Pabbly?" → lookup_setup_guide(query='Pabbly setup')
• "How to connect WhatsApp" → lookup_setup_guide(query='WhatsApp Cloud API embedded sign in')
• "How do I install the mobile app" → lookup_setup_guide(query='mobile app install APK')
• "How do I add a custom field for budget" → lookup_setup_guide(query='custom field add')
• "Push notifications not working" → lookup_setup_guide(query='push notifications troubleshoot')
• "How do I configure SMTP for Gmail" → lookup_setup_guide(query='SMTP Gmail app password')
• "How to import leads from Zoho" → lookup_setup_guide(query='CSV import Zoho')
• "Set up auto assign" → lookup_setup_guide(query='auto-assign rules')
• "How does TAT work" → lookup_setup_guide(query='TAT SLA')
• "How to train the AI bot" → lookup_setup_guide(query='AI bot knowledge base train')
After calling, synthesise a SHORT step-by-step answer using the returned content, AND end with the URL so the user can read the full guide.

IMPORTANT RULES:
1. ALWAYS use a tool — never make up names, counts, or amounts.
2. When the user asks for a TOTAL ("how many leads", "total quotations") and gives NO date range, leave from/to OUT so the tool returns ALL-TIME data (matches the dashboard).
3. Only pass from/to when the user explicitly says "today", "this week", "last month", "since March", etc.
4. After EVERY tool call, ALWAYS produce a short natural-language summary of the result. Never end your turn silently.
5. Use bullet lists for any list of 2+ items. Use "₹" for INR amounts. Format big numbers with commas.
6. If a question is off-topic (general world knowledge, code, etc.), politely refuse and remind them this is a CRM-only assistant.
7. If the user asks something that needs MULTIPLE pieces of info (e.g. "top performer + their leads"), call multiple tools.`;

  const ctx = { userId: me.id, userName: me.name, userRole: me.role };
  const hist = Array.isArray(history) ? history.slice(-6).map(h => ({
    role: h && h.role === 'model' ? 'model' : 'user',
    text: String((h && h.text) || '').slice(0, 4000)
  })).filter(h => h.text) : [];

  const result = await gemini.generateWithTools({
    feature: 'copilot',  // SHOWCASE_AI_v2 — allowed on demo tenants
    system, history: hist, prompt: text,
    tools: TOOLS,
    runTool: (name, args) => _runTool(name, args, ctx),
    maxTurns: 6, maxOutputTokens: 1200, temperature: 0.2,  // COST_REDUCE_v1: was 8/1800
  });

  let answer = result.text || '';
  if (!answer && Array.isArray(result.tools_called) && result.tools_called.length) {
    answer = _formatToolFallback(result.tools_called, text);
  }
  if (!answer) {
    answer =
      "I wasn’t able to put together an answer for that one. Try asking me about your CRM data directly — for example:\n" +
      "• How many leads do I have in total?\n" +
      "• Show me 5 fresh leads\n" +
      "• Top 3 performers this month\n" +
      "• Conversion rate by source\n" +
      "• Tell me about lead <name>\n" +
      "• Quotations summary";
  }

  try {
    await db.query(
      `INSERT INTO crm_copilot_log
         (user_id, question, answer, tools_called, input_tokens, output_tokens, cost_inr_billed, error_text)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
      [
        me.id, text.slice(0, 4000), answer.slice(0, 8000),
        JSON.stringify(result.tools_called || []),
        result.input_tokens || 0, result.output_tokens || 0,
        result.cost_inr_billed || 0,
        result.ok ? null : (result.error || '').slice(0, 500)
      ]
    );
  } catch (_) {}

  try {
    const slug = (db.tenantStorage && db.tenantStorage.getStore && db.tenantStorage.getStore() || {}).slug || '';
    await gemini.logUsage({
      tenant_slug: slug, call_kind: 'copilot',
      phone: null, lead_id: null, result
    });
  } catch (_) {}

  if (!result.ok) throw new Error(result.error || 'Copilot failed');

  // CP_ACT_v1: lift any preview generated by an action tool to top-level
  let action_preview = null;
  if (Array.isArray(result.tools_called)) {
    for (const t of result.tools_called) {
      const r = t && t.result;
      if (r && r._preview && r.confirm_token) {
        action_preview = {
          confirm_token: r.confirm_token,
          title: r.title,
          rows:  r.rows,
          explain: r.explain,
          tool_name: t.name,
          expires_in_minutes: r.expires_in_minutes || 15,
        };
        break;
      }
      if (r && r._refuse) {
        answer = (answer ? (answer + '\n\n') : '') + r._refuse;
      }
    }
  }

  // Roll up today's totals so the SPA header meter updates after each ask.
  let costInrToday = 0, tokensInToday = 0, tokensOutToday = 0;
  try {
    const t = _todayBounds();
    const r = await db.query(
      `SELECT COALESCE(SUM(cost_inr_billed),0)::numeric AS cost,
              COALESCE(SUM(input_tokens),0)::int  AS tin,
              COALESCE(SUM(output_tokens),0)::int AS tout
         FROM crm_copilot_log
        WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [me.id, t.from, t.to]
    );
    costInrToday   = Number(r.rows[0]?.cost) || 0;
    tokensInToday  = Number(r.rows[0]?.tin)  || 0;
    tokensOutToday = Number(r.rows[0]?.tout) || 0;
  } catch (_) {}

  return {
    text: answer,
    tools_called: (result.tools_called || []).map(t => ({ name: t.name, args: t.args })),
    daily_used: used + 1,
    daily_limit: limit,
    cost_inr_billed: result.cost_inr_billed || 0,
    cost_inr_today: costInrToday,
    tokens_in_today: tokensInToday,
    tokens_out_today: tokensOutToday,
    action_preview,
  };
}

// CP_ACT_v1: execute a pending action by confirm_token.
async function api_copilot_confirm(token, confirm_token) {
  const me = await authUser(token);
  await _ensureTables();
  if (!confirm_token) throw new Error('confirm_token required');
  if (!await _actionsEnabled()) throw new Error('Copilot write actions are not enabled for this tenant.');
  if (me.role !== 'admin') throw new Error('This change can only be confirmed by an admin.');
  const r = await db.query(
    `SELECT * FROM copilot_actions WHERE confirm_token = $1 AND user_id = $2 LIMIT 1`,
    [confirm_token, me.id]
  );
  const row = r.rows[0];
  if (!row) throw new Error('Action not found or already used');
  if (row.state !== 'pending') throw new Error('Action already ' + row.state);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.query(`UPDATE copilot_actions SET state = 'expired' WHERE id = $1`, [row.id]);
    throw new Error('Action expired - please ask Copilot again');
  }
  try {
    const out = await _executePendingAction(row, { userId: me.id, userName: me.name, userRole: me.role });
    await db.query(
      `UPDATE copilot_actions SET state = 'confirmed', confirmed_at = NOW(), result_json = $2::jsonb WHERE id = $1`,
      [row.id, JSON.stringify(out)]
    );
    return { ok: true, tool: row.tool_name, result: out };
  } catch (e) {
    await db.query(
      `UPDATE copilot_actions SET state = 'failed', error_text = $2 WHERE id = $1`,
      [row.id, String(e.message || e).slice(0, 500)]
    );
    throw e;
  }
}

// CP_ACT_v1: cancel a pending action.
async function api_copilot_cancelAction(token, confirm_token) {
  const me = await authUser(token);
  await _ensureTables();
  if (!confirm_token) throw new Error('confirm_token required');
  await db.query(
    `UPDATE copilot_actions SET state = 'cancelled'
      WHERE confirm_token = $1 AND user_id = $2 AND state = 'pending'`,
    [confirm_token, me.id]
  );
  return { ok: true };
}

async function api_copilot_usage(token) {
  const me = await authUser(token);
  await _ensureTables();
  const limit = await _resolveDailyLimit();
  const used  = await _todaysCount(me.id);
  let recent = [];
  try {
    const r = await db.query(
      `SELECT id, question, answer, created_at FROM crm_copilot_log
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [me.id]
    );
    recent = r.rows;
  } catch (_) {}
  // Daily token + cost rollup for the Copilot header meter (CP_ACT_v1)
  let tokensInToday = 0, tokensOutToday = 0, costInrToday = 0;
  try {
    const t = _todayBounds();
    const r = await db.query(
      `SELECT COALESCE(SUM(input_tokens),0)::int  AS tin,
              COALESCE(SUM(output_tokens),0)::int AS tout,
              COALESCE(SUM(cost_inr_billed),0)::numeric AS cost
         FROM crm_copilot_log
        WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
      [me.id, t.from, t.to]
    );
    tokensInToday  = Number(r.rows[0]?.tin)  || 0;
    tokensOutToday = Number(r.rows[0]?.tout) || 0;
    costInrToday   = Number(r.rows[0]?.cost) || 0;
  } catch (_) {}
  return { today: used, daily_limit: limit, recent,
           tokens_in_today: tokensInToday, tokens_out_today: tokensOutToday,
           cost_inr_today: costInrToday };
}

module.exports = { api_copilot_ask, api_copilot_usage, api_copilot_confirm, api_copilot_cancelAction };
