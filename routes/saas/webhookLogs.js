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

module.exports = {
  api_saas_webhookLogs_list,
  api_saas_webhookLogs_get
};
