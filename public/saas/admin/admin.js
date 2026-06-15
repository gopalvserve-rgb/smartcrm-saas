/**
 * Super-admin SPA — single-file vanilla JS, like the tenant CRM.
 *
 * Views: dashboard, packages, tenants, invoices, custom-requirements,
 *        announcements, super-admins, settings. Hash-routed: #/tenants etc.
 */
const APP = { token: localStorage.getItem('saas_admin_token') || '', user: null };

const h = (tag, attrs, ...kids) => {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  // Children can be: Node, string, number, null/false (skipped), or arrays.
  // Coerce primitives to text nodes so callers don't have to String()
  // every count/amount they pass in (the previous version threw
  // "parameter 1 is not of type Node" on numeric children).
  kids.flat(Infinity).forEach(k => {
    if (k == null || k === false) return;
    if (k instanceof Node) { el.appendChild(k); return; }
    el.appendChild(document.createTextNode(String(k)));
  });
  return el;
};
const $ = sel => document.querySelector(sel);

/**
 * Best-effort client-error reporter — same shape as the landing page
 * version, so admin-side bugs (e.g. a broken view handler) also land
 * in the platform Errors page. Throttled at 1 request / second so a
 * runaway loop can't DOS our own /log-error endpoint.
 */
let _lastErrLogAt = 0;
async function logClientError(payload) {
  const now = Date.now();
  if (now - _lastErrLogAt < 1000) return;
  _lastErrLogAt = now;
  try {
    await fetch('/api/saas/log-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(Object.assign({
        url: location.href,
        ua: navigator.userAgent,
        source: 'admin-spa',
        ts_iso: new Date().toISOString()
      }, payload || {}))
    });
  } catch (_) {}
}
window.addEventListener('error', ev => {
  try {
    logClientError({
      message: (ev.error && ev.error.message) || ev.message || 'window.error',
      stack:   (ev.error && ev.error.stack)   || null,
      file:    ev.filename || null,
      line:    ev.lineno   || null,
      col:     ev.colno    || null
    });
  } catch (_) {}
});
window.addEventListener('unhandledrejection', ev => {
  try {
    const reason = ev.reason || {};
    logClientError({
      message: (reason && reason.message) || String(reason) || 'unhandledrejection',
      stack:   (reason && reason.stack)   || null
    });
  } catch (_) {}
});

async function api(fn, args) {
  const r = await fetch('/api/saas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-auth-token': APP.token },
    body: JSON.stringify({ fn, args: args ? [args] : [] })
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'API error');
  return j.result;
}

function toast(msg, kind = 'ok') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function fmtRupees(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }
function fmtDate(s) { if (!s) return ''; const d = new Date(s); return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }

// ---------- Login ----------------------------------------------
function renderLogin() {
  const root = $('#app');
  root.innerHTML = '';
  root.style.display = 'block';
  const form = h('form', { class: 'login-box', onsubmit: async ev => {
    ev.preventDefault();
    const email = ev.target.email.value.trim();
    const password = ev.target.password.value;
    try {
      const r = await api('api_saas_admin_login', { email, password });
      APP.token = r.token; APP.user = r.user;
      localStorage.setItem('saas_admin_token', r.token);
      route();
    } catch (e) { toast(e.message, 'err'); }
  } },
    h('h2', {}, 'SmartCRM SaaS Admin'),
    h('div', { class: 'field' }, h('label', {}, 'Email'), h('input', { name: 'email', type: 'email', required: true, autofocus: true })),
    h('div', { class: 'field' }, h('label', {}, 'Password'), h('input', { name: 'password', type: 'password', required: true })),
    h('button', { class: 'btn', style: { width: '100%', marginTop: '.5rem' } }, 'Sign in')
  );
  root.appendChild(form);
}

// ---------- Shell ----------------------------------------------
const NAV = [
  { id: 'dashboard',     label: '🏠 Dashboard' },
  { id: 'tenants',       label: '🏢 Tenants' },
  { id: 'signup_requests', label: '🆕 Signup Requests' },   // TENANT_SIGNUP_APPROVAL_v1
  { id: 'packages',      label: '📦 Packages' },
  { id: 'invoices',      label: '🧾 Invoices' },
  { id: 'webhooks',      label: '📡 Webhook Logs' },
  { id: 'errors',        label: '🐞 Errors' },
  { id: 'crashes',       label: '🚨 Crashes' },
  { id: 'ai_costing',    label: '🤖 AI Costing' },
  { id: 'finance',       label: '💰 Finance' },   /* FIN_DASH_v1 */
  { id: 'wl_billing',    label: '🏷️ White-Label Billing' },   /* WL_BILLING_v1 */
  { id: 'announcements', label: '📣 Updates' },
  { id: 'requirements',  label: '🛠 Custom Requirements' },
  { id: 'tickets',       label: '🎫 Support Tickets' },   // TKT_ADMIN_v1
  { id: 'admins',        label: '👥 Super Assistants' },
  { id: 'device_health', label: '📱 Device Health' },  /* DEVICE_DIAG_v1 */
  { id: 'settings',      label: '⚙️ Settings' }
];

function renderShell() {
  const root = $('#app');
  root.innerHTML = '';
  root.style.display = 'block';
  root.appendChild(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, '🎯 SmartCRM'),
      h('nav', { id: 'nav' }, ...NAV.map(n => h('a', { 'data-view': n.id, onclick: () => navigate(n.id) }, n.label))),
      h('div', { class: 'footer' }, APP.user ? APP.user.name + ' · ' + APP.user.role : '', h('br'), h('a', { onclick: logout, style: { cursor: 'pointer', color: '#94a3b8' } }, 'Logout'))
    ),
    h('main', { class: 'main', id: 'view' })
  ));
}

function navigate(id) { location.hash = '#/' + id; }
function logout() { localStorage.removeItem('saas_admin_token'); APP.token = ''; APP.user = null; location.reload(); }

// ---------- Views ----------------------------------------------
const VIEWS = {};

VIEWS.dashboard = async (view) => {
  view.appendChild(h('h1', {}, 'Dashboard'));
  let stats;
  try {
    const [pkgs, tenants, invoices] = await Promise.all([
      api('api_saas_packages_list'),
      api('api_saas_tenants_list', {}),
      api('api_saas_invoices_list', {})
    ]);
    const activeT = tenants.filter(t => t.status === 'active' || t.status === 'trial').length;
    const paidInvCount = invoices.filter(i => i.status === 'paid').length;
    const mrr = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total_inr || 0), 0);
    stats = { pkgs: pkgs.length, tenants: tenants.length, activeT, paidInvCount, mrr };
  } catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }

  const card = (label, value, sub) => h('div', { class: 'card', style: { flex: 1, minWidth: '200px' } },
    h('div', { class: 'muted', style: { fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
    h('div', { style: { fontSize: '1.8rem', fontWeight: '700', margin: '.4rem 0 .2rem' } }, value),
    sub ? h('div', { class: 'muted', style: { fontSize: '.85rem' } }, sub) : null
  );
  view.appendChild(h('div', { style: { display: 'flex', gap: '1rem', flexWrap: 'wrap' } },
    card('Active tenants', stats.activeT, stats.tenants + ' total'),
    card('Packages', stats.pkgs, 'in catalogue'),
    card('Paid invoices', stats.paidInvCount, 'all-time'),
    card('Revenue', fmtRupees(stats.mrr), 'all-time paid')
  ));
};

VIEWS.packages = async (view) => {
  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Packages'),
    h('button', { class: 'btn', onclick: () => editPackage({}) }, '+ New package')
  ));
  let list;
  try { list = await api('api_saas_packages_list'); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) { view.appendChild(h('div', { class: 'empty' }, 'No packages yet — click "New package" to add one.')); return; }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Price'), h('th', {}, 'Period'),
      h('th', {}, 'Modules'), h('th', {}, 'Public?'), h('th', {}, '')
    )),
    h('tbody', {}, ...list.map(p => h('tr', {},
      h('td', {}, h('b', {}, p.name), p.is_most_popular ? h('span', { class: 'tag warn', style: { marginLeft: '.5rem' } }, 'Popular') : null),
      h('td', {}, fmtRupees(p.base_price_inr) + ' + ' + p.tax_percent + '% tax'),
      h('td', {}, 'Every ' + (p.recurring_period_count || 1) + ' ' + p.recurring_period),
      h('td', { class: 'muted', style: { maxWidth: '300px', fontSize: '.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.modules || ''),
      h('td', {}, p.is_enabled === 1 ? (p.is_private ? h('span', { class: 'tag info' }, 'Private') : h('span', { class: 'tag ok' }, 'Public')) : h('span', { class: 'tag' }, 'Disabled')),
      h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn ghost sm', onclick: () => editPackage(p) }, 'Edit'))
    )))
  );
  // FB_REGISTRY_BACKFILL_v1 — one-click sync all tenant FB pages into central registry
  const fbBackfillBar = h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.6rem', padding: '.5rem .7rem', background: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }},
    h('span', { style: { fontSize: '.85rem' }}, '\ud83d\udce1 FB Lead Ads central registry:'),
    h('span', { class: 'muted', style: { fontSize: '.78rem', flex: 1 }},
      'Push every tenant\'s connected Facebook pages into fb_leads_connections.json on smartcrmsolution.com so the central webhook routes leads correctly. Safe to run anytime.'),
    h('button', { class: 'btn primary', style: { whiteSpace: 'nowrap' }, onclick: async (ev) => {
      const btn = ev.target;
      btn.disabled = true; btn.textContent = '\u23f3 Backfilling...';
      try {
        const out = await api('api_saas_fb_backfillRegistry', {});
        const s = out.summary || {};
        toast('\u2714 Backfill done: ' + (s.totalRegistered || 0) + ' pages registered across ' + (s.tenants_scanned || 0) + ' tenants');
        // Show results in a quick modal
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        m.onclick = (e) => { if (e.target === m) m.remove(); };
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:12px;max-width:720px;width:92%;max-height:80vh;overflow:auto;padding:1.2rem 1.4rem;';
        card.innerHTML = '<h3 style="margin:0 0 .4rem">\u{1f4e1} FB Registry backfill results</h3>' +
                        '<p class="muted" style="font-size:.85rem;margin-bottom:.6rem">Pages registered: <b>' + (s.totalRegistered || 0) + '</b> &middot; tenants scanned: <b>' + (s.tenants_scanned || 0) + '</b> &middot; errors: <b>' + (s.totalErrors || 0) + '</b></p>' +
                        '<pre style="background:#0f172a;color:#e2e8f0;padding:.7rem;border-radius:6px;font-size:.74rem;max-height:55vh;overflow:auto;white-space:pre-wrap">' + JSON.stringify(out.results, null, 2) + '</pre>' +
                        '<div style="text-align:right;margin-top:.7rem"><button id="re-close" style="padding:.45rem .8rem;border-radius:8px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-weight:600">Close</button></div>';
        m.appendChild(card);
        document.body.appendChild(m);
        card.querySelector('#re-close').onclick = () => m.remove();
      } catch(e) { toast('Backfill failed: ' + e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '\ud83d\udd04 Backfill FB Registry'; }
    }}, '\ud83d\udd04 Backfill FB Registry')
  );
  view.appendChild(fbBackfillBar);
    view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

function editPackage(p) {
  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal' });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, p.id ? 'Edit package' : 'New package'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  // Helper: read a packages.quotas object (or {}), pull the friendly
  // limit-only fields out for the form, then merge them back on save.
  // Keeps any future / extra metric the admin set via JSON elsewhere
  // intact.
  const _existingQuotas = (() => {
    let q = p.quotas;
    if (typeof q === 'string') { try { q = JSON.parse(q); } catch (_) { q = {}; } }
    return q || {};
  })();
  function _quotaInitial(metric) {
    const m = _existingQuotas[metric];
    if (!m) return '';                                   // unset → empty (treated as unlimited)
    if (Number(m.limit) === -1) return '';               // explicit unlimited
    return String(m.limit != null ? m.limit : '');
  }
  function _buildQuotasFromForm(fd) {
    // Default periods: users one_time (a seat), leads + WA per_month.
    const out = Object.assign({}, _existingQuotas);
    const apply = (metric, period) => {
      const raw = String(fd.get('quota_' + metric) || '').trim();
      if (raw === '') {
        // Empty / unspecified → mark as unlimited (-1) so admins can
        // explicitly carve OUT a previously-limited package.
        out[metric] = { limit: -1, period };
      } else {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) out[metric] = { limit: n, period };
      }
    };
    apply('users',         'one_time');
    apply('leads',         'per_month');
    apply('whatsapp_send', 'per_month');
    return out;
  }

  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd);
    if (p.id) payload.id = p.id;
    payload.base_price_inr = Number(payload.base_price_inr);
    payload.tax_percent    = Number(payload.tax_percent);
    payload.recurring_period_count = Number(payload.recurring_period_count) || 1;
    payload.is_enabled       = fd.get('is_enabled') ? 1 : 0;
    payload.is_most_popular  = fd.get('is_most_popular') ? 1 : 0;
    payload.is_private       = fd.get('is_private') ? 1 : 0;
    payload.is_default       = fd.get('is_default') ? 1 : 0;
    // Build quotas object from the three friendly inputs. Drop the
    // raw quota_* form fields so they don't end up as columns on the
    // packages row.
    payload.quotas = _buildQuotasFromForm(fd);
    delete payload.quota_users;
    delete payload.quota_leads;
    delete payload.quota_whatsapp_send;
    try {
      await api('api_saas_packages_save', payload);
      toast('Saved'); m.remove(); navigate('packages');
    } catch (e) { toast(e.message, 'err'); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'Name *'), h('input', { name: 'name', required: true, value: p.name || '' })),
    h('div', { class: 'field' }, h('label', {}, 'Description (HTML)'),
      h('textarea', { name: 'description', rows: 3 }, p.description || '')),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Base price (INR) *'),
        h('input', { name: 'base_price_inr', type: 'number', step: '0.01', required: true, value: p.base_price_inr || 0 })),
      h('div', { class: 'field' }, h('label', {}, 'Tax %'),
        h('input', { name: 'tax_percent', type: 'number', step: '0.01', value: p.tax_percent != null ? p.tax_percent : 18 }))
    ),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Recurring period'),
        h('select', { name: 'recurring_period' },
          ...['month', 'quarter', 'year', 'lifetime'].map(v => h('option', { value: v, selected: p.recurring_period === v ? true : null }, v))
        )),
      h('div', { class: 'field' }, h('label', {}, 'Period count'),
        h('input', { name: 'recurring_period_count', type: 'number', min: '1', value: p.recurring_period_count || 1 }))
    ),
    h('div', { class: 'field' }, h('label', {}, 'Modules (CSV of module ids — leads,whatsbot,…)'),
      h('input', { name: 'modules', value: p.modules || '' })),
    h('div', { class: 'field' }, h('label', {}, 'Hidden tabs (CSV)'),
      h('input', { name: 'hidden_tabs', value: p.hidden_tabs || '' })),
    // ---- Plan limits / quotas ------------------------------------
    // Three friendly numeric inputs. Leave any blank to mean
    // "unlimited" (saved as limit=-1 internally). Internally these
    // map to packages.quotas JSONB which the tenant API dispatcher
    // checks before every relevant call (utils/quota.js).
    h('div', { class: 'field', style: { borderTop: '1px solid #e5e7eb', paddingTop: '1rem', marginTop: '.5rem' } },
      h('label', { style: { fontWeight: '600', fontSize: '.95rem' } }, '📊 Plan limits'),
      h('p', { class: 'muted', style: { fontSize: '.82rem', margin: '.25rem 0 .75rem' } },
        'Caps each tenant on this plan can\'t exceed. Leave blank for unlimited. Enforced live — calls that would push a tenant over the cap return HTTP 402 Plan limit reached.')
    ),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Total users'),
        h('input', { name: 'quota_users', type: 'number', min: '0', step: '1', placeholder: 'Unlimited', value: _quotaInitial('users') }),
        h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.2rem' } }, 'Active users in the workspace.')),
      h('div', { class: 'field' }, h('label', {}, 'Leads / month'),
        h('input', { name: 'quota_leads', type: 'number', min: '0', step: '1', placeholder: 'Unlimited', value: _quotaInitial('leads') }),
        h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.2rem' } }, 'New leads created in the current calendar month — counter resets on the 1st.')),
      h('div', { class: 'field' }, h('label', {}, 'WhatsApp sends / month'),
        h('input', { name: 'quota_whatsapp_send', type: 'number', min: '0', step: '1', placeholder: 'Unlimited', value: _quotaInitial('whatsapp_send') }),
        h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.2rem' } }, 'Outbound WhatsApp messages — chats + bulk campaigns combined. Resets monthly.'))
    ),
    h('div', { class: 'row' },
      h('label', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
        h('input', { type: 'checkbox', name: 'is_enabled', checked: p.is_enabled !== 0 ? true : null, style: { width: 'auto' } }),
        h('span', {}, 'Enabled')),
      h('label', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
        h('input', { type: 'checkbox', name: 'is_most_popular', checked: p.is_most_popular ? true : null, style: { width: 'auto' } }),
        h('span', {}, 'Most popular')),
      h('label', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
        h('input', { type: 'checkbox', name: 'is_private', checked: p.is_private ? true : null, style: { width: 'auto' } }),
        h('span', {}, 'Private')),
      h('label', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
        h('input', { type: 'checkbox', name: 'is_default', checked: p.is_default ? true : null, style: { width: 'auto' } }),
        h('span', {}, 'Default'))
    ),
    h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '1rem' } },
      h('button', { type: 'submit', class: 'btn' }, 'Save'),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => m.remove() }, 'Cancel')
    )
  );
  card.appendChild(form);
  m.appendChild(card);
  document.body.appendChild(m);
}

VIEWS.tenants = async (view) => {
  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Tenants'),
    h('button', { class: 'btn primary', onclick: () => openCreateTenant() }, '+ Create tenant'),
    // 🌟 One-click showcase demo: creates (or refreshes) a 'showcase'
    // tenant pre-loaded with leads, products, recordings (with fake AI),
    // quotations, etc. so we can hand prospects a working URL.
    h('button', {
      class: 'btn ghost', style: { marginLeft: '.5rem' },
      title: 'Create or refresh the showcase demo tenant with sample data',
      onclick: () => openShowcaseDemoModal()
    }, '🌟 Showcase demo'),
    h('button', {
      class: 'btn ghost', style: { marginLeft: '.5rem' },
      title: 'Re-apply db/schema.sql to every active tenant — fixes missing tables/columns added in later releases',
      onclick: async () => {
        if (!confirm('Re-apply schema.sql to ALL active tenants?\n\nThe schema is idempotent so this is safe — it just adds any missing tables / columns / indexes that newer releases added. Existing data is untouched.\n\nThis can take 30-90 seconds depending on tenant count.')) return;
        toast('Migrating tenants...');
        try {
          const r = await api('api_saas_apply_schema_to_all_tenants');
          const failedSlugs = (r.details || []).filter(d => !d.ok).map(d => d.slug + ' (' + (d.error || 'failed') + ')');
          if (r.failed === 0) {
            alert('✅ Migrated ' + r.ok + ' tenants successfully — no failures.');
          } else {
            alert('Migrated ' + r.ok + ' tenants. ' + r.failed + ' failed:\n\n' + failedSlugs.join('\n'));
          }
        } catch (e) { toast(e.message, 'err'); }
      }
    }, '🛠 Re-apply schema')
  ));
  let list;
  let dbVol = null;
  try {
    const [tl, vol] = await Promise.all([
      api('api_saas_tenants_list', {}),
      api('api_saas_dbVolume_summary').catch(() => null)
    ]);
    list = tl;
    dbVol = vol;
  } catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }

  // DB_VOLUME_v1 — top banner showing total disk usage + per-tenant lookup map
  let _sizeMap = new Map();
  if (dbVol && dbVol.tenants) {
    dbVol.tenants.forEach(t => _sizeMap.set(t.slug, t));
    const pct = dbVol.percent_full;
    const colour = pct >= 90 ? '#dc2626' : pct >= 75 ? '#f59e0b' : '#16a34a';
    const bg = pct >= 90 ? '#fee2e2' : pct >= 75 ? '#fef3c7' : '#ecfdf5';
    view.appendChild(h('div', {
      style: {
        background: bg, border: '1px solid ' + colour, borderRadius: '10px',
        padding: '12px 16px', marginBottom: '14px',
        display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap'
      }
    },
      h('span', { style: { fontSize: '1.3rem' }}, pct >= 90 ? '🚨' : pct >= 75 ? '⚠️' : '💾'),
      h('div', { style: { flex: '1' }},
        h('div', { style: { fontWeight: '700', color: colour }},
          'Postgres volume: ' + dbVol.used_pretty + ' / ' + dbVol.capacity_gb + ' GB used (' + pct.toFixed(1) + '%)'
        ),
        h('div', { style: { fontSize: '.78rem', color: '#475569', marginTop: '2px' }},
          dbVol.db_count + ' databases · Free: ' + dbVol.free_pretty + ' · Control: ' + dbVol.control_pretty +
          (dbVol.other_bytes > 0 ? ' · Other: ' + dbVol.other_pretty : '') +
          '  (set RAILWAY_PG_VOLUME_GB env var to match your Railway plan)'
        )
      ),
      // Progress bar
      h('div', { style: { width: '180px', height: '10px', background: '#fff', border: '1px solid '+colour, borderRadius: '999px', overflow: 'hidden' }},
        h('div', { style: { width: Math.min(100, pct) + '%', height: '100%', background: colour }})
      )
    ));
  }
  if (!list.length) {
    view.appendChild(h('div', { class: 'empty' }, 'No tenants yet. Click "+ Create tenant" to add one manually, or wait for a paid signup to come through Cashfree.'));
    return;
  }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Org'), h('th', {}, 'Slug'), h('th', {}, 'Email'),
      h('th', {}, 'Plan'), h('th', {}, 'Status'), h('th', {}, 'Period ends'), h('th', {}, '')
    )),
    h('tbody', {}, ...list.map(t => h('tr', {},
      h('td', {},
        h('b', {}, t.org_name),
        // DB_VOLUME_v1 — show per-tenant disk usage under the name
        (function() {
          const s = _sizeMap.get(t.slug);
          if (!s) return null;
          const p = s.percent_of_volume;
          const c = p >= 10 ? '#dc2626' : p >= 5 ? '#f59e0b' : '#16a34a';
          return h('div', {
            style: { fontSize: '.72rem', color: c, marginTop: '2px', fontWeight: '600' },
            title: 'Database ' + s.db_name + ' uses ' + s.pretty + ' (' + p + '% of volume, ' + s.percent_of_used + '% of used)'
          }, '💾 ' + s.pretty + ' · ' + p + '%');
        })()
      ),
      h('td', {}, h('a', { href: '/t/' + t.slug, target: '_blank' }, '/t/' + t.slug)),
      h('td', { class: 'muted' }, t.contact_email),
      h('td', {}, t.package_name || '—'),
      h('td', {}, h('span', { class: 'tag ' + (t.status === 'active' ? 'ok' : t.status === 'pending_delete' ? 'err' : 'warn') }, t.status)),
      h('td', { class: 'muted' }, fmtDate(t.current_period_end)),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        // Open the tenant workspace in a new window with a short-lived
        // sudo token. Disabled for non-active tenants — there's no
        // working session to drop into. Audit-logged on every click.
        (t.status === 'active' || t.status === 'trial' || t.status === 'pending_delete')
          ? h('button', {
              class: 'btn xs', style: { marginRight: '.3rem' },
              title: 'Open this workspace in a new window, signed in as the tenant admin (5-min magic link, audit-logged)',
              onclick: () => loginAsTenant(t)
            }, '🔓 Login as ↗')
          : null,
        // Reset the tenant admin password — generates a fresh password,
        // updates the user row in the tenant DB, and shows the plaintext
        // ONCE so the super-admin can copy + share with the tenant.
        (t.status === 'active' || t.status === 'trial' || t.status === 'pending_delete')
          ? h('button', {
              class: 'btn xs', style: { marginRight: '.3rem', background: '#fef3c7', borderColor: '#f59e0b', color: '#92400e' },
              title: 'Reset the password for this tenant admin user. New password is shown ONCE.',
              onclick: () => resetTenantAdminPassword(t)
            }, '🔑 Reset password')
          : null,
        // Re-seed help articles: refreshes the system-seeded knowledge-base
        // entries (those tagged `system-seed`). Tenant admins keep any
        // articles they've authored themselves. Useful when we ship new
        // default articles and want to roll them out to existing tenants.
        (t.status === 'active' || t.status === 'trial' || t.status === 'pending_delete')
          ? h('button', {
              class: 'btn ghost xs', style: { marginRight: '.3rem' },
              title: 'Re-seed default help articles in this tenant\'s Knowledge tab. Admin-authored articles are preserved.',
              onclick: async () => {
                if (!confirm('Re-seed default help articles for ' + (t.org_name || t.slug) + '?\n\nThis replaces the system-seeded articles only — anything the tenant\'s admin has added will be left alone.')) return;
                try {
                  const r = await api('api_saas_tenants_reseedKb', t.id);
                  toast('Re-seeded ' + r.articles + ' articles for ' + (t.org_name || t.slug));
                } catch (e) { toast('Re-seed failed: ' + e.message, 'err'); }
              }
            }, '📚 Re-seed help')
          : null,
        h('button', { class: 'btn ghost xs', title: 'Toggle modules ON/OFF for this tenant',
          onclick: () => openModulesModal(t)
        }, '\ud83e\udde9 Modules'),
        // PACK_RETROFIT_v1 — install / switch industry pack on existing tenant.
        h('button', { class: 'btn ghost xs', title: 'Install or switch industry pack (Education / Real Estate / Generic)',
          onclick: () => openInstallPackModal(t)
        }, '\ud83c\udfd7\ufe0f Pack'),
        // ADMIN_ADD_USER_v1 — manage users + per-user pricing for this tenant
        h('button', { class: 'btn ghost xs', title: 'Add users + set per-user monthly cost',
          onclick: () => openTenantUsersModal(t)
        }, '\ud83d\udc64 Users'),
        // ADMIN_AI_RECORDING_TOGGLE_v1 — flip AI Call Summary on/off for this tenant
        h('button', {
          class: 'btn ghost xs',
          title: 'Toggle AI Call Summary (recording transcription) on/off',
          onclick: () => openAiRecordingModal(t)
        }, '\ud83c\udf99\ufe0f AI Rec'),
        t.status === 'active'
          ? h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_tenants_suspend', t.id); navigate('tenants'); } }, 'Suspend')
          : h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_tenants_restore', t.id); navigate('tenants'); } }, 'Restore')
      )
    )))
  );
  // FB_REGISTRY_BACKFILL_v1 — one-click sync all tenant FB pages into central registry
  const fbBackfillBar = h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.6rem', padding: '.5rem .7rem', background: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }},
    h('span', { style: { fontSize: '.85rem' }}, '\ud83d\udce1 FB Lead Ads central registry:'),
    h('span', { class: 'muted', style: { fontSize: '.78rem', flex: 1 }},
      'Push every tenant\'s connected Facebook pages into fb_leads_connections.json on smartcrmsolution.com so the central webhook routes leads correctly. Safe to run anytime.'),
    h('button', { class: 'btn primary', style: { whiteSpace: 'nowrap' }, onclick: async (ev) => {
      const btn = ev.target;
      btn.disabled = true; btn.textContent = '\u23f3 Backfilling...';
      try {
        const out = await api('api_saas_fb_backfillRegistry', {});
        const s = out.summary || {};
        toast('\u2714 Backfill done: ' + (s.totalRegistered || 0) + ' pages registered across ' + (s.tenants_scanned || 0) + ' tenants');
        // Show results in a quick modal
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        m.onclick = (e) => { if (e.target === m) m.remove(); };
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:12px;max-width:720px;width:92%;max-height:80vh;overflow:auto;padding:1.2rem 1.4rem;';
        card.innerHTML = '<h3 style="margin:0 0 .4rem">\u{1f4e1} FB Registry backfill results</h3>' +
                        '<p class="muted" style="font-size:.85rem;margin-bottom:.6rem">Pages registered: <b>' + (s.totalRegistered || 0) + '</b> &middot; tenants scanned: <b>' + (s.tenants_scanned || 0) + '</b> &middot; errors: <b>' + (s.totalErrors || 0) + '</b></p>' +
                        '<pre style="background:#0f172a;color:#e2e8f0;padding:.7rem;border-radius:6px;font-size:.74rem;max-height:55vh;overflow:auto;white-space:pre-wrap">' + JSON.stringify(out.results, null, 2) + '</pre>' +
                        '<div style="text-align:right;margin-top:.7rem"><button id="re-close" style="padding:.45rem .8rem;border-radius:8px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-weight:600">Close</button></div>';
        m.appendChild(card);
        document.body.appendChild(m);
        card.querySelector('#re-close').onclick = () => m.remove();
      } catch(e) { toast('Backfill failed: ' + e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '\ud83d\udd04 Backfill FB Registry'; }
    }}, '\ud83d\udd04 Backfill FB Registry')
  );
  view.appendChild(fbBackfillBar);
    view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

