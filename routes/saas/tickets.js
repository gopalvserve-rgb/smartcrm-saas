/**
 * Support Tickets — cross-tenant ticket system.
 *
 * Tenants raise tickets from inside their CRM (Help & Support sidebar).
 * Super-admin manages them from /admin → Tickets. The control DB holds
 * every ticket so super-admin can list/filter across all tenants in one
 * place; tenant DBs are never touched.
 *
 * APIs (all start with api_saas_tk_* so the SAAS_API dispatcher picks them up):
 *   Tenant-side (verified via the tenant CRM's JWT, scoped to that tenant):
 *     api_saas_tk_categories         — static list, no auth
 *     api_saas_tk_submit             — create new ticket
 *     api_saas_tk_listMine           — list this tenant's tickets
 *     api_saas_tk_getMine            — get one ticket (must belong to tenant)
 *     api_saas_tk_replyTenant        — tenant adds a reply
 *     api_saas_tk_closeMine          — tenant marks a ticket resolved
 *     api_saas_tk_reopenMine         — tenant reopens a resolved ticket
 *
 *   Super-admin (verified via requireSuperAdmin):
 *     api_saas_tk_admin_listAll      — list every tenant's tickets
 *     api_saas_tk_admin_get          — get one (includes internal notes)
 *     api_saas_tk_admin_reply        — admin replies (optionally internal)
 *     api_saas_tk_admin_setStatus    — change status
 *     api_saas_tk_admin_setPriority  — change priority
 *     api_saas_tk_admin_assign       — assign to a super-admin
 *
 * Attachments are uploaded via the dedicated /api/saas/ticket-attachment
 * multipart endpoint mounted from server.js (this file just exposes the
 * download URL builder + handler so server.js can hand bytes back).
 */

const jwt = require('jsonwebtoken');
const control = require('../../control/db');
const r2store = require('../../utils/r2store'); // R2_STORE_v1 — zero-egress attachment offload (non-destructive)
const { requireSuperAdmin } = require('./superAdminAuth');
const tenantPoolMod = require('../../utils/tenantPool');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------
const CATEGORIES = [
  { id: 'finance',     label: 'Finance / Billing',    icon: '💰' },
  { id: 'technical',   label: 'Technical Issue',      icon: '🛠️' },
  { id: 'bug',         label: 'Bug Report',           icon: '🐞' },
  { id: 'feature',     label: 'Feature Request',      icon: '✨' },
  { id: 'integration', label: '3rd-Party Integration',icon: '🔌' },
  { id: 'training',    label: 'Training / How-to',    icon: '🎓' },
  { id: 'onboarding',  label: 'Onboarding',           icon: '🚀' },
  { id: 'account',     label: 'Account / Access',     icon: '👤' },
  { id: 'billing',     label: 'Subscription / Plan',  icon: '💳' },
  { id: 'other',       label: 'Other',                icon: '📝' },
];

const STATUSES = [
  { id: 'open',              label: 'Open',              color: '#3b82f6' },
  { id: 'in_progress',       label: 'In Progress',       color: '#8b5cf6' },
  { id: 'waiting_customer',  label: 'Waiting Customer',  color: '#f59e0b' },
  { id: 'resolved',          label: 'Resolved',          color: '#10b981' },
  { id: 'closed',            label: 'Closed',            color: '#6b7280' },
  { id: 'reopened',          label: 'Re-opened',         color: '#ef4444' },
];

const PRIORITIES = [
  { id: 'low',    label: 'Low',    color: '#94a3b8' },
  { id: 'normal', label: 'Normal', color: '#3b82f6' },
  { id: 'high',   label: 'High',   color: '#f59e0b' },
  { id: 'urgent', label: 'Urgent', color: '#ef4444' },
];

const VALID_CATEGORIES = CATEGORIES.map(c => c.id);
const VALID_STATUSES   = STATUSES.map(s => s.id);
const VALID_PRIORITIES = PRIORITIES.map(p => p.id);

