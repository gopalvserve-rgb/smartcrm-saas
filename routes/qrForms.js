/**
 * QR Forms — public, branded lead-capture forms with QR code support.
 *
 * Each tenant can create N forms (e.g. one per event / campaign).
 * A form has:
 *   - slug      (URL-safe, unique per tenant — used in the public URL)
 *   - name      (admin-facing label)
 *   - title     (heading on the public form)
 *   - subtitle  (sub-heading)
 *   - fields    (which standard fields are shown: name/phone/email/company/
 *                city/message — phone is always required and shown)
 *   - source    (text label written to lead.source on submit)
 *   - status    (active / inactive — inactive returns a friendly closed page)
 *   - thank_you_text (shown after submission)
 *
 * Public URL: /t/<tenant-slug>/form/<form-slug>
 *
 * On submit we call api_leads_create with the form's source label so
 * the lead lands in CRM exactly as if it came from the website hook.
 */

'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const STD_FIELDS = ['name', 'phone', 'email', 'company', 'city', 'message'];

async function _ensureTable() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS qr_forms (
        id              SERIAL PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        title           TEXT NOT NULL DEFAULT 'Tell us about yourself',
        subtitle        TEXT NOT NULL DEFAULT 'We''ll get in touch shortly.',
        fields_json     TEXT NOT NULL DEFAULT '["name","phone","email"]',
        source          TEXT NOT NULL DEFAULT 'QR Form',
        status_id       INTEGER,
        assigned_to     INTEGER,
        thank_you_text  TEXT NOT NULL DEFAULT 'Thanks! We''ll be in touch shortly.',
        is_active       INTEGER NOT NULL DEFAULT 1,
        submissions     INTEGER NOT NULL DEFAULT 0,
        created_by      INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_qr_forms_slug ON qr_forms(slug)`);
  } catch (e) { console.warn('[qr-forms] schema:', e.message); }
}

function _slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || ('form-' + Date.now());
}

async function api_qrForms_list(token) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin / manager only');
  await _ensureTable();
  const { rows } = await db.query(
    `SELECT id, slug, name, title, subtitle, source, status_id, assigned_to,
            is_active, submissions, created_at, updated_at
       FROM qr_forms ORDER BY created_at DESC`
  );
  return rows;
}

async function api_qrForms_save(token, payload) {
  const me = await authUser(token);
  if (me.role !== 'admin' && me.role !== 'manager') throw new Error('Admin / manager only');
  await _ensureTable();
  const p = payload || {};
  const id = Number(p.id) || 0;
  const slug = p.slug ? _slugify(p.slug) : _slugify(p.name);
  if (!p.name || !p.name.trim()) throw new Error('Name required');
  if (!slug) throw new Error('Slug could not be generated');

  // Validate fields
  let fields = Array.isArray(p.fields) ? p.fields : ['name', 'phone', 'email'];
  fields = fields.filter(f => STD_FIELDS.includes(f));
  if (!fields.includes('phone')) fields.push('phone'); // phone always required

  if (id) {
    // Update
    await db.query(
      `UPDATE qr_forms SET slug=$1, name=$2, title=$3, subtitle=$4,
         fields_json=$5, source=$6, status_id=$7, assigned_to=$8,
         thank_you_text=$9, is_active=$10, updated_at=NOW()
       WHERE id=$11`,
      [slug, p.name.trim(), p.title || 'Tell us about yourself',
       p.subtitle || '', JSON.stringify(fields),
       p.source || 'QR Form',
       Number(p.status_id) || null, Number(p.assigned_to) || null,
       p.thank_you_text || "Thanks! We'll be in touch shortly.",
       Number(p.is_active) === 0 ? 0 : 1, id]
    );
    return { ok: true, id };
  }
  // Insert — generate unique slug if collision
  let finalSlug = slug;
  for (let i = 0; i < 20; i++) {
    const r = await db.query('SELECT 1 FROM qr_forms WHERE slug=$1', [finalSlug]);
    if (!r.rows.length) break;
    finalSlug = slug + '-' + (i + 2);
  }
  const ins = await db.query(
    `INSERT INTO qr_forms (slug, name, title, subtitle, fields_json, source,
       status_id, assigned_to, thank_you_text, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [finalSlug, p.name.trim(), p.title || 'Tell us about yourself',
     p.subtitle || '', JSON.stringify(fields),
     p.source || 'QR Form',
     Number(p.status_id) || null, Number(p.assigned_to) || null,
     p.thank_you_text || "Thanks! We'll be in touch shortly.",
     Number(p.is_active) === 0 ? 0 : 1, me.id]
  );
  return { ok: true, id: Number(ins.rows[0].id), slug: finalSlug };
}