/**
 * Open the tenant workspace in a new window with a short-lived
 * super-admin sudo token. Pop the new tab IMMEDIATELY (synchronously
 * inside the click handler) so popup blockers don't kick in, then
 * navigate it to the magic-link URL once the API call returns.
 */
async function resetTenantAdminPassword(t) {
  const email = prompt('Reset password for which user email? (leave blank for tenant contact email "' + (t.contact_email || 'unknown') + '")', '');
  if (email === null) return;
  const targetEmail = (email || t.contact_email || '').trim();
  if (!targetEmail) { toast('No contact email on tenant — pass email explicitly', 'err'); return; }
  if (!confirm('Reset password for ' + targetEmail + ' on "' + (t.org_name || t.slug) + '"? A new random password will be generated and shown to you ONCE.')) return;
  let r;
  try {
    r = await api('api_saas_tenants_resetUserPassword', { tenantId: t.id, email: targetEmail });
  } catch (e) { toast('Reset failed: ' + e.message, 'err'); return; }
  if (!r || !r.ok || !r.new_password) {
    toast('Reset returned no password — server response: ' + JSON.stringify(r || {}).slice(0, 200), 'err');
    return;
  }
  console.log('🔑 Password reset for', r.user, 'NEW PASSWORD:', r.new_password);

  // Self-styled overlay — does NOT depend on admin.css. Renders even if the
  // SPA's modal classes are missing or overridden.
  const dlg = document.createElement('div');
  dlg.style.cssText = 'position:fixed; inset:0; background:rgba(15,23,42,.55); display:flex; align-items:center; justify-content:center; z-index:99999;';
  const inner = document.createElement('div');
  inner.style.cssText = 'background:#fff; border-radius:12px; box-shadow:0 20px 50px rgba(0,0,0,.3); max-width:540px; width:92%; padding:1.2rem 1.4rem; font-family:-apple-system,Segoe UI,Roboto,sans-serif; color:#0f172a;';
  inner.innerHTML = ''
    + '<h2 style="margin:0 0 .4rem; color:#92400e">🔑 Password reset</h2>'
    + '<p style="margin:0 0 .3rem"><b>Workspace:</b> ' + (t.slug || '') + '</p>'
    + '<p style="margin:0 0 .8rem"><b>User:</b> ' + (r.user.name || '') + ' &middot; ' + (r.user.email || '') + ' &middot; ' + (r.user.role || '') + '</p>'
    + '<div style="font-family:ui-monospace,Menlo,Consolas,monospace; font-size:1.4rem; font-weight:700; padding:1rem; background:#fef3c7; border:2px dashed #f59e0b; border-radius:10px; text-align:center; letter-spacing:.06em; user-select:all; color:#92400e" id="pw-display">' + r.new_password + '</div>'
    + '<p style="font-size:.82rem; color:#64748b; margin-top:.7rem">' + (r.note || 'Save this password now — it is shown ONCE.') + '</p>'
    + '<div style="display:flex; gap:.5rem; justify-content:flex-end; margin-top:.9rem">'
    + '<button id="pw-copy" style="padding:.5rem .9rem; border-radius:8px; border:1px solid #cbd5e1; background:#fff; cursor:pointer; font-weight:600">📋 Copy password</button>'
    + '<button id="pw-close" style="padding:.5rem .9rem; border-radius:8px; border:none; background:#6366f1; color:#fff; cursor:pointer; font-weight:600">Done</button>'
    + '</div>';
  dlg.appendChild(inner);
  document.body.appendChild(dlg);
  inner.querySelector('#pw-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(r.new_password); toast('Copied to clipboard', 'ok'); }
    catch (_) { window.prompt('Copy this password manually:', r.new_password); }
  };
  inner.querySelector('#pw-close').onclick = () => dlg.remove();
  dlg.onclick = (ev) => { if (ev.target === dlg) dlg.remove(); };
}

async function loginAsTenant(t) {
  // Open a placeholder window inside the click — browsers only allow
  // window.open without prompting if it's a direct user gesture.
  const w = window.open('about:blank', '_blank');
  if (!w) {
    toast('Pop-up was blocked — allow pop-ups for this site and try again.', 'err');
    return;
  }
  try {
    w.document.write(`<!doctype html><meta charset=utf-8><title>Opening ${t.org_name || t.slug}…</title>
<style>body{font-family:system-ui,sans-serif;color:#475569;margin:6rem auto;max-width:420px;text-align:center}</style>
<h2>🔓 Opening ${t.org_name || t.slug}…</h2>
<p>Minting a 5-minute sudo token, hold on…</p>`);
  } catch (_) {}
  try {
    const r = await api('api_saas_tenants_loginAs', t.id);
    w.location = r.url;
    toast('Opened ' + (t.org_name || t.slug) + ' in a new window');
  } catch (e) {
    try { w.close(); } catch (_) {}
    toast('Login as failed: ' + e.message, 'err');
  }
}

async function openCreateTenant() {
  // Need the package list so the operator can pick a plan.
  let pkgs = [];
  try { pkgs = await api('api_saas_packages_list'); }
  catch (e) { toast(e.message, 'err'); return; }
  if (!pkgs.length) { toast('Add a package first (Packages tab) before creating a tenant.', 'err'); return; }

  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal', style: { maxWidth: '560px' } });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '+ Create tenant manually'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem', marginTop: 0 } },
    'Provisions a workspace immediately — no Cashfree payment needed. ',
    'The customer gets a welcome email with login URL + temporary password.'));

  const form = h('form', { onsubmit: ev => { ev.preventDefault(); _submitCreateTenant(form, pkgs, m); } });

  const field = (label, input) => h('div', { class: 'field', style: { marginBottom: '.6rem' } },
    h('label', { style: { display: 'block', fontSize: '.78rem', marginBottom: '.2rem', color: '#475569' } }, label),
    input
  );

  form.appendChild(field('Contact name *',
    h('input', { name: 'name', required: 'required', placeholder: 'Priya Sharma', style: { width: '100%' } })));
  form.appendChild(field('Email *',
    h('input', { name: 'email', type: 'email', required: 'required', placeholder: 'priya@acme.com', style: { width: '100%' } })));
  form.appendChild(field('Mobile *',
    h('input', { name: 'mobile', required: 'required', placeholder: '9876543210', style: { width: '100%' }, pattern: '\\+?\\d{8,15}' })));
  form.appendChild(field('Organisation *',
    h('input', { name: 'org_name', required: 'required', placeholder: 'ACME Realty', style: { width: '100%' } })));
  form.appendChild(field('Workspace URL slug *',
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '.25rem' } },
      h('span', { class: 'muted', style: { fontSize: '.85rem' } }, '/t/'),
      // Pattern uses [-a-z0-9] (dash at start) so Firefox v-mode regex
      // doesn't reject it, same fix we applied to the public landing.
      h('input', { name: 'desired_slug', required: 'required', placeholder: 'acme',
        pattern: '[a-z][-a-z0-9]{2,29}',
        style: { flex: 1 } })
    )));
  const pkgSel = h('select', { name: 'package_id', required: 'required', style: { width: '100%' } },
    h('option', { value: '' }, '— pick a plan —'),
    ...pkgs.map(p => h('option', { value: p.id }, p.name + ' · ₹' + Number(p.base_price_inr || 0).toLocaleString('en-IN') + ' · ' + (p.recurring_period_count || 1) + ' ' + p.recurring_period))
  );
  form.appendChild(field('Package *', pkgSel));

  /* --- BILL_PLAN_PICKER_v1 (2026-05-23) ---
     Start Date + Amount Override + live Validity-ends-on display.
     - Start Date defaults to today; super-admin can backdate.
     - Amount field auto-fills from the picked package's base_price_inr.
     - Validity ends on: computed live from (Start Date) + (cycle * count).
     - Custom end-date checkbox lets you punch in a bespoke date (trials, promos). */
  const _todayIso = new Date().toISOString().slice(0, 10);
  const startInp  = h('input', { name: 'start_date', type: 'date', value: _todayIso, style: { width: '100%' } });
  form.appendChild(field('Validity start date *', startInp));

  const amtInp = h('input', { name: 'override_amount', type: 'number', step: '0.01', min: '0',
    placeholder: 'auto-fills from package', style: { width: '100%' } });
  form.appendChild(field('Amount (₹) — override package price',
    h('div', {},
      amtInp,
      h('div', { class: 'muted', style: { fontSize: '.72rem', marginTop: '.2rem' } },
        'Leave blank to use the package list price. Override for discounts, custom deals or promotional pricing.')
    )));

  const endPrev = h('div', { id: 'create-tenant-end-preview',
    style: { padding: '.5rem .7rem', background: '#f1f5f9', borderRadius: '6px', fontSize: '.85rem', color: '#0f172a' } },
    'Pick a package and start date to see when validity ends');
  form.appendChild(field('Validity ends on (auto-computed)', endPrev));

  const customEndChk = h('input', { type: 'checkbox', name: 'use_custom_end' });
  const customEndInp = h('input', { name: 'override_end_date', type: 'date', value: '', style: { width: '100%', display: 'none' } });
  customEndChk.addEventListener('change', () => {
    customEndInp.style.display = customEndChk.checked ? '' : 'none';
    if (!customEndChk.checked) customEndInp.value = '';
    _refreshEndPreview();
  });
  form.appendChild(h('label', { style: { display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.78rem', color: '#475569', margin: '.4rem 0 .2rem' } },
    customEndChk, h('span', {}, 'Use custom end date (override the auto-computed one)')));
  form.appendChild(customEndInp);

  function _addPeriod(startDate, cycle, count) {
    const d = new Date(startDate);
    const n = Math.max(1, Number(count) || 1);
    const c = String(cycle || 'month').toLowerCase();
    if (c === 'lifetime') { d.setFullYear(d.getFullYear() + 99); return d; }
    if (c === 'year')     { d.setFullYear(d.getFullYear() + n); return d; }
    if (c === 'quarter')  { d.setMonth(d.getMonth() + (3 * n));  return d; }
    if (c === 'week')     { d.setDate(d.getDate() + (7 * n));    return d; }
    d.setMonth(d.getMonth() + n);
    return d;
  }
  function _fmtIst(d) { return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  function _refreshEndPreview() {
    const pkgId = Number(pkgSel.value);
    const pkg = pkgs.find(p => p.id === pkgId);
    if (!pkg || !startInp.value) {
      endPrev.textContent = 'Pick a package and start date to see when validity ends';
      endPrev.style.background = '#f1f5f9';
      return;
    }
    if (customEndChk.checked && customEndInp.value) {
      const d = new Date(customEndInp.value);
      const days = Math.round((d - new Date(startInp.value)) / 86400000);
      endPrev.innerHTML = '<b>' + _fmtIst(d) + '</b> · ' + days + ' days from start · <span style="color:#7c3aed">custom</span>';
      endPrev.style.background = '#ede9fe';
      return;
    }
    if (Number(pkg.is_lifetime) === 1) {
      endPrev.innerHTML = '<b>Lifetime</b> · no expiry · ' + pkg.name;
      endPrev.style.background = '#d1fae5';
      return;
    }
    const end = _addPeriod(startInp.value, pkg.recurring_period, pkg.recurring_period_count);
    const days = Math.round((end - new Date(startInp.value)) / 86400000);
    endPrev.innerHTML = '<b>' + _fmtIst(end) + '</b> · ' + days + ' days · ' + (pkg.recurring_period_count || 1) + ' ' + pkg.recurring_period + (Number(pkg.recurring_period_count) > 1 ? 's' : '');
    endPrev.style.background = '#dbeafe';
  }
  pkgSel.addEventListener('change', () => {
    const pkg = pkgs.find(p => p.id === Number(pkgSel.value));
    if (pkg && !amtInp.value) amtInp.placeholder = '₹ ' + Number(pkg.base_price_inr || 0).toLocaleString('en-IN') + ' (package default — leave blank to use)';
    _refreshEndPreview();
  });
  startInp.addEventListener('change', _refreshEndPreview);
  customEndInp.addEventListener('change', _refreshEndPreview);
  /* --- /BILL_PLAN_PICKER_v1 --- */

  /* CREATE_TENANT_USERS_v1 (2026-05-28) — user cap + extra-user pricing.
     - user_cap blank → backend auto-uses package quotas.users.limit
     - extra-user charge is what we bill per user OVER the cap, per period. */
  const userCapInp = h('input', { name: 'user_cap', type: 'number', min: '0', step: '1',
    placeholder: 'leave blank → use package quota', style: { width: '100%' } });
  form.appendChild(field('User cap (max active users)',
    h('div', {},
      userCapInp,
      h('div', { class: 'muted', style: { fontSize: '.72rem', marginTop: '.2rem' } },
        'Blank = use the package\'s built-in user limit. Set a number to override (custom plans, agency bundles, paid add-ons).')
    )));

  const extraInrInp = h('input', { name: 'user_extra_charge_inr', type: 'number', min: '0', step: '0.01',
    placeholder: '0', value: '0', style: { width: '100%' } });
  const extraPerSel = h('select', { name: 'user_extra_charge_period', style: { width: '100%' } },
    h('option', { value: 'month' }, 'per month'),
    h('option', { value: 'quarter' }, 'per quarter'),
    h('option', { value: 'year' }, 'per year')
  );
  form.appendChild(field('Extra-user pricing (when tenant exceeds cap)',
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem' } },
      h('div', {}, h('div', { class: 'muted', style: { fontSize: '.7rem', marginBottom: '.2rem' } }, '₹ per extra user'),  extraInrInp),
      h('div', {}, h('div', { class: 'muted', style: { fontSize: '.7rem', marginBottom: '.2rem' } }, 'billed'),                extraPerSel)
    )));

  // Industry pack — selects a vertical-specific bundle. 'Generic' (default)
  // is the base CRM with no pack; picking a pack triggers its installer
  // (extra tables, seed data, statuses, custom fields) immediately after
  // the tenant is provisioned.
  const packSel = h('select', { name: 'industry_pack', style: { width: '100%' } },
    h('option', { value: '' }, '🧩 Generic CRM (no pack — base features only)'),
    h('option', { value: 'education' },  '🎓 Education / Coaching — fees + installments + reminders'),
    h('option', { value: 'realestate' }, '🏢 Real Estate — inventory + bookings + demand letters + commissions')
  );
  form.appendChild(field('Industry pack', packSel));

  form.appendChild(field('Notes (internal)',
    h('textarea', { name: 'notes', rows: 2, placeholder: 'e.g. paid offline by bank transfer ref XXX', style: { width: '100%' } })));

  // mark_paid checkbox — defaults true since the operator is creating
  // this manually for a customer who's already paid (or is on trial).
  const markPaidWrap = h('label', { style: { display: 'flex', alignItems: 'center', gap: '.4rem', margin: '.4rem 0', fontSize: '.85rem' } },
    h('input', { type: 'checkbox', name: 'mark_paid', checked: 'checked' }),
    h('span', {}, 'Mark first invoice as paid (tenant lands in active state)')
  );
  form.appendChild(markPaidWrap);

  const btnRow = h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' } },
    h('button', { type: 'button', class: 'btn ghost', onclick: () => m.remove() }, 'Cancel'),
    h('button', { type: 'submit', class: 'btn primary', id: 'create-tenant-btn' }, 'Create tenant')
  );
  form.appendChild(btnRow);
  body.appendChild(form);
  card.appendChild(body);
  // Snapshot button — query live counts on the showcase tenant DB.
  const snapBtn = h('button', { class: 'btn ghost', style: { marginLeft: '.5rem' }, onclick: async () => {
    snapBtn.disabled = true; snapBtn.textContent = '\u23f3 Querying\u2026';
    try {
      const r = await api('api_saas_demo_snapshot', {});
      const dlg = document.createElement('div');
      dlg.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const inner = document.createElement('div');
      inner.style.cssText = 'background:#fff;border-radius:12px;max-width:720px;width:92%;max-height:85vh;overflow:auto;padding:1.2rem 1.4rem;font-family:-apple-system,Segoe UI,Roboto,sans-serif;';
      inner.innerHTML = '<h3 style="margin:0 0 .4rem">\u{1f4ca} Showcase tenant snapshot</h3>' + '<p class="muted" style="font-size:.85rem; margin-bottom:.7rem">Live row counts on the showcase tenant database. Slug: <b>' + (r.slug || '') + '</b> &middot; status: ' + (r.tenant_status || '') + '</p>' + '<pre style="background:#0f172a;color:#e2e8f0;padding:.7rem;border-radius:6px;font-size:.78rem;max-height:60vh;overflow:auto;white-space:pre-wrap">' + JSON.stringify(r, null, 2) + '</pre>' + '<div style="display:flex;gap:.4rem;justify-content:flex-end;margin-top:.7rem">' + '<button id="snap-copy" style="padding:.5rem .9rem;border-radius:8px;border:1px solid #cbd5e1;background:#fff;cursor:pointer">\u{1f4cb} Copy JSON</button>' + '<button id="snap-close" style="padding:.5rem .9rem;border-radius:8px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-weight:600">Close</button>' + '</div>';
      dlg.appendChild(inner);
      document.body.appendChild(dlg);
      inner.querySelector('#snap-copy').onclick = () => { try { navigator.clipboard.writeText(JSON.stringify(r, null, 2)); toast('Copied'); } catch (_) {} };
      inner.querySelector('#snap-close').onclick = () => dlg.remove();
      dlg.onclick = (ev) => { if (ev.target === dlg) dlg.remove(); };
    } catch (e) { toast('Snapshot failed: ' + e.message, 'err'); }
    finally { snapBtn.disabled = false; snapBtn.textContent = '\u{1f50d} Show showcase snapshot'; }
  }}, '\u{1f50d} Show showcase snapshot');
  body.appendChild(snapBtn);
  m.appendChild(card);
  document.body.appendChild(m);
  setTimeout(() => form.querySelector('input[name=name]').focus(), 50);
}

async function _submitCreateTenant(form, pkgs, modal) {
  const btn = form.querySelector('#create-tenant-btn');
  const setBtn = (txt, dis) => { btn.textContent = txt; btn.disabled = !!dis; };
  setBtn('Creating…', true);
  const fd = new FormData(form);
  // BILL_PLAN_PICKER_v1 — also send start_date / override_amount / override_end_date.
  const overrideAmtRaw = (fd.get('override_amount') || '').toString().trim();
  const customEndRaw   = (fd.get('override_end_date') || '').toString().trim();
  const payload = {
    name:         (fd.get('name') || '').toString().trim(),
    email:        (fd.get('email') || '').toString().trim(),
    mobile:       (fd.get('mobile') || '').toString().trim(),
    org_name:     (fd.get('org_name') || '').toString().trim(),
    desired_slug: (fd.get('desired_slug') || '').toString().trim().toLowerCase(),
    package_id:   Number(fd.get('package_id')) || 0,
    industry_pack: (fd.get('industry_pack') || '').toString().trim(),
    notes:        (fd.get('notes') || '').toString().trim() || null,
    mark_paid:    fd.get('mark_paid') === 'on',
    start_date:   (fd.get('start_date') || '').toString().trim(),
    override_amount: overrideAmtRaw === '' ? null : Number(overrideAmtRaw),
    override_end_date: customEndRaw || null,
    // CREATE_TENANT_USERS_v1 — user cap + extra-user pricing
    user_cap: (() => { const v = (fd.get('user_cap') || '').toString().trim(); return v === '' ? null : Math.max(0, Math.floor(Number(v) || 0)); })(),
    user_extra_charge_inr: Math.max(0, Number((fd.get('user_extra_charge_inr') || '0').toString().trim()) || 0),
    user_extra_charge_period: (fd.get('user_extra_charge_period') || 'month').toString().trim()
  };
  try {
    const r = await api('api_saas_tenants_createManual', payload);
    modal.remove();
    // Success modal — show generated credentials so the admin can copy
    // them out before they navigate away.
    showCreateTenantSuccess(r);
    // Refresh the list
    navigate('tenants');
  } catch (e) {
    setBtn('Create tenant', false);
    toast(e.message, 'err');
  }
}

function showCreateTenantSuccess(r) {
  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal', style: { maxWidth: '520px' } });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '✅ Tenant created'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', {}, 'A welcome email with these credentials has been sent. Copy them now — the password will not be shown again.'));
  const credBox = (lbl, val) => h('div', { style: { background: '#f1f5f9', padding: '.6rem .8rem', borderRadius: '6px', margin: '.5rem 0' } },
    h('div', { class: 'muted', style: { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em' } }, lbl),
    h('div', { style: { fontFamily: 'monospace', fontSize: '.95rem', wordBreak: 'break-all' } }, val)
  );
  body.appendChild(credBox('Login URL', r.login_url));
  body.appendChild(credBox('Email', r.email));
  body.appendChild(credBox('Temporary password', r.password));
  body.appendChild(h('button', {
    class: 'btn primary', style: { marginTop: '.5rem' },
    onclick: () => {
      try {
        navigator.clipboard.writeText(
          'Login: ' + r.login_url + '\nEmail: ' + r.email + '\nPassword: ' + r.password
        );
        toast('Copied');
      } catch (_) { toast('Copy failed', 'err'); }
    }
  }, '📋 Copy all'));
  card.appendChild(body);
  m.appendChild(card);
  document.body.appendChild(m);
}

// ---------- 🌟 Showcase demo tenant ----------
// One-click "create or refresh" the showcase demo. Calls
// api_saas_demo_seed which provisions tenant 'showcase' (if missing)
// and seeds it with users, products, leads, recordings (with fake
// AI summaries / audits / ratings), quotations, etc.
async function openShowcaseDemoModal() {
  const m = h('div', { class: 'modal-bd' });
  const card = h('div', { class: 'modal', style: { maxWidth: '560px' } });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '🌟 Showcase Demo'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('p', {},
    'Creates (or refreshes) a fully-loaded demo tenant at ',
    h('code', {}, '/t/showcase'),
    '. The workspace is pre-populated with:'
  ));
  body.appendChild(h('ul', { style: { fontSize: '.88rem', color: '#475569', lineHeight: '1.6' } },
    h('li', {}, '5 sales users + admin'),
    h('li', {}, '6 products, 5 sources, 7 statuses'),
    h('li', {}, '5 project stages, 8 tags, 4 custom fields'),
    h('li', {}, '30 leads spread across the pipeline'),
    h('li', {}, '10 call recordings with pre-baked AI summaries, action items, sentiment, ratings + audit notes'),
    h('li', {}, '10 quotations (mixed states: draft / sent / accepted / rejected)'),
    h('li', {}, 'Welcome announcement + brand theme + interactive in-app tour')
  ));
  body.appendChild(h('p', { class: 'muted', style: { fontSize: '.82rem' } },
    'Re-running this resets all transactional data (leads, quotations, recordings) but preserves the workspace itself. Admin password is reset to the documented demo password each run.'
  ));

  const status = h('div', { id: 'demo-status', style: { padding: '.6rem', background: '#f8fafc', borderRadius: '6px', fontSize: '.85rem', minHeight: '2rem', display: 'none' } });
  body.appendChild(status);

  const result = h('div', { id: 'demo-result', style: { display: 'none', marginTop: '.6rem' } });
  body.appendChild(result);

  const runBtn = h('button', { class: 'btn primary', id: 'demo-run-btn', onclick: () => _runDemoSeed() }, '✨ Generic CRM demo (showcase)');
  const eduBtn = h('button', { class: 'btn', style: { background: '#fef3c7', color: '#92400e', borderColor: '#fde68a' }, onclick: () => _runIndustrySeed('education') }, '🎓 Education demo (showcase-edu)');
  const reBtn  = h('button', { class: 'btn', style: { background: '#dbeafe', color: '#1e40af', borderColor: '#bfdbfe' }, onclick: () => _runIndustrySeed('realestate') }, '🏢 Real Estate demo (showcase-re)');
  const cancelBtn = h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Close');
  body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '.5rem', marginTop: '1rem', flexWrap: 'wrap' } },
    h('div', { style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap' } }, eduBtn, reBtn),
    h('div', { style: { display: 'flex', gap: '.5rem' } }, cancelBtn, runBtn)
  ));

  async function _runIndustrySeed(pack) {
    const btn = pack === 'education' ? eduBtn : reBtn;
    const label = pack === 'education' ? '🎓 Education' : '🏢 Real Estate';
    btn.disabled = true; btn.textContent = '⏳ Seeding ' + label + '…';
    status.style.display = 'block';
    status.style.background = '#e0f2fe'; status.style.color = '#075985';
    status.textContent = 'Installing ' + label + ' pack and loading rich demo data on the showcase tenant…';
    try {
      const fn = pack === 'education' ? 'api_saas_demo_seedEducationPack' : 'api_saas_demo_seedRealEstatePack';
      const r = await api(fn, {});
      status.style.background = '#dcfce7'; status.style.color = '#166534';
      status.textContent = '✅ ' + label + ' demo ready! ' + Object.entries(r.counts || {}).map(([k,v]) => v + ' ' + k).join(', ');
      result.style.display = 'block';
      result.innerHTML = '';
      const credBox = (lbl, val) => h('div', { style: { background: '#f1f5f9', padding: '.6rem .8rem', borderRadius: '6px', margin: '.4rem 0' } },
        h('div', { class: 'muted', style: { fontSize: '.72rem', textTransform: 'uppercase' } }, lbl),
        h('div', { style: { fontFamily: 'monospace', fontSize: '.95rem', wordBreak: 'break-all' } }, val)
      );
      result.appendChild(h('h4', { style:{ margin:'0 0 .4rem 0' } }, label + ' showcase URLs'));
      Object.entries(r.showcase_links || {}).forEach(([k, v]) => result.appendChild(credBox(k.replace(/_/g,' '), v)));
      result.appendChild(credBox('Login email',    r.email));
      result.appendChild(credBox('Login password', r.password));
      result.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.6rem', flexWrap: 'wrap' } },
        h('button', { class: 'btn primary', onclick: () => window.open(r.url, '_blank') }, '🔓 Open ' + label + ' demo ↗'),
        h('button', { class: 'btn ghost', onclick: () => {
          try { navigator.clipboard.writeText(label + ' demo:\nURL: ' + r.url + '\nEmail: ' + r.email + '\nPassword: ' + r.password); toast('Copied'); }
          catch (_) { toast('Copy failed', 'err'); }
        } }, '📋 Copy share text')
      ));
      btn.textContent = '🔄 Re-seed ' + label;
      btn.disabled = false;
    } catch (e) {
      status.style.background = '#fee2e2'; status.style.color = '#991b1b';
      status.textContent = '❌ ' + e.message;
      btn.disabled = false;
      btn.textContent = label === '🎓 Education' ? '🔄 Re-seed Education demo' : '🔄 Re-seed Real Estate demo';
    }
  }

  card.appendChild(body);
  m.appendChild(card);
  document.body.appendChild(m);

  async function _runDemoSeed() {
    runBtn.disabled = true;
    runBtn.textContent = '⏳ Working… (this can take 20-60 seconds)';
    status.style.display = 'block';
    status.textContent = 'Provisioning database, seeding leads, recordings, quotations…';
    try {
      const r = await api('api_saas_demo_seed', {});
      status.style.background = '#dcfce7'; status.style.color = '#166534';
      status.textContent = '✅ Done! ' + Object.entries(r.counts).map(([k, v]) => v + ' ' + k).join(', ');
      result.style.display = 'block';
      const credBox = (lbl, val) => h('div', { style: { background: '#f1f5f9', padding: '.6rem .8rem', borderRadius: '6px', margin: '.4rem 0' } },
        h('div', { class: 'muted', style: { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em' } }, lbl),
        h('div', { style: { fontFamily: 'monospace', fontSize: '.95rem', wordBreak: 'break-all' } }, val)
      );
      result.innerHTML = '';
      result.appendChild(credBox('Login URL', r.url));
      result.appendChild(credBox('Email',     r.email));
      result.appendChild(credBox('Password',  r.password));
      result.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.5rem', flexWrap: 'wrap' } },
        h('button', { class: 'btn primary', onclick: () => { window.open(r.url, '_blank'); } }, '🔓 Open demo workspace ↗'),
        h('button', { class: 'btn ghost', onclick: () => {
          try {
            navigator.clipboard.writeText('URL: ' + r.url + '\nEmail: ' + r.email + '\nPassword: ' + r.password);
            toast('Copied');
          } catch (_) { toast('Copy failed', 'err'); }
        } }, '📋 Copy creds')
      ));
      runBtn.textContent = '🔄 Re-run (refresh data)';
      runBtn.disabled = false;
      const seedDump = h('pre', { style: { background: '#0f172a', color: '#e2e8f0', padding: '.7rem', borderRadius: '6px', fontSize: '.78rem', maxHeight: '320px', overflow: 'auto', whiteSpace: 'pre-wrap', marginTop: '.6rem' } },
        JSON.stringify(r, null, 2));
      result.appendChild(h('div', { style: { marginTop: '.5rem', fontWeight: 600 } }, '\u{1f4ca} Verification counts (seed response):'));
      result.appendChild(seedDump);
    } catch (e) {
      status.style.background = '#fee2e2'; status.style.color = '#991b1b';
      status.textContent = '❌ ' + e.message;
      runBtn.disabled = false;
      runBtn.textContent = '✨ Create / refresh demo';
    }
  }
}

