/**
 * routes/crmCopilot.js
 *
 * In-app "Ask CRM" assistant. Wraps Gemini with a function-calling
 * layer that exposes a curated set of CRM data tools — count_leads,
 * list_leads, report_summary, employee_perf, my_tasks, tat_violations,
 * pipeline_funnel — so users can ask natural-language questions and
 * the model fetches the actual data via these tools instead of
 * hallucinating.
 *
 * Public surface (auto-loaded by tenantApi.js):
 *   api_copilot_ask(token, message, history?)
 *     → { text, tools_called, daily_used, daily_limit, cost_inr_billed }
 *   api_copilot_usage(token)
 *     → { today, daily_limit, recent: [...] }
 *
 * Daily limit:
 *   per-user, per-tenant. Counts api_copilot_ask calls in the current
 *   UTC date for this user. Default 50, override via tenant config
 *   COPILOT_DAILY_LIMIT_PER_USER.
 *
 * Knowledge boundary:
 *   The system prompt instructs Gemini that it can ONLY answer
 *   questions about THIS tenant's CRM data, and must use the provided
 *   tools — it has no other knowledge of the data.
 */

'use strict';

const db = require('../db/pg');
const control = require('../control/db');
const { authUser } = require('../utils/auth');
const gemini = require('../utils/geminiClient');

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
// Gemini's function-call schema. Keep names + parameters tight so the
// model reliably picks the right tool.
const TOOLS = [
  { name: 'count_leads',
    description: "Count leads matching filters. Use for 'how many leads', 'today new leads', 'won this month', etc.",
    parameters: {
      type: 'object',
      properties: {
        from:        { type: 'string', description: 'ISO date (YYYY-MM-DD) lower bound on created_at' },
        to:          { type: 'string', description: 'ISO date (YYYY-MM-DD) upper bound on created_at' },
        status:      { type: 'string', description: 'Status name e.g. New / Contacted / Won / Lost' },
        source:      { type: 'string', description: 'Source name e.g. Website / Facebook / Inbound Call' },
        assigned_to: { type: 'string', description: 'User name to filter by' }
      }
    }
  },
  { name: 'list_leads',
    description: "List recent leads matching filters (max 20). Use for 'show me 3 fresh leads', 'leads in TAT violation', etc.",
    parameters: {
      type: 'object',
      properties: {
        from:        { type: 'string' }, to: { type: 'string' },
        status:      { type: 'string' }, source: { type: 'string' },
        assigned_to: { type: 'string' },
        tat_breached: { type: 'boolean', description: 'Only return leads whose TAT is breached' },
        limit:       { type: 'number', description: 'Default 5; max 20' }
      }
    }
  },
  { name: 'report_summary',
    description: 'High-level KPI snapshot: total / new / won / lost counts + per-status + per-source.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } }
  },
  { name: 'employee_performance',
    description: 'Per-rep counts (total, new, open, won, lost) over a date range.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } }
  },
  { name: 'my_tasks_today',
    description: 'Tasks + follow-ups due today for the calling user.',
    parameters: { type: 'object', properties: {} }
  },
  { name: 'pipeline_funnel',
    description: 'Lead counts grouped by status, in pipeline order.',
    parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } }
  },
  { name: 'todays_calls',
    description: 'Calls logged today (incoming, outgoing, missed) — counts + sample.',
    parameters: { type: 'object', properties: {} }
  },
];

// ---- Tool implementations ------------------------------------------
function _todayBounds() {
  // "Today" = the calling tenant's local Asia/Kolkata calendar day.
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
  // Default: ALL TIME so totals match the dashboard. Pass
  // { defaultDays: 30 } to opt back into a recent window.
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
    const r = await db.query(
      `SELECT id FROM statuses WHERE LOWER(name) = LOWER($1) LIMIT 1`, [String(name)]
    );
    return r.rows[0]?.id || null;
  } catch (_) { return null; }
}
async function _resolveUserId(name) {
  if (!name) return null;
  try {
    const r = await db.query(
      `SELECT id FROM users WHERE LOWER(name) = LOWER($1) OR LOWER(email) = LOWER($1) LIMIT 1`,
      [String(name)]
    );
    return r.rows[0]?.id || null;
  } catch (_) { return null; }
}

