/**
 * TENANT_SIGNUP_APPROVAL_v1 (2026-06-01)
 *
 * Public signup-request workflow:
 *   1. A person fills out the public form at /saas/signup-request.html.
 *      The form posts to /api/saas-public-signup-request (no auth).
 *      We stash everything in control.signup_requests with status='pending'.
 *
 *   2. Super-admin sees the pending request in the "Signup Requests" tab,
 *      can edit any field (correct typos, change package, fix slug), then
 *      clicks Approve.
 *
 *   3. On approve we wrap provisionFromSignup(signupId) — the same pipeline
 *      Cashfree + manual create use. It returns { login_url, email, password }
 *      which we surface in the SPA so the operator can copy + WhatsApp/email
 *      the credentials to the customer.
 *
 *   4. Reject just marks the row and records who/why.
 */
const control = require('../../control/db');
const provisioning = require('./provisioning');
const { requireSuperAdmin } = require('./superAdminAuth');

/* ───────── schema heal ───────── */
let _schemaReady = false;
async function _ensureSchema() {
  if (_schemaReady) return;
  await control.query(`
    CREATE TABLE IF NOT EXISTS signup_requests (
      id                   SERIAL PRIMARY KEY,
      name                 TEXT NOT NULL,
      email                TEXT NOT NULL,
      mobile               TEXT NOT NULL,
      org_name             TEXT NOT NULL,
      desired_slug         TEXT,
      package_id           INTEGER,
      desired_tenure       TEXT,
      desired_users        INTEGER,
      industry_pack        TEXT,
      notes                TEXT,
      submitted_by         TEXT,
      ip_address           TEXT,
      ua                   TEXT,
      status               TEXT NOT NULL DEFAULT 'pending',
      provisioned_signup_id INTEGER,
      provisioned_tenant_id INTEGER,
      provisioned_slug     TEXT,
      provisioned_password TEXT,
      reject_reason        TEXT,
      approved_at          TIMESTAMPTZ,
      approved_by          TEXT,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // best-effort additive heal
  const adds = [
    'desired_tenure TEXT',
    'desired_users INTEGER',
    'industry_pack TEXT',
    'notes TEXT',
    'submitted_by TEXT',
    'ip_address TEXT',
    'ua TEXT',
    'provisioned_signup_id INTEGER',
    'provisioned_tenant_id INTEGER',
    'provisioned_slug TEXT',
    'provisioned_password TEXT',
    'reject_reason TEXT',
    'approved_at TIMESTAMPTZ',
    'approved_by TEXT',
    'updated_at TIMESTAMPTZ DEFAULT NOW()'
  ];
  for (const a of adds) {
    const col = a.split(' ')[0];
    try { await control.query(`ALTER TABLE signup_requests ADD COLUMN IF NOT EXISTS ${a}`); } catch (_) {}
  }
  try {
    await control.query(`CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON signup_requests(status, id DESC)`);
  } catch (_) {}
  _schemaReady = true;
}

/* ───────── helpers ───────── */
function _str(v, max) {
  const s = (v == null ? '' : String(v)).trim();
  return max ? s.slice(0, max) : s;
}
function _validEmail(e) { return /^\S+@\S+\.\S+$/.test(String(e || '')); }
function _validMobile(m) { return /^\+?\d{8,15}$/.test(String(m || '').replace(/\s/g, '')); }
function _slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}
function _validSlug(s) { return /^[a-z][-a-z0-9]{2,29}$/.test(s); }

/* ───────── PUBLIC: list packages (for the form) ───────── */
async function api_saas_sr_publicPackages(_token) {
  await _ensureSchema();
  const r = await control.query(
    `SELECT id, name, base_price_inr, recurring_period, recurring_period_count, is_lifetime
       FROM packages
      WHERE is_enabled = 1 AND is_private = 0
      ORDER BY sort_order ASC, base_price_inr ASC`
  );
  return r.rows;
}

/* ───────── PUBLIC: submit a request ───────── */
async function api_saas_sr_publicSubmit(_token, payload) {
  await _ensureSchema();
  const p = payload || {};

  const name    = _str(p.name, 100);
  const email   = _str(p.email, 200).toLowerCase();
  const mobile  = _str(p.mobile, 30);
  const orgName = _str(p.org_name, 200);
  const slug    = _str(p.desired_slug, 30).toLowerCase();
  const pack    = _str(p.industry_pack, 30).toLowerCase();
  const notes   = _str(p.notes, 1000);
  const submittedBy = _str(p.submitted_by, 100);
  const packageId = p.package_id ? Number(p.package_id) : null;
  const desiredTenure = _str(p.desired_tenure, 20).toLowerCase();
  const desiredUsersRaw = p.desired_users;
  const desiredUsers = (desiredUsersRaw == null || desiredUsersRaw === '' || isNaN(Number(desiredUsersRaw)))
    ? null : Math.max(1, Math.floor(Number(desiredUsersRaw)));
  const VALID_TENURES = ['month','quarter','half_year','year','2year','3year','lifetime'];
  if (desiredTenure && !VALID_TENURES.includes(desiredTenure)) {
    throw new Error('Invalid tenure');
  }

  if (!name)            throw new Error('Name is required');
  if (!_validEmail(email))  throw new Error('Valid email is required');
  if (!_validMobile(mobile)) throw new Error('Valid mobile is required');
  if (!orgName)         throw new Error('Organisation name is required');

  // basic rate-limit by email — drop obvious duplicates submitted in the last 5 min
  try {
    const r = await control.query(
      `SELECT id FROM signup_requests
        WHERE LOWER(email) = $1
          AND status = 'pending'
          AND created_at > NOW() - INTERVAL '5 minutes'
        LIMIT 1`,
      [email]
    );
    if (r.rows.length) {
      return { ok: true, id: r.rows[0].id, deduped: true };
    }
  } catch (_) {}

  const id = await control.insert('signup_requests', {
    name, email, mobile, org_name: orgName,
    desired_slug: slug || null,
    package_id: packageId,
    desired_tenure: desiredTenure || null,
    desired_users: desiredUsers,
    industry_pack: pack || null,
    notes: notes || null,
    submitted_by: submittedBy || null,
    ip_address: _str(p._ip, 80) || null,
    ua: _str(p._ua, 300) || null,
    status: 'pending'
  });
  try {
    await control.insert('audit_log', {
      actor_type: 'public', event: 'signup_request.submitted',
      detail: JSON.stringify({ id, email, org_name: orgName })
    });
  } catch (_) {}
  return { ok: true, id };
}

/* ───────── ADMIN: list ───────── */
async function api_saas_sr_list(token, filters) {
  await requireSuperAdmin(token);
  await _ensureSchema();
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.status) { params.push(f.status); where.push(`sr.status = $${params.length}`); }
  if (f.q) {
    params.push('%' + String(f.q).toLowerCase() + '%');
    where.push(`(LOWER(sr.name) LIKE $${params.length} OR LOWER(sr.email) LIKE $${params.length} OR LOWER(sr.org_name) LIKE $${params.length})`);
  }
  const sql = `
    SELECT sr.*, p.name AS package_name
      FROM signup_requests sr
      LEFT JOIN packages p ON p.id = sr.package_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY (sr.status = 'pending') DESC, sr.id DESC
     LIMIT 500`;
  const r = await control.query(sql, params);
  return r.rows;
}

/* ───────── ADMIN: count pending (for sidebar badge) ───────── */
async function api_saas_sr_pendingCount(token) {
  await requireSuperAdmin(token);
  await _ensureSchema();
  const r = await control.query(`SELECT COUNT(*)::int AS n FROM signup_requests WHERE status='pending'`);
  return { count: r.rows[0].n };
}

/* ───────── ADMIN: get one ───────── */
async function api_saas_sr_get(token, id) {
  await requireSuperAdmin(token);
  await _ensureSchema();
  return control.findById('signup_requests', id);
}

/* ───────── ADMIN: edit before approval ───────── */
async function api_saas_sr_update(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const row = await control.findById('signup_requests', p.id);
  if (!row) throw new Error('Signup request not found');
  if (row.status !== 'pending') throw new Error('Only pending requests are editable');

  const upd = {};
  ['name','email','mobile','org_name','desired_slug','desired_tenure','industry_pack','notes'].forEach(k => {
    if (p[k] !== undefined) upd[k] = _str(p[k], 200);
  });
  if (upd.email) upd.email = upd.email.toLowerCase();
  if (upd.desired_slug != null) upd.desired_slug = upd.desired_slug.toLowerCase();
  if (p.package_id !== undefined) {
    upd.package_id = p.package_id ? Number(p.package_id) : null;
  }
  if (p.desired_users !== undefined) {
    const v = p.desired_users;
    upd.desired_users = (v == null || v === '' || isNaN(Number(v))) ? null : Math.max(1, Math.floor(Number(v)));
  }
  upd.updated_at = new Date().toISOString();
  await control.update('signup_requests', row.id, upd);
  try {
    await control.insert('audit_log', {
      actor_type: 'admin', actor_email: me.email,
      event: 'signup_request.edited', detail: JSON.stringify({ id: row.id, changes: Object.keys(upd) })
    });
  } catch (_) {}
  return { ok: true };
}

/* ───────── ADMIN: approve → provision tenant ───────── */
async function api_saas_sr_approve(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const row = await control.findById('signup_requests', p.id);
  if (!row) throw new Error('Signup request not found');
  if (row.status === 'approved') {
    return {
      ok: true, alreadyApproved: true,
      login_url: row.provisioned_slug ? `${(process.env.PUBLIC_BASE_URL || 'https://crm.smartcrmsolution.com').replace(/\/+$/,'')}/t/${row.provisioned_slug}` : null,
      email: row.email,
      tenant_slug: row.provisioned_slug,
      tenant_id: row.provisioned_tenant_id
    };
  }
  if (row.status === 'rejected') throw new Error('This request was rejected — un-reject it first');

  // Final validation
  if (!row.name)            throw new Error('Name is required');
  if (!_validEmail(row.email))  throw new Error('Valid email is required');
  if (!_validMobile(row.mobile)) throw new Error('Valid mobile is required');
  if (!row.org_name)        throw new Error('Organisation name is required');
  if (!row.package_id)      throw new Error('Pick a package before approving');

  // Derive slug if missing
  let slug = (row.desired_slug || '').toLowerCase();
  if (!slug) slug = _slugify(row.org_name) || _slugify(row.email.split('@')[0]);
  if (!_validSlug(slug)) throw new Error('Workspace slug must start with a letter, 3–30 chars, only letters/digits/dashes (got "' + slug + '")');

  // Reject if slug already taken
  const existing = await control.findOneBy('tenants', 'slug', slug);
  if (existing) throw new Error('Workspace URL "' + slug + '" is already taken — edit the request and pick a different slug');

  // Create signup row + provision (mirrors super-admin manual create)
  const signupId = await control.insert('signups', {
    name: row.name, email: row.email, mobile: row.mobile, org_name: row.org_name,
    package_id: row.package_id, desired_slug: slug,
    status: 'pending',
    metadata: JSON.stringify({
      manual_create: true,
      from_signup_request: row.id,
      created_by: me.email,
      created_by_id: me.id,
      mark_paid: true,
      notes: row.notes || null,
      industry_pack: row.industry_pack || null
    })
  });

  let prov;
  try {
    prov = await provisioning.provisionFromSignup(signupId);
  } catch (e) {
    try { await control.update('signups', signupId, { status: 'abandoned', metadata: JSON.stringify({ error: e.message }) }); } catch (_) {}
    throw new Error('Provisioning failed: ' + e.message);
  }

  // Mark the auto-generated first invoice paid
  try {
    await control.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW()
        WHERE tenant_id = $1 AND status = 'pending'`,
      [prov.tenant_id]
    );
  } catch (_) {}

  // Mark signup_request approved + stash credentials so SPA can show again
  await control.update('signup_requests', row.id, {
    status: 'approved',
    provisioned_signup_id: signupId,
    provisioned_tenant_id: prov.tenant_id,
    provisioned_slug: prov.slug,
    provisioned_password: prov.password || null,
    approved_at: new Date().toISOString(),
    approved_by: me.email,
    updated_at: new Date().toISOString()
  });

  try {
    await control.insert('audit_log', {
      actor_type: 'admin', actor_email: me.email,
      event: 'signup_request.approved',
      detail: JSON.stringify({ id: row.id, tenant_id: prov.tenant_id, slug: prov.slug })
    });
  } catch (_) {}

  return {
    ok: true,
    tenant_id: prov.tenant_id,
    tenant_slug: prov.slug,
    login_url: prov.login_url,
    email: prov.email,
    password: prov.password
  };
}