VIEWS.invoices = async (view) => {
  view.appendChild(h('h1', {}, 'Invoices'));
  let list;
  try { list = await api('api_saas_invoices_list', {}); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) { view.appendChild(h('div', { class: 'empty' }, 'No invoices yet.')); return; }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Number'), h('th', {}, 'Org'), h('th', {}, 'Plan'),
      h('th', {}, 'Total'), h('th', {}, 'Status'), h('th', {}, 'Date'), h('th', {}, '')
    )),
    h('tbody', {}, ...list.map(i => h('tr', {},
      h('td', {}, h('code', {}, i.number)),
      h('td', {}, i.org_name || '—'),
      h('td', { class: 'muted' }, i.package_name || '—'),
      h('td', {}, fmtRupees(i.total_inr)),
      h('td', {}, h('span', { class: 'tag ' + (i.status === 'paid' ? 'ok' : i.status === 'pending' ? 'warn' : 'err') }, i.status)),
      h('td', { class: 'muted' }, fmtDate(i.created_at)),
      h('td', { style: { textAlign: 'right' } },
        i.status !== 'paid' ? h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_invoices_markPaid', i.id); navigate('invoices'); } }, 'Mark paid') : null
      )
    )))
  );
  // FB_REGISTRY_BACKFILL_v1 — one-click sync all tenant FB pages into central registry
  const fbBackfillBar = h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.6rem', padding: '.5rem .7rem', background: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }},
    h('span', { style: { fontSize: '.85rem' }}, '\ud83d\udce1 FB Lead Ads central registry:'),
    h('span', { class: 'muted', style: { fontSize: '.78rem', flex: 1 }},
      'Push every tenant\'s connected Facebook pages into fb_leads_connections.json on smartcrmsolution.com so the central webhook routes leads correctly. Safe to run anytime.'),
    h('button', { class: 'btn primary', style: { whiteSpace: 'nowrap' }, onclick: async (ev) => {
      const btn = ev.target;
      btn.disabled = true; btn.textContent = '\u23f3 Backfilling...';
      try {
        const out = await api('api_saas_fb_backfillRegistry', {});
        const s = out.summary || {};
        toast('\u2714 Backfill done: ' + (s.totalRegistered || 0) + ' pages registered across ' + (s.tenants_scanned || 0) + ' tenants');
        // Show results in a quick modal
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        m.onclick = (e) => { if (e.target === m) m.remove(); };
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:12px;max-width:720px;width:92%;max-height:80vh;overflow:auto;padding:1.2rem 1.4rem;';
        card.innerHTML = '<h3 style="margin:0 0 .4rem">\u{1f4e1} FB Registry backfill results</h3>' +
                        '<p class="muted" style="font-size:.85rem;margin-bottom:.6rem">Pages registered: <b>' + (s.totalRegistered || 0) + '</b> &middot; tenants scanned: <b>' + (s.tenants_scanned || 0) + '</b> &middot; errors: <b>' + (s.totalErrors || 0) + '</b></p>' +
                        '<pre style="background:#0f172a;color:#e2e8f0;padding:.7rem;border-radius:6px;font-size:.74rem;max-height:55vh;overflow:auto;white-space:pre-wrap">' + JSON.stringify(out.results, null, 2) + '</pre>' +
                        '<div style="text-align:right;margin-top:.7rem"><button id="re-close" style="padding:.45rem .8rem;border-radius:8px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-weight:600">Close</button></div>';
        m.appendChild(card);
        document.body.appendChild(m);
        card.querySelector('#re-close').onclick = () => m.remove();
      } catch(e) { toast('Backfill failed: ' + e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '\ud83d\udd04 Backfill FB Registry'; }
    }}, '\ud83d\udd04 Backfill FB Registry')
  );
  view.appendChild(fbBackfillBar);
    view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

VIEWS.webhooks = async (view) => {
  /* WEBHOOK_LOGS_v2 — Toolbar with date range + filters; summary cards
   * above the table; S.No column added. */
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const prevFrom = (document.getElementById('wh-from') || {}).value || monthAgo;
  const prevTo   = (document.getElementById('wh-to')   || {}).value || today;

  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Cashfree Webhook Logs'),
    h('div', { style: { display: 'flex', gap: '.4rem', alignItems: 'center', flexWrap: 'wrap' } },
      h('label', { class: 'muted', style: { fontSize: '.8rem' } }, 'From'),
      h('input', { type: 'date', id: 'wh-from', value: prevFrom, onchange: () => navigate('webhooks') }),
      h('label', { class: 'muted', style: { fontSize: '.8rem' } }, 'To'),
      h('input', { type: 'date', id: 'wh-to', value: prevTo, onchange: () => navigate('webhooks') }),
      h('select', { id: 'wh-status', onchange: () => navigate('webhooks') },
        h('option', { value: '' }, 'All statuses'),
        h('option', { value: 'SUCCESS' }, 'SUCCESS'),
        h('option', { value: 'FAILED' }, 'FAILED'),
        h('option', { value: 'PENDING' }, 'PENDING'),
        h('option', { value: 'USER_DROPPED' }, 'USER_DROPPED'),
        h('option', { value: 'CANCELLED' }, 'CANCELLED')
      ),
      h('select', { id: 'wh-entity', onchange: () => navigate('webhooks') },
        h('option', { value: '' }, 'All entities'),
        h('option', { value: 'payment' }, 'payment'),
        h('option', { value: 'refund' }, 'refund'),
        h('option', { value: 'order' }, 'order')
      )
    )
  ));

  // Re-read after the toolbar renders (so first paint uses defaults)
  const fromEl = document.getElementById('wh-from');
  const toEl   = document.getElementById('wh-to');
  const filters = {};
  if (fromEl && fromEl.value) filters.from = fromEl.value;
  if (toEl   && toEl.value)   filters.to   = toEl.value + ' 23:59:59';
  const sStatus = document.getElementById('wh-status'); if (sStatus && sStatus.value) filters.status = sStatus.value;
  const sEntity = document.getElementById('wh-entity'); if (sEntity && sEntity.value) filters.entity_type = sEntity.value;

  /* Summary card row — drives off api_saas_webhookLogs_summary which
   * uses the same date+entity filters as the list (intentionally ignores
   * status filter so admins can compare success vs failed within the
   * same window). */
  const summaryFilters = { from: filters.from, to: filters.to, entity_type: filters.entity_type };
  let summary;
  try { summary = await api('api_saas_webhookLogs_summary', summaryFilters); }
  catch (e) { /* non-fatal: continue without summary */ summary = null; }
  if (summary) {
    const _inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
    const mk = (icon, label, count, amount, bg, fg) => h('div', { style: {
      flex: '1 1 180px', background: bg, color: fg, padding: '.7rem .9rem',
      borderRadius: '8px', border: '1px solid rgba(0,0,0,.05)'
    } },
      h('div', { style: { fontSize: '.75rem', fontWeight: 600, opacity: .85 } }, icon + ' ' + label),
      h('div', { style: { fontSize: '1.5rem', fontWeight: 700, marginTop: '.15rem' } }, _inr(amount)),
      h('div', { style: { fontSize: '.78rem', opacity: .85, marginTop: '.1rem' } }, String(count) + ' txn' + (Number(count) === 1 ? '' : 's'))
    );
    view.appendChild(h('div', { style: { display: 'flex', gap: '.6rem', flexWrap: 'wrap', marginBottom: '1rem' } },
      mk('✅', 'Success',  summary.success.count,  summary.success.amount,  '#dcfce7', '#166534'),
      mk('❌', 'Failed',   summary.failed.count,   summary.failed.amount,   '#fee2e2', '#991b1b'),
      mk('⏳', 'Pending',  summary.pending.count,  summary.pending.amount,  '#fef3c7', '#854d0e'),
      mk('📊', 'Total',    summary.total.count,    summary.total.amount,    '#e0e7ff', '#3730a3')
    ));
  }

  let list;
  try { list = await api('api_saas_webhookLogs_list', filters); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) {
    view.appendChild(h('div', { class: 'empty' }, 'No webhooks in this date range.'));
    return;
  }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', { style: { width: '40px' } }, 'S.No'),  /* WEBHOOK_LOGS_v2 */
      h('th', {}, 'When'),
      h('th', {}, 'Type'),
      h('th', {}, 'Entity'),
      h('th', {}, 'Status'),
      h('th', {}, 'Amount'),
      h('th', {}, 'Method'),
      h('th', {}, 'Order ID'),
      h('th', {}, 'Result'),
      h('th', {}, '')
    )),
    h('tbody', {}, ...list.map((w, idx) => h('tr', {},
      h('td', { class: 'muted', style: { textAlign: 'right' } }, String(idx + 1)),
      h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDateTime(w.created_at)),
      h('td', { style: { fontSize: '.78rem' } }, w.webhook_type || '—'),
      h('td', {}, w.entity_type || '—'),
      h('td', {}, h('span', { class: 'tag ' + _whStatusClass(w.status) }, w.status || '—')),
      h('td', {}, w.amount_inr ? fmtRupees(w.amount_inr) : '—'),
      h('td', { class: 'muted' }, w.payment_method || '—'),
      h('td', { class: 'muted', style: { fontFamily: 'monospace', fontSize: '.78rem' } }, w.order_id || '—'),
      h('td', { class: 'muted', style: { fontSize: '.78rem', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, w.result_message || '—'),
      h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn ghost xs', onclick: () => openWebhookDetail(w.id) }, 'View'))
    )))
  );
  view.appendChild(h('div', { class: 'card', style: { padding: 0, overflowX: 'auto' } }, tbl));
};

function _whStatusClass(s) {
  const u = String(s || '').toUpperCase();
  if (u === 'SUCCESS' || u === 'PAID') return 'ok';
  if (u === 'FAILED') return 'err';
  return 'warn';
}

// ---------- Errors ---------------------------------------------
// Central error log — every server throw, every uncaught client
// error/promise rejection, every webhook-side problem ends up here.
// Admin reads the list, clicks into a row to see stack/url/context,
// then marks it resolved (or resolves all of a fingerprint at once).
VIEWS.errors = async (view) => {
  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Errors'),
    h('div', {},
      h('select', { id: 'err-resolved', style: { marginRight: '.5rem' }, onchange: () => navigate('errors') },
        h('option', { value: '0' }, 'Open only'),
        h('option', { value: '1' }, 'Resolved only'),
        h('option', { value: 'all' }, 'All')
      ),
      h('select', { id: 'err-source', style: { marginRight: '.5rem' }, onchange: () => navigate('errors') },
        h('option', { value: '' }, 'Any source'),
        h('option', { value: 'server' }, 'server'),
        h('option', { value: 'client' }, 'client'),
        h('option', { value: 'process' }, 'process'),
        h('option', { value: 'signup' }, 'signup'),
        h('option', { value: 'webhook' }, 'webhook')
      ),
      h('select', { id: 'err-severity', style: { marginRight: '.5rem' }, onchange: () => navigate('errors') },
        h('option', { value: '' }, 'Any severity'),
        h('option', { value: 'error' }, 'error'),
        h('option', { value: 'warn' }, 'warn'),
        h('option', { value: 'fatal' }, 'fatal')
      ),
      h('input', { id: 'err-q', placeholder: 'Search…', style: { marginRight: '.5rem' },
        onkeydown: ev => { if (ev.key === 'Enter') navigate('errors'); } }),
      h('button', { class: 'btn ghost', onclick: () => navigate('errors') }, '🔎'),
      h('button', { class: 'btn ghost danger', style: { marginLeft: '.5rem' }, onclick: async () => {
        if (!confirm('Delete every resolved error row? This cannot be undone.')) return;
        try {
          const r = await api('api_saas_errorLogs_purgeResolved');
          toast('Purged ' + r.deleted + ' resolved rows');
          navigate('errors');
        } catch (e) { toast(e.message, 'err'); }
      } }, '🗑 Purge resolved')
    )
  ));

  let res;
  try {
    const filters = {
      resolved: (document.getElementById('err-resolved') || {}).value || '0',
      source:   (document.getElementById('err-source')   || {}).value || undefined,
      severity: (document.getElementById('err-severity') || {}).value || undefined,
      q:        (document.getElementById('err-q')        || {}).value || undefined
    };
    res = await api('api_saas_errorLogs_list', filters);
  } catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }

  // Header chips — quick overview before the operator dives in
  const c = res.counts || {};
  view.appendChild(h('div', { style: { display: 'flex', gap: '.6rem', flexWrap: 'wrap', marginBottom: '.75rem' } },
    h('span', { class: 'tag ' + (Number(c.open_count) > 0 ? 'err' : 'ok') }, '🛑 Open: ' + (c.open_count || 0)),
    h('span', { class: 'tag warn' }, '🕒 Last 24h: ' + (c.open_24h || 0)),
    h('span', { class: 'tag ok' }, '✅ Resolved: ' + (c.resolved_count || 0))
  ));

  const rows = res.rows || [];
  if (!rows.length) {
    view.appendChild(h('div', { class: 'empty' }, '🎉 No errors match your filter.'));
    return;
  }

  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Last seen'),
      h('th', {}, 'Source'),
      h('th', {}, 'Sev'),
      h('th', {}, 'Message'),
      h('th', {}, 'URL'),
      h('th', { style: { textAlign: 'right' } }, '×'),
      h('th', {}, '')
    )),
    h('tbody', {}, ...rows.map(r => h('tr', { class: Number(r.resolved) === 1 ? 'row-resolved' : '' },
      h('td', { class: 'muted', style: { whiteSpace: 'nowrap' } }, fmtDateTime(r.last_seen_at)),
      h('td', { style: { fontSize: '.78rem' } }, r.source || '—'),
      h('td', {}, h('span', { class: 'tag ' + _errSeverityClass(r.severity) }, r.severity || 'error')),
      h('td', { style: { maxWidth: '420px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.message }, r.message || '—'),
      h('td', { class: 'muted', style: { fontSize: '.78rem', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.url || '' }, r.url || '—'),
      h('td', { style: { textAlign: 'right', fontWeight: '600' } }, Number(r.occurrences) > 1 ? ('×' + r.occurrences) : ''),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        h('button', { class: 'btn ghost xs', onclick: () => openErrorDetail(r.id) }, 'View'),
        Number(r.resolved) === 1
          ? h('button', { class: 'btn ghost xs', style: { marginLeft: '.25rem' }, onclick: async () => {
              try { await api('api_saas_errorLogs_reopen', r.id); toast('Reopened'); navigate('errors'); }
              catch (e) { toast(e.message, 'err'); }
            } }, '↺ Reopen')
          : h('button', { class: 'btn xs', style: { marginLeft: '.25rem' }, onclick: async () => {
              const note = prompt('Resolution note (optional):', '');
              if (note === null) return; // user cancelled
              try { await api('api_saas_errorLogs_resolve', r.id, note); toast('Marked resolved'); navigate('errors'); }
              catch (e) { toast(e.message, 'err'); }
            } }, '✓ Resolve')
      )
    )))
  );
  view.appendChild(h('div', { class: 'card', style: { padding: 0, overflowX: 'auto' } }, tbl));

  // Restore filter selections after re-render
  setTimeout(() => {
    const elR = document.getElementById('err-resolved');
    if (elR) elR.value = (APP._lastErrFilter && APP._lastErrFilter.resolved) || '0';
    const elS = document.getElementById('err-source');
    if (elS) elS.value = (APP._lastErrFilter && APP._lastErrFilter.source) || '';
    const elSev = document.getElementById('err-severity');
    if (elSev) elSev.value = (APP._lastErrFilter && APP._lastErrFilter.severity) || '';
    const elQ = document.getElementById('err-q');
    if (elQ) elQ.value = (APP._lastErrFilter && APP._lastErrFilter.q) || '';
  }, 0);
};

function _errSeverityClass(s) {
  const u = String(s || '').toLowerCase();
  if (u === 'fatal') return 'err';
  if (u === 'warn')  return 'warn';
  return 'err';
}

async function openErrorDetail(id) {
  let row;
  try { row = await api('api_saas_errorLogs_get', id); }
  catch (e) { toast(e.message, 'err'); return; }
  if (!row) return;
  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal', style: { maxWidth: '780px' } });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, '🐞 Error detail · ' + (row.source || 'unknown')),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '.5rem 1rem', marginBottom: '1rem' } },
    _kv('Severity',   row.severity || 'error'),
    _kv('Source',     row.source || '—'),
    _kv('Occurrences', row.occurrences || 1),
    _kv('First seen', fmtDateTime(row.first_seen_at)),
    _kv('Last seen',  fmtDateTime(row.last_seen_at)),
    _kv('URL',        row.url || '—'),
    _kv('Method',     row.method || '—'),
    _kv('HTTP code',  row.status_code || '—'),
    _kv('Tenant',     row.tenant_slug || '—'),
    _kv('User',       row.user_email || '—'),
    _kv('Resolved',   Number(row.resolved) === 1 ? '✅ ' + fmtDateTime(row.resolved_at) : '— open')
  ));
  body.appendChild(h('h4', { style: { margin: '1rem 0 .25rem' } }, 'Message'));
  body.appendChild(h('pre', { style: { background: '#fee2e2', color: '#7f1d1d', padding: '.75rem', borderRadius: '6px', whiteSpace: 'pre-wrap', fontSize: '.85rem' } }, row.message || ''));
  if (row.stack) {
    body.appendChild(h('h4', { style: { margin: '1rem 0 .25rem' } }, 'Stack'));
    const pre = h('pre', { style: { background: '#0f172a', color: '#e2e8f0', padding: '1rem', borderRadius: '6px', overflow: 'auto', maxHeight: '300px', fontSize: '.75rem' } });
    pre.textContent = row.stack;
    body.appendChild(pre);
  }
  if (row.context) {
    body.appendChild(h('h4', { style: { margin: '1rem 0 .25rem' } }, 'Context'));
    const pre = h('pre', { style: { background: '#0f172a', color: '#e2e8f0', padding: '1rem', borderRadius: '6px', overflow: 'auto', maxHeight: '220px', fontSize: '.75rem' } });
    try { pre.textContent = JSON.stringify(typeof row.context === 'string' ? JSON.parse(row.context) : row.context, null, 2); }
    catch (_) { pre.textContent = String(row.context); }
    body.appendChild(pre);
  }
  if (row.resolution_note) {
    body.appendChild(h('h4', { style: { margin: '1rem 0 .25rem' } }, 'Resolution note'));
    body.appendChild(h('pre', { style: { background: '#dcfce7', color: '#14532d', padding: '.75rem', borderRadius: '6px', whiteSpace: 'pre-wrap', fontSize: '.85rem' } }, row.resolution_note));
  }
  // Action buttons in the modal foot
  const foot = h('div', { class: 'modal-foot', style: { display: 'flex', gap: '.5rem', justifyContent: 'flex-end' } });
  if (Number(row.resolved) === 1) {
    foot.appendChild(h('button', { class: 'btn ghost', onclick: async () => {
      try { await api('api_saas_errorLogs_reopen', row.id); toast('Reopened'); m.remove(); navigate('errors'); }
      catch (e) { toast(e.message, 'err'); }
    } }, '↺ Reopen'));
  } else {
    foot.appendChild(h('button', { class: 'btn primary', onclick: async () => {
      const note = prompt('Resolution note (optional):', '');
      if (note === null) return;
      try { await api('api_saas_errorLogs_resolve', row.id, note); toast('Marked resolved'); m.remove(); navigate('errors'); }
      catch (e) { toast(e.message, 'err'); }
    } }, '✓ Mark resolved'));
  }
  if (row.fingerprint) {
    foot.appendChild(h('button', { class: 'btn ghost', onclick: async () => {
      if (!confirm('Mark every OPEN error with the same fingerprint as resolved?')) return;
      try {
        const r = await api('api_saas_errorLogs_resolveAll', { fingerprint: row.fingerprint });
        toast('Resolved ' + r.marked + ' rows');
        m.remove(); navigate('errors');
      } catch (e) { toast(e.message, 'err'); }
    } }, '✓ Resolve all of this kind'));
  }
  foot.appendChild(h('button', { class: 'btn ghost danger', onclick: async () => {
    if (!confirm('Permanently delete this error row?')) return;
    try { await api('api_saas_errorLogs_delete', row.id); toast('Deleted'); m.remove(); navigate('errors'); }
    catch (e) { toast(e.message, 'err'); }
  } }, '🗑 Delete'));
  card.appendChild(body);
  card.appendChild(foot);
  m.appendChild(card);
  document.body.appendChild(m);
}

function fmtDateTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

async function openWebhookDetail(id) {
  let row;
  try { row = await api('api_saas_webhookLogs_get', id); }
  catch (e) { toast(e.message, 'err'); return; }
  if (!row) return;
  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal', style: { maxWidth: '720px' } });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, 'Webhook detail · ' + (row.webhook_type || 'unknown')),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const body = h('div', { class: 'modal-body' });
  body.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '.5rem 1rem', marginBottom: '1rem' } },
    _kv('Status', row.status),
    _kv('Entity', row.entity_type),
    _kv('Amount', row.amount_inr ? fmtRupees(row.amount_inr) : '—'),
    _kv('Method', row.payment_method || '—'),
    _kv('Order ID', row.order_id || '—'),
    _kv('CF Payment ID', row.cf_payment_id || '—'),
    _kv('Customer email', row.customer_email || '—'),
    _kv('Customer phone', row.customer_phone || '—'),
    _kv('Processed', row.processed === 1 ? '✅ yes' : '— no'),
    _kv('Received at', fmtDateTime(row.created_at)),
    _kv('Result', row.result_message || '—'),
    _kv('Tenant ID', row.tenant_id || '—')
  ));
  body.appendChild(h('h4', { style: { margin: '1rem 0 .5rem' } }, 'Raw payload'));
  const pre = h('pre', { style: { background: '#0f172a', color: '#e2e8f0', padding: '1rem', borderRadius: '6px', overflow: 'auto', maxHeight: '320px', fontSize: '.78rem' } });
  try { pre.textContent = JSON.stringify(typeof row.raw_payload === 'string' ? JSON.parse(row.raw_payload) : row.raw_payload, null, 2); }
  catch (_) { pre.textContent = String(row.raw_payload || ''); }
  body.appendChild(pre);
  card.appendChild(body);
  m.appendChild(card);
  document.body.appendChild(m);
}

function _kv(label, value) {
  return h('div', {},
    h('div', { class: 'muted', style: { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
    h('div', { style: { fontSize: '.92rem', fontWeight: '500', wordBreak: 'break-all' } }, String(value == null ? '' : value))
  );
}

VIEWS.crashes = async (view) => {
  // App-crash dashboard. Reads from the same control.error_logs table
  // the Errors page uses, but pre-filters to severity in
  // (fatal, error) and groups by fingerprint so we get a real
  // "is the app crashing right now?" signal rather than an event firehose.

  view.appendChild(h('h2', {}, '🚨 App Crash Report'));

  // Controls strip
  const hoursSel = h('select', { id: 'crash-hours', style: { marginRight: '.5rem' }, onchange: () => navigate('crashes') },
    h('option', { value: '1' },   'Last 1 hour'),
    h('option', { value: '24' },  'Last 24 hours'),
    h('option', { value: '168' }, 'Last 7 days'),
    h('option', { value: 'all' }, 'All time')
  );
  const sevSel = h('select', { id: 'crash-sev', style: { marginRight: '.5rem' }, onchange: () => navigate('crashes') },
    h('option', { value: 'fatal_and_error' }, 'Fatal + 5xx errors'),
    h('option', { value: 'fatal' },           'Fatal only (process crashes)'),
    h('option', { value: 'error' },           '5xx errors only')
  );
  const params  = new URLSearchParams(location.hash.split('?')[1] || '');
  hoursSel.value = params.get('hours') || '24';
  sevSel.value   = params.get('sev')   || 'fatal_and_error';
  view.appendChild(h('div', { class: 'toolbar', style: { marginBottom: '1rem' } },
    hoursSel, sevSel,
    h('button', { class: 'btn ghost', onclick: () => navigate('crashes') }, '↻ Refresh'),
    h('span', { style: { flex: 1 } }),
    h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm('Mark every crash (severity=fatal) as resolved?')) return;
      try {
        const r = await api('api_saas_errorLogs_resolveAll', { severity: 'fatal' });
        toast(`Marked ${r.affected || 0} resolved`);
        navigate('crashes');
      } catch (e) { toast(e.message, 'err'); }
    } }, 'Mark all crashes resolved')
  ));

  let res;
  try {
    res = await api('api_saas_crashReport_summary', {
      hours:    hoursSel.value === 'all' ? 'all' : Number(hoursSel.value || 24),
      severity: sevSel.value
    });
  } catch (e) {
    view.appendChild(h('div', { class: 'error-box' }, 'Failed to load crash report: ' + e.message));
    return;
  }

  // KPI cards
  const minsAgoLabel = res.counts.last_crash_minutes_ago == null
    ? '—'
    : (res.counts.last_crash_minutes_ago < 60
        ? res.counts.last_crash_minutes_ago + ' min ago'
        : Math.round(res.counts.last_crash_minutes_ago / 60) + ' hr ago');
  const kpiGrid = h('div', { class: 'kpi-grid', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '.8rem', marginBottom: '1.4rem' } });
  const kpi = (title, value, sub) => h('div', { class: 'card kpi', style: { padding: '1rem' } },
    h('div', { class: 'muted', style: { fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.05em' } }, title),
    h('div', { style: { fontSize: '1.6rem', fontWeight: 700, marginTop: '.25rem' } }, String(value)),
    sub ? h('div', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.15rem' } }, sub) : null
  );
  kpiGrid.appendChild(kpi('Fatal in window',   res.counts.fatal_in_window,   'Process-level crashes'));
  kpiGrid.appendChild(kpi('5xx errors',        res.counts.error_in_window,   'Server-side request errors'));
  kpiGrid.appendChild(kpi('Unresolved total',  res.counts.unresolved_total,  'Across all time'));
  kpiGrid.appendChild(kpi('Last crash',        minsAgoLabel,                  res.counts.last_crash_at ? new Date(res.counts.last_crash_at).toLocaleString() : 'No fatal events on record'));
  view.appendChild(kpiGrid);

  // Top crashes table (deduped by fingerprint)
  view.appendChild(h('h3', { style: { marginTop: '1.5rem' } }, 'Top crashes — by occurrence count'));
  if (!res.top.length) {
    view.appendChild(h('div', { class: 'empty', style: { padding: '1rem 0', color: '#64748b' } }, '🎉 No crashes in this window.'));
  } else {
    const tbl = h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '#'),
        h('th', {}, 'Severity'),
        h('th', {}, 'Source'),
        h('th', {}, 'Message'),
        h('th', {}, 'First seen'),
        h('th', {}, 'Last seen'),
        h('th', { style: { textAlign: 'right' } }, 'Count')
      )),
      h('tbody', {}, ...res.top.map(t =>
        h('tr', { style: { cursor: 'pointer' }, onclick: () => navigate('errors?id=' + t.id) },
          h('td', {}, '#' + t.id),
          h('td', {},
            h('span', { class: 'badge ' + (t.severity === 'fatal' ? 'err' : 'warn') }, t.severity)),
          h('td', {}, t.source || '—'),
          h('td', { style: { maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            t.message + (t.sample_stack_first_line ? '\n  ' + t.sample_stack_first_line : '')),
          h('td', { class: 'muted', style: { fontSize: '.85rem' } }, new Date(t.first_seen_at).toLocaleString()),
          h('td', { class: 'muted', style: { fontSize: '.85rem' } }, new Date(t.last_seen_at).toLocaleString()),
          h('td', { style: { textAlign: 'right', fontWeight: 600 } }, String(t.occurrences))
        )))
    );
    view.appendChild(tbl);
  }

  // Recent (raw, non-deduped)
  view.appendChild(h('h3', { style: { marginTop: '1.5rem' } }, 'Recent — last 20 events'));
  if (!res.recent.length) {
    view.appendChild(h('div', { class: 'empty', style: { padding: '1rem 0', color: '#64748b' } }, 'Nothing recent.'));
  } else {
    const tbl2 = h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'When'),
        h('th', {}, 'Severity'),
        h('th', {}, 'Source'),
        h('th', {}, 'Tenant'),
        h('th', {}, 'Status'),
        h('th', {}, 'Message')
      )),
      h('tbody', {}, ...res.recent.map(r =>
        h('tr', { style: { cursor: 'pointer' }, onclick: () => navigate('errors?id=' + r.id) },
          h('td', { class: 'muted', style: { fontSize: '.85rem' } }, new Date(r.last_seen_at).toLocaleString()),
          h('td', {},
            h('span', { class: 'badge ' + (r.severity === 'fatal' ? 'err' : 'warn') }, r.severity)),
          h('td', {}, r.source || '—'),
          h('td', {}, r.tenant_slug || '—'),
          h('td', {}, r.status_code != null ? String(r.status_code) : '—'),
          h('td', { style: { maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.message)
        )))
    );
    view.appendChild(tbl2);
  }
};

