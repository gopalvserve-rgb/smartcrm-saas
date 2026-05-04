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
  kids.flat().forEach(k => { if (k != null && k !== false) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); });
  return el;
};
const $ = sel => document.querySelector(sel);

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
  view.appendChild(h('h1', {}, 'Tenants'));
  let list;
  try { list = await api('api_saas_tenants_list', {}); }
  catch (e) { view.appendChild(h('div', { class: 'error-box' }, e.message)); return; }
  if (!list.length) { view.appendChild(h('div', { class: 'empty' }, 'No tenants yet. Once someone signs up + pays, they appear here.')); return; }
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
  const titles = { payments: '💳 Payments', email: '✉️ Email', lifecycle: '🔄 Lifecycle', brand: '🎨 Brand' };
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
      card.appendChild(h('div', { class: 'field' },
        h('label', {}, s.label + (s.is_set ? ' ✓' : '')),
        h('input', {
          name: s.key,
          value: s.mask ? '' : (s.value || ''),
          placeholder: s.mask ? (s.is_set ? '••• (set — leave blank to keep)' : 'Not set') : ''
        })
      ));
    });
    form.appendChild(card);
  });
  form.appendChild(h('button', { class: 'btn', type: 'submit', style: { marginTop: '1rem' } }, 'Save settings'));
  form.appendChild(h('button', { class: 'btn ghost', type: 'button', style: { marginLeft: '.5rem' }, onclick: async () => {
    try { const r = await api('api_saas_settings_testEmail', {}); toast('Test email sent to ' + r.sent_to); }
    catch (e) { toast(e.message, 'err'); }
  } }, 'Send test email'));
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
