/**
 * Cashfree webhook logs — admin read-only listing.
 *
 *   /admin → Webhook Logs tab
 *   - newest first
 *   - filter by status (SUCCESS / FAILED / PENDING / …) + entity type
 *     (payment / refund / order)
 *   - click a row to inspect the raw payload + processing result
 */
const control = require('../../control/db');
const { requireSuperAdmin } = require('./superAdminAuth');

async function api_saas_webhookLogs_list(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  const where = []; const params = [];
  if (f.status)        { params.push(String(f.status).toUpperCase()); where.push(`status = $${params.length}`); }
  if (f.entity_type)   { params.push(f.entity_type); where.push(`entity_type = $${params.length}`); }
  if (f.webhook_type)  { params.push(String(f.webhook_type).toUpperCase()); where.push(`webhook_type = $${params.length}`); }
  if (f.order_id)      { params.push(f.order_id); where.push(`order_id = $${params.length}`); }
  if (f.from)          { params.push(f.from); where.push(`created_at >= $${params.length}`); }
  if (f.to)            { params.push(f.to);   where.push(`created_at <= $${params.length}`); }
  const sql = `
    SELECT id, webhook_type, entity_type, status, amount_inr, order_id,
           cf_payment_id, payment_method, customer_email, customer_phone,
           processed, signature_ok, result_message, signup_id, tenant_id,
           created_at
      FROM cashfree_webhook_logs
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY id DESC LIMIT 500`;
  const r = await control.query(sql, params);
  return r.rows;
}

async function api_saas_webhookLogs_get(token, id) {
  await requireSuperAdmin(token);
  return control.findById('cashfree_webhook_logs', id);
}

async function api_saas_webhookLogs_summary(token, filters) {
  await requireSuperAdmin(token);
  const f = filters || {};
  /* WEBHOOK_LOGS_v2 — totals + per-status grouping with optional date
   * range. Mirrors the same WHERE clause as _list so the dashboard
   * stays in sync with whatever rows the table is showing. */
  const where = []; const params = [];
  if (f.entity_type)  { params.push(f.entity_type);                          where.push('entity_type = $' + params.length); }
  if (f.webhook_type) { params.push(String(f.webhook_type).toUpperCase()); where.push('webhook_type = $' + params.length); }
  if (f.order_id)     { params.push(f.order_id);                            where.push('order_id = $' + params.length); }
  if (f.from)         { params.push(f.from);                                where.push('created_at >= $' + params.length); }
  if (f.to)           { params.push(f.to);                                  where.push('created_at <= $' + params.length); }
  const sql = `
    SELECT UPPER(COALESCE(status, '')) AS status,
           COUNT(*)::int        AS cnt,
           COALESCE(SUM(amount_inr), 0)::numeric AS amount_sum
      FROM cashfree_webhook_logs
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY UPPER(COALESCE(status, ''))`;
  const r = await control.query(sql, params);
  const out = { success: { count: 0, amount: 0 },
                failed:  { count: 0, amount: 0 },
                pending: { count: 0, amount: 0 },
                other:   { count: 0, amount: 0 },
                total:   { count: 0, amount: 0 },
                by_status: {} };
  r.rows.forEach(row => {
    const c = Number(row.cnt) || 0;
    const a = Number(row.amount_sum) || 0;
    out.by_status[row.status || ''] = { count: c, amount: a };
    out.total.count  += c;
    out.total.amount += a;
    if (row.status === 'SUCCESS' || row.status === 'PAID') {
      out.success.count += c; out.success.amount += a;
    } else if (row.status === 'FAILED' || row.status === 'CANCELLED' || row.status === 'USER_DROPPED') {
      out.failed.count += c; out.failed.amount += a;
    } else if (row.status === 'PENDING') {
      out.pending.count += c; out.pending.amount += a;
    } else {
      out.other.count += c; out.other.amount += a;
    }
  });
  out.total.amount   = Math.round(out.total.amount   * 100) / 100;
  out.success.amount = Math.round(out.success.amount * 100) / 100;
  out.failed.amount  = Math.round(out.failed.amount  * 100) / 100;
  out.pending.amount = Math.round(out.pending.amount * 100) / 100;
  return out;
}

module.exports = {
  api_saas_webhookLogs_list,
  api_saas_webhookLogs_get,
  api_saas_webhookLogs_summary  /* WEBHOOK_LOGS_v2 */
};