// ----------------------------------------------------------------
// Self-healing schema (also in control/schema.sql; here for safety
// against tenants on installations that haven't run schema migrations).
// ----------------------------------------------------------------
let _schemaEnsured = false;
async function _ensureSchema() {
  if (_schemaEnsured) return;
  try {
    await control.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id                  SERIAL PRIMARY KEY,
        ticket_number       TEXT NOT NULL UNIQUE,
        tenant_id           INTEGER,
        tenant_slug         TEXT NOT NULL,
        contact_name        TEXT,
        contact_email       TEXT,
        contact_phone       TEXT,
        created_by_user_id  INTEGER,
        category            TEXT NOT NULL,
        priority            TEXT NOT NULL DEFAULT 'normal',
        subject             TEXT NOT NULL,
        description         TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'open',
        assignee_id         INTEGER,
        reply_count         INTEGER NOT NULL DEFAULT 0,
        last_reply_at       TIMESTAMPTZ,
        last_reply_by       TEXT,
        closed_at           TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant  ON support_tickets(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_status  ON support_tickets(status);
      CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON support_tickets(created_at DESC);

      CREATE TABLE IF NOT EXISTS support_ticket_replies (
        id           SERIAL PRIMARY KEY,
        ticket_id    INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        author_type  TEXT NOT NULL,
        author_id    INTEGER,
        author_name  TEXT,
        author_email TEXT,
        body         TEXT NOT NULL,
        is_internal  INTEGER NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_support_replies_ticket ON support_ticket_replies(ticket_id, created_at);

      CREATE TABLE IF NOT EXISTS support_ticket_attachments (
        id               SERIAL PRIMARY KEY,
        ticket_id        INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        reply_id         INTEGER REFERENCES support_ticket_replies(id) ON DELETE CASCADE,
        filename         TEXT NOT NULL,
        mime_type        TEXT,
        size_bytes       INTEGER NOT NULL DEFAULT 0,
        file_bytes       BYTEA,
        uploaded_by_type TEXT NOT NULL,
        uploaded_by_id   INTEGER,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_support_attach_ticket ON support_ticket_attachments(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_support_attach_reply  ON support_ticket_attachments(reply_id);
    `);
    // R2_STORE_v1 — additive column for the R2 object key. BYTEA stays the
    // source of truth; this only records where the R2 copy lives (if any).
    try { await control.query(`ALTER TABLE support_ticket_attachments ADD COLUMN IF NOT EXISTS r2_key TEXT`); } catch (_) {}
    _schemaEnsured = true;
  } catch (e) {
    console.warn('[tickets] _ensureSchema failed:', e.message);
  }
}

// ----------------------------------------------------------------
// Tenant auth — decode the tenant CRM's JWT, find the tenant, lookup
// the user in that tenant's DB. JWT layout (signed by routes/auth.js
// inside the tenant): { id, email, role, t: <slug>, iat, exp }
// ----------------------------------------------------------------
async function _authTenantUser(token) {
  if (!token) throw new Error('Not signed in');
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (_) { throw new Error('Invalid or expired token'); }
  if (payload.sa) throw new Error('Super-admin token cannot create tenant tickets');
  const slug = payload.t;
  if (!slug) throw new Error('Token missing tenant slug');
  const tenant = await control.findOneBy('tenants', 'slug', slug);
  if (!tenant) throw new Error('Tenant not found: ' + slug);
  // Pull the user from the tenant DB so we can snapshot their name/email/phone.
  let user = null;
  try {
    const pool = tenantPoolMod.poolFor(tenant);
    if (pool) {
      const r = await pool.query(
        'SELECT id, name, email, phone FROM users WHERE id = $1 LIMIT 1',
        [Number(payload.id)]
      );
      user = r.rows[0] || null;
    }
  } catch (e) { console.warn('[tickets] tenant user lookup failed:', e.message); }
  return {
    tenant,
    user: user || { id: Number(payload.id), name: '', email: payload.email || '', phone: '' }
  };
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
async function _nextTicketNumber() {
  const yr = new Date().getFullYear();
  // Count current-year tickets to make a friendly per-year sequence.
  const r = await control.query(
    `SELECT COUNT(*)::int AS c FROM support_tickets
       WHERE ticket_number LIKE $1`,
    ['TKT-' + yr + '-%']
  );
  const next = (Number(r.rows[0].c) || 0) + 1;
  return 'TKT-' + yr + '-' + String(next).padStart(5, '0');
}

async function _ticketWithDetails(ticketId, { includeInternal = false } = {}) {
  const t = await control.findById('support_tickets', ticketId);
  if (!t) return null;
  const rWhere = includeInternal ? 'ticket_id = $1' : 'ticket_id = $1 AND is_internal = 0';
  const replies = (await control.query(
    `SELECT id, ticket_id, author_type, author_id, author_name, author_email, body, is_internal, created_at
       FROM support_ticket_replies WHERE ${rWhere} ORDER BY id ASC`,
    [ticketId]
  )).rows;
  // Attachment metadata (no bytes) — bytes streamed via the download endpoint.
  const att = (await control.query(
    `SELECT id, ticket_id, reply_id, filename, mime_type, size_bytes, uploaded_by_type, created_at
       FROM support_ticket_attachments WHERE ticket_id = $1 ORDER BY id ASC`,
    [ticketId]
  )).rows;
  return Object.assign({}, t, { replies, attachments: att });
}

function _looksLikeEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }

// Best-effort email — never throws so a misconfigured SMTP doesn't block
// ticket workflow. The admin sees the failure in the error log instead.
async function _notify({ to, subject, html }) {
  if (!to) return;
  try {
    const mailer = require('./saasMailer');
    await mailer.sendMail({ to, subject, html });
  } catch (e) {
    console.warn('[tickets] email notify failed (' + to + '):', e.message);
  }
}

async function _platformName() {
  try { return await control.getSetting('PLATFORM_NAME', 'SmartCRM'); }
  catch (_) { return 'SmartCRM'; }
}

async function _supportEmail() {
  // Where tenant→admin emails go.
  try {
    const v = await control.getSetting('SUPPORT_EMAIL', '');
    if (v) return v;
  } catch (_) {}
  // Fallback to first active super-admin.
  try {
    const r = await control.query(
      `SELECT email FROM super_admins WHERE COALESCE(is_active,1) = 1 AND role IN ('admin','assistant') ORDER BY id ASC LIMIT 1`
    );
    if (r.rows[0]) return r.rows[0].email;
  } catch (_) {}
  return '';
}

function _ticketLinkTenant(slug, id) {
  const base = process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com';
  return base + '/t/' + slug + '/#/tickets/' + id;
}
function _ticketLinkAdmin(id) {
  const base = process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com';
  return base + '/admin/#/tickets/' + id;
}

function _renderEmail({ title, ticket, intro, bodyHtml, ctaLabel, ctaUrl, brand }) {
  const safe = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1f2937">
  <div style="background:#0f172a;color:#fff;padding:1rem 1.5rem;border-radius:8px 8px 0 0">
    <div style="font-size:.78rem;opacity:.7">${safe(brand || 'SmartCRM')}</div>
    <div style="font-size:1.2rem;font-weight:700;margin-top:.15rem">${safe(title)}</div>
  </div>
  <div style="background:#fff;padding:1.5rem;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px">
    ${intro ? `<p style="margin:0 0 1rem">${intro}</p>` : ''}
    <table style="font-size:.9rem;border-collapse:collapse;margin:0 0 1rem">
      <tr><td style="padding:.25rem 1rem .25rem 0;color:#6b7280">Ticket</td><td style="padding:.25rem 0"><b>${safe(ticket.ticket_number)}</b></td></tr>
      <tr><td style="padding:.25rem 1rem .25rem 0;color:#6b7280">Subject</td><td style="padding:.25rem 0">${safe(ticket.subject)}</td></tr>
      <tr><td style="padding:.25rem 1rem .25rem 0;color:#6b7280">Status</td><td style="padding:.25rem 0">${safe(ticket.status)}</td></tr>
      <tr><td style="padding:.25rem 1rem .25rem 0;color:#6b7280">Priority</td><td style="padding:.25rem 0">${safe(ticket.priority)}</td></tr>
      <tr><td style="padding:.25rem 1rem .25rem 0;color:#6b7280">Category</td><td style="padding:.25rem 0">${safe(ticket.category)}</td></tr>
      ${ticket.tenant_slug ? `<tr><td style="padding:.25rem 1rem .25rem 0;color:#6b7280">Workspace</td><td style="padding:.25rem 0">${safe(ticket.tenant_slug)}</td></tr>` : ''}
    </table>
    ${bodyHtml || ''}
    ${ctaUrl ? `<p style="margin:1.5rem 0 0"><a href="${safe(ctaUrl)}" style="display:inline-block;background:#3b82f6;color:#fff;padding:.6rem 1.2rem;text-decoration:none;border-radius:6px;font-weight:600">${safe(ctaLabel || 'View ticket')}</a></p>` : ''}
  </div>
  <div style="text-align:center;padding:1rem;color:#9ca3af;font-size:.78rem">
    You're receiving this because you opened or follow this support ticket on ${safe(brand || 'SmartCRM')}.
  </div>
</div>`;
}

// ================================================================
// Tenant APIs
// ================================================================

/** Static catalog. No auth needed. */
async function api_saas_tk_categories() {
  return { categories: CATEGORIES, priorities: PRIORITIES, statuses: STATUSES };
}

/** Tenant-side: submit a new ticket. */
async function api_saas_tk_submit(token, payload) {
  await _ensureSchema();
  const p = payload || {};
  const { tenant, user } = await _authTenantUser(token);

  // Sanitize + validate
  const category = String(p.category || '').toLowerCase();
  const priority = String(p.priority || 'normal').toLowerCase();
  const subject  = String(p.subject || '').trim().slice(0, 200);
  const description = String(p.description || '').trim().slice(0, 20000);
  const contactName  = String(p.contact_name  || user.name || '').slice(0, 120);
  const contactEmail = String(p.contact_email || user.email || '').slice(0, 200).toLowerCase().trim();
  const contactPhone = String(p.contact_phone || user.phone || '').slice(0, 40);

  if (!VALID_CATEGORIES.includes(category)) throw new Error('Pick a category');
  if (!VALID_PRIORITIES.includes(priority)) throw new Error('Invalid priority');
  if (!subject)     throw new Error('Subject is required');
  if (!description) throw new Error('Description is required');
  if (contactEmail && !_looksLikeEmail(contactEmail)) throw new Error('Contact email looks invalid');

  const ticketNumber = await _nextTicketNumber();
  const id = await control.insert('support_tickets', {
    ticket_number: ticketNumber,
    tenant_id: tenant.id,
    tenant_slug: tenant.slug,
    contact_name: contactName,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    created_by_user_id: user.id || null,
    category,
    priority,
    subject,
    description,
    status: 'open'
  });

  await control.insert('audit_log', {
    actor_type: 'tenant',
    tenant_id: tenant.id,
    event: 'support_ticket.created',
    detail: JSON.stringify({ id, ticket_number: ticketNumber, category, priority })
  }).catch(() => {});

  // Email: ack to customer + alert to support team. Fire-and-forget so a
  // slow SMTP server doesn't make the submit-button spin.
  (async () => {
    try {
      const brand = await _platformName();
      const supportEmail = await _supportEmail();
      const ticket = await control.findById('support_tickets', id);

      if (contactEmail) {
        await _notify({
          to: contactEmail,
          subject: `[${ticketNumber}] We received your support request`,
          html: _renderEmail({
            title: 'We received your support request',
            brand,
            ticket,
            intro: `Hi ${contactName || 'there'}, thanks for reaching out. Our team has logged your ticket and will reply shortly.`,
            bodyHtml: `<div style="background:#f9fafb;padding:.9rem;border-radius:6px;border-left:3px solid #3b82f6;font-size:.92rem;white-space:pre-wrap">${description}</div>`,
            ctaLabel: 'Open ticket',
            ctaUrl: _ticketLinkTenant(tenant.slug, id)
          })
        });
      }
      if (supportEmail) {
        await _notify({
          to: supportEmail,
          subject: `[${ticketNumber}] New ${priority.toUpperCase()} ticket — ${subject}`,
          html: _renderEmail({
            title: 'New support ticket',
            brand,
            ticket,
            intro: `Submitted by <b>${contactName || contactEmail || tenant.slug}</b> (${tenant.org_name || tenant.slug}).`,
            bodyHtml: `<div style="background:#f9fafb;padding:.9rem;border-radius:6px;border-left:3px solid #f59e0b;font-size:.92rem;white-space:pre-wrap">${description}</div>`,
            ctaLabel: 'Open in admin',
            ctaUrl: _ticketLinkAdmin(id)
          })
        });
      }
    } catch (e) { console.warn('[tickets] create-notify error:', e.message); }
  })();

  return { ok: true, id, ticket_number: ticketNumber };
}

/** Tenant-side: list MY tickets. */
async function api_saas_tk_listMine(token, opts) {
  await _ensureSchema();
  const { tenant } = await _authTenantUser(token);
  const o = opts || {};
  const where = ['tenant_id = $1']; const params = [tenant.id];
  if (o.status && VALID_STATUSES.includes(o.status)) {
    params.push(o.status); where.push(`status = $${params.length}`);
  }
  if (o.q) {
    params.push('%' + String(o.q).toLowerCase() + '%');
    where.push(`(LOWER(subject) LIKE $${params.length} OR LOWER(ticket_number) LIKE $${params.length})`);
  }
  const r = await control.query(
    `SELECT id, ticket_number, category, priority, subject, status, reply_count,
            last_reply_at, last_reply_by, created_at, updated_at
       FROM support_tickets
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_reply_at, created_at) DESC
      LIMIT 500`,
    params
  );
  return { tickets: r.rows };
}

/** Tenant-side: get one ticket (must be ours). Internal notes hidden. */
async function api_saas_tk_getMine(token, ticketId) {
  await _ensureSchema();
  const { tenant } = await _authTenantUser(token);
  const ticket = await _ticketWithDetails(Number(ticketId), { includeInternal: false });
  if (!ticket) throw new Error('Ticket not found');
  if (Number(ticket.tenant_id) !== Number(tenant.id)) throw new Error('Not your ticket');
  return ticket;
}

/** Tenant-side: add a reply. */
async function api_saas_tk_replyTenant(token, payload) {
  await _ensureSchema();
  const { tenant, user } = await _authTenantUser(token);
  const p = payload || {};
  const ticketId = Number(p.ticket_id);
  const body = String(p.body || '').trim().slice(0, 20000);
  if (!ticketId) throw new Error('ticket_id required');
  if (!body)     throw new Error('Reply body is required');
  const ticket = await control.findById('support_tickets', ticketId);
  if (!ticket) throw new Error('Ticket not found');
  if (Number(ticket.tenant_id) !== Number(tenant.id)) throw new Error('Not your ticket');

  const replyId = await control.insert('support_ticket_replies', {
    ticket_id: ticketId,
    author_type: 'tenant',
    author_id: user.id || null,
    author_name: user.name || ticket.contact_name || '',
    author_email: user.email || ticket.contact_email || '',
    body,
    is_internal: 0
  });
  // Roll the ticket forward — tenant reply usually means it's no longer
  // 'waiting_customer'. Move to 'open' if it was waiting; otherwise keep
  // existing status. Resolved/closed tickets re-open automatically.
  const newStatus = ['waiting_customer', 'resolved', 'closed'].includes(ticket.status) ? 'reopened' : ticket.status;
  await control.query(
    `UPDATE support_tickets
        SET reply_count   = reply_count + 1,
            last_reply_at = NOW(),
            last_reply_by = 'tenant',
            status        = $1,
            updated_at    = NOW()
      WHERE id = $2`,
    [newStatus, ticketId]
  );

  // Notify support email of the new reply.
  (async () => {
    try {
      const brand = await _platformName();
      const supportEmail = await _supportEmail();
      const t2 = await control.findById('support_tickets', ticketId);
      if (supportEmail) {
        await _notify({
          to: supportEmail,
          subject: `[${ticket.ticket_number}] Customer reply — ${ticket.subject}`,
          html: _renderEmail({
            title: 'Customer replied to a support ticket',
            brand,
            ticket: t2,
            intro: `<b>${user.name || user.email || 'A user'}</b> on workspace <b>${tenant.org_name || tenant.slug}</b> wrote:`,
            bodyHtml: `<div style="background:#f9fafb;padding:.9rem;border-radius:6px;border-left:3px solid #3b82f6;font-size:.92rem;white-space:pre-wrap">${body}</div>`,
            ctaLabel: 'Open in admin',
            ctaUrl: _ticketLinkAdmin(ticketId)
          })
        });
      }
    } catch (e) { console.warn('[tickets] tenant-reply notify error:', e.message); }
  })();

  return { ok: true, reply_id: replyId };
}

/** Tenant-side: mark ticket resolved (customer confirms fix). */
async function api_saas_tk_closeMine(token, ticketId) {
  await _ensureSchema();
  const { tenant } = await _authTenantUser(token);
  const ticket = await control.findById('support_tickets', Number(ticketId));
  if (!ticket) throw new Error('Ticket not found');
  if (Number(ticket.tenant_id) !== Number(tenant.id)) throw new Error('Not your ticket');
  await control.query(
    `UPDATE support_tickets
        SET status = 'resolved', closed_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [ticket.id]
  );
  return { ok: true };
}

/** Tenant-side: re-open a resolved ticket. */
async function api_saas_tk_reopenMine(token, ticketId) {
  await _ensureSchema();
  const { tenant } = await _authTenantUser(token);
  const ticket = await control.findById('support_tickets', Number(ticketId));
  if (!ticket) throw new Error('Ticket not found');
  if (Number(ticket.tenant_id) !== Number(tenant.id)) throw new Error('Not your ticket');
  await control.query(
    `UPDATE support_tickets
        SET status = 'reopened', closed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [ticket.id]
  );
  return { ok: true };
}

// ================================================================
// Super-admin APIs
// ================================================================

/** List every tenant's tickets with filters. */
async function api_saas_tk_admin_listAll(token, filters) {
  await requireSuperAdmin(token);
  await _ensureSchema();
  const f = filters || {};
  const where = []; const params = [];
  // TKT_STATUS_MULTI_v1 — accept a statuses[] array (multi-select) or single status.
  if (Array.isArray(f.statuses) && f.statuses.length) {
    const valid = f.statuses.filter(x => VALID_STATUSES.includes(x));
    if (valid.length) { const ph = valid.map(v => { params.push(v); return '$' + params.length; }); where.push(`t.status IN (${ph.join(',')})`); }
  } else if (f.status && VALID_STATUSES.includes(f.status)) { params.push(f.status); where.push(`t.status = $${params.length}`); }
  if (f.category && VALID_CATEGORIES.includes(f.category)) { params.push(f.category); where.push(`t.category = $${params.length}`); }
  if (f.priority && VALID_PRIORITIES.includes(f.priority)) { params.push(f.priority); where.push(`t.priority = $${params.length}`); }
  if (f.tenant_id) { params.push(Number(f.tenant_id)); where.push(`t.tenant_id = $${params.length}`); }
  if (f.assignee_id) { params.push(Number(f.assignee_id)); where.push(`t.assignee_id = $${params.length}`); }
  if (f.unassigned) { where.push(`t.assignee_id IS NULL`); }
  if (f.q) {
    params.push('%' + String(f.q).toLowerCase() + '%');
    where.push(`(LOWER(t.subject) LIKE $${params.length} OR LOWER(t.ticket_number) LIKE $${params.length} OR LOWER(t.tenant_slug) LIKE $${params.length})`);
  }
  // TKT_LAST_REMARK_FILTER_v1 — filter tickets by who left the LAST reply
  // ('tenant' = customer replied last / needs our response, 'admin' = our team
  // replied last, 'system' = auto). Applied ONLY to the main list query because it
  // references the lr LATERAL join; stats/byAssignee keep the shared where+params.
  const listWhere = where.slice(); const listParams = params.slice();
  if (f.last_reply_by && ['tenant', 'admin', 'system'].includes(f.last_reply_by)) {
    listParams.push(f.last_reply_by);
    listWhere.push(`lr.author_type = $${listParams.length}`);
  }
  const sql = `
    SELECT t.*, te.org_name, sa.name AS assignee_name,
           lr.body        AS last_reply_body,
           lr.author_type AS last_reply_author_type,
           lr.author_name AS last_reply_author_name,
           lr.is_internal AS last_reply_internal,
           lr.created_at  AS last_reply_created_at
      FROM support_tickets t
      LEFT JOIN tenants     te ON te.id = t.tenant_id
      LEFT JOIN super_admins sa ON sa.id = t.assignee_id
      -- TKT_LAST_REMARK_AUTHOR_v1 — pull the whole latest reply row (not just the
      -- body) so the list can show WHO left it: our team vs the tenant.
      LEFT JOIN LATERAL (
        SELECT r.body, r.author_type, r.author_name, r.is_internal, r.created_at
          FROM support_ticket_replies r
         WHERE r.ticket_id = t.id
         ORDER BY r.created_at DESC
         LIMIT 1
      ) lr ON TRUE
     ${listWhere.length ? 'WHERE ' + listWhere.join(' AND ') : ''}
     ORDER BY COALESCE(t.last_reply_at, t.created_at) DESC
     LIMIT 1000`;
  const r = await control.query(sql, listParams);
  // Stats card data
  const stats = (await control.query(`
    SELECT
      COUNT(*)::int                                            AS total,
      SUM(CASE WHEN status='open' THEN 1 ELSE 0 END)::int      AS open,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END)::int AS in_progress,
      SUM(CASE WHEN status='waiting_customer' THEN 1 ELSE 0 END)::int AS waiting_customer,
      SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END)::int  AS resolved,
      SUM(CASE WHEN status='closed' THEN 1 ELSE 0 END)::int    AS closed,
      SUM(CASE WHEN status='reopened' THEN 1 ELSE 0 END)::int  AS reopened,
      SUM(CASE WHEN priority='urgent' AND status NOT IN ('closed','resolved') THEN 1 ELSE 0 END)::int AS urgent_open
    FROM support_tickets`)).rows[0];
  // TKT_ASSIGNEE_SUMMARY_v1 — counts grouped by assignee (respects the same
  // status/category/priority/tenant/search filters as the list above).
  const byAssignee = (await control.query(`
    SELECT t.assignee_id, COALESCE(sa.name, 'Unassigned') AS assignee_name,
           COUNT(*)::int AS total,
           SUM(CASE WHEN t.status NOT IN ('closed','resolved') THEN 1 ELSE 0 END)::int AS open_count,
           SUM(CASE WHEN t.priority='urgent' AND t.status NOT IN ('closed','resolved') THEN 1 ELSE 0 END)::int AS urgent_open
      FROM support_tickets t
      LEFT JOIN super_admins sa ON sa.id = t.assignee_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     GROUP BY t.assignee_id, sa.name
     ORDER BY total DESC`, params)).rows;
  return { tickets: r.rows, stats, byAssignee };
}

/** Admin: get one ticket with replies + internal notes. */
async function api_saas_tk_admin_get(token, ticketId) {
  await requireSuperAdmin(token);
  await _ensureSchema();
  const t = await _ticketWithDetails(Number(ticketId), { includeInternal: true });
  if (!t) throw new Error('Ticket not found');
  // Attach tenant org_name + assignee name for header display.
  const tenant = t.tenant_id ? await control.findById('tenants', t.tenant_id) : null;
  const assignee = t.assignee_id ? await control.findById('super_admins', t.assignee_id) : null;
  t.tenant_org_name = tenant ? tenant.org_name : null;
  t.assignee_name = assignee ? assignee.name : null;
  return t;
}

/** Admin reply. is_internal=1 hides it from the tenant view. */
async function api_saas_tk_admin_reply(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const ticketId = Number(p.ticket_id);
  const body = String(p.body || '').trim().slice(0, 20000);
  const isInternal = Number(p.is_internal) === 1 ? 1 : 0;
  if (!ticketId) throw new Error('ticket_id required');
  if (!body)     throw new Error('Reply body required');
  const ticket = await control.findById('support_tickets', ticketId);
  if (!ticket) throw new Error('Ticket not found');

  const replyId = await control.insert('support_ticket_replies', {
    ticket_id: ticketId,
    author_type: 'admin',
    author_id: me.id,
    author_name: me.name || '',
    author_email: me.email || '',
    body,
    is_internal: isInternal
  });
  // Visible reply moves to waiting_customer; internal notes don't change status.
  if (!isInternal) {
    await control.query(
      `UPDATE support_tickets
          SET reply_count   = reply_count + 1,
              last_reply_at = NOW(),
              last_reply_by = 'admin',
              status        = CASE WHEN status IN ('open','reopened','in_progress') THEN 'waiting_customer' ELSE status END,
              close_warned_at = NULL,
              updated_at    = NOW()
        WHERE id = $1`,
      [ticketId]
    );
    // Notify the customer email.
    (async () => {
      try {
        const brand = await _platformName();
        const t2 = await control.findById('support_tickets', ticketId);
        if (t2.contact_email) {
          await _notify({
            to: t2.contact_email,
            subject: `[${ticket.ticket_number}] Reply from support — ${ticket.subject}`,
            html: _renderEmail({
              title: 'New reply from support',
              brand,
              ticket: t2,
              intro: `<b>${me.name || 'Our team'}</b> replied:`,
              bodyHtml: `<div style="background:#f9fafb;padding:.9rem;border-radius:6px;border-left:3px solid #10b981;font-size:.92rem;white-space:pre-wrap">${body}</div>`,
              ctaLabel: 'View & reply',
              ctaUrl: _ticketLinkTenant(t2.tenant_slug, t2.id)
            })
          });
        }
      } catch (e) { console.warn('[tickets] admin-reply notify error:', e.message); }
    })();
  }

  // TKT_AUTO_ASSIGN_v1 — whoever replies takes ownership of the ticket.
  try { await control.query(`UPDATE support_tickets SET assignee_id = $1, updated_at = NOW() WHERE id = $2`, [me.id, ticketId]); } catch (_) {}

  return { ok: true, reply_id: replyId, assigned_to: me.id };
}

// TKT_AI_SUGGEST_v1 — draft a step-by-step resolution from the ticket thread using
// the platform Gemini key. The admin edits/approves before sending.
async function api_saas_tk_admin_aiSuggest(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const ticketId = Number((payload || {}).ticket_id);
  if (!ticketId) throw new Error('ticket_id required');
  const t = await control.findById('support_tickets', ticketId);
  if (!t) throw new Error('Ticket not found');
  const reps = await control.query(
    `SELECT author_type, author_name, body, is_internal, created_at
       FROM support_ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 40`, [ticketId]);
  const convo = (reps.rows || [])
    .filter(r => Number(r.is_internal) !== 1)
    .map(r => (r.author_type === 'admin' ? 'Support' : 'Customer') + ': ' + String(r.body || '').trim())
    .join('\n');
  const system = 'You are a senior customer-support agent for SmartCRM, a CRM SaaS used by sales teams (leads, WhatsApp, calling, invoicing, campaigns, reports). ' +
    'Given a support ticket, write a clear, friendly reply the agent can send to the customer that RESOLVES the issue with concrete, numbered step-by-step instructions specific to SmartCRM. ' +
    'Be concise and practical. Do not invent features. If information is missing, ask one crisp clarifying question at the end. Output only the reply text (no preamble).';
  const prompt = 'Category: ' + (t.category || '-') + '\nSubject: ' + (t.subject || '') +
    '\n\nCustomer description:\n' + (t.description || '(none)') +
    (convo ? ('\n\nConversation so far:\n' + convo) : '') +
    '\n\nWrite the resolution reply now.';
  let text = '';
  try {
    const gemini = require('../../utils/geminiClient');
    const r = await gemini.generate({ system, prompt, maxOutputTokens: 700, temperature: 0.4 });
    text = String((r && r.text) || '').trim();
  } catch (e) {
    throw new Error('AI is not available: ' + (e.message || e) + ' (set the platform Gemini key in AI settings).');
  }
  if (!text) throw new Error('AI returned an empty suggestion — try again.');
  return { ok: true, suggestion: text };
}

/** Admin: change ticket status. */
async function api_saas_tk_admin_setStatus(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const ticketId = Number(p.ticket_id);
  const status = String(p.status || '').toLowerCase();
  if (!ticketId) throw new Error('ticket_id required');
  if (!VALID_STATUSES.includes(status)) throw new Error('Invalid status');
  const ticket = await control.findById('support_tickets', ticketId);
  if (!ticket) throw new Error('Ticket not found');
  await control.query(
    `UPDATE support_tickets
        SET status = $1,
            closed_at = CASE WHEN $1 IN ('resolved','closed') THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $2`,
    [status, ticketId]
  );
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    tenant_id: ticket.tenant_id, event: 'support_ticket.status_changed',
    detail: JSON.stringify({ id: ticketId, from: ticket.status, to: status })
  }).catch(() => {});
  // Notify customer if reaching a resolved/closed terminal state, so they
  // know it's been wrapped up.
  if ((status === 'resolved' || status === 'closed') && ticket.contact_email) {
    (async () => {
      try {
        const brand = await _platformName();
        const t2 = await control.findById('support_tickets', ticketId);
        await _notify({
          to: ticket.contact_email,
          subject: `[${ticket.ticket_number}] Marked ${status} — ${ticket.subject}`,
          html: _renderEmail({
            title: 'Your ticket has been ' + (status === 'resolved' ? 'resolved' : 'closed'),
            brand,
            ticket: t2,
            intro: 'If you still need help, just reply to this email or re-open the ticket.',
            ctaLabel: 'Open ticket',
            ctaUrl: _ticketLinkTenant(t2.tenant_slug, t2.id)
          })
        });
      } catch (e) { console.warn('[tickets] status-notify error:', e.message); }
    })();
  }
  return { ok: true };
}

/** Admin: change priority. */
async function api_saas_tk_admin_setPriority(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const ticketId = Number(p.ticket_id);
  const priority = String(p.priority || '').toLowerCase();
  if (!ticketId) throw new Error('ticket_id required');
  if (!VALID_PRIORITIES.includes(priority)) throw new Error('Invalid priority');
  await control.query(
    `UPDATE support_tickets SET priority = $1, updated_at = NOW() WHERE id = $2`,
    [priority, ticketId]
  );
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'support_ticket.priority_changed',
    detail: JSON.stringify({ id: ticketId, priority })
  }).catch(() => {});
  return { ok: true };
}

/** Admin: assign to a super-admin (or null to unassign). */
async function api_saas_tk_admin_assign(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const ticketId = Number(p.ticket_id);
  const assigneeId = p.assignee_id != null ? Number(p.assignee_id) : null;
  if (!ticketId) throw new Error('ticket_id required');
  if (assigneeId) {
    const sa = await control.findById('super_admins', assigneeId);
    if (!sa) throw new Error('Assignee not found');
  }
  await control.query(
    `UPDATE support_tickets SET assignee_id = $1, updated_at = NOW() WHERE id = $2`,
    [assigneeId, ticketId]
  );
  await control.insert('audit_log', {
    actor_type: 'super_admin', actor_id: me.id, actor_email: me.email,
    event: 'support_ticket.assigned',
    detail: JSON.stringify({ id: ticketId, assignee_id: assigneeId })
  }).catch(() => {});
  return { ok: true };
}

// ================================================================
// Attachments — multipart upload + download handlers
// (called from server.js to keep multer config in one place)
// ================================================================

/** Verify caller can attach to this ticket; returns { ticket, who, isAdmin }. */
async function _checkAttachAccess(token, ticketId) {
  // Try super-admin first.
  try {
    const me = await requireSuperAdmin(token);
    const ticket = await control.findById('support_tickets', Number(ticketId));
    if (!ticket) throw new Error('Ticket not found');
    return { ticket, who: { id: me.id, name: me.name, email: me.email }, isAdmin: true };
  } catch (_) {
    const { tenant, user } = await _authTenantUser(token);
    const ticket = await control.findById('support_tickets', Number(ticketId));
    if (!ticket) throw new Error('Ticket not found');
    if (Number(ticket.tenant_id) !== Number(tenant.id)) throw new Error('Not your ticket');
    return { ticket, who: user, isAdmin: false };
  }
}

/** Express handler — multipart upload. Mount in server.js. */
async function expressAttachmentUpload(req, res) {
  try {
    await _ensureSchema();
    const token = (req.headers['x-auth-token'] || req.body.token || '').toString();
    const ticketId = Number(req.body.ticket_id);
    const replyId  = req.body.reply_id ? Number(req.body.reply_id) : null;
    if (!ticketId) return res.status(400).json({ error: 'ticket_id required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if ((req.file.size || 0) > 25 * 1024 * 1024) {
      return res.status(400).json({ error: 'Max 25 MB per file' });
    }
    const { ticket, who, isAdmin } = await _checkAttachAccess(token, ticketId);
    const id = await control.insert('support_ticket_attachments', {
      ticket_id: ticket.id,
      reply_id: replyId,
      filename: String(req.file.originalname || 'file').slice(0, 200),
      mime_type: req.file.mimetype || 'application/octet-stream',
      size_bytes: req.file.size || 0,
      file_bytes: req.file.buffer,
      uploaded_by_type: isAdmin ? 'admin' : 'tenant',
      uploaded_by_id: who.id || null
    });
    // R2_STORE_v1 — best-effort dual-write to R2 (zero-egress serving layer).
    // BYTEA above is already persisted and untouched; if this fails we simply
    // keep serving from BYTEA. Gated by R2_OFFLOAD=write|on.
    if (r2store.writesEnabled()) {
      try {
        const key = await r2store.put({
          tenant: ticket.tenant_slug || 'unknown',
          category: 'attachments',
          subPath: 'tickets/' + ticket.id,
          filename: id + '-' + (req.file.originalname || 'file'),
          body: req.file.buffer,
          contentType: req.file.mimetype || 'application/octet-stream',
        });
        await control.query('UPDATE support_ticket_attachments SET r2_key = $1 WHERE id = $2', [key, id]);
      } catch (e) { console.warn('[ticket-attach] R2 dual-write skipped:', e.message); }
    }
    res.json({ ok: true, id, filename: req.file.originalname, size_bytes: req.file.size });
  } catch (e) {
    console.error('[ticket-attach]', e.message);
    res.status(400).json({ error: e.message });
  }
}

/** Express handler — stream attachment bytes for download. Mount in server.js. */
async function expressAttachmentDownload(req, res) {
  try {
    await _ensureSchema();
    const token = (req.query.token || req.headers['x-auth-token'] || '').toString();
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const a = (await control.query(
      `SELECT a.*, t.tenant_id AS t_tenant_id, t.tenant_slug AS t_tenant_slug
         FROM support_ticket_attachments a
         JOIN support_tickets t ON t.id = a.ticket_id
        WHERE a.id = $1 LIMIT 1`,
      [id]
    )).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    // Access: either a super-admin token OR a tenant token whose slug matches.
    let allow = false;
    try { await requireSuperAdmin(token); allow = true; } catch (_) {}
    if (!allow) {
      try {
        const { tenant } = await _authTenantUser(token);
        if (Number(tenant.id) === Number(a.t_tenant_id)) allow = true;
      } catch (_) {}
    }
    if (!allow) return res.status(401).json({ error: 'Not authorized' });
    // R2_STORE_v1 — when reads are on and this row has an R2 copy, redirect the
    // browser to a short-lived signed URL so the bytes come from Cloudflare (zero
    // Railway egress). Any failure falls through to the original BYTEA stream.
    if (r2store.readsEnabled() && a.r2_key) {
      try {
        const url = await r2store.presignGet(a.r2_key, 'attachments', 900);
        return res.redirect(302, url);
      } catch (e) { console.warn('[ticket-attach-dl] R2 read fell back to BYTEA:', e.message); }
    }
    let buf = a.file_bytes;
    if (!Buffer.isBuffer(buf)) buf = buf ? Buffer.from(buf) : Buffer.alloc(0);
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', 'inline; filename="' + (a.filename || 'file').replace(/[^a-z0-9._-]/gi, '_') + '"');
    res.end(buf);
  } catch (e) {
    console.error('[ticket-attach-dl]', e.message);
    res.status(400).json({ error: e.message });
  }
}

// ================================================================
// TKT_AUTOCLOSE_v1 — remind the tenant at 24h then auto-close at 48h when a ticket
// is waiting on the customer (last reply was ours). Run hourly from server.js.
async function sweepStaleTickets() {
  await _ensureSchema();
  try { await control.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS close_warned_at TIMESTAMPTZ`); } catch (_) {}
  const brand = await _platformName().catch(() => 'SmartCRM');
  let warned = 0, closed = 0;
  // 1) 24h reminder
  const warnRows = await control.query(
    `SELECT * FROM support_tickets
      WHERE status = 'waiting_customer' AND last_reply_by = 'admin'
        AND last_reply_at < NOW() - INTERVAL '24 hours' AND close_warned_at IS NULL
      LIMIT 300`).catch(() => ({ rows: [] }));
  for (const t of warnRows.rows) {
    try {
      if (t.contact_email) await _notify({ to: t.contact_email,
        subject: '[' + t.ticket_number + '] Reminder — we will close this ticket soon',
        html: _renderEmail({ title: 'We are waiting to hear from you', brand, ticket: t,
          intro: 'We have not heard back on your ticket:',
          bodyHtml: '<div style="background:#fff7ed;padding:.9rem;border-radius:6px;border-left:3px solid #f59e0b;font-size:.92rem">If we do not hear from you within the next <b>24 hours</b>, we will assume it is resolved and close this ticket. Just reply if you still need help.</div>',
          ctaLabel: 'Reply now', ctaUrl: _ticketLinkTenant(t.tenant_slug, t.id) }) });
    } catch (e) { console.warn('[tickets] warn notify failed:', e.message); }
    await control.query(`UPDATE support_tickets SET close_warned_at = NOW(), updated_at = NOW() WHERE id = $1`, [t.id]).catch(() => {});
    warned++;
  }
  // 2) 48h auto-close
  const closeRows = await control.query(
    `SELECT * FROM support_tickets
      WHERE status = 'waiting_customer' AND last_reply_by = 'admin'
        AND last_reply_at < NOW() - INTERVAL '48 hours'
      LIMIT 300`).catch(() => ({ rows: [] }));
  for (const t of closeRows.rows) {
    await control.query(`UPDATE support_tickets SET status = 'closed', updated_at = NOW() WHERE id = $1`, [t.id]).catch(() => {});
    try { await control.insert('support_ticket_replies', { ticket_id: t.id, author_type: 'system', author_id: 0, author_name: 'System', author_email: '', body: 'This ticket was automatically closed after 48 hours with no response. Reply anytime to reopen it.', is_internal: 0 }); } catch (_) {}
    try {
      if (t.contact_email) await _notify({ to: t.contact_email,
        subject: '[' + t.ticket_number + '] Ticket closed — no response',
        html: _renderEmail({ title: 'Ticket closed', brand, ticket: t,
          intro: 'We closed your ticket as we did not hear back:',
          bodyHtml: '<div style="background:#f9fafb;padding:.9rem;border-radius:6px;border-left:3px solid #6b7280;font-size:.92rem">We closed this ticket after <b>48 hours</b> with no reply. If you still need help, just reply and it will reopen automatically.</div>',
          ctaLabel: 'Reopen / reply', ctaUrl: _ticketLinkTenant(t.tenant_slug, t.id) }) });
    } catch (e) { console.warn('[tickets] close notify failed:', e.message); }
    closed++;
  }
  if (warned || closed) console.log('[tickets] stale sweep — warned ' + warned + ', closed ' + closed);
  return { warned, closed };
}

// TKT_AI_DEFLECT_v1 — tenant-facing: try to resolve the issue with SmartCRM AI
// BEFORE a ticket is created. Grounded in the platform Copilot KB (help articles)
// so answers are real SmartCRM steps, not invented ones.
async function api_saas_tk_aiHelp(token, payload) {
  await _ensureSchema();
  const { tenant, user } = await _authTenantUser(token);
  const p = payload || {};
  const subject = String(p.subject || '').trim().slice(0, 300);
  const description = String(p.description || '').trim().slice(0, 5000);
  const category = String(p.category || '').trim();
  const question = (subject + ' ' + description).trim();
  if (question.replace(/\s+/g, ' ').length < 10) throw new Error('Please describe the issue first (a sentence or two).');

  let kb = [];
  try { kb = await require('./copilotKb').lookupActive(question, 5); } catch (_) { kb = []; }
  const kbText = kb.length
    ? kb.map((k, i) => (i + 1) + '. ' + k.title + '\n' + k.body).join('\n\n')
    : '(no matching help articles found)';

  const system = 'You are SmartCRM\'s AI support assistant. SmartCRM is a CRM SaaS for sales teams '
    + '(leads, WhatsApp Business, calling/recordings, invoicing, campaigns, automations, reports). '
    + 'A customer is about to raise a support ticket. Try to solve their problem FIRST. '
    + 'Rules: (1) Base your answer on the SmartCRM help knowledge provided; do NOT invent features or menus. '
    + '(2) Give concrete numbered steps with the exact menu path where possible. '
    + '(3) Be concise and friendly. '
    + '(4) If the knowledge does not clearly cover the issue, or it looks like a bug/billing/account problem that needs a human, '
    + 'reply with a short honest note that you could not resolve it and that they should submit the ticket. '
    + 'Start that reply with the exact token NEEDS_HUMAN on its own first line. '
    + 'Output only the answer text.';
  const prompt = 'Category: ' + (category || '-') + '\nSubject: ' + subject
    + '\n\nIssue described by the customer:\n' + description
    + '\n\nSmartCRM help knowledge (use this):\n' + kbText
    + '\n\nNow answer the customer.';

  let text = '';
  try {
    const gemini = require('../../utils/geminiClient');
    const r = await gemini.generate({ system, prompt, maxOutputTokens: 650, temperature: 0.3 });
    text = String((r && r.text) || '').trim();
  } catch (e) {
    throw new Error('AI help is unavailable right now — please submit the ticket. (' + (e.message || e) + ')');
  }
  if (!text) throw new Error('AI could not find an answer — please submit the ticket.');
  let needsHuman = false;
  if (/^NEEDS_HUMAN/i.test(text)) { needsHuman = true; text = text.replace(/^NEEDS_HUMAN\s*/i, '').trim(); }
  return {
    ok: true, answer: text, needs_human: needsHuman,
    sources: kb.map(k => ({ title: k.title, url: k.url || '' })).filter(x => x.title)
  };
}

module.exports = {
  // Tenant-side
  api_saas_tk_categories,
  api_saas_tk_submit,
  api_saas_tk_aiHelp,
  api_saas_tk_listMine,
  api_saas_tk_getMine,
  api_saas_tk_replyTenant,
  api_saas_tk_closeMine,
  api_saas_tk_reopenMine,
  // Super-admin
  api_saas_tk_admin_listAll,
  api_saas_tk_admin_get,
  api_saas_tk_admin_reply,
  api_saas_tk_admin_aiSuggest,
  sweepStaleTickets,
  api_saas_tk_admin_setStatus,
  api_saas_tk_admin_setPriority,
  api_saas_tk_admin_assign,
  // Attachments (Express)
  expressAttachmentUpload,
  expressAttachmentDownload,
  // Constants exposed for tests / introspection
  CATEGORIES, STATUSES, PRIORITIES
};
