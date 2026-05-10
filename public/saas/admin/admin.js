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
  { id: 'crashes',       label: '🚨 Crashes' },
  { id: 'ai_costing',    label: '🤖 AI Costing' },
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
        t.status === 'active'
          ? h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_tenants_suspend', t.id); navigate('tenants'); } }, 'Suspend')
          : h('button', { class: 'btn ghost xs', onclick: async () => { await api('api_saas_tenants_restore', t.id); navigate('tenants'); } }, 'Restore')
      )
    )))
  );
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
  try {
    const r = await api('api_saas_tenants_resetUserPassword', { tenantId: t.id, email: targetEmail });
    if (!r.ok) { toast('Reset failed', 'err'); return; }
    // Show the new password in a modal so it can be copied. Display ONCE — closing dismisses it.
    const dlg = document.createElement('div');
    dlg.className = 'modal-backdrop';
    dlg.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'modal';
    inner.style.maxWidth = '520px';
    inner.innerHTML = ''
      + '<div class="modal-head"><h3>🔑 Password reset</h3></div>'
      + '<p>Workspace: <b>' + (t.slug || '') + '</b></p>'
      + '<p>User: <b>' + (r.user.name || '') + '</b> &middot; ' + (r.user.email || '') + ' &middot; ' + (r.user.role || '') + '</p>'
      + '<div style="font-family:ui-monospace,Menlo,monospace; font-size:1.1rem; padding:.7rem; background:#fef3c7; border:1px solid #f59e0b; border-radius:8px; text-align:center; letter-spacing:.05em" id="pw-display">' + r.new_password + '</div>'
      + '<p class="muted" style="font-size:.85rem; margin-top:.6rem">' + (r.note || '') + '</p>'
      + '<div class="actions" style="display:flex; gap:.4rem; justify-content:flex-end; margin-top:.8rem">'
      + '<button id="pw-copy" class="btn small">📋 Copy password</button>'
      + '<button id="pw-close" class="btn small primary">Done</button>'
      + '</div>';
    dlg.appendChild(inner);
    document.body.appendChild(dlg);
    inner.querySelector('#pw-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(r.new_password); toast('Copied to clipboard', 'ok'); }
      catch (_) { toast('Copy failed — select and copy manually', 'err'); }
    };
    inner.querySelector('#pw-close').onclick = () => dlg.remove();
  } catch (e) { toast('Reset failed: ' + e.message, 'err'); }
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

  const runBtn = h('button', { class: 'btn primary', id: 'demo-run-btn', onclick: () => _runDemoSeed() }, '✨ Create / refresh demo');
  const cancelBtn = h('button', { class: 'btn ghost', onclick: () => m.remove() }, 'Close');
  body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' } }, cancelBtn, runBtn));

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