VIEWS.announcements = async (view) => {
  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Updates'),
    h('button', { class: 'btn', onclick: () => editAnnouncement({}) }, '+ New update')
  ));
  let list;
  try { list = await api('api_saas_announcements_listAdmin'); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) { view.appendChild(h('div', { class: 'empty' }, 'No updates posted.')); return; }
  list.forEach(a => {
    view.appendChild(h('div', { class: 'card' },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' } },
        h('div', {},
          h('h3', {}, a.title, ' ', h('span', { class: 'tag ' + (a.level === 'critical' ? 'err' : a.level === 'warn' ? 'warn' : 'info') }, a.level)),
          h('div', { class: 'muted', style: { fontSize: '.82rem' } }, fmtDate(a.starts_at) + (a.ends_at ? ' → ' + fmtDate(a.ends_at) : ''))
        ),
        h('div', {},
          h('button', { class: 'btn ghost xs', onclick: () => editAnnouncement(a) }, 'Edit'),
          ' ',
          h('button', { class: 'btn danger xs', onclick: async () => { if (confirm('Delete this update?')) { await api('api_saas_announcements_delete', a.id); navigate('announcements'); } } }, 'Delete')
        )
      ),
      h('div', { style: { marginTop: '.5rem' }, html: a.body }, a.body)
    ));
  });
};

function editAnnouncement(a) {
  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal' });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, a.id ? 'Edit update' : 'New update'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd);
    if (a.id) payload.id = a.id;
    payload.is_active = 1;
    try { await api('api_saas_announcements_save', payload); toast('Saved'); m.remove(); navigate('announcements'); }
    catch (e) { toast(e.message, 'err'); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'Title *'), h('input', { name: 'title', required: true, value: a.title || '' })),
    h('div', { class: 'field' }, h('label', {}, 'Body *'), h('textarea', { name: 'body', required: true, rows: 4 }, a.body || '')),
    h('div', { class: 'field' }, h('label', {}, 'Level'),
      h('select', { name: 'level' },
        ...['info', 'warn', 'critical', 'new_feature'].map(v => h('option', { value: v, selected: a.level === v ? true : null }, v)))),
    h('button', { type: 'submit', class: 'btn' }, 'Save')
  );
  card.appendChild(form);
  m.appendChild(card);
  document.body.appendChild(m);
}

VIEWS.requirements = async (view) => {
  view.appendChild(h('h1', {}, 'Custom Requirements'));
  let list;
  try { list = await api('api_saas_cr_listAll', {}); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) { view.appendChild(h('div', { class: 'empty' }, 'No tickets yet.')); return; }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Title'), h('th', {}, 'Org'), h('th', {}, 'Status'),
      h('th', {}, 'Quote'), h('th', {}, 'Created')
    )),
    h('tbody', {}, ...list.map(c => h('tr', {},
      h('td', {}, h('b', {}, c.title)),
      h('td', { class: 'muted' }, c.org_name || '—'),
      h('td', {}, h('span', { class: 'tag info' }, c.status)),
      h('td', {}, c.quote_inr ? fmtRupees(c.quote_inr) : '—'),
      h('td', { class: 'muted' }, fmtDate(c.created_at))
    )))
  );
  // FB_REGISTRY_BACKFILL_v1 — one-click sync all tenant FB pages into central registry
  const fbBackfillBar = h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.6rem', padding: '.5rem .7rem', background: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }},
    h('span', { style: { fontSize: '.85rem' }}, '\ud83d\udce1 FB Lead Ads central registry:'),
    h('span', { class: 'muted', style: { fontSize: '.78rem', flex: 1 }},
      'Push every tenant\'s connected Facebook pages into fb_leads_connections.json on smartcrmsolution.com so the central webhook routes leads correctly. Safe to run anytime.'),
    h('button', { class: 'btn primary', style: { whiteSpace: 'nowrap' }, onclick: async (ev) => {
      const btn = ev.target;
      btn.disabled = true; btn.textContent = '\u23f3 Backfilling...';
      try {
        const out = await api('api_saas_fb_backfillRegistry', {});
        const s = out.summary || {};
        toast('\u2714 Backfill done: ' + (s.totalRegistered || 0) + ' pages registered across ' + (s.tenants_scanned || 0) + ' tenants');
        // Show results in a quick modal
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        m.onclick = (e) => { if (e.target === m) m.remove(); };
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:12px;max-width:720px;width:92%;max-height:80vh;overflow:auto;padding:1.2rem 1.4rem;';
        card.innerHTML = '<h3 style="margin:0 0 .4rem">\u{1f4e1} FB Registry backfill results</h3>' +
                        '<p class="muted" style="font-size:.85rem;margin-bottom:.6rem">Pages registered: <b>' + (s.totalRegistered || 0) + '</b> &middot; tenants scanned: <b>' + (s.tenants_scanned || 0) + '</b> &middot; errors: <b>' + (s.totalErrors || 0) + '</b></p>' +
                        '<pre style="background:#0f172a;color:#e2e8f0;padding:.7rem;border-radius:6px;font-size:.74rem;max-height:55vh;overflow:auto;white-space:pre-wrap">' + JSON.stringify(out.results, null, 2) + '</pre>' +
                        '<div style="text-align:right;margin-top:.7rem"><button id="re-close" style="padding:.45rem .8rem;border-radius:8px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-weight:600">Close</button></div>';
        m.appendChild(card);
        document.body.appendChild(m);
        card.querySelector('#re-close').onclick = () => m.remove();
      } catch(e) { toast('Backfill failed: ' + e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '\ud83d\udd04 Backfill FB Registry'; }
    }}, '\ud83d\udd04 Backfill FB Registry')
  );
  view.appendChild(fbBackfillBar);
    view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

VIEWS.admins = async (view) => {
  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Super Assistants'),
    h('button', { class: 'btn', onclick: () => editAdmin({}) }, '+ New admin')
  ));
  let list;
  try { list = await api('api_saas_admin_list'); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'),
      h('th', {}, 'Status'), h('th', {}, 'Last login'), h('th', {}, '')
    )),
    h('tbody', {}, ...list.map(a => h('tr', {},
      h('td', {}, h('b', {}, a.name)),
      h('td', { class: 'muted' }, a.email),
      h('td', {}, h('span', { class: 'tag info' }, a.role)),
      h('td', {}, a.is_active === 1 ? h('span', { class: 'tag ok' }, 'Active') : h('span', { class: 'tag err' }, 'Inactive')),
      h('td', { class: 'muted' }, fmtDate(a.last_login_at) || 'never'),
      h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn ghost xs', onclick: () => editAdmin(a) }, 'Edit'))
    )))
  );
  // FB_REGISTRY_BACKFILL_v1 — one-click sync all tenant FB pages into central registry
  const fbBackfillBar = h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', marginBottom: '.6rem', padding: '.5rem .7rem', background: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a' }},
    h('span', { style: { fontSize: '.85rem' }}, '\ud83d\udce1 FB Lead Ads central registry:'),
    h('span', { class: 'muted', style: { fontSize: '.78rem', flex: 1 }},
      'Push every tenant\'s connected Facebook pages into fb_leads_connections.json on smartcrmsolution.com so the central webhook routes leads correctly. Safe to run anytime.'),
    h('button', { class: 'btn primary', style: { whiteSpace: 'nowrap' }, onclick: async (ev) => {
      const btn = ev.target;
      btn.disabled = true; btn.textContent = '\u23f3 Backfilling...';
      try {
        const out = await api('api_saas_fb_backfillRegistry', {});
        const s = out.summary || {};
        toast('\u2714 Backfill done: ' + (s.totalRegistered || 0) + ' pages registered across ' + (s.tenants_scanned || 0) + ' tenants');
        // Show results in a quick modal
        const m = document.createElement('div');
        m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
        m.onclick = (e) => { if (e.target === m) m.remove(); };
        const card = document.createElement('div');
        card.style.cssText = 'background:#fff;border-radius:12px;max-width:720px;width:92%;max-height:80vh;overflow:auto;padding:1.2rem 1.4rem;';
        card.innerHTML = '<h3 style="margin:0 0 .4rem">\u{1f4e1} FB Registry backfill results</h3>' +
                        '<p class="muted" style="font-size:.85rem;margin-bottom:.6rem">Pages registered: <b>' + (s.totalRegistered || 0) + '</b> &middot; tenants scanned: <b>' + (s.tenants_scanned || 0) + '</b> &middot; errors: <b>' + (s.totalErrors || 0) + '</b></p>' +
                        '<pre style="background:#0f172a;color:#e2e8f0;padding:.7rem;border-radius:6px;font-size:.74rem;max-height:55vh;overflow:auto;white-space:pre-wrap">' + JSON.stringify(out.results, null, 2) + '</pre>' +
                        '<div style="text-align:right;margin-top:.7rem"><button id="re-close" style="padding:.45rem .8rem;border-radius:8px;border:none;background:#6366f1;color:#fff;cursor:pointer;font-weight:600">Close</button></div>';
        m.appendChild(card);
        document.body.appendChild(m);
        card.querySelector('#re-close').onclick = () => m.remove();
      } catch(e) { toast('Backfill failed: ' + e.message, 'err'); }
      finally { btn.disabled = false; btn.textContent = '\ud83d\udd04 Backfill FB Registry'; }
    }}, '\ud83d\udd04 Backfill FB Registry')
  );
  view.appendChild(fbBackfillBar);
    view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

function editAdmin(a) {
  const m = h('div', { class: 'modal-bd' });   // Backdrop click does NOT close — must use X. Prevents accidental discards.
  const card = h('div', { class: 'modal' });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, a.id ? 'Edit admin' : 'New admin'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd);
    if (a.id) payload.id = a.id;
    payload.is_active = fd.get('is_active') ? 1 : 0;
    try { await api('api_saas_admin_save', payload); toast('Saved'); m.remove(); navigate('admins'); }
    catch (e) { toast(e.message, 'err'); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'Name *'), h('input', { name: 'name', required: true, value: a.name || '' })),
    h('div', { class: 'field' }, h('label', {}, 'Email *'), h('input', { name: 'email', type: 'email', required: !a.id, value: a.email || '' })),
    h('div', { class: 'field' }, h('label', {}, 'Password ' + (a.id ? '(leave blank to keep current)' : '*')),
      h('input', { name: 'password', type: 'password', required: !a.id })),
    h('div', { class: 'field' }, h('label', {}, 'Role'),
      h('select', { name: 'role' }, ...['admin', 'assistant', 'viewer'].map(v => h('option', { value: v, selected: a.role === v ? true : null }, v)))),
    h('label', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } },
      h('input', { type: 'checkbox', name: 'is_active', checked: a.is_active !== 0 ? true : null, style: { width: 'auto' } }),
      h('span', {}, 'Active')),
    h('button', { type: 'submit', class: 'btn', style: { marginTop: '1rem' } }, 'Save')
  );
  card.appendChild(form);
  m.appendChild(card);
  document.body.appendChild(m);
}

