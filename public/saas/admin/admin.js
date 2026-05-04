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
  { id: 'packages',      label: '📦 Packages' },
  { id: 'invoices',      label: '🧾 Invoices' },
  { id: 'webhooks',      label: '📡 Webhook Logs' },
  { id: 'errors',        label: '🐞 Errors' },
  { id: 'announcements', label: '📣 Updates' },
  { id: 'requirements',  label: '🛠 Custom Requirements' },
  { id: 'admins',        label: '👥 Super Assistants' },
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
  view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

function editPackage(p) {
  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
  const card = h('div', { class: 'modal' });
  card.appendChild(h('div', { class: 'modal-head' },
    h('h3', {}, p.id ? 'Edit package' : 'New package'),
    h('button', { class: 'x', onclick: () => m.remove() }, '✕')
  ));
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
    h('div', { class: 'field' }, h('label', {}, 'Quotas (JSON, e.g. {"users":{"limit":5,"extra_inr":50}})'),
      h('textarea', { name: 'quotas', rows: 3 }, typeof p.quotas === 'string' ? p.quotas : JSON.stringify(p.quotas || {}, null, 2))),
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
    h('button', { class: 'btn primary', onclick: () => openCreateTenant() }, '+ Create tenant')
  ));
  let list;
  try { list = await api('api_saas_tenants_list', {}); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
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
      h('td', {}, h('b', {}, t.org_name)),
      h('td', {}, h('a', { href: '/t/' + t.slug, target: '_blank' }, '/t/' + t.slug)),
      h('td', { class: 'muted' }, t.contact_email),
      h('td', {}, t.package_name || '—'),
      h('td', {}, h('span', { class: 'tag ' + (t.status === 'active' ? 'ok' : t.status === 'pending_delete' ? 'err' : 'warn') }, t.status)),
      h('td', { class: 'muted' }, fmtDate(t.current_period_end)),
      h('td', { style: { textAlign: 'right' } },
        t.status === 'active'
          ? h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_tenants_suspend', t.id); navigate('tenants'); } }, 'Suspend')
          : h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_tenants_restore', t.id); navigate('tenants'); } }, 'Restore')
      )
    )))
  );
  view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

async function openCreateTenant() {
  // Need the package list so the operator can pick a plan.
  let pkgs = [];
  try { pkgs = await api('api_saas_packages_list'); }
  catch (e) { toast(e.message, 'err'); return; }
  if (!pkgs.length) { toast('Add a package first (Packages tab) before creating a tenant.', 'err'); return; }

  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
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
    ...pkgs.map(p => h('option', { value: p.id }, p.name + ' · ₹' + Number(p.base_price_inr || 0).toLocaleString('en-IN')))
  );
  form.appendChild(field('Package *', pkgSel));
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
  m.appendChild(card);
  document.body.appendChild(m);
  setTimeout(() => form.querySelector('input[name=name]').focus(), 50);
}

async function _submitCreateTenant(form, pkgs, modal) {
  const btn = form.querySelector('#create-tenant-btn');
  const setBtn = (txt, dis) => { btn.textContent = txt; btn.disabled = !!dis; };
  setBtn('Creating…', true);
  const fd = new FormData(form);
  const payload = {
    name:         (fd.get('name') || '').toString().trim(),
    email:        (fd.get('email') || '').toString().trim(),
    mobile:       (fd.get('mobile') || '').toString().trim(),
    org_name:     (fd.get('org_name') || '').toString().trim(),
    desired_slug: (fd.get('desired_slug') || '').toString().trim().toLowerCase(),
    package_id:   Number(fd.get('package_id')) || 0,
    notes:        (fd.get('notes') || '').toString().trim() || null,
    mark_paid:    fd.get('mark_paid') === 'on'
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
  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
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
  view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

VIEWS.webhooks = async (view) => {
  view.appendChild(h('div', { class: 'toolbar' },
    h('h1', {}, 'Cashfree Webhook Logs'),
    h('div', {},
      h('select', { id: 'wh-status', style: { marginRight: '.5rem' }, onchange: () => navigate('webhooks') },
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
  let list;
  try {
    const filters = {};
    const sStatus = document.getElementById('wh-status'); if (sStatus && sStatus.value) filters.status = sStatus.value;
    const sEntity = document.getElementById('wh-entity'); if (sEntity && sEntity.value) filters.entity_type = sEntity.value;
    list = await api('api_saas_webhookLogs_list', filters);
  } catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) { view.appendChild(h('div', { class: 'empty' }, 'No webhooks received yet.')); return; }
  const tbl = h('table', {},
    h('thead', {}, h('tr', {},
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
    h('tbody', {}, ...list.map(w => h('tr', {},
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
  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
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
  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
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
  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
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
  view.appendChild(h('div', { class: 'card', style: { padding: 0 } }, tbl));
};

function editAdmin(a) {
  const m = h('div', { class: 'modal-bd', onclick: ev => { if (ev.target.classList.contains('modal-bd')) m.remove(); } });
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
};

// ---------- Router ---------------------------------------------
async function route() {
  if (!APP.token) return renderLogin();
  if (!APP.user) {
    try { APP.user = await api('api_saas_admin_me'); }
    catch (_) { APP.token = ''; localStorage.removeItem('saas_admin_token'); return renderLogin(); }
  }
  if (!$('#nav')) renderShell();
  const id = (location.hash.match(/^#\/([a-z]+)/) || [])[1] || 'dashboard';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === id));
  const view = $('#view'); view.innerHTML = '';
  const fn = VIEWS[id];
  if (!fn) { view.appendChild(h('div', { class: 'empty' }, 'Unknown view')); return; }
  try { await fn(view); } catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
route();
