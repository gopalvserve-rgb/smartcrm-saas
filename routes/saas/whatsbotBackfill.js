/**
 * WhatsApp forwarder backfill — super-admin only.
 *
 * Re-registers every active tenant that already has a saved
 * WHATSAPP_PHONE_NUMBER_ID with the central PHP forwarder at
 * smartcrmsolution.com/whatsbot_register.php.
 *
 * Why: tenants that connected WhatsApp BEFORE the slug-aware
 * registration code shipped have entries in wa_connections.json
 * with `webhook_url = https://crm.smartcrmsolution.com/hook/whatsapp_webhook`
 * (no `/t/<slug>/` prefix). The forwarder still routes correctly
 * via the slow path on the SaaS side, but it's slower and brittle.
 * Calling this once after the env vars FORWARDER_REGISTER_URL +
 * FORWARDER_REGISTER_SECRET are set replaces every entry with the
 * proper tenant-scoped URL.
 *
 * It's also safe to re-run — the PHP register endpoint UPDATEs
 * existing rows by phone_number_id, so duplicates won't appear.
 *
 * Usage from the super-admin panel (or curl):
 *
 *   POST /api  (super-admin token)
 *   { "fn": "api_saas_wb_backfill_forwarder", "args": [] }
 *
 * Returns:
 *   {
 *     processed: <int>,        // tenants that had a phone_number_id
 *     skipped:   <int>,        // tenants without phone_number_id
 *     ok:        <int>,        // POSTs that returned 2xx
 *     failed:    <int>,        // POSTs that errored or non-2xx
 *     details: [
 *       { slug, phone_number_id, ok, error?, http_status? },
 *       ...
 *     ]
 *   }
 */

const control = require('../../control/db');
const tenantPool = require('../../utils/tenantPool');
const { requireSuperAdmin } = require('./superAdminAuth');

async function api_saas_wb_backfill_forwarder(token) {
  await requireSuperAdmin(token);

  const url    = process.env.FORWARDER_REGISTER_URL || '';
  const secret = process.env.FORWARDER_REGISTER_SECRET || '';
  const platformBase = (
    process.env.PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    ''
  ).replace(/\/+$/, '');

  if (!url) throw new Error('FORWARDER_REGISTER_URL env var is not set on this Railway service.');
  if (!secret) throw new Error('FORWARDER_REGISTER_SECRET env var is not set on this Railway service.');
  if (!platformBase) throw new Error('PUBLIC_BASE_URL / BASE_URL env var is not set — needed to derive each tenant webhook URL.');

  // Walk every active tenant. We deliberately ignore suspended /
  // pending_payment / deleted statuses so we don't re-register
  // workspaces that shouldn't be receiving Meta traffic.
  const tenants = await control.query(
    `SELECT id, slug FROM tenants
      WHERE status IN ('active','trial','past_due')
      ORDER BY id ASC`
  );

  const details = [];
  let processed = 0, skipped = 0, ok = 0, failed = 0;

  for (const row of tenants.rows) {
    const slug = row.slug;
    let t;
    try { t = await tenantPool.findActiveTenant(slug); } catch (_) { t = null; }
    if (!t) { skipped++; details.push({ slug, ok: false, error: 'tenant pool unavailable' }); continue; }

    const pool = tenantPool.poolFor(t);
    if (!pool) { skipped++; details.push({ slug, ok: false, error: 'tenant pool unavailable' }); continue; }

    let phoneId = '', wabaId = '', companyName = '';
    try {
      const cfg = await pool.query(
        `SELECT key, value FROM config
          WHERE key IN ('WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_BUSINESS_ACCOUNT_ID','COMPANY_NAME')`
      );
      for (const r of cfg.rows) {
        if (r.key === 'WHATSAPP_PHONE_NUMBER_ID')     phoneId = String(r.value || '').trim();
        else if (r.key === 'WHATSAPP_BUSINESS_ACCOUNT_ID') wabaId = String(r.value || '').trim();
        else if (r.key === 'COMPANY_NAME')             companyName = String(r.value || '').trim();
      }
    } catch (e) {
      skipped++;
      details.push({ slug, ok: false, error: 'config lookup failed: ' + e.message });
      continue;
    }

    if (!phoneId) {
      skipped++;
      details.push({ slug, ok: false, error: 'no WHATSAPP_PHONE_NUMBER_ID configured' });
      continue;
    }

    processed++;

    const webhookUrl = `${platformBase}/t/${slug}/hook/whatsapp_webhook`;
    let httpStatus = 0, body = '';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Register-Secret': secret
        },
        body: JSON.stringify({
          phone_number_id:     phoneId,
          business_account_id: wabaId,
          tenant_name:         companyName || slug,
          webhook_url:         webhookUrl
        })
      });
      httpStatus = r.status;
      body = await r.text();
      if (r.status >= 200 && r.status < 300) {
        ok++;
        details.push({ slug, phone_number_id: phoneId, webhook_url: webhookUrl, ok: true, http_status: httpStatus });
      } else {
        failed++;
        details.push({ slug, phone_number_id: phoneId, webhook_url: webhookUrl, ok: false, http_status: httpStatus, error: (body || '').slice(0, 300) });
      }
    } catch (e) {
      failed++;
      details.push({ slug, phone_number_id: phoneId, webhook_url: webhookUrl, ok: false, error: e.message });
    }
  }

  return { processed, skipped, ok, failed, details };
}

module.exports = { api_saas_wb_backfill_forwarder };