VIEWS.settings = async (view) => {
  view.appendChild(h('h1', {}, 'Settings'));
  let list;
  try { list = await api('api_saas_settings_get'); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  const groups = {};
  list.forEach(s => { (groups[s.group] = groups[s.group] || []).push(s); });
  const titles = {
    payments:  '💳 Payments',
    email:     '✉️ Email',
    lifecycle: '🔄 Lifecycle',
    brand:     '🎨 Brand'
  };
  const form = h('form', { onsubmit: async ev => {
    ev.preventDefault();
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd);
    try { await api('api_saas_settings_save', payload); toast('Saved'); navigate('settings'); }
    catch (e) { toast(e.message, 'err'); }
  } });

  Object.entries(groups).forEach(([g, items]) => {
    const card = h('div', { class: 'card' }, h('h2', {}, titles[g] || g));
    items.forEach(s => {
      const labelEl = h('label', {}, s.label + (s.is_set ? ' ✓' : ''));
      let inputEl;
      const baseProps = { name: s.key };
      if (s.kind === 'select' && Array.isArray(s.options)) {
        inputEl = h('select', baseProps,
          ...s.options.map(opt => h('option', { value: opt, selected: s.value === opt ? true : null }, opt))
        );
      } else if (s.kind === 'textarea') {
        inputEl = h('textarea', Object.assign({}, baseProps, { rows: 3 }), s.value || '');
      } else if (s.kind === 'number') {
        inputEl = h('input', Object.assign({}, baseProps, {
          type: 'number',
          value: s.value || '',
          placeholder: s.mask ? (s.is_set ? '••• (set — leave blank to keep)' : '') : ''
        }));
      } else if (s.mask) {
        inputEl = h('input', Object.assign({}, baseProps, {
          type: 'password',
          value: '',
          placeholder: s.is_set ? '••• (set — leave blank to keep)' : 'Not set'
        }));
      } else {
        inputEl = h('input', Object.assign({}, baseProps, { value: s.value || '' }));
      }
      const field = h('div', { class: 'field' }, labelEl, inputEl);
      if (s.hint) {
        field.appendChild(h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.25rem' } }, s.hint));
      }
      card.appendChild(field);
    });

    // Email card gets a "Send test email" button right inside it for fast iteration
    if (g === 'email') {
      card.appendChild(h('div', { style: { marginTop: '.75rem', paddingTop: '.75rem', borderTop: '1px solid #e2e8f0' } },
        h('button', {
          class: 'btn ghost', type: 'button',
          onclick: async () => {
            try { const r = await api('api_saas_settings_testEmail', {}); toast('Test email sent to ' + r.sent_to); }
            catch (e) { toast(e.message, 'err'); }
          }
        }, '✉️ Send test email to me')
      ));
    }
    form.appendChild(card);
  });

  form.appendChild(h('button', { class: 'btn', type: 'submit', style: { marginTop: '1rem' } }, '💾 Save settings'));
  view.appendChild(form);

  // ============================================================
  // AI / Gemini settings card — separate form because it uses its
  // own backend (control.ai_settings) + has a "Test connection"
  // button that should run independently of the main save.
  // ============================================================
  let aiCfg;
  try { aiCfg = await api('api_saas_ai_settings_get'); }
  catch (e) { view.appendChild(h('div', { class: 'error-box', style: { marginTop: '1rem' } }, '⚠️ AI settings not loaded: ' + e.message)); return; }

  const aiCard = h('div', { class: 'card', style: { marginTop: '1.5rem' } },
    h('h2', {}, '🤖 WhatsApp AI Bot — Gemini'),
    h('p', { class: 'muted', style: { marginTop: 0, fontSize: '.85rem' } },
      'Stored in the control DB, encrypted at rest. Tenants never see this key — they consume Gemini via your account and you bill them in INR with markup.')
  );

  const sourceTag = aiCfg.key_source === 'env'
    ? ' (using GEMINI_API_KEY env var — same as call AI)'
    : aiCfg.key_source === 'database' ? ' (saved here)' : '';
  const aiKeyInput = h('input', {
    type: 'password', name: 'gemini_api_key', autocomplete: 'off',
    placeholder: aiCfg.key_set
      ? ('Active: ' + (aiCfg.key_preview || '\u2022\u2022\u2022\u2022') + sourceTag + ' \u2014 leave blank to keep')
      : 'Paste Gemini API key from Google AI Studio',
    style: { width: '100%' }
  });
  aiCard.appendChild(h('div', { class: 'field' },
    h('label', {}, 'Gemini API key' + (aiCfg.key_set ? ' \u2713' : '')),
    aiKeyInput,
    h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.25rem' } },
      aiCfg.key_source === 'env'
        ? '\u2705 Using your existing GEMINI_API_KEY environment variable (same one the call-recording AI uses). Paste a key here to override it.'
        : (aiCfg.key_source === 'database'
          ? 'Stored encrypted in control DB. Paste a new key to rotate.'
          : 'Get a key at aistudio.google.com \u2192 API keys, OR set GEMINI_API_KEY in Railway env vars.'))
  ));

  const modelSel = h('select', { name: 'gemini_default_model' },
    ...aiCfg.suggested_models.map(m => h('option', { value: m, selected: m === aiCfg.gemini_default_model ? 'selected' : null }, m)));
  aiCard.appendChild(h('div', { class: 'field' }, h('label', {}, 'Default model'), modelSel,
    h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.25rem' } }, 'Used for every tenant unless they override on their AI Bot Settings page.')));

  const priceInput  = h('input', { name: 'price_input_usd_per_m',  type: 'number', step: '0.0001', value: aiCfg.price_input_usd_per_m });
  const priceOutput = h('input', { name: 'price_output_usd_per_m', type: 'number', step: '0.0001', value: aiCfg.price_output_usd_per_m });
  const exch        = h('input', { name: 'exchange_rate_inr',      type: 'number', step: '0.01',   value: aiCfg.exchange_rate_inr });
  const markup      = h('input', { name: 'markup_pct',             type: 'number', step: '0.01',   value: aiCfg.markup_pct });
  aiCard.appendChild(h('div', { class: 'field' }, h('label', {}, 'Input price (USD per 1M tokens)'),  priceInput));
  aiCard.appendChild(h('div', { class: 'field' }, h('label', {}, 'Output price (USD per 1M tokens)'), priceOutput));
  aiCard.appendChild(h('div', { class: 'field' }, h('label', {}, 'Exchange rate (USD → INR)'),    exch));
  aiCard.appendChild(h('div', { class: 'field' }, h('label', {}, 'Markup % (added on top of real INR cost)'), markup,
    h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.25rem' } }, 'Tenants see (real INR) × (1 + markup/100). 30 = 30% margin.')));

  const activeChk = h('input', { name: 'is_active', type: 'checkbox', checked: aiCfg.is_active ? 'checked' : null });
  aiCard.appendChild(h('div', { class: 'field' }, h('label', {}, activeChk, ' Globally enabled (tenants can use the bot)'),
    h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.25rem' } }, 'Master kill-switch. Tenants still need to flip ON their own bot in their AI Bot tab.')));

  const aiActions = h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.75rem' } },
    h('button', { class: 'btn', type: 'button', onclick: async () => {
      const payload = {
        gemini_api_key:         aiKeyInput.value,
        gemini_default_model:   modelSel.value,
        price_input_usd_per_m:  priceInput.value,
        price_output_usd_per_m: priceOutput.value,
        exchange_rate_inr:      exch.value,
        markup_pct:             markup.value,
        is_active:              activeChk.checked
      };
      try { await api('api_saas_ai_settings_save', payload); toast('AI settings saved'); navigate('settings'); }
      catch (e) { toast(e.message, 'err'); }
    } }, '💾 Save AI settings'),
    h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
      try {
        const r = await api('api_saas_ai_settings_test');
        if (r.ok) toast('✅ Gemini key works — ' + r.models_visible + ' models visible');
        else toast('❌ ' + (r.error || 'failed'), 'err');
      } catch (e) { toast(e.message, 'err'); }
    } }, '🔌 Test connection')
  );
  aiCard.appendChild(aiActions);
  view.appendChild(aiCard);
};

// ============================================================
// AI Costing — per-tenant breakdown of real $ cost vs marked-up ₹
// ============================================================
VIEWS.ai_costing = async (view) => {
  view.appendChild(h('h1', {}, '🤖 AI Costing'));

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 8) + '01';
  const fromInp   = h('input', { type: 'date', value: monthStart });
  const toInp     = h('input', { type: 'date', value: today });
  const tenantInp = h('input', { type: 'text', placeholder: 'Filter by tenant slug (blank = all)', style: { minWidth: '14rem' } });
  const refreshBtn= h('button', { class: 'btn ghost' }, '↻ Refresh');
  const backfillBtn = h('button', { class: 'btn ghost', style: { marginLeft: '.5rem' },
    title: 'Match orphan ai_usage_log rows (with empty tenant_slug) to the right tenant by phone + timestamp. Cleans up rows from before the multi-tenant scoping fix.' },
    '🔧 Backfill orphans');
  backfillBtn.onclick = async () => {
    if (!confirm('Walk every orphan ai_usage_log row (no tenant_slug) and try to attribute it by matching phone + timestamp against each tenant\'s ai_chat_log. Idempotent — safe to re-run.')) return;
    const orig = backfillBtn.textContent;
    backfillBtn.textContent = '⏳ Working…'; backfillBtn.disabled = true;
    try {
      const r = await api('api_saas_backfill_aiusage_orphans');
      alert('Done: ' + r.attributed + ' attributed, ' + r.unmatched + ' unmatched (of ' + r.total_orphans + ' orphans)\n\nBy tenant: ' + JSON.stringify(r.by_tenant, null, 2));
      reload();
    } catch (e) { alert('Backfill failed: ' + e.message); }
    finally { backfillBtn.textContent = orig; backfillBtn.disabled = false; }
  };
  view.appendChild(h('div', { class: 'card', style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' } },
    h('label', {}, 'From '), fromInp,
    h('label', {}, ' To '),  toInp,
    tenantInp, refreshBtn, backfillBtn));

  const totalsCard = h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Loading…'));
  const tableCard  = h('div', { class: 'card' });
  view.appendChild(totalsCard);
  view.appendChild(tableCard);

  function kpi(label, value, hint) {
    return h('div', { style: { padding: '.6rem .8rem', background: '#f1f5f9', borderRadius: '8px' } },
      h('div', { class: 'muted', style: { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
      h('div', { style: { fontSize: '1.2rem', fontWeight: '700' } }, value),
      hint ? h('div', { class: 'muted', style: { fontSize: '.72rem' } }, hint) : null
    );
  }

  async function reload() {
    totalsCard.innerHTML = ''; tableCard.innerHTML = '';
    totalsCard.appendChild(h('div', { class: 'muted' }, 'Loading…'));
    let data;
    try {
      data = await api('api_saas_ai_costing_summary', {
        from: fromInp.value, to: toInp.value,
        tenant_slug: tenantInp.value.trim() || null
      });
    } catch (e) {
      totalsCard.innerHTML = '';
      totalsCard.appendChild(h('div', { class: 'error-box' }, e.message));
      return;
    }
    const t = data.totals;
    totalsCard.innerHTML = '';
    totalsCard.appendChild(h('h2', { style: { marginTop: 0 } }, 'Range: ' + data.range.from + ' → ' + data.range.to));
    const kpis = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.75rem' } });
    kpis.appendChild(kpi('Tenants billed', t.tenants_billed));
    kpis.appendChild(kpi('Calls', t.calls.toLocaleString('en-IN')));
    kpis.appendChild(kpi('Tokens in / out', t.input_tokens.toLocaleString('en-IN') + ' / ' + t.output_tokens.toLocaleString('en-IN')));
    kpis.appendChild(kpi('Real $ cost', '$' + t.cost_usd.toFixed(4)));
    kpis.appendChild(kpi('Real ₹ cost', '₹' + t.cost_inr_real.toLocaleString('en-IN')));
    kpis.appendChild(kpi('Billed to tenants ₹', '₹' + t.cost_inr_billed.toLocaleString('en-IN')));
    kpis.appendChild(kpi('Your margin', '₹' + t.margin_inr.toLocaleString('en-IN'), (t.margin_pct == null ? '' : t.margin_pct + '%')));
    if (t.failed_calls) kpis.appendChild(kpi('Failed (not billed)', t.failed_calls));
    totalsCard.appendChild(kpis);

    const rows = data.per_tenant.length ? data.per_tenant : [{ tenant_slug: '— no usage in range —', calls: 0, input_tokens: 0, output_tokens: 0 }];
    const tbl = h('table', { class: 'data-table', style: { width: '100%' } },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Tenant'),
        h('th', {}, 'Calls'),
        h('th', { title: 'Calls that errored — bad Gemini key, quota, etc. Tenant attempted to use AI but got nothing back.' }, 'Failed'),
        h('th', {}, 'Tokens'),
        h('th', {}, 'Real $'),
        h('th', {}, 'Real ₹'),
        h('th', {}, 'Billed ₹'),
        h('th', {}, 'Margin ₹'),
        h('th', {}, 'Last call'),
        h('th', { title: 'Most recent error message for this tenant in the range' }, 'Last error')
      )),
      h('tbody', {}, ...rows.map(r => h('tr', {
          style: (Number(r.calls || 0) === 0 && Number(r.failed_calls || 0) > 0)
            ? { background: '#fff3f3' } : {}
        },
        h('td', {}, r.tenant_slug),
        h('td', {}, (r.calls || 0).toLocaleString('en-IN')),
        h('td', { style: { color: (r.failed_calls > 0 ? '#dc2626' : '#94a3b8'), fontWeight: r.failed_calls > 0 ? '600' : '400' } },
          (r.failed_calls || 0).toLocaleString('en-IN')),
        h('td', {}, ((r.input_tokens || 0) + (r.output_tokens || 0)).toLocaleString('en-IN')),
        h('td', {}, '$' + (r.cost_usd || 0).toFixed(6)),
        h('td', {}, '₹' + (r.cost_inr_real || 0).toLocaleString('en-IN')),
        h('td', {}, '₹' + (r.cost_inr_billed || 0).toLocaleString('en-IN')),
        h('td', {}, '₹' + (r.margin_inr || 0).toLocaleString('en-IN')),
        h('td', { class: 'muted' }, r.last_call_at ? new Date(r.last_call_at).toLocaleString() : '—'),
        h('td', { class: 'muted', style: { fontSize: '.78rem', maxWidth: '20rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.last_error || '' },
          r.last_error ? r.last_error.slice(0, 60) + (r.last_error.length > 60 ? '…' : '') : '—')
      )))
    );
    tableCard.appendChild(h('h2', { style: { marginTop: 0 } }, 'Per-tenant breakdown'));
    tableCard.appendChild(tbl);
  }

  refreshBtn.addEventListener('click', reload);
  fromInp.addEventListener('change', reload);
  toInp.addEventListener('change', reload);
  tenantInp.addEventListener('change', reload);
  reload();
};


// ---------- Router ---------------------------------------------
// Render guard: VIEW fns are async, so two route() calls can race.
// Tag every render with a monotonically increasing token.
let _routeToken = 0;

async function route() {
  if (!APP.token) return renderLogin();
  if (!APP.user) {
    try { APP.user = await api('api_saas_admin_me'); }
    catch (_) { APP.token = ''; localStorage.removeItem('saas_admin_token'); return renderLogin(); }
  }
  const myToken = ++_routeToken;
  if (!$('#nav')) renderShell();
  // Allow underscores in view ids so 'ai_costing' resolves correctly.
  const id = (location.hash.match(/^#\/([a-z_]+)/) || [])[1] || 'dashboard';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === id));
  const view = $('#view'); view.innerHTML = '';
  const fn = VIEWS[id];
  if (!fn) { view.appendChild(h('div', { class: 'empty' }, 'Unknown view: ' + id)); return; }
  try {
    await fn(view);
    if (myToken !== _routeToken) view.innerHTML = '';
  } catch (e) {
    if (myToken === _routeToken) {
      view.appendChild(h('div', { class: 'error-box' }, e.message));
    }
  }
}



// ============================================================
// TENANT_SIGNUP_APPROVAL_v1 — Signup Requests view
// Public form posts to /api/saas-public-signup-request. Super-admin
// reviews here, edits if needed, then Approve to provision the
// tenant or Reject with a reason. Approval surfaces the temp
// password so the operator can WhatsApp/email it to the customer.
// ============================================================
VIEWS.signup_requests = async (view) => {
  view.appendChild(h('h1', {}, '🆕 Signup Requests'));

  // public-form URL helper line
  const formUrl = location.origin + '/saas/signup-request.html';
  const urlRow = h('div', {
    style: {
      background: '#eef2ff', border: '1px solid #c7d2fe',
      padding: '.75rem 1rem', borderRadius: '8px',
      marginBottom: '1rem', display: 'flex', gap: '.75rem',
      alignItems: 'center', flexWrap: 'wrap', fontSize: '.9rem'
    }
  },
    h('span', {}, '📋 Share this public form URL with assignees:'),
    h('code', { style: { background: '#fff', padding: '.2rem .5rem', borderRadius: '4px' } }, formUrl),
    h('button', {
      class: 'btn sm', onclick: () => {
        navigator.clipboard.writeText(formUrl);
        toast('Copied', 'ok');
      }
    }, 'Copy'),
    h('a', { href: formUrl, target: '_blank', class: 'btn sm ghost' }, 'Open ↗')
  );
  view.appendChild(urlRow);

  // Filter strip
  const _filterState = { status: 'pending', q: '' };
  const reload = async () => {
    const list = await api('api_saas_sr_list', _filterState);
    renderTable(list);
  };
  const statusSel = h('select', {
    onchange: ev => { _filterState.status = ev.target.value; reload(); }
  },
    h('option', { value: 'pending', selected: true }, 'Pending'),
    h('option', { value: 'approved' }, 'Approved'),
    h('option', { value: 'rejected' }, 'Rejected'),
    h('option', { value: '' }, 'All')
  );
  const qInput = h('input', {
    placeholder: 'Search name / email / org…',
    style: { padding: '.4rem .6rem', border: '1px solid #cbd5e1', borderRadius: '6px', minWidth: '260px' },
    oninput: (function () {
      let _t;
      return ev => { clearTimeout(_t); _t = setTimeout(() => { _filterState.q = ev.target.value; reload(); }, 300); };
    })()
  });
  view.appendChild(h('div', {
    style: { display: 'flex', gap: '.6rem', marginBottom: '1rem', alignItems: 'center' }
  },
    h('label', { class: 'muted', style: { fontSize: '.85rem' } }, 'Status:'), statusSel,
    qInput,
    h('button', { class: 'btn sm ghost', onclick: reload }, '↻ Refresh')
  ));

  const tableHost = h('div', {});
  view.appendChild(tableHost);

  function renderTable(rows) {
    tableHost.innerHTML = '';
    if (!rows || !rows.length) {
      tableHost.appendChild(h('div', { class: 'empty' }, 'No signup requests in this view yet.'));
      return;
    }
    const tbl = h('table', { class: 'tbl' });
    tbl.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, 'ID'),
      h('th', {}, 'Submitted'),
      h('th', {}, 'Customer'),
      h('th', {}, 'Email / Mobile'),
      h('th', {}, 'Organisation'),
      h('th', {}, 'Slug'),
      h('th', {}, 'Wants'),
      h('th', {}, 'Plan picked'),
      h('th', {}, 'Status'),
      h('th', {}, 'Actions')
    )));
    const tb = h('tbody', {});
    rows.forEach(r => {
      const pillColour = r.status === 'pending' ? '#f59e0b'
        : r.status === 'approved' ? '#16a34a'
        : '#dc2626';
      tb.appendChild(h('tr', {},
        h('td', {}, '#' + r.id),
        h('td', {}, fmtDate(r.created_at)),
        h('td', {}, h('b', {}, r.name || '—'),
          r.submitted_by ? h('div', { class: 'muted', style: { fontSize: '.75rem' } }, 'via ' + r.submitted_by) : ''),
        h('td', {},
          h('div', {}, r.email),
          h('div', { class: 'muted', style: { fontSize: '.78rem' } }, r.mobile || '')
        ),
        h('td', {}, r.org_name || ''),
        h('td', {}, r.desired_slug ? h('code', {}, r.desired_slug) : h('span', { class: 'muted' }, '—')),
        h('td', {},
          h('div', {}, (function () {
            const TEN_LABELS = { month:'Monthly', quarter:'Quarterly', half_year:'6-month', year:'Yearly', '2year':'2-year', '3year':'3-year' };
            return r.desired_tenure ? (TEN_LABELS[r.desired_tenure] || r.desired_tenure) : '—';
          })()),
          h('div', { class: 'muted', style: { fontSize: '.75rem' } },
            r.desired_users ? (r.desired_users + ' users') : 'users not set')
        ),
        h('td', {}, r.package_name || h('span', { class: 'muted' }, 'pick on approve')),
        h('td', {}, h('span', {
          style: {
            background: pillColour, color: '#fff', padding: '.15rem .55rem',
            borderRadius: '999px', fontSize: '.75rem', fontWeight: '600'
          }
        }, r.status)),
        h('td', {},
          h('button', { class: 'btn sm', onclick: () => openSignupRequestModal(r.id, reload) }, 'Review')
        )
      ));
    });
    tbl.appendChild(tb);
    tableHost.appendChild(tbl);
  }

  await reload();
};

async function openSignupRequestModal(id, onClose) {
  const row = await api('api_saas_sr_get', id);
  const packages = await api('api_saas_packages_list', {});

  const m = h('div', { class: 'modal-bd' });
  const card = h('div', { class: 'modal', style: { maxWidth: '700px', maxHeight: '92vh', overflow: 'auto' } });
  m.appendChild(card);
  document.body.appendChild(m);

  function close() {
    m.remove();
    if (typeof onClose === 'function') onClose();
  }

  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', { style: { margin: 0 } }, '🆕 Signup Request #' + row.id),
    h('button', { class: 'modal-close', onclick: close, title: 'Close' }, '✕')
  ));

  const body = h('div', { class: 'modal-body' });
  card.appendChild(body);

  // ── If already approved: show credentials again
  if (row.status === 'approved' && row.provisioned_slug) {
    const loginUrl = location.origin + '/t/' + row.provisioned_slug;
    body.appendChild(h('div', {
      style: { background: '#ecfdf5', border: '1px solid #6ee7b7', padding: '1rem', borderRadius: '10px', marginBottom: '1rem' }
    },
      h('h4', { style: { margin: '0 0 .5rem 0', color: '#065f46' } }, '✓ Approved — tenant provisioned'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '.4rem .8rem', fontSize: '.9rem' } },
        h('div', { class: 'muted' }, 'Login URL'),  h('div', {}, h('a', { href: loginUrl, target: '_blank' }, loginUrl)),
        h('div', { class: 'muted' }, 'Email'),      h('div', {}, h('code', {}, row.email)),
        h('div', { class: 'muted' }, 'Password'),   h('div', {}, h('code', {}, row.provisioned_password || '(was shown once, not stored)')),
        h('div', { class: 'muted' }, 'Approved by'), h('div', {}, row.approved_by || ''),
        h('div', { class: 'muted' }, 'Approved at'), h('div', {}, fmtDate(row.approved_at))
      ),
      h('button', {
        class: 'btn sm', style: { marginTop: '.75rem' },
        onclick: () => {
          const txt = `Welcome to SmartCRM!\n\nLogin URL: ${loginUrl}\nEmail: ${row.email}\nPassword: ${row.provisioned_password || ''}`;
          navigator.clipboard.writeText(txt);
          toast('Credentials copied', 'ok');
        }
      }, '📋 Copy credentials')
    ));
  }
  if (row.status === 'rejected') {
    body.appendChild(h('div', {
      style: { background: '#fef2f2', border: '1px solid #fecaca', padding: '.75rem 1rem', borderRadius: '10px', marginBottom: '1rem', color: '#991b1b' }
    },
      h('b', {}, '✗ Rejected — '), row.reject_reason || '(no reason given)'
    ));
  }

  // ── Editable form
  const f = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem 1rem' } });
  function field(label, key, type, full, opts) {
    const wrap = h('div', { style: full ? { gridColumn: 'span 2' } : {} });
    wrap.appendChild(h('label', { class: 'muted', style: { fontSize: '.75rem', fontWeight: '600' } }, label));
    let el;
    if (type === 'textarea') {
      el = h('textarea', { style: { width: '100%', minHeight: '60px', padding: '.5rem', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box' } });
    } else if (type === 'select') {
      el = h('select', { style: { width: '100%', padding: '.5rem', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box' } },
        ...(opts || []).map(o => h('option', { value: o.value }, o.label))
      );
    } else {
      el = h('input', { type: type || 'text', style: { width: '100%', padding: '.5rem', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box' } });
    }
    el.value = row[key] == null ? '' : row[key];
    el.dataset.field = key;
    if (row.status !== 'pending') el.disabled = true;
    wrap.appendChild(el);
    f.appendChild(wrap);
    return el;
  }
  field('Name', 'name');
  field('Organisation', 'org_name');
  field('Email', 'email', 'email');
  field('Mobile', 'mobile');
  field('Desired slug', 'desired_slug');
  const pkgOptions = [{ value: '', label: '— pick a package —' }].concat(
    packages.map(p => ({ value: String(p.id), label: p.name + ' — ₹' + Number(p.base_price_inr || 0).toLocaleString('en-IN') + ' / ' + (p.is_lifetime ? 'lifetime' : ((p.recurring_period_count || 1) + ' ' + (p.recurring_period || 'month'))) }))
  );
  const pkgSel = field('Package', 'package_id', 'select', false, pkgOptions);
  pkgSel.value = String(row.package_id || '');
  // End-date preview — recomputes whenever the package selection changes.
  const endPreview = h('div', {
    style: {
      gridColumn: 'span 2', background: '#f1f5f9', padding: '.6rem .8rem',
      borderRadius: '6px', fontSize: '.85rem', color: '#334155', marginTop: '.25rem'
    }
  }, 'Pick a package to see the end date');
  function _computeEnd(pkg) {
    if (!pkg) return null;
    const d = new Date();
    if (Number(pkg.is_lifetime) === 1) { d.setFullYear(d.getFullYear() + 99); return d; }
    const n = Number(pkg.recurring_period_count) || 1;
    const per = String(pkg.recurring_period || 'month').toLowerCase();
    if (per === 'year') d.setFullYear(d.getFullYear() + n);
    else if (per === 'quarter') d.setMonth(d.getMonth() + (3 * n));
    else if (per === 'week') d.setDate(d.getDate() + (7 * n));
    else d.setMonth(d.getMonth() + n);
    return d;
  }
  function _refreshEndPreview() {
    const pkg = packages.find(p => String(p.id) === pkgSel.value);
    if (!pkg) {
      endPreview.textContent = 'Pick a package to see the end date';
      endPreview.style.background = '#f1f5f9';
      return;
    }
    const end = _computeEnd(pkg);
    const today = new Date();
    const ms = end - today;
    const days = Math.round(ms / (1000 * 60 * 60 * 24));
    const lifetimePkg = Number(pkg.is_lifetime) === 1;
    endPreview.style.background = '#ecfdf5';
    endPreview.style.color = '#065f46';
    endPreview.innerHTML =
      '<b>✓ ' + (lifetimePkg ? 'Lifetime plan' : 'Valid till: ' + end.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })) + '</b>' +
      (lifetimePkg ? ' — no renewal needed' : ' &nbsp;·&nbsp; ' + days + ' days from today &nbsp;·&nbsp; ₹' + Number(pkg.base_price_inr || 0).toLocaleString('en-IN'));
  }
  pkgSel.addEventListener('change', _refreshEndPreview);
  f.appendChild(endPreview);
  _refreshEndPreview();
  field('Industry pack', 'industry_pack', 'select', false, [
    { value: '', label: 'Generic' },
    { value: 'education', label: 'Education' },
    { value: 'realestate', label: 'Real Estate' }
  ]).value = row.industry_pack || '';
  field('Desired tenure', 'desired_tenure', 'select', false, [
    { value: '', label: '— not specified —' },
    { value: 'month', label: 'Monthly' },
    { value: 'quarter', label: 'Quarterly' },
    { value: 'half_year', label: 'Half-yearly (6 months)' },
    { value: 'year', label: 'Yearly' },
    { value: '2year', label: '2 years' },
    { value: '3year', label: '3 years' }
  ]).value = row.desired_tenure || '';
  field('Number of users', 'desired_users', 'number');
  field('Notes', 'notes', 'textarea', true);
  body.appendChild(f);
  body.appendChild(h('div', { class: 'muted', style: { fontSize: '.75rem', marginTop: '.4rem' } },
    'Submitted by: ' + (row.submitted_by || 'public form') + (row.ip_address ? ' · IP ' + row.ip_address : '')
  ));

  // ── Action buttons (only for pending)
  if (row.status === 'pending') {
    const actions = h('div', {
      class: 'modal-foot',
      style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1.25rem' }
    });
    const btnSave = h('button', { class: 'btn sm ghost' }, '💾 Save');
    const btnReject = h('button', { class: 'btn sm', style: { background: '#fee2e2', color: '#991b1b' } }, '✗ Reject');
    const btnApprove = h('button', { class: 'btn sm', style: { background: '#16a34a' } }, '✓ Approve & Provision');
    actions.appendChild(btnSave);
    actions.appendChild(btnReject);
    actions.appendChild(btnApprove);
    body.appendChild(actions);

    function collect() {
      const out = { id: row.id };
      f.querySelectorAll('[data-field]').forEach(el => { out[el.dataset.field] = el.value; });
      return out;
    }
    btnSave.onclick = async () => {
      btnSave.disabled = true;
      try { await api('api_saas_sr_update', collect()); toast('Saved', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
      finally { btnSave.disabled = false; }
    };
    btnReject.onclick = async () => {
      const reason = prompt('Reason for rejection (shown internally):', '');
      if (reason === null) return;
      btnReject.disabled = true;
      try {
        await api('api_saas_sr_reject', { id: row.id, reason: reason });
        toast('Rejected', 'ok');
        close();
      } catch (e) { toast(e.message, 'err'); btnReject.disabled = false; }
    };
    btnApprove.onclick = async () => {
      if (!confirm('Approve this request? This will create the tenant workspace and generate login credentials.')) return;
      // Save edits first
      btnApprove.disabled = true;
      btnApprove.textContent = 'Provisioning…';
      try {
        await api('api_saas_sr_update', collect());
        const r = await api('api_saas_sr_approve', { id: row.id });
        toast('Tenant provisioned!', 'ok');
        // Show credentials in a fresh modal so they're hard to miss
        showCredentialsModal(r);
        close();
      } catch (e) {
        toast(e.message, 'err');
        btnApprove.disabled = false;
        btnApprove.textContent = '✓ Approve & Provision';
      }
    };
  }
}

function showCredentialsModal(r) {
  const m = h('div', { class: 'modal-bd' });
  const card = h('div', { class: 'modal', style: { maxWidth: '520px' } });
  m.appendChild(card);
  document.body.appendChild(m);
  const close = () => m.remove();
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', { style: { margin: 0 } }, '🎉 Tenant provisioned'),
    h('button', { class: 'modal-close', onclick: close }, '✕')
  ));
  const body = h('div', { class: 'modal-body' });
  card.appendChild(body);
  body.appendChild(h('p', { class: 'muted', style: { marginTop: 0 } },
    'These are the login credentials. Copy them now — the password is shown only once in this strong form and is NOT recoverable later.'
  ));
  body.appendChild(h('div', { style: { background: '#f1f5f9', padding: '1rem', borderRadius: '8px' } },
    h('div', { style: { display: 'grid', gridTemplateColumns: '110px 1fr', gap: '.4rem .8rem' } },
      h('div', { class: 'muted' }, 'Login URL'), h('div', {}, h('a', { href: r.login_url, target: '_blank' }, r.login_url)),
      h('div', { class: 'muted' }, 'Email'),     h('div', {}, h('code', {}, r.email)),
      h('div', { class: 'muted' }, 'Password'),  h('div', {}, h('code', {}, r.password || '—'))
    )
  ));
  const composed = `Welcome to SmartCRM!\n\nLogin URL: ${r.login_url}\nEmail: ${r.email}\nPassword: ${r.password || ''}\n\nPlease change your password after first login.`;
  body.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '1rem' } },
    h('button', {
      class: 'btn', onclick: () => { navigator.clipboard.writeText(composed); toast('Copied to clipboard', 'ok'); }
    }, '📋 Copy welcome message'),
    h('a', {
      class: 'btn ghost',
      href: 'https://wa.me/?text=' + encodeURIComponent(composed),
      target: '_blank'
    }, '💬 Share via WhatsApp')
  ));
}

/* ============================================================
   Modules toggle modal — flip modules ON/OFF per tenant
   ============================================================ */
async function openModulesModal(t) {
  const m = h('div', { class: 'modal-bd' });
  const card = h('div', { class: 'modal', style: { maxWidth: '640px', maxHeight: '85vh', overflow: 'auto' } });
  m.appendChild(card);
  document.body.appendChild(m);

  card.appendChild(h('h3', { style: { marginTop: 0 } }, '\ud83e\udde9 Modules \u2014 ' + (t.org_name || t.slug)));
  card.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
    'Toggle modules on/off for this tenant. Changes apply on the tenant\'s next page load. Always-on modules (Core) cannot be disabled.'));

  const body = h('div', {}, h('div', { class: 'muted' }, 'Loading\u2026'));
  card.appendChild(body);
  card.appendChild(h('div', { style: { marginTop: '1rem', textAlign: 'right' } },
    h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Close')
  ));

  let data;
  try { data = await api('api_saas_tenant_modules_get', t.id); }
  catch (e) { body.innerHTML = ''; body.appendChild(h('div', { class: 'error-box' }, e.message)); return; }

  body.innerHTML = '';
  const active = new Set(data.active || []);
  const checks = {};

  data.catalog.forEach(mod => {
    const isActive = active.has(mod.key);
    const chk = h('input', {
      type: 'checkbox',
      checked: isActive ? 'checked' : null,
      disabled: mod.always_on ? 'disabled' : null
    });
    checks[mod.key] = chk;
    body.appendChild(h('label', {
      style: { display: 'flex', alignItems: 'flex-start', gap: '.6rem',
               padding: '.55rem .75rem', borderRadius: '8px',
               background: '#f8fafc', marginBottom: '.4rem',
               cursor: mod.always_on ? 'not-allowed' : 'pointer',
               opacity: mod.always_on ? '.7' : '1' }
    },
      chk,
      h('div', {},
        h('div', { style: { fontWeight: '600' } }, mod.label + (mod.always_on ? ' \u2014 always on' : '')),
        h('div', { class: 'muted', style: { fontSize: '.78rem', marginTop: '.15rem' } }, mod.description)
      )
    ));
  });

  const saveBtn = h('button', { class: 'btn primary', style: { marginTop: '.75rem' } }, '\ud83d\udcbe Save modules');
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const keys = data.catalog
      .filter(mod => checks[mod.key] && checks[mod.key].checked)
      .map(mod => mod.key);
    try {
      const r = await api('api_saas_tenant_modules_set', t.id, keys);
      toast('Modules updated for ' + (t.org_name || t.slug));
      m.remove();
    } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
  };
  body.appendChild(saveBtn);
}

window.addEventListener('hashchange', route);
route();


// ================================================================
// TKT_ADMIN_v1 — Support Tickets (all tenants)
// ================================================================
let _tkCat = null;
async function _loadTkCatalog() {
  if (_tkCat) return _tkCat;
  try { _tkCat = await api('api_saas_tk_categories'); }
  catch (e) { console.warn('[tk-admin] catalog load failed:', e); _tkCat = { categories: [], priorities: [], statuses: [] }; }
  return _tkCat;
}
function _tkStatusPill(status, cat) {
  const f = (cat && cat.statuses || []).find(s => s.id === status);
  const color = f ? f.color : '#6b7280';
  const label = f ? f.label : status;
  return h('span', { style: { background: color + '22', color, border: '1px solid ' + color + '55', padding: '.15rem .55rem', borderRadius: '12px', fontSize: '.78rem', fontWeight: 600 } }, label);
}
function _tkPrioPill(p, cat) {
  const f = (cat && cat.priorities || []).find(x => x.id === p);
  const color = f ? f.color : '#3b82f6';
  return h('span', { style: { color, fontWeight: 600, fontSize: '.8rem' } }, '● ' + (f ? f.label : p));
}
function _tkFmt(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts), now = new Date();
    const min = Math.round((now - d) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + 'm ago';
    if (min < 1440) return Math.round(min / 60) + 'h ago';
    return d.toLocaleString();
  } catch (_) { return ts; }
}

VIEWS.tickets = async (view) => {
  const cat = await _loadTkCatalog();
  view.appendChild(h('h1', {}, '🎫 Support Tickets'));

  // Filter bar
  const statusSel = h('select', { class: 'input' });
  statusSel.appendChild(h('option', { value: '' }, 'All statuses'));
  (cat.statuses || []).forEach(s => statusSel.appendChild(h('option', { value: s.id }, s.label)));
  const prioSel = h('select', { class: 'input' });
  prioSel.appendChild(h('option', { value: '' }, 'All priorities'));
  (cat.priorities || []).forEach(p => prioSel.appendChild(h('option', { value: p.id }, p.label)));
  const catSel = h('select', { class: 'input' });
  catSel.appendChild(h('option', { value: '' }, 'All categories'));
  (cat.categories || []).forEach(c => catSel.appendChild(h('option', { value: c.id }, c.icon + ' ' + c.label)));
  const searchIn = h('input', { class: 'input', placeholder: 'Search subject, ticket #, or tenant slug', style: { minWidth: '260px' } });
  const refreshBtn = h('button', { class: 'btn' }, '🔄 Refresh');
  const onlyUnassigned = h('label', { style: { display: 'inline-flex', gap: '.3rem', alignItems: 'center' } },
    h('input', { type: 'checkbox', id: 'tk-unassigned' }), 'Unassigned only'
  );

  view.appendChild(h('div', { class: 'toolbar', style: { display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', margin: '1rem 0' } },
    statusSel, prioSel, catSel, onlyUnassigned, searchIn, refreshBtn
  ));

  const statsRow = h('div', { id: 'tk-stats', style: { display: 'flex', gap: '.75rem', flexWrap: 'wrap', marginBottom: '1rem' } });
  view.appendChild(statsRow);
  const tableWrap = h('div', { id: 'tk-table' });
  view.appendChild(tableWrap);

  async function load() {
    tableWrap.innerHTML = '<div class="muted" style="padding:1rem">Loading...</div>';
    let res;
    try {
      res = await api('api_saas_tk_admin_listAll', {
        status: statusSel.value || null,
        priority: prioSel.value || null,
        category: catSel.value || null,
        q: searchIn.value.trim() || null,
        unassigned: document.getElementById('tk-unassigned').checked ? 1 : null
      });
    } catch (e) {
      tableWrap.innerHTML = '';
      tableWrap.appendChild(h('div', { class: 'error-box' }, '⚠ ' + e.message));
      return;
    }
    // Stats cards
    statsRow.innerHTML = '';
    const s = res.stats || {};
    function statCard(label, n, color) {
      return h('div', { style: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '.6rem .9rem', minWidth: '110px' } },
        h('div', { style: { fontSize: '.72rem', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em' } }, label),
        h('div', { style: { fontSize: '1.3rem', fontWeight: 700, color: color || '#0f172a' } }, String(n || 0))
      );
    }
    statsRow.appendChild(statCard('Total', s.total, '#0f172a'));
    statsRow.appendChild(statCard('Open', s.open, '#3b82f6'));
    statsRow.appendChild(statCard('In progress', s.in_progress, '#8b5cf6'));
    statsRow.appendChild(statCard('Waiting customer', s.waiting_customer, '#f59e0b'));
    statsRow.appendChild(statCard('Reopened', s.reopened, '#ef4444'));
    statsRow.appendChild(statCard('Urgent open', s.urgent_open, '#dc2626'));
    statsRow.appendChild(statCard('Resolved', s.resolved, '#10b981'));

    // Table
    tableWrap.innerHTML = '';
    const tickets = res.tickets || [];
    if (!tickets.length) {
      tableWrap.appendChild(h('div', { class: 'empty' }, 'No tickets match these filters.'));
      return;
    }
    const tbl = h('table', { class: 'table' });
    tbl.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, '#'),
      h('th', {}, 'Tenant'),
      h('th', {}, 'Subject'),
      h('th', {}, 'Category'),
      h('th', {}, 'Status'),
      h('th', {}, 'Priority'),
      h('th', {}, 'Assignee'),
      h('th', {}, 'Last activity'),
      h('th', {}, 'Replies'),
      h('th', {}, '')
    )));
    const tbody = h('tbody', {});
    tickets.forEach(t => {
      const catObj = (cat.categories || []).find(c => c.id === t.category);
      tbody.appendChild(h('tr', { style: { cursor: 'pointer' }, onclick: () => openAdminTicketModal(t.id) },
        h('td', {}, h('span', { style: { fontFamily: 'monospace', fontSize: '.82rem' } }, t.ticket_number)),
        h('td', {}, h('div', {},
          h('div', { style: { fontWeight: 600 } }, t.org_name || t.tenant_slug),
          h('div', { class: 'muted', style: { fontSize: '.75rem' } }, t.tenant_slug)
        )),
        h('td', { style: { maxWidth: '300px' } }, h('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.subject)),
        h('td', {}, (catObj ? catObj.icon + ' ' + catObj.label : t.category)),
        h('td', {}, _tkStatusPill(t.status, cat)),
        h('td', {}, _tkPrioPill(t.priority, cat)),
        h('td', { class: 'muted', style: { fontSize: '.85rem' } }, t.assignee_name || '—'),
        h('td', { class: 'muted', style: { fontSize: '.82rem' } }, _tkFmt(t.last_reply_at || t.created_at)),
        h('td', { style: { textAlign: 'center' } }, String(t.reply_count || 0)),
        h('td', {}, h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); openAdminTicketModal(t.id); } }, 'Open →'))
      ));
    });
    tbl.appendChild(tbody);
    tableWrap.appendChild(tbl);
  }
  refreshBtn.onclick = load;
  statusSel.onchange = load; prioSel.onchange = load; catSel.onchange = load;
  document.getElementById('tk-unassigned').onchange = load;
  searchIn.addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
  await load();
};

