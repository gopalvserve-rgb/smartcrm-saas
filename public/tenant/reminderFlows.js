/* ======================================================================
 * REMINDER_FLOWS_v1 SPA (2026-07-05) — v3 MULTI-FLOW REBUILD
 * ----------------------------------------------------------------------
 * Matches REMINDER_FLOWS_v1_MOCKUP.html exactly:
 *   - Landing view = grid of ALL reminder flows as cards
 *   - "+ New Flow" button top-right
 *   - Click any card (or "+ New Flow") → opens the flow BUILDER inline
 *   - Builder has 4 numbered sections: Times / Channels / Recipients / Content
 *   - Content section includes TEMPLATE VARIABLE PICKER + HEADER IMAGE URL
 *   - Save → returns to the grid
 *
 * Backend (routes/reminderFlows.js) already supports full multi-flow CRUD:
 *   api_reminderFlows_list / _get / _save / _delete / _setDefault
 * ====================================================================== */
(function () {
  'use strict';
  if (window.REMINDER_FLOWS_v1) return;
  window.REMINDER_FLOWS_v1 = { version: '3.0-multi' };

  /* ── Helpers ── */
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

  /* Time preset chips (max 3 pickable) */
  var TIMES = [
    { m: -180, l: '3 hrs before' },
    { m: -60,  l: '1 hour before' },
    { m: -30,  l: '30 min before' },
    { m: -15,  l: '15 min before' },
    { m: -10,  l: '10 min before' },
    { m: -5,   l: '5 min before' },
    { m: 0,    l: 'At follow-up time' }
  ];

  /* Merge tokens available in template variable dropdowns */
  var TOKEN_OPTS = [
    { v: '{{name}}',            l: 'Lead name — {{name}}' },
    { v: '{{owner_name}}',      l: 'Owner (assigned rep) — {{owner_name}}' },
    { v: '{{followup_date}}',   l: 'Follow-up date — {{followup_date}}' },
    { v: '{{followup_time}}',   l: 'Follow-up time — {{followup_time}}' },
    { v: '{{minutes_before}}',  l: 'Minutes before — {{minutes_before}}' },
    { v: '{{company}}',         l: 'Company name — {{company}}' },
    { v: '__custom__',          l: '✏ Custom text…' }
  ];

  /* Cache the templates list once — avoids re-fetching between grid ↔ editor */
  var _templatesCache = null;
  async function _loadTemplates() {
    if (_templatesCache) return _templatesCache;
    try {
      var t = await _api('api_wb_templates_list').catch(function () { return []; });
      if (!Array.isArray(t)) t = t.items || [];
      _templatesCache = t;
      return t;
    } catch (_) { _templatesCache = []; return []; }
  }

  /* ══════════════════════════════════════════════════════════════════
   * ENTRY — always lands on the flow-list grid
   * ══════════════════════════════════════════════════════════════ */
  async function viewFollowupReminders() {
    var root = document.querySelector('main') || document.body;
    root.innerHTML =
      '<div class="admin-content" id="rf-root">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;flex-wrap:wrap;gap:.5rem">' +
          '<div>' +
            '<h2 style="margin:0">🔔 Follow-up Reminders</h2>' +
            '<p class="muted" style="margin:.25rem 0 0">Reusable reminder flows. Reps pick one when they set a follow-up — WhatsApp templates + emails fire at the times you configure.</p>' +
          '</div>' +
          '<div style="display:flex;gap:.5rem">' +
            '<button type="button" id="rf-log" style="padding:.55rem 1rem;font-weight:600;background:#fff;color:#0f172a;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer">📋 Log</button>' +
            '<button type="button" class="btn primary" id="rf-new" style="padding:.55rem 1.1rem;font-weight:600;background:#6366f1;color:#fff;border:0;border-radius:8px;cursor:pointer">+ New Flow</button>' +
          '</div>' +
        '</div>' +
        '<div id="rf-body"><div style="padding:2rem;text-align:center;color:#94a3b8">Loading…</div></div>' +
      '</div>';

    document.getElementById('rf-new').onclick = function () { openBuilder(null); };
    document.getElementById('rf-log').onclick = function () { renderLog(); };
    try { await renderList(); }
    catch (e) {
      document.getElementById('rf-body').innerHTML =
        '<div style="padding:1rem;background:#fee2e2;color:#991b1b;border-radius:8px">⚠ ' + esc(e.message) + '</div>';
    }
  }

  /* ══════════════════════════════════════════════════════════════════
   * LIST — card grid of every flow
   * ══════════════════════════════════════════════════════════════ */
  async function renderList() {
    var d = await _api('api_reminderFlows_list');
    var flows = d.items || [];
    var body = document.getElementById('rf-body');

    if (!flows.length) {
      body.innerHTML =
        '<div style="padding:3rem 2rem;text-align:center;background:#fff;border:2px dashed #e5e7eb;border-radius:12px">' +
          '<div style="font-size:3rem;margin-bottom:.5rem">🔔</div>' +
          '<div style="font-size:1.05rem;font-weight:600;margin-bottom:.35rem">No reminder flows yet</div>' +
          '<div style="color:#64748b;margin-bottom:1rem">Create your first flow so reps can attach it to any lead follow-up.</div>' +
          '<button type="button" class="btn primary" onclick="window.REMINDER_FLOWS_v1.openBuilder(null)" style="padding:.55rem 1.4rem;font-weight:600;background:#6366f1;color:#fff;border:0;border-radius:8px;cursor:pointer">+ New Flow</button>' +
        '</div>';
      return;
    }

    var cards = flows.map(function (f) {
      var rungs = (f.rungs || []).slice().sort(function (a, b) { return Number(a.offset_minutes) - Number(b.offset_minutes); });
      var chChip = Number(f.channel_wa) && Number(f.channel_email) ? 'WA+Email'
                 : Number(f.channel_wa) ? 'WA'
                 : Number(f.channel_email) ? 'Email' : '—';
      var rungHtml = rungs.length ? rungs.map(function (r) {
        var m = Number(r.offset_minutes);
        var lbl = m === 0 ? 'On time' : (Math.abs(m) < 60 ? Math.abs(m) + 'm' : (Math.abs(m) / 60) + 'h') + ' before';
        return '<span style="background:#eef2ff;color:#4338ca;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600">' + esc(lbl) + '</span>';
      }).join(' ') : '<span style="color:#94a3b8;font-size:11px">— no rungs configured —</span>';
      var isDefault = Number(f.is_default) === 1;
      var isActive = Number(f.is_active) === 1;
      var cardClass = 'rf-flow-card' + (isDefault ? ' default' : '') + (isActive ? '' : ' off');
      return '<div class="' + cardClass + '" data-id="' + f.id + '" style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;box-shadow:0 1px 2px rgba(15,23,42,.04);cursor:pointer;position:relative;transition:.15s' + (isActive ? '' : ';opacity:.6') + '">' +
        (isDefault ? '<span style="position:absolute;top:-8px;right:12px;background:#6366f1;color:#fff;font-size:9px;font-weight:700;padding:2px 7px;border-radius:99px;letter-spacing:.3px">DEFAULT</span>' : '') +
        '<div style="display:flex;justify-content:space-between;align-items:start;gap:.5rem;margin-bottom:6px">' +
          '<h4 style="margin:0;font-size:14px;font-weight:600;color:#0f172a">' + esc(f.name || '(unnamed)') + '</h4>' +
          '<span style="font-size:10.5px;font-weight:700;color:#fff;padding:2px 8px;border-radius:99px;background:' + (chChip === 'WA+Email' ? 'linear-gradient(135deg,#25D366,#0891b2)' : chChip === 'WA' ? '#25D366' : chChip === 'Email' ? '#0891b2' : '#94a3b8') + '">' + chChip + '</span>' +
        '</div>' +
        '<div style="color:#475569;font-size:12px;line-height:1.5;margin-bottom:10px;min-height:2.6em">' + esc(f.description || 'No description') + '</div>' +
        '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">' + rungHtml + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid #f1f5f9;font-size:11px;color:#94a3b8">' +
          '<span>' + rungs.length + ' rung' + (rungs.length === 1 ? '' : 's') + ' · ' + (isActive ? 'Active' : 'OFF') + '</span>' +
          '<span style="font-size:11px;color:' + (isActive ? '#10b981' : '#94a3b8') + ';font-weight:600">' + (isActive ? '🟢' : '⚪') + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.85rem;margin-top:.5rem" id="rf-grid">' +
        cards +
      '</div>' +
      '<p class="muted" style="font-size:11.5px;margin:1.5rem 0 0;color:#94a3b8">' +
        '💡 Click any flow card to edit it. Reps see all ACTIVE flows in the Lead → Edit Follow-up modal.' +
      '</p>';

    /* Wire card clicks */
    body.querySelectorAll('.rf-flow-card').forEach(function (card) {
      card.addEventListener('mouseover', function () { card.style.borderColor = '#6366f1'; card.style.boxShadow = '0 2px 8px rgba(15,23,42,.08)'; });
      card.addEventListener('mouseout',  function () { card.style.borderColor = '#e5e7eb'; card.style.boxShadow = '0 1px 2px rgba(15,23,42,.04)'; });
      card.addEventListener('click', function () {
        var id = Number(card.getAttribute('data-id'));
        openBuilder(id);
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════
   * LOG — every reminder ever sent/scheduled/failed
   * REMINDER_LOG_v1 (2026-07-05)
   * ══════════════════════════════════════════════════════════════ */
  var _logState = { since_hours: 168, status: '', channel: '' };

  async function renderLog() {
    var body = document.getElementById('rf-body');
    if (!body) return;
    body.innerHTML = '<div style="padding:2rem;text-align:center;color:#94a3b8">Loading log…</div>';

    var d;
    try {
      d = await _api('api_followupReminders_log', {
        limit: 200,
        since_hours: _logState.since_hours,
        status: _logState.status || undefined,
        channel: _logState.channel || undefined
      });
    } catch (e) {
      body.innerHTML = '<div style="padding:1rem;background:#fee2e2;color:#991b1b;border-radius:8px">⚠ ' + esc(e.message) + '</div>';
      return;
    }

    var items = d.items || [];
    var totals = d.totals || {};

    function fmtDT(s) {
      if (!s) return '<span style="color:#94a3b8">—</span>';
      try {
        var dt = new Date(s);
        return dt.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
      } catch (_) { return esc(s); }
    }
    function statusPill(st) {
      var col = { sent: '#10b981', failed: '#dc2626', scheduled: '#6366f1', cancelled: '#94a3b8', skipped: '#f59e0b' }[st] || '#64748b';
      return '<span style="background:' + col + ';color:#fff;padding:2px 8px;border-radius:99px;font-size:10.5px;font-weight:700;text-transform:uppercase">' + esc(st) + '</span>';
    }
    function chChip(ch) {
      var col = ch === 'wa' ? '#25D366' : ch === 'email' ? '#0891b2' : '#94a3b8';
      var lbl = ch === 'wa' ? '💬 WA' : ch === 'email' ? '📧 Email' : ch;
      return '<span style="background:' + col + ';color:#fff;padding:2px 8px;border-radius:99px;font-size:10.5px;font-weight:600">' + esc(lbl) + '</span>';
    }

    var rows = items.map(function (r) {
      var rung = Number(r.rung_offset_minutes || 0);
      var rungLbl = rung === 0 ? 'On time' : (Math.abs(rung) < 60 ? Math.abs(rung) + 'm before' : (Math.abs(rung) / 60) + 'h before');
      var recipient = r.recipient_type === 'lead'
        ? '👤 Lead · ' + esc(r.recipient_phone || r.recipient_email || '—')
        : '💼 Owner · ' + esc(r.recipient_phone || r.recipient_email || '—');
      var msgId = r.wa_message_id || r.email_message_id || '';
      var errCell = r.error
        ? '<span style="color:#dc2626;font-size:11px" title="' + esc(r.error) + '">' + esc(String(r.error).slice(0, 80)) + '</span>'
        : '<span style="color:#94a3b8;font-size:11px">—</span>';
      return '<tr style="border-top:1px solid #f1f5f9">' +
        '<td style="padding:.55rem .5rem;vertical-align:top">' + statusPill(r.status) + '</td>' +
        '<td style="padding:.55rem .5rem;vertical-align:top"><b>' + esc(r.lead_name || '(no name)') + '</b><br><span style="color:#64748b;font-size:11px">' + esc(r.lead_phone || r.lead_email || '') + '</span></td>' +
        '<td style="padding:.55rem .5rem;vertical-align:top">' + esc(r.flow_name || '(deleted flow)') + '<br><span style="color:#94a3b8;font-size:10.5px">' + esc(rungLbl) + '</span></td>' +
        '<td style="padding:.55rem .5rem;vertical-align:top">' + chChip(r.channel) + '<br><span style="color:#64748b;font-size:11px">' + recipient + '</span></td>' +
        '<td style="padding:.55rem .5rem;vertical-align:top;font-size:11.5px">' +
          '<div><span style="color:#94a3b8">Fire:</span> ' + fmtDT(r.fire_at) + '</div>' +
          '<div><span style="color:#94a3b8">Sent:</span> ' + fmtDT(r.sent_at) + '</div>' +
        '</td>' +
        '<td style="padding:.55rem .5rem;vertical-align:top;font-size:11px">' +
          (r.wa_template_name ? '<code style="background:#eef2ff;color:#4338ca;padding:1px 6px;border-radius:4px;font-size:10.5px">' + esc(r.wa_template_name) + '</code><br>' : '') +
          (msgId ? '<span style="color:#94a3b8;font-family:ui-monospace,Menlo,monospace;font-size:10px" title="' + esc(msgId) + '">ID: ' + esc(String(msgId).slice(0, 24)) + '…</span>' : '') +
        '</td>' +
        '<td style="padding:.55rem .5rem;vertical-align:top">' + errCell + '</td>' +
      '</tr>';
    }).join('');

    if (!rows) rows = '<tr><td colspan="7" style="padding:2rem;text-align:center;color:#94a3b8">No reminder activity in the selected window.</td></tr>';

    body.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;flex-wrap:wrap;gap:.5rem">' +
        '<button type="button" id="rf-log-back" style="background:transparent;border:0;color:#6366f1;cursor:pointer;font-size:13px;font-weight:600;padding:0">◄ Back to all flows</button>' +
        '<div style="display:flex;gap:.5rem;align-items:center;font-size:12.5px;flex-wrap:wrap">' +
          '<label style="display:flex;align-items:center;gap:.35rem">Window ' +
            '<select id="rf-log-window" style="padding:.35rem;border:1px solid #e5e7eb;border-radius:6px;font-size:12.5px">' +
              [ [24, 'Last 24h'], [72, 'Last 3 days'], [168, 'Last 7 days'], [720, 'Last 30 days'] ].map(function (o) {
                var sel = _logState.since_hours === o[0] ? ' selected' : '';
                return '<option value="' + o[0] + '"' + sel + '>' + o[1] + '</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:.35rem">Status ' +
            '<select id="rf-log-status" style="padding:.35rem;border:1px solid #e5e7eb;border-radius:6px;font-size:12.5px">' +
              [ ['', 'All'], ['sent', 'Sent'], ['failed', 'Failed'], ['scheduled', 'Scheduled'], ['cancelled', 'Cancelled'], ['skipped', 'Skipped'] ].map(function (o) {
                var sel = _logState.status === o[0] ? ' selected' : '';
                return '<option value="' + o[0] + '"' + sel + '>' + o[1] + '</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:.35rem">Channel ' +
            '<select id="rf-log-channel" style="padding:.35rem;border:1px solid #e5e7eb;border-radius:6px;font-size:12.5px">' +
              [ ['', 'All'], ['wa', 'WhatsApp'], ['email', 'Email'] ].map(function (o) {
                var sel = _logState.channel === o[0] ? ' selected' : '';
                return '<option value="' + o[0] + '"' + sel + '>' + o[1] + '</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<button type="button" id="rf-log-refresh" style="padding:.35rem .75rem;background:#6366f1;color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px">↻ Refresh</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:.5rem;margin-bottom:1rem">' +
        [
          [totals.total || 0, 'Total', '#6366f1'],
          [totals.sent || 0, '✅ Sent', '#10b981'],
          [totals.failed || 0, '❌ Failed', '#dc2626'],
          [totals.scheduled || 0, '⏳ Scheduled', '#6366f1'],
          [totals.cancelled || 0, '🚫 Cancelled', '#94a3b8'],
          [totals.skipped || 0, '⏭ Skipped', '#f59e0b']
        ].map(function (c) {
          return '<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ' + c[2] + ';border-radius:8px;padding:.6rem .8rem">' +
            '<div style="font-size:1.4rem;font-weight:700;color:' + c[2] + '">' + c[0] + '</div>' +
            '<div style="font-size:11px;color:#64748b;font-weight:600">' + c[1] + '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:auto">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
          '<thead style="background:#f8fafc">' +
            '<tr>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Status</th>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Lead</th>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Flow / Rung</th>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Channel · Recipient</th>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Timing</th>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Template / Msg ID</th>' +
              '<th style="text-align:left;padding:.6rem .5rem;font-weight:700;color:#0f172a;font-size:11px;text-transform:uppercase;letter-spacing:.3px">Error</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<p class="muted" style="font-size:11px;margin:1rem 0 0;color:#94a3b8">Showing up to 200 entries. Rows sorted by most recent fire time.</p>';

    document.getElementById('rf-log-back').onclick = function () { viewFollowupReminders(); };
    document.getElementById('rf-log-refresh').onclick = function () {
      _logState.since_hours = Number(document.getElementById('rf-log-window').value) || 168;
      _logState.status = document.getElementById('rf-log-status').value;
      _logState.channel = document.getElementById('rf-log-channel').value;
      renderLog();
    };
    ['rf-log-window','rf-log-status','rf-log-channel'].forEach(function (id) {
      document.getElementById(id).onchange = function () { document.getElementById('rf-log-refresh').click(); };
    });
  }

  window.REMINDER_FLOWS_v1.log = renderLog;

  /* ══════════════════════════════════════════════════════════════════
   * BUILDER — edit one flow (or create new when id=null)
   * ══════════════════════════════════════════════════════════════ */
  async function openBuilder(flowId) {
    var body = document.getElementById('rf-body');
    if (!body) return;
    body.innerHTML = '<div style="padding:2rem;text-align:center;color:#94a3b8">Loading flow…</div>';

    var flow = null, rungs = [], templates = [];
    try {
      templates = await _loadTemplates();
      if (flowId) {
        var g = await _api('api_reminderFlows_get', flowId);
        flow = g.flow; rungs = g.rungs || [];
      }
    } catch (e) {
      body.innerHTML = '<div style="padding:1rem;background:#fee2e2;color:#991b1b;border-radius:8px">⚠ ' + esc(e.message) + '</div>';
      return;
    }

    var isNew = !flow;
    if (!flow) {
      flow = {
        id: null, name: '', description: '',
        is_active: 1, is_default: 0,
        channel_wa: 1, channel_email: 0,
        wa_template_name: '', wa_language: 'en',
        email_subject: 'Reminder: your follow-up with {{owner_name}} is coming up',
        email_body_html: '<p>Hi {{name}},</p><p>Reminder — your follow-up with <b>{{owner_name}}</b> is at <b>{{followup_time}}</b> on <b>{{followup_date}}</b>.</p>',
        send_to_lead: 1, send_to_owner: 1,
        variable_map: [], header_image_url: ''
      };
    }
    var vmap = Array.isArray(flow.variable_map) ? flow.variable_map
             : (typeof flow.variable_map === 'string' ? (function(){ try{return JSON.parse(flow.variable_map||'[]');}catch(_){return[];} })() : []);

    var pickedMs = new Set(rungs.map(function (r) { return Number(r.offset_minutes); }));

    body.innerHTML =
      /* Back link + title */
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">' +
        '<button type="button" id="rf-back" style="background:transparent;border:0;color:#6366f1;cursor:pointer;font-size:13px;font-weight:600;padding:0">◄ Back to all flows</button>' +
        '<div style="font-size:13px;color:#94a3b8">' + (isNew ? 'New flow' : 'Editing flow') + '</div>' +
      '</div>' +

      '<div class="card" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.4rem;box-shadow:0 1px 2px rgba(15,23,42,.04)">' +

        /* Name / description / default */
        '<div style="display:grid;grid-template-columns:2fr 1fr;gap:1rem">' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">Flow name</span>' +
            '<input type="text" id="rf-name" value="' + esc(flow.name || '') + '" placeholder="e.g. VIP high-touch" style="padding:.5rem .65rem;border:1px solid #e5e7eb;border-radius:6px;font-size:14px">' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:.25rem">' +
            '<span style="font-weight:600;font-size:.85rem">Default flow?</span>' +
            '<select id="rf-default" style="padding:.5rem .65rem;border:1px solid #e5e7eb;border-radius:6px;font-size:14px">' +
              '<option value="0"' + (Number(flow.is_default) ? '' : ' selected') + '>No</option>' +
              '<option value="1"' + (Number(flow.is_default) ? ' selected' : '') + '>Yes — pre-select for new follow-ups</option>' +
            '</select>' +
          '</label>' +
        '</div>' +
        '<label style="display:flex;flex-direction:column;gap:.25rem;margin-top:.75rem">' +
          '<span style="font-weight:600;font-size:.85rem">Description (optional)</span>' +
          '<input type="text" id="rf-desc" value="' + esc(flow.description || '') + '" placeholder="Sensible default for most follow-ups." style="padding:.5rem .65rem;border:1px solid #e5e7eb;border-radius:6px;font-size:14px">' +
        '</label>' +
        '<label style="display:flex;align-items:center;gap:.5rem;margin-top:.75rem;font-size:.85rem;font-weight:600">' +
          '<input type="checkbox" id="rf-active"' + (Number(flow.is_active) ? ' checked' : '') + '>' +
          '<span>🟢 Flow is active (uncheck to disable without deleting)</span>' +
        '</label>' +

        /* ═══ STEP 1 · Times ═══ */
        '<div style="background:linear-gradient(135deg,#eef2ff,#fff);border:1px solid #c7d2fe;border-radius:10px;padding:14px;margin-top:1.25rem">' +
          '<h4 style="margin:0 0 4px;font-size:14px;color:#4f46e5;display:flex;align-items:center;gap:6px">' +
            '<span style="background:#6366f1;color:#fff;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">1</span>' +
            'Reminder alert times' +
          '</h4>' +
          '<p style="color:#475569;margin:0 0 12px;font-size:12.5px">Pick when reminders fire relative to the follow-up. Max 3.</p>' +
          '<div id="rf-times" style="display:flex;gap:8px;flex-wrap:wrap">' +
            TIMES.map(function (t) {
              var on = pickedMs.has(t.m);
              return '<label class="rf-tchip" data-off="' + t.m + '" style="padding:8px 14px;border:2px solid ' + (on ? '#4f46e5' : '#e5e7eb') + ';border-radius:99px;background:' + (on ? '#6366f1' : '#fff') + ';color:' + (on ? '#fff' : '#0f172a') + ';font-size:12.5px;font-weight:600;cursor:pointer;user-select:none;transition:.15s">' +
                '<input type="checkbox" data-time="1" value="' + t.m + '"' + (on ? ' checked' : '') + ' style="display:none">' +
                (on ? '☑ ' : '☐ ') + esc(t.l) +
              '</label>';
            }).join('') +
          '</div>' +
          '<div id="rf-timesum" style="margin:10px 0 0;font-size:12px;color:#4f46e5;font-weight:600"></div>' +
        '</div>' +

        /* ═══ STEP 2 · Channels ═══ */
        '<div style="background:linear-gradient(135deg,#f0fdfa,#fff);border:1px solid #a7f3d0;border-radius:10px;padding:14px;margin-top:1rem">' +
          '<h4 style="margin:0 0 4px;font-size:14px;color:#047857;display:flex;align-items:center;gap:6px">' +
            '<span style="background:#10b981;color:#fff;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">2</span>' +
            'How to send' +
          '</h4>' +
          '<p style="color:#475569;margin:0 0 12px;font-size:12.5px">Pick one or both channels.</p>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<label class="rf-cchip" data-key="channel_wa" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:2px solid ' + (Number(flow.channel_wa) ? '#128C7E' : '#e5e7eb') + ';border-radius:99px;background:' + (Number(flow.channel_wa) ? '#25D366' : '#fff') + ';color:' + (Number(flow.channel_wa) ? '#fff' : '#0f172a') + ';font-size:12.5px;font-weight:600;cursor:pointer;user-select:none">' +
              '<input type="checkbox" id="rf-ch-wa"' + (Number(flow.channel_wa) ? ' checked' : '') + ' style="display:none">' +
              '💬 WhatsApp' +
            '</label>' +
            '<label class="rf-cchip" data-key="channel_email" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:2px solid ' + (Number(flow.channel_email) ? '#0e7490' : '#e5e7eb') + ';border-radius:99px;background:' + (Number(flow.channel_email) ? '#0891b2' : '#fff') + ';color:' + (Number(flow.channel_email) ? '#fff' : '#0f172a') + ';font-size:12.5px;font-weight:600;cursor:pointer;user-select:none">' +
              '<input type="checkbox" id="rf-ch-email"' + (Number(flow.channel_email) ? ' checked' : '') + ' style="display:none">' +
              '📧 Email' +
            '</label>' +
          '</div>' +
        '</div>' +

        /* ═══ STEP 3 · Recipients ═══ */
        '<div style="background:linear-gradient(135deg,#faf5ff,#fff);border:1px solid #ddd6fe;border-radius:10px;padding:14px;margin-top:1rem">' +
          '<h4 style="margin:0 0 4px;font-size:14px;color:#7c3aed;display:flex;align-items:center;gap:6px">' +
            '<span style="background:#7c3aed;color:#fff;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">3</span>' +
            'Who receives them' +
          '</h4>' +
          '<p style="color:#475569;margin:0 0 12px;font-size:12.5px">Each fire delivers to whichever recipients you pick.</p>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<label class="rf-cchip" data-key="send_to_lead" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:2px solid ' + (Number(flow.send_to_lead) ? '#4f46e5' : '#e5e7eb') + ';border-radius:99px;background:' + (Number(flow.send_to_lead) ? '#6366f1' : '#fff') + ';color:' + (Number(flow.send_to_lead) ? '#fff' : '#0f172a') + ';font-size:12.5px;font-weight:600;cursor:pointer;user-select:none">' +
              '<input type="checkbox" id="rf-r-lead"' + (Number(flow.send_to_lead) ? ' checked' : '') + ' style="display:none">' +
              '👤 The Lead' +
            '</label>' +
            '<label class="rf-cchip" data-key="send_to_owner" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border:2px solid ' + (Number(flow.send_to_owner) ? '#6d28d9' : '#e5e7eb') + ';border-radius:99px;background:' + (Number(flow.send_to_owner) ? '#7c3aed' : '#fff') + ';color:' + (Number(flow.send_to_owner) ? '#fff' : '#0f172a') + ';font-size:12.5px;font-weight:600;cursor:pointer;user-select:none">' +
              '<input type="checkbox" id="rf-r-owner"' + (Number(flow.send_to_owner) ? ' checked' : '') + ' style="display:none">' +
              '💼 Owner (assigned rep)' +
            '</label>' +
          '</div>' +
        '</div>' +

        /* ═══ STEP 4 · Content ═══ */
        '<div style="background:linear-gradient(135deg,#fef3c7,#fff);border:1px solid #fde68a;border-radius:10px;padding:14px;margin-top:1rem">' +
          '<h4 style="margin:0 0 4px;font-size:14px;color:#92400e;display:flex;align-items:center;gap:6px">' +
            '<span style="background:#f59e0b;color:#fff;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700">4</span>' +
            'What the message says' +
          '</h4>' +
          '<p style="color:#475569;margin:0 0 12px;font-size:12.5px">Same content used for every reminder in this flow.</p>' +

          /* WA template + language + variable picker */
          '<div style="display:grid;grid-template-columns:2fr 1fr;gap:.85rem">' +
            '<label style="display:flex;flex-direction:column;gap:.25rem">' +
              '<span style="font-weight:600;font-size:.82rem">📱 WhatsApp template</span>' +
              '<select id="rf-watpl" style="padding:.5rem;border:1px solid #e5e7eb;border-radius:6px;font-size:13px">' +
                '<option value="">— choose a template —</option>' +
                templates.map(function (t) {
                  var name = t.name || t.template_name || '';
                  var lang = t.language || t.lang || '';
                  var sel = flow.wa_template_name === name ? ' selected' : '';
                  return '<option value="' + esc(name) + '"' + sel + '>' + esc(name) + (lang ? ' (' + esc(lang) + ')' : '') + '</option>';
                }).join('') +
              '</select>' +
            '</label>' +
            '<label style="display:flex;flex-direction:column;gap:.25rem">' +
              '<span style="font-weight:600;font-size:.82rem">🌐 Language</span>' +
              '<input type="text" id="rf-walang" value="' + esc(flow.wa_language || 'en') + '" placeholder="en" style="padding:.5rem;border:1px solid #e5e7eb;border-radius:6px;font-size:13px">' +
            '</label>' +
          '</div>' +

          /* Slot where template variable picker + header image renders */
          '<div id="rf-tpl-config" style="margin-top:.75rem"></div>' +

          /* Email content */
          '<div style="display:grid;grid-template-columns:1fr;gap:.75rem;margin-top:1rem">' +
            '<label style="display:flex;flex-direction:column;gap:.25rem">' +
              '<span style="font-weight:600;font-size:.82rem">📧 Email subject</span>' +
              '<input type="text" id="rf-esubj" value="' + esc(flow.email_subject || '') + '" style="padding:.5rem;border:1px solid #e5e7eb;border-radius:6px;font-size:13px">' +
            '<label style="display:flex;flex-direction:column;gap:.25rem">' +
              '<span style="font-weight:600;font-size:.82rem">Email body (HTML)</span>' +
              '<textarea id="rf-ebody" rows="4" style="padding:.5rem;border:1px solid #e5e7eb;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical">' + esc(flow.email_body_html || '') + '</textarea>' +
            '</label>' +
          '</div>' +
          '<p class="muted" style="font-size:11px;margin:.75rem 0 0;color:#94a3b8">' +
            'Available tokens: <code>{{name}}</code> <code>{{owner_name}}</code> <code>{{followup_date}}</code> <code>{{followup_time}}</code> <code>{{minutes_before}}</code> <code>{{company}}</code>' +
          '</p>' +
        '</div>' +

        /* Action bar */
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-top:1.4rem;padding-top:1rem;border-top:1px solid #f1f5f9">' +
          '<div>' +
            (isNew ? '' :
              '<button type="button" id="rf-delete" style="padding:.5rem 1rem;background:#fff;border:1px solid #fecaca;color:#dc2626;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px">🗑 Delete flow</button>'
            ) +
          '</div>' +
          '<div style="display:flex;gap:.5rem">' +
            '<button type="button" id="rf-cancel" style="padding:.5rem 1rem;background:#fff;border:1px solid #e5e7eb;color:#0f172a;border-radius:6px;cursor:pointer;font-weight:500;font-size:13px">Cancel</button>' +
            '<button type="button" id="rf-save" style="padding:.55rem 1.4rem;background:#6366f1;color:#fff;border:0;border-radius:6px;cursor:pointer;font-weight:600;font-size:13px">' + (isNew ? '+ Create flow' : 'Save flow') + '</button>' +
          '</div>' +
        '</div>' +

        '<div id="rf-status" style="font-size:12px;color:#64748b;margin-top:.5rem;text-align:right;min-height:1.2em"></div>' +
      '</div>';

    /* Wire chip toggles (channels + recipients) */
    body.querySelectorAll('.rf-cchip').forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        var cb = chip.querySelector('input[type="checkbox"]');
        cb.checked = !cb.checked;
        var key = chip.getAttribute('data-key');
        var on = cb.checked;
        var palette = { channel_wa: ['#25D366', '#128C7E'], channel_email: ['#0891b2', '#0e7490'], send_to_lead: ['#6366f1', '#4f46e5'], send_to_owner: ['#7c3aed', '#6d28d9'] };
        var p = palette[key] || ['#6366f1', '#4f46e5'];
        chip.style.background = on ? p[0] : '#fff';
        chip.style.borderColor = on ? p[1] : '#e5e7eb';
        chip.style.color = on ? '#fff' : '#0f172a';
      });
    });

    /* Wire time chips (enforce max 3) */
    var timeChips = body.querySelectorAll('.rf-tchip');
    function updateTimeSum() {
      var picked = Array.from(timeChips).filter(function (c) { return c.querySelector('input').checked; });
      var box = document.getElementById('rf-timesum');
      if (!picked.length) {
        box.style.color = '#dc2626';
        box.textContent = '⚠ Pick at least 1 reminder time';
      } else {
        box.style.color = '#4f46e5';
        var lbls = picked.map(function (c) {
          var m = Number(c.getAttribute('data-off'));
          var t = TIMES.find(function (x) { return x.m === m; });
          return t ? t.l.replace(' before', '').replace('At follow-up time', 'at time') : '';
        });
        box.textContent = '✓ ' + picked.length + ' selected — ' + lbls.join(', ');
      }
    }
    timeChips.forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        e.preventDefault();
        var cb = chip.querySelector('input');
        var picked = Array.from(timeChips).filter(function (c) { return c.querySelector('input').checked; });
        if (!cb.checked && picked.length >= 3) {
          toast('Max 3 reminder times per flow', 'err');
          return;
        }
        cb.checked = !cb.checked;
        var on = cb.checked;
        chip.style.background = on ? '#6366f1' : '#fff';
        chip.style.borderColor = on ? '#4f46e5' : '#e5e7eb';
        chip.style.color = on ? '#fff' : '#0f172a';
        var t = TIMES.find(function (x) { return x.m === Number(chip.getAttribute('data-off')); });
        chip.childNodes[chip.childNodes.length - 1].textContent = (on ? '☑ ' : '☐ ') + (t ? t.l : '');
        updateTimeSum();
      });
    });
    updateTimeSum();

    /* Template variable picker + header image */
    var tplSel = document.getElementById('rf-watpl');
    function _findTpl(name) {
      if (!name) return null;
      return templates.find(function (t) { return (t.name || t.template_name) === name; }) || null;
    }
    function _renderTplConfig() {
      var slot = document.getElementById('rf-tpl-config');
      var tpl = _findTpl(tplSel.value);
      if (!tpl) { slot.innerHTML = ''; return; }
      var comps = tpl.components || (tpl.template && tpl.template.components) || [];
      var header = comps.find(function (c) { return String(c.type || '').toUpperCase() === 'HEADER'; });
      var bodyC  = comps.find(function (c) { return String(c.type || '').toUpperCase() === 'BODY'; });
      var headerType = header ? String(header.format || '').toUpperCase() : '';
      var bodyText = bodyC ? (bodyC.text || '') : (tpl.body_text || '');
      var bodyParams = 0;
      if (bodyC && bodyC.example && bodyC.example.body_text && bodyC.example.body_text[0]) {
        bodyParams = bodyC.example.body_text[0].length;
      }
      if (!bodyParams && bodyText) {
        var mm = bodyText.match(/\{\{\s*\d+\s*\}\}/g);
        bodyParams = mm ? mm.length : 0;
      }

      var html = '<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px">' +
        '<div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-bottom:6px">Template preview</div>' +
        '<pre style="margin:0;padding:8px 10px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#0f172a;white-space:pre-wrap;word-break:break-word">' + esc(bodyText || '(no body)') + '</pre>';

      if (headerType === 'IMAGE') {
        html += '<label style="display:flex;flex-direction:column;gap:.25rem;margin-top:.75rem">' +
          '<span style="font-weight:600;font-size:.82rem">🖼 Header image URL (public HTTPS)</span>' +
          '<input type="text" id="rf-hdrimg" value="' + esc(flow.header_image_url || '') + '" placeholder="https://cdn.example.com/reminder-banner.png" style="padding:.5rem;border:1px solid #e5e7eb;border-radius:6px;font-size:13px">' +
          '<span style="font-size:11px;color:#94a3b8">Meta will fetch this URL when the reminder fires.</span>' +
        '</label>';
      } else if (headerType === 'TEXT') {
        html += '<div style="margin-top:.5rem;font-size:11.5px;color:#64748b">ℹ Header type: TEXT (no image needed)</div>';
      } else if (headerType) {
        html += '<div style="margin-top:.5rem;font-size:11.5px;color:#64748b">ℹ Header type: ' + esc(headerType) + '</div>';
      }

      if (bodyParams > 0) {
        html += '<div style="margin-top:.85rem">' +
          '<div style="font-weight:600;font-size:.82rem;margin-bottom:.35rem">📝 Body variables (' + bodyParams + ')</div>' +
          '<p style="font-size:11px;color:#94a3b8;margin:0 0 .5rem">Pick a merge token for each placeholder or type custom text.</p>';
        for (var i = 0; i < bodyParams; i++) {
          var current = vmap[i] || '';
          var isCustom = current && !TOKEN_OPTS.some(function (o) { return o.v === current; });
          html += '<div class="rf-var-row" data-idx="' + i + '" style="display:grid;grid-template-columns:64px 1fr 1fr;gap:.5rem;align-items:center;margin-bottom:.4rem">' +
            '<span style="background:#eef2ff;color:#4338ca;padding:4px 8px;border-radius:6px;font-size:12px;font-weight:700;text-align:center;font-family:ui-monospace,Menlo,monospace">{{' + (i + 1) + '}}</span>' +
            '<select class="rf-var-sel" style="padding:.4rem;border:1px solid #e5e7eb;border-radius:6px;font-size:13px">' +
              TOKEN_OPTS.map(function (o) {
                var sel = (isCustom && o.v === '__custom__') || (!isCustom && o.v === current) ? ' selected' : '';
                return '<option value="' + esc(o.v) + '"' + sel + '>' + esc(o.l) + '</option>';
              }).join('') +
            '</select>' +
            '<input type="text" class="rf-var-custom" placeholder="Custom text…" value="' + esc(isCustom ? current : '') + '" style="padding:.4rem;border:1px solid #e5e7eb;border-radius:6px;font-size:13px;display:' + (isCustom ? 'block' : 'none') + '">' +
          '</div>';
        }
        html += '</div>';
      } else {
        html += '<div style="margin-top:.5rem;font-size:11.5px;color:#64748b">ℹ This template has no {{variables}}.</div>';
      }
      html += '</div>';
      slot.innerHTML = html;

      slot.querySelectorAll('.rf-var-row').forEach(function (row) {
        var sel = row.querySelector('.rf-var-sel');
        var inp = row.querySelector('.rf-var-custom');
        sel.addEventListener('change', function () {
          inp.style.display = sel.value === '__custom__' ? 'block' : 'none';
        });
      });
    }
    tplSel.addEventListener('change', _renderTplConfig);
    _renderTplConfig();

    /* Back / Cancel */
    document.getElementById('rf-back').onclick   = function () { viewFollowupReminders(); };
    document.getElementById('rf-cancel').onclick = function () { viewFollowupReminders(); };

    /* Delete */
    var delBtn = document.getElementById('rf-delete');
    if (delBtn) {
      delBtn.onclick = async function () {
        if (!confirm('Delete this flow?\n\nAny leads referencing it will lose their reminder queue (already-fired reminders are kept).')) return;
        delBtn.disabled = true; delBtn.textContent = 'Deleting…';
        try {
          await _api('api_reminderFlows_delete', flowId);
          toast('Flow deleted', 'ok');
          viewFollowupReminders();
        } catch (e) {
          toast('Delete failed: ' + e.message, 'err');
          delBtn.disabled = false; delBtn.textContent = '🗑 Delete flow';
        }
      };
    }

    /* Save */
    document.getElementById('rf-save').onclick = async function () {
      var status = document.getElementById('rf-status');
      var name = document.getElementById('rf-name').value.trim();
      if (!name) { status.textContent = '❌ Flow name is required'; status.style.color = '#dc2626'; return; }

      var picked = Array.from(timeChips)
        .filter(function (c) { return c.querySelector('input').checked; })
        .map(function (c) { return { offset_minutes: Number(c.getAttribute('data-off')) }; });
      if (!picked.length) { status.textContent = '❌ Pick at least 1 reminder time'; status.style.color = '#dc2626'; return; }

      var vmapNew = [];
      document.querySelectorAll('.rf-var-row').forEach(function (row) {
        var sel = row.querySelector('.rf-var-sel').value;
        var custom = row.querySelector('.rf-var-custom').value;
        vmapNew.push(sel === '__custom__' ? custom : sel);
      });
      var hdrImgInp = document.getElementById('rf-hdrimg');
      var hdrImg = hdrImgInp ? hdrImgInp.value.trim() : (flow.header_image_url || '');

      var payload = {
        id: flowId || null,
        name: name,
        description: document.getElementById('rf-desc').value,
        is_active:     document.getElementById('rf-active').checked ? 1 : 0,
        is_default:    document.getElementById('rf-default').value === '1' ? 1 : 0,
        channel_wa:    document.getElementById('rf-ch-wa').checked ? 1 : 0,
        channel_email: document.getElementById('rf-ch-email').checked ? 1 : 0,
        wa_template_name: document.getElementById('rf-watpl').value || '',
        wa_language:   document.getElementById('rf-walang').value.trim() || 'en',
        email_subject: document.getElementById('rf-esubj').value,
        email_body_html: document.getElementById('rf-ebody').value,
        send_to_lead:  document.getElementById('rf-r-lead').checked ? 1 : 0,
        send_to_owner: document.getElementById('rf-r-owner').checked ? 1 : 0,
        variable_map:  vmapNew,
        header_image_url: hdrImg
      };

      var btn = this;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await _api('api_reminderFlows_save', { flow: payload, rungs: picked });
        toast('Flow saved', 'ok');
        viewFollowupReminders();
      } catch (e) {
        status.textContent = '❌ ' + (e && e.message || e);
        status.style.color = '#dc2626';
        toast('Save failed: ' + e.message, 'err');
        btn.disabled = false; btn.textContent = isNew ? '+ Create flow' : 'Save flow';
      }
    };
  }

  /* Expose so the empty-state button can call it */
  window.REMINDER_FLOWS_v1.openBuilder = openBuilder;
  window.REMINDER_FLOWS_v1.view        = viewFollowupReminders;

  /* Registry + sidebar link injection */
  function _registerViews() {
    var V = window.VIEWS = window.VIEWS || {};
    V.followupreminders = viewFollowupReminders;
    V.reminderflows     = viewFollowupReminders;
  }

  function _hideDemoReminders() {
    try {
      var btns = document.querySelectorAll('button.admin-settings-item, [data-tab="demoreminder"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.getAttribute('data-tab') === 'demoreminder' ||
            /demo\s*reminder/i.test(b.textContent || '')) {
          b.remove();
        }
      }
      var nav = document.querySelector('.sidebar nav');
      if (nav) {
        var links = nav.querySelectorAll('a');
        for (var j = 0; j < links.length; j++) {
          var a = links[j];
          if (/demo\s*reminder/i.test(a.textContent || '')) a.remove();
        }
      }
    } catch (e) {}
  }

  function _injectSettingsInnerButton() {
    try {
      if (document.getElementById('rf-settings-btn')) return;
      var groups = document.querySelectorAll('.admin-settings-group');
      var target = null;
      for (var i = 0; i < groups.length; i++) {
        var title = groups[i].querySelector('.admin-settings-group-title');
        if (title && /^ai\s*features/i.test(title.textContent.trim())) {
          target = groups[i]; break;
        }
      }
      if (!target) return;
      var btn = document.createElement('button');
      btn.id = 'rf-settings-btn';
      btn.className = 'admin-settings-item';
      btn.setAttribute('data-tab', 'followupreminders');
      btn.setAttribute('data-label', '🔔 follow-up reminders');
      btn.setAttribute('data-search', '🔔 follow-up reminders whatsapp email alert time before flow');
      btn.textContent = '🔔 Follow-up Reminders';
      btn.onclick = function (e) {
        e.preventDefault();
        try {
          if (typeof window.navigateTo === 'function') return window.navigateTo('followupreminders');
          if (window.go) return window.go('followupreminders');
          if (window.VIEWS && window.VIEWS.followupreminders) return window.VIEWS.followupreminders();
          viewFollowupReminders();
        } catch (_) { viewFollowupReminders(); }
      };
      target.appendChild(btn);
    } catch (e) {}
  }

  function _ensureFab() {
    /* FAB_REMOVE_v1 (2026-07-05) — bell FAB removed per user request.
     * If a legacy FAB is on the page, evict it. Otherwise do nothing. */
    var old = document.getElementById('rf-fab');
    if (old) old.remove();
    return;
    /* legacy code (dead) below */
    if (document.getElementById('rf-fab')) return;
    var fab = document.createElement('button');
    fab.id = 'rf-fab';
    fab.title = 'Follow-up Reminders';
    fab.innerHTML = '🔔';
    fab.style.cssText = [
      'position:fixed', 'bottom:22px', 'right:22px', 'width:52px', 'height:52px',
      'border-radius:50%', 'background:linear-gradient(135deg,#6366f1,#4f46e5)',
      'color:#fff', 'border:0', 'font-size:22px', 'cursor:pointer', 'z-index:9988',
      'box-shadow:0 8px 22px rgba(99,102,241,.5)', 'transition:transform .15s'
    ].join(';');
    fab.onmouseover = function () { this.style.transform = 'scale(1.08)'; };
    fab.onmouseout  = function () { this.style.transform = ''; };
    fab.onclick = function () {
      if (typeof window.navigateTo === 'function') window.navigateTo('followupreminders');
      else if (window.go) window.go('followupreminders');
      else if (window.VIEWS && window.VIEWS.followupreminders) window.VIEWS.followupreminders();
      else viewFollowupReminders();
    };
    document.body.appendChild(fab);
  }

  function _injectSidebarLink() {
    try {
      var nav = document.querySelector('.sidebar nav') ||
                document.querySelector('.sidebar .nav') ||
                document.querySelector('aside nav') ||
                document.querySelector('.side-nav') ||
                document.querySelector('#sidebar nav') ||
                document.querySelector('nav.sidebar-nav');
      if (!nav) return;
      if (document.getElementById('nav-followupreminders')) return;
      var link = document.createElement('a');
      link.id = 'nav-followupreminders';
      link.href = '#/followupreminders';
      link.setAttribute('data-view', 'followupreminders');
      link.innerHTML = '<span class="nav-icon">🔔</span> Follow-up Reminders';
      link.style.cssText = 'display:flex;align-items:center;gap:.55rem;padding:.48rem .65rem;border-radius:6px;color:inherit;font-size:.85rem;text-decoration:none;cursor:pointer';
      link.onmouseover = function () { this.style.background = 'rgba(148,163,184,.15)'; };
      link.onmouseout  = function () { this.style.background = ''; };
      link.onclick = function (e) {
        e.preventDefault();
        if (typeof window.navigateTo === 'function') window.navigateTo('followupreminders');
        else if (window.go) window.go('followupreminders');
        else if (window.VIEWS && window.VIEWS.followupreminders) window.VIEWS.followupreminders();
      };
      var aiGroup = Array.from(nav.querySelectorAll('.nav-group-head'))
        .find(function (h) { return /ai\s*features/i.test(h.textContent); });
      if (aiGroup && aiGroup.nextElementSibling) {
        aiGroup.nextElementSibling.appendChild(link);
        return;
      }
      var settingsGroup = Array.from(nav.querySelectorAll('.nav-group-head'))
        .find(function (h) { return /settings/i.test(h.textContent); });
      if (settingsGroup && settingsGroup.nextElementSibling) {
        settingsGroup.nextElementSibling.appendChild(link);
      } else {
        nav.appendChild(link);
      }
    } catch (e) {}
  }

  var _lastRun = 0;
  var _observerStarted = false;
  function _runInject() {
    var now = Date.now();
    if (now - _lastRun < 400) return;
    _lastRun = now;
    try { _registerViews(); } catch (_) {}
    try { _injectSidebarLink(); } catch (_) {}
    try { _injectSettingsInnerButton(); } catch (_) {}
    try { _hideDemoReminders(); } catch (_) {}
    try { _ensureFab(); } catch (_) {}
  }
  function _startObserver() {
    if (_observerStarted) return;
    _observerStarted = true;
    try {
      var mo = new MutationObserver(function () { _runInject(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
    _runInject();
    setTimeout(_runInject, 200);
    setTimeout(_runInject, 600);
    setTimeout(_runInject, 1500);
    setTimeout(_runInject, 3000);
    if (location.hash === '#/followupreminders' || location.hash === '#/reminderflows') {
      setTimeout(function () { viewFollowupReminders(); }, 400);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _startObserver);
  } else {
    _startObserver();
  }
})();
