/**
 * routes/pages.js — Landing Page Builder (Phase 1)
 *
 * Section-based composer. Each page is a row in landing_pages with a
 * JSON `sections` array describing the page's content. The public render
 * walks the sections and emits a clean responsive HTML page.
 *
 * Supported section types (Phase 1):
 *   hero        — big heading, subheading, optional image, CTA button
 *   features    — 3-column feature grid (icon + title + body)
 *   text        — single rich-text block
 *   image       — full-width image with optional caption
 *   form        — embeds a form-builder form (form_id from forms table)
 *   testimonials— list of quote/author cards
 *   faq         — accordion-style Q/A list
 *   cta         — centered call-to-action with button
 *   pricing     — 3-column pricing table
 *   contact     — email / phone / address card
 *   footer      — copyright + links
 *
 * Public URL: /t/<tenant>/p/<page-slug>
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS landing_pages (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    theme_color TEXT NOT NULL DEFAULT '#4f46e5',
    theme_bg TEXT NOT NULL DEFAULT '#ffffff',
    theme_font TEXT NOT NULL DEFAULT 'system',
    sections JSONB NOT NULL DEFAULT '[]'::jsonb,
    seo_title TEXT NOT NULL DEFAULT '',
    seo_description TEXT NOT NULL DEFAULT '',
    og_image TEXT NOT NULL DEFAULT '',
    favicon_url TEXT NOT NULL DEFAULT '',
    custom_css TEXT NOT NULL DEFAULT '',
    view_count INTEGER NOT NULL DEFAULT 0,
    conversion_count INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

function _slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || ('page-' + Date.now());
}
async function _uniqueSlug(base, ignoreId) {
  let slug = _slugify(base), n = 1;
  while (true) {
    const r = await db.query(`SELECT id FROM landing_pages WHERE slug = $1 AND ($2::int IS NULL OR id <> $2)`, [slug, ignoreId || null]);
    if (!r.rows.length) return slug;
    n++; slug = _slugify(base) + '-' + n;
    if (n > 999) return slug + '-' + Date.now();
  }
}

// ──────────────────────────────────────────────────────────────────
// Admin APIs
// ──────────────────────────────────────────────────────────────────
async function api_pages_list(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`
    SELECT id, slug, name, description, is_active, theme_color,
           view_count, conversion_count, created_at, updated_at,
           jsonb_array_length(sections) AS section_count
      FROM landing_pages ORDER BY is_active DESC, created_at DESC
  `);
  return r.rows;
}
async function api_pages_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`SELECT * FROM landing_pages WHERE id = $1`, [Number(id)]);
  if (!r.rows[0]) throw new Error('Page not found');
  return r.rows[0];
}
async function api_pages_save(token, payload) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  const p = payload || {};
  const name = String(p.name || '').trim();
  if (!name) throw new Error('Page name required');
  const slug = await _uniqueSlug(p.slug || name, p.id ? Number(p.id) : null);
  const sections = JSON.stringify(Array.isArray(p.sections) ? p.sections : []);

  let id = p.id ? Number(p.id) : null;
  if (!id) {
    const r = await db.query(
      `INSERT INTO landing_pages
         (slug, name, description, is_active, theme_color, theme_bg, theme_font,
          sections, seo_title, seo_description, og_image, favicon_url, custom_css, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [slug, name, String(p.description || ''), p.is_active ? 1 : 0,
       String(p.theme_color || '#4f46e5').slice(0, 20),
       String(p.theme_bg || '#ffffff').slice(0, 20),
       String(p.theme_font || 'system').slice(0, 60),
       sections,
       String(p.seo_title || '').slice(0, 200),
       String(p.seo_description || '').slice(0, 500),
       String(p.og_image || '').slice(0, 500),
       String(p.favicon_url || '').slice(0, 500),
       String(p.custom_css || '').slice(0, 20000),
       me.id]
    );
    id = r.rows[0].id;
  } else {
    await db.query(
      `UPDATE landing_pages SET slug=$2, name=$3, description=$4, is_active=$5,
              theme_color=$6, theme_bg=$7, theme_font=$8, sections=$9::jsonb,
              seo_title=$10, seo_description=$11, og_image=$12, favicon_url=$13,
              custom_css=$14, updated_at=NOW() WHERE id=$1`,
      [id, slug, name, String(p.description || ''), p.is_active ? 1 : 0,
       String(p.theme_color || '#4f46e5').slice(0, 20),
       String(p.theme_bg || '#ffffff').slice(0, 20),
       String(p.theme_font || 'system').slice(0, 60),
       sections,
       String(p.seo_title || '').slice(0, 200),
       String(p.seo_description || '').slice(0, 500),
       String(p.og_image || '').slice(0, 500),
       String(p.favicon_url || '').slice(0, 500),
       String(p.custom_css || '').slice(0, 20000)]
    );
  }
  return { ok: true, id, slug };
}
async function api_pages_delete(token, id) {
  const me = await authUser(token);
  if (me.role !== 'admin') throw new Error('Admin only');
  await db.query(`DELETE FROM landing_pages WHERE id = $1`, [Number(id)]);
  return { ok: true };
}
async function api_pages_clone(token, id) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  const src = await api_pages_get(token, id);
  return api_pages_save(token, {
    name: src.name + ' (copy)',
    description: src.description,
    theme_color: src.theme_color, theme_bg: src.theme_bg, theme_font: src.theme_font,
    sections: src.sections, is_active: 0,
    seo_title: src.seo_title, seo_description: src.seo_description,
    og_image: src.og_image, favicon_url: src.favicon_url, custom_css: src.custom_css
  });
}

// ──────────────────────────────────────────────────────────────────
// Public renderer
// ──────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _renderSection(s, ctx) {
  const t = (s && s.type || '').toLowerCase();
  if (t === 'hero') {
    return `<section class="lp-hero">
      <div class="lp-container">
        ${s.eyebrow ? `<div class="lp-eyebrow">${_esc(s.eyebrow)}</div>` : ''}
        <h1>${_esc(s.heading || '')}</h1>
        ${s.subheading ? `<p class="lp-sub">${_esc(s.subheading)}</p>` : ''}
        ${s.cta_label ? `<a class="lp-btn" href="${_esc(s.cta_url || '#contact')}">${_esc(s.cta_label)}</a>` : ''}
        ${s.image_url ? `<img class="lp-hero-img" src="${_esc(s.image_url)}" alt="">` : ''}
      </div>
    </section>`;
  }
  if (t === 'features') {
    const items = Array.isArray(s.items) ? s.items : [];
    return `<section class="lp-features"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      <div class="lp-grid">
        ${items.map(i => `<div class="lp-card">
          ${i.icon ? `<div class="lp-icon">${_esc(i.icon)}</div>` : ''}
          <h3>${_esc(i.title || '')}</h3>
          <p>${_esc(i.body || '')}</p>
        </div>`).join('')}
      </div>
    </div></section>`;
  }
  if (t === 'text') {
    return `<section class="lp-text"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      <div class="lp-body">${String(s.body || '').split('\n').map(l => `<p>${_esc(l)}</p>`).join('')}</div>
    </div></section>`;
  }
  if (t === 'image') {
    return `<section class="lp-image"><div class="lp-container">
      ${s.image_url ? `<img src="${_esc(s.image_url)}" alt="${_esc(s.caption || '')}">` : ''}
      ${s.caption ? `<div class="lp-caption">${_esc(s.caption)}</div>` : ''}
    </div></section>`;
  }
  if (t === 'form') {
    const slug = String(s.form_slug || '').trim();
    if (!slug) return '';
    const lpParam = ctx.pageSlug ? '?lp=' + encodeURIComponent(ctx.pageSlug) : '';
    const formUrl = (ctx.tenantSlug ? '/t/' + ctx.tenantSlug : '') + '/f/' + slug + lpParam;
    return `<section class="lp-form" id="contact"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      ${s.subheading ? `<p class="lp-sub">${_esc(s.subheading)}</p>` : ''}
      <iframe class="lp-form-frame" src="${_esc(formUrl)}" frameborder="0" loading="lazy"></iframe>
    </div></section>`;
  }
  if (t === 'testimonials') {
    const items = Array.isArray(s.items) ? s.items : [];
    return `<section class="lp-testimonials"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      <div class="lp-grid">
        ${items.map(i => `<div class="lp-quote">
          <blockquote>${_esc(i.quote || '')}</blockquote>
          <cite>— ${_esc(i.author || '')}${i.role ? ', ' + _esc(i.role) : ''}</cite>
        </div>`).join('')}
      </div>
    </div></section>`;
  }
  if (t === 'faq') {
    const items = Array.isArray(s.items) ? s.items : [];
    return `<section class="lp-faq"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      ${items.map(i => `<details class="lp-faq-item">
        <summary>${_esc(i.q || '')}</summary>
        <div>${_esc(i.a || '')}</div>
      </details>`).join('')}
    </div></section>`;
  }
  if (t === 'cta') {
    return `<section class="lp-cta"><div class="lp-container">
      <h2>${_esc(s.heading || '')}</h2>
      ${s.subheading ? `<p>${_esc(s.subheading)}</p>` : ''}
      ${s.cta_label ? `<a class="lp-btn lp-btn-lg" href="${_esc(s.cta_url || '#contact')}">${_esc(s.cta_label)}</a>` : ''}
    </div></section>`;
  }
  if (t === 'pricing') {
    const items = Array.isArray(s.items) ? s.items : [];
    return `<section class="lp-pricing"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      <div class="lp-grid">
        ${items.map(i => `<div class="lp-plan ${i.featured ? 'featured' : ''}">
          <h3>${_esc(i.name || '')}</h3>
          <div class="lp-price">${_esc(i.price || '')}</div>
          <ul>${(i.features || []).map(f => `<li>${_esc(f)}</li>`).join('')}</ul>
          ${i.cta_label ? `<a class="lp-btn" href="${_esc(i.cta_url || '#contact')}">${_esc(i.cta_label)}</a>` : ''}
        </div>`).join('')}
      </div>
    </div></section>`;
  }
  if (t === 'contact') {
    return `<section class="lp-contact" id="contact"><div class="lp-container">
      ${s.heading ? `<h2>${_esc(s.heading)}</h2>` : ''}
      <div class="lp-contact-grid">
        ${s.email ? `<div><strong>Email</strong><br><a href="mailto:${_esc(s.email)}">${_esc(s.email)}</a></div>` : ''}
        ${s.phone ? `<div><strong>Phone</strong><br><a href="tel:${_esc(s.phone)}">${_esc(s.phone)}</a></div>` : ''}
        ${s.address ? `<div><strong>Address</strong><br>${_esc(s.address)}</div>` : ''}
      </div>
    </div></section>`;
  }
  if (t === 'footer') {
    return `<footer class="lp-footer"><div class="lp-container">
      <div>${_esc(s.text || '© ' + new Date().getFullYear() + ' All rights reserved.')}</div>
    </div></footer>`;
  }
  return '';
}

async function expressRenderPage(req, res) {
  try {
    await _ensureSchema();
    const slug = String(req.params.pageSlug || '').trim();
    const page = (await db.query(`SELECT * FROM landing_pages WHERE slug = $1`, [slug])).rows[0];
    if (!page) return res.status(404).send('<h1>Page not found</h1>');
    if (!Number(page.is_active)) return res.status(410).send('<h1>This page is no longer available</h1>');

    try { await db.query(`UPDATE landing_pages SET view_count = view_count + 1 WHERE id = $1`, [page.id]); } catch (_) {}

    let sections;
    try { sections = Array.isArray(page.sections) ? page.sections : JSON.parse(page.sections || '[]'); } catch (_) { sections = []; }
    const ctx = { tenantSlug: req.tenantSlug || (req.tenant && req.tenant.slug) || '', pageSlug: slug };
    const body = sections.map(s => _renderSection(s, ctx)).join('\n');
    const themeColor = page.theme_color || '#4f46e5';
    const themeBg    = page.theme_bg || '#ffffff';

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${_esc(page.seo_title || page.name)}</title>
${page.seo_description ? `<meta name="description" content="${_esc(page.seo_description)}">` : ''}
${page.og_image ? `<meta property="og:image" content="${_esc(page.og_image)}">` : ''}
<meta property="og:title" content="${_esc(page.seo_title || page.name)}">
${page.favicon_url ? `<link rel="icon" href="${_esc(page.favicon_url)}">` : ''}
<style>
:root { --primary: ${_esc(themeColor)}; --bg: ${_esc(themeBg)}; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: #1e293b; line-height: 1.6; }
.lp-container { max-width: 1100px; margin: 0 auto; padding: 0 1.25rem; }
section { padding: 4rem 0; }
.lp-eyebrow { color: var(--primary); font-weight: 600; font-size: .85rem; letter-spacing: .05em; text-transform: uppercase; margin-bottom: .5rem; }
.lp-hero { padding: 5rem 0; text-align: center; background: linear-gradient(135deg, ${_esc(themeColor)}11, ${_esc(themeColor)}05); }
.lp-hero h1 { font-size: clamp(2rem, 4.5vw, 3.5rem); margin: 0 0 1rem; color: #0f172a; line-height: 1.15; }
.lp-sub { font-size: 1.15rem; color: #475569; max-width: 700px; margin: 0 auto 2rem; }
.lp-hero-img { max-width: 100%; border-radius: 12px; box-shadow: 0 10px 40px rgba(15,23,42,0.12); margin-top: 2rem; }
.lp-btn { display: inline-block; background: var(--primary); color: #fff; padding: .8rem 2rem; border-radius: 8px; font-weight: 600; text-decoration: none; transition: opacity .15s, transform .15s; }
.lp-btn:hover { opacity: .92; transform: translateY(-1px); }
.lp-btn-lg { padding: 1rem 2.5rem; font-size: 1.1rem; }
.lp-features h2, .lp-text h2, .lp-testimonials h2, .lp-faq h2, .lp-cta h2, .lp-pricing h2, .lp-contact h2, .lp-form h2 { text-align: center; font-size: 2rem; margin: 0 0 2.5rem; color: #0f172a; }
.lp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.5rem; }
.lp-card { background: #fff; padding: 1.5rem; border-radius: 12px; box-shadow: 0 2px 8px rgba(15,23,42,0.06); border: 1px solid #f1f5f9; }
.lp-card h3 { margin: .5rem 0 .5rem; color: #0f172a; }
.lp-icon { font-size: 2rem; margin-bottom: .5rem; }
.lp-text .lp-body p { font-size: 1.05rem; color: #334155; max-width: 720px; margin: 0 auto 1rem; }
.lp-image img { max-width: 100%; border-radius: 12px; display: block; margin: 0 auto; }
.lp-caption { text-align: center; color: #64748b; font-size: .9rem; margin-top: .75rem; }
.lp-form-frame { width: 100%; min-height: 600px; border-radius: 12px; background: #fff; box-shadow: 0 4px 20px rgba(15,23,42,0.08); }
.lp-quote { background: #fff; padding: 1.5rem; border-radius: 12px; border-left: 4px solid var(--primary); }
.lp-quote blockquote { margin: 0 0 1rem; font-size: 1.05rem; color: #334155; font-style: italic; }
.lp-quote cite { color: #64748b; font-style: normal; font-weight: 600; font-size: .9rem; }
.lp-faq-item { background: #fff; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: .75rem; border: 1px solid #e2e8f0; }
.lp-faq-item summary { font-weight: 600; cursor: pointer; color: #0f172a; }
.lp-faq-item[open] summary { color: var(--primary); margin-bottom: .5rem; }
.lp-faq-item div { color: #475569; font-size: .95rem; padding-top: .25rem; }
.lp-cta { background: var(--primary); color: #fff; text-align: center; }
.lp-cta h2 { color: #fff; margin-bottom: .75rem; }
.lp-cta p { font-size: 1.1rem; opacity: .92; margin-bottom: 2rem; }
.lp-cta .lp-btn { background: #fff; color: var(--primary); }
.lp-plan { background: #fff; padding: 2rem 1.5rem; border-radius: 12px; text-align: center; border: 1px solid #e2e8f0; }
.lp-plan.featured { border: 2px solid var(--primary); transform: scale(1.04); box-shadow: 0 10px 30px rgba(15,23,42,0.10); }
.lp-price { font-size: 2.25rem; font-weight: 700; color: var(--primary); margin: 1rem 0; }
.lp-plan ul { list-style: none; padding: 0; margin: 1rem 0 1.5rem; }
.lp-plan li { padding: .35rem 0; color: #475569; }
.lp-contact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 2rem; text-align: center; }
.lp-contact-grid a { color: var(--primary); text-decoration: none; }
.lp-footer { background: #0f172a; color: #cbd5e1; padding: 2rem 0; text-align: center; font-size: .9rem; }
${page.custom_css || ''}
</style>
</head>
<body>
${body}
</body>
</html>`;
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    console.error('[/p] render error:', e);
    res.status(500).send('<h1>Page error</h1><pre>' + _esc(e.message) + '</pre>');
  }
}


async function api_pages_templates(token) {
  await authUser(token);
  const { TEMPLATES } = require('../utils/pageTemplates');
  return TEMPLATES.map(t => ({
    id: t.id, name: t.name, industry: t.industry,
    description: t.description, theme_color: t.theme_color,
    section_count: (t.sections || []).length
  }));
}

async function api_pages_createFromTemplate(token, payload) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  const p = payload || {};
  const { TEMPLATES } = require('../utils/pageTemplates');
  const tpl = TEMPLATES.find(t => t.id === String(p.template_id || ''));
  if (!tpl) throw new Error('Template not found');
  return api_pages_save(token, {
    name: p.name || tpl.name,
    description: tpl.description,
    is_active: 0,
    theme_color: tpl.theme_color || '#4f46e5',
    theme_bg: '#ffffff',
    sections: tpl.sections || []
  });
}

module.exports = {
  api_pages_list, api_pages_get, api_pages_save, api_pages_delete, api_pages_clone,
  api_pages_templates, api_pages_createFromTemplate,
  expressRenderPage, _ensureSchema
};