async function _runTool(name, args, ctx) {
  switch (name) {
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
      return { count: Number(q.rows[0]?.c || 0), filters_used: args, period: { from: r.from, to: r.to } };
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
      // TAT breach: rough heuristic — leads in non-terminal status + last_status_change_at older than 24h
      if (args.tat_breached) {
        where += ` AND l.last_status_change_at < NOW() - INTERVAL '24 hours' AND COALESCE((SELECT is_final FROM statuses WHERE id = l.status_id LIMIT 1), 0) = 0`;
      }
      const q = await db.query(
        `SELECT l.id, l.name, l.phone, l.email, l.source, l.created_at,
                s.name AS status, u.name AS assigned_name
           FROM leads l
           LEFT JOIN statuses s ON s.id = l.status_id
           LEFT JOIN users u    ON u.id = l.assigned_to
          WHERE ${where}
          ORDER BY l.created_at DESC
          LIMIT ${limit}`,
        params
      );
      return { rows: q.rows, count_returned: q.rows.length };
    }
    case 'report_summary': {
      const r = _resolveBounds(args, { defaultDays: 30 });
      const total = (await db.query(`SELECT COUNT(*)::int AS c FROM leads WHERE created_at >= $1 AND created_at < $2`, [r.from, r.to])).rows[0]?.c || 0;
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
    case 'my_tasks_today': {
      const t = _todayBounds();
      const tasks = (await db.query(
        `SELECT id, title, due_at, is_done FROM tasks
          WHERE user_id = $1 AND COALESCE(is_done, 0) = 0
          ORDER BY due_at ASC NULLS LAST LIMIT 20`,
        [ctx.userId]
      ).catch(() => ({ rows: [] }))).rows;
      const followups = (await db.query(
        `SELECT f.id, f.due_at, f.note, l.id AS lead_id, l.name AS lead_name
           FROM followups f
           LEFT JOIN leads l ON l.id = f.lead_id
          WHERE f.user_id = $1 AND COALESCE(f.is_done, 0) = 0
            AND f.due_at >= $2 AND f.due_at < $3
          ORDER BY f.due_at ASC LIMIT 20`,
        [ctx.userId, t.from, t.to]
      ).catch(() => ({ rows: [] }))).rows;
      return { tasks, followups };
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
    case 'todays_calls': {
      const t = _todayBounds();
      const q = (await db.query(
        `SELECT direction, event, phone, lead_id, duration_s, created_at
           FROM call_events
          WHERE created_at >= $1 AND created_at < $2
          ORDER BY created_at DESC LIMIT 50`,
        [t.from, t.to]
      ).catch(() => ({ rows: [] }))).rows;
      const counts = q.reduce((a, x) => {
        const k = x.direction || 'unknown';
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {});
      return { counts, sample: q.slice(0, 10) };
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
//
// Called when Gemini ran a tool but returned no text (e.g. budget cut
// off, empty candidate, or model only emitted a function-call on the
// final turn). We turn the structured tool result into a readable
// answer so the user sees the data they asked for instead of a
// useless "(no answer)" bubble.
function _formatToolFallback(toolsCalled, question) {
  const lines = [];
  for (const t of toolsCalled) {
    const name = t.name;
    const r = t.result || {};
    if (r && r.error) {
      lines.push('⚠ ' + name + ': ' + r.error);
      continue;
    }
    if (name === 'count_leads') {
      lines.push('📊 You have **' + Number(r.count || 0).toLocaleString('en-IN') + '** matching lead(s).');
      if (r.period && r.period.from) lines.push('Period: ' + r.period.from + ' → ' + r.period.to);
    } else if (name === 'pipeline_funnel') {
      const stages = Array.isArray(r.stages) ? r.stages : [];
      const total = stages.reduce((a, s) => a + Number(s.c || 0), 0);
      lines.push('📊 **Pipeline funnel** (' + stages.length + ' statuses, ' + total.toLocaleString('en-IN') + ' leads total):');
      for (const s of stages) lines.push('• ' + s.name + ': ' + Number(s.c || 0).toLocaleString('en-IN'));
    } else if (name === 'list_leads') {
      const rows = Array.isArray(r.leads) ? r.leads : Array.isArray(r) ? r : [];
      if (!rows.length) { lines.push('No matching leads found.'); }
      else {
        lines.push('📋 Top ' + rows.length + ' lead(s):');
        for (const l of rows.slice(0, 10)) {
          const status = l.status_name || l.status || '';
          const assignee = l.assignee_name || l.assigned_to_name || '';
          const bits = [l.name || l.lead_name, l.company, status, assignee].filter(Boolean);
          lines.push('• ' + bits.join(' — '));
        }
      }
    } else if (name === 'employee_performance') {
      const rows = Array.isArray(r.rows) ? r.rows : Array.isArray(r) ? r : [];
      if (!rows.length) { lines.push('No performance data found for that period.'); }
      else {
        lines.push('👥 **Employee performance**:');
        for (const e of rows) {
          const bits = [e.user_name || e.name, 'leads:' + (e.leads || 0), 'won:' + (e.won || 0), 'remarks:' + (e.remarks || 0)].filter(Boolean);
          lines.push('• ' + bits.join(' · '));
        }
      }
    } else if (name === 'report_summary') {
      const k = (r.kpis || r);
      lines.push('📊 **Report summary**:');
      Object.keys(k).forEach(key => {
        if (typeof k[key] === 'object') return;
        lines.push('• ' + key.replace(/_/g, ' ') + ': ' + k[key]);
      });
    } else if (name === 'my_tasks_today') {
      const tasks = (r.tasks || []), fus = (r.followups || []);
      lines.push('✅ **Today\u2019s plate**: ' + tasks.length + ' task(s), ' + fus.length + ' follow-up(s)');
      tasks.slice(0, 5).forEach(t => lines.push('• Task: ' + (t.title || t.task || '(untitled)')));
      fus.slice(0, 5).forEach(f => lines.push('• Follow-up #' + (f.lead_id || '?') + ': ' + (f.note || '')));
    } else if (name === 'todays_calls') {
      const c = r.counts || {};
      lines.push('📞 **Today\u2019s calls** — ' + (Object.entries(c).map(([k, v]) => k + ': ' + v).join(' · ') || 'none yet'));
    } else {
      try {
        const s = JSON.stringify(r, null, 2);
        if (s.length < 1500) lines.push('```\n' + s + '\n```');
        else lines.push('(Tool ' + name + ' returned ' + s.length + ' chars of data)');
      } catch (_) { lines.push('(Tool ' + name + ' returned non-serialisable data)'); }
    }
  }
  if (!lines.length) return '';
  return lines.join('\n') + '\n\n_(Synthesised from tool data — Gemini\u2019s narrative response was empty.)_';
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
- ONLY answer questions about leads, calls, tasks, follow-ups, employees, status, sources, pipeline, and reports for this CRM.
- ALWAYS use the provided tools to fetch real data — never fabricate counts or names.
- When the user asks for a TOTAL or "across the CRM" without specifying a time window, DO NOT pass from/to to the tools — leave them out so the tool returns ALL leads (not just last 30 days).
- Only pass from/to when the user explicitly mentions a date range ("today", "this week", "last month", "in March", etc.).
- If the user asks something off-topic (general world knowledge, code, etc.), politely refuse and remind them this is a CRM-only assistant.
- Be concise. Format numerical answers as bullet lists when listing multiple items. Use "₹" for INR amounts.
- After every tool call, ALWAYS produce a short natural-language summary of the result. Never end your turn silently.
- Today's date is ${new Date().toISOString().slice(0, 10)} (UTC). The user is in IST.
- Calling user: ${me.name} (role: ${me.role}).`;

  const ctx = { userId: me.id, userName: me.name, userRole: me.role };
  const hist = Array.isArray(history) ? history.slice(-6).map(h => ({
    role: h && h.role === 'model' ? 'model' : 'user',
    text: String((h && h.text) || '').slice(0, 4000)
  })).filter(h => h.text) : [];

  const result = await gemini.generateWithTools({
    system, history: hist, prompt: text,
    tools: TOOLS,
    runTool: (name, args) => _runTool(name, args, ctx),
    maxTurns: 6, maxOutputTokens: 1500, temperature: 0.2,
  });

  // Persist the call regardless of success — counts toward the daily
  // quota (so a flood of failures still gets capped).
  let answer = result.text || '';

  // Fallback: if Gemini returned no text but at least one tool ran
  // successfully, synthesize a human-readable answer from the tool
  // result so the user doesn't see "(no answer)" when the data is
  // actually right there. This covers MAX_TOKENS, empty candidate,
  // or model-only-emits-functioncall cases.
  if (!answer && Array.isArray(result.tools_called) && result.tools_called.length) {
    answer = _formatToolFallback(result.tools_called, text);
  }

  // Polite default if even the tool fallback came up empty.
  if (!answer) {
    answer = "I wasn\u2019t able to put together an answer for that one. Try asking me about your CRM data directly — for example:\n" +
             "• How many leads do I have in total?\n" +
             "• Show me 5 fresh leads\n" +
             "• Which leads are out of TAT?\n" +
             "• Employee performance this month\n" +
             "• What\u2019s on my plate today?";
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

  // Log to control usage table for super-admin costing visibility.
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
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [me.id]
    );
    recent = r.rows;
  } catch (_) {}
  return { today: used, daily_limit: limit, recent };
}

module.exports = { api_copilot_ask, api_copilot_usage };