/* ───────── ADMIN: reject ───────── */
async function api_saas_sr_reject(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const row = await control.findById('signup_requests', p.id);
  if (!row) throw new Error('Signup request not found');
  if (row.status === 'approved') throw new Error('Cannot reject an already-approved tenant');
  await control.update('signup_requests', row.id, {
    status: 'rejected',
    reject_reason: _str(p.reason, 500) || 'no reason given',
    approved_by: me.email,
    updated_at: new Date().toISOString()
  });
  try {
    await control.insert('audit_log', {
      actor_type: 'admin', actor_email: me.email,
      event: 'signup_request.rejected', detail: JSON.stringify({ id: row.id, reason: p.reason })
    });
  } catch (_) {}
  return { ok: true };
}

/* ───────── ADMIN: re-open a rejected one ───────── */
async function api_saas_sr_reopen(token, payload) {
  const me = await requireSuperAdmin(token);
  await _ensureSchema();
  const p = payload || {};
  const row = await control.findById('signup_requests', p.id);
  if (!row) throw new Error('Signup request not found');
  if (row.status !== 'rejected') throw new Error('Only rejected requests can be re-opened');
  await control.update('signup_requests', row.id, {
    status: 'pending', reject_reason: null,
    updated_at: new Date().toISOString()
  });
  try {
    await control.insert('audit_log', {
      actor_type: 'admin', actor_email: me.email,
      event: 'signup_request.reopened', detail: JSON.stringify({ id: row.id })
    });
  } catch (_) {}
  return { ok: true };
}

/* ───────── Express adapter for public POST ───────── */
async function expressPublicSubmit(req, res) {
  try {
    const p = Object.assign({}, req.body || {});
    p._ip = req.ip || req.connection?.remoteAddress || '';
    p._ua = (req.headers['user-agent'] || '').slice(0, 300);
    const r = await api_saas_sr_publicSubmit('', p);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

module.exports = {
  api_saas_sr_publicPackages,
  api_saas_sr_publicSubmit,
  api_saas_sr_list,
  api_saas_sr_pendingCount,
  api_saas_sr_get,
  api_saas_sr_update,
  api_saas_sr_approve,
  api_saas_sr_reject,
  api_saas_sr_reopen,
  expressPublicSubmit,
  _ensureSchema
};
