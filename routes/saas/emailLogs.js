/* EMAIL_LOG_v1 (2026-07-20) — super-admin view of every platform email send.
 * Fed by routes/saas/saasMailer._logEmail (welcome, invoice, password reset,
 * SMTP test). Control-DB table email_logs. */
const control = require('../../control/db');
/* EMAIL_LOG_v1 fix — super-admin endpoints authenticate against the CONTROL
 * users via requireSuperAdmin, NOT the tenant-scoped authUser (which has no
 * tenant pool in the super-admin context and threw "API error"). */
const { requireSuperAdmin } = require('./superAdminAuth');

async function api_saas_email_logs_list(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  const lim = Math.min(500, Math.max(1, Number(f.limit) || 100));
  const where = []; const params = [];
  if (f.context)  { params.push(String(f.context));                    where.push('context = $' + params.length); }
  if (f.q)        { params.push('%' + String(f.q).toLowerCase() + '%'); where.push('(LOWER(to_email) LIKE $' + params.length + ' OR LOWER(subject) LIKE $' + params.length + ')'); }
  if (f.only_failed) where.push('success = 0');
  let rows = [];
  try {
    const r = await control.query(
      `SELECT * FROM email_logs
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC LIMIT ${lim}`, params);
    rows = r.rows;
  } catch (e) {
    // Table not created yet (no email sent since deploy) — return empty.
    if (!/does not exist/i.test(e.message)) throw e;
  }
  // Small summary for the header cards
  let summary = { total: 0, failed: 0, sent: 0 };
  try {
    const s = await control.query(`SELECT COUNT(*)::int AS total,
       SUM(CASE WHEN success=1 THEN 1 ELSE 0 END)::int AS sent,
       SUM(CASE WHEN success=0 THEN 1 ELSE 0 END)::int AS failed
       FROM email_logs WHERE created_at > NOW() - INTERVAL '7 days'`);
    if (s.rows[0]) summary = s.rows[0];
  } catch (_) {}
  return { logs: rows, summary };
}

module.exports = { api_saas_email_logs_list };