async function api_qrForms_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureTable();
  await db.query('DELETE FROM qr_forms WHERE id=$1', [Number(id)]);
  return { ok: true };
}

/* ---------------- Public HTML form ---------------- */
async function expressRenderForm(req, res) {
  await _ensureTable();
  const formSlug = String(req.params.formSlug || '').toLowerCase();
  const tenant = req.tenant || {};
  let form = null;
  try {
    const r = await db.query('SELECT * FROM qr_forms WHERE slug=$1', [formSlug]);
    form = r.rows[0];
  } catch (_) {}

  // Branding from tenant config
  let brand = { name: tenant.name || 'Lead CRM', logo: '', primary: '#6366f1' };
  try {
    const rows = await db.getAll('config');
    const cfg = {}; rows.forEach(r => cfg[r.key] = r.value);
    brand.name = cfg.COMPANY_NAME || brand.name;
    brand.logo = cfg.COMPANY_LOGO_URL || cfg.BRAND_LOGO_URL || '';
    brand.primary = cfg.BRAND_PRIMARY_COLOR || brand.primary;
  } catch (_) {}

  if (!form) {
    return res.status(404).type('html').send(_renderShell(brand,
      '<h2 style="margin:0 0 .5rem">Form not found</h2><p class="muted">This QR / link is no longer active.</p>'));
  }
  if (Number(form.is_active) !== 1) {
    return res.type('html').send(_renderShell(brand,
      '<h2 style="margin:0 0 .5rem">📵 Form closed</h2><p class="muted">This form is currently inactive. Please reach out to ' +
      _esc(brand.name) + ' directly.</p>'));
  }
  const fields = JSON.parse(form.fields_json || '[]');
  const fieldHtml = fields.map(f => _renderField(f)).join('\n');
  const submitUrl = '/t/' + tenant.slug + '/form/' + form.slug + '/submit';

  const body = `
    <h2 style="margin:0 0 .35rem">${_esc(form.title)}</h2>
    <p class="muted" style="margin:0 0 1.1rem">${_esc(form.subtitle || '')}</p>
    <form id="qrForm" method="POST" action="${_esc(submitUrl)}">
      ${fieldHtml}
      <button type="submit" class="btn-primary">Submit</button>
    </form>
    <div id="ok" style="display:none">
      <div style="font-size:3rem;text-align:center;margin:.5rem 0">✅</div>
      <p style="text-align:center;font-size:1.05rem;line-height:1.5;margin:0">${_esc(form.thank_you_text)}</p>
    </div>
    <script>
      (function(){
        const f = document.getElementById('qrForm');
        f.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const btn = f.querySelector('button');
          btn.disabled = true; btn.textContent = 'Submitting…';
          const data = {};
          new FormData(f).forEach((v,k) => data[k] = v);
          try {
            const r = await fetch(${JSON.stringify(submitUrl)}, {
              method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify(data)
            });
            const j = await r.json();
            if (j && j.ok) {
              f.style.display = 'none';
              document.getElementById('ok').style.display = 'block';
            } else {
              btn.disabled = false; btn.textContent = 'Submit';
              alert(j.error || 'Submission failed. Please try again.');
            }
          } catch (e) {
            btn.disabled = false; btn.textContent = 'Submit';
            alert('Network error. Please try again.');
          }
        });
      })();
    </script>
  `;
  res.type('html').send(_renderShell(brand, body));
}