// ---- Ticket detail modal ----------------------------------------
async function openAdminTicketModal(ticketId) {
  const cat = await _loadTkCatalog();
  const m = h('div', { class: 'modal-bd' });
  const card = h('div', { class: 'modal', style: { maxWidth: '880px', maxHeight: '90vh', overflow: 'auto', width: '95%' } });
  m.appendChild(card);
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });

  const body = h('div', {}, h('div', { class: 'muted' }, 'Loading…'));
  card.appendChild(body);

  async function load() {
    body.innerHTML = '<div class="muted">Loading…</div>';
    let t;
    try { t = await api('api_saas_tk_admin_get', ticketId); }
    catch (e) { body.innerHTML = ''; body.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
    body.innerHTML = '';

    // Header
    const head = h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' } });
    head.appendChild(h('div', {},
      h('div', { style: { fontFamily: 'monospace', fontSize: '.78rem', color: '#6b7280' } }, t.ticket_number),
      h('h3', { style: { margin: '.15rem 0 .35rem' } }, t.subject),
      h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', fontSize: '.82rem', color: '#475569' } },
        _tkStatusPill(t.status, cat),
        _tkPrioPill(t.priority, cat),
        h('span', {}, '· ' + (t.tenant_org_name || t.tenant_slug)),
        h('span', {}, '· ' + ((cat.categories || []).find(c => c.id === t.category) || {}).label || t.category),
        h('span', {}, '· opened ' + _tkFmt(t.created_at))
      )
    ));
    const actions = h('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap' } });
    // Status dropdown
    const statusSel = h('select', { class: 'input', onchange: async () => {
      try { await api('api_saas_tk_admin_setStatus', { ticket_id: t.id, status: statusSel.value }); toast('Status updated'); load(); }
      catch (e) { toast(e.message, 'err'); }
    } });
    (cat.statuses || []).forEach(s => statusSel.appendChild(h('option', { value: s.id, selected: s.id === t.status }, s.label)));
    actions.appendChild(h('label', {}, h('div', { class: 'muted', style: { fontSize: '.7rem' } }, 'Status'), statusSel));
    // Priority
    const prioSel = h('select', { class: 'input', onchange: async () => {
      try { await api('api_saas_tk_admin_setPriority', { ticket_id: t.id, priority: prioSel.value }); toast('Priority updated'); load(); }
      catch (e) { toast(e.message, 'err'); }
    } });
    (cat.priorities || []).forEach(p => prioSel.appendChild(h('option', { value: p.id, selected: p.id === t.priority }, p.label)));
    actions.appendChild(h('label', {}, h('div', { class: 'muted', style: { fontSize: '.7rem' } }, 'Priority'), prioSel));
    // Assignee
    const assignSel = h('select', { class: 'input', onchange: async () => {
      const id = assignSel.value ? Number(assignSel.value) : null;
      try { await api('api_saas_tk_admin_assign', { ticket_id: t.id, assignee_id: id }); toast(id ? 'Assigned' : 'Unassigned'); load(); }
      catch (e) { toast(e.message, 'err'); }
    } });
    assignSel.appendChild(h('option', { value: '' }, '— Unassigned —'));
    try {
      const admins = await api('api_saas_admin_list');
      (admins || []).filter(a => Number(a.is_active) === 1).forEach(a => {
        assignSel.appendChild(h('option', { value: a.id, selected: Number(a.id) === Number(t.assignee_id) }, a.name + ' (' + a.role + ')'));
      });
    } catch (_) {}
    actions.appendChild(h('label', {}, h('div', { class: 'muted', style: { fontSize: '.7rem' } }, 'Assignee'), assignSel));
    head.appendChild(actions);
    body.appendChild(head);

    // Contact info
    body.appendChild(h('div', { style: { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '.6rem .9rem', margin: '.75rem 0', fontSize: '.85rem' } },
      h('b', {}, 'Reporter: '), (t.contact_name || '—'),
      h('span', { class: 'muted' }, ' · ', t.contact_email || 'no email', ' · ', t.contact_phone || 'no phone')
    ));

    // Thread
    const thread = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.6rem', marginTop: '.5rem' } });
    function renderMsg(m) {
      const isAdmin = m.author_type === 'admin';
      const isInternal = Number(m.is_internal) === 1;
      const bg     = isInternal ? '#fffbeb' : (isAdmin ? '#eff6ff' : '#fff');
      const border = isInternal ? '#fcd34d' : (isAdmin ? '#bfdbfe' : '#e5e7eb');
      const accent = isInternal ? '#f59e0b' : (isAdmin ? '#3b82f6' : '#10b981');
      const card = h('div', { style: { background: bg, border: '1px solid ' + border, borderLeft: '4px solid ' + accent, borderRadius: '6px', padding: '.7rem .9rem' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '.82rem', marginBottom: '.3rem' } },
          h('div', {},
            h('b', {}, m.author_name || (isAdmin ? 'Support' : 'Customer')),
            isAdmin ? h('span', { style: { marginLeft: '.4rem', color: '#3b82f6', fontSize: '.7rem', background: '#dbeafe', padding: '.05rem .35rem', borderRadius: '4px', fontWeight: 600 } }, '🛟 SUPPORT') : h('span', { style: { marginLeft: '.4rem', color: '#10b981', fontSize: '.7rem', background: '#d1fae5', padding: '.05rem .35rem', borderRadius: '4px', fontWeight: 600 } }, '👤 CUSTOMER'),
            isInternal ? h('span', { style: { marginLeft: '.4rem', color: '#b45309', fontSize: '.7rem', background: '#fef3c7', padding: '.05rem .35rem', borderRadius: '4px', fontWeight: 600 } }, '🔒 INTERNAL NOTE') : null
          ),
          h('span', { class: 'muted', style: { fontSize: '.78rem' } }, _tkFmt(m.created_at))
        ),
        h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.5, fontSize: '.92rem' } }, m.body)
      );
      // Attachments scoped to this reply
      const atts = (t.attachments || []).filter(a => a.reply_id === m.id);
      if (atts.length) {
        const row = h('div', { style: { marginTop: '.5rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' } });
        atts.forEach(a => {
          const url = '/api/saas/ticket-attachment/' + a.id + '?token=' + encodeURIComponent(APP.token);
          row.appendChild(h('a', { href: url, target: '_blank', style: { display: 'inline-flex', alignItems: 'center', gap: '.3rem', padding: '.3rem .55rem', background: '#fff', border: '1px solid ' + border, borderRadius: '4px', textDecoration: 'none', fontSize: '.8rem' } },
            '📎 ' + (a.filename || 'file')
          ));
        });
        card.appendChild(row);
      }
      return card;
    }
    // Description acts as first message
    thread.appendChild(renderMsg({
      author_type: 'tenant',
      author_name: t.contact_name || 'Customer',
      body: t.description,
      created_at: t.created_at,
      id: null
    }));
    // Description-level attachments (reply_id IS NULL)
    const descAtts = (t.attachments || []).filter(a => !a.reply_id);
    if (descAtts.length) {
      const row = h('div', { style: { marginTop: '.4rem', display: 'flex', gap: '.4rem', flexWrap: 'wrap' } });
      descAtts.forEach(a => {
        const url = '/api/saas/ticket-attachment/' + a.id + '?token=' + encodeURIComponent(APP.token);
        row.appendChild(h('a', { href: url, target: '_blank', style: { padding: '.3rem .55rem', background: '#fff', border: '1px solid #e5e7eb', borderRadius: '4px', textDecoration: 'none', fontSize: '.8rem' } },
          '📎 ' + (a.filename || 'file')
        ));
      });
      thread.appendChild(row);
    }
    (t.replies || []).forEach(r => thread.appendChild(renderMsg(r)));
    body.appendChild(thread);

    // Composer
    const compWrap = h('div', { style: { marginTop: '1rem', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: '6px', padding: '.85rem' } });
    const replyIn = h('textarea', { class: 'input', rows: 4, placeholder: 'Type your reply...', style: { width: '100%', minHeight: '80px' } });
    const fileIn = h('input', { type: 'file' });
    const intCb = h('input', { type: 'checkbox' });
    compWrap.appendChild(h('div', { style: { fontWeight: 600, marginBottom: '.4rem' } }, '✏ Reply'));
    compWrap.appendChild(replyIn);
    compWrap.appendChild(h('div', { style: { display: 'flex', gap: '.6rem', alignItems: 'center', marginTop: '.5rem', flexWrap: 'wrap' } },
      fileIn,
      h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: '.25rem', fontSize: '.85rem' } }, intCb, '🔒 Internal note (hidden from customer)'),
      h('button', { class: 'btn primary', onclick: async (e) => {
        if (!replyIn.value.trim()) { toast('Type a reply', 'err'); return; }
        e.target.disabled = true; e.target.textContent = 'Sending...';
        try {
          const r = await api('api_saas_tk_admin_reply', {
            ticket_id: t.id,
            body: replyIn.value.trim(),
            is_internal: intCb.checked ? 1 : 0
          });
          if (fileIn.files && fileIn.files[0]) {
            try {
              const fd = new FormData();
              fd.append('ticket_id', t.id);
              fd.append('reply_id', r.reply_id);
              fd.append('file', fileIn.files[0]);
              await fetch('/api/saas/ticket-attachment', {
                method: 'POST',
                headers: { 'X-Auth-Token': APP.token },
                body: fd
              });
            } catch (_) {}
          }
          replyIn.value = '';
          intCb.checked = false;
          toast('✓ Reply sent');
          load();
        } catch (err) {
          toast(err.message, 'err');
          e.target.disabled = false; e.target.textContent = 'Send reply';
        }
      } }, 'Send reply')
    ));
    body.appendChild(compWrap);

    // Footer close
    body.appendChild(h('div', { style: { marginTop: '1rem', textAlign: 'right' } },
      h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Close')
    ));
  }
  await load();
}
window.openAdminTicketModal = openAdminTicketModal;



// PACK_RETROFIT_v1 (2026-05-21) — Install / switch industry pack on existing tenant.
async function openInstallPackModal(t) {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
  const card = h('div', { class: 'card', style: { maxWidth: '480px', width: '92%', padding: '1.2rem 1.4rem', background: '#fff', borderRadius: '12px' } });
  card.appendChild(h('h3', { style: { marginTop: 0 } }, '\ud83c\udfd7\ufe0f Install / Switch Industry Pack'));
  card.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } },
    'Tenant: ', h('b', {}, t.org_name || t.slug), ' (', t.slug, ')'));
  card.appendChild(h('p', { class: 'muted', style: { fontSize: '.78rem', marginTop: '-.4rem' } },
    'Installs the pack\'s tables, custom fields, seed data, and 12-stage pipeline (where applicable). Existing data is preserved; statuses are added only if not already present.'));

  const packSel = h('select', { style: { width: '100%', padding: '.5rem', borderRadius: '8px', border: '1px solid #cbd5e1', marginTop: '.5rem' } },
    h('option', { value: '' }, '— pick a pack —'),
    h('option', { value: 'realestate' }, '\ud83c\udfe2 Real Estate — inventory + bookings + 12-stage CP pipeline'),
    h('option', { value: 'education' },  '\ud83c\udf93 Education / Coaching — fees + installments + reminders'),
    h('option', { value: 'generic' },    '\ud83e\udde9 Generic CRM (uninstall current pack, soft — data kept)')
  );
  card.appendChild(h('label', { style: { fontSize: '.8rem', fontWeight: 600 } }, 'Industry pack'));
  card.appendChild(packSel);

  const status = h('div', { style: { marginTop: '.7rem', fontSize: '.8rem' } });
  card.appendChild(status);

  const btnRow = h('div', { style: { display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '1rem' } },
    h('button', { type: 'button', class: 'btn ghost', onclick: () => m.remove() }, 'Cancel'),
    h('button', { type: 'button', class: 'btn primary', onclick: async () => {
      const packId = packSel.value;
      if (!packId) { status.innerHTML = '<span style="color:#b91c1c">Pick a pack first.</span>'; return; }
      status.innerHTML = '⏳ Installing — this can take a few seconds…';
      try {
        const r = await api('api_saas_tenants_installPack', { slug: t.slug, pack_id: packId });
        status.innerHTML = '<span style="color:#16a34a">✔ Pack installed: <b>' + packId + '</b>. Tenant SPA will pick it up on next reload.</span>';
        toast('Pack installed: ' + packId + ' on ' + t.slug);
        setTimeout(() => { m.remove(); navigate('tenants'); }, 1600);
      } catch (e) {
        status.innerHTML = '<span style="color:#b91c1c">✗ ' + e.message + '</span>';
      }
    } }, 'Install pack')
  );
  card.appendChild(btnRow);
  m.appendChild(card);
  document.body.appendChild(m);
}



// ADMIN_AI_RECORDING_TOGGLE_v1 — super-admin per-tenant AI Call Summary toggle.
async function openAiRecordingModal(t) {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
  const card = h('div', { class: 'card', style: { maxWidth: '480px', width: '92%', padding: '1.2rem 1.4rem', background: '#fff', borderRadius: '12px' } });
  card.appendChild(h('h3', { style: { marginTop: 0 } }, '\ud83c\udf99\ufe0f AI Call Summary'));
  card.appendChild(h('p', { class: 'muted', style: { fontSize: '.85rem' } }, 'Tenant: ', h('b', {}, t.org_name || t.slug), ' (', t.slug, ')'));
  card.appendChild(h('p', { class: 'muted', style: { fontSize: '.78rem' } },
    'When ON, the platform transcribes + summarises every uploaded recording with Gemini. '
    + 'When OFF, the worker silently skips them (still saves the audio, just no AI processing). '
    + 'Useful to cut Gemini cost for tenants who don\'t use the AI summary feature.'));

  const status = h('div', { style: { padding: '.6rem', background: '#f1f5f9', borderRadius: '8px', margin: '.5rem 0', fontSize: '.85rem' } }, '\u23f3 Loading current state\u2026');
  card.appendChild(status);

  const onBtn  = h('button', { class: 'btn primary', type: 'button', disabled: true }, '\u25cf Turn ON');
  const offBtn = h('button', { class: 'btn', type: 'button', disabled: true, style: { background: '#fee2e2', color: '#b91c1c', borderColor: '#fecaca' } }, '\u25cb Turn OFF');
  const btnRow = h('div', { style: { display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '1rem' } },
    h('button', { type: 'button', class: 'btn ghost', onclick: () => m.remove() }, 'Close'),
    offBtn, onBtn
  );
  card.appendChild(btnRow);
  m.appendChild(card);
  document.body.appendChild(m);

  async function refresh() {
    try {
      const r = await api('api_saas_tenants_getAiRecording', t.slug);
      status.innerHTML = '<b>Current state:</b> ' + (r.enabled
        ? '<span style="color:#16a34a">\u2714 ON \u2014 every uploaded recording is processed by Gemini</span>'
        : '<span style="color:#b91c1c">\u2717 OFF \u2014 worker skips recordings, no AI cost</span>');
      onBtn.disabled  = r.enabled;
      offBtn.disabled = !r.enabled;
      onBtn.style.opacity  = r.enabled  ? '.4' : '1';
      offBtn.style.opacity = !r.enabled ? '.4' : '1';
    } catch (e) {
      status.innerHTML = '<span style="color:#b91c1c">\u2717 ' + e.message + '</span>';
    }
  }

  onBtn.onclick = async () => {
    onBtn.disabled = true;
    try {
      await api('api_saas_tenants_setAiRecording', { slug: t.slug, enabled: true });
      toast('AI Call Summary turned ON for ' + t.slug);
      await refresh();
    } catch (e) { toast(e.message, 'err'); onBtn.disabled = false; }
  };
  offBtn.onclick = async () => {
    if (!confirm('Turn AI Call Summary OFF for ' + t.slug + '?\n\nUploaded recordings will still be saved, but the worker will NOT call Gemini for transcription/summary. Save instant Gemini cost.')) return;
    offBtn.disabled = true;
    try {
      await api('api_saas_tenants_setAiRecording', { slug: t.slug, enabled: false });
      toast('AI Call Summary turned OFF for ' + t.slug);
      await refresh();
    } catch (e) { toast(e.message, 'err'); offBtn.disabled = false; }
  };

  refresh();
}

// ADMIN_ADD_USER_v1 (2026-05-22) — super-admin manages users + per-user monthly cost.
async function openTenantUsersModal(t) {
  const m = document.createElement('div');
  m.className = 'modal-backdrop';
  m.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:1rem;';
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
  const card = h('div', { class: 'card', style: { maxWidth: '780px', width: '100%', maxHeight: '90vh', overflow: 'auto', padding: '1.2rem 1.4rem', background: '#fff', borderRadius: '12px' } });

  card.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
    h('h3', { style: { margin: 0 } }, '\ud83d\udc64 Users \u2014 ', t.org_name || t.slug),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => m.remove() }, '\u2715')
  ));
  card.appendChild(h('p', { class: 'muted', style: { fontSize: '.8rem', marginTop: '.4rem' } },
    'Slug: ', h('code', {}, t.slug), ' \u00b7 Manage seat cap + per-extra-user billing and add users to this tenant.'));

  // ADMIN_USER_CAP_v1 — Plan & cap card. Shows base cap from package, override
  // cap, current user count, extra count, and per-user charge config.
  const planCard = h('div', { style: { background: '#fef3c7', border: '1px solid #fde68a', padding: '.8rem 1rem', borderRadius: '10px', margin: '.7rem 0' } }, 'Loading plan\u2026');
  card.appendChild(planCard);

  async function loadPlan() {
    planCard.innerHTML = '<div style="color:#92400e">Loading plan\u2026</div>';
    let plan;
    try { plan = await api('api_saas_tenants_getUserPlan', t.slug); }
    catch (e) { planCard.innerHTML = '<div style="color:#b91c1c">' + e.message + '</div>'; return; }

    planCard.innerHTML = '';
    const capInput   = h('input', { type: 'number', min: '0', step: '1', value: plan.override_cap != null ? String(plan.override_cap) : '', placeholder: plan.base_cap != null ? String(plan.base_cap) + ' (from plan)' : 'No cap', style: { width: '110px', padding: '.4rem', border: '1px solid #cbd5e1', borderRadius: '6px', textAlign: 'right' } });
    const rateInput  = h('input', { type: 'number', min: '0', step: '0.01', value: String(plan.extra_charge_inr_per_user || 0), style: { width: '110px', padding: '.4rem', border: '1px solid #cbd5e1', borderRadius: '6px', textAlign: 'right' } });
    const periodSel  = h('select', { style: { padding: '.4rem', border: '1px solid #cbd5e1', borderRadius: '6px' } },
      h('option', { value: 'month',   selected: plan.period === 'month'   ? 'selected' : null }, 'per month'),
      h('option', { value: 'quarter', selected: plan.period === 'quarter' ? 'selected' : null }, 'per quarter'),
      h('option', { value: 'year',    selected: plan.period === 'year'    ? 'selected' : null }, 'per year')
    );

    const capStr = (plan.effective_cap == null) ? 'Unlimited' : String(plan.effective_cap);
    const capColor = (plan.extra_users > 0) ? '#b91c1c' : (plan.current_users >= plan.effective_cap ? '#92400e' : '#15803d');

    planCard.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '.8rem' } },
      h('div', {},
        h('div', { style: { fontWeight: 700, color: '#0f172a', fontSize: '.95rem' } }, '\ud83d\udcca Plan & seat cap'),
        h('div', { style: { fontSize: '.82rem', color: '#475569', marginTop: '.25rem' } },
          'Package: ', h('b', {}, plan.package_name || '(none)'),
          ' \u00b7 Base cap: ', h('b', {}, plan.base_cap != null ? String(plan.base_cap) : 'unlimited'),
          plan.override_cap != null ? h('span', {}, ' \u00b7 Override: ', h('b', { style: { color: '#3730a3' } }, String(plan.override_cap))) : null
        ),
        h('div', { style: { marginTop: '.5rem', fontSize: '1.05rem' } },
          h('span', {}, 'Users: '),
          h('b', { style: { color: capColor } }, String(plan.current_users) + ' / ' + capStr),
          plan.extra_users > 0 ? h('span', { style: { color: '#b91c1c', fontWeight: 700, marginLeft: '.4rem' } }, '\u00b7 ' + plan.extra_users + ' extra over cap') : null
        )
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '.4rem', alignItems: 'flex-end' } },
        h('div', { style: { display: 'flex', gap: '.4rem', alignItems: 'center' } },
          h('label', { style: { fontSize: '.78rem', fontWeight: 600 } }, 'Total seats:'),
          capInput
        ),
        h('div', { style: { display: 'flex', gap: '.4rem', alignItems: 'center' } },
          h('label', { style: { fontSize: '.78rem', fontWeight: 600 } }, '\u20b9 per extra user:'),
          rateInput,
          periodSel
        )
      )
    ));

    const status = h('div', { style: { marginTop: '.5rem', fontSize: '.82rem', minHeight: '1.2rem' } });
    const saveBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      saveBtn.disabled = true;
      status.innerHTML = '\u23f3 Saving\u2026';
      try {
        const r = await api('api_saas_tenants_setUserPlan', {
          slug: t.slug,
          cap: capInput.value === '' ? null : Number(capInput.value),
          extra_inr: Number(rateInput.value) || 0,
          period: periodSel.value
        });
        status.innerHTML = '<span style="color:#16a34a">\u2714 Saved. Cap: ' + (r.cap == null ? 'unlimited' : r.cap) + ' \u00b7 \u20b9' + r.extra_inr + ' / ' + r.period + ' per extra user.</span>';
        await loadPlan();
      } catch (e) { status.innerHTML = '<span style="color:#b91c1c">' + e.message + '</span>'; }
      finally { saveBtn.disabled = false; }
    } }, '\ud83d\udcbe Save cap & rate');

    const chargeBtn = h('button', { class: 'btn', type: 'button', title: 'Create a pending invoice for the extra users × per-user rate', style: { background: '#dcfce7', color: '#15803d', borderColor: '#86efac' }, onclick: async () => {
      if (!confirm('Generate an invoice for ' + plan.extra_users + ' extra user(s) at \u20b9' + plan.extra_charge_inr_per_user + ' / ' + plan.period + ' = \u20b9' + plan.pending_charge_inr + ' + 18% GST?')) return;
      chargeBtn.disabled = true;
      status.innerHTML = '\u23f3 Creating invoice\u2026';
      try {
        const r = await api('api_saas_tenants_chargeExtraUsers', { slug: t.slug });
        status.innerHTML = '<span style="color:#15803d">\u2714 Invoice ' + r.number + ' created \u00b7 \u20b9' + r.total_inr + ' (incl. GST). Tenant can pay via the regular flow.</span>';
      } catch (e) { status.innerHTML = '<span style="color:#b91c1c">' + e.message + '</span>'; }
      finally { chargeBtn.disabled = false; }
    } }, '\ud83e\uddfe Generate invoice for extra users');

    const actionsRow = h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '.7rem', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' } },
      saveBtn,
      (plan.extra_users > 0 && plan.extra_charge_inr_per_user > 0) ? chargeBtn : null
    );
    planCard.appendChild(actionsRow);
    planCard.appendChild(status);
    if (plan.extra_users > 0 && plan.extra_charge_inr_per_user > 0) {
      planCard.appendChild(h('div', { style: { marginTop: '.4rem', fontSize: '.78rem', color: '#92400e' } },
        '\ud83d\udcb0 Pending: \u20b9' + Number(plan.pending_charge_inr).toLocaleString('en-IN') + ' + GST for ' + plan.extra_users + ' extra user(s) this ' + plan.period + '.'));
    }
  }
  loadPlan();

  const totalsBar = h('div', { style: { background: '#f1f5f9', padding: '.6rem .8rem', borderRadius: '8px', margin: '.7rem 0', fontSize: '.85rem' } }, 'Loading\u2026');
  card.appendChild(totalsBar);

  const tableWrap = h('div', { style: { maxHeight: '300px', overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px' } });
  card.appendChild(tableWrap);

  const formHeading = h('h4', { style: { marginTop: '1.2rem', marginBottom: '.4rem' } }, '\u2795 Add new user');
  card.appendChild(formHeading);

  const nameIn  = h('input', { type: 'text', placeholder: 'Full name', style: { width: '100%', padding: '.45rem', border: '1px solid #cbd5e1', borderRadius: '6px' } });
  const emailIn = h('input', { type: 'email', placeholder: 'email@example.com', style: { width: '100%', padding: '.45rem', border: '1px solid #cbd5e1', borderRadius: '6px' } });
  const phoneIn = h('input', { type: 'tel', placeholder: '+91 98765 43210', style: { width: '100%', padding: '.45rem', border: '1px solid #cbd5e1', borderRadius: '6px' } });
  const roleSel = h('select', { style: { width: '100%', padding: '.45rem', border: '1px solid #cbd5e1', borderRadius: '6px' } },
    h('option', { value: 'sales' }, 'Sales'),
    h('option', { value: 'team_leader' }, 'Team Leader'),
    h('option', { value: 'manager' }, 'Manager'),
    h('option', { value: 'admin' }, 'Admin'),
    h('option', { value: 'employee' }, 'Employee')
  );
  const passIn  = h('input', { type: 'text', placeholder: 'Initial password (min 6 chars)', style: { width: '100%', padding: '.45rem', border: '1px solid #cbd5e1', borderRadius: '6px' } });
  const costIn  = h('input', { type: 'number', step: '0.01', min: '0', placeholder: '0', value: '0', style: { width: '100%', padding: '.45rem', border: '1px solid #cbd5e1', borderRadius: '6px', textAlign: 'right' } });

  // Helper to generate a sensible default password.
  function _genPw() {
    const alpha = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 10; i++) out += alpha[Math.floor(Math.random() * alpha.length)];
    return out;
  }
  passIn.value = _genPw();

  const form = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem' } },
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '.2rem', fontSize: '.78rem', fontWeight: 600 } }, 'Name *', nameIn),
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '.2rem', fontSize: '.78rem', fontWeight: 600 } }, 'Email *', emailIn),
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '.2rem', fontSize: '.78rem', fontWeight: 600 } }, 'Phone', phoneIn),
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '.2rem', fontSize: '.78rem', fontWeight: 600 } }, 'Role', roleSel),
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '.2rem', fontSize: '.78rem', fontWeight: 600 } }, 'Initial password *', passIn),
    h('label', { style: { display: 'flex', flexDirection: 'column', gap: '.2rem', fontSize: '.78rem', fontWeight: 600 } }, 'Monthly cost (\u20b9)', costIn)
  );
  card.appendChild(form);

  const status = h('div', { style: { fontSize: '.82rem', marginTop: '.6rem', minHeight: '1.2rem' } });
  card.appendChild(status);

  const addBtn = h('button', { type: 'button', class: 'btn primary', style: { marginTop: '.6rem' }, onclick: async () => {
    const name = nameIn.value.trim();
    const email = emailIn.value.trim().toLowerCase();
    const password = passIn.value.trim();
    if (!name || !email || !password) { status.innerHTML = '<span style="color:#b91c1c">Name, email and password are required.</span>'; return; }
    addBtn.disabled = true;
    status.innerHTML = '\u23f3 Creating user\u2026';
    try {
      const r = await api('api_saas_tenants_addUser', {
        slug: t.slug, name, email,
        phone: phoneIn.value.trim(),
        role: roleSel.value,
        password,
        monthly_cost_inr: Number(costIn.value) || 0
      });
      status.innerHTML = '<span style="color:#16a34a">\u2714 User added: ' + r.email + ' \u00b7 \u20b9' + (r.monthly_cost_inr || 0) + '/mo</span>';
      // Clear form for next entry
      nameIn.value = ''; emailIn.value = ''; phoneIn.value = ''; passIn.value = _genPw(); costIn.value = '0';
      await refresh();
      try { await loadPlan(); } catch (_) {}
    } catch (e) {
      status.innerHTML = '<span style="color:#b91c1c">\u2717 ' + e.message + '</span>';
    } finally { addBtn.disabled = false; }
  } }, '\u2795 Add user');
  card.appendChild(addBtn);

  async function refresh() {
    tableWrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading users\u2026</div>';
    try {
      const r = await api('api_saas_tenants_listUsers', t.slug);
      totalsBar.innerHTML = '<b>' + r.counts.active + '</b> active user(s), <b>' + r.counts.total + '</b> total \u00b7 Combined monthly cost: <b>\u20b9' + Number(r.monthly_cost_total_inr).toLocaleString('en-IN') + '</b>';
      tableWrap.innerHTML = '';
      const table = h('table', { style: { width: '100%', fontSize: '.83rem', borderCollapse: 'collapse' } });
      table.appendChild(h('thead', {}, h('tr', { style: { background: '#f8fafc' } },
        h('th', { style: { padding: '.4rem .55rem', textAlign: 'left' } }, 'Name'),
        h('th', { style: { padding: '.4rem .55rem', textAlign: 'left' } }, 'Email'),
        h('th', { style: { padding: '.4rem .55rem', textAlign: 'left' } }, 'Role'),
        h('th', { style: { padding: '.4rem .55rem', textAlign: 'right' } }, '\u20b9 / month'),
        h('th', { style: { padding: '.4rem .55rem', textAlign: 'center' } }, 'Active')
      )));
      const tbody = h('tbody', {});
      r.users.forEach(u => {
        const costInput = h('input', { type: 'number', step: '0.01', min: '0', value: String(u.monthly_cost_inr || 0), style: { width: '90px', padding: '.25rem .4rem', border: '1px solid #cbd5e1', borderRadius: '4px', textAlign: 'right', fontSize: '.8rem' } });
        const saveCostBtn = h('button', { type: 'button', class: 'btn xs', title: 'Save cost', style: { marginLeft: '.3rem' }, onclick: async () => {
          saveCostBtn.disabled = true;
          try {
            await api('api_saas_tenants_updateUserCost', { slug: t.slug, user_id: u.id, monthly_cost_inr: Number(costInput.value) || 0 });
            saveCostBtn.textContent = '\u2714';
            setTimeout(() => { saveCostBtn.textContent = '\ud83d\udcbe'; saveCostBtn.disabled = false; refresh(); }, 700);
          } catch (e) { toast(e.message, 'err'); saveCostBtn.disabled = false; }
        } }, '\ud83d\udcbe');
        tbody.appendChild(h('tr', { style: { borderTop: '1px solid #e2e8f0', opacity: Number(u.is_active) === 1 ? '1' : '.55' } },
          h('td', { style: { padding: '.35rem .55rem' } }, u.name),
          h('td', { style: { padding: '.35rem .55rem', color: '#475569' } }, u.email),
          h('td', { style: { padding: '.35rem .55rem' } },
            h('span', { style: { background: '#e0e7ff', color: '#3730a3', padding: '1px 7px', borderRadius: '999px', fontSize: '.7rem', fontWeight: 600 } }, u.role)),
          h('td', { style: { padding: '.35rem .55rem', textAlign: 'right' } }, costInput, saveCostBtn),
          h('td', { style: { padding: '.35rem .55rem', textAlign: 'center', color: Number(u.is_active) === 1 ? '#16a34a' : '#94a3b8' } }, Number(u.is_active) === 1 ? '\u2714' : '\u2715')
        ));
      });
      if (!r.users.length) tbody.appendChild(h('tr', {}, h('td', { colspan: 5, style: { padding: '1rem', color: '#94a3b8', textAlign: 'center' } }, 'No users yet \u2014 add one below.')));
      table.appendChild(tbody);
      tableWrap.appendChild(table);
    } catch (e) {
      tableWrap.innerHTML = '<div style="padding:1rem;color:#b91c1c">\u2717 ' + e.message + '</div>';
    }
  }

  m.appendChild(card);
  document.body.appendChild(m);
  refresh();
}

