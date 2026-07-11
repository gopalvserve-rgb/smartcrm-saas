/* aicallVapi.js — AICALL_v1 Phase 2 frontend
 *
 * VAPI AI dedicated configuration page with 3 tabs:
 *   Phone Numbers · Assistants · Knowledge Base
 *
 * Loaded by index.html and exposed as window.AICALL_VAPI.render(view).
 * VIEWS.aicallVapi (in app.js) just delegates here.
 *
 * All data is fetched live from VAPI via the api_aicall_* proxies in
 * routes/aiCall.js — no local mirroring.
 */
(function () {
  'use strict';
  if (window.AICALL_VAPI) return;

  // Scoped-token helper — mirrors the pattern every recent SPA module uses
  function _slug() {
    try { return window.TENANT_SLUG || ''; } catch (_) { return ''; }
  }
  function _token() {
    try {
      const sl = _slug();
      return (sl && localStorage.getItem('crm_token_' + sl))
          || localStorage.getItem('crm_token')
          || (window.CRM && window.CRM.token) || '';
    } catch (_) { return ''; }
  }
  async function _api(fn, ...args) {
    const r = await fetch((_slug() ? '/t/' + _slug() : '') + '/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args: [_token(), ...args] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j.result !== undefined ? j.result : j;
  }
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        const v = attrs[k];
        if (v == null) return;
        if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v);
      });
    }
    children.forEach(c => {
      if (c == null || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return el;
  }
  function toast(msg, kind) {
    try { window.toast && window.toast(msg, kind); }
    catch (_) { console.log('[aicallVapi]', kind || 'info', msg); }
  }

  const S = {
    tab: 'phones',          // phones | assistants | kb
    phones: [],
    assistants: [],
    files: [],
    kbs: [],
    selectedPhoneId: null,
    selectedAssistantId: null,
    defaultAssistantId: '',
    loading: false
  };

  const COLORS = {
    bg: '#f8fafc', card: '#ffffff', border: '#e2e8f0', text: '#0f172a',
    muted: '#64748b', accent: '#4338ca', accentBg: '#eef2ff',
    success: '#15803d', warning: '#b45309', danger: '#dc2626'
  };

  function render(view) {
    if (!view) return;
    view.innerHTML = '';
    const wrap = h('div', { style: { padding: '1.5rem' } });
    wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '.75rem', marginBottom: '.25rem' } },
      h('h2', { style: { margin: 0 } }, '🎙️ VAPI AI Configuration'),
      h('span', { class: 'muted', style: { fontSize: '12.5px' } }, 'Manage your AI assistants, knowledge bases, and phone numbers')
    ));
    // Tab strip
    const tabs = h('div', { style: { display: 'flex', gap: '4px', borderBottom: '1px solid ' + COLORS.border, marginTop: '1rem' } });
    [['phones', '📞 Phone Numbers'], ['assistants', '🤖 Assistants'], ['kb', '📚 Knowledge Base']].forEach(([k, label]) => {
      tabs.appendChild(h('button', {
        style: {
          padding: '10px 18px', background: S.tab === k ? COLORS.accentBg : 'transparent',
          color: S.tab === k ? COLORS.accent : COLORS.muted, border: 'none',
          borderBottom: S.tab === k ? ('2px solid ' + COLORS.accent) : '2px solid transparent',
          marginBottom: '-1px', cursor: 'pointer', fontSize: '14px', fontWeight: S.tab === k ? '700' : '500'
        },
        onclick: () => { S.tab = k; render(view); }
      }, label));
    });
    wrap.appendChild(tabs);

    const tabBody = h('div', { style: { paddingTop: '1.25rem' } });
    wrap.appendChild(tabBody);
    view.appendChild(wrap);

    if (S.tab === 'phones')      renderPhonesTab(tabBody);
    else if (S.tab === 'assistants') renderAssistantsTab(tabBody);
    else                          renderKbTab(tabBody);
  }

  // ════════ Tab: Phone Numbers ════════
  async function renderPhonesTab(host) {
    host.innerHTML = '';
    host.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' } },
      h('div', null,
        h('h3', { style: { margin: 0 } }, '📞 Phone Numbers'),
        h('p', { class: 'muted', style: { margin: '.25rem 0 0', fontSize: '12.5px' } }, 'Pulled live from your VAPI account — any number already attached there (including a Twilio BYO number) shows up here. No Twilio details needed in SmartCRM.')
      ),
      h('div', { style: { display: 'flex', gap: '.5rem' } },
        h('button', { class: 'btn', style: _btnStyle('primary'), title: 'Fetch the numbers already attached in your VAPI account', onclick: () => importFromVapi(host) }, '⬇ Import from VAPI'),
        h('button', { class: 'btn', style: _btnStyle('ghost'), onclick: () => openAddPhoneModal(host) }, '+ Add Number')
      )
    ));
    const listHost = h('div');
    host.appendChild(listHost);
    listHost.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, '⏳ Loading…'));
    try {
      S.phones = await _api('api_aicall_phones_list');
      _renderPhonesList(listHost);
    } catch (e) {
      listHost.innerHTML = '';
      listHost.appendChild(_errBox(e.message));
    }
  }
  async function loadPhones(host) { renderPhonesTab(host); }
  // VAPI_IMPORT_NUMBERS_v1 — numbers already attached in VAPI (Twilio BYO, VAPI
  // native, SIP) are fetched via VAPI's GET /phone-number. Nothing to re-enter.
  async function importFromVapi(host) {
    try {
      const list = await _api('api_aicall_phones_list');
      S.phones = Array.isArray(list) ? list : [];
      const tw = S.phones.filter(p => String(p.provider || '').toLowerCase() === 'twilio').length;
      toast(S.phones.length
        ? ('Imported ' + S.phones.length + ' number(s) from VAPI' + (tw ? (' — ' + tw + ' Twilio') : ''))
        : 'No numbers found in your VAPI account — attach one in VAPI first.', S.phones.length ? 'ok' : 'err');
      renderPhonesTab(host);
    } catch (e) { toast('VAPI: ' + e.message, 'err'); }
  }
  function _renderPhonesList(host) {
    host.innerHTML = '';
    if (!S.phones.length) {
      host.appendChild(_emptyBox('No numbers found in your VAPI account',
        'Already attached a number in VAPI (e.g. your Twilio number)? Click "⬇ Import from VAPI" — you do NOT need to enter Twilio credentials here. Only use "+ Add Number" if the number is not in VAPI yet.'));
      return;
    }
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '1rem' } });
    // Left: list
    const left = h('div', { style: { background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: '10px', overflow: 'hidden' } });
    S.phones.forEach(p => {
      const active = S.selectedPhoneId === p.id;
      left.appendChild(h('div', {
        style: {
          padding: '12px 14px', borderBottom: '1px solid ' + COLORS.border, cursor: 'pointer',
          background: active ? COLORS.accentBg : 'transparent'
        },
        onclick: () => { S.selectedPhoneId = p.id; _renderPhonesList(host); }
      },
        h('div', { style: { fontWeight: 600, fontSize: '14px', color: COLORS.text } }, p.number || p.sipUri || ('#' + (p.id || '').slice(0, 8))),
        h('div', { style: { fontSize: '11px', color: COLORS.muted, marginTop: '2px' } },
          (p.provider || 'vapi').toUpperCase(),
          p.name ? (' · ' + p.name) : ''),
        p.assistantId ? h('div', {
          style: { display: 'inline-block', marginTop: '4px', padding: '1px 6px', background: '#dcfce7', color: '#166534', borderRadius: '8px', fontSize: '9.5px', fontWeight: 700 }
        }, '🤖 Inbound Assistant') : null
      ));
    });
    grid.appendChild(left);
    // Right: detail
    const sel = S.phones.find(p => p.id === S.selectedPhoneId) || S.phones[0];
    if (sel) {
      S.selectedPhoneId = sel.id;
      grid.appendChild(_phoneDetailPanel(sel, host));
    }
    host.appendChild(grid);
  }
  function _phoneDetailPanel(p, host) {
    const card = h('div', { style: { background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: '10px', padding: '1.5rem' } });
    card.appendChild(h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' } },
      h('h3', { style: { margin: 0 } }, p.number || p.sipUri || 'Phone'),
      h('span', { class: 'muted', style: { fontSize: '11px' } }, 'ID: ' + (p.id || '').slice(0, 12) + '…')
    ));
    card.appendChild(h('div', { style: { display: 'inline-block', marginTop: '6px', padding: '2px 10px', background: COLORS.accentBg, color: COLORS.accent, borderRadius: '10px', fontSize: '10.5px', fontWeight: 700 } },
      (p.provider || 'vapi').toUpperCase()));

    // Label
    const labelInp = h('input', { type: 'text', value: p.name || '', placeholder: 'e.g. Main Sales Line', style: _inpStyle() });
    card.appendChild(_field('🏷️ Label', 'Friendly name to identify this number', labelInp));

    // Inbound Assistant
    const asgnSel = h('select', { style: _inpStyle() }, h('option', { value: '' }, '— No inbound assistant —'));
    (S.assistants.length ? S.assistants : []).forEach(a => {
      asgnSel.appendChild(h('option', { value: a.id, selected: a.id === p.assistantId ? 'selected' : null }, a.name || a.id));
    });
    if (!S.assistants.length) {
      // Lazy load assistants in background so this dropdown populates
      _api('api_aicall_assistants_list').then(list => {
        S.assistants = list || [];
        asgnSel.innerHTML = '';
        asgnSel.appendChild(h('option', { value: '' }, '— No inbound assistant —'));
        S.assistants.forEach(a => asgnSel.appendChild(h('option', { value: a.id, selected: a.id === p.assistantId ? 'selected' : null }, a.name || a.id)));
      }).catch(() => {});
    }
    card.appendChild(_field('🤖 Inbound Assistant', 'AI assistant that answers calls to this number', asgnSel));

    // Action row
    const saveBtn = h('button', { class: 'btn', style: _btnStyle('primary') }, '💾 Save Changes');
    const delBtn  = h('button', { class: 'btn', style: _btnStyle('danger') }, '🗑️ Delete Number');
    saveBtn.onclick = async () => {
      saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving…';
      try {
        await _api('api_aicall_phones_update', { id: p.id, name: labelInp.value, assistantId: asgnSel.value || null });
        toast('Saved', 'ok'); renderPhonesTab(host);
      } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = '💾 Save Changes'; }
    };
    delBtn.onclick = async () => {
      if (!confirm('Delete ' + (p.number || p.id) + ' from VAPI? This cannot be undone.')) return;
      delBtn.disabled = true; delBtn.textContent = '⏳ Deleting…';
      try { await _api('api_aicall_phones_delete', p.id); toast('Deleted', 'ok'); S.selectedPhoneId = null; renderPhonesTab(host); }
      catch (e) { toast(e.message, 'err'); delBtn.disabled = false; delBtn.textContent = '🗑️ Delete Number'; }
    };
    card.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '1.25rem', justifyContent: 'space-between' } },
      saveBtn, delBtn));
    return card;
  }
  function openAddPhoneModal(host) {
    const ov = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)', zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center' }, onclick: (e) => { if (e.target === ov) ov.remove(); } });
    const card = h('div', { style: { background: 'white', borderRadius: '12px', width: '460px', maxWidth: '90vw', padding: '1.5rem', boxShadow: '0 25px 60px rgba(0,0,0,.3)' } });
    card.appendChild(h('h3', { style: { margin: '0 0 .25rem' } }, '+ Add Phone Number'));
    card.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px', marginTop: 0 } }, 'Only use this if the number is NOT in your VAPI account yet.'));
    // VAPI_IMPORT_NUMBERS_v1 — stop people re-entering Twilio creds they already gave VAPI.
    card.appendChild(h('div', { style: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', padding: '.6rem .75rem', margin: '0 0 .9rem', fontSize: '12.5px', color: '#1e3a8a' } },
      h('b', {}, 'Already attached this number inside VAPI?'),
      h('div', { style: { marginTop: '2px' } }, 'Then you do NOT need to enter Twilio details again — close this and click ', h('b', {}, '⬇ Import from VAPI'), '. SmartCRM reads your numbers straight from your VAPI account.')));

    const provSel = h('select', { style: _inpStyle() },
      h('option', { value: 'twilio' }, '📞 Import Twilio Number (BYO)'),
      h('option', { value: 'vapi' }, '🎙️ Buy from VAPI (free)'),
      h('option', { value: 'byo-phone-number' }, '☎️ BYO via your carrier'),
      h('option', { value: 'sip-trunk' }, '🔗 SIP Trunk (BYO)')
    );
    card.appendChild(_field('Provider', 'How VAPI gets the number', provSel));

    // Twilio-specific inputs (default)
    const tNum = h('input', { type: 'text', placeholder: '+15555550100 (E.164)', style: _inpStyle() });
    const tSid = h('input', { type: 'text', placeholder: 'Twilio Account SID', style: _inpStyle() });
    const tTok = h('input', { type: 'password', placeholder: 'Twilio Auth Token', style: _inpStyle() });
    const twilioBlk = h('div', null,
      _field('Phone Number', 'E.164 format', tNum),
      _field('Twilio Account SID', '', tSid),
      _field('Twilio Auth Token', '', tTok)
    );
    card.appendChild(twilioBlk);

    // VAPI free number block
    const vNum = h('input', { type: 'text', placeholder: '+15555550100 (E.164)', style: _inpStyle() });
    const vapiBlk = h('div', { style: { display: 'none' } },
      _field('Desired number', 'Leave blank to let VAPI assign one', vNum)
    );
    card.appendChild(vapiBlk);

    provSel.onchange = () => {
      twilioBlk.style.display = provSel.value === 'twilio' ? 'block' : 'none';
      vapiBlk.style.display = provSel.value === 'vapi' ? 'block' : 'none';
    };

    const actions = h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '1.5rem', justifyContent: 'flex-end' } });
    actions.appendChild(h('button', { class: 'btn', style: _btnStyle('ghost'), onclick: () => ov.remove() }, 'Cancel'));
    const addBtn = h('button', { class: 'btn', style: _btnStyle('primary') }, 'Add Number');
    addBtn.onclick = async () => {
      addBtn.disabled = true; addBtn.textContent = '⏳ Adding…';
      try {
        let body = {};
        if (provSel.value === 'twilio') {
          body = { provider: 'twilio', number: tNum.value.trim(), twilioAccountSid: tSid.value.trim(), twilioAuthToken: tTok.value.trim() };
        } else if (provSel.value === 'vapi') {
          body = { provider: 'vapi' };
          if (vNum.value.trim()) body.number = vNum.value.trim();
        } else if (provSel.value === 'byo-phone-number') {
          body = { provider: 'byo-phone-number', number: tNum.value.trim() };
        } else {
          body = { provider: 'sip-trunk' };
        }
        await _api('api_aicall_phones_create', body);
        toast('Number added', 'ok'); ov.remove(); renderPhonesTab(host);
      } catch (e) { toast('Failed: ' + e.message, 'err'); addBtn.disabled = false; addBtn.textContent = 'Add Number'; }
    };
    actions.appendChild(addBtn);
    card.appendChild(actions);
    ov.appendChild(card); document.body.appendChild(ov);
  }

  // ════════ Tab: Assistants ════════
  async function renderAssistantsTab(host) {
    host.innerHTML = '';
    host.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' } },
      h('div', null,
        h('h3', { style: { margin: 0 } }, '🤖 Assistants'),
        h('p', { class: 'muted', style: { margin: '.25rem 0 0', fontSize: '12.5px' } }, 'Select to view and edit configuration')),
      h('div', { style: { display: 'flex', gap: '.5rem' } },
        h('button', { class: 'btn', style: _btnStyle('ghost'), onclick: () => loadAssistants(host) }, '🔄 Refresh'),
        h('button', { class: 'btn', style: _btnStyle('primary'), onclick: () => openCreateAssistantModal(host) }, '+ New Assistant')
      )
    ));

    const wrapper = h('div'); host.appendChild(wrapper);
    wrapper.appendChild(h('div', { class: 'muted', style: { padding: '2rem', textAlign: 'center' } }, '⏳ Loading…'));
    try {
      const [list, def] = await Promise.all([
        _api('api_aicall_assistants_list'),
        _api('api_aicall_default_assistant_get').catch(() => ({ assistant_id: '' }))
      ]);
      S.assistants = list || [];
      S.defaultAssistantId = (def && def.assistant_id) || '';
      _renderAssistantsList(wrapper, host);
    } catch (e) {
      wrapper.innerHTML = '';
      wrapper.appendChild(_errBox(e.message));
    }
  }
  async function loadAssistants(host) { renderAssistantsTab(host); }
  function _renderAssistantsList(host, tabHost) {
    host.innerHTML = '';

    // Default-outbound picker at the top
    const defSel = h('select', { style: { padding: '6px 10px', border: '1px solid ' + COLORS.border, borderRadius: '6px', minWidth: '260px' } },
      h('option', { value: '' }, '— pick default outbound assistant —'),
      ...S.assistants.map(a => h('option', { value: a.id, selected: a.id === S.defaultAssistantId ? 'selected' : null }, a.name || a.id))
    );
    const defSaveBtn = h('button', { class: 'btn', style: _btnStyle('primary') }, '💾 Save Default');
    defSaveBtn.onclick = async () => {
      defSaveBtn.disabled = true; defSaveBtn.textContent = '⏳ Saving…';
      try {
        await _api('api_aicall_default_assistant_set', { assistant_id: defSel.value });
        S.defaultAssistantId = defSel.value;
        toast('Default assistant updated', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      defSaveBtn.disabled = false; defSaveBtn.textContent = '💾 Save Default';
    };
    host.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', padding: '1rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', marginBottom: '1rem' } },
      h('span', { style: { fontSize: '18px' } }, '📞'),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontWeight: 700, fontSize: '13.5px' } }, 'Default Outbound Assistant'),
        h('div', { style: { fontSize: '11.5px', color: COLORS.muted } }, 'Pre-selected in the Call button + lead modals. Override per call when needed.')),
      defSel, defSaveBtn));

    if (!S.assistants.length) {
      host.appendChild(_emptyBox('No assistants yet', 'Click "+ New Assistant" to create one.'));
      return;
    }
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1rem' } });
    const left = h('div', { style: { background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: '10px', overflow: 'hidden', maxHeight: '600px', overflowY: 'auto' } });
    S.assistants.forEach(a => {
      const active = S.selectedAssistantId === a.id || (!S.selectedAssistantId && a === S.assistants[0]);
      if (active) S.selectedAssistantId = a.id;
      left.appendChild(h('div', {
        style: {
          padding: '12px 14px', borderBottom: '1px solid ' + COLORS.border, cursor: 'pointer',
          background: active ? COLORS.accentBg : 'transparent',
          borderLeft: active ? ('3px solid ' + COLORS.accent) : '3px solid transparent'
        },
        onclick: () => { S.selectedAssistantId = a.id; _renderAssistantsList(host, tabHost); }
      },
        h('div', { style: { fontWeight: 600, fontSize: '14px', color: COLORS.text } }, a.name || '(unnamed)'),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
          h('span', { style: _tinyTag('#dcfce7', '#166534') }, (a.model && a.model.provider) || 'openai'),
          h('span', { style: _tinyTag('#e0e7ff', '#3730a3') }, (a.model && a.model.model) || 'gpt-4o'),
          a.id === S.defaultAssistantId ? h('span', { style: _tinyTag('#fef3c7', '#92400e') }, '★ DEFAULT') : null
        )
      ));
    });
    grid.appendChild(left);
    const sel = S.assistants.find(a => a.id === S.selectedAssistantId) || S.assistants[0];
    grid.appendChild(_assistantDetailPanel(sel, tabHost));
    host.appendChild(grid);
  }
  function _assistantDetailPanel(a, tabHost) {
    const card = h('div', { style: { background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: '10px', padding: '1.5rem' } });

    // General
    card.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.5rem' } },
      h('span', { style: { fontSize: '18px' } }, '👤'),
      h('div', null,
        h('div', { style: { fontWeight: 700 } }, 'General'),
        h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Basic assistant identity and greeting'))));

    const nameInp = h('input', { type: 'text', value: a.name || '', style: _inpStyle() });
    card.appendChild(_field('Assistant Name', '', nameInp));

    const firstInp = h('textarea', { rows: 2, style: Object.assign(_inpStyle(), { resize: 'vertical' }) });
    firstInp.value = a.firstMessage || '';
    card.appendChild(_field('First Message', 'What the AI says when the call connects', firstInp));

    // Model
    card.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', margin: '1.25rem 0 .5rem' } },
      h('span', { style: { fontSize: '18px' } }, '🧠'),
      h('div', null,
        h('div', { style: { fontWeight: 700 } }, 'Model'),
        h('div', { class: 'muted', style: { fontSize: '11px' } }, 'LLM provider, model and parameters'))));
    const provSel = h('select', { style: _inpStyle() },
      ...['openai', 'anthropic', 'groq', 'google', 'azure-openai'].map(v => h('option', { value: v, selected: ((a.model && a.model.provider) || 'openai') === v ? 'selected' : null }, v))
    );
    const modelInp = h('input', { type: 'text', value: (a.model && a.model.model) || 'gpt-4o', placeholder: 'e.g. gpt-4o, claude-3-5-sonnet', style: _inpStyle() });
    card.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' } },
      _field('Provider', '', provSel),
      _field('Model', '', modelInp)));

    const sysInp = h('textarea', { rows: 6, style: Object.assign(_inpStyle(), { fontFamily: 'inherit', resize: 'vertical' }) });
    sysInp.value = (a.model && a.model.messages && a.model.messages[0] && a.model.messages[0].content) || '';
    card.appendChild(_field('System Prompt', 'Instructions, persona, rules', sysInp));

    // Voice (basic)
    card.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '.5rem', margin: '1.25rem 0 .5rem' } },
      h('span', { style: { fontSize: '18px' } }, '🔊'),
      h('div', null,
        h('div', { style: { fontWeight: 700 } }, 'Voice'),
        h('div', { class: 'muted', style: { fontSize: '11px' } }, 'Text-to-speech provider + voice id'))));
    const voiceProvSel = h('select', { style: _inpStyle() },
      ...['11labs', 'openai', 'playht', 'deepgram', 'cartesia'].map(v => h('option', { value: v, selected: ((a.voice && a.voice.provider) || '11labs') === v ? 'selected' : null }, v))
    );
    const voiceIdInp = h('input', { type: 'text', value: (a.voice && a.voice.voiceId) || '', placeholder: 'e.g. burt, jennifer (depends on provider)', style: _inpStyle() });
    card.appendChild(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' } },
      _field('TTS Provider', '', voiceProvSel),
      _field('Voice ID', '', voiceIdInp)));

    // Actions
    const saveBtn = h('button', { class: 'btn', style: _btnStyle('primary') }, '💾 Save Changes');
    const delBtn  = h('button', { class: 'btn', style: _btnStyle('danger') }, '🗑️ Delete');
    saveBtn.onclick = async () => {
      saveBtn.disabled = true; saveBtn.textContent = '⏳ Saving…';
      try {
        const payload = {
          id: a.id,
          name: nameInp.value.trim(),
          firstMessage: firstInp.value,
          model: {
            provider: provSel.value,
            model: modelInp.value.trim(),
            messages: sysInp.value ? [{ role: 'system', content: sysInp.value }] : undefined
          },
          voice: {
            provider: voiceProvSel.value,
            voiceId: voiceIdInp.value.trim()
          }
        };
        await _api('api_aicall_assistants_update', payload);
        toast('Assistant saved', 'ok'); renderAssistantsTab(tabHost);
      } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; saveBtn.textContent = '💾 Save Changes'; }
    };
    delBtn.onclick = async () => {
      if (!confirm('Delete assistant "' + (a.name || a.id) + '"? This cannot be undone.')) return;
      delBtn.disabled = true; delBtn.textContent = '⏳ Deleting…';
      try { await _api('api_aicall_assistants_delete', a.id); toast('Deleted', 'ok'); S.selectedAssistantId = null; renderAssistantsTab(tabHost); }
      catch (e) { toast(e.message, 'err'); delBtn.disabled = false; delBtn.textContent = '🗑️ Delete'; }
    };
    card.appendChild(h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '1.5rem', justifyContent: 'space-between' } }, saveBtn, delBtn));
    return card;
  }
  function openCreateAssistantModal(host) {
    const ov = h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)', zIndex: 99999, display: 'flex', alignItems: 'center', justifyContent: 'center' }, onclick: (e) => { if (e.target === ov) ov.remove(); } });
    const card = h('div', { style: { background: 'white', borderRadius: '12px', width: '440px', padding: '1.5rem' } });
    card.appendChild(h('h3', { style: { margin: '0 0 1rem' } }, '+ New Assistant'));

    const nameInp = h('input', { type: 'text', placeholder: 'e.g. Lead Qualifier AI', style: _inpStyle() });
    const firstInp = h('input', { type: 'text', placeholder: "Hi, this is Sarah from Acme. Do you have a moment?", style: _inpStyle() });
    card.appendChild(_field('Name *', '', nameInp));
    card.appendChild(_field('First Message', "What the AI says when the call connects", firstInp));

    const actions = h('div', { style: { display: 'flex', gap: '.5rem', marginTop: '1.5rem', justifyContent: 'flex-end' } },
      h('button', { class: 'btn', style: _btnStyle('ghost'), onclick: () => ov.remove() }, 'Cancel'));
    const createBtn = h('button', { class: 'btn', style: _btnStyle('primary') }, 'Create');
    createBtn.onclick = async () => {
      if (!nameInp.value.trim()) { toast('Name is required', 'err'); return; }
      createBtn.disabled = true; createBtn.textContent = '⏳ Creating…';
      try {
        await _api('api_aicall_assistants_create', {
          name: nameInp.value.trim(),
          firstMessage: firstInp.value || 'Hello! How can I help you today?',
          model: { provider: 'openai', model: 'gpt-4o' },
          voice: { provider: '11labs', voiceId: 'burt' }
        });
        toast('Assistant created', 'ok'); ov.remove(); renderAssistantsTab(host);
      } catch (e) { toast(e.message, 'err'); createBtn.disabled = false; createBtn.textContent = 'Create'; }
    };
    actions.appendChild(createBtn);
    card.appendChild(actions);
    ov.appendChild(card); document.body.appendChild(ov);
  }

  // ════════ Tab: Knowledge Base ════════
  async function renderKbTab(host) {
    host.innerHTML = '';
    host.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' } },
      h('div', null,
        h('h3', { style: { margin: 0 } }, '📚 Knowledge Base'),
        h('p', { class: 'muted', style: { margin: '.25rem 0 0', fontSize: '12.5px' } }, 'Upload company docs the AI can reference during calls')),
      h('div', { style: { display: 'flex', gap: '.5rem' } },
        h('button', { class: 'btn', style: _btnStyle('ghost'), onclick: () => renderKbTab(host) }, '🔄 Refresh')
      )
    ));
    host.appendChild(h('p', { class: 'muted', style: { padding: '1rem', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '12.5px' } },
      '📌 Phase 2 ships READ-only view of your existing VAPI files + named knowledge bases. File upload + KB attachment to assistants lands in Phase 3.'
    ));

    const filesHost = h('div', { style: { marginTop: '1rem' } });
    const kbsHost   = h('div', { style: { marginTop: '1.5rem' } });
    host.appendChild(filesHost);
    host.appendChild(kbsHost);

    filesHost.appendChild(h('div', { class: 'muted', style: { padding: '1rem', textAlign: 'center' } }, '⏳ Loading…'));
    kbsHost.appendChild(h('div', { class: 'muted', style: { padding: '1rem', textAlign: 'center' } }, '⏳ Loading…'));
    try {
      const [files, kbs] = await Promise.all([
        _api('api_aicall_kb_files_list').catch(() => []),
        _api('api_aicall_kb_list').catch(() => [])
      ]);
      S.files = files || []; S.kbs = kbs || [];
      _renderFilesList(filesHost);
      _renderKbsList(kbsHost);
    } catch (e) {
      filesHost.innerHTML = '';
      filesHost.appendChild(_errBox(e.message));
    }
  }
  function _renderFilesList(host) {
    host.innerHTML = '';
    host.appendChild(h('h4', { style: { margin: '0 0 .5rem' } }, '📄 Files (' + S.files.length + ')'));
    if (!S.files.length) {
      host.appendChild(_emptyBox('No knowledge files yet', 'Upload from your VAPI dashboard for now — local upload UI ships in Phase 3.'));
      return;
    }
    const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: '8px' } },
      h('thead', null,
        h('tr', { style: { background: '#f8fafc' } },
          h('th', { style: _th() }, 'Name'),
          h('th', { style: _th() }, 'Size'),
          h('th', { style: _th() }, 'Uploaded'),
          h('th', { style: _th() }, 'Actions')
        )
      ),
      h('tbody', null,
        ...S.files.map(f => h('tr', { style: { borderTop: '1px solid ' + COLORS.border } },
          h('td', { style: _td() }, f.name || f.originalName || f.id),
          h('td', { style: _td() }, _formatBytes(f.bytes || f.size || 0)),
          h('td', { style: _td() }, f.createdAt ? new Date(f.createdAt).toLocaleString('en-IN') : '—'),
          h('td', { style: _td() },
            h('button', {
              class: 'btn', style: _btnStyle('danger-sm'),
              onclick: async () => {
                if (!confirm('Delete ' + (f.name || f.id) + '?')) return;
                try { await _api('api_aicall_kb_file_delete', f.id); toast('Deleted', 'ok'); renderKbTab(host.parentElement); }
                catch (e) { toast(e.message, 'err'); }
              }
            }, '🗑️')
          )
        ))
      )
    );
    host.appendChild(tbl);
  }
  function _renderKbsList(host) {
    host.innerHTML = '';
    host.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.5rem' } },
      h('h4', { style: { margin: 0 } }, '📚 Knowledge Bases (' + S.kbs.length + ')'),
      h('button', {
        class: 'btn', style: _btnStyle('primary'),
        onclick: async () => {
          const name = prompt('Knowledge base name:');
          if (!name) return;
          try { await _api('api_aicall_kb_create', { name: name.trim(), provider: 'custom-knowledge-base' }); toast('Created', 'ok'); renderKbTab(host.parentElement); }
          catch (e) { toast(e.message, 'err'); }
        }
      }, '+ Create Knowledge Base')
    ));
    if (!S.kbs.length) {
      host.appendChild(_emptyBox('No knowledge bases yet', 'Group files together to give an assistant focused retrieval scope.'));
      return;
    }
    const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', background: COLORS.card, border: '1px solid ' + COLORS.border, borderRadius: '8px' } },
      h('thead', null,
        h('tr', { style: { background: '#f8fafc' } },
          h('th', { style: _th() }, 'Name'),
          h('th', { style: _th() }, 'Provider'),
          h('th', { style: _th() }, 'Files'),
          h('th', { style: _th() }, 'Created'),
          h('th', { style: _th() }, 'Actions')
        )
      ),
      h('tbody', null,
        ...S.kbs.map(kb => h('tr', { style: { borderTop: '1px solid ' + COLORS.border } },
          h('td', { style: _td() }, kb.name || kb.id),
          h('td', { style: _td() }, kb.provider || 'custom'),
          h('td', { style: _td() }, h('span', { style: _tinyTag('#dbeafe', '#1e40af') }, (Array.isArray(kb.fileIds) ? kb.fileIds.length : 0) + ' files')),
          h('td', { style: _td() }, kb.createdAt ? new Date(kb.createdAt).toLocaleString('en-IN') : '—'),
          h('td', { style: _td() },
            h('button', {
              class: 'btn', style: _btnStyle('danger-sm'),
              onclick: async () => {
                if (!confirm('Delete KB "' + (kb.name || kb.id) + '"?')) return;
                try { await _api('api_aicall_kb_delete', kb.id); toast('Deleted', 'ok'); renderKbTab(host.parentElement); }
                catch (e) { toast(e.message, 'err'); }
              }
            }, '🗑️')
          )
        ))
      )
    );
    host.appendChild(tbl);
  }

  // ─── shared helpers ──────────────────────────────────────────────
  function _inpStyle() { return { width: '100%', padding: '8px 10px', border: '1px solid ' + COLORS.border, borderRadius: '6px', fontSize: '13px', fontFamily: 'inherit' }; }
  function _btnStyle(kind) {
    const base = { padding: '7px 14px', border: '1px solid ' + COLORS.border, borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' };
    if (kind === 'primary')   return Object.assign(base, { background: '#0f172a', color: 'white', borderColor: '#0f172a' });
    if (kind === 'danger')    return Object.assign(base, { background: '#dc2626', color: 'white', borderColor: '#dc2626' });
    if (kind === 'danger-sm') return Object.assign(base, { padding: '4px 8px', background: '#fee2e2', color: '#b91c1c', borderColor: '#fecaca' });
    return Object.assign(base, { background: 'white', color: COLORS.text });
  }
  function _tinyTag(bg, fg) { return { background: bg, color: fg, padding: '1px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700, letterSpacing: '.3px', textTransform: 'uppercase' }; }
  function _th() { return { textAlign: 'left', padding: '8px 10px', fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', color: COLORS.muted, borderBottom: '1px solid ' + COLORS.border }; }
  function _td() { return { padding: '10px', fontSize: '13px' }; }
  function _field(label, hint, inp) {
    return h('div', { style: { marginBottom: '.75rem' } },
      h('label', { style: { display: 'block', fontSize: '12px', fontWeight: 700, color: COLORS.text, marginBottom: '.25rem' } }, label),
      hint ? h('div', { style: { fontSize: '11px', color: COLORS.muted, marginBottom: '.35rem' } }, hint) : null,
      inp
    );
  }
  function _emptyBox(title, sub) {
    return h('div', { style: { padding: '2.5rem', textAlign: 'center', background: COLORS.card, border: '2px dashed ' + COLORS.border, borderRadius: '12px' } },
      h('div', { style: { fontSize: '2.5rem' } }, '📭'),
      h('div', { style: { fontWeight: 700, marginTop: '.5rem', fontSize: '15px' } }, title),
      h('div', { class: 'muted', style: { marginTop: '.25rem', fontSize: '12.5px', maxWidth: '420px', margin: '.25rem auto 0' } }, sub)
    );
  }
  function _errBox(msg) {
    return h('div', { style: { padding: '1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#991b1b', fontSize: '13px' } },
      h('strong', null, '⚠ Could not load: '), msg);
  }
  function _formatBytes(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }

  window.AICALL_VAPI = { render };
})();
