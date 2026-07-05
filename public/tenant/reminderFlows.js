/* ======================================================================
 * REMINDER_FLOWS_v1 SPA (2026-07-05)
 * ----------------------------------------------------------------------
 * Standalone Settings module — pattern matches solar.js / education.js.
 *   - Registers window.VIEWS.reminderflows
 *   - Injects a sidebar link under ⚙️ Settings once app.js has painted it
 *   - Only visible to role='admin'
 * ====================================================================== */
(function () {
  'use strict';
  if (window.REMINDER_FLOWS_v1) return;
  window.REMINDER_FLOWS_v1 = { version: '1.0' };

  function _slug() {
    try { var m = location.pathname.match(/\/t\/([^\/]+)/); return m ? m[1] : ''; }
    catch (e) { return ''; }
  }
  function _tok() {
    var s = _slug();
    try { return (s && localStorage.getItem('crm_token_' + s)) || localStorage.getItem('crm_token') || ''; }
    catch (e) { return ''; }
  }
  async function _api(name, payload) {
    if (window.api && typeof window.api === 'function') return await window.api(name, payload || {});
    var r = await fetch('/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': _tok() },
      body: JSON.stringify({ fn: name, args: [_tok(), payload || {}] })
    });
    var j = await r.json();
    if (j && j.error) throw new Error(j.error);
    return j.result !== undefined ? j.result : j;
  }
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) {
    if (window.toast && typeof window.toast === 'function') return window.toast(msg, kind);
    var div = document.createElement('div');
    div.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;background:' +
      (kind === 'err' ? '#dc2626' : '#15803d') + ';color:#fff;border-radius:8px;z-index:99999;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:13.5px';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 3200);
  }
  function _injectCss() {
    if (document.getElementById('rem-flows-css')) return;
    var css = document.createElement('style'); css.id = 'rem-flows-css';
    css.textContent = [
      '.rf-wrap{padding:12px 4px}',
      '.rf-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}',
      '.rf-title{font-size:18px;font-weight:700;margin:0}',
      '.rf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}',
      '.rf-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;cursor:pointer;transition:.15s;position:relative}',
      '.rf-card:hover{border-color:#6366f1;box-shadow:0 2px 8px rgba(99,102,241,.15)}',
      '.rf-card.def::before{content:"DEFAULT";position:absolute;top:-8px;right:12px;background:#6366f1;color:#fff;font-size:9px;font-weight:700;padding:2px 8px;border-radius:99px;letter-spacing:.3px}',
      '.rf-card h4{margin:0 0 4px;font-size:14px}',
      '.rf-card .desc{color:#64748b;font-size:12px;margin-bottom:8px}',
      '.rf-chips{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px}',
      '.rf-chip{background:#eef2ff;color:#4338ca;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}',
      '.rf-editor{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-top:14px}',
      '.rf-editor label{display:block;margin:.6rem 0 .2rem;font-size:12px;font-weight:600;color:#475569}',
      '.rf-editor input,.rf-editor select,.rf-editor textarea{width:100%;padding:.5rem .65rem;border:1px solid #e5e7eb;border-radius:6px;font:inherit;font-family:inherit}',
      '.rf-editor textarea{min-height:80px;resize:vertical}',
      '.rf-editor .grid2{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}',
      '.rf-section{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin-top:12px}',
      '.rf-section h5{margin:0 0 8px;font-size:13px;color:#4338ca;display:flex;align-items:center;gap:6px}',
      '.rf-section h5 .num{background:#6366f1;color:#fff;width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}',
      '.rf-tchips{display:flex;gap:6px;flex-wrap:wrap}',
      '.rf-tchip{padding:6px 12px;border:2px solid #e5e7eb;border-radius:99px;background:#fff;font-size:12px;font-weight:600;cursor:pointer;user-select:none}',
      '.rf-tchip:hover{background:#f1f5f9}',
      '.rf-tchip.on{background:#6366f1;color:#fff;border-color:#4f46e5}',
      '.rf-cchip{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border:2px solid #e5e7eb;border-radius:99px;font-size:12px;font-weight:600;cursor:pointer;background:#fff;user-select:none}',
      '.rf-cchip.on.wa{background:#25D366;color:#fff;border-color:#128C7E}',
      '.rf-cchip.on.email{background:#0891b2;color:#fff;border-color:#0e7490}',
      '.rf-cchip.on.lead{background:#6366f1;color:#fff;border-color:#4f46e5}',
      '.rf-cchip.on.owner{background:#7c3aed;color:#fff;border-color:#6d28d9}',
      '.rf-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:14px}',
      '.rf-btn{padding:.4rem .85rem;border:1px solid #e5e7eb;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;font-weight:500;font-family:inherit}',
      '.rf-btn:hover{background:#f1f5f9}',
      '.rf-btn.primary{background:#6366f1;color:#fff;border-color:#4f46e5}',
      '.rf-btn.primary:hover{background:#4f46e5}',
      '.rf-btn.danger{color:#dc2626;border-color:#fecaca}',
      '.rf-btn.danger:hover{background:#fee2e2}',
      '.rf-empty{text-align:center;padding:40px;color:#94a3b8}',
      '.rf-summary{background:#f0fdf4;border:1px solid #a7f3d0;color:#047857;padding:8px 12px;border-radius:6px;margin-top:8px;font-size:12px;font-weight:500}'
    ].join('\n');
    document.head.appendChild(css);
  }

  var STATE = { flows: [], editing: null };
  var PRESET_TIMES = [
    { m: -180, l: '3 hrs before' }, { m: -60, l: '1 hour before' },
    { m: -30, l: '30 min before' }, { m: -15, l: '15 min before' },
    { m: -10, l: '10 min before' }, { m: -5, l: '5 min before' },
    { m: 0,   l: 'At time'       }
  ];

  async function viewReminderFlows() {
    _injectCss();
    var root = document.querySelector('main') || document.body;
    root.innerHTML = '<div class="rf-wrap" id="rf-root"><div class="rf-head"><h1 class="rf-title">🔔 Follow-up Reminders</h1>' +
      '<button class="rf-btn primary" id="rf-new">+ New Flow</button></div>' +
      '<div id="rf-list"></div><div id="rf-edit"></div></div>';
    document.getElementById('rf-new').onclick = function () { openEditor(null); };
    await loadList();
  }

  async function loadList() {
    try {
      var d = await _api('api_reminderFlows_list');
      STATE.flows = d.items || [];
    } catch (e) {
      document.getElementById('rf-list').innerHTML =
        '<div class="rf-empty" style="color:#dc2626">⚠ ' + esc(e.message) + '</div>';
      return;
    }
    var box = document.getElementById('rf-list');
    if (!STATE.flows.length) {
      box.innerHTML = '<div class="rf-empty"><div style="font-size:32px;margin-bottom:6px">🔔</div>' +
        '<div style="font-weight:500">No reminder flows yet</div>' +
        '<div style="font-size:12px;margin-top:4px">Click <b>+ New Flow</b> or wait for the auto-seeded defaults on the next tick.</div></div>';
      return;
    }
    box.innerHTML = '<div class="rf-grid">' + STATE.flows.map(function (f) {
      var chips = (f.rungs || []).map(function (r) {
        var m = Math.abs(r.offset_minutes);
        var lab = r.offset_minutes === 0 ? 'At time' :
                  m >= 60 ? Math.round(m / 60) + 'h' + (r.offset_minutes < 0 ? ' before' : ' after') :
                            m + 'm' + (r.offset_minutes < 0 ? ' before' : ' after');
        return '<span class="rf-chip">' + lab + '</span>';
      }).join('');
      var chan = [
        Number(f.channel_wa)    ? '💬 WA' : '',
        Number(f.channel_email) ? '📧 Email' : ''
      ].filter(Boolean).join(' + ');
      var recip = [
        Number(f.send_to_lead)  ? 'Lead'  : '',
        Number(f.send_to_owner) ? 'Owner' : ''
      ].filter(Boolean).join(' + ');
      return '<div class="rf-card' + (Number(f.is_default) ? ' def' : '') + '" data-fid="' + f.id + '">' +
        '<h4>' + esc(f.name) + '</h4>' +
        '<div class="desc">' + esc(f.description || '') + '</div>' +
        '<div class="rf-chips">' + chips + '</div>' +
        '<div style="font-size:11px;color:#64748b">' + chan + ' → ' + recip + '</div>' +
        '</div>';
    }).join('') + '</div>';
    box.querySelectorAll('.rf-card').forEach(function (c) {
      c.onclick = function () {
        var id = Number(c.getAttribute('data-fid'));
        var flow = STATE.flows.find(function (x) { return Number(x.id) === id; });
        openEditor(flow);
      };
    });
  }

  function openEditor(flow) {
    STATE.editing = flow ? JSON.parse(JSON.stringify(flow)) : {
      id: null, name: '', description: '', is_active: 1, is_default: 0,
      channel_wa: 1, channel_email: 1, wa_template_name: 'followup_reminder',
      wa_language: 'en',
      email_subject: 'Reminder: your follow-up with {{owner_name}} is coming up',
      email_body_html: '<p>Hi {{name}},</p><p>Reminder — your follow-up with <b>{{owner_name}}</b> is at <b>{{followup_time}}</b> on <b>{{followup_date}}</b>.</p>',
      send_to_lead: 1, send_to_owner: 1,
      rungs: [{ offset_minutes: -60 }, { offset_minutes: -30 }, { offset_minutes: -10 }]
    };
    renderEditor();
    document.getElementById('rf-edit').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderEditor() {
    var f = STATE.editing;
    var box = document.getElementById('rf-edit');
    var pickedOffsets = new Set((f.rungs || []).map(function (r) { return Number(r.offset_minutes); }));
    var tchipHtml = PRESET_TIMES.map(function (p) {
      var on = pickedOffsets.has(p.m);
      return '<div class="rf-tchip' + (on ? ' on' : '') + '" data-m="' + p.m + '">' +
        (on ? '☑ ' : '☐ ') + p.l + '</div>';
    }).join('');
    box.innerHTML = '<div class="rf-editor">' +
      '<h3 style="margin:0 0 10px;font-size:15px">' + (f.id ? '✏ Edit' : '+ New') + ' flow</h3>' +
      '<label>Flow name *</label><input id="rf-name" value="' + esc(f.name) + '">' +
      '<label>Description</label><input id="rf-desc" value="' + esc(f.description || '') + '">' +
      '<div class="grid2"><div><label>Default flow?</label><select id="rf-def">' +
        '<option value="0"' + (Number(f.is_default) ? '' : ' selected') + '>No</option>' +
        '<option value="1"' + (Number(f.is_default) ? ' selected' : '') + '>Yes — default for new follow-ups</option>' +
      '</select></div><div><label>Active?</label><select id="rf-act">' +
        '<option value="1"' + (Number(f.is_active) ? ' selected' : '') + '>Enabled</option>' +
        '<option value="0"' + (Number(f.is_active) ? '' : ' selected') + '>Disabled</option>' +
      '</select></div></div>' +
      /* Step 1 — Times */
      '<div class="rf-section"><h5><span class="num">1</span>Reminder alert times (max 3)</h5>' +
      '<div class="rf-tchips" id="rf-times">' + tchipHtml + '</div>' +
      '<div class="rf-summary" id="rf-tsum"></div></div>' +
      /* Step 2 — Channels */
      '<div class="rf-section"><h5><span class="num">2</span>How to send</h5>' +
      '<div class="rf-tchips">' +
        '<div class="rf-cchip' + (Number(f.channel_wa)    ? ' on wa'    : ' wa') + '" data-ch="wa">💬 WhatsApp</div>' +
        '<div class="rf-cchip' + (Number(f.channel_email) ? ' on email' : ' email') + '" data-ch="email">📧 Email</div>' +
      '</div></div>' +
      /* Step 3 — Recipients */
      '<div class="rf-section"><h5><span class="num">3</span>Who receives them</h5>' +
      '<div class="rf-tchips">' +
        '<div class="rf-cchip' + (Number(f.send_to_lead)  ? ' on lead'  : ' lead') + '" data-r="lead">👤 The Lead</div>' +
        '<div class="rf-cchip' + (Number(f.send_to_owner) ? ' on owner' : ' owner') + '" data-r="owner">💼 Owner (assigned rep)</div>' +
      '</div></div>' +
      /* Step 4 — Content */
      '<div class="rf-section"><h5><span class="num">4</span>What the message says</h5>' +
      '<div class="grid2"><div><label>WhatsApp template name</label>' +
        '<input id="rf-watpl" value="' + esc(f.wa_template_name || '') + '" placeholder="followup_reminder">' +
        '<label>Language</label><input id="rf-walang" value="' + esc(f.wa_language || 'en') + '" placeholder="en"></div>' +
        '<div><label>Email subject</label><input id="rf-esubj" value="' + esc(f.email_subject || '') + '">' +
        '<label>Email body (HTML)</label><textarea id="rf-ebody">' + esc(f.email_body_html || '') + '</textarea></div></div>' +
      '<div style="font-size:11px;color:#64748b;margin-top:8px">Merge tokens: <code>{{name}}</code> <code>{{owner_name}}</code> <code>{{followup_date}}</code> <code>{{followup_time}}</code> <code>{{minutes_before}}</code> <code>{{company}}</code></div></div>' +
      /* Actions */
      '<div class="rf-actions">' +
        (f.id ? '<button class="rf-btn danger" id="rf-del">🗑 Delete</button>' : '') +
        '<button class="rf-btn" id="rf-cancel">Cancel</button>' +
        '<button class="rf-btn primary" id="rf-save">💾 Save flow</button>' +
      '</div></div>';

    /* Wire up handlers */
    box.querySelectorAll('#rf-times .rf-tchip').forEach(function (chip) {
      chip.onclick = function () {
        var m = Number(chip.getAttribute('data-m'));
        var picked = new Set((STATE.editing.rungs || []).map(function (r) { return Number(r.offset_minutes); }));
        if (picked.has(m)) picked.delete(m);
        else if (picked.size >= 3) { toast('Max 3 reminders per flow', 'err'); return; }
        else picked.add(m);
        STATE.editing.rungs = Array.from(picked).sort(function (a, b) { return a - b; })
          .map(function (v) { return { offset_minutes: v }; });
        renderEditor();
      };
    });
    box.querySelectorAll('.rf-cchip[data-ch]').forEach(function (chip) {
      chip.onclick = function () {
        var ch = chip.getAttribute('data-ch');
        var key = ch === 'wa' ? 'channel_wa' : 'channel_email';
        STATE.editing[key] = Number(STATE.editing[key]) ? 0 : 1;
        renderEditor();
      };
    });
    box.querySelectorAll('.rf-cchip[data-r]').forEach(function (chip) {
      chip.onclick = function () {
        var r = chip.getAttribute('data-r');
        var key = r === 'lead' ? 'send_to_lead' : 'send_to_owner';
        STATE.editing[key] = Number(STATE.editing[key]) ? 0 : 1;
        renderEditor();
      };
    });
    document.getElementById('rf-cancel').onclick = function () {
      STATE.editing = null;
      document.getElementById('rf-edit').innerHTML = '';
    };
    document.getElementById('rf-save').onclick = doSave;
    if (document.getElementById('rf-del')) {
      document.getElementById('rf-del').onclick = function () {
        if (!confirm('Delete flow "' + STATE.editing.name + '"?\nExisting scheduled reminders will stay queued.')) return;
        _api('api_reminderFlows_delete', STATE.editing.id).then(function () {
          toast('Deleted');
          STATE.editing = null;
          document.getElementById('rf-edit').innerHTML = '';
          loadList();
        }).catch(function (e) { toast(e.message, 'err'); });
      };
    }
    updateSummary();
  }

  function updateSummary() {
    var box = document.getElementById('rf-tsum');
    if (!box) return;
    var rungs = STATE.editing.rungs || [];
    if (!rungs.length) {
      box.style.background = '#fee2e2'; box.style.color = '#991b1b'; box.style.borderColor = '#fecaca';
      box.textContent = '⚠ Pick at least 1 reminder time';
    } else {
      box.style.background = '#f0fdf4'; box.style.color = '#047857'; box.style.borderColor = '#a7f3d0';
      var labels = rungs.map(function (r) {
        var m = Math.abs(r.offset_minutes);
        if (r.offset_minutes === 0) return 'at time';
        return (m >= 60 ? Math.round(m / 60) + 'h' : m + 'm') + ' before';
      });
      box.textContent = '✓ ' + rungs.length + ' reminder' + (rungs.length > 1 ? 's' : '') + ' — ' + labels.join(', ');
    }
  }

  async function doSave() {
    var f = STATE.editing;
    // Pull latest field values from DOM
    f.name             = document.getElementById('rf-name').value.trim();
    f.description      = document.getElementById('rf-desc').value.trim();
    f.is_default       = Number(document.getElementById('rf-def').value);
    f.is_active        = Number(document.getElementById('rf-act').value);
    f.wa_template_name = document.getElementById('rf-watpl').value.trim();
    f.wa_language      = document.getElementById('rf-walang').value.trim() || 'en';
    f.email_subject    = document.getElementById('rf-esubj').value.trim();
    f.email_body_html  = document.getElementById('rf-ebody').value;
    if (!f.name)           return toast('Name required', 'err');
    if (!(f.rungs || []).length) return toast('Pick at least 1 reminder time', 'err');
    try {
      var out = await _api('api_reminderFlows_save', { flow: f, rungs: f.rungs });
      toast('✓ Flow saved');
      STATE.editing = null;
      document.getElementById('rf-edit').innerHTML = '';
      await loadList();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ── Registry + sidebar link injection ────────────────────────── */
  function _registerViews() {
    var V = window.VIEWS = window.VIEWS || {};
    V.reminderflows = viewReminderFlows;
  }
  function _injectSidebarLink() {
    try {
      if (!window.CRM || !CRM.user || CRM.user.role !== 'admin') return;
      var nav = document.querySelector('.sidebar nav');
      if (!nav) return;
      if (document.getElementById('nav-reminderflows')) return;
      var link = document.createElement('a');
      link.id = 'nav-reminderflows';
      link.href = '#/reminderflows';
      link.setAttribute('data-view', 'reminderflows');
      link.innerHTML = '<span class="nav-icon">🔔</span> Follow-up Reminders';
      link.onclick = function (e) {
        e.preventDefault();
        if (typeof window.navigateTo === 'function') window.navigateTo('reminderflows');
        else if (window.go) window.go('reminderflows');
        else if (window.VIEWS && window.VIEWS.reminderflows) window.VIEWS.reminderflows();
      };
      /* Insert right before the last item (usually "Settings" or role-based). */
      var settingsGroup = Array.from(nav.querySelectorAll('.nav-group-head'))
        .find(function (h) { return /settings/i.test(h.textContent); });
      if (settingsGroup && settingsGroup.nextElementSibling) {
        settingsGroup.nextElementSibling.appendChild(link);
      } else {
        nav.appendChild(link);
      }
    } catch (e) { console.warn('[reminderFlows] sidebar inject failed:', e.message); }
  }

  function _ready(fn) {
    if (window.api && window.CRM) return fn();
    setTimeout(function () { _ready(fn); }, 200);
  }
  _ready(function () {
    _registerViews();
    /* Try immediately and then observe for sidebar mount */
    _injectSidebarLink();
    setTimeout(_injectSidebarLink, 800);
    setTimeout(_injectSidebarLink, 2400);
    /* Handle deep-link on load */
    if (location.hash === '#/reminderflows') {
      setTimeout(function () { viewReminderFlows(); }, 300);
    }
  });
})();
