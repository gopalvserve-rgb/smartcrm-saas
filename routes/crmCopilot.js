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
const { authUser } = require('../utils/auth');
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
    }, required: ['query'] } }

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

// ---- Tool dispatcher ------------------------------------------------
async function _runTool(name, args, ctx) {
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
  const system = `You are the CRM data assistant for ${company}.

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

  return {
    text: answer,
    tools_called: (result.tools_called || []).map(t => ({ name: t.name, args: t.args })),
    daily_used: used + 1,
    daily_limit: limit,
    cost_inr_billed: result.cost_inr_billed || 0,
  };
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
  return { today: used, daily_limit: limit, recent };
}

module.exports = { api_copilot_ask, api_copilot_usage };
