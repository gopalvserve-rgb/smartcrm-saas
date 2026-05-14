/**
 * routes/forms.js — Form Builder (Phase 1)
 *
 * Field-list editor + public render + auto-lead-create on submit.
 *
 * Public URLs (under each tenant's subdomain):
 *   GET  /t/<tenant>/f/<form-slug>          — branded responsive HTML form
 *   POST /t/<tenant>/f/<form-slug>/submit   — JSON submit → creates lead
 *
 * Schema (3 tables, idempotent migrations):
 *   forms             — meta: name, slug, branding, success behaviour
 *   form_fields       — per-form field definitions (type, label, validation, lead_field_map)
 *   form_submissions  — every submit with payload + tracking + linked lead_id
 *
 * Field types: text, email, phone, number, textarea, dropdown, checkbox,
 * radio, date, hidden, file, consent.
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const FIELD_TYPES = ['text','email','phone','number','textarea','dropdown','checkbox','radio','date','hidden','file','consent'];

// ──────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────
async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS forms (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    theme_color TEXT NOT NULL DEFAULT '#4f46e5',
    success_message TEXT NOT NULL DEFAULT 'Thank you! We will be in touch shortly.',
    redirect_url TEXT NOT NULL DEFAULT '',
    auto_create_lead INTEGER NOT NULL DEFAULT 1,
    lead_default_source TEXT NOT NULL DEFAULT 'Form',
    lead_default_status_id INTEGER,
    lead_default_assigned_to INTEGER,
    lead_default_campaign_id INTEGER,
    view_count INTEGER NOT NULL DEFAULT 0,
    submission_count INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS form_fields (
    id SERIAL PRIMARY KEY,
    form_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    field_type TEXT NOT NULL DEFAULT 'text',
    field_key TEXT NOT NULL,
    label TEXT NOT NULL,
    placeholder TEXT NOT NULL DEFAULT '',
    help_text TEXT NOT NULL DEFAULT '',
    is_required INTEGER NOT NULL DEFAULT 0,
    default_value TEXT NOT NULL DEFAULT '',
    options_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    validation_regex TEXT NOT NULL DEFAULT '',
    validation_message TEXT NOT NULL DEFAULT '',
    lead_field_map TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_form_fields_form ON form_fields(form_id, position)`);
  await db.query(`CREATE TABLE IF NOT EXISTS form_submissions (
    id SERIAL PRIMARY KEY,
    form_id INTEGER NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_ip TEXT,
    user_agent TEXT,
    referrer TEXT,
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT,
    utm_term TEXT, utm_content TEXT, gclid TEXT,
    lead_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_form_subs_form ON form_submissions(form_id, created_at DESC)`);
}

function _slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || ('form-' + Date.now());
}

async function _uniqueSlug(base, ignoreId) {
  let slug = _slugify(base);
  let n = 1;
  while (true) {
    const r = await db.query(`SELECT id FROM forms WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)`, [slug, ignoreId || null]);
    if (!r.rows.length) return slug;
    n++; slug = _slugify(base) + '-' + n;
    if (n > 999) return slug + '-' + Date.now();
  }
}

// ──────────────────────────────────────────────────────────────────
// API (admin)
// ──────────────────────────────────────────────────────────────────
async function api_forms_list(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`
    SELECT f.id, f.slug, f.name, f.description, f.is_active, f.theme_color,
           f.view_count, f.submission_count, f.created_at, f.updated_at,
           (SELECT COUNT(*)::int FROM form_fields WHERE form_id = f.id) AS field_count
      FROM forms f
     ORDER BY f.is_active DESC, f.created_at DESC
  `);
  return r.rows;
}

async function api_forms_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  const f = (await db.query(`SELECT * FROM forms WHERE id = $1`, [Number(id)])).rows[0];
  if (!f) throw new Error('Form not found');
  const fields = (await db.query(`SELECT * FROM form_fields WHERE form_id = $1 ORDER BY position ASC, id ASC`, [Number(id)])).rows;
  return { ...f, fields };
}

async function api_forms_save(token, payload) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('Form name required');
  const slug = await _uniqueSlug(p.slug || name, p.id ? Number(p.id) : null);

  let id = p.id ? Number(p.id) : null;
  if (!id) {
    const r = await db.query(
      `INSERT INTO forms
         (slug, name, description, is_active, theme_color, success_message, redirect_url,
          auto_create_lead, lead_default_source, lead_default_status_id,
          lead_default_assigned_to, lead_default_campaign_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [slug, name, String(p.description || ''), p.is_active ? 1 : 0,
       String(p.theme_color || '#4f46e5').slice(0, 20),
       String(p.success_message || 'Thank you!').slice(0, 1000),
       String(p.redirect_url || '').slice(0, 500),
       p.auto_create_lead ? 1 : 0,
       String(p.lead_default_source || 'Form').slice(0, 100),
       p.lead_default_status_id || null,
       p.lead_default_assigned_to || null,
       p.lead_default_campaign_id || null,
       me.id]
    );
    id = r.rows[0].id;
  } else {
    await db.query(
      `UPDATE forms SET slug=$2, name=$3, description=$4, is_active=$5, theme_color=$6,
              success_message=$7, redirect_url=$8, auto_create_lead=$9, lead_default_source=$10,
              lead_default_status_id=$11, lead_default_assigned_to=$12, lead_default_campaign_id=$13,
              updated_at=NOW()
        WHERE id = $1`,
      [id, slug, name, String(p.description || ''), p.is_active ? 1 : 0,
       String(p.theme_color || '#4f46e5').slice(0, 20),
       String(p.success_message || 'Thank you!').slice(0, 1000),
       String(p.redirect_url || '').slice(0, 500),
       p.auto_create_lead ? 1 : 0,
       String(p.lead_default_source || 'Form').slice(0, 100),
       p.lead_default_status_id || null,
       p.lead_default_assigned_to || null,
       p.lead_default_campaign_id || null]
    );
  }

  // Replace fields wholesale
  const fields = Array.isArray(p.fields) ? p.fields : [];
  await db.query(`DELETE FROM form_fields WHERE form_id = $1`, [id]);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const type = String(f.field_type || 'text').toLowerCase();
    if (!FIELD_TYPES.includes(type)) continue;
    const key = String(f.field_key || f.label || ('field_' + (i + 1))).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80);
    await db.query(
      `INSERT INTO form_fields
         (form_id, position, field_type, field_key, label, placeholder, help_text,
          is_required, default_value, options_json, validation_regex, validation_message, lead_field_map)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)`,
      [id, i, type, key, String(f.label || '').slice(0, 200),
       String(f.placeholder || '').slice(0, 200),
       String(f.help_text || '').slice(0, 500),
       f.is_required ? 1 : 0,
       String(f.default_value || '').slice(0, 500),
       JSON.stringify(Array.isArray(f.options) ? f.options : []),
       String(f.validation_regex || '').slice(0, 500),
       String(f.validation_message || '').slice(0, 500),
       String(f.lead_field_map || '').slice(0, 60)]
    );
  }
  return { ok: true, id, slug };
}

async function api_forms_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await _ensureSchema();
  await db.query(`DELETE FROM form_submissions WHERE form_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM form_fields WHERE form_id = $1`, [Number(id)]);
  await db.query(`DELETE FROM forms WHERE id = $1`, [Number(id)]);
  return { ok: true };
}

async function api_forms_clone(token, id) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  const src = await api_forms_get(token, id);
  const payload = {
    name: src.name + ' (copy)',
    description: src.description, theme_color: src.theme_color,
    success_message: src.success_message, redirect_url: src.redirect_url,
    is_active: 0, auto_create_lead: src.auto_create_lead,
    lead_default_source: src.lead_default_source,
    lead_default_status_id: src.lead_default_status_id,
    lead_default_assigned_to: src.lead_default_assigned_to,
    lead_default_campaign_id: src.lead_default_campaign_id,
    fields: (src.fields || []).map(f => ({
      field_type: f.field_type, field_key: f.field_key, label: f.label,
      placeholder: f.placeholder, help_text: f.help_text,
      is_required: f.is_required, default_value: f.default_value,
      options: Array.isArray(f.options_json) ? f.options_json : (typeof f.options_json === 'string' ? JSON.parse(f.options_json || '[]') : []),
      validation_regex: f.validation_regex, validation_message: f.validation_message,
      lead_field_map: f.lead_field_map
    }))
  };
  return api_forms_save(token, payload);
}

async function api_forms_submissions(token, formId, limit) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const r = await db.query(`
    SELECT s.*, l.name AS lead_name, l.phone AS lead_phone
      FROM form_submissions s
      LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.form_id = $1
     ORDER BY s.created_at DESC
     LIMIT $2
  `, [Number(formId), lim]);
  return r.rows;
}

// ──────────────────────────────────────────────────────────────────
// Public render (no auth)
// ──────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _renderField(f, prefill) {
  const val = (prefill && prefill[f.field_key] != null) ? prefill[f.field_key] : (f.default_value || '');
  const req = f.is_required ? 'required' : '';
  const ph = _esc(f.placeholder || '');
  const id = 'f_' + f.field_key;
  const labelHtml = f.field_type === 'hidden' ? '' :
    `<label for="${id}">${_esc(f.label)}${f.is_required ? ' <span style="color:#dc2626">*</span>' : ''}</label>`;
  let input = '';
  switch (f.field_type) {
    case 'textarea':
      input = `<textarea id="${id}" name="${f.field_key}" placeholder="${ph}" ${req} rows="4">${_esc(val)}</textarea>`;
      break;
    case 'dropdown': {
      let opts = Array.isArray(f.options_json) ? f.options_json : (typeof f.options_json === 'string' ? JSON.parse(f.options_json || '[]') : []);
      opts = (opts || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
      input = `<select id="${id}" name="${f.field_key}" ${req}><option value="">— Select —</option>` +
        opts.map(o => `<option value="${_esc(o.value)}" ${String(val) === String(o.value) ? 'selected' : ''}>${_esc(o.label)}</option>`).join('') +
        `</select>`;
      break;
    }
    case 'checkbox':
    case 'consent':
      input = `<label class="cb"><input type="checkbox" id="${id}" name="${f.field_key}" value="1" ${val ? 'checked' : ''} ${req}> <span>${_esc(f.help_text || f.label)}</span></label>`;
      break;
    case 'radio': {
      let opts = Array.isArray(f.options_json) ? f.options_json : (typeof f.options_json === 'string' ? JSON.parse(f.options_json || '[]') : []);
      opts = (opts || []).map(o => typeof o === 'string' ? { value: o, label: o } : o);
      input = opts.map((o, i) =>
        `<label class="rb"><input type="radio" name="${f.field_key}" value="${_esc(o.value)}" ${String(val) === String(o.value) ? 'checked' : ''} ${i === 0 && f.is_required ? 'required' : ''}> <span>${_esc(o.label)}</span></label>`
      ).join('');
      break;
    }
    case 'hidden':
      input = `<input type="hidden" id="${id}" name="${f.field_key}" value="${_esc(val)}">`;
      break;
    case 'file':
      input = `<input type="file" id="${id}" name="${f.field_key}" ${req}>`;
      break;
    case 'date':
      input = `<input type="date" id="${id}" name="${f.field_key}" value="${_esc(val)}" ${req}>`;
      break;
    case 'number':
      input = `<input type="number" id="${id}" name="${f.field_key}" value="${_esc(val)}" placeholder="${ph}" ${req}>`;
      break;
    case 'phone':
      input = `<input type="tel" id="${id}" name="${f.field_key}" value="${_esc(val)}" placeholder="${ph}" ${req}>`;
      break;
    case 'email':
      input = `<input type="email" id="${id}" name="${f.field_key}" value="${_esc(val)}" placeholder="${ph}" ${req}>`;
      break;
    default:
      input = `<input type="text" id="${id}" name="${f.field_key}" value="${_esc(val)}" placeholder="${ph}" ${req}>`;
  }
  const help = (f.field_type !== 'checkbox' && f.field_type !== 'consent' && f.help_text)
    ? `<div class="help">${_esc(f.help_text)}</div>` : '';
  return f.field_type === 'hidden' ? input : `<div class="field">${labelHtml}${input}${help}</div>`;
}

async function expressRenderForm(req, res) {
  try {
    await _ensureSchema();
    const slug = String(req.params.formSlug || '').trim();
    const form = (await db.query(`SELECT * FROM forms WHERE slug = $1`, [slug])).rows[0];
    if (!form) return res.status(404).send('<h1>Form not found</h1>');
    if (!Number(form.is_active)) return res.status(410).send('<h1>This form is no longer accepting submissions</h1>');
    const fields = (await db.query(`SELECT * FROM form_fields WHERE form_id = $1 ORDER BY position ASC, id ASC`, [form.id])).rows;

    try { await db.query(`UPDATE forms SET view_count = view_count + 1 WHERE id = $1`, [form.id]); } catch (_) {}

    const prefill = req.query || {};
    const themeColor = form.theme_color || '#4f46e5';
    const tenantSlug = req.tenantSlug || (req.tenant && req.tenant.slug) || '';
    const submitUrl = (tenantSlug ? '/t/' + tenantSlug : '') + '/f/' + slug + '/submit';

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${_esc(form.name)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<style>
:root { --primary: ${_esc(themeColor)}; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; color: #1e293b; line-height: 1.5; }
.wrap { max-width: 560px; margin: 2rem auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(15,23,42,0.08); overflow: hidden; }
.hdr { padding: 1.5rem 1.75rem 1rem; border-bottom: 1px solid #e2e8f0; }
.hdr h1 { margin: 0 0 .25rem; font-size: 1.5rem; color: var(--primary); }
.hdr p  { margin: 0; color: #64748b; font-size: .95rem; }
.body { padding: 1.5rem 1.75rem; }
.field { margin-bottom: 1.1rem; }
label { display: block; font-weight: 600; font-size: .9rem; color: #334155; margin-bottom: .35rem; }
input[type=text], input[type=email], input[type=tel], input[type=number], input[type=date], select, textarea {
  width: 100%; padding: .65rem .75rem; font-size: 1rem; border: 1.5px solid #cbd5e1; border-radius: 8px;
  background: #fff; color: #1e293b; transition: border .15s, box-shadow .15s; font-family: inherit;
}
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px ${_esc(themeColor)}22; }
textarea { resize: vertical; min-height: 90px; }
.cb, .rb { display: flex; align-items: center; gap: .5rem; font-weight: normal; margin-bottom: .35rem; }
.cb input, .rb input { width: 1.1rem; height: 1.1rem; margin: 0; }
.help { font-size: .78rem; color: #64748b; margin-top: .25rem; }
button[type=submit] { width: 100%; padding: .85rem 1rem; font-size: 1rem; font-weight: 600; background: var(--primary); color: #fff; border: none; border-radius: 8px; cursor: pointer; margin-top: .5rem; }
button[type=submit]:hover { filter: brightness(0.94); }
button[type=submit]:disabled { opacity: .55; cursor: progress; }
.ok { background: #ecfdf5; color: #065f46; padding: 1.25rem; border-radius: 8px; text-align: center; font-weight: 500; }
.err { background: #fef2f2; color: #991b1b; padding: .75rem 1rem; border-radius: 8px; margin-bottom: 1rem; font-size: .9rem; }
.footer { padding: .75rem 1.75rem 1rem; text-align: center; font-size: .72rem; color: #94a3b8; }
@media (max-width: 600px) { .wrap { margin: 0; border-radius: 0; box-shadow: none; min-height: 100vh; } }
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <h1>${_esc(form.name)}</h1>
    ${form.description ? `<p>${_esc(form.description)}</p>` : ''}
  </div>
  <div class="body">
    <div id="err" class="err" style="display:none"></div>
    <form id="frm" method="post" action="${_esc(submitUrl)}">
      ${fields.map(f => _renderField(f, prefill)).join('\n')}
      <!-- Honeypot -->
      <input type="text" name="_h" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off">
      <input type="hidden" name="utm_source"   value="${_esc(prefill.utm_source || '')}">
      <input type="hidden" name="utm_medium"   value="${_esc(prefill.utm_medium || '')}">
      <input type="hidden" name="utm_campaign" value="${_esc(prefill.utm_campaign || '')}">
      <input type="hidden" name="utm_term"     value="${_esc(prefill.utm_term || '')}">
      <input type="hidden" name="utm_content"  value="${_esc(prefill.utm_content || '')}">
      <input type="hidden" name="gclid"        value="${_esc(prefill.gclid || '')}">
      <input type="hidden" name="_lp"          value="${_esc(prefill.lp || '')}">
      <button type="submit" id="sb">Submit</button>
    </form>
    <div id="ok" class="ok" style="display:none">${_esc(form.success_message || 'Thank you!')}</div>
  </div>
  <div class="footer">Powered by SmartCRM</div>
</div>
<script>
(function(){
  var f = document.getElementById('frm'), sb = document.getElementById('sb');
  var er = document.getElementById('err'), ok = document.getElementById('ok');
  f.addEventListener('submit', function(ev) {
    ev.preventDefault();
    er.style.display = 'none';
    sb.disabled = true; sb.textContent = 'Sending…';
    var data = new FormData(f);
    var json = {};
    data.forEach(function(v, k) {
      if (json[k] !== undefined) { json[k] = [].concat(json[k], v); } else { json[k] = v; }
    });
    fetch(f.action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json)
    }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
    .then(function(res) {
      sb.disabled = false; sb.textContent = 'Submit';
      if (!res.ok || res.body.error) {
        er.textContent = res.body.error || 'Submission failed';
        er.style.display = 'block';
        return;
      }
      ${form.redirect_url ? `setTimeout(function(){ window.location.href = ${JSON.stringify(form.redirect_url)}; }, 600);` : ''}
      f.style.display = 'none'; ok.style.display = 'block';
    })
    .catch(function(e) {
      sb.disabled = false; sb.textContent = 'Submit';
      er.textContent = 'Network error. Please try again.';
      er.style.display = 'block';
    });
  });
})();
</script>
</body>
</html>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    console.error('[/f] render error:', e);
    res.status(500).send('<h1>Form error</h1><pre>' + _esc(e.message) + '</pre>');
  }
}

async function expressSubmitForm(req, res) {
  try {
    await _ensureSchema();
    const slug = String(req.params.formSlug || '').trim();
    const form = (await db.query(`SELECT * FROM forms WHERE slug = $1`, [slug])).rows[0];
    if (!form) return res.status(404).json({ error: 'Form not found' });
    if (!Number(form.is_active)) return res.status(410).json({ error: 'Form not accepting submissions' });

    // Honeypot — bots fill this hidden field
    if (req.body && req.body._h) return res.json({ ok: true, ignored: true });

    const fields = (await db.query(`SELECT * FROM form_fields WHERE form_id = $1 ORDER BY position ASC`, [form.id])).rows;
    const payload = {};
    const errors = [];
    for (const f of fields) {
      const raw = req.body && req.body[f.field_key];
      let v = raw == null ? '' : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
      if (Number(f.is_required) && !v.trim() && f.field_type !== 'consent') {
        errors.push(f.label + ' is required'); continue;
      }
      if (f.field_type === 'consent' && Number(f.is_required) && !raw) {
        errors.push((f.label || 'Consent') + ' is required'); continue;
      }
      if (f.validation_regex && v) {
        try {
          if (!new RegExp(f.validation_regex).test(v)) {
            errors.push(f.validation_message || (f.label + ' is invalid')); continue;
          }
        } catch (_) {}
      }
      payload[f.field_key] = v;
    }
    if (errors.length) return res.status(400).json({ error: errors.join(' · ') });

    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';
    const ref = req.headers.referer || req.headers.referrer || '';

    // Auto-create lead?
    let leadId = null;
    if (Number(form.auto_create_lead)) {
      const lead = {
        name: '', phone: '', whatsapp: '', email: '', city: '', company: '', address: '',
        notes: 'Submitted via form: ' + form.name,
        source: form.lead_default_source || 'Form',
        source_ref: 'form:' + form.slug,
        status_id: form.lead_default_status_id || null,
        assigned_to: form.lead_default_assigned_to || null,
        campaign_id: form.lead_default_campaign_id || null,
        utm_source: req.body.utm_source || null,
        utm_medium: req.body.utm_medium || null,
        utm_campaign: req.body.utm_campaign || null,
        utm_term: req.body.utm_term || null,
        utm_content: req.body.utm_content || null,
        gclid: req.body.gclid || null,
        created_at: db.nowIso(), updated_at: db.nowIso()
      };
      const extra_json = {};
      for (const f of fields) {
        const v = payload[f.field_key];
        if (!v) continue;
        const map = String(f.lead_field_map || '').trim();
        if (map && map in lead) lead[map] = v;
        else extra_json[f.field_key] = v;
      }
      if (Object.keys(extra_json).length) lead.extra_json = JSON.stringify(extra_json);
      if (!lead.name) lead.name = lead.phone || lead.email || ('Form submission ' + Date.now());
      try {
        leadId = await db.insert('leads', lead);
      } catch (e) {
        console.warn('[/f/submit] lead insert failed:', e.message);
      }
    }

    await db.query(
      `INSERT INTO form_submissions (form_id, payload, source_ip, user_agent, referrer,
                                     utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid, lead_id)
       VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [form.id, JSON.stringify(payload), String(ip).slice(0, 100), String(ua).slice(0, 500), String(ref).slice(0, 500),
       req.body.utm_source || null, req.body.utm_medium || null, req.body.utm_campaign || null,
       req.body.utm_term || null, req.body.utm_content || null, req.body.gclid || null, leadId]
    );
    await db.query(`UPDATE forms SET submission_count = submission_count + 1 WHERE id = $1`, [form.id]);

    // Phase-2: landing-page conversion attribution. The page builder appends
    // ?lp=<page_slug> to the iframe URL when embedding this form. The form
    // page passes it through as a hidden field on submit so we can bump
    // landing_pages.conversion_count for the page that drove the lead.
    try {
      const lpSlug = String((req.body && req.body._lp) || req.query.lp || '').trim();
      if (lpSlug) {
        await db.query(`UPDATE landing_pages SET conversion_count = conversion_count + 1 WHERE slug = $1`, [lpSlug]);
      }
    } catch (_) {}

    // Fire automations + nurture auto-enroll
    if (leadId) {
      try { require('../utils/automations').fire('lead_created', { lead: Object.assign({ id: leadId }, payload), user: null }); } catch (_) {}
      try { require('./nurture')._tryAutoEnroll('lead_created', { lead: { id: leadId, ...payload, source: form.lead_default_source }, user: null }); } catch (_) {}
    }

    return res.json({ ok: true, lead_id: leadId });
  } catch (e) {
    console.error('[/f/submit]', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = {
  api_forms_list, api_forms_get, api_forms_save, api_forms_delete,
  api_forms_clone, api_forms_submissions,
  expressRenderForm, expressSubmitForm, _ensureSchema
};
