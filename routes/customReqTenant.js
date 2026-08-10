/**
 * CUSTOM_REQ_TENANT_v1 — tenant-side Custom Requirements.
 *
 * A tenant submits a custom requirement ("I want feature X") and then chats
 * back-and-forth with the super-admin, who verifies it and quotes a price.
 * The data lives in the CONTROL DB (custom_requirements + the new
 * custom_requirement_messages thread) so it lands in the super-admin queue.
 *
 * SECURITY: the tenant_id is derived server-side from the authenticated tenant
 * context (the request's tenant slug) — it is NEVER taken from the client, so a
 * tenant can only ever see / post to its own requirements.
 */
const control = require('../control/db');
const tdb = require('../db/pg');
const { authUser } = require('../utils/auth');

async function _ctxTenant() {
  const store = (tdb.tenantStorage && tdb.tenantStorage.getStore && tdb.tenantStorage.getStore()) || {};
  if (store.tenant && store.tenant.id) return { id: Number(store.tenant.id) };
  const slug = store.slug || (store.tenant && store.tenant.slug) || '';
  if (!slug) throw new Error('Tenant context missing');
  const r = await control.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
  if (!r.rows.length) throw new Error('Tenant not found');
  return { id: Number(r.rows[0].id) };
}

async function _ensureSchema() {
  await control.query(`CREATE TABLE IF NOT EXISTS custom_requirement_messages (
    id SERIAL PRIMARY KEY,
    cr_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL,          -- 'tenant' | 'admin'
    sender_name TEXT,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await control.query(`CREATE INDEX IF NOT EXISTS idx_cr_msg_thread ON custom_requirement_messages(cr_id, id)`);
}

async function _ownedCr(crId, tenantId) {
  const cr = await control.findById('custom_requirements', Number(crId));
  if (!cr || Number(cr.tenant_id) !== Number(tenantId)) throw new Error('Requirement not found');
  return cr;
}

/** List the tenant's own requirements (newest first, with message counts). */
async function api_customreq_mine(token) {
  await authUser(token);
  const t = await _ctxTenant();
  await _ensureSchema();
  const r = await control.query(
    `SELECT cr.id, cr.title, cr.description, cr.status, cr.quote_inr, cr.created_at, cr.updated_at,
            (SELECT COUNT(*) FROM custom_requirement_messages m WHERE m.cr_id = cr.id)::int AS message_count
       FROM custom_requirements cr
      WHERE cr.tenant_id = $1
      ORDER BY cr.id DESC`, [t.id]);
  return r.rows;
}

/** Submit a new requirement — the description becomes the first thread message. */
async function api_customreq_submit(token, payload) {
  const me = await authUser(token);
  const t = await _ctxTenant();
  await _ensureSchema();
  const p = payload || {};
  const title = String(p.title || '').trim();
  const desc = String(p.description || '').trim();
  if (!title || !desc) throw new Error('Please enter a title and describe your requirement.');
  const who = me.name || me.email || 'Tenant';
  const id = await control.insert('custom_requirements', {
    tenant_id: t.id, submitted_by: me.email || me.name || '',
    title: title.slice(0, 200), description: desc.slice(0, 5000), status: 'open'
  });
  await control.insert('custom_requirement_messages', {
    cr_id: id, sender_type: 'tenant', sender_name: who, message: desc.slice(0, 5000)
  });
  try {
    await control.insert('audit_log', {
      actor_type: 'tenant', tenant_id: t.id, event: 'custom_req.submitted',
      detail: JSON.stringify({ id, title })
    });
  } catch (_) {}
  return { id, ok: true };
}

/** Full discussion thread for one of the tenant's requirements. */
async function api_customreq_thread(token, crId) {
  await authUser(token);
  const t = await _ctxTenant();
  await _ensureSchema();
  const cr = await _ownedCr(crId, t.id);
  const r = await control.query(
    `SELECT id, sender_type, sender_name, message, created_at
       FROM custom_requirement_messages WHERE cr_id = $1 ORDER BY id ASC`, [cr.id]);
  return { requirement: cr, messages: r.rows };
}

/** Tenant posts a reply into the thread. */
async function api_customreq_postMessage(token, payload) {
  const me = await authUser(token);
  const t = await _ctxTenant();
  await _ensureSchema();
  const p = payload || {};
  const cr = await _ownedCr(p.cr_id, t.id);
  const msg = String(p.message || '').trim();
  if (!msg) throw new Error('Message is empty');
  const id = await control.insert('custom_requirement_messages', {
    cr_id: cr.id, sender_type: 'tenant', sender_name: me.name || me.email || 'Tenant', message: msg.slice(0, 5000)
  });
  try { await control.update('custom_requirements', cr.id, { updated_at: new Date().toISOString() }); } catch (_) {}
  return { id, ok: true };
}

module.exports = {
  api_customreq_mine,
  api_customreq_submit,
  api_customreq_thread,
  api_customreq_postMessage
};
