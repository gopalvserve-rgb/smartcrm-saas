/* ============================================================================
 * CUSTOMER_MODULE_v1 — SPA (2026-07-17), vserve only
 * ============================================================================
 * The UI for the Convert-to-Customer / delivery-journey module. Backend is
 * routes/customers.js (buyers* tables). Gopal: "I cant see customer Module in
 * Vserve and Button for convert to customer section."
 *
 * OWN FILE, on purpose — the pack/workspaceHub isolation standard. app.js is
 * ~59k lines and a whole-file upload from a stale checkout has silently reverted
 * other people's work twice. A small module can be diffed at a glance and can't
 * take the SPA down with it. It is a separate <script>, so it CANNOT see app.js's
 * module-scoped helpers (api, h, CRM) — the PACK_GLOBALS trap — so it carries its
 * own token + fetch + DOM helpers, exactly like workspaceHub.js.
 *
 * Exposes:
 *   window.CustomersUI.render(view)   — the Customers page (VIEWS.customers)
 *   window.CustomersUI.openConvert(lead) — the Convert modal (called from the
 *                                          button app.js adds to the lead modal)
 * ========================================================================== */
(function () {
  'use strict';

  function slug() {
    try {
      if (window.TENANT_SLUG) return String(window.TENANT_SLUG);
      const m = String(location.pathname).match(/\/t\/([^/]+)/);
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }
  function token() {
    try {
      const s = slug();
      return (s && localStorage.getItem('crm_token_' + s)) ||
             localStorage.getItem('crm_token') || '';
    } catch (_) { return ''; }
  }
  function apiBase() { const s = slug(); return location.origin + (s ? '/t/' + s : '') + '/api'; }
  async function api(fn) {
    const args = Array.prototype.slice.call(arguments, 1);
    if (typeof window.api === 'function') return window.api.apply(null, [fn].concat(args));
    const res = await fetch(apiBase(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: [token()].concat(args) })
    });
    const j = await res.json();
    if (j && j.error) throw new Error(j.error);
    return j && j.result !== undefined ? j.result : j;
  }
  function h(tag, attrs) {
    const n = document.createElement(tag);
    const kids = Array.prototype.slice.call(arguments, 2);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      const v = attrs[k];
      if (v == null) return;
      if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else n.setAttribute(k, v);
    });
    kids.forEach(function add(c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      n.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return n;
  }
  function toast(m, t) { if (typeof window.toast === 'function') { try { return window.toast(m, t); } catch (_) {} } }
  function money(v) {
    const n = Number(v) || 0;
    return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  /* CRM is module-scoped in app.js and NOT on window (PACK_GLOBALS trap), so we can't
   * read CRM.user here. Fetch the user once via api_me and cache it. */
  let _me = null;
  async function loadMe() { if (_me) return _me; try { _me = await api('api_me'); } catch (_) { _me = {}; } return _me; }
  function role() { return (_me && _me.role) || ''; }
  function myId() { return _me && _me.id != null ? Number(_me.id) : -1; }
  const C = { brand: '#6366f1', ok: '#10b981', warn: '#f59e0b', err: '#ef4444',
              muted: '#94a3b8', text: '#0f172a', soft: '#475569', border: '#e5e7eb' };

  /* ---------- shared bits ---------- */
  function pill(txt, bg, fg) {
    return h('span', { style: { display: 'inline-block', padding: '.12rem .5rem', borderRadius: '99px',
      fontSize: '.7rem', fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' } }, txt);
  }
  function stageColorById(id) {
    const st = (S.stages || []).find(function (x) { return Number(x.id) === Number(id); });
    return (st && st.color) || '#94a3b8';
  }
  function stagePill(row) {
    // STAGES_FROM_CLOSURE_v1 — the list/detail joins no longer carry a colour (stages come
    // from Sales Closure, which has no colour column), so resolve it from the stages cache.
    const col = row.stage_color || (row.stage_id != null ? stageColorById(row.stage_id) : '#94a3b8');
    return pill(row.stage_name || '—', col + '22', col);
  }
  function card(children, extra) {
    return h('div', { style: Object.assign({ background: '#fff', border: '1px solid ' + C.border,
      borderRadius: '10px', padding: '.9rem' }, extra || {}) }, children);
  }
  function label(t) { return h('label', { style: { display: 'block', fontSize: '.72rem', fontWeight: 700,
    color: C.soft, textTransform: 'uppercase', letterSpacing: '.02em', marginBottom: '.22rem' } }, t); }
  function input(attrs) { return h('input', Object.assign({ style: { width: '100%', border: '1px solid ' + C.border,
    borderRadius: '6px', padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } }, attrs || {})); }
  function btn(txt, kind, on) {
    const styles = { display: 'inline-flex', alignItems: 'center', gap: '.3rem', border: '1px solid ' + C.border,
      background: '#fff', color: C.text, borderRadius: '6px', padding: '.42rem .7rem', fontSize: '.82rem',
      fontWeight: 600, cursor: 'pointer' };
    if (kind === 'primary') { styles.background = C.brand; styles.borderColor = C.brand; styles.color = '#fff'; }
    if (kind === 'ok') { styles.background = C.ok; styles.borderColor = C.ok; styles.color = '#fff'; }
    return h('button', { type: 'button', style: styles, onclick: on }, txt);
  }
  function modalShell(titleTxt, bodyNode, wide) {
    const bg = h('div', { style: { position: 'fixed', inset: '0', background: 'rgba(15,23,42,.45)',
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: '9999', overflow: 'auto', padding: '3vh 1rem' },
      onclick: function (e) { if (e.target === bg) bg.remove(); } });
    const box = h('div', { style: { background: '#fff', borderRadius: '14px', width: wide ? 'min(860px,96vw)' : 'min(560px,96vw)',
      boxShadow: '0 20px 40px rgba(15,23,42,.2)', overflow: 'hidden' } });
    box.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', padding: '.8rem 1.1rem',
      borderBottom: '1px solid ' + C.border } },
      h('span', { style: { fontWeight: 700, fontSize: '1.05rem' } }, titleTxt),
      h('span', { style: { marginLeft: 'auto', cursor: 'pointer', color: C.muted, fontSize: '1.1rem' },
        onclick: function () { bg.remove(); } }, '✕')));
    const inner = h('div', { style: { padding: '1.1rem' } }, bodyNode);
    box.appendChild(inner);
    bg.appendChild(box);
    bg._close = function () { bg.remove(); };
    return bg;
  }

  /* =========================================================================
   * CONVERT MODAL — called from the lead modal button, or from the list.
   * `lead` is a lead-shaped object; we only need id/name/phone/product/value.
   * ======================================================================= */
  async function openConvert(lead) {
    lead = lead || {};
    let products = [];
    try { products = (await api('api_products_list')) || []; } catch (_) {}
    products = products.filter(function (p) { return Number(p.is_active) !== 0; });
    /* CUSTOMER_MODULE_v1 — admin-defined custom fields (Gopal: "like custom field in
     * Leads"). Definitions come from api_customers_fields; the values the rep types are
     * saved into buyers.extra_json under each field's key. */
    let cfDefs = [];
    try { cfDefs = (await api('api_customers_fields')) || []; } catch (_) {}

    const body = h('div', {});
    // Customer
    const fName = input({ value: lead.name || '' });
    const fPhone = input({ value: lead.phone || lead.whatsapp || '', disabled: 'disabled',
      style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px', padding: '.42rem .55rem',
               fontSize: '.85rem', boxSizing: 'border-box', background: '#f1f5f9', color: C.soft } });
    // Order
    const fProduct = h('select', { style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px',
      padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } },
      h('option', { value: '' }, '— pick a product —'),
      products.map(function (p) {
        const o = h('option', { value: p.id }, p.name);
        if (lead.product_id && Number(lead.product_id) === Number(p.id)) o.selected = 'selected';
        return o;
      }));
    const fAmount = input({ value: lead.value != null ? lead.value : '', placeholder: 'e.g. 320000' });
    const fPaid = input({ placeholder: 'advance received' });
    const fMode = h('select', { style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px',
      padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } },
      ['—', 'UPI', 'Bank transfer', 'Cash', 'Cheque', 'Card'].map(function (m) { return h('option', {}, m); }));
    const fRef = input({ placeholder: 'txn / UTR (optional)' });
    // Delivery
    const fAddr = h('textarea', { rows: '2', style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px',
      padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } }, lead.address || '');
    const fContact = input({ value: (lead.name || '') + (lead.phone ? ' — ' + lead.phone : '') });
    const fTarget = input({ type: 'date' });
    const fNotes = h('textarea', { rows: '2', style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px',
      padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } });

    const sec = function (t) { return h('div', { style: { fontWeight: 700, fontSize: '.75rem', color: C.soft,
      textTransform: 'uppercase', letterSpacing: '.04em', margin: '1rem 0 .5rem', paddingBottom: '.3rem',
      borderBottom: '1px solid #f1f5f9' } }, t); };
    const row2 = function (a, b) { return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.7rem' } }, a, b); };

    // assignee preview banner
    const assignBanner = h('div', { style: { marginTop: '1rem', padding: '.55rem .7rem', borderRadius: '8px',
      background: '#ecfdf5', border: '1px solid #6ee7b7', color: '#065f46', fontSize: '.82rem' } }, 'Resolving assignment…');
    async function refreshAssignee() {
      try {
        const pid = fProduct.value ? Number(fProduct.value) : null;
        const r = await api('api_customers_previewAssignee', { product_id: pid });
        if (r && r.user_id) {
          assignBanner.style.background = '#ecfdf5'; assignBanner.style.borderColor = '#6ee7b7'; assignBanner.style.color = '#065f46';
          assignBanner.innerHTML = '<b>Will be assigned to → ' + (r.user_name || ('#' + r.user_id)) + '</b>' +
            (r.is_fallback ? ' <span style="opacity:.75">(fallback rule — set a product rule in Settings for smarter routing)</span>'
                           : ' <span style="opacity:.75">(rule: ' + (r.rule_name || r.rule_id) + ', ' + r.mode + ')</span>');
        } else {
          assignBanner.style.background = '#fef2f2'; assignBanner.style.borderColor = '#fca5a5'; assignBanner.style.color = '#991b1b';
          assignBanner.textContent = '⚠ No rule matched and no fallback owner set — the customer would be unassigned. Add a rule in Settings.';
        }
      } catch (e) { assignBanner.textContent = 'Could not preview assignment: ' + e.message; }
    }
    fProduct.addEventListener('change', refreshAssignee);

    body.appendChild(sec('Customer'));
    body.appendChild(row2(h('div', {}, label('Customer name *'), fName), h('div', {}, label('Phone (match key)'), fPhone)));
    body.appendChild(sec('Order'));
    body.appendChild(row2(h('div', {}, label('Product / package *'), fProduct), h('div', {}, label('Order value *'), fAmount)));
    body.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '.7rem', marginTop: '.6rem' } },
      h('div', {}, label('Payment received'), fPaid), h('div', {}, label('Mode'), fMode), h('div', {}, label('Reference'), fRef)));
    body.appendChild(sec('Delivery'));
    body.appendChild(row2(h('div', {}, label('Site address'), fAddr),
      h('div', {}, label('Site contact'), fContact, h('div', { style: { height: '.5rem' } }), label('Target date'), fTarget)));
    body.appendChild(sec('Notes for back office'));
    body.appendChild(fNotes);

    /* Render each admin-defined custom field by type. We keep a map key -> read()
     * so the submit handler can pull values into extra_json without caring about type. */
    const cfInputs = {};
    if (cfDefs.length) {
      body.appendChild(sec('Additional details'));
      const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.7rem' } });
      cfDefs.forEach(function (f) {
        let el;
        if (f.field_type === 'textarea') {
          el = h('textarea', { rows: '2', style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px',
            padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } });
        } else if (f.field_type === 'select') {
          const opts = String(f.options || '').split('|').map(function (o) { return o.trim(); }).filter(Boolean);
          el = h('select', { style: { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px',
            padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' } },
            h('option', { value: '' }, '—'), opts.map(function (o) { return h('option', { value: o }, o); }));
        } else {
          el = input({ type: f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text' });
        }
        cfInputs[f.key] = { el: el, def: f };
        const cell = h('div', {}, label(f.label + (Number(f.is_required) ? ' *' : '')), el);
        // textarea spans both columns for room
        if (f.field_type === 'textarea') cell.style.gridColumn = '1 / -1';
        grid.appendChild(cell);
      });
      body.appendChild(grid);
    }

    body.appendChild(assignBanner);

    const doBtn = btn('🎉 Convert & assign', 'ok', null);
    const foot = h('div', { style: { display: 'flex', gap: '.5rem', justifyContent: 'flex-end', marginTop: '1.1rem',
      paddingTop: '.8rem', borderTop: '1px solid #f1f5f9' } },
      btn('Cancel', null, function () { shell._close(); }), doBtn);
    body.appendChild(foot);

    const shell = modalShell('🎉 Convert to Customer', body, true);
    document.body.appendChild(shell);
    refreshAssignee();

    doBtn.addEventListener('click', async function () {
      if (!lead.id) { toast('No lead id', 'err'); return; }
      if (!fProduct.value) { toast('Pick a product — it decides the delivery journey and who gets assigned', 'err'); return; }
      // gather custom-field values + enforce required ones
      const extra = {};
      let missing = null;
      Object.keys(cfInputs).forEach(function (k) {
        const rec = cfInputs[k];
        const v = rec.el.value;
        if (Number(rec.def.is_required) && !String(v || '').trim()) missing = rec.def.label;
        if (String(v || '').trim()) extra[k] = v;
      });
      if (missing) { toast('Please fill "' + missing + '"', 'err'); return; }
      doBtn.disabled = 'disabled'; doBtn.textContent = 'Converting…';
      try {
        const prodName = (products.find(function (p) { return Number(p.id) === Number(fProduct.value); }) || {}).name || '';
        const r = await api('api_customers_convert', {
          extra_json: extra,
          lead_id: lead.id,
          name: fName.value, phone: fPhone.value,
          product_id: Number(fProduct.value), product_name: prodName,
          sale_amount: fAmount.value, paid_amount: fPaid.value,
          payment_mode: fMode.value === '—' ? null : fMode.value, payment_ref: fRef.value,
          address: fAddr.value, site_contact: fContact.value,
          target_date: fTarget.value || null, notes: fNotes.value
        });
        shell._close();
        toast('Converted' + (r.owner_user_id ? '' : ' (unassigned — check rules)'), 'ok');
        // if we're on the customers page, refresh it
        if (location.hash.indexOf('customers') >= 0 && window.CustomersUI) window.CustomersUI.render(document.getElementById('view') || document.querySelector('#view'));
      } catch (e) {
        toast('Convert failed: ' + e.message, 'err');
        doBtn.disabled = null; doBtn.textContent = '🎉 Convert & assign';
      }
    });
  }

  /* =========================================================================
   * CUSTOMERS PAGE — tabs: List · Reports · Settings(admin)
   * ======================================================================= */
  const S = { tab: 'list', scope: 'all', stages: [] };

  async function render(view) {
    await loadMe();
    if (!S.stages || !S.stages.length) { try { S.stages = (await api('api_customers_stages')) || []; } catch (_) {} }
    view.innerHTML = '';
    view.appendChild(h('h2', { style: { margin: '0 0 .2rem', fontSize: '1.4rem' } }, '👥 Customers'));
    view.appendChild(h('div', { style: { color: C.soft, margin: '0 0 1rem', fontSize: '.85rem' } },
      'Sales you converted, moving through delivery. You see the ones you won and the ones assigned to you.'));

    // gate check
    let enabled = true;
    try { const probe = await api('api_customers_list', { page_size: 1 }); enabled = probe.enabled !== false; }
    catch (e) { view.appendChild(card(h('div', { style: { color: C.err } }, 'Customer module error: ' + e.message))); return; }
    if (!enabled) { view.appendChild(card('The Customer module is not enabled for this workspace.')); return; }

    const tabs = h('div', { style: { display: 'flex', gap: '.4rem', marginBottom: '.9rem', flexWrap: 'wrap' } });
    const mk = function (id, txt) {
      const on = S.tab === id;
      return h('button', { type: 'button', style: { padding: '.35rem .8rem', borderRadius: '99px', fontSize: '.8rem',
        fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? C.brand : C.border),
        background: on ? C.brand : '#fff', color: on ? '#fff' : C.text },
        onclick: function () { S.tab = id; render(view); } }, txt);
    };
    tabs.appendChild(mk('list', '📋 List'));
    tabs.appendChild(mk('reports', '📊 Reports'));
    if (role() === 'admin') tabs.appendChild(mk('rules', '⚙️ Auto-assign rules'));
    if (role() === 'admin') tabs.appendChild(mk('fields', '🧩 Custom fields'));
    view.appendChild(tabs);

    const panel = h('div', {});
    view.appendChild(panel);
    if (S.tab === 'list') await renderList(panel);
    else if (S.tab === 'reports') await renderReports(panel);
    else if (S.tab === 'rules') await renderRules(panel);
    else if (S.tab === 'fields') await renderFields(panel);
  }

  async function renderList(panel) {
    panel.innerHTML = '';
    const scopeBar = h('div', { style: { display: 'flex', gap: '.4rem', marginBottom: '.7rem' } });
    [['all', 'All I can see'], ['mine', '👤 Assigned to me'], ['shared', '🤝 I won / watching']].forEach(function (s) {
      const on = S.scope === s[0];
      scopeBar.appendChild(h('button', { type: 'button', style: { padding: '.3rem .65rem', borderRadius: '6px',
        fontSize: '.76rem', fontWeight: 600, cursor: 'pointer', border: '1px solid ' + (on ? C.brand : C.border),
        background: on ? C.brand : '#fff', color: on ? '#fff' : C.text },
        onclick: function () { S.scope = s[0]; renderList(panel); } }, s[1]));
    });
    panel.appendChild(scopeBar);

    const wrap = card(h('div', { style: { color: C.muted, padding: '1rem' } }, 'Loading…'), { padding: '0' });
    panel.appendChild(wrap);
    let data;
    try { data = await api('api_customers_list', { scope: S.scope, page_size: 200 }); }
    catch (e) { wrap.innerHTML = ''; wrap.appendChild(h('div', { style: { padding: '1rem', color: C.err } }, e.message)); return; }
    wrap.innerHTML = '';
    const rows = data.rows || [];
    if (!rows.length) { wrap.appendChild(h('div', { style: { padding: '1.3rem', color: C.muted, textAlign: 'center' } },
      'No customers yet. Open a Sale-Done lead and click “Convert to Customer”.')); return; }

    const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' } });
    tbl.appendChild(h('thead', {}, h('tr', {},
      ['Customer', 'Product', 'Value', 'Stage', 'Owner', 'Sales rep', 'Age'].map(function (th, i) {
        return h('th', { style: { textAlign: i === 2 ? 'right' : 'left', fontSize: '.66rem', textTransform: 'uppercase',
          color: C.muted, padding: '.5rem .55rem', borderBottom: '1px solid ' + C.border, letterSpacing: '.03em' } }, th);
      }))));
    const tb = h('tbody', {});
    rows.forEach(function (r) {
      const late = r.expected_days && r.days_in_stage != null && r.days_in_stage > Number(r.expected_days);
      tb.appendChild(h('tr', { style: { cursor: 'pointer' }, onclick: function () { openDetail(r.id); } },
        h('td', { style: td() }, h('div', { style: { fontWeight: 600 } }, r.name || '—'),
          h('div', { style: { color: C.muted, fontSize: '.72rem' } }, '#' + r.id + (Number(r.is_repeat) ? ' · repeat' : ''))),
        h('td', { style: td() }, r.product_name || '—'),
        h('td', { style: Object.assign({ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, td()) }, money(r.sale_amount)),
        h('td', { style: td() }, stagePill(r), late ? h('div', {}, pill((r.days_in_stage) + 'd · late', '#fee2e2', '#991b1b')) : null),
        h('td', { style: td() }, r.owner_name || h('span', { style: { color: C.err } }, 'unassigned')),
        h('td', { style: td() }, r.sales_name || '—'),
        h('td', { style: td() }, r.days_in_stage != null ? r.days_in_stage + 'd' : '—')));
    });
    tbl.appendChild(tb);
    wrap.appendChild(h('div', { style: { overflowX: 'auto' } }, tbl));
  }
  function td() { return { padding: '.5rem .55rem', borderBottom: '1px solid #f1f5f9', verticalAlign: 'top' }; }

  async function openDetail(id) {
    let d;
    try { d = await api('api_customers_get', id); } catch (e) { toast(e.message, 'err'); return; }
    const c = d.customer;
    const body = h('div', {});
    body.appendChild(h('div', { style: { display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '.6rem' } },
      kv('Phone', c.phone), kv('Product', c.product_name), kv('Value', money(c.sale_amount)),
      kv('Paid', money(c.paid_amount)), kv('Sales rep', c.sales_name), kv('Owner', c.owner_name || 'unassigned')));

    // custom-field values (extra_json) labelled by their definitions
    try {
      let ex = c.extra_json; if (typeof ex === 'string') ex = JSON.parse(ex || '{}');
      const defs = (await api('api_customers_fields')) || [];
      const shown = defs.filter(function (f) { return ex && ex[f.key] != null && String(ex[f.key]).trim(); });
      if (shown.length) {
        body.appendChild(h('div', { style: { display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '.6rem' } },
          shown.map(function (f) { return kv(f.label, ex[f.key]); })));
      }
    } catch (_) {}

    // stage mover (owner/admin only)
    const canMove = role() === 'admin' || role() === 'manager' || myId() === Number(c.owner_user_id);
    const stageWrap = h('div', { style: { margin: '.6rem 0' } });
    stageWrap.appendChild(label('Delivery stage'));
    if (canMove) {
      const sel = h('select', { style: { border: '1px solid ' + C.border, borderRadius: '6px', padding: '.4rem .6rem', fontSize: '.85rem' } },
        S.stages.map(function (st) {
          const o = h('option', { value: st.id }, st.name);
          if (Number(st.id) === Number(c.stage_id)) o.selected = 'selected';
          return o;
        }));
      stageWrap.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', alignItems: 'center' } }, sel,
        btn('Move', 'primary', async function () {
          try { await api('api_customers_setStage', { id: c.id, stage_id: Number(sel.value) }); toast('Stage updated', 'ok'); shell._close(); renderCurrent(); }
          catch (e) { toast(e.message, 'err'); }
        })));
    } else {
      stageWrap.appendChild(h('div', {}, stagePill(c),
        h('span', { style: { marginLeft: '.5rem', color: C.muted, fontSize: '.76rem' } }, 'Only the assigned owner can move the stage')));
    }
    body.appendChild(stageWrap);

    // history
    if (d.history && d.history.length) {
      body.appendChild(h('div', { style: { fontWeight: 700, fontSize: '.75rem', color: C.soft, textTransform: 'uppercase',
        margin: '.8rem 0 .4rem' } }, 'Journey'));
      d.history.forEach(function (hst) {
        body.appendChild(h('div', { style: { fontSize: '.78rem', color: C.soft, padding: '.25rem 0', borderBottom: '1px solid #f8fafc' } },
          (hst.to_name || '—') + (hst.from_name ? ' (from ' + hst.from_name + ')' : '') +
          ' · ' + (hst.changed_by_name || 'system') + ' · ' + new Date(hst.changed_at).toLocaleDateString() +
          (hst.note ? ' — ' + hst.note : '')));
      });
    }
    const shell = modalShell(c.name || ('Customer #' + c.id), body, true);
    document.body.appendChild(shell);
  }
  function kv(k, v) { return h('div', {}, h('div', { style: { fontSize: '.68rem', color: C.muted, textTransform: 'uppercase' } }, k),
    h('div', { style: { fontSize: '.85rem', fontWeight: 600 } }, v || '—')); }
  function renderCurrent() { const v = document.getElementById('view') || document.querySelector('#view'); if (v) render(v); }

  async function renderReports(panel) {
    panel.innerHTML = '';
    panel.appendChild(h('div', { style: { color: C.muted, padding: '.5rem 0' } }, 'Loading…'));
    let r;
    try { r = await api('api_customers_report', {}); } catch (e) { panel.innerHTML = ''; panel.appendChild(card(h('div', { style: { color: C.err } }, e.message))); return; }
    panel.innerHTML = '';
    const t = r.totals || {};
    // KPI strip
    const kpi = function (lab, val, col) { return card(h('div', {}, h('div', { style: { fontSize: '.7rem', color: C.muted, textTransform: 'uppercase' } }, lab),
      h('div', { style: { fontSize: '1.4rem', fontWeight: 800, color: col || C.text } }, val)), { flex: '1', minWidth: '120px' }); };
    panel.appendChild(h('div', { style: { display: 'flex', gap: '.7rem', flexWrap: 'wrap', marginBottom: '1rem' } },
      kpi('Volume', money(t.volume), C.brand), kpi('Sales', t.count || 0),
      kpi('Unique customers', t.unique_customers || 0), kpi('Collected', money(t.collected), C.ok),
      kpi('Completed', t.completed || 0, C.ok)));

    panel.appendChild(reportTable('By stage', ['Stage', 'Count', 'Volume'], (r.by_stage || []).map(function (x) {
      return [stagePill({ stage_name: x.stage, stage_id: x.stage_id }), x.count, money(x.volume)]; })));
    panel.appendChild(reportTable('Salesperson-wise (who won it)', ['Salesperson', 'Count', 'Volume', 'Collected'],
      (r.by_sales || []).map(function (x) { return [x.name, x.count, money(x.volume), money(x.collected)]; })));
    panel.appendChild(reportTable('By product', ['Product', 'Count', 'Volume'],
      (r.by_product || []).map(function (x) { return [x.product, x.count, money(x.volume)]; })));
    panel.appendChild(reportTable('Owner-wise (delivery)', ['Owner', 'Count', 'Volume', 'Open'],
      (r.by_owner || []).map(function (x) { return [x.name, x.count, money(x.volume), x.open_count]; })));
  }
  function reportTable(title, heads, rows) {
    const c = card(null, { marginBottom: '1rem', padding: '0' });
    c.appendChild(h('div', { style: { fontWeight: 700, fontSize: '.85rem', padding: '.7rem .9rem', borderBottom: '1px solid ' + C.border } }, title));
    if (!rows.length) { c.appendChild(h('div', { style: { padding: '.9rem', color: C.muted, fontSize: '.8rem' } }, 'No data in range.')); return c; }
    const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' } });
    tbl.appendChild(h('thead', {}, h('tr', {}, heads.map(function (hd, i) {
      return h('th', { style: { textAlign: i === 0 ? 'left' : 'right', fontSize: '.66rem', textTransform: 'uppercase',
        color: C.muted, padding: '.45rem .7rem', borderBottom: '1px solid ' + C.border } }, hd); }))));
    const tb = h('tbody', {});
    rows.forEach(function (r) {
      tb.appendChild(h('tr', {}, r.map(function (cell, i) {
        return h('td', { style: { textAlign: i === 0 ? 'left' : 'right', padding: '.45rem .7rem',
          borderBottom: '1px solid #f8fafc', fontVariantNumeric: i ? 'tabular-nums' : 'normal' } },
          (cell && cell.nodeType) ? cell : String(cell)); })));
    });
    tbl.appendChild(tb);
    c.appendChild(h('div', { style: { overflowX: 'auto' } }, tbl));
    return c;
  }

  async function renderFields(panel) {
    panel.innerHTML = '';
    let defs = [];
    try { defs = (await api('api_customers_fields')) || []; } catch (e) { panel.appendChild(card(h('div', { style: { color: C.err } }, e.message))); return; }
    panel.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '.6rem' } },
      h('div', { style: { color: C.soft, fontSize: '.82rem' } }, 'Extra fields shown on the Convert-to-Customer form — same idea as Leads custom fields. Values are saved on each customer.'),
      h('span', { style: { flex: 1 } }),
      btn('+ Add field', 'primary', function () { fieldEditor(null, panel); })));
    if (!defs.length) { panel.appendChild(card(h('div', { style: { color: C.muted } }, 'No custom fields yet. Click “Add field”.'))); return; }
    const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' } });
    tbl.appendChild(h('thead', {}, h('tr', {}, ['Label', 'Type', 'Options', 'Required', 'Order', ''].map(function (hd) {
      return h('th', { style: { textAlign: 'left', fontSize: '.66rem', textTransform: 'uppercase', color: C.muted,
        padding: '.5rem .6rem', borderBottom: '1px solid ' + C.border } }, hd); }))));
    const tb = h('tbody', {});
    defs.forEach(function (f) {
      tb.appendChild(h('tr', {},
        h('td', { style: td() }, h('b', {}, f.label), h('div', { style: { color: C.muted, fontSize: '.7rem' } }, f.key)),
        h('td', { style: td() }, f.field_type),
        h('td', { style: td() }, f.options || '—'),
        h('td', { style: td() }, Number(f.is_required) ? 'Yes' : '—'),
        h('td', { style: td() }, f.sort_order),
        h('td', { style: Object.assign({ textAlign: 'right' }, td()) },
          btn('Edit', null, function () { fieldEditor(f, panel); }),
          h('span', { style: { marginLeft: '.3rem' } }, btn('Remove', null, async function () {
            if (!confirm('Remove this field? Existing saved values are kept.')) return;
            try { await api('api_customers_fieldDelete', f.id); renderFields(panel); } catch (e) { toast(e.message, 'err'); }
          })))));
    });
    tbl.appendChild(tb);
    panel.appendChild(card(h('div', { style: { overflowX: 'auto' } }, tbl), { padding: '0' }));
  }

  function fieldEditor(f, panel) {
    f = f || {};
    const body = h('div', {});
    const fLabel = input({ value: f.label || '', placeholder: 'e.g. Roof type' });
    const fType = h('select', { style: sel() }, [['text','Text'],['number','Number'],['date','Date'],['select','Dropdown'],['textarea','Long text']].map(function (t) {
      const o = h('option', { value: t[0] }, t[1]); if ((f.field_type || 'text') === t[0]) o.selected = 'selected'; return o; }));
    const fOpts = input({ value: f.options || '', placeholder: 'Option A | Option B | Option C' });
    const optWrap = h('div', { style: { marginTop: '.6rem', display: (f.field_type === 'select' ? 'block' : 'none') } }, label('Dropdown options (separate with |)'), fOpts);
    fType.addEventListener('change', function () { optWrap.style.display = fType.value === 'select' ? 'block' : 'none'; });
    const fReq = h('input', { type: 'checkbox' }); if (Number(f.is_required)) fReq.checked = true;
    const fSort = input({ type: 'number', value: f.sort_order != null ? f.sort_order : 10 });
    body.appendChild(h('div', {}, label('Field label *'), fLabel));
    body.appendChild(h('div', { style: { marginTop: '.6rem' } }, label('Type'), fType));
    body.appendChild(optWrap);
    body.appendChild(h('div', { style: { display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '.7rem' } },
      h('label', { style: { display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.82rem' } }, fReq, 'Required'),
      h('div', {}, label('Sort order'), fSort)));
    if (f.key) body.appendChild(h('div', { style: { marginTop: '.5rem', color: C.muted, fontSize: '.72rem' } }, 'Key: ' + f.key + ' (fixed — values are stored under it)'));
    const save = btn('Save field', 'primary', null);
    body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' } },
      btn('Cancel', null, function () { shell._close(); }), save));
    const shell = modalShell(f.id ? 'Edit field' : 'Add custom field', body);
    document.body.appendChild(shell);
    save.addEventListener('click', async function () {
      if (!fLabel.value.trim()) { toast('Enter a label', 'err'); return; }
      try {
        await api('api_customers_fieldSave', { id: f.id || undefined, label: fLabel.value.trim(),
          field_type: fType.value, options: fType.value === 'select' ? fOpts.value : null,
          is_required: fReq.checked ? 1 : 0, sort_order: Number(fSort.value) || 10 });
        shell._close(); renderFields(panel);
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function renderRules(panel) {
    panel.innerHTML = '';
    let data, products = [], users = [];
    try {
      data = await api('api_customers_rules');
      products = (await api('api_products_list')) || [];
      users = (await api('api_users_list')) || [];
    } catch (e) { panel.appendChild(card(h('div', { style: { color: C.err } }, e.message))); return; }
    users = users.filter(function (u) { return Number(u.is_active) !== 0; });

    panel.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '.6rem' } },
      h('div', { style: { color: C.soft, fontSize: '.82rem' } }, 'On convert, the first matching rule (top-down) picks the delivery owner. The fallback catches anything unmatched and can’t be deleted.'),
      h('span', { style: { flex: 1 } }),
      btn('+ Add rule', 'primary', function () { ruleEditor(null, products, users, panel); })));

    const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '.82rem' } });
    tbl.appendChild(h('thead', {}, h('tr', {}, ['When product is', 'Mode', 'Members (→ next)', 'Priority', ''].map(function (hd) {
      return h('th', { style: { textAlign: 'left', fontSize: '.66rem', textTransform: 'uppercase', color: C.muted,
        padding: '.5rem .6rem', borderBottom: '1px solid ' + C.border } }, hd); }))));
    const tb = h('tbody', {});
    (data.rows || []).forEach(function (r) {
      const members = (r.members || []).map(function (m) {
        return pill(m.name + (Number(r.next_user_id) === Number(m.id) && r.mode === 'round_robin' ? ' →next' : ''),
          '#eef2ff', '#3730a3'); });
      tb.appendChild(h('tr', { style: { background: Number(r.is_fallback) ? '#fffbeb' : '' } },
        h('td', { style: td() }, Number(r.is_fallback) ? h('b', {}, 'Fallback — any product') : (r.product_name || '(product #' + r.product_id + ')')),
        h('td', { style: td() }, r.mode),
        h('td', { style: td() }, h('div', { style: { display: 'flex', gap: '.25rem', flexWrap: 'wrap' } }, members.length ? members : h('span', { style: { color: C.err } }, 'none set'))),
        h('td', { style: td() }, Number(r.is_fallback) ? '—' : r.priority),
        h('td', { style: Object.assign({ textAlign: 'right' }, td()) },
          btn('Edit', null, function () { ruleEditor(r, products, users, panel); }),
          Number(r.is_fallback) ? null : h('span', { style: { marginLeft: '.3rem' } },
            btn('Delete', null, async function () {
              if (!confirm('Delete this rule?')) return;
              try { await api('api_customers_ruleDelete', r.id); renderRules(panel); } catch (e) { toast(e.message, 'err'); }
            })))));
    });
    tbl.appendChild(tb);
    panel.appendChild(card(h('div', { style: { overflowX: 'auto' } }, tbl), { padding: '0' }));
  }

  function ruleEditor(rule, products, users, panel) {
    rule = rule || {};
    const isFallback = Number(rule.is_fallback) === 1;
    const body = h('div', {});
    const fProd = h('select', { style: sel() }, h('option', { value: '' }, isFallback ? '(any product — fallback)' : '— pick a product —'),
      products.map(function (p) { const o = h('option', { value: p.id }, p.name); if (Number(rule.product_id) === Number(p.id)) o.selected = 'selected'; return o; }));
    if (isFallback) fProd.disabled = 'disabled';
    const fMode = h('select', { style: sel() }, ['round_robin', 'fixed', 'least_busy'].map(function (m) {
      const o = h('option', { value: m }, m === 'round_robin' ? 'Round-robin' : m === 'fixed' ? 'Fixed person' : 'Least busy');
      if ((rule.mode || 'round_robin') === m) o.selected = 'selected'; return o; }));
    const fPrio = input({ type: 'number', value: rule.priority != null ? rule.priority : 100 });
    if (isFallback) fPrio.disabled = 'disabled';

    // member picker
    const picked = new Set((rule.members || []).map(function (m) { return Number(m.id); }));
    const chips = h('div', { style: { display: 'flex', gap: '.3rem', flexWrap: 'wrap', margin: '.3rem 0' } });
    function paintChips() {
      chips.innerHTML = '';
      users.forEach(function (u) {
        const on = picked.has(Number(u.id));
        chips.appendChild(h('button', { type: 'button', style: { padding: '.2rem .55rem', borderRadius: '99px', fontSize: '.75rem',
          cursor: 'pointer', border: '1px solid ' + (on ? C.brand : C.border), background: on ? C.brand : '#fff', color: on ? '#fff' : C.text },
          onclick: function () { if (on) picked.delete(Number(u.id)); else picked.add(Number(u.id)); paintChips(); } }, u.name));
      });
    }
    paintChips();

    body.appendChild(h('div', {}, label('When product is'), fProd));
    body.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.7rem', marginTop: '.6rem' } },
      h('div', {}, label('Mode'), fMode), h('div', {}, label('Priority (lower = first)'), fPrio)));
    body.appendChild(h('div', { style: { marginTop: '.6rem' } }, label('Members (click to toggle)'), chips));
    const save = btn('Save rule', 'primary', null);
    body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '.5rem', marginTop: '1rem' } },
      btn('Cancel', null, function () { shell._close(); }), save));
    const shell = modalShell(rule.id ? 'Edit rule' : 'Add rule', body);
    document.body.appendChild(shell);

    save.addEventListener('click', async function () {
      const ids = Array.from(picked);
      if (!ids.length) { toast('Pick at least one member', 'err'); return; }
      if (!isFallback && !fProd.value) { toast('Pick a product', 'err'); return; }
      try {
        await api('api_customers_ruleSave', { id: rule.id || undefined, product_id: fProd.value ? Number(fProd.value) : null,
          mode: fMode.value, priority: Number(fPrio.value) || 100, user_ids: ids });
        shell._close(); renderRules(panel);
      } catch (e) { toast(e.message, 'err'); }
    });
  }
  function sel() { return { width: '100%', border: '1px solid ' + C.border, borderRadius: '6px', padding: '.42rem .55rem', fontSize: '.85rem', boxSizing: 'border-box' }; }

  // preload stages once for the detail stage-mover
  (async function () { try { S.stages = (await api('api_customers_stages')) || []; } catch (_) {} })();

  window.CustomersUI = { render: render, openConvert: openConvert };
})();
