/**
 * routes/waWidget.js — Embeddable WhatsApp Chat Widget
 *
 * Lets each tenant generate a copy-paste snippet that drops a floating
 * "Chat on WhatsApp" button onto any external website.
 *
 *   <script src="https://app.smartcrm.com/t/<tenant>/widget/wa.js?w=<slug>" async></script>
 *
 * Schema (1 table, idempotent):
 *   wa_widgets — name, slug, phone, prefilled_message, theme_color, position,
 *                greeting_text, agent_name, agent_avatar_url,
 *                track_clicks (creates a "Website Widget" lead on click), is_active
 *
 * Public URLs (under each tenant's subdomain):
 *   GET  /t/<tenant>/widget/wa.js?w=<slug>    — the JS injector
 *   POST /t/<tenant>/widget/click             — optional click-to-lead capture
 */
'use strict';

const db = require('../db/pg');
const { authUser } = require('../utils/auth');

const POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];

// ──────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────
async function _ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS wa_widgets (
    id SERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    phone TEXT NOT NULL DEFAULT '',
    prefilled_message TEXT NOT NULL DEFAULT 'Hi, I would like to know more.',
    theme_color TEXT NOT NULL DEFAULT '#25D366',
    position TEXT NOT NULL DEFAULT 'bottom-right',
    greeting_text TEXT NOT NULL DEFAULT 'Hi there! How can we help?',
    greeting_delay_ms INTEGER NOT NULL DEFAULT 2500,
    agent_name TEXT NOT NULL DEFAULT 'Customer Care',
    agent_subtitle TEXT NOT NULL DEFAULT 'Typically replies within minutes',
    agent_avatar_url TEXT NOT NULL DEFAULT '',
    show_avatar INTEGER NOT NULL DEFAULT 1,
    business_hours_json TEXT NOT NULL DEFAULT '',
    track_clicks INTEGER NOT NULL DEFAULT 0,
    lead_default_source TEXT NOT NULL DEFAULT 'Website Widget',
    lead_default_status_id INTEGER,
    click_count INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  const cols = [
    ['greeting_delay_ms',   'INTEGER NOT NULL DEFAULT 2500'],
    ['agent_subtitle',      "TEXT NOT NULL DEFAULT 'Typically replies within minutes'"],
    ['show_avatar',         'INTEGER NOT NULL DEFAULT 1'],
    ['business_hours_json', "TEXT NOT NULL DEFAULT ''"],
    ['track_clicks',        'INTEGER NOT NULL DEFAULT 0'],
    ['lead_default_source', "TEXT NOT NULL DEFAULT 'Website Widget'"],
    ['lead_default_status_id', 'INTEGER'],
    ['click_count',         'INTEGER NOT NULL DEFAULT 0'],
    ['view_count',          'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [c, t] of cols) {
    try { await db.query(`ALTER TABLE wa_widgets ADD COLUMN IF NOT EXISTS ${c} ${t}`); } catch (_) {}
  }
}

function _slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || ('w-' + Date.now().toString(36));
}
function _digitsOnly(s) { return String(s || '').replace(/\D+/g, ''); }
function _jsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n').replace(/<\/script/gi, '<\\/script');
}

// ──────────────────────────────────────────────────────────────────
// CRUD APIs (tenant-side, called from SPA)
// ──────────────────────────────────────────────────────────────────
async function api_waWidget_list(token) {
  await authUser(token);
  await _ensureSchema();
  const r = await db.query(`
    SELECT id, slug, name, is_active, phone, prefilled_message, theme_color, position,
           greeting_text, agent_name, agent_subtitle, agent_avatar_url, show_avatar,
           track_clicks, lead_default_source, lead_default_status_id,
           click_count, view_count, created_at, updated_at
    FROM wa_widgets ORDER BY id DESC`);
  return { ok: true, widgets: r.rows };
}