async function expressSubmitForm(req, res) {
  await _ensureTable();
  const formSlug = String(req.params.formSlug || '').toLowerCase();
  const r = await db.query('SELECT * FROM qr_forms WHERE slug=$1 AND is_active=1', [formSlug]);
  const form = r.rows[0];
  if (!form) return res.status(404).json({ error: 'Form not found or inactive' });

  const body = req.body || {};
  const fields = JSON.parse(form.fields_json || '[]');

  // Build the lead payload — only fields that the form actually advertises
  const lead = { source: form.source || 'QR Form' };
  fields.forEach(f => { if (body[f]) lead[f] = String(body[f]).trim().slice(0, 500); });
  // Always include phone — required for de-dup
  if (!lead.phone && body.phone) lead.phone = String(body.phone).trim().slice(0, 50);
  if (!lead.phone || String(lead.phone).replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }
  if (!lead.name) lead.name = lead.phone;
  if (form.status_id) lead.status_id = form.status_id;
  if (form.assigned_to) lead.assigned_to = form.assigned_to;
  // Source-ref records the form slug so admins can see which QR brought the lead
  lead.source_ref = 'qr/' + form.slug;

  // Create the lead. Use a service-token if we have one stored, else
  // borrow the form's creator (or skip auth via a special bypass).
  // For now we synthesise a system token by calling api_leads_create
  // with the form's owner. Falls back to admin lookup.
  try {
    const leadRoutes = require('./leads');
    // Find a user to attribute the create to — prefer form.assigned_to, else first admin
    let asUserId = Number(form.assigned_to) || 0;
    if (!asUserId) {
      const a = await db.query(`SELECT id FROM users WHERE role='admin' AND COALESCE(is_active,1)=1 ORDER BY id LIMIT 1`);
      asUserId = a.rows[0] && Number(a.rows[0].id);
    }
    if (!asUserId) return res.status(500).json({ error: 'No admin user available to attribute lead' });
    // Mint a one-shot JWT — same pattern other public endpoints use.
    const jwt = require('jsonwebtoken');
    const secret = process.env.JWT_SECRET || 'change-me-in-production';
    const fakeToken = jwt.sign({ id: asUserId, role: 'admin' }, secret, { expiresIn: '5m' });
    const result = await leadRoutes.api_leads_create(fakeToken, lead);
    // Increment submissions counter
    await db.query('UPDATE qr_forms SET submissions = submissions + 1 WHERE id=$1', [form.id]);
    return res.json({ ok: true, lead_id: result && result.id });
  } catch (e) {
    console.error('[qr-form submit]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

/* ---------------- HTML helpers ---------------- */
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _renderField(f) {
  const label = {
    name: 'Your name', phone: 'Phone *', email: 'Email',
    company: 'Company', city: 'City', message: 'Message'
  }[f] || f;
  const type = f === 'email' ? 'email' : (f === 'phone' ? 'tel' : 'text');
  const required = f === 'phone' ? 'required' : '';
  if (f === 'message') {
    return `<label>${_esc(label)}<textarea name="${f}" rows="3"></textarea></label>`;
  }
  return `<label>${_esc(label)}<input type="${type}" name="${f}" ${required} autocomplete="${f === 'phone' ? 'tel' : (f === 'email' ? 'email' : 'on')}" /></label>`;
}

function _renderShell(brand, innerHtml) {
  const logo = brand.logo
    ? `<img src="${_esc(brand.logo)}" alt="logo" style="max-height:48px;max-width:160px;object-fit:contain" />`
    : `<div style="font-size:1.4rem;font-weight:700;color:${_esc(brand.primary)}">${_esc(brand.name)}</div>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no"/>
<title>${_esc(brand.name)} — Contact form</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%); min-height: 100vh; color: #0f172a; padding: 1rem; }
  .wrap { max-width: 480px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: center; padding: 1.2rem 0; min-height: 60px; }
  .card { background: #fff; border-radius: 14px; padding: 1.4rem 1.2rem; box-shadow: 0 6px 24px rgba(15,23,42,.07);
          border: 1px solid #e2e8f0; }
  h2 { font-size: 1.3rem; }
  .muted { color: #64748b; font-size: .9rem; }
  label { display: block; margin: .7rem 0; font-size: .85rem; color: #334155; font-weight: 600; }
  input, textarea { display: block; width: 100%; padding: .65rem .7rem; border: 1px solid #cbd5e1;
                    border-radius: 8px; font-size: 1rem; margin-top: .25rem;
                    transition: border-color .15s; background: #fff; color: #0f172a; }
  input:focus, textarea:focus { outline: none; border-color: ${_esc(brand.primary)}; box-shadow: 0 0 0 3px ${_esc(brand.primary)}33; }
  .btn-primary { display: block; width: 100%; padding: .75rem; background: ${_esc(brand.primary)};
                 color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600;
                 cursor: pointer; margin-top: 1rem; }
  .btn-primary:disabled { opacity: .6; cursor: wait; }
  footer { text-align: center; margin-top: 1.2rem; font-size: .75rem; color: #94a3b8; }
</style>
</head><body>
<div class="wrap">
  <header>${logo}</header>
  <div class="card">${innerHtml}</div>
  <footer>Powered by ${_esc(brand.name)}</footer>
</div>
</body></html>`;
}

module.exports = {
  api_qrForms_list, api_qrForms_save, api_qrForms_delete,
  expressRenderForm, expressSubmitForm
};
