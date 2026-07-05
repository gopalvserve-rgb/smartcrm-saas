/* ======================================================================
 * REMINDER_FLOWS_v1 SPA (2026-07-05) — v2 REDESIGN
 * ----------------------------------------------------------------------
 * Layout matches the existing "Demo Reminders" page style
 * (Settings → AI Features → 📅 Demo Reminders) — single card, enable
 * toggle at top, status checkboxes, config grid at bottom, save button,
 * footer helper.
 *
 * The user picks:
 *   • ✅ Enable Follow-up Reminders for this tenant
 *   • ⏰ Which reminder times fire (checkboxes: 1h / 30m / 15m / 10m / 5m / at time)
 *   • 💬 Which channels: WhatsApp + Email
 *   • 👥 Who receives them: Lead + Owner
 *   • ✏ WhatsApp template (dropdown of approved templates)
 *   • 📧 Email subject + body
 *
 * On save, updates the "Standard reminders" flow (default). All reps that
 * opt into a follow-up reminder use this flow.
 * ====================================================================== */
(function () {
  'use strict';
  if (window.REMINDER_FLOWS_v1) return;
  window.REMINDER_FLOWS_v1 = { version: '2.0' };

  function _slug() { try { var m = location.pathname.match(/\/t\/([^\/]+)/); return m ? m[1] : ''; } catch (e) { return ''; } }
  function _tok() { var s = _slug(); try { return (s && localStorage.getItem('crm_token_' + s)) || localStorage.getItem('crm_token') || ''; } catch (e) { return ''; } }
  async function _api(name, payload) {
    if (window.api && typeof window.api === 'function') return await window.api(name, payload || {});
    var r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': _tok() },
      body: JSON.stringify({ fn: name, args: [_tok(), payload || {}] }) });
    var j = await r.json();
    if (j && j.error) throw new Error(j.error);
    return j.result !== undefined ? j.result : j;
  }
  function esc(s) { if (s == null) return ''; return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, kind) {
    if (window.toast && typeof window.toast === 'function') return window.toast(msg, kind);
    var div = document.createElement('div');
    div.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;background:' +
      (kind === 'err' ? '#dc2626' : '#15803d') + ';color:#fff;border-radius:8px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:13.5px';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 3200);
  }

  // Time presets — this is what the user picks in the checkboxes
  var TIMES = [
    { m: -180, l: '3 hours before' }, { m: -60, l: '1 hour before' },
    { m: -30, l: '30 min before' }, { m: -15, l: '15 min before' },
    { m: -10, l: '10 min before' }, { m: -5, l: '5 min before' },
    { m: 0, l: 'At follow-up time' }
  ];

  async function viewFollowupReminders() {
    var root = document.querySelector('main') || document.body;
    root.innerHTML = '<div class="admin-content" id="rf-root"><h2 style="margin-top:0">🔔 Follow-up Reminders</h2>' +
      '<p class="muted" style="margin-top:0">Auto-remind the Lead and/or the Owner about upcoming follow-ups via WhatsApp and/or Email. Pick up to 3 alert times (e.g. 1 hour, 30 min, 10 min before) — the same template/message fires at each.</p>' +
      '<div id="rf-body"><div class="loading" style="padding:2rem;text-align:center;color:#94a3b8">Loading…</div></div></div>';
    try {
      await render();
    } catch (e) {
      document.getElementById('rf-body').innerHTML =
        '<div style="padding:1rem;background:#fee2e2;color:#991b1b;border-radius:8px">⚠ ' + esc(e.message) + '</div>';
    }
  }

  async function render() {
    // Load the flow list — we operate on the DEFAULT flow (or the first one)
    var flows, templates;
    try {
      var d = await _api('api_reminderFlows_list');
      flows = d.items || [];
    } catch (e) { throw new Error('Could not load flows: ' + e.message); }
    try {
      templates = await _api('api_wb_templates_list').catch(function () { return []; });
    } catch (_) { templates = []; }
    if (!Array.isArray(templates)) templates = templates.items || [];

    // Prefer the default flow, then the first "Standard" one, then first any
    var flow = flows.find(function (f) { return Number(f.is_default) === 1; }) ||
               flows.find(function (f) { return /standard/i.test(f.name || ''); }) ||
               flows[0] || null;

    // Build the checked-set of currently-picked offsets
    var pickedMs = new Set((flow && flow.rungs || []).map(function (r) { return Number(r.offset_minutes); }));

    var body = document.getElementById('rf-body');
    body.innerHTML =
      '<div class="card" style="padding:1.2rem 1.4rem;margin-bottom:1rem;border-radius:12px;background:linear-gradient(180deg,#eff6ff 0%,#fff 70%);border:1px solid #bfdbfe">' +

        /* Enable toggle */
        '<label style="display:flex;align-items:center;gap:.5rem;font-weight:600;margin-bottom:1rem">' +
          '<input type="checkbox" id="rf-enabled"' + (flow && Number(flow.is_active) ? ' checked' : '') + '>' +
          '<span>🟢 Enable Follow-up Reminders for this tenant</span>' +
        '</label>' +

        /* Times */
        '<div style="font-weight:600;margin-top:.6rem">⏰ Reminder alert times (max 3)</div>' +
        '<p class="muted" style="font-size:.8rem;margin-top:.2rem">Each selected time will fire relative to the follow-up date/time on the lead.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:.4rem;margin-top:.5rem" id="rf-times">' +
          TIMES.map(function (t) {
            var checked = pickedMs.has(t.m) ? ' checked' : '';
            return '<label style="display:flex;align-items:center;gap:.4rem;padding:.3rem .5rem;border:1px solid #e5e7eb;border-radius:6px;cursor:pointer;font-size:.85rem">' +
              '<input type="checkbox" data-time="1" value="' + t.m + '"' + checked + '>' +
              '<span>' + esc(t.l) + '</span></label>';
          }).join('') +
        '</div>' +
        '<div id="rf-timesum" style="font-size:.78rem;color:#047857;margin-top:.5rem;font-weight:500"></div>' +

        /* Channel + recipient — a 2×2 grid like Demo Reminders' bottom grid */
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1.2rem">' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">📤 Channels</span>' +
            '<div style="display:flex;gap:.75rem;padding:.35rem 0">' +
              '<label style="display:flex;align-items:center;gap:.35rem;font-size:.85rem"><input type="checkbox" id="rf-ch-wa"' + (flow && Number(flow.channel_wa) ? ' checked' : '') + '>💬 WhatsApp</label>' +
              '<label style="display:flex;align-items:center;gap:.35rem;font-size:.85rem"><input type="checkbox" id="rf-ch-email"' + (flow && Number(flow.channel_email) ? ' checked' : '') + '>📧 Email</label>' +
            '</div>' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">👥 Recipients</span>' +
            '<div style="display:flex;gap:.75rem;padding:.35rem 0">' +
              '<label style="display:flex;align-items:center;gap:.35rem;font-size:.85rem"><input type="checkbox" id="rf-r-lead"' + (flow && Number(flow.send_to_lead) ? ' checked' : '') + '>👤 The Lead</label>' +
              '<label style="display:flex;align-items:center;gap:.35rem;font-size:.85rem"><input type="checkbox" id="rf-r-owner"' + (flow && Number(flow.send_to_owner) ? ' checked' : '') + '>💼 Owner (assigned rep)</label>' +
            '</div>' +
          '</label>' +
        '</div>' +

        /* Template + language */
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem">' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">💬 WhatsApp template (used when 24h window closed)</span>' +
            '<select id="rf-watpl"><option value="">— choose a template —</option>' +
            (templates || []).map(function (t) {
              var name = t.name || t.template_name || '';
              var lang = t.language || t.lang || '';
              var sel = flow && flow.wa_template_name === name ? ' selected' : '';
              return '<option value="' + esc(name) + '"' + sel + '>' + esc(name) + (lang ? ' (' + esc(lang) + ')' : '') + '</option>';
            }).join('') + '</select>' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">🌐 Language</span>' +
            '<input type="text" id="rf-walang" value="' + esc(flow && flow.wa_language || 'en') + '" style="padding:.35rem">' +
          '</label>' +
        '</div>' +

        /* Email content */
        '<div style="margin-top:1rem">' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">📧 Email subject</span>' +
            '<input type="text" id="rf-esubj" value="' + esc(flow && flow.email_subject || 'Reminder: your follow-up with {{owner_name}} is coming up') + '" style="padding:.35rem">' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:.25rem;margin-top:.6rem">' +
            '<span style="font-weight:600;font-size:.85rem">Email body (HTML)</span>' +
            '<textarea id="rf-ebody" rows="4" style="padding:.4rem;font-family:inherit">' + esc(flow && flow.email_body_html || '<p>Hi {{name}},</p><p>Reminder — your follow-up with <b>{{owner_name}}</b> is at <b>{{followup_time}}</b> on <b>{{followup_date}}</b>.</p>') + '</textarea>' +
          '</label>' +
          '<p class="muted" style="font-size:.75rem;margin-top:.35rem">Tokens: <code>{{name}}</code> <code>{{owner_name}}</code> <code>{{followup_date}}</code> <code>{{followup_time}}</code> <code>{{minutes_before}}</code> <code>{{company}}</code></p>' +
        '</div>' +

        /* Save + status line */
        '<div style="display:flex;align-items:center;gap:.6rem;margin-top:1.2rem">' +
          '<button type="button" class="btn primary" id="rf-save" style="padding:.55rem 1.4rem;border-radius:8px;font-weight:600">Save</button>' +
          '<div id="rf-status" style="font-size:.78rem;color:#64748b;min-height:1.1em"></div>' +
        '</div>' +

        /* Footer helper */
        '<p class="muted" style="font-size:.75rem;margin-top:1.2rem">' +
          '💡 Reps opt into reminders when they set a follow-up date on any lead — they see the tick-boxes above as options in the Lead → Edit modal. ' +
          'If the WA 24h window is closed (no inbound from the lead in 24h), the template is used. Otherwise, a plain-text WA is sent. ' +
          'Email fires via the tenant SMTP configured in Settings.' +
        '</p>' +
      '</div>';

    /* ── Wire handlers ── */
    // Enforce max-3 on time checkboxes
    var timeCbs = body.querySelectorAll('[data-time="1"]');
    function updateTimeSum() {
      var picked = Array.from(timeCbs).filter(function (c) { return c.checked; });
      var sumBox = document.getElementById('rf-timesum');
      if (!picked.length) {
        sumBox.style.color = '#b91c1c';
        sumBox.textContent = '⚠ Pick at least 1 reminder time';
      } else {
        sumBox.style.color = '#047857';
        var labels = picked.map(function (c) {
          var t = TIMES.find(function (x) { return String(x.m) === c.value; });
          return t ? t.l.replace(' before', '').replace(' At follow-up time','at time') : '';
        });
        sumBox.textContent = '✓ ' + picked.length + ' reminder' + (picked.length > 1 ? 's' : '') + ' selected — ' + labels.join(', ');
      }
    }
    timeCbs.forEach(function (cb) {
      cb.onchange = function () {
        var picked = Array.from(timeCbs).filter(function (c) { return c.checked; });
        if (picked.length > 3) {
          cb.checked = false;
          toast('Max 3 reminder times per flow', 'err');
        }
        updateTimeSum();
      };
    });
    updateTimeSum();

    // Save handler
    document.getElementById('rf-save').onclick = async function () {
      var picked = Array.from(timeCbs).filter(function (c) { return c.checked; })
                   .map(function (c) { return { offset_minutes: Number(c.value) }; });
      var statusLine = document.getElementById('rf-status');
      if (!picked.length) {
        statusLine.textContent = '❌ Pick at least 1 reminder time';
        statusLine.style.color = '#b91c1c';
        return;
      }
      var flowPayload = {
        id: flow ? flow.id : null,
        name: flow ? flow.name : 'Standard reminders',
        description: flow ? (flow.description || 'Default follow-up reminder flow') : 'Default follow-up reminder flow',
        is_active: document.getElementById('rf-enabled').checked ? 1 : 0,
        is_default: 1,
        channel_wa:    document.getElementById('rf-ch-wa').checked ? 1 : 0,
        channel_email: document.getElementById('rf-ch-email').checked ? 1 : 0,
        wa_template_name: document.getElementById('rf-watpl').value || '',
        wa_language:      document.getElementById('rf-walang').value.trim() || 'en',
        email_subject:    document.getElementById('rf-esubj').value,
        email_body_html:  document.getElementById('rf-ebody').value,
        send_to_lead:  document.getElementById('rf-r-lead').checked ? 1 : 0,
        send_to_owner: document.getElementById('rf-r-owner').checked ? 1 : 0
      };
      var btn = this;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await _api('api_reminderFlows_save', { flow: flowPayload, rungs: picked });
        statusLine.textContent = '✅ Saved. Reminders scheduled from now on will use these settings.';
        statusLine.style.color = '#047857';
        toast('Saved', 'ok');
      } catch (e) {
        statusLine.textContent = '❌ ' + (e && e.message || e);
        statusLine.style.color = '#b91c1c';
        toast('Save failed: ' + e.message, 'err');
      } finally {
        btn.disabled = false; btn.textContent = 'Save';
      }
    };
  }

  /* ── Registry + sidebar link injection under AI FEATURES ── */
  function _registerViews() {
    var V = window.VIEWS = window.VIEWS || {};
    V.followupreminders = viewFollowupReminders;
    /* Keep old alias too so #/reminderflows still works */
    V.reminderflows = viewFollowupReminders;
  }
  function _injectSidebarLink() {
    try {
      if (!window.CRM || !CRM.user || CRM.user.role !== 'admin') return;
      var nav = document.querySelector('.sidebar nav');
      if (!nav) return;
      if (document.getElementById('nav-followupreminders')) return;
      var link = document.createElement('a');
      link.id = 'nav-followupreminders';
      link.href = '#/followupreminders';
      link.setAttribute('data-view', 'followupreminders');
      link.innerHTML = '<span class="nav-icon">🔔</span> Follow-up Reminders';
      link.onclick = function (e) {
        e.preventDefault();
        if (typeof window.navigateTo === 'function') window.navigateTo('followupreminders');
        else if (window.go) window.go('followupreminders');
        else if (window.VIEWS && window.VIEWS.followupreminders) window.VIEWS.followupreminders();
      };
      /* Try to place under "AI FEATURES" group next to Demo Reminders */
      var aiGroup = Array.from(nav.querySelectorAll('.nav-group-head'))
        .find(function (h) { return /ai\s*features/i.test(h.textContent); });
      if (aiGroup && aiGroup.nextElementSibling) {
        aiGroup.nextElementSibling.appendChild(link);
        return;
      }
      /* Fallback — Settings group */
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
    _injectSidebarLink();
    setTimeout(_injectSidebarLink, 800);
    setTimeout(_injectSidebarLink, 2400);
    if (location.hash === '#/followupreminders' || location.hash === '#/reminderflows') {
      setTimeout(function () { viewFollowupReminders(); }, 300);
    }
  });
})();