async function api_waWidget_get(token, id) {
  await authUser(token);
  await _ensureSchema();
  id = Number(id || 0);
  const r = await db.query(`SELECT * FROM wa_widgets WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new Error('Widget not found');
  return { ok: true, widget: r.rows[0] };
}

async function api_waWidget_save(token, payload) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  const p = payload || {};
  const id = Number(p.id || 0);

  const base = {
    name:              String(p.name || '').trim() || 'WhatsApp Widget',
    slug:              _slugify(p.slug || p.name || 'widget'),
    is_active:         p.is_active === 0 || p.is_active === false ? 0 : 1,
    phone:             _digitsOnly(p.phone),
    prefilled_message: String(p.prefilled_message || '').slice(0, 600),
    theme_color:       String(p.theme_color || '#25D366').slice(0, 20),
    position:          POSITIONS.indexOf(p.position) >= 0 ? p.position : 'bottom-right',
    greeting_text:     String(p.greeting_text || '').slice(0, 400),
    greeting_delay_ms: Math.max(0, Math.min(60000, Number(p.greeting_delay_ms) || 2500)),
    agent_name:        String(p.agent_name || '').slice(0, 80),
    agent_subtitle:    String(p.agent_subtitle || '').slice(0, 120),
    agent_avatar_url:  String(p.agent_avatar_url || '').slice(0, 500),
    show_avatar:       p.show_avatar === 0 || p.show_avatar === false ? 0 : 1,
    business_hours_json: typeof p.business_hours_json === 'string' ? p.business_hours_json : JSON.stringify(p.business_hours_json || ''),
    track_clicks:      p.track_clicks ? 1 : 0,
    lead_default_source: String(p.lead_default_source || 'Website Widget').slice(0, 80),
    lead_default_status_id: p.lead_default_status_id ? Number(p.lead_default_status_id) : null,
  };

  if (!base.phone) throw new Error('WhatsApp phone number is required');

  let widgetId = id;
  if (!widgetId) {
    let s = base.slug, i = 2;
    while ((await db.query(`SELECT 1 FROM wa_widgets WHERE slug = $1`, [s])).rows[0]) {
      s = base.slug + '-' + i++; if (i > 99) { s = base.slug + '-' + Date.now().toString(36); break; }
    }
    base.slug = s;
    const ins = await db.query(`
      INSERT INTO wa_widgets
        (slug, name, is_active, phone, prefilled_message, theme_color, position,
         greeting_text, greeting_delay_ms, agent_name, agent_subtitle, agent_avatar_url, show_avatar,
         business_hours_json, track_clicks, lead_default_source, lead_default_status_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id, slug`,
      [base.slug, base.name, base.is_active, base.phone, base.prefilled_message, base.theme_color, base.position,
       base.greeting_text, base.greeting_delay_ms, base.agent_name, base.agent_subtitle, base.agent_avatar_url, base.show_avatar,
       base.business_hours_json, base.track_clicks, base.lead_default_source, base.lead_default_status_id]);
    widgetId = ins.rows[0].id;
  } else {
    await db.query(`
      UPDATE wa_widgets SET
        slug=$2, name=$3, is_active=$4, phone=$5, prefilled_message=$6, theme_color=$7, position=$8,
        greeting_text=$9, greeting_delay_ms=$10, agent_name=$11, agent_subtitle=$12, agent_avatar_url=$13, show_avatar=$14,
        business_hours_json=$15, track_clicks=$16, lead_default_source=$17, lead_default_status_id=$18, updated_at=NOW()
      WHERE id = $1`,
      [widgetId, base.slug, base.name, base.is_active, base.phone, base.prefilled_message, base.theme_color, base.position,
       base.greeting_text, base.greeting_delay_ms, base.agent_name, base.agent_subtitle, base.agent_avatar_url, base.show_avatar,
       base.business_hours_json, base.track_clicks, base.lead_default_source, base.lead_default_status_id]);
  }
  const out = (await db.query(`SELECT * FROM wa_widgets WHERE id = $1`, [widgetId])).rows[0];
  return { ok: true, widget: out };
}

async function api_waWidget_delete(token, id) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  id = Number(id || 0);
  await db.query(`DELETE FROM wa_widgets WHERE id = $1`, [id]);
  return { ok: true };
}

async function api_waWidget_clone(token, id) {
  const me = await authUser(token);
  if (!['admin','manager'].includes(me.role)) throw new Error('Admin/manager only');
  await _ensureSchema();
  id = Number(id || 0);
  const src = (await db.query(`SELECT * FROM wa_widgets WHERE id = $1`, [id])).rows[0];
  if (!src) throw new Error('Widget not found');
  const copy = Object.assign({}, src, { id: 0, name: src.name + ' (copy)', slug: src.slug + '-copy' });
  return api_waWidget_save(token, copy);
}

function _buildSnippet(baseUrl, tenantSlug, slug) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  const tpath = tenantSlug ? '/t/' + tenantSlug : '';
  const src = `${base}${tpath}/widget/wa.js?w=${encodeURIComponent(slug)}`;
  return `<!-- SmartCRM WhatsApp Chat Widget -->\n<script src="${src}" async></script>`;
}

async function api_waWidget_snippet(token, payload) {
  await authUser(token);
  await _ensureSchema();
  const p = payload || {};
  const id = Number(p.id || 0);
  const r = await db.query(`SELECT slug, name FROM wa_widgets WHERE id = $1`, [id]);
  if (!r.rows[0]) throw new Error('Widget not found');
  const baseUrl = String(p.base_url || process.env.PUBLIC_BASE_URL || '').trim();
  const tenant  = String(p.tenant_slug || '').trim();
  return { ok: true, snippet: _buildSnippet(baseUrl, tenant, r.rows[0].slug), widget: r.rows[0] };
}

// ──────────────────────────────────────────────────────────────────
// Public renderer: GET /t/<tenant>/widget/wa.js?w=<slug>
// ──────────────────────────────────────────────────────────────────
async function expressRenderWidgetJs(req, res) {
  try {
    await _ensureSchema();
    const slug = String((req.query && req.query.w) || '').trim();
    if (!slug) return res.status(400).type('application/javascript').send('/* SmartCRM widget: missing ?w=<slug> */');

    const w = (await db.query(`SELECT * FROM wa_widgets WHERE slug = $1`, [slug])).rows[0];
    if (!w || !Number(w.is_active)) {
      return res.status(200).type('application/javascript').send('/* SmartCRM widget: not found or disabled */');
    }

    try { await db.query(`UPDATE wa_widgets SET view_count = view_count + 1 WHERE id = $1`, [w.id]); } catch (_) {}

    const tenantSlug = req.tenantSlug || (req.tenant && req.tenant.slug) || '';
    const trackUrl = (tenantSlug ? '/t/' + tenantSlug : '') + '/widget/click';

    const js = `/* SmartCRM WhatsApp Chat Widget — slug=${_jsEsc(w.slug)} */
(function(){
  if (window.__smartcrmWaWidget && window.__smartcrmWaWidget['${_jsEsc(w.slug)}']) return;
  window.__smartcrmWaWidget = window.__smartcrmWaWidget || {};
  window.__smartcrmWaWidget['${_jsEsc(w.slug)}'] = true;

  var CFG = {
    slug:    '${_jsEsc(w.slug)}',
    phone:   '${_jsEsc(w.phone)}',
    msg:     '${_jsEsc(w.prefilled_message)}',
    color:   '${_jsEsc(w.theme_color || '#25D366')}',
    pos:     '${_jsEsc(w.position || 'bottom-right')}',
    greet:   '${_jsEsc(w.greeting_text || '')}',
    delay:   ${Number(w.greeting_delay_ms) || 2500},
    agent:   '${_jsEsc(w.agent_name || '')}',
    subt:    '${_jsEsc(w.agent_subtitle || '')}',
    avatar:  '${_jsEsc(w.agent_avatar_url || '')}',
    showAv:  ${Number(w.show_avatar) ? 'true' : 'false'},
    track:   ${Number(w.track_clicks) ? 'true' : 'false'},
    trackUrl:'${_jsEsc(trackUrl)}'
  };

  function el(tag, attrs, kids){
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs){ if (k === 'style') n.style.cssText = attrs[k]; else if (k === 'html') n.innerHTML = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids||[]).forEach(function(c){ if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function posCss(){
    var p = CFG.pos || 'bottom-right';
    var s = 'position:fixed;z-index:2147483600;';
    if (p.indexOf('bottom') === 0) s += 'bottom:20px;'; else s += 'top:20px;';
    if (p.indexOf('right') > 0)    s += 'right:20px;';  else s += 'left:20px;';
    return s;
  }
  function panelPos(){
    var p = CFG.pos || 'bottom-right';
    var s = 'position:fixed;z-index:2147483601;';
    if (p.indexOf('bottom') === 0) s += 'bottom:92px;'; else s += 'top:92px;';
    if (p.indexOf('right') > 0)    s += 'right:20px;';  else s += 'left:20px;';
    return s;
  }
  function track(action){
    if (!CFG.track) return;
    try {
      var url = CFG.trackUrl + '?w=' + encodeURIComponent(CFG.slug) + '&a=' + encodeURIComponent(action||'click') + '&href=' + encodeURIComponent(location.href);
      if (navigator.sendBeacon) navigator.sendBeacon(url);
      else fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true });
    } catch(_){}
  }
  function openWa(){
    track('click');
    var ph = (CFG.phone || '').replace(/[^0-9]/g,'');
    var u  = 'https://wa.me/' + ph + (CFG.msg ? ('?text=' + encodeURIComponent(CFG.msg)) : '');
    window.open(u, '_blank', 'noopener,noreferrer');
  }
  var WA_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" fill="#fff" aria-hidden="true"><path d="M20.52 3.48A11.94 11.94 0 0012 0C5.37 0 0 5.37 0 12c0 2.11.55 4.17 1.6 6L0 24l6.16-1.6A11.94 11.94 0 0012 24c6.63 0 12-5.37 12-12 0-3.19-1.24-6.18-3.48-8.52zM12 21.82c-1.83 0-3.61-.49-5.17-1.4l-.37-.22-3.66.95.98-3.57-.24-.37A9.78 9.78 0 012.18 12C2.18 6.59 6.59 2.18 12 2.18c2.62 0 5.09 1.02 6.95 2.88a9.74 9.74 0 012.87 6.94c0 5.41-4.41 9.82-9.82 9.82zm5.4-7.36c-.3-.15-1.77-.87-2.05-.97-.28-.1-.48-.15-.68.15-.2.3-.78.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.47-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.68-1.63-.93-2.23-.24-.59-.49-.51-.68-.52-.17-.01-.37-.01-.57-.01-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.06 2.87 1.21 3.07.15.2 2.09 3.19 5.07 4.47.71.31 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/></svg>';
  var CLOSE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff"><path d="M18.3 5.71 12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3z"/></svg>';
  function build(){
    if (document.getElementById('smartcrm-wa-fab')) return;
    var fab = el('button', { id:'smartcrm-wa-fab', 'aria-label':'Chat on WhatsApp',
      style: posCss() + 'background:' + CFG.color + ';color:#fff;border:none;border-radius:50%;width:60px;height:60px;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .15s;'
    });
    fab.innerHTML = WA_ICON;
    fab.onmouseover = function(){ fab.style.transform='scale(1.06)'; };
    fab.onmouseout  = function(){ fab.style.transform='scale(1)'; };
    var panel = el('div', { id:'smartcrm-wa-panel',
      style: panelPos() + 'width:320px;max-width:calc(100vw - 40px);background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.18);overflow:hidden;display:none;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;'
    });
    var hdr = el('div', { style:'background:' + CFG.color + ';color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px;' });
    if (CFG.showAv) {
      var av;
      if (CFG.avatar) {
        av = el('img', { src: CFG.avatar, style:'width:42px;height:42px;border-radius:50%;border:2px solid rgba(255,255,255,.6);object-fit:cover;' });
      } else {
        av = el('div', { style:'width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:18px;color:#fff;' });
        av.textContent = (CFG.agent||'?').slice(0,1).toUpperCase();
      }
      hdr.appendChild(av);
    }
    var hd = el('div', { style:'flex:1;line-height:1.25;' });
    hd.appendChild(el('div', { style:'font-weight:600;font-size:15px;' }, [CFG.agent || 'Customer Care']));
    if (CFG.subt) hd.appendChild(el('div', { style:'font-size:12px;opacity:.9;' }, [CFG.subt]));
    hdr.appendChild(hd);
    var cl = el('button', { 'aria-label':'Close', style:'background:transparent;border:none;cursor:pointer;padding:4px;display:flex;align-items:center;' });
    cl.innerHTML = CLOSE_ICON;
    cl.onclick = function(){ panel.style.display='none'; };
    hdr.appendChild(cl);
    panel.appendChild(hdr);
    var body = el('div', { style:'padding:18px 16px;background:#ECE5DD;min-height:90px;' });
    var bubble = el('div', { style:'background:#fff;color:#1f2937;padding:10px 12px;border-radius:8px;font-size:14px;line-height:1.45;max-width:88%;box-shadow:0 1px 1px rgba(0,0,0,.06);position:relative;' });
    bubble.textContent = CFG.greet || 'Hi! How can we help?';
    body.appendChild(bubble);
    panel.appendChild(body);
    var foot = el('div', { style:'padding:12px 16px;background:#fff;border-top:1px solid #eee;' });
    var go = el('button', { style:'width:100%;background:' + CFG.color + ';color:#fff;border:none;border-radius:24px;padding:11px 14px;font-size:14px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;' });
    go.innerHTML = WA_ICON.replace('width="28" height="28"','width="18" height="18"') + '<span>Start chat on WhatsApp</span>';
    go.onclick = openWa;
    foot.appendChild(go);
    panel.appendChild(foot);
    var brand = el('div', { style:'padding:6px 0 8px;text-align:center;font-size:10.5px;color:#94a3b8;background:#fff;' }, ['Powered by SmartCRM']);
    panel.appendChild(brand);
    fab.onclick = function(){
      if (panel.style.display === 'block') { panel.style.display='none'; return; }
      panel.style.display='block'; track('open');
    };
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    if (CFG.greet && CFG.delay >= 0) {
      setTimeout(function(){
        if (panel.dataset.opened === '1') return;
        if (window.sessionStorage && sessionStorage.getItem('__smartcrm_wa_' + CFG.slug + '_shown') === '1') return;
        panel.style.display='block';
        panel.dataset.opened = '1';
        try { sessionStorage.setItem('__smartcrm_wa_' + CFG.slug + '_shown', '1'); } catch(_){}
        track('greet');
      }, Math.max(0, CFG.delay));
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();`;

    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.type('application/javascript').send(js);
  } catch (e) {
    console.error('[/widget/wa.js]', e);
    res.status(500).type('application/javascript').send('/* SmartCRM widget error */');
  }
}

// Optional click tracker — POST /t/<tenant>/widget/click
async function expressTrackClick(req, res) {
  try {
    await _ensureSchema();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    const slug = String((req.query && req.query.w) || (req.body && req.body.w) || '').trim();
    const action = String((req.query && req.query.a) || 'click').trim();
    const href = String((req.query && req.query.href) || '').slice(0, 500);
    if (!slug) return res.status(204).end();
    const w = (await db.query(`SELECT * FROM wa_widgets WHERE slug = $1`, [slug])).rows[0];
    if (!w) return res.status(204).end();
    if (action === 'click') {
      try { await db.query(`UPDATE wa_widgets SET click_count = click_count + 1 WHERE id = $1`, [w.id]); } catch (_) {}
      if (Number(w.track_clicks)) {
        try {
          const ins = await db.query(`
            INSERT INTO leads (name, phone, source, source_ref, status_id, extra_json, created_at)
            VALUES ($1,$2,$3,$4,$5,$6, NOW()) RETURNING id`,
            ['Website Widget Visitor', '', w.lead_default_source || 'Website Widget',
             href || ('widget:' + slug), w.lead_default_status_id || null,
             JSON.stringify({ widget_slug: slug, widget_id: w.id, source_url: href })]);
          const leadId = ins.rows[0] && ins.rows[0].id;
          if (leadId) {
            try { require('../utils/automations').fire('lead_created', { lead: { id: leadId, source: w.lead_default_source }, user: null }); } catch (_) {}
            try { require('./nurture')._tryAutoEnroll('lead_created', { lead: { id: leadId, source: w.lead_default_source }, user: null }); } catch (_) {}
          }
        } catch (_) { /* best-effort */ }
      }
    }
    res.status(204).end();
  } catch (e) {
    console.error('[/widget/click]', e);
    res.status(204).end();
  }
}

module.exports = {
  api_waWidget_list, api_waWidget_get, api_waWidget_save, api_waWidget_delete,
  api_waWidget_clone, api_waWidget_snippet,
  expressRenderWidgetJs, expressTrackClick, _ensureSchema
};