/* ============================================================
 * DEVICE_DIAG_v1 — "Device Health" super-admin tab
 * ============================================================ */
VIEWS.device_health = async function (view) {
  view.innerHTML = '';
  var header = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' } },
    h('h2', { style: { margin: 0 } }, 'Device Health — recording sync diagnosis'),
    h('button', { class: 'btn sm ghost', onclick: function () { VIEWS.device_health(view); } }, 'Refresh')
  );
  view.appendChild(header);

  var status = h('div', { style: { padding: '12px', color: '#666' } }, 'Loading tenants...');
  view.appendChild(status);

  var resp;
  try { resp = await api('api_saas_recHealth_overview', {}); }
  catch (e) { status.textContent = 'Error: ' + (e.message || e); return; }
  if (!resp || !resp.ok) { status.textContent = 'Error: ' + (resp && resp.error || 'unknown'); return; }
  status.remove();

  var rows = (resp.tenants || []).map(function (t) {
    var lastRec = t.last_rec_at ? new Date(t.last_rec_at).toLocaleString() : '-';
    var stale = t.last_rec_at ? ((Date.now() - Date.parse(t.last_rec_at)) > 3 * 24 * 60 * 60 * 1000) : true;
    return h('tr', {},
      h('td', {}, h('b', {}, t.name || t.slug), h('div', { style: { fontSize: '11px', color: '#888' } }, t.slug)),
      h('td', {}, String(t.users || 0)),
      h('td', {}, String(t.calls_24h || 0)),
      h('td', {}, String(t.recs_24h || 0)),
      h('td', { style: { color: stale ? '#c00' : '#080' } }, lastRec),
      h('td', {}, h('button', {
        class: 'btn sm',
        onclick: (function (slug) { return function () { VIEWS.deviceHealthTenant(view, slug); }; })(t.slug)
      }, 'Diagnose'))
    );
  });

  view.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Tenant'),
      h('th', {}, 'Users'),
      h('th', {}, 'Calls 24h'),
      h('th', {}, 'Recs 24h'),
      h('th', {}, 'Last recording'),
      h('th', {}, '')
    )),
    h('tbody', {}, rows)
  ));
};

VIEWS.deviceHealthTenant = async function (view, slug) {
  view.innerHTML = '';
  view.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
    h('button', { class: 'btn sm ghost', onclick: function () { VIEWS.device_health(view); } }, 'Back'),
    h('h2', { style: { margin: 0 } }, slug)
  ));
  var status = h('div', { style: { padding: '12px', color: '#666' } }, 'Diagnosing users...');
  view.appendChild(status);

  var resp;
  try { resp = await api('api_saas_recHealth_byTenant', { tenant_slug: slug }); }
  catch (e) { status.textContent = 'Error: ' + (e.message || e); return; }
  if (!resp || !resp.ok) { status.textContent = 'Error: ' + (resp && resp.error || 'unknown'); return; }
  status.remove();

  var s = resp.summary || {};
  /* DEVICE_HEALTH_FILTER_v1: clickable filter chips */
  if (!window._dhFilter) window._dhFilter = 'all';
  function mkPill(label, key, bg, fg, br) {
    var active = window._dhFilter === key;
    return h('div', {
      style: {
        padding: '8px 12px', background: bg, color: fg, borderRadius: '6px',
        border: '2px solid ' + (active ? fg : br), cursor: 'pointer',
        fontWeight: active ? 'bold' : 'normal'
      },
      onclick: function () { window._dhFilter = key; VIEWS.deviceHealthTenant(view, slug); }
    }, label);
  }
  view.appendChild(h('div', { style: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' } },
    mkPill((s.users_red || 0) + ' broken',  'red',    '#fee',   '#c00', '#fcc'),
    mkPill((s.users_yellow || 0) + ' warning', 'yellow', '#fff7e6', '#a60', '#fec'),
    mkPill((s.users_green || 0) + ' healthy',  'green',  '#e6fff0', '#080', '#cfc'),
    mkPill((s.users_total || 0) + ' all users',  'all',    '#eef',    '#234', '#dde')
  ));

  /* DEVICE_HEALTH_FILTER_v1: apply pill filter */
  var filtered = (resp.users || []).filter(function (u) {
    if (window._dhFilter === 'all') return true;
    return u.diagnosis && u.diagnosis.severity === window._dhFilter;
  });
  var userRows = filtered.map(function (u) {
    var sev = u.diagnosis && u.diagnosis.severity;
    var bg = sev === 'red' ? '#fff5f5' : sev === 'yellow' ? '#fffaf0' : '#f5fff5';
    var di = u.device_info || {};
    var deviceCell = di.model
      ? h('div', {},
          h('div', { style: { fontSize: '12px', fontWeight: 'bold' } }, (di.manufacturer ? di.manufacturer + ' ' : '') + (di.model || '')),
          h('div', { style: { fontSize: '10px', color: '#666' } }, (di.platform || '') + ' ' + (di.os_version || '')),
          di.app_version ? h('div', { style: { fontSize: '10px', color: '#888' } }, 'v' + di.app_version) : null
        )
      : h('span', { class: 'muted', style: { fontSize: '11px' } }, 'No telemetry yet');
    return h('tr', { style: { background: bg } },
      h('td', {}, h('b', {}, u.user_name || u.user_email), h('div', { style: { fontSize: '11px', color: '#888' } }, u.user_role || '')),
      h('td', {}, deviceCell),
      h('td', {},
        h('div', { style: { fontSize: '12px' } }, (u.diagnosis && u.diagnosis.message) || ''),
        h('div', { style: { fontSize: '10px', color: '#888', textTransform: 'uppercase' } }, 'Step: ' + ((u.diagnosis && u.diagnosis.step) || '?'))
      ),
      h('td', {}, u.days_since_login == null ? '-' : (u.days_since_login + 'd ago')),
      h('td', {}, u.days_since_call == null ? '-' : (u.days_since_call + 'd ago')),
      h('td', {}, u.days_since_recording == null ? '-' : (u.days_since_recording + 'd ago')),
      h('td', {}, (u.recordings_total || 0) + (u.recordings_matched_pct != null ? (' (' + u.recordings_matched_pct + '% matched)') : '')),
      h('td', {}, h('button', {
        class: 'btn sm ghost',
        onclick: (function (slug, uid, name) { return function () { VIEWS.deviceHealthUser(view, slug, uid, name); }; })(slug, u.user_id, u.user_name)
      }, 'Timeline'))
    );
  });

  view.appendChild(h('table', { class: 'tbl', style: { width: '100%' } },
    h('thead', {}, h('tr', {},
      h('th', {}, 'User'),
      h('th', {}, 'Device'),
      h('th', {}, 'Diagnosis'),
      h('th', {}, 'Login'),
      h('th', {}, 'Last call'),
      h('th', {}, 'Last rec'),
      h('th', {}, 'Recs'),
      h('th', {}, '')
    )),
    h('tbody', {}, userRows)
  ));
};

