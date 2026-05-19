/**
 * routes/reportTemplates.js — REPORT_SCHEDULE_v1
 *
 * Tenants save Report Builder configurations as named templates, then
 * schedule them to be emailed / WhatsApp'd to specific recipients on a
 * daily / weekly / monthly cadence.
 *
 * Storage:
 *   report_templates    — admin-saved Report Builder configs
 *   report_schedules    — { template_id, frequency, recipients, last_run, next_run }
 *
 * The actual report data is computed by re-running api_reports_groupBy with
 * the saved filters + dim. The result is rendered as an HTML table for email
 * and a compact text summary for WhatsApp.
 *
 * Worker:
 *   tickScheduledReports() — called hourly per tenant from server.js. Walks
 *   enabled schedules whose next_run_at <= NOW, runs them, dispatches via
 *   utils/mailer.sendRaw + whatsbot._sendText, advances next_run_at.
 */
const db = require('../db/pg');
const { authUser } = require('../utils/auth');

// ---------- schema bootstrap ----------
let _ensured = false;
async function ensureSchema() {
  if (_ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS report_templates (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      dim         TEXT NOT NULL,
      filters_json TEXT NOT NULL DEFAULT '{}',
      created_by  INT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS report_schedules (
      id            SERIAL PRIMARY KEY,
      template_id   INT NOT NULL,
      name          TEXT,
      frequency     TEXT NOT NULL DEFAULT 'daily',  -- daily | weekly | monthly
      hour          INT  NOT NULL DEFAULT 9,         -- 0–23, in REPORT_TZ
      minute        INT  NOT NULL DEFAULT 0,
      day_of_week   INT,                              -- 0=Sun..6=Sat (weekly only)
      day_of_month  INT,                              -- 1..28      (monthly only)
      recipients_email    TEXT NOT NULL DEFAULT '[]',   -- JSON array of emails
      recipients_whatsapp TEXT NOT NULL DEFAULT '[]',   -- JSON array of phone numbers
      message_template    TEXT,                          -- prepended to body
      enabled       INT  NOT NULL DEFAULT 1,
      last_run_at   TIMESTAMPTZ,
      next_run_at   TIMESTAMPTZ,
      last_error    TEXT,
      created_by    INT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_rs_next_run ON report_schedules(next_run_at) WHERE enabled = 1`);
  _ensured = true;
}

const REPORT_TZ = process.env.TIMEZONE || 'Asia/Kolkata';

// ---------- next-run calc ----------
function _computeNextRun(sched, fromDate) {
  const base = fromDate ? new Date(fromDate) : new Date();
  // Express base in REPORT_TZ-day; pick the next H:MM on the right calendar day
  const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const tzNow = tzFmt.format(base);  // YYYY-MM-DD in TZ
  let candidate = new Date(tzNow + 'T' + String(sched.hour || 9).padStart(2, '0') + ':' + String(sched.minute || 0).padStart(2, '0') + ':00');
  // candidate is "midnight of TZ-today + H:M" interpreted as local; force to TZ offset via cheap loop
  while (candidate <= base) {
    if (sched.frequency === 'weekly') {
      // Advance day by day until the weekday matches
      candidate.setDate(candidate.getDate() + 1);
      if (Number(sched.day_of_week) === candidate.getUTCDay()) break;
    } else if (sched.frequency === 'monthly') {
      candidate.setMonth(candidate.getMonth() + 1);
      candidate.setDate(Number(sched.day_of_month) || 1);
    } else {  // daily
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return candidate;
}

// ---------- templates CRUD ----------
async function api_reportTemplate_list(token) {
  await authUser(token);
  await ensureSchema();
  const r = await db.query(`SELECT * FROM report_templates ORDER BY id DESC`);
  return r.rows.map(row => Object.assign({}, row, {
    filters: (() => { try { return JSON.parse(row.filters_json || '{}'); } catch (_) { return {}; } })()
  }));
}

async function api_reportTemplate_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager', 'team_leader'].includes(me.role)) throw new Error('Manager only');
  await ensureSchema();
  const p = payload || {};
  if (!p.name) throw new Error('name required');
  if (!p.dim)  throw new Error('dim required');
  const filters = p.filters && typeof p.filters === 'object' ? p.filters : {};
  if (p.id) {
    await db.query(
      `UPDATE report_templates SET name=$1, description=$2, dim=$3, filters_json=$4, updated_at=NOW() WHERE id=$5`,
      [String(p.name).slice(0, 200), String(p.description || '').slice(0, 1000),
       String(p.dim), JSON.stringify(filters), Number(p.id)]
    );
    return { ok: true, id: Number(p.id) };
  } else {
    const r = await db.query(
      `INSERT INTO report_templates (name, description, dim, filters_json, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [String(p.name).slice(0, 200), String(p.description || '').slice(0, 1000),
       String(p.dim), JSON.stringify(filters), me.id]
    );
    return { ok: true, id: r.rows[0].id };
  }
}

async function api_reportTemplate_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  await ensureSchema();
  await db.query(`DELETE FROM report_schedules WHERE template_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM report_templates WHERE id = $1`,           [Number(id)]);
  return { ok: true };
}

async function api_reportTemplate_run(token, id) {
  await authUser(token);
  await ensureSchema();
  const r = await db.query(`SELECT * FROM report_templates WHERE id = $1`, [Number(id)]);
  const tpl = r.rows[0];
  if (!tpl) throw new Error('Template not found');
  const filters = (() => { try { return JSON.parse(tpl.filters_json || '{}'); } catch (_) { return {}; } })();
  // Re-run via the existing groupBy endpoint
  const reports = require('./reports');
  const data = await reports.api_reports_groupBy(token, filters, tpl.dim);
  return { template: tpl, filters, data };
}

// ---------- schedules CRUD ----------
async function api_reportSchedule_list(token, templateId) {
  await authUser(token);
  await ensureSchema();
  const where = templateId ? 'WHERE template_id = $1' : '';
  const params = templateId ? [Number(templateId)] : [];
  const r = await db.query(
    `SELECT rs.*, rt.name AS template_name, rt.dim AS template_dim
       FROM report_schedules rs
       LEFT JOIN report_templates rt ON rt.id = rs.template_id
       ${where}
       ORDER BY rs.id DESC`, params);
  return r.rows.map(row => Object.assign({}, row, {
    recipients_email:    (() => { try { return JSON.parse(row.recipients_email    || '[]'); } catch (_) { return []; } })(),
    recipients_whatsapp: (() => { try { return JSON.parse(row.recipients_whatsapp || '[]'); } catch (_) { return []; } })()
  }));
}

async function api_reportSchedule_save(token, payload) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  await ensureSchema();
  const p = payload || {};
  if (!p.template_id) throw new Error('template_id required');
  const tpl = (await db.query(`SELECT * FROM report_templates WHERE id = $1`, [Number(p.template_id)])).rows[0];
  if (!tpl) throw new Error('Template not found');

  const sched = {
    template_id:  Number(p.template_id),
    name:         String(p.name || tpl.name).slice(0, 200),
    frequency:    ['daily', 'weekly', 'monthly'].includes(p.frequency) ? p.frequency : 'daily',
    hour:         Math.max(0, Math.min(23, Number(p.hour ?? 9))),
    minute:       Math.max(0, Math.min(59, Number(p.minute ?? 0))),
    day_of_week:  p.day_of_week == null ? null : Math.max(0, Math.min(6,  Number(p.day_of_week))),
    day_of_month: p.day_of_month == null ? null : Math.max(1, Math.min(28, Number(p.day_of_month))),
    recipients_email:    Array.isArray(p.recipients_email)    ? p.recipients_email.filter(Boolean).map(String)    : [],
    recipients_whatsapp: Array.isArray(p.recipients_whatsapp) ? p.recipients_whatsapp.filter(Boolean).map(String) : [],
    message_template: String(p.message_template || '').slice(0, 2000),
    enabled: p.enabled === false || Number(p.enabled) === 0 ? 0 : 1
  };
  const nextRun = _computeNextRun(sched);

  if (p.id) {
    await db.query(
      `UPDATE report_schedules SET template_id=$1, name=$2, frequency=$3, hour=$4, minute=$5,
          day_of_week=$6, day_of_month=$7, recipients_email=$8, recipients_whatsapp=$9,
          message_template=$10, enabled=$11, next_run_at=$12
        WHERE id=$13`,
      [sched.template_id, sched.name, sched.frequency, sched.hour, sched.minute,
       sched.day_of_week, sched.day_of_month,
       JSON.stringify(sched.recipients_email), JSON.stringify(sched.recipients_whatsapp),
       sched.message_template, sched.enabled, nextRun, Number(p.id)]
    );
    return { ok: true, id: Number(p.id), next_run_at: nextRun };
  } else {
    const r = await db.query(
      `INSERT INTO report_schedules
         (template_id, name, frequency, hour, minute, day_of_week, day_of_month,
          recipients_email, recipients_whatsapp, message_template, enabled, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [sched.template_id, sched.name, sched.frequency, sched.hour, sched.minute,
       sched.day_of_week, sched.day_of_month,
       JSON.stringify(sched.recipients_email), JSON.stringify(sched.recipients_whatsapp),
       sched.message_template, sched.enabled, nextRun, me.id]
    );
    return { ok: true, id: r.rows[0].id, next_run_at: nextRun };
  }
}

async function api_reportSchedule_delete(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  await ensureSchema();
  await db.query(`DELETE FROM report_schedules WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

// ---------- send helpers ----------
function _esc(s) { return String(s || '').replace(/[&<>]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }

function _renderHtml(tpl, data) {
  const rows = (data && data.rows) || [];
  const total = (data && data.total) || rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
  let html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937">';
  html += '<h2 style="color:#3b82f6;margin:0 0 4px">' + _esc(tpl.name) + '</h2>';
  html += '<p style="color:#6b7280;margin:0 0 16px;font-size:13px">' + _esc(tpl.description || '') + '</p>';
  html += '<p style="margin:0 0 12px"><b>' + total + '</b> total leads · grouped by <b>' + _esc(tpl.dim) + '</b></p>';
  html += '<table cellpadding="6" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:640px;border:1px solid #e5e7eb">';
  html += '<thead style="background:#f3f4f6"><tr><th align="left">' + _esc(tpl.dim) + '</th><th align="right">Count</th></tr></thead><tbody>';
  rows.forEach(r => {
    html += '<tr><td style="border-top:1px solid #e5e7eb">' + _esc(r.value || '—') + '</td>' +
            '<td style="border-top:1px solid #e5e7eb;text-align:right"><b>' + Number(r.count) + '</b></td></tr>';
  });
  html += '</tbody></table>';
  html += '<p style="color:#9ca3af;font-size:11px;margin-top:16px">Sent by SmartCRM · ' + new Date().toLocaleString('en-IN', { timeZone: REPORT_TZ }) + '</p></div>';
  return html;
}

function _renderText(tpl, data, prefix) {
  const rows = (data && data.rows) || [];
  const total = (data && data.total) || rows.reduce((n, r) => n + (Number(r.count) || 0), 0);
  let txt = (prefix ? prefix.trim() + '\n\n' : '');
  txt += '*' + tpl.name + '*\n';
  if (tpl.description) txt += '_' + tpl.description + '_\n';
  txt += '\nTotal: *' + total + '* leads (by ' + tpl.dim + ')\n\n';
  rows.slice(0, 15).forEach(r => { txt += '• ' + (r.value || '—') + ' — *' + r.count + '*\n'; });
  if (rows.length > 15) txt += '\n…and ' + (rows.length - 15) + ' more rows.';
  return txt;
}

async function _runOneSchedule(token, schedule) {
  const tplR = await db.query(`SELECT * FROM report_templates WHERE id = $1`, [schedule.template_id]);
  const tpl = tplR.rows[0];
  if (!tpl) return { ok: false, error: 'Template missing' };
  const filters = (() => { try { return JSON.parse(tpl.filters_json || '{}'); } catch (_) { return {}; } })();
  const reports = require('./reports');
  const data = await reports.api_reports_groupBy(token, filters, tpl.dim);

  const html = _renderHtml(tpl, data);
  const text = _renderText(tpl, data, schedule.message_template);
  const subject = '[CRM Report] ' + tpl.name + ' — ' + new Date().toLocaleDateString('en-IN', { timeZone: REPORT_TZ });

  const emails    = (() => { try { return JSON.parse(schedule.recipients_email    || '[]'); } catch (_) { return []; } })();
  const whatsapps = (() => { try { return JSON.parse(schedule.recipients_whatsapp || '[]'); } catch (_) { return []; } })();

  const results = { email: [], whatsapp: [] };
  if (emails.length) {
    const mailer = require('../utils/mailer');
    for (const to of emails) {
      try { await mailer.sendRaw(to, subject, html); results.email.push({ to, ok: true }); }
      catch (e) { results.email.push({ to, ok: false, error: e.message }); }
    }
  }
  if (whatsapps.length) {
    let whatsbot; try { whatsbot = require('./whatsbot'); } catch (_) {}
    if (whatsbot && whatsbot._sendText && whatsbot._cfg) {
      const cfg = await whatsbot._cfg().catch(() => null);
      for (const to of whatsapps) {
        try { const r = await whatsbot._sendText({ to: String(to), text }, cfg); results.whatsapp.push({ to, ok: !!r, response: r }); }
        catch (e) { results.whatsapp.push({ to, ok: false, error: e.message }); }
      }
    } else {
      results.whatsapp.push({ ok: false, error: 'whatsbot._sendText unavailable' });
    }
  }
  return { ok: true, results };
}

async function api_reportSchedule_runNow(token, id) {
  const me = await authUser(token);
  if (!['admin', 'manager'].includes(me.role)) throw new Error('Admin or Manager only');
  await ensureSchema();
  const r = await db.query(`SELECT * FROM report_schedules WHERE id = $1`, [Number(id)]);
  const sch = r.rows[0];
  if (!sch) throw new Error('Schedule not found');
  const out = await _runOneSchedule(token, sch);
  await db.query(`UPDATE report_schedules SET last_run_at=NOW(), last_error=$2 WHERE id=$1`,
    [Number(id), out.ok ? null : (out.error || 'unknown')]);
  return out;
}

// ---------- worker: hourly tick ----------
async function tickScheduledReports(systemToken) {
  await ensureSchema();
  const due = await db.query(
    `SELECT * FROM report_schedules
       WHERE enabled = 1
         AND (next_run_at IS NULL OR next_run_at <= NOW())
       ORDER BY id LIMIT 50`);
  let ran = 0;
  for (const sch of due.rows) {
    try {
      // systemToken is a per-tenant admin token; if absent (in worker context),
      // fabricate a minimal auth by calling reports directly via internal API.
      // The reports module's authUser will skip when called inline — but we
      // require it. Workaround: build a service token via first admin user.
      let tokenToUse = systemToken;
      if (!tokenToUse) {
        const admin = (await db.query(`SELECT id, email FROM users WHERE role='admin' ORDER BY id LIMIT 1`)).rows[0];
        if (!admin) continue;
        const { signToken } = require('../utils/auth');
        tokenToUse = signToken({ id: admin.id, email: admin.email, role: 'admin' });
      }
      const out = await _runOneSchedule(tokenToUse, sch);
      const next = _computeNextRun(sch, new Date());
      await db.query(
        `UPDATE report_schedules SET last_run_at=NOW(), next_run_at=$1, last_error=$2 WHERE id=$3`,
        [next, out.ok ? null : (out.error || 'unknown'), sch.id]
      );
      ran += 1;
    } catch (e) {
      await db.query(`UPDATE report_schedules SET last_error=$1 WHERE id=$2`, [String(e.message).slice(0, 500), sch.id]);
      console.warn('[reportSchedule] ' + sch.id + ' failed:', e.message);
    }
  }
  return { ok: true, ran };
}

module.exports = {
  ensureSchema, tickScheduledReports,
  api_reportTemplate_list, api_reportTemplate_save,
  api_reportTemplate_delete, api_reportTemplate_run,
  api_reportSchedule_list, api_reportSchedule_save,
  api_reportSchedule_delete, api_reportSchedule_runNow
};