VIEWS.deviceHealthUser = async function (view, slug, userId, userName) {
  view.innerHTML = '';
  view.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
    h('button', { class: 'btn sm ghost', onclick: (function (s) { return function () { VIEWS.deviceHealthTenant(view, s); }; })(slug) }, 'Back'),
    h('h2', { style: { margin: 0 } }, (userName || 'user') + ' — event timeline')
  ));
  var status = h('div', { style: { padding: '12px', color: '#666' } }, 'Loading events...');
  view.appendChild(status);

  var resp;
  try { resp = await api('api_saas_devicediag_timeline', { tenant_slug: slug, user_id: userId, limit: 200 }); }
  catch (e) { status.textContent = 'Error: ' + (e.message || e); return; }
  if (!resp || !resp.ok) { status.textContent = 'Error: ' + (resp && resp.error || 'unknown'); return; }
  status.remove();

  var events = resp.events || [];
  if (!events.length) {
    var stats = resp.stats || {};
    var tenantTotal = Number(stats.tenant_total || 0);
    var distinctUsers = Number(stats.distinct_users || 0);
    var lastAt = stats.last_event_at ? new Date(stats.last_event_at).toLocaleString() : null;
    var box = h('div', { style: { padding: '20px', background: '#fffbe6', borderRadius: '6px', color: '#a60', border: '1px solid #fed' } });
    if (tenantTotal === 0) {
      box.appendChild(h('div', { style: { fontWeight: 'bold', marginBottom: '8px' } }, 'ℹ️ No telemetry from any user in this tenant yet'));
      box.appendChild(h('div', { style: { fontSize: '13px', lineHeight: '1.5' } },
        'The phone telemetry script is live. Events arrive within 60–90 seconds of a user opening the app (APK or browser). If nothing shows up, check:',
        h('ul', { style: { marginTop: '6px' } },
          h('li', {}, 'No user has opened the CRM in the last ~3 days (retention window). Ask any user to launch the APK or open ', h('code', {}, '/t/<tenant>/'), ' in a browser; the first heartbeat fires within ~60s.'),
          h('li', {}, 'The user closes the app immediately — telemetry needs ~60s of visible-tab time before the first heartbeat is sent.'),
          h('li', {}, 'Browser blocks localStorage / cookies (the auth token can\'t be read → no POST).')
        )
      ));
    } else {
      box.appendChild(h('div', { style: { fontWeight: 'bold', marginBottom: '8px' } }, 'No events for this specific user yet'));
      box.appendChild(h('div', { style: { fontSize: '13px', lineHeight: '1.5' } },
        'This tenant has telemetry flowing (', h('b', {}, String(tenantTotal)), ' events from ', h('b', {}, String(distinctUsers)), ' distinct users',
        lastAt ? '; last event ' + lastAt : '',
        ') — but this user has produced 0. Most likely: they haven’t opened the web SPA since the telemetry shipped, or they only use the APK.'
      ));
    }
    view.appendChild(box);
    return;
  }

  /* DEVICE_HEALTH_TIMELINE_v1: render each event as a human-readable row instead of raw JSON. */
  function _summarize(ev) {
    var p = ev.payload;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (_) { p = {}; } }
    p = p || {};
    var cap = p.capacitor || {};
    var dev = cap.device || {};
    var net = cap.network || {};
    var batt = cap.battery || {};
    var perms = p.perms || {};
    var bc = p.breadcrumbs || {};
    var parts = [];
    if (dev.model) parts.push((dev.manufacturer || '') + ' ' + dev.model + (dev.osVersion ? ' (Android ' + dev.osVersion + ')' : ''));
    if (dev.appVersion) parts.push('app v' + dev.appVersion);
    if (net.connectionType) parts.push('net: ' + net.connectionType);
    if (batt.batteryLevel != null) parts.push('battery: ' + Math.round(Number(batt.batteryLevel) * 100) + '%' + (batt.isCharging ? ' charging' : ''));
    var permFlags = [];
    if (perms.microphone)  permFlags.push('mic:' + perms.microphone);
    if (perms.geolocation) permFlags.push('geo:' + perms.geolocation);
    if (perms.notifications) permFlags.push('notif:' + perms.notifications);
    if (permFlags.length) parts.push('perms[' + permFlags.join(', ') + ']');
    if (bc.rec_last_sync_at) parts.push('last rec sync: ' + bc.rec_last_sync_at + (bc.rec_last_sync_count ? (' (' + bc.rec_last_sync_count + ' files)') : ''));
    if (bc.rec_last_sync_error) parts.push('rec err: ' + bc.rec_last_sync_error);
    if (bc.call_last_event_at) parts.push('last call evt: ' + bc.call_last_event_type + ' @ ' + bc.call_last_event_at);
    return parts.join(' · ') || '(no payload)';
  }
  function _eventLabel(ev) {
    var t = ev.event_type || '';
    if (t === 'app_open') return '🚀 App opened';
    if (t === 'heartbeat') return '💓 Heartbeat';
    if (t === 'resume') return '🔄 Resumed (after gap)';
    return t;
  }
  var rows = events.map(function (ev) {
    var bg = ev.severity === 'error' ? '#fff5f5' : ev.severity === 'warn' ? '#fffaf0' : '#fff';
    return h('tr', { style: { background: bg } },
      h('td', { style: { whiteSpace: 'nowrap' } }, new Date(ev.created_at).toLocaleString()),
      h('td', {}, h('b', {}, _eventLabel(ev)), h('div', { style: { fontSize: '10px', color: '#888' } }, ev.step || '')),
      h('td', { style: { fontSize: '11px', color: '#333' } }, _summarize(ev)),
      h('td', {}, h('details', {},
        h('summary', { style: { cursor: 'pointer', fontSize: '11px', color: '#888' } }, 'raw'),
        h('pre', { style: { fontFamily: 'monospace', fontSize: '10px', color: '#555', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
          (function () { try { return JSON.stringify(ev.payload || {}, null, 2); } catch (_) { return ''; } })())
      ))
    );
  });

  view.appendChild(h('table', { class: 'tbl', style: { width: '100%', fontSize: '12px' } },
    h('thead', {}, h('tr', {},
      h('th', {}, 'When'),
      h('th', {}, 'Event'),
      h('th', {}, 'Details'),
      h('th', {}, '')
    )),
    h('tbody', {}, rows)
  ));
};

/* DEVICE_DIAG_v1 — bootstrap removed in v2 (NAV entry handles it) */



// ============================================================
// FIN_DASH_v1 (2026-06-04) — Finance & Business Dashboard
// ============================================================
// Renders KPIs (MRR, ARR, this-month revenue, expiring tenants, etc.),
// a per-tenant sale table, and a 12-month revenue bar chart. All numbers
// are pulled fresh from the backend on every render — nothing cached.
// ============================================================
VIEWS.finance = async (view) => {
  view.appendChild(h('h1', {}, '💰 Finance & Business'));

  // FIN_DASH_DATE_v1 — date-range state (default: this month). Reload all
  // sections when changed.
  const RANGES = [
    ['today',       'Today'],
    ['yesterday',   'Yesterday'],
    ['this_week',   'This week'],
    ['this_month',  'This month'],
    ['last_month',  'Last month'],
    ['last_7',      'Last 7d'],
    ['last_30',     'Last 30d'],
    ['last_90',     'Last 90d'],
    ['this_quarter','This quarter'],
    ['this_year',   'This year'],
    ['last_year',   'Last year'],
    ['all',         'All time']
  ];
  let _finRange = { range: 'this_month' };
  function _rangePayload() { return Object.assign({}, _finRange); }

  // Date-range picker card (chips + custom From/To inputs)
  const rangeCard = h('div', { class: 'card', style: { padding: '.85rem 1rem' } });
  rangeCard.appendChild(h('div', { style: { fontWeight: '600', marginBottom: '.5rem', fontSize: '.9rem', color: '#475569' } }, '📅 Date range'));
  const chipRow = h('div', { style: { display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'center' } });
  RANGES.forEach(([tok, lbl]) => {
    const btn = h('button', { 'data-range': tok, class: 'btn' + (tok === 'this_month' ? ' primary' : ' ghost'),
      style: { padding: '.35rem .75rem', fontSize: '.82rem', borderRadius: '999px' },
      onclick: () => {
        _finRange = { range: tok };
        Array.from(chipRow.querySelectorAll('button[data-range]')).forEach(b => {
          b.className = 'btn ' + (b.dataset.range === tok ? 'primary' : 'ghost');
          b.style.padding = '.35rem .75rem'; b.style.fontSize = '.82rem'; b.style.borderRadius = '999px';
        });
        _updateRangeLabel(); if (typeof refreshAll === 'function') refreshAll();
      } }, lbl);
    chipRow.appendChild(btn);
  });
  // Custom from/to inputs
  const fromInp = h('input', { type: 'date', style: { padding: '.3rem .5rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '.82rem' } });
  const toInp   = h('input', { type: 'date', style: { padding: '.3rem .5rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '.82rem' } });
  const applyBtn = h('button', { class: 'btn primary',
    style: { padding: '.35rem .75rem', fontSize: '.82rem', borderRadius: '6px' },
    onclick: () => {
      if (!fromInp.value || !toInp.value) { alert('Pick both From and To dates'); return; }
      _finRange = { range: 'custom', from: fromInp.value, to: toInp.value };
      Array.from(chipRow.querySelectorAll('button[data-range]')).forEach(b => {
        b.className = 'btn ghost'; b.style.padding = '.35rem .75rem'; b.style.fontSize = '.82rem'; b.style.borderRadius = '999px';
      });
      _updateRangeLabel(); if (typeof refreshAll === 'function') refreshAll();
    } }, 'Apply');
  chipRow.appendChild(h('span', { class: 'muted', style: { marginLeft: '.75rem', fontSize: '.78rem' } }, '· Custom:'));
  chipRow.appendChild(fromInp);
  chipRow.appendChild(h('span', { style: { color: '#64748b' } }, '→'));
  chipRow.appendChild(toInp);
  chipRow.appendChild(applyBtn);
  rangeCard.appendChild(chipRow);
  // FIN_DASH_DATE_FIX_v1 — big "Showing: <range>" label so the user can
  // SEE the active filter at a glance. Updated whenever the chips change.
  const rangeLabel = h('div', {
    id: 'fin-range-label',
    style: { marginTop: '.5rem', fontSize: '.85rem', color: '#4338ca', fontWeight: '600' }
  }, '\ud83d\udcca Showing: This month');
  rangeCard.appendChild(rangeLabel);
  function _updateRangeLabel() {
    const labels = {
      today: 'Today', yesterday: 'Yesterday', this_week: 'This week',
      this_month: 'This month', last_month: 'Last month',
      last_7: 'Last 7 days', last_30: 'Last 30 days', last_90: 'Last 90 days',
      this_quarter: 'This quarter', this_year: 'This year', last_year: 'Last year',
      all: 'All time', custom: 'Custom: ' + (_finRange.from || '') + ' \u2192 ' + (_finRange.to || '')
    };
    rangeLabel.textContent = '\ud83d\udcca Showing: ' + (labels[_finRange.range] || _finRange.range);
  }
  view.appendChild(rangeCard);

  // Action bar
  const refreshBtn = h('button', { class: 'btn ghost' }, '↻ Refresh');
  const exportBtn  = h('button', { class: 'btn ghost', style: { marginLeft: '.5rem' } }, '📥 Export tenants CSV');
  view.appendChild(h('div', { class: 'card', style: { display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' } },
    h('div', { class: 'muted', style: { flex: '1' } }, 'Live numbers from the control DB. Click any tenant row to open it.'),
    refreshBtn, exportBtn
  ));

  // Containers we will populate after data loads
  const kpiCard      = h('div', { class: 'card' }, h('div', { class: 'muted' }, 'Loading overview…'));
  const chartCard    = h('div', { class: 'card' });
  const packageCard  = h('div', { class: 'card' });
  const expiringCard = h('div', { class: 'card' });
  const overdueCard  = h('div', { class: 'card' });
  const salesCard    = h('div', { class: 'card' });
  view.appendChild(kpiCard);
  view.appendChild(chartCard);
  view.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '.75rem' } },
    packageCard, expiringCard));
  view.appendChild(overdueCard);
  view.appendChild(salesCard);

  function kpi(label, value, hint, color) {
    // FIN_DASH_DATE_v1 — larger, clearer KPI cards
    return h('div', { style: {
      padding: '1rem 1.1rem',
      background: (color || '#f8fafc'),
      borderRadius: '12px',
      border: '1px solid rgba(15,23,42,.07)',
      boxShadow: '0 1px 2px rgba(15,23,42,.03)',
      minHeight: '90px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between'
    } },
      h('div', { style: { fontSize: '.72rem', textTransform: 'uppercase', letterSpacing: '.05em', color: '#64748b', fontWeight: '600' } }, label),
      h('div', { style: { fontSize: '1.7rem', fontWeight: '800', color: '#0f172a', lineHeight: '1.1', margin: '.35rem 0 .1rem' } }, value),
      hint ? h('div', { style: { fontSize: '.74rem', color: '#475569', fontWeight: '500' } }, hint) : null
    );
  }

  // ---- KPI cards ---------------------------------------------------
  async function loadOverview() {
    kpiCard.innerHTML = '';
    kpiCard.appendChild(h('div', { class: 'muted' }, 'Loading overview…'));
    let d;
    try { d = await api('api_saas_finance_overview', _rangePayload()); }
    catch (e) { kpiCard.innerHTML = ''; kpiCard.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
    kpiCard.innerHTML = '';

    kpiCard.appendChild(h('h2', { style: { marginTop: 0 } }, 'Revenue'));
    const revGrid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '.75rem' } });
    const r = d.revenue;
    const periodLabel = (d.period && d.period.label) ? d.period.label : 'This month';
    const pctVal = (r.delta_pct != null ? r.delta_pct : r.mom_pct);
    const deltaTxt = pctVal == null ? 'no prior period to compare' :
      (pctVal >= 0 ? '▲ ' : '▼ ') + Math.abs(pctVal).toFixed(1) + '% vs prior ' + periodLabel.toLowerCase();
    const periodPaid = (r.period_paid != null ? r.period_paid : r.this_month);
    const prevPaid   = (r.prev_paid   != null ? r.prev_paid   : r.last_month);
    revGrid.appendChild(kpi('MRR',  fmtRupees(r.mrr),  r.paying_tenants + ' paying tenants', '#ecfdf5'));
    revGrid.appendChild(kpi('ARR',  fmtRupees(r.arr),  '12 × MRR projection', '#ecfdf5'));
    revGrid.appendChild(kpi(periodLabel + ' (paid)', fmtRupees(periodPaid), deltaTxt,
      pctVal != null && pctVal < 0 ? '#fef2f2' : '#eff6ff'));
    revGrid.appendChild(kpi('Prior ' + periodLabel.toLowerCase(), fmtRupees(prevPaid), 'previous comparable window', '#f1f5f9'));
    revGrid.appendChild(kpi('Lifetime collected', fmtRupees(r.lifetime_paid), 'all paid invoices', '#fefce8'));
    kpiCard.appendChild(revGrid);

    kpiCard.appendChild(h('h2', { style: { marginTop: '1rem' } }, 'Tenants'));
    const tn = d.tenants;
    const tGrid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.75rem' } });
    tGrid.appendChild(kpi('Total tenants', tn.total));
    tGrid.appendChild(kpi('Active',        tn.active,    null, '#ecfdf5'));
    tGrid.appendChild(kpi('Trial',         tn.trial,     null, '#eff6ff'));
    tGrid.appendChild(kpi('Past due',      tn.past_due,  null, '#fff7ed'));
    tGrid.appendChild(kpi('Suspended',     tn.suspended, null, '#fef2f2'));
    tGrid.appendChild(kpi('New this month',     tn.new_this_month,     'signups since 1st', '#f0fdf4'));
    tGrid.appendChild(kpi('Expired this month', tn.expired_this_month, 'period ended, not renewed', '#fef2f2'));
    tGrid.appendChild(kpi('Churned this month', tn.churned_this_month, 'moved to deleted/suspended', '#fef2f2'));
    tGrid.appendChild(kpi('Expiring in 7 days',  tn.expiring_in_7,  null, '#fff7ed'));
    tGrid.appendChild(kpi('Expiring in 30 days', tn.expiring_in_30, null, '#fff7ed'));
    kpiCard.appendChild(tGrid);

    kpiCard.appendChild(h('h2', { style: { marginTop: '1rem' } }, 'Invoices'));
    const iv = d.invoices;
    const iGrid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '.75rem' } });
    iGrid.appendChild(kpi('Paid (lifetime)',   iv.paid_count));
    iGrid.appendChild(kpi('Pending',           iv.pending_count, fmtRupees(iv.pending_total) + ' open', '#fff7ed'));
    iGrid.appendChild(kpi('Overdue',           iv.overdue_count, fmtRupees(iv.overdue_total) + ' past due', '#fef2f2'));
    iGrid.appendChild(kpi('Failed payments',   iv.failed_count, null, '#fef2f2'));
    kpiCard.appendChild(iGrid);

    kpiCard.appendChild(h('div', { class: 'muted', style: { marginTop: '.6rem', fontSize: '.72rem' } },
      'Generated ' + new Date(d.generated_at).toLocaleString('en-IN')));
  }

  // ---- Revenue by month — simple SVG bar chart ---------------------
  async function loadChart() {
    chartCard.innerHTML = '';
    chartCard.appendChild(h('h2', { style: { marginTop: 0 } }, 'Revenue — last 12 months'));
    chartCard.appendChild(h('div', { class: 'muted' }, 'Loading…'));
    let d;
    try { d = await api('api_saas_finance_revenueByMonth'); }
    catch (e) { chartCard.innerHTML = '<div class="error-box">' + e.message + '</div>'; return; }
    chartCard.innerHTML = '';
    chartCard.appendChild(h('h2', { style: { marginTop: 0 } }, 'Revenue — last 12 months'));
    const rows = d.rows || [];
    if (!rows.length) { chartCard.appendChild(h('div', { class: 'muted' }, 'No data.')); return; }
    const max = Math.max(1, ...rows.map(r => Number(r.paid_total) || 0));
    const w = 760, h_ = 220, pad = 30, bw = (w - pad * 2) / rows.length;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h_);
    svg.setAttribute('style', 'width:100%; height:auto; max-width:760px');
    rows.forEach((r, i) => {
      const v = Number(r.paid_total) || 0;
      const bh = (v / max) * (h_ - pad * 2);
      const x = pad + i * bw + bw * 0.1;
      const y = h_ - pad - bh;
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x); rect.setAttribute('y', y);
      rect.setAttribute('width', bw * 0.8); rect.setAttribute('height', Math.max(0, bh));
      rect.setAttribute('fill', '#4f46e5'); rect.setAttribute('rx', '3');
      const ttl = document.createElementNS(svgNS, 'title');
      ttl.textContent = r.month + ': ' + fmtRupees(v) + ' (' + r.paid_count + ' invoice' + (r.paid_count === 1 ? '' : 's') + ')';
      rect.appendChild(ttl);
      svg.appendChild(rect);
      const lbl = document.createElementNS(svgNS, 'text');
      lbl.setAttribute('x', x + bw * 0.4); lbl.setAttribute('y', h_ - pad + 14);
      lbl.setAttribute('text-anchor', 'middle');
      lbl.setAttribute('font-size', '9'); lbl.setAttribute('fill', '#64748b');
      lbl.textContent = (r.month || '').slice(2); // YY-MM
      svg.appendChild(lbl);
    });
    chartCard.appendChild(svg);
    // Total below
    const total = rows.reduce((s, r) => s + (Number(r.paid_total) || 0), 0);
    chartCard.appendChild(h('div', { class: 'muted', style: { fontSize: '.78rem' } },
      '12-month total: ' + fmtRupees(total)));
  }

  // ---- By package -------------------------------------------------
  async function loadPackages() {
    packageCard.innerHTML = '';
    packageCard.appendChild(h('h2', { style: { marginTop: 0 } }, 'By package'));
    let d;
    try { d = await api('api_saas_finance_byPackage'); }
    catch (e) { packageCard.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
    if (!(d.rows && d.rows.length)) { packageCard.appendChild(h('div', { class: 'muted' }, 'No packages.')); return; }
    packageCard.appendChild(h('table', { class: 'data-table', style: { width: '100%' } },
      h('thead', {}, h('tr', {}, h('th', {}, 'Package'), h('th', {}, 'Tenants'),
        h('th', {}, 'Active'), h('th', {}, 'Trial'),
        h('th', {}, '₹/mo each'), h('th', {}, 'MRR'),
        h('th', {}, 'Lifetime ₹'))),
      h('tbody', {}, ...d.rows.map(r => h('tr', {},
        h('td', {}, r.name),
        h('td', {}, r.tenant_count),
        h('td', {}, r.active_count),
        h('td', {}, r.trial_count),
        h('td', {}, fmtRupees(r.monthly_per_tenant)),
        h('td', { style: { fontWeight: '600' } }, fmtRupees(r.mrr_contribution)),
        h('td', {}, fmtRupees(r.lifetime_paid))
      )))
    ));
  }

  // ---- Expiring soon (next 30 days) -------------------------------
  async function loadExpiring() {
    expiringCard.innerHTML = '';
    expiringCard.appendChild(h('h2', { style: { marginTop: 0 } }, '⚠ Expiring in 30 days'));
    let d;
    try { d = await api('api_saas_finance_expiringSoon', { days: 30 }); }
    catch (e) { expiringCard.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
    if (!(d.rows && d.rows.length)) {
      expiringCard.appendChild(h('div', { class: 'muted' }, 'No tenants expiring in the next 30 days.'));
      return;
    }
    expiringCard.appendChild(h('table', { class: 'data-table', style: { width: '100%', fontSize: '.84rem' } },
      h('thead', {}, h('tr', {}, h('th', {}, 'Tenant'),
        h('th', {}, 'Package'), h('th', {}, 'Expires'), h('th', {}, 'In'), h('th', {}, '₹/mo'))),
      h('tbody', {}, ...d.rows.map(r => h('tr', {
          style: r.days_to_expiry <= 7 ? { background: '#fff7ed' } : {}
        },
        h('td', {}, h('a', { href: '#/tenants', style: { color: '#4f46e5', fontWeight: '500' } }, r.org_name),
          h('div', { class: 'muted', style: { fontSize: '.72rem' } }, r.slug)),
        h('td', {}, r.package || '—'),
        h('td', {}, fmtDate(r.current_period_end)),
        h('td', { style: { color: r.days_to_expiry <= 7 ? '#dc2626' : '#92400e', fontWeight: '600' } },
          r.days_to_expiry + 'd'),
        h('td', {}, fmtRupees(r.monthly_value))
      )))
    ));
  }

  // ---- Overdue invoices -------------------------------------------
  async function loadOverdue() {
    overdueCard.innerHTML = '';
    overdueCard.appendChild(h('h2', { style: { marginTop: 0 } }, '🧾 Overdue invoices'));
    let d;
    try { d = await api('api_saas_finance_overdueInvoices'); }
    catch (e) { overdueCard.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
    if (!(d.rows && d.rows.length)) {
      overdueCard.appendChild(h('div', { class: 'muted' }, 'No overdue invoices. 🎉'));
      return;
    }
    overdueCard.appendChild(h('table', { class: 'data-table', style: { width: '100%' } },
      h('thead', {}, h('tr', {}, h('th', {}, 'Invoice #'),
        h('th', {}, 'Tenant'), h('th', {}, 'Amount'),
        h('th', {}, 'Period end'), h('th', {}, 'Days overdue'))),
      h('tbody', {}, ...d.rows.map(r => h('tr', { style: { background: '#fef2f2' } },
        h('td', {}, r.number),
        h('td', {}, r.tenant_name || '—',
          h('div', { class: 'muted', style: { fontSize: '.72rem' } }, r.tenant_slug || '')),
        h('td', { style: { fontWeight: '600' } }, fmtRupees(r.total_inr)),
        h('td', {}, fmtDate(r.period_end || r.created_at)),
        h('td', { style: { color: '#dc2626', fontWeight: '600' } }, r.overdue_days + 'd')
      )))
    ));
  }

  // ---- Tenant-wise sale table -------------------------------------
  let salesData = null;
  async function loadSales() {
    salesCard.innerHTML = '';
    salesCard.appendChild(h('h2', { style: { marginTop: 0 } }, '🏢 Tenant-wise sale'));

    const statusSel = h('select', {},
      h('option', { value: '' }, 'All statuses'),
      ...['active','trial','past_due','suspended','pending_delete','pending_payment','deleted']
        .map(s => h('option', { value: s }, s))
    );
    const qInp = h('input', { type: 'search', placeholder: 'Search org / email / slug…', style: { minWidth: '14rem' } });
    const applyBtn = h('button', { class: 'btn sm' }, 'Apply');
    salesCard.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', marginBottom: '.6rem', flexWrap: 'wrap' } },
      statusSel, qInp, applyBtn));

    const tblWrap = h('div', { style: { overflowX: 'auto' } });
    salesCard.appendChild(tblWrap);

    async function reload() {
      tblWrap.innerHTML = '<div class="muted">Loading…</div>';
      try {
        const filt = Object.assign({ status: statusSel.value || null, q: qInp.value.trim() || null }, _rangePayload());
        const d = await api('api_saas_finance_tenantSales', filt);
        salesData = d;
        renderTable(d.rows || []);
      } catch (e) { tblWrap.innerHTML = ''; tblWrap.appendChild(h('div', { class: 'error-box' }, e.message)); }
    }
    function renderTable(rows) {
      tblWrap.innerHTML = '';
      if (!rows.length) { tblWrap.appendChild(h('div', { class: 'muted' }, 'No tenants match.')); return; }
      const tbl = h('table', { class: 'data-table', style: { width: '100%', fontSize: '.85rem' } },
        h('thead', {}, h('tr', {}, h('th', {}, 'Tenant'), h('th', {}, 'Package'),
          h('th', {}, 'Status'), h('th', {}, 'Created'),
          h('th', {}, 'Period end'), h('th', {}, 'Days'),
          h('th', {}, '₹/mo'), h('th', {}, '₹/yr'),
          h('th', { style: { background:'#eef2ff', color:'#4338ca' }, title: 'Filtered by selected date range' }, '₹ in period'),
          h('th', { style: { background:'#eef2ff', color:'#4338ca' }, title: 'Filtered by selected date range' }, '# in period'),
          h('th', {}, 'Lifetime ₹'), h('th', {}, '# paid'),
          h('th', {}, 'Pending ₹'), h('th', {}, 'Last paid'))),
        h('tbody', {}, ...rows.map(r => h('tr', {},
          h('td', {}, h('a', { href: '#/tenants', style: { color: '#4f46e5', fontWeight: '500' } }, r.org_name),
            h('div', { class: 'muted', style: { fontSize: '.72rem' } }, r.slug + ' · ' + (r.contact_email || ''))),
          h('td', {}, r.package || '—'),
          h('td', {}, h('span', { class: 'pill pill-' + (r.status || ''), style: { fontSize: '.72rem' } }, r.status)),
          h('td', {}, fmtDate(r.created_at)),
          h('td', {}, fmtDate(r.current_period_end)),
          h('td', { style: {
              color: r.days_to_expiry == null ? '#94a3b8'
                : r.days_to_expiry < 0 ? '#dc2626'
                : r.days_to_expiry <= 7 ? '#92400e'
                : '#0f172a',
              fontWeight: '500'
            } },
            r.days_to_expiry == null ? '—' : r.days_to_expiry + 'd'),
          h('td', {}, fmtRupees(r.monthly_value)),
          h('td', {}, fmtRupees(r.annual_value)),
          h('td', { style: { fontWeight: '700', background: r.period_paid > 0 ? '#eef2ff' : '#f8fafc', color: r.period_paid > 0 ? '#4338ca' : '#94a3b8' } }, fmtRupees(r.period_paid)),
          h('td', { style: { background: r.period_paid_count > 0 ? '#eef2ff' : '#f8fafc', color: r.period_paid_count > 0 ? '#4338ca' : '#94a3b8' } }, r.period_paid_count || 0),
          h('td', { style: { fontWeight: '600' } }, fmtRupees(r.lifetime_paid)),
          h('td', {}, r.paid_count),
          h('td', { style: { color: r.pending_total > 0 ? '#92400e' : '#94a3b8' } }, fmtRupees(r.pending_total)),
          h('td', {}, fmtDate(r.last_paid_at))
        )))
      );
      tblWrap.appendChild(tbl);
      tblWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '.72rem', marginTop: '.4rem' } },
        rows.length + ' tenants'));
    }
    applyBtn.onclick = reload;
    qInp.addEventListener('keydown', ev => { if (ev.key === 'Enter') reload(); });
    reload();
  }

  // ---- Export tenants CSV (uses last loaded sales table) -----------
  exportBtn.onclick = () => {
    if (!salesData || !salesData.rows || !salesData.rows.length) {
      toast('Load the tenant table first', 'error'); return;
    }
    const cols = ['org_name','slug','contact_email','status','package',
      'created_at','current_period_end','days_to_expiry',
      'monthly_value','annual_value','lifetime_paid','paid_count',
      'pending_total','last_paid_at'];
    const esc = v => v == null ? '' : ('"' + String(v).replace(/"/g, '""') + '"');
    const lines = [cols.join(',')];
    salesData.rows.forEach(r => lines.push(cols.map(c => esc(r[c])).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'tenant-sales-' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- Refresh everything -----------------------------------------
  function refreshAll() { try { loadOverview(); loadChart(); loadPackages(); loadExpiring(); loadOverdue(); loadSales && loadSales(); } catch(_){} }
  refreshBtn.onclick = () => Promise.all([loadOverview(), loadChart(), loadPackages(), loadExpiring(), loadOverdue(), loadSales()]);
  // Initial parallel load
  loadOverview(); loadChart(); loadPackages(); loadExpiring(); loadOverdue(); loadSales();
};

// ─────────────────────────────────────────────────────────────
// WL_BILLING_v1 — White-label customer billing tab.
// ─────────────────────────────────────────────────────────────
VIEWS.wl_billing = async (view) => {
  view.innerHTML = '';
  view.appendChild(h('h1', {}, '🏷️ White-Label Billing'));
  view.appendChild(h('p', { style: { color: '#64748b', marginTop: '-8px' } },
    'Track agencies who bought the white-label CRM. Generate monthly invoices, send WhatsApp reminders, and collect payments via Cashfree.'));
  const summary = await api('api_saas_wl_summary').catch(() => null);
  const wlFmt = n => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  if (summary) {
    const kpis = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '14px', margin: '16px 0' } });
    [
      ['Active customers',     summary.active_customers, '#6366f1'],
      ['MRR',                  wlFmt(summary.mrr), '#10b981'],
      ['Outstanding balance',  wlFmt(summary.total_balance), '#dc2626'],
      ['Lifetime revenue',     wlFmt(summary.lifetime_revenue), '#0ea5e9'],
      ['Collected this month', wlFmt(summary.this_month_collected), '#16a34a'],
      ['Pending invoices',     summary.pending_this_month + ' / ' + summary.month, '#f59e0b']
    ].forEach(function(arr) {
      const label = arr[0], value = arr[1], color = arr[2];
      kpis.appendChild(h('div', { style: { background: '#fff', padding: '14px 16px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(15,23,42,.08)', borderLeft: '4px solid ' + color } },
        h('div', { style: { fontSize: '.72rem', color: '#64748b', textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: '600' } }, label),
        h('div', { style: { fontSize: '1.4rem', fontWeight: '700', marginTop: '4px', color: color } }, value)
      ));
    });
    view.appendChild(kpis);
  }
  const actions = h('div', { style: { display: 'flex', gap: '8px', margin: '12px 0', flexWrap: 'wrap' } },
    h('button', { class: 'btn primary', onclick: function(){ _wlOpenCustomerModal(null); } }, '+ Add Customer'),
    h('button', {
      class: 'btn',
      style: { background: '#7c3aed', color: '#fff', border: 0 },
      title: 'Manually trigger the billing cron (normally runs at 9am IST). Generates invoices for every customer whose billing_day == today, and auto-sends WhatsApp.',
      onclick: async function() {
        if (!confirm('Run the billing cron NOW?\n\nFor every active customer whose billing day = today, this will:\n  1. Generate this month\u2019s invoice (if not already)\n  2. Auto-send the invoice via WhatsApp')) return;
        try {
          const r = await api('api_saas_wl_runBillingCronNow', {});
          alert('Billing run complete.\n\nCustomers due today: ' + r.due_today +
                '\nInvoices generated: ' + (r.generated || []).length +
                '\nInvoices sent: ' + (r.sent || []).length +
                ((r.errors && r.errors.length) ? '\nErrors: ' + r.errors.length : ''));
          navigate('wl_billing');
        } catch (e) { alert(e.message); }
      }
    }, '\u26a1 Run Billing Now'),
    h('button', { class: 'btn', onclick: async function() {
      if (!confirm('Generate this-month invoices for ALL active customers? (Skips customers who already have an invoice for this month.)')) return;
      try {
        const r = await api('api_saas_wl_invoices_generateMonth', null);
        alert('Generated ' + r.count + ' invoices for ' + r.month + '. Skipped: ' + r.skipped.length);
        navigate('wl_billing');
      } catch (e) { alert(e.message); }
    } }, 'Generate Monthly Invoices'),
    h('button', { class: 'btn', onclick: function(){ _wlOpenSettingsModal(); } }, 'WhatsApp Settings')
  );
  view.appendChild(actions);
  const listBox = h('div', { id: 'wl-list', style: { marginTop: '14px' } }, 'Loading customers…');
  view.appendChild(listBox);
  try {
    const customers = await api('api_saas_wl_customers_list');
    listBox.innerHTML = '';
    if (!customers.length) {
      listBox.appendChild(h('div', { style: { padding: '40px', textAlign: 'center', color: '#94a3b8', background: '#fff', borderRadius: '12px' } },
        'No customers yet. Click "Add Customer" to start.'));
      return;
    }
    customers.forEach(function(c){ listBox.appendChild(_wlCustomerCard(c, wlFmt)); });
  } catch (e) {
    listBox.innerHTML = '';
    listBox.appendChild(h('div', { style: { padding: '20px', background: '#fee2e2', color: '#991b1b', borderRadius: '8px' } }, 'Failed to load: ' + e.message));
  }
};

function _wlCustomerCard(c, wlFmt) {
  const portalUrl = location.origin + '/wl/portal/' + c.portal_token;
  const borderColor = c.status === 'churned' ? '#94a3b8' : c.balance > 0 ? '#f59e0b' : '#10b981';
  return h('div', {
    style: { background: '#fff', borderRadius: '12px', padding: '16px', boxShadow: '0 1px 3px rgba(15,23,42,.08)', marginBottom: '12px', borderLeft: '4px solid ' + borderColor }
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' } },
      h('div', { style: { flex: '1', minWidth: '220px' } },
        h('div', { style: { fontSize: '1.05rem', fontWeight: '700' } }, c.company_name,
          c.status !== 'active' ? h('span', { style: { fontSize: '.7rem', background: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '99px', marginLeft: '8px', fontWeight: '500' } }, c.status) : null
        ),
        h('div', { style: { fontSize: '.85rem', color: '#64748b', marginTop: '4px' } },
          (c.contact_name || '') + (c.contact_name ? ' • ' : '') + c.phone +
          (c.total_users ? ' • ' + c.total_users + ' users' : '') +
          ' • ' + (c.product_name || 'CRM')
        )
      ),
      h('div', { style: { display: 'flex', gap: '20px', textAlign: 'right', flexWrap: 'wrap' } },
        h('div', {}, h('div', { style: { fontSize: '.68rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: '600' } }, 'Monthly'), h('div', { style: { fontWeight: '700' } }, wlFmt(c.monthly_amount))),
        h('div', {}, h('div', { style: { fontSize: '.68rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: '600' } }, 'Paid'),    h('div', { style: { fontWeight: '700', color: '#16a34a' } }, wlFmt(c.total_paid))),
        h('div', {}, h('div', { style: { fontSize: '.68rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: '600' } }, 'Balance'), h('div', { style: { fontWeight: '700', color: c.balance > 0 ? '#dc2626' : '#64748b' } }, wlFmt(c.balance))),
        h('div', { title: 'Next invoice generates on this day (per billing_day = ' + c.billing_day + ')' },
          h('div', { style: { fontSize: '.68rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: '600' } }, '\ud83d\udcc5 Next Due'),
          h('div', { style: { fontWeight: '700', color: '#4338ca' } }, c.next_due_date || c.scheduled_next_due || ('Day ' + c.billing_day))
        )
      )
    ),
    h('div', { style: { display: 'flex', gap: '6px', marginTop: '12px', flexWrap: 'wrap' } },
      h('button', { class: 'btn', onclick: function(){ _wlOpenCustomerModal(c); } }, 'Edit'),
      h('button', { class: 'btn', onclick: function(){ _wlOpenInvoicesModal(c, wlFmt); } }, 'Invoices'),
      h('button', { class: 'btn', onclick: function(){ _wlOpenPaymentModal(c); } }, 'Record Payment'),
      h('button', { class: 'btn', onclick: async function() {
        if (!confirm('Generate this-month invoice for ' + c.company_name + '?')) return;
        try {
          const r = await api('api_saas_wl_invoices_generateMonth', Number(c.id));
          alert(r.count ? 'Invoice generated' : 'Already exists for this month');
          navigate('wl_billing');
        } catch (e) { alert(e.message); }
      } }, 'New Invoice'),
      h('a', { href: portalUrl, target: '_blank', class: 'btn', style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' } }, 'Portal')
    )
  );
}

function _wlOpenCustomerModal(c) {
  const isEdit = !!c;
  const f = c || { status: 'active', currency: 'INR', billing_day: 1, monthly_amount: 0 };
  function inp(label, key, type, opts) {
    return h('div', { style: { marginBottom: '12px' } },
      h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, label),
      h('input', Object.assign({ type: type || 'text', value: f[key] != null ? f[key] : '', 'data-k': key, style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } }, opts || {}))
    );
  }
  function sel(label, key, options) {
    return h('div', { style: { marginBottom: '12px' } },
      h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, label),
      h('select', { 'data-k': key, style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } },
        options.map(function(o){ return h('option', { value: o, selected: f[key] === o }, o); }))
    );
  }
  const overlay = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' } },
    h('div', { style: { background: '#fff', borderRadius: '14px', maxWidth: '520px', width: '100%', padding: '20px', maxHeight: '90vh', overflowY: 'auto' } },
      h('h3', { style: { margin: '0 0 14px' } }, isEdit ? 'Edit Customer' : 'New White-Label Customer'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
        inp('Company name *', 'company_name'),
        inp('Contact name', 'contact_name')
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
        inp('Phone (with +91) *', 'phone'),
        inp('Email', 'email', 'email')
      ),
      inp('Product name (e.g. SmartCRM White Label)', 'product_name'),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
        inp('Total users', 'total_users', 'number', { min: '0' }),
        inp('Monthly ₹', 'monthly_amount', 'number', { min: '0', step: '0.01' }),
        inp('Billing day (1-28)', 'billing_day', 'number', { min: '1', max: '28' })
      ),
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' } },
        inp('Already paid ₹', 'total_paid', 'number', { min: '0', step: '0.01' }),
        inp('Opening balance ₹', 'balance', 'number', { step: '0.01' }),
        sel('Status', 'status', ['active', 'paused', 'churned'])
      ),
      h('div', { style: { marginBottom: '12px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'Notes'),
        h('textarea', { 'data-k': 'notes', rows: '2', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } }, f.notes || '')
      ),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: function(){ overlay.remove(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async function() {
          const payload = isEdit ? { id: c.id } : {};
          overlay.querySelectorAll('[data-k]').forEach(function(el){ payload[el.dataset.k] = el.value; });
          try {
            await api('api_saas_wl_customers_save', payload);
            overlay.remove();
            navigate('wl_billing');
          } catch (e) { alert(e.message); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(overlay);
}

async function _wlOpenInvoicesModal(c, wlFmt) {
  const invoices = await api('api_saas_wl_invoices_listForCustomer', Number(c.id)).catch(function(){ return []; });
  const portalUrl = location.origin + '/wl/portal/' + c.portal_token;
  const overlay = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' } },
    h('div', { style: { background: '#fff', borderRadius: '14px', maxWidth: '720px', width: '100%', padding: '20px', maxHeight: '90vh', overflowY: 'auto' } },
      h('h3', { style: { margin: '0 0 6px' } }, c.company_name + ' — Invoices'),
      h('div', { style: { fontSize: '.8rem', color: '#64748b', marginBottom: '14px' } }, 'Portal: ',
        h('a', { href: portalUrl, target: '_blank', style: { color: '#6366f1' } }, portalUrl)
      ),
      !invoices.length ? h('div', { style: { padding: '20px', textAlign: 'center', color: '#94a3b8' } }, 'No invoices yet.') :
      h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '.85rem' } },
        h('thead', {}, h('tr', { style: { borderBottom: '1px solid #e2e8f0' } },
          h('th', { style: { textAlign: 'left', padding: '8px' } }, 'Invoice'),
          h('th', { style: { textAlign: 'left', padding: '8px' } }, 'Month'),
          h('th', { style: { textAlign: 'right', padding: '8px' } }, 'Amount'),
          h('th', { style: { textAlign: 'center', padding: '8px' } }, 'Status'),
          h('th', { style: { textAlign: 'right', padding: '8px' } }, 'Actions')
        )),
        h('tbody', {}, invoices.map(function(i){
          return h('tr', { style: { borderBottom: '1px solid #f1f5f9' } },
            h('td', { style: { padding: '8px' } }, i.invoice_no),
            h('td', { style: { padding: '8px' } }, i.period_month),
            h('td', { style: { padding: '8px', textAlign: 'right' } }, wlFmt(i.amount)),
            h('td', { style: { padding: '8px', textAlign: 'center' } }, i.status),
            h('td', { style: { padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' } },
              i.status === 'paid' ? h('span', { style: { color: '#16a34a' } }, 'Paid') :
              h('button', { class: 'btn', style: { fontSize: '.78rem', padding: '4px 8px' }, onclick: async function(e) {
                e.target.disabled = true; e.target.textContent = 'Sending...';
                try {
                  await api('api_saas_wl_invoices_sendWA', Number(i.id), 'invoice');
                  e.target.textContent = 'Sent';
                } catch (err) { e.target.disabled = false; e.target.textContent = 'WA Send'; alert(err.message); }
              } }, 'WA Send')
            )
          );
        }))
      ),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '14px' } },
        h('button', { class: 'btn', onclick: function(){ overlay.remove(); } }, 'Close')
      )
    )
  );
  document.body.appendChild(overlay);
}

function _wlOpenPaymentModal(c) {
  const overlay = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' } },
    h('div', { style: { background: '#fff', borderRadius: '14px', maxWidth: '460px', width: '100%', padding: '20px' } },
      h('h3', { style: { margin: '0 0 12px' } }, 'Record Payment'),
      h('div', { style: { fontSize: '.85rem', color: '#64748b', marginBottom: '14px' } }, c.company_name),
      h('div', { style: { marginBottom: '10px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'Amount (₹)'),
        h('input', { type: 'number', id: 'pay-amt', step: '0.01', min: '0', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } })
      ),
      h('div', { style: { marginBottom: '10px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'Method'),
        h('select', { id: 'pay-method', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } },
          ['bank','upi','cash','cashfree','other'].map(function(m){ return h('option', { value: m }, m); })
        )
      ),
      h('div', { style: { marginBottom: '14px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'Reference (tx id, UTR)'),
        h('input', { type: 'text', id: 'pay-ref', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } })
      ),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: function(){ overlay.remove(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async function() {
          const amt = Number(document.getElementById('pay-amt').value);
          if (!(amt > 0)) { alert('Enter a positive amount'); return; }
          try {
            await api('api_saas_wl_invoices_recordPayment', {
              customer_id: c.id, amount: amt,
              method:    document.getElementById('pay-method').value,
              reference: document.getElementById('pay-ref').value
            });
            overlay.remove();
            navigate('wl_billing');
          } catch (e) { alert(e.message); }
        } }, 'Record')
      )
    )
  );
  document.body.appendChild(overlay);
}

async function _wlOpenSettingsModal() {
  const cur = await api('api_saas_wl_settingsGet').catch(function(){ return {}; });
  const overlay = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.5)', zIndex: '9999', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' } },
    h('div', { style: { background: '#fff', borderRadius: '14px', maxWidth: '520px', width: '100%', padding: '20px' } },
      h('h3', { style: { margin: '0 0 6px' } }, 'White-Label WhatsApp Settings'),
      h('p', { style: { fontSize: '.8rem', color: '#64748b', marginTop: '0' } }, 'Single WhatsApp Cloud API number that this module uses to send invoices and reminders to all your white-label customers.'),
      h('div', { style: { marginBottom: '12px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'WhatsApp phone_number_id'),
        h('input', { type: 'text', id: 'wl-pid', value: cur.WL_WA_PHONE_NUMBER_ID || '', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } })
      ),
      h('div', { style: { marginBottom: '12px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'WhatsApp Access Token ' + (cur.WL_WA_ACCESS_TOKEN_MASKED ? '(current: ' + cur.WL_WA_ACCESS_TOKEN_MASKED + ')' : '')),
        h('input', { type: 'text', id: 'wl-tok', placeholder: 'Paste fresh token to update', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } })
      ),
      h('div', { style: { marginBottom: '14px' } },
        h('label', { style: { display: 'block', fontSize: '.75rem', color: '#64748b', fontWeight: '600', marginBottom: '4px' } }, 'Portal base URL'),
        h('input', { type: 'text', id: 'wl-base', value: cur.WL_PORTAL_BASE_URL || location.origin, style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '8px' } })
      ),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: function(){ overlay.remove(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async function() {
          try {
            await api('api_saas_wl_settingsSave', {
              WL_WA_PHONE_NUMBER_ID: document.getElementById('wl-pid').value,
              WL_WA_ACCESS_TOKEN:    document.getElementById('wl-tok').value,
              WL_PORTAL_BASE_URL:    document.getElementById('wl-base').value
            });
            overlay.remove();
            alert('Saved.');
          } catch (e) { alert(e.message); }
        } }, 'Save')
      )
    )
  );
  document.body.appendChild(overlay);
}
