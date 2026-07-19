/* ============================================================================
 * WHATSAPP_PACK_v1 — isolated SPA module (2026-07-18)
 *
 * Loaded by public/tenant/index.html as a script after app.js.
 * All WhatsApp Suite pack VIEWS live here so app.js never grows.
 *
 *   - VIEWS.wapackinbox    (Shared Team Inbox + Manager Monitor)
 *   - VIEWS.wapackretarget (Engagement-based Smart Retargeting)
 *
 * Backend APIs live in routes/packs/whatsapp.js (api_wapack_*).
 * ============================================================================ */
(function () {
  'use strict';

  function ready(fn) {
    if (window.VIEWS && window.api && window.h) return fn();
    setTimeout(function () { ready(fn); }, 60);
  }

  ready(function () {
    const VIEWS = window.VIEWS;
    const api   = window.api;
    const h     = window.h;
    const toast = window.toast || function (m) { console.log(m); };

    const WA   = '#25d366';
    const WA_D = '#128c7e';
    const INK  = '#0f172a';

    // ---- shared helpers ----------------------------------------------
    function btn(label, onclick, kind) {
      const primary = kind === 'primary';
      return h('button', { onclick, style: primary
        ? { background: 'linear-gradient(135deg,#25d366,#128c7e)', color: '#fff', border: 0,
            padding: '7px 12px', borderRadius: '7px', fontWeight: 600, fontSize: '12.5px', cursor: 'pointer' }
        : { background: '#fff', border: '1px solid #d1fae5', color: INK,
            padding: '7px 12px', borderRadius: '7px', fontWeight: 600, fontSize: '12.5px', cursor: 'pointer' } }, label);
    }
    function pill(text, bg, fg) {
      return h('span', { style: { background: bg || '#f1f5f9', color: fg || '#475569',
        padding: '2px 8px', borderRadius: '99px', fontSize: '11px', fontWeight: 700, display: 'inline-block' } }, text);
    }
    function statusPill(s) {
      if (s === 'resolved') return pill('✓ Resolved', '#dcfce7', '#166534');
      if (s === 'pending')  return pill('⏳ Pending', '#fffbeb', '#b45309');
      return pill('● Open', '#e0f2fe', '#0369a1');
    }
    function topbar(crumb, title, actions) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid #d1fae5' } },
        h('div', {}, h('div', { style: { fontSize: '12px', color: '#64748b' } }, crumb),
          h('h1', { style: { fontSize: '20px', margin: '4px 0 0' } }, title)),
        h('div', { style: { display: 'flex', gap: '6px' } }, ...(actions || [])));
    }
    function tabStyle(on) {
      return { padding: '8px 14px', borderRadius: '7px', border: 0, cursor: 'pointer',
        fontSize: '12.5px', fontWeight: 700,
        background: on ? 'linear-gradient(180deg,#25d366,#128c7e)' : 'transparent',
        color: on ? '#fff' : '#475569' };
    }
    function sel(options, value) {
      const s = h('select', { style: { padding: '7px 9px', border: '1px solid #d1fae5',
        borderRadius: '7px', fontSize: '13px', background: '#fff' } });
      options.forEach(function (o) {
        const v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? (o[1] || o[0]) : o;
        const opt = h('option', { value: v }, l);
        if (String(v) === String(value == null ? '' : value)) opt.selected = true;
        s.appendChild(opt);
      });
      return s;
    }
    function modal(title, body, actions) {
      const overlay = h('div', { style: { position: 'fixed', inset: '0', background: 'rgba(15,23,42,.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 9999, padding: '36px 16px', overflowY: 'auto' } });
      function close() { try { document.body.removeChild(overlay); } catch (_) {} }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      const foot = h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px',
        marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #ecfdf5' } });
      (actions || []).forEach(function (a) { foot.appendChild(btn(a[0], function () { a[1](close); }, a[2])); });
      foot.appendChild(btn('Close', close));
      const box = h('div', { style: { background: '#fff', borderRadius: '14px', padding: '18px',
        width: '100%', maxWidth: '620px', boxShadow: '0 20px 60px rgba(0,0,0,.25)' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
          h('h3', { style: { margin: 0, fontSize: '15px' } }, title),
          h('button', { onclick: close, style: { border: 0, background: 'transparent', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' } }, '×')),
        body, foot);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      return { close: close };
    }
    function fmtTime(ts) {
      if (!ts) return '';
      try {
        const d = new Date(ts), now = new Date();
        const sameDay = d.toDateString() === now.toDateString();
        return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                       : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
      } catch (_) { return String(ts).slice(0, 16); }
    }
    function card(children) {
      return h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '10px',
        padding: '14px', marginBottom: '12px' } }, ...children);
    }

    let AGENTS = [];
    async function loadAgents() {
      if (AGENTS.length) return AGENTS;
      try { AGENTS = (await api('api_wapack_agents')).agents || []; } catch (_) { AGENTS = []; }
      return AGENTS;
    }

    // ════════════════════════════════════════════════════════════════
    //  TEAM INBOX + MANAGER MONITOR
    // ════════════════════════════════════════════════════════════════
    VIEWS.wapackinbox = async function (view) {
      let tab = 'inbox';           // inbox | monitor
      let scope = 'all';           // mine | unassigned | all | resolved
      let query = '';
      let me = null;

      function render() {
        view.innerHTML = '';
        view.appendChild(topbar('WhatsApp / Team Inbox', '📥 Team Inbox', [
          btn('🔄 Refresh', function () { render(); })
        ]));
        const tabs = h('div', { style: { display: 'flex', gap: '6px', background: '#fff', padding: '6px',
          borderRadius: '10px', border: '1px solid #d1fae5', marginBottom: '14px', width: 'fit-content' } });
        [['inbox', '📥 Inbox'], ['monitor', '👀 Manager Monitor']].forEach(function (t) {
          tabs.appendChild(h('button', { style: tabStyle(tab === t[0]), onclick: function () { tab = t[0]; render(); } }, t[1]));
        });
        view.appendChild(tabs);
        const body = h('div'); view.appendChild(body);
        if (tab === 'inbox') renderInbox(body); else renderMonitor(body);
      }

      async function renderInbox(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading conversations…</div>';
        let data;
        try { data = await api('api_wapack_inbox_list', { scope: scope, q: query }); }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        me = data.me || me;
        const c = data.counts || {};

        body.innerHTML = '';
        // scope + search bar
        const scopeBar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center',
          marginBottom: '12px', flexWrap: 'wrap' } });
        [['mine', 'Mine (' + (c.mine || 0) + ')'], ['unassigned', 'Unassigned (' + (c.unassigned || 0) + ')'],
         ['all', 'All open'], ['resolved', 'Resolved']].forEach(function (o) {
          const on = scope === o[0];
          scopeBar.appendChild(h('button', { onclick: function () { scope = o[0]; renderInbox(body); },
            style: { border: '1px solid #d1fae5', borderRadius: '99px', padding: '5px 12px', fontSize: '12px',
              fontWeight: 700, cursor: 'pointer', background: on ? WA_D : '#fff', color: on ? '#fff' : '#475569' } }, o[1]));
        });
        const search = h('input', { value: query, placeholder: '🔍 name or number',
          style: { padding: '6px 10px', border: '1px solid #d1fae5', borderRadius: '7px', fontSize: '13px', marginLeft: 'auto' },
          onkeydown: function (e) { if (e.key === 'Enter') { query = search.value; renderInbox(body); } } });
        scopeBar.appendChild(search);
        body.appendChild(scopeBar);

        const threads = data.threads || [];
        if (!threads.length) {
          body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } },
            'No conversations in this view.')]));
          return;
        }
        threads.forEach(function (t) {
          const row = h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '10px',
            padding: '11px 13px', marginBottom: '8px', display: 'flex', gap: '12px', alignItems: 'center' } },
            h('div', { style: { width: '38px', height: '38px', borderRadius: '50%', background: '#dcfce7',
              color: WA_D, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0 } },
              String(t.name || '?').slice(0, 1).toUpperCase()),
            h('div', { style: { flex: 1, minWidth: 0, cursor: 'pointer' }, onclick: function () { openThread(t); } },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h('b', { style: { fontSize: '13.5px' } }, t.name),
                t.unread ? pill(String(t.unread) + ' new', '#25d366', '#fff') : null,
                statusPill(t.status)),
              h('div', { style: { fontSize: '12px', color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                (t.last_dir === 'in' ? '↩ ' : '↪ ') + (t.last_body || '') )),
            h('div', { style: { textAlign: 'right', flexShrink: 0 } },
              h('div', { style: { fontSize: '11px', color: '#94a3b8' } }, fmtTime(t.last_at)),
              t.assigned_name ? pill('👤 ' + t.assigned_name, '#eff6ff', '#1d4ed8')
                              : btn('Claim', function () { doAction('api_wapack_inbox_claim', { phone: t.phone }, body); }, 'primary')));
          body.appendChild(row);
        });
      }

      async function doAction(fn, args, body) {
        try { await api(fn, args); toast('Done'); renderInbox(body || view); }
        catch (e) { toast(e.message); }
      }

      async function openThread(t) {
        let data;
        try { data = await api('api_wapack_inbox_thread', { phone: t.phone }); }
        catch (e) { toast(e.message); return; }
        await loadAgents();
        const msgs = data.messages || [];
        const ib = data.inbox || {};
        const wrap = h('div', {});
        // messages
        const thread = h('div', { style: { maxHeight: '360px', overflowY: 'auto', padding: '8px',
          background: '#ece5dd', borderRadius: '10px', marginBottom: '12px' } });
        if (!msgs.length) thread.appendChild(h('div', { style: { color: '#64748b', textAlign: 'center', padding: '20px' } }, 'No messages.'));
        msgs.forEach(function (m) {
          const inbound = m.direction === 'in';
          thread.appendChild(h('div', { style: { display: 'flex', justifyContent: inbound ? 'flex-start' : 'flex-end', margin: '4px 0' } },
            h('div', { style: { maxWidth: '75%', background: inbound ? '#fff' : '#dcf8c6', borderRadius: '8px',
              padding: '6px 9px', fontSize: '12.5px', boxShadow: '0 1px 1px rgba(0,0,0,.08)' } },
              h('div', {}, m.body || ''),
              h('div', { style: { fontSize: '10px', color: '#667781', textAlign: 'right', marginTop: '2px' } }, fmtTime(m.created_at)))));
        });
        wrap.appendChild(thread);
        // assign / transfer controls
        const agentSel = sel([['', '— pick agent —']].concat(AGENTS.map(function (a) { return [a.id, a.name + ' (' + a.role + ')']; })), '');
        wrap.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          agentSel,
          btn('Assign', function () {
            if (!agentSel.value) { toast('Pick an agent'); return; }
            api('api_wapack_inbox_assign', { phone: t.phone, user_id: agentSel.value })
              .then(function () { toast('Assigned'); m2.close(); render(); }).catch(function (e) { toast(e.message); });
          }, 'primary'),
          btn('Transfer', function () {
            if (!agentSel.value) { toast('Pick an agent'); return; }
            api('api_wapack_inbox_transfer', { phone: t.phone, user_id: agentSel.value })
              .then(function () { toast('Transferred'); m2.close(); render(); }).catch(function (e) { toast(e.message); });
          })));

        const acts = [['🙋 Claim to me', function (close) { api('api_wapack_inbox_claim', { phone: t.phone }).then(function () { toast('Claimed'); close(); render(); }).catch(function (e) { toast(e.message); }); }, 'primary']];
        if (ib.status === 'resolved') acts.push(['↩ Reopen', function (close) { api('api_wapack_inbox_reopen', { phone: t.phone }).then(function () { toast('Reopened'); close(); render(); }).catch(function (e) { toast(e.message); }); }]);
        else acts.push(['✓ Resolve', function (close) { api('api_wapack_inbox_resolve', { phone: t.phone }).then(function () { toast('Resolved'); close(); render(); }).catch(function (e) { toast(e.message); }); }]);

        const m2 = modal('💬 ' + (t.name || t.phone) + '  ' + (data.assigned_name ? '· 👤 ' + data.assigned_name : ''), wrap, acts);
      }

      async function renderMonitor(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let data;
        try { data = await api('api_wapack_inbox_monitor'); }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        body.innerHTML = '';
        // per-agent table
        body.appendChild(h('div', { style: { display: 'flex', gap: '10px', marginBottom: '12px' } },
          kpi('Unassigned', data.unassigned || 0, '#b45309')));
        const tblWrap = card([h('h3', { style: { margin: '0 0 8px', fontSize: '14px' } }, '👥 Workload by agent')]);
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } },
          h('thead', {}, h('tr', { style: { background: '#f0fdf4' } },
            ['Agent', 'Open', 'Pending', 'Resolved'].map(function (l) {
              return h('th', { style: { textAlign: l === 'Agent' ? 'left' : 'center', padding: '8px 10px',
                borderBottom: '1px solid #d1fae5', fontSize: '11px', textTransform: 'uppercase', color: '#475569' } }, l); }))),
          h('tbody', {}, ...(data.per_agent || []).map(function (a) {
            return h('tr', {},
              h('td', { style: td() }, h('b', {}, a.name)),
              h('td', { style: tdc() }, statusNum(a.open, '#0369a1')),
              h('td', { style: tdc() }, statusNum(a.pending, '#b45309')),
              h('td', { style: tdc() }, statusNum(a.resolved, '#166534')));
          })));
        if (!(data.per_agent || []).length) tbl.appendChild(h('tbody', {}, h('tr', {}, h('td', { colspan: 4, style: { padding: '14px', textAlign: 'center', color: '#64748b' } }, 'No assigned conversations yet.'))));
        tblWrap.appendChild(tbl);
        body.appendChild(tblWrap);

        // handoff log
        const logWrap = card([h('h3', { style: { margin: '0 0 8px', fontSize: '14px' } }, '🔁 Live handoff log')]);
        const hs = data.handoffs || [];
        if (!hs.length) logWrap.appendChild(h('div', { style: { color: '#64748b', fontSize: '12.5px' } }, 'No handoffs yet.'));
        hs.forEach(function (e) {
          const verb = { claim: 'claimed', assign: 'assigned', transfer: 'transferred', resolve: 'resolved', reopen: 'reopened', note: 'noted' }[e.action] || e.action;
          logWrap.appendChild(h('div', { style: { display: 'flex', gap: '8px', padding: '6px 0', borderBottom: '1px solid #ecfdf5', fontSize: '12.5px' } },
            h('span', { style: { color: '#94a3b8', minWidth: '52px' } }, fmtTime(e.created_at)),
            h('div', { style: { flex: 1 } },
              h('b', {}, e.from_name || '—'), ' ' + verb + ' ',
              e.to_name ? h('b', {}, '→ ' + e.to_name) : null,
              h('span', { style: { color: '#64748b' } }, '  · ' + e.phone),
              e.note ? h('div', { style: { color: '#94a3b8', fontSize: '11.5px' } }, e.note) : null)));
        });
        body.appendChild(logWrap);
      }

      function kpi(label, val, color) {
        return h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '10px',
          padding: '12px 16px', borderTop: '3px solid ' + (color || WA_D) } },
          h('div', { style: { fontSize: '11px', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 } }, label),
          h('div', { style: { fontSize: '22px', fontWeight: 800, color: INK } }, String(val)));
      }
      function statusNum(n, c) { return h('span', { style: { fontWeight: 800, color: Number(n) ? c : '#cbd5e1' } }, String(n || 0)); }
      function td() { return { padding: '8px 10px', borderBottom: '1px solid #ecfdf5' }; }
      function tdc() { return { padding: '8px 10px', borderBottom: '1px solid #ecfdf5', textAlign: 'center' }; }

      render();
    };

    // ════════════════════════════════════════════════════════════════
    //  SMART RETARGETING
    // ════════════════════════════════════════════════════════════════
    VIEWS.wapackretarget = async function (view) {
      let campaignId = '';
      let campaigns = [];

      function render() {
        view.innerHTML = '';
        view.appendChild(topbar('WhatsApp / Smart Retargeting', '🎯 Smart Retargeting', [
          btn('🔄 Refresh', function () { render(); })
        ]));
        const body = h('div'); view.appendChild(body);
        loadSegments(body);
      }

      async function loadSegments(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Crunching engagement…</div>';
        let data;
        try { data = await api('api_wapack_retarget_segments', campaignId ? { campaign_id: campaignId } : {}); }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        campaigns = data.campaigns || [];
        body.innerHTML = '';

        // campaign filter
        const filt = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '12.5px', color: '#475569' } }, 'Base audience:'));
        const campSel = sel([['', 'All campaigns']].concat(campaigns.map(function (c) { return [c.id, c.name]; })), campaignId);
        campSel.onchange = function () { campaignId = campSel.value; render(); };
        filt.appendChild(campSel);
        body.appendChild(filt);

        // segment cards
        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: '12px' } });
        (data.segments || []).forEach(function (s) {
          grid.appendChild(h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '12px',
            padding: '14px', cursor: s.count ? 'pointer' : 'default', opacity: s.count ? 1 : .55 },
            onclick: function () { if (s.count) openAudience(s); } },
            h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '6px' } }, s.label),
            h('div', { style: { fontSize: '26px', fontWeight: 800, color: WA_D } }, String(s.count)),
            h('div', { style: { fontSize: '11.5px', color: '#64748b', marginTop: '4px' } },
              s.count ? 'contacts · click to view / retarget' : 'no contacts')));
        });
        body.appendChild(grid);
        body.appendChild(h('div', { style: { fontSize: '11.5px', color: '#94a3b8', marginTop: '12px' } },
          'Segments are computed from your WhatsApp campaign delivery + read receipts and inbound replies.'));
      }

      async function openAudience(seg) {
        let data;
        try { data = await api('api_wapack_retarget_audience', { segment: seg.key, campaign_id: campaignId || null, limit: 1000 }); }
        catch (e) { toast(e.message); return; }
        const aud = data.audience || [];
        const listWrap = h('div', { style: { maxHeight: '340px', overflowY: 'auto', border: '1px solid #ecfdf5', borderRadius: '8px' } });
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' } },
          h('thead', {}, h('tr', { style: { background: '#f0fdf4' } },
            ['Name', 'Number', 'Campaign', 'Status'].map(function (l) {
              return h('th', { style: { textAlign: 'left', padding: '7px 9px', position: 'sticky', top: 0,
                background: '#f0fdf4', borderBottom: '1px solid #d1fae5', fontSize: '11px', textTransform: 'uppercase', color: '#475569' } }, l); }))),
          h('tbody', {}, ...aud.map(function (a) {
            return h('tr', {},
              h('td', { style: td2() }, a.name || '—'),
              h('td', { style: td2() }, a.phone),
              h('td', { style: td2() }, a.campaign_name || '—'),
              h('td', { style: td2() }, a.status || '—'));
          })));
        listWrap.appendChild(tbl);

        const bodyEl = h('div', {},
          h('div', { style: { fontSize: '13px', color: '#475569', marginBottom: '10px' } },
            seg.label + ' — ', h('b', {}, String(aud.length)), ' contacts'),
          listWrap);

        modal('🎯 ' + seg.label, bodyEl, [
          ['⬇ Export CSV', function () { exportCsv(seg, aud); }],
          ['📋 Copy numbers', function () { copyNumbers(aud); }],
          ['🚀 Retarget with WhatsApp', function (close) { close(); openRetargetCampaign(seg); }, 'primary']
        ]);
      }

      function exportCsv(seg, aud) {
        const rows = [['name', 'phone', 'campaign', 'status']].concat(
          aud.map(function (a) { return [a.name || '', a.phone || '', a.campaign_name || '', a.status || '']; }));
        const csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'retarget-' + seg.key + '.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        toast('CSV downloaded');
      }
      function copyNumbers(aud) {
        const nums = aud.map(function (a) { return a.phone; }).filter(Boolean).join(', ');
        try { navigator.clipboard.writeText(nums); toast('Numbers copied'); }
        catch (_) { toast('Copy failed'); }
      }

      async function openRetargetCampaign(seg) {
        let tpls = [];
        try { tpls = (await api('api_wb_templates_list')) || []; }
        catch (_) { tpls = []; }
        // api_wb_templates_list may return array or {templates:[]}
        if (tpls && tpls.templates) tpls = tpls.templates;
        if (!Array.isArray(tpls)) tpls = [];
        const names = tpls.map(function (t) { return t.name || t.template_name || t; }).filter(Boolean);
        if (!names.length) { toast('No WhatsApp templates found — create one in WhatsApp settings first.'); return; }
        const tplSel = sel(names, names[0]);
        const bodyEl = h('div', {},
          h('div', { style: { fontSize: '12.5px', color: '#475569', marginBottom: '10px' } },
            'Fire a fresh WhatsApp campaign at everyone in ', h('b', {}, seg.label), '. Pick an approved template:'),
          tplSel);
        modal('🚀 Retarget · ' + seg.label, bodyEl, [
          ['Create campaign', function (close) {
            api('api_wapack_retarget_createCampaign', { segment: seg.key, campaign_id: campaignId || null, template_name: tplSel.value })
              .then(function (r) { toast('Campaign created for ' + (r.targeted || 0) + ' contacts'); close(); })
              .catch(function (e) { toast(e.message); });
          }, 'primary']
        ]);
      }

      function td2() { return { padding: '7px 9px', borderBottom: '1px solid #f0fdf4' }; }

      render();
    };

    // ════════════════════════════════════════════════════════════════
    //  FORMS & WEBVIEWS
    // ════════════════════════════════════════════════════════════════
    const FIELD_TYPES = [['text', 'Text'], ['email', 'Email'], ['phone', 'Phone'], ['number', 'Number'], ['select', 'Dropdown']];
    function phoneMock(children) {
      return h('div', { style: { width: '260px', border: '8px solid #111827', borderRadius: '26px',
        background: '#ece5dd', padding: '10px', minHeight: '360px' } },
        h('div', { style: { background: WA_D, color: '#fff', margin: '-10px -10px 8px', padding: '10px',
          borderRadius: '18px 18px 0 0', fontSize: '12px', fontWeight: 700 } }, 'WhatsApp'),
        ...children);
    }

    VIEWS.wapackforms = async function (view) {
      let tab = 'forms';
      function render() {
        view.innerHTML = '';
        view.appendChild(topbar('WhatsApp / Forms & WebViews', '📝 Forms & WebViews', [btn('🔄 Refresh', function () { render(); })]));
        const tabs = h('div', { style: { display: 'flex', gap: '6px', background: '#fff', padding: '6px',
          borderRadius: '10px', border: '1px solid #d1fae5', marginBottom: '14px', width: 'fit-content' } });
        [['forms', '📝 In-chat Forms'], ['webviews', '🌐 WebViews']].forEach(function (t) {
          tabs.appendChild(h('button', { style: tabStyle(tab === t[0]), onclick: function () { tab = t[0]; render(); } }, t[1]));
        });
        view.appendChild(tabs);
        const body = h('div'); view.appendChild(body);
        (tab === 'forms' ? renderForms : renderWebviews)(body);
      }
      view.appendChild(h('div'));

      async function renderForms(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let forms;
        try { forms = (await api('api_wapack_forms_list')).forms || []; }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        body.innerHTML = '';
        body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
          h('div', { style: { fontSize: '11.5px', color: '#64748b' } }, 'Capture leads without leaving the WhatsApp chat. Publishing uses Meta Flows on your WABA.'),
          btn('＋ New form', function () { formModal(null); }, 'primary')));

        // WA_PACK_BOT_FORM_v1 — AI Bot auto-send config: when an inbound message
        // contains the keyword, the AI bot sends the chosen form automatically.
        if (forms.length) {
          let trig = null;
          try { trig = (await api('api_wapack_bot_trigger_get')).trigger; } catch (_) {}
          const curType = (trig && trig.trigger_type) || 'keyword';
          const typeSel = sel([['keyword', 'When a message contains a word'], ['after_first_reply', "After the bot's 1st reply"]], curType);
          const kwI = h('input', { value: (trig && trig.keyword) || '', placeholder: 'Trigger word (e.g. brochure)', style: { padding: '7px 9px', border: '1px solid #bfdbfe', borderRadius: '7px', fontSize: '13px', width: '170px' } });
          const formSel = sel(forms.map(function (f) { return [String(f.id), f.name]; }), trig ? String(trig.form_id) : String(forms[0].id));
          const enChk = h('input', { type: 'checkbox' }); enChk.checked = trig ? trig.enabled != 0 : true;
          const enL = h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer' } }, enChk, document.createTextNode('Enabled'));
          const kwWrap = h('span', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('span', { style: { fontSize: '12px', color: '#64748b' } }, 'word'), kwI);
          const hintEl = h('div', { style: { fontSize: '11.5px', color: '#475569', marginBottom: '8px' } }, '');
          function syncType() {
            kwWrap.style.display = typeSel.value === 'keyword' ? 'flex' : 'none';
            hintEl.textContent = typeSel.value === 'keyword'
              ? 'When a customer message contains the trigger word, the bot sends the form (native in-chat form if a Flow ID is set, else a text prompt).'
              : "After the bot has replied once, the next customer message triggers the form — sent one time per contact. Great for capturing details right after the first exchange.";
          }
          typeSel.onchange = syncType;
          body.appendChild(h('div', { style: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' } },
            h('div', { style: { fontWeight: 700, fontSize: '13px', color: '#1e40af', marginBottom: '6px' } }, '🤖 AI Bot auto-send'),
            hintEl,
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: '12px', color: '#64748b' } }, 'Trigger:'), typeSel, kwWrap,
              h('span', { style: { fontSize: '12px', color: '#64748b' } }, 'send'), formSel, enL,
              btn('💾 Save', async function () {
                const type = typeSel.value;
                if (type === 'keyword' && !kwI.value.trim()) { toast('Enter a trigger word'); return; }
                try { await api('api_wapack_bot_trigger_save', { trigger_type: type, keyword: kwI.value.trim(), form_id: Number(formSel.value), enabled: enChk.checked }); toast('Bot trigger saved'); }
                catch (e) { toast(e.message); }
              }, 'primary'))));
          syncType();
        }

        if (!forms.length) { body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } }, 'No forms yet.')])); return; }
        forms.forEach(function (f) {
          body.appendChild(h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '10px',
            padding: '12px 14px', marginBottom: '8px', display: 'flex', gap: '12px', alignItems: 'center' } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, h('b', {}, f.name),
                f.status === 'published' ? pill('✓ Published', '#dcfce7', '#166534') : pill('Draft', '#f1f5f9', '#475569')),
              h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '2px', display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
                h('span', {}, (f.fields || []).length + ' fields · ' + (f.submissions || 0) + ' submissions'),
                f.flow_id ? pill('✓ Opens in chat', '#dcfce7', '#166534') : pill('Text prompt', '#f1f5f9', '#475569'))),
            btn(f.flow_id ? '🔄 Re-publish' : '🚀 Publish in-chat', async function (e) {
              var b = e && e.target; if (b) { b.disabled = true; b.textContent = '⏳ Publishing…'; }
              try { var r = await api('api_wapack_form_publishFlow', { form_id: f.id }); if (r && r.ok) { toast('Published — this form now opens inside the chat ✓'); render(); } else { toast('Publish failed: ' + ((r && r.error) || 'unknown')); if (b) { b.disabled = false; } } }
              catch (er) { toast(er.message); if (b) { b.disabled = false; } }
            }, 'primary'),
            btn('📤 Send test', async function () {
              const to = prompt('Send "' + f.name + '" to which WhatsApp number? (with country code)');
              if (!to) return;
              try { const r = await api('api_wapack_form_send', { form_id: f.id, phone: to }); toast(r && r.sent ? ('Sent (' + (r.mode || '') + ')') : ('Failed: ' + ((r && r.error) || 'unknown'))); }
              catch (e) { toast(e.message); }
            }),
            btn('👁 Responses', function () { responsesModal(f); }),
            btn('✏️ Edit', function () { formModal(f); }),
            btn('🗑', async function () { if (!confirm('Delete form?')) return; try { await api('api_wapack_form_delete', { id: f.id }); render(); } catch (e) { toast(e.message); } })));
        });
      }

      function formModal(f) {
        f = f || {}; let fields = (f.fields || []).slice();
        const nameI = h('input', { value: f.name || '', placeholder: 'Form name', style: inpS() });
        const descI = h('input', { value: f.description || '', placeholder: 'Short description', style: inpS() });
        const statusSel = sel([['draft', 'Draft'], ['published', 'Published']], f.status || 'draft');
        // WA_PACK_BOT_FORM_v1 — native Flow linkage (optional). With a Flow ID the
        // form is delivered as a real in-chat WhatsApp form; without it, the bot
        // sends a text prompt listing the fields (works with no WABA Flow).
        const flowIdI = h('input', { value: f.flow_id || '', placeholder: 'Meta Flow ID — optional, enables the NATIVE in-chat form', style: inpS() });
        const ctaI = h('input', { value: f.cta_text || '', placeholder: 'Button text (e.g. Open form)', style: inpS() });
        const bodyTxtI = h('input', { value: f.body_text || '', placeholder: 'Message shown above the form / prompt', style: inpS() });
        const screenI = h('input', { value: f.flow_screen || '', placeholder: 'Flow first screen id (default RECOMMEND)', style: inpS() });
        const fieldsWrap = h('div');
        const preview = h('div');
        function draw() {
          fieldsWrap.innerHTML = '';
          fields.forEach(function (fl, idx) {
            const labelI = h('input', { value: fl.label || '', placeholder: 'Field label — e.g. Full name',
              style: { width: '100%', padding: '7px 9px', border: '1px solid #d1fae5', borderRadius: '7px', boxSizing: 'border-box', fontWeight: 600, fontSize: '13px' } });
            labelI.oninput = function () { fl.label = labelI.value; drawPreview(); };
            const typeS = sel(FIELD_TYPES, fl.type || 'text'); typeS.style.width = '130px';
            const optRow = h('div');
            function drawOpt() {
              optRow.innerHTML = '';
              if (typeS.value === 'select') {
                const o = h('input', { value: (fl.options || []).join(', '), placeholder: 'Dropdown options, comma-separated',
                  style: { width: '100%', padding: '6px 8px', border: '1px solid #d1fae5', borderRadius: '6px', marginTop: '6px', boxSizing: 'border-box', fontSize: '12px' } });
                o.oninput = function () { fl.options = o.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean); drawPreview(); };
                optRow.appendChild(o);
              }
            }
            typeS.onchange = function () { fl.type = typeS.value; drawOpt(); drawPreview(); };
            const reqL = h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer' } });
            const c = h('input', { type: 'checkbox' }); c.checked = !!fl.required; c.onchange = function () { fl.required = c.checked; drawPreview(); };
            reqL.appendChild(c); reqL.appendChild(document.createTextNode('Required'));
            const cardEl = h('div', { style: { border: '1px solid #d1fae5', borderRadius: '9px', padding: '10px', marginBottom: '8px', background: '#f8fffb' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' } },
                h('span', { style: { fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.4px', color: '#94a3b8', fontWeight: 700 } }, 'Field ' + (idx + 1)),
                btn('🗑 Remove', function () { fields.splice(idx, 1); draw(); })),
              labelI,
              h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginTop: '6px' } }, typeS, reqL),
              optRow);
            drawOpt();
            fieldsWrap.appendChild(cardEl);
          });
          drawPreview();
        }
        function drawPreview() {
          preview.innerHTML = '';
          preview.appendChild(phoneMock([
            h('div', { style: { background: '#fff', borderRadius: '8px', padding: '10px', fontSize: '12px' } },
              h('b', {}, nameI.value || 'Form'),
              f.description || descI.value ? h('div', { style: { color: '#667781', fontSize: '11px', margin: '2px 0 8px' } }, descI.value) : null,
              ...fields.map(function (fl) {
                return h('div', { style: { marginBottom: '7px' } },
                  h('div', { style: { fontSize: '11px', color: '#374151', marginBottom: '2px' } }, (fl.label || 'Field') + (fl.required ? ' *' : '')),
                  fl.type === 'select'
                    ? h('div', { style: { border: '1px solid #d1d5db', borderRadius: '6px', padding: '5px 7px', color: '#9ca3af', fontSize: '11px' } }, '▾ ' + ((fl.options && fl.options[0]) || 'Select'))
                    : h('div', { style: { border: '1px solid #d1d5db', borderRadius: '6px', padding: '5px 7px', color: '#9ca3af', fontSize: '11px' } }, fl.type === 'email' ? 'name@email.com' : fl.type === 'phone' ? '+91…' : '…'));
              }),
              h('div', { style: { background: WA, color: '#fff', textAlign: 'center', padding: '7px', borderRadius: '6px', fontWeight: 700, fontSize: '12px', marginTop: '4px' } }, 'Submit'))
          ]));
        }
        nameI.oninput = drawPreview; descI.oninput = drawPreview;
        const bodyEl = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 280px', gap: '16px' } },
          h('div', {},
            h('div', { style: { marginBottom: '8px' } }, nameI),
            h('div', { style: { marginBottom: '8px' } }, descI),
            h('div', { style: { marginBottom: '8px' } }, statusSel),
            h('details', { style: { margin: '4px 0 8px', border: '1px solid #d1fae5', borderRadius: '8px', padding: '8px 10px', background: '#f8fffb' } },
              h('summary', { style: { cursor: 'pointer', fontSize: '12px', fontWeight: 700, color: WA_D } }, '🔗 Native Flow & message (optional)'),
              h('div', { style: { fontSize: '11px', color: '#64748b', margin: '6px 0' } }, 'Leave Flow ID blank to send the form as a text prompt. Add a published Meta Flow ID to deliver a real in-chat form.'),
              h('div', { style: { marginBottom: '6px' } }, bodyTxtI),
              h('div', { style: { marginBottom: '6px' } }, flowIdI),
              h('div', { style: { display: 'flex', gap: '6px' } }, ctaI, screenI)),
            h('div', { style: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.4px', color: '#64748b', fontWeight: 700, margin: '8px 0 6px' } }, 'Fields'),
            fieldsWrap,
            btn('＋ Add field', function () { fields.push({ key: 'f' + Date.now(), label: '', type: 'text', required: false, options: ['Option 1', 'Option 2'] }); draw(); })),
          h('div', {}, h('div', { style: { fontSize: '11px', color: '#64748b', marginBottom: '6px' } }, 'Live preview'), preview));
        draw();
        modal(f.id ? 'Edit form' : 'New form', bodyEl, [
          ['💾 Save form', async function (close) {
            try { await api('api_wapack_form_save', { id: f.id || 0, name: nameI.value, description: descI.value, status: statusSel.value, fields: fields, flow_id: flowIdI.value, cta_text: ctaI.value, body_text: bodyTxtI.value, flow_screen: screenI.value }); toast('Saved'); close(); render(); }
            catch (e) { toast(e.message); }
          }, 'primary']
        ]);
      }

      async function responsesModal(f) {
        let resp = [];
        try { resp = (await api('api_wapack_form_responses', { form_id: f.id })).responses || []; } catch (e) { toast(e.message); }
        // Map raw flow field-keys (e.g. f1784…) back to the form's labels so
        // answers read "How many users?: 5" instead of "f1784…: 5".
        var flds = f.fields || f.fields_json || [];
        if (typeof flds === 'string') { try { flds = JSON.parse(flds); } catch (_) { flds = []; } }
        var labelMap = {};
        (flds || []).forEach(function (fl, i) {
          var key = String((fl.key || fl.label || ('field_' + i))).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || ('field_' + i);
          labelMap[key] = fl.label || fl.key || ('Field ' + (i + 1));
        });
        const rows = resp.map(function (r) {
          const ans = r.answers || {};
          return h('div', { style: { padding: '10px 0', borderBottom: '1px solid #ecfdf5', fontSize: '12.5px' } },
            h('b', {}, r.contact_name || r.phone || '—'), ' ', h('span', { style: { color: '#94a3b8', fontSize: '11px' } }, fmtTime(r.created_at)),
            h('div', { style: { color: '#475569', marginTop: '4px', lineHeight: '1.5' } },
              ...Object.keys(ans).filter(function (k) { return k !== 'flow_token' && !/^flow_/i.test(k); }).map(function (k) {
                return h('div', {}, h('span', { style: { color: '#0f766e', fontWeight: '600' } }, (labelMap[k] || k) + ': '), String(ans[k]));
              })));
        });
        modal('👁 Responses · ' + f.name, h('div', {}, resp.length ? h('div', {}, ...rows) : h('div', { style: { color: '#64748b', padding: '10px' } }, 'No responses yet.')), []);
      }

      async function renderWebviews(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let wvs;
        try { wvs = (await api('api_wapack_webviews_list')).webviews || []; }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        body.innerHTML = '';
        body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } },
          h('div', { style: { fontSize: '11.5px', color: '#64748b' } }, 'Let customers open web pages inside the chat. Rendering in-chat uses Meta Flows.'),
          btn('＋ New WebView', function () { wvModal(null); }, 'primary')));
        const g = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: '10px' } });
        wvs.forEach(function (w) {
          g.appendChild(h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '10px', padding: '12px' } },
            h('div', { style: { fontWeight: 700 } }, '🌐 ' + w.title),
            h('div', { style: { fontSize: '12px', color: WA_D, wordBreak: 'break-all' } }, w.url),
            w.description ? h('div', { style: { fontSize: '11.5px', color: '#64748b', margin: '4px 0' } }, w.description) : null,
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
              btn('📤 Send in chat', function () {
                var ph = h('input', { placeholder: 'WhatsApp number e.g. 9198…', style: inpS() });
                modal('📤 Send "' + w.title + '" in chat', h('div', {},
                  h('div', { style: { fontSize: '12.5px', color: '#475569', marginBottom: '10px' } }, 'Sends the page as a tappable link in the WhatsApp chat. Enter the customer\'s number:'),
                  ph), [['Send', async function (close) { try { var r = await api('api_wapack_webview_send', { id: w.id, phone: ph.value }); toast('Sent to ' + r.sent_to); close(); } catch (e) { toast(e.message); } }, 'primary']]);
              }, 'primary'),
              btn('✏️', function () { wvModal(w); }),
              btn('🗑', async function () { if (!confirm('Delete?')) return; try { await api('api_wapack_webview_delete', { id: w.id }); render(); } catch (e) { toast(e.message); } }))));
        });
        if (!wvs.length) body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } }, 'No webviews yet.')]));
        else body.appendChild(g);
      }
      function wvModal(w) {
        w = w || {};
        const t = h('input', { value: w.title || '', placeholder: 'Title', style: inpS() });
        const u = h('input', { value: w.url || '', placeholder: 'https://…', style: inpS() });
        const d = h('input', { value: w.description || '', placeholder: 'Description', style: inpS() });
        modal(w.id ? 'Edit WebView' : 'New WebView', h('div', {}, h('div', { style: { marginBottom: '8px' } }, t), h('div', { style: { marginBottom: '8px' } }, u), d), [
          ['💾 Save', async function (close) { try { await api('api_wapack_webview_save', { id: w.id || 0, title: t.value, url: u.value, description: d.value }); toast('Saved'); close(); render(); } catch (e) { toast(e.message); } }, 'primary']
        ]);
      }
      function inpS() { return { width: '100%', padding: '8px 10px', border: '1px solid #d1fae5', borderRadius: '7px', fontSize: '13px', boxSizing: 'border-box' }; }
      render();
    };

    // ════════════════════════════════════════════════════════════════
    //  STOREFRONT — Shopify / WooCommerce / FB catalog
    // ════════════════════════════════════════════════════════════════
    VIEWS.wapackshop = async function (view) {
      var SLUG = (location.pathname.match(/\/t\/([^\/]+)/) || [])[1] || '';
      var STORE_URL = location.origin + '/t/' + SLUG + '/store';
      var inpS = function () { return { width: '100%', padding: '9px 11px', border: '1px solid #d1fae5', borderRadius: '8px', boxSizing: 'border-box', fontSize: '14px' }; };
      var money = function (n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); };
      let tab = 'store';
      function render() {
        view.innerHTML = '';
        view.appendChild(topbar('WhatsApp / Storefront', '🛒 Storefront', [btn('🔄 Refresh', function () { render(); })]));
        const tabs = h('div', { style: { display: 'flex', gap: '6px', background: '#fff', padding: '6px', borderRadius: '10px', border: '1px solid #d1fae5', marginBottom: '14px', flexWrap: 'wrap' } });
        [['store', '🏪 My Store'], ['products', '📦 Products'], ['orders', '🧾 Orders']].forEach(function (t) {
          tabs.appendChild(h('button', { style: tabStyle(tab === t[0]), onclick: function () { tab = t[0]; render(); } }, t[1]));
        });
        view.appendChild(tabs);
        const body = h('div'); view.appendChild(body);
        (tab === 'store' ? renderStore : tab === 'products' ? renderProducts : renderOrders)(body);
      }

      /* ---------------- My Store ---------------- */
      async function renderStore(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let store = {}, count = 0;
        try { var d = await api('api_wapack_store_get'); store = d.store || {}; count = d.product_count || 0; } catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        body.innerHTML = '';
        var nameI = h('input', { value: store.store_name || '', placeholder: 'Store name', style: inpS() });
        var logoI = h('input', { value: store.logo_emoji || '🛍️', placeholder: '🛍️', style: Object.assign(inpS(), { width: '70px', textAlign: 'center', fontSize: '20px' }) });
        var tagI = h('input', { value: store.tagline || '', placeholder: 'Tagline (e.g. Fast delivery · COD available)', style: inpS() });
        var aboutI = h('textarea', { placeholder: 'About your store (optional)', style: Object.assign(inpS(), { height: '54px' }) }); aboutI.value = store.about || '';
        var codC = h('input', { type: 'checkbox' }); codC.checked = store.id ? Number(store.pay_cod) === 1 : true;
        var upiC = h('input', { type: 'checkbox' }); upiC.checked = Number(store.pay_upi) === 1;
        var upiI = h('input', { value: store.upi_id || '', placeholder: 'yourupi@bank', style: inpS() });
        var notifyI = h('input', { value: store.notify_phone || '', placeholder: 'WhatsApp number for order alerts', style: inpS() });
        var cPhoneI = h('input', { value: store.contact_phone || '', placeholder: 'Contact phone (shown to customers)', style: inpS() });
        var cEmailI = h('input', { value: store.contact_email || '', placeholder: 'Contact email (optional)', style: inpS() });
        var cAddrI = h('textarea', { placeholder: 'Shop address (optional)', style: Object.assign(inpS(), { height: '46px' }) }); cAddrI.value = store.address || '';
        var activeC = h('input', { type: 'checkbox' }); activeC.checked = store.id ? Number(store.active) === 1 : true;
        var invC = h('input', { type: 'checkbox' }); invC.checked = Number(store.inventory_on) === 1;
        var ck = function (c, label) { return h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13px', cursor: 'pointer' } }, c, label); };

        body.appendChild(card([
          h('div', { style: { fontWeight: 700, marginBottom: '10px' } }, '🏪 Store details'),
          h('div', { style: { display: 'flex', gap: '10px' } }, logoI, nameI),
          h('div', { style: { marginTop: '8px' } }, tagI),
          h('div', { style: { marginTop: '8px' } }, aboutI),
          h('div', { style: { fontWeight: 700, margin: '14px 0 6px', fontSize: '13px' } }, '💳 Payment'),
          h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } }, ck(codC, 'Cash on Delivery'), ck(upiC, 'UPI')),
          h('div', { style: { marginTop: '8px' } }, upiI),
          h('div', { style: { fontWeight: 700, margin: '14px 0 6px', fontSize: '13px' } }, '🔔 Order alerts'),
          notifyI,
          h('div', { style: { fontWeight: 700, margin: '14px 0 6px', fontSize: '13px' } }, '📇 Contact details (shown on your store)'),
          cPhoneI,
          h('div', { style: { marginTop: '8px' } }, cEmailI),
          h('div', { style: { marginTop: '8px' } }, cAddrI),
          h('div', { style: { marginTop: '12px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
            ck(activeC, 'Store is open'),
            ck(invC, '📦 Track inventory / stock (off = paused)'),
            btn('💾 Save store', async function () {
              try { await api('api_wapack_store_save', { store_name: nameI.value, tagline: tagI.value, logo_emoji: logoI.value, about: aboutI.value, pay_cod: codC.checked, pay_upi: upiC.checked, upi_id: upiI.value, notify_phone: notifyI.value, contact_phone: cPhoneI.value, contact_email: cEmailI.value, address: cAddrI.value, active: activeC.checked, inventory_on: invC.checked }); toast('Store saved'); render(); }
              catch (e) { toast(e.message); }
            }, 'primary'))
        ]));

        body.appendChild(card([
          h('div', { style: { fontWeight: 700, marginBottom: '6px' } }, '🔗 Your store link'),
          h('div', { style: { fontSize: '12px', color: '#64748b', marginBottom: '8px' } }, count + ' product(s) live. Share this link on WhatsApp / Instagram — customers browse and place orders, no app needed.'),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '9px', padding: '10px' } },
            h('span', { style: { flex: 1, minWidth: '180px', fontSize: '12.5px', color: WA_D, fontWeight: 700, wordBreak: 'break-all' } }, STORE_URL),
            btn('📋 Copy', function () { navigator.clipboard && navigator.clipboard.writeText(STORE_URL); toast('Link copied'); }, 'primary'),
            btn('↗ Open', function () { window.open(STORE_URL, '_blank'); }))
        ]));
      }

      /* ---------------- Products ---------------- */
      var invOn = false;   // INVENTORY_PAUSE_v1 — stock features hidden unless turned on in My Store
      var knownCats = [];  // STORE_CATEGORY_v1 — datalist of existing categories
      async function renderProducts(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let prods;
        try { prods = (await api('api_wapack_products_list')).products || []; }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        try { invOn = Number(((await api('api_wapack_store_get')).store || {}).inventory_on) === 1; } catch (_) { invOn = false; }
        knownCats = []; prods.forEach(function (p) { var c = (p.category || '').trim(); if (c && knownCats.indexOf(c) < 0) knownCats.push(c); }); knownCats.sort();
        body.innerHTML = '';
        body.appendChild(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' } },
          btn('➕ Add product', function () { productModal(null); }, 'primary'),
          btn('🔗 Add from URL', function () { fromUrlModal(); }),
          btn('📷 Scan image / menu', function () { scanModal(); })));
        if (!prods.length) { body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } }, 'No products yet. Add one manually, paste a product URL, or scan a menu photo.')])); return; }
        const g = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: '10px' } });
        prods.forEach(function (p) {
          var imgBox = p.image_url
            ? h('div', { style: { height: '120px', background: '#f1f5f9', overflow: 'hidden' } }, h('img', { src: p.image_url, style: { width: '100%', height: '100%', objectFit: 'cover' }, onerror: function () { this.style.display = 'none'; this.parentNode.innerHTML = '<div style="height:120px;display:flex;align-items:center;justify-content:center;font-size:34px;background:linear-gradient(135deg,#a7f3d0,#6ee7b7)">📦</div>'; } }))
            : h('div', { style: { height: '120px', background: 'linear-gradient(135deg,#a7f3d0,#6ee7b7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '34px' } }, '📦');
          g.appendChild(h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '12px', overflow: 'hidden', opacity: Number(p.active) === 0 ? '.55' : '1' } },
            imgBox,
            h('div', { style: { padding: '10px' } },
              h('div', { style: { fontWeight: 700, fontSize: '13px', lineHeight: '1.3' } }, p.name),
              p.category ? h('div', { style: { display: 'inline-block', fontSize: '10px', fontWeight: 700, color: '#166534', background: '#dcfce7', borderRadius: '6px', padding: '1px 7px', marginTop: '3px' } }, p.category) : null,
              p.description ? h('div', { style: { fontSize: '11px', color: '#64748b', marginTop: '3px', lineHeight: '1.4', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, p.description) : null,
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' } },
                h('b', { style: { color: WA_D, fontSize: '13px' } }, p.price_inr ? money(p.price_inr) : '—'),
                (invOn && p.stock_qty != null
                  ? (Number(p.stock_qty) > 0 ? pill(p.stock_qty + ' in stock', '#dcfce7', '#166534') : pill('Out of stock', '#fef2f2', '#dc2626'))
                  : (Number(p.in_stock) ? pill('Available', '#dcfce7', '#166534') : pill('Hidden', '#f1f5f9', '#475569')))),
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' } },
                btn('✏️ Edit', function () { productModal(p); }),
                (invOn ? btn('➕ Stock', function () {
                  var q = prompt('Add how many units to “' + p.name + '” stock? (current: ' + (p.stock_qty != null ? p.stock_qty : 'untracked') + ')');
                  if (q == null) return; var n = Number(q); if (!n) { toast('Enter a number'); return; }
                  api('api_wapack_product_restock', { id: p.id, add: n }).then(function (r) { toast('Stock now ' + r.stock_qty); render(); }).catch(function (e) { toast(e.message); });
                }) : null),
                btn('🗑', async function () { if (!confirm('Delete ' + p.name + '?')) return; try { await api('api_wapack_product_delete', { id: p.id }); render(); } catch (e) { toast(e.message); } })))));
        });
        body.appendChild(g);
      }

      function productModal(p) {
        p = p || {};
        var imgI = h('input', { value: p.image_url || '', placeholder: 'Image URL (optional)', style: inpS() });
        var nameI = h('input', { value: p.name || '', placeholder: 'Product name', style: inpS() });
        var priceI = h('input', { value: p.price_inr != null ? p.price_inr : '', placeholder: 'Price ₹', inputmode: 'numeric', style: inpS() });
        var stockI = h('input', { value: p.stock_qty != null ? p.stock_qty : '', placeholder: 'Stock qty (optional)', inputmode: 'numeric', style: inpS() });
        var catI = h('input', { value: p.category || '', placeholder: 'Category (e.g. Chargers)', list: 'wapack-catlist', style: inpS() });
        var catList = h('datalist', { id: 'wapack-catlist' }); knownCats.forEach(function (c) { catList.appendChild(h('option', { value: c })); });
        var descI = h('textarea', { placeholder: 'Description (optional)', style: Object.assign(inpS(), { height: '50px' }) }); descI.value = p.description || '';
        var inStockC = h('input', { type: 'checkbox' }); inStockC.checked = p.id ? Number(p.in_stock) === 1 : true;
        var prev = h('div');
        function drawPrev() {
          prev.innerHTML = '';
          prev.appendChild(h('div', { style: { border: '1px solid #d1fae5', borderRadius: '10px', overflow: 'hidden', width: '150px' } },
            imgI.value ? h('img', { src: imgI.value, style: { width: '100%', height: '96px', objectFit: 'cover' }, onerror: function () { this.style.display = 'none'; } }) : h('div', { style: { height: '96px', background: 'linear-gradient(135deg,#a7f3d0,#6ee7b7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '30px' } }, '📦'),
            h('div', { style: { padding: '9px' } }, h('div', { style: { fontWeight: 700, fontSize: '12.5px' } }, nameI.value || 'Product name'), h('b', { style: { color: WA_D } }, priceI.value ? money(priceI.value) : '—'))));
        }
        imgI.oninput = drawPrev; nameI.oninput = drawPrev; priceI.oninput = drawPrev; drawPrev();
        modal(p.id ? 'Edit product' : 'Add product', h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 160px', gap: '14px' } },
          h('div', {}, h('div', { style: { marginBottom: '8px' } }, nameI),
            h('div', { style: { display: 'flex', gap: '8px', marginBottom: '8px' } }, priceI, (invOn ? stockI : null)),
            h('div', { style: { marginBottom: '8px' } }, catI, catList),
            h('div', { style: { marginBottom: '8px' } }, imgI), h('div', { style: { marginBottom: '8px' } }, descI),
            h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '13px' } }, inStockC, 'Available in store')),
          h('div', {}, h('div', { style: { fontSize: '11px', color: '#94a3b8', marginBottom: '6px' } }, 'Preview'), prev)),
          [['💾 Save', async function (close) {
            if (!nameI.value.trim()) { toast('Enter a product name'); return; }
            try { await api('api_wapack_product_save', { id: p.id || 0, name: nameI.value, price_inr: priceI.value, image_url: imgI.value, stock_qty: stockI.value, description: descI.value, category: catI.value, in_stock: inStockC.checked }); toast('Saved'); close(); render(); }
            catch (e) { toast(e.message); }
          }, 'primary']]);
      }

      function fromUrlModal() {
        var urlI = h('input', { placeholder: 'Paste a product OR collection link (https://…)', style: inpS() });
        var busy = h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '8px' } }, '');
        modal('🔗 Add from URL', h('div', {},
          h('div', { style: { fontSize: '12.5px', color: '#475569', marginBottom: '10px' } }, 'Paste a link — a single product, or a whole collection/category (we’ll import all of them). Works great for Shopify stores. You can edit before saving.'),
          urlI, busy), [['Fetch', async function (close) {
            if (!urlI.value.trim()) { toast('Enter a URL'); return; }
            busy.textContent = '🔍 Reading the page…';
            try {
              var r = await api('api_wapack_product_from_url', { url: urlI.value.trim() });
              close();
              if (r.drafts && r.drafts.length) { reviewDraftsModal(r.drafts, r.drafts.length + ' products found'); }
              else { productModal(r.draft || {}); }
            } catch (e) { busy.textContent = ''; toast(e.message); }
          }, 'primary']]);
      }

      // Reusable review list for a batch of draft products (from a collection
      // URL or a scanned photo): edit name/price, untick unwanted, then add all.
      function reviewDraftsModal(drafts, subtitle) {
        var wrap = h('div');
        var catAll = h('input', { placeholder: 'Category for all these (optional, e.g. Chargers)', list: 'wapack-catlist', style: Object.assign(inpS(), { marginBottom: '10px' }) });
        var catAllList = h('datalist', { id: 'wapack-catlist' }); knownCats.forEach(function (c) { catAllList.appendChild(h('option', { value: c })); });
        function draw() {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
            h('div', { style: { fontSize: '12.5px', color: '#475569' } }, (subtitle || 'Review') + ' — edit, untick any you don’t want:'),
            h('label', { style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } },
              (function () { var a = h('input', { type: 'checkbox' }); a.checked = true; a.onchange = function () { drafts.forEach(function (d) { d._on = a.checked; }); draw(); }; return a; })(), 'All')));
          drafts.forEach(function (d, i) {
            if (d._on === undefined) d._on = true;
            var chk = h('input', { type: 'checkbox' }); chk.checked = d._on; chk.onchange = function () { drafts[i]._on = chk.checked; };
            var thumb = d.image_url
              ? h('img', { src: d.image_url, style: { width: '34px', height: '34px', objectFit: 'cover', borderRadius: '6px', flex: '0 0 34px' }, onerror: function () { this.style.visibility = 'hidden'; } })
              : h('div', { style: { width: '34px', height: '34px', borderRadius: '6px', background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 34px' } }, '📦');
            var nm = h('input', { value: d.name, style: Object.assign(inpS(), { flex: '1', fontSize: '13px', padding: '7px 9px' }) }); nm.oninput = function () { drafts[i].name = nm.value; };
            var pr = h('input', { value: d.price_inr != null ? d.price_inr : '', placeholder: '₹', inputmode: 'numeric', style: Object.assign(inpS(), { width: '72px', fontSize: '13px', padding: '7px 9px' }) }); pr.oninput = function () { drafts[i].price_inr = pr.value; };
            var st = h('input', { value: d.stock_qty != null ? d.stock_qty : '', placeholder: 'Qty', inputmode: 'numeric', title: 'Stock quantity', style: Object.assign(inpS(), { width: '58px', fontSize: '13px', padding: '7px 9px' }) }); st.oninput = function () { drafts[i].stock_qty = st.value; };
            wrap.appendChild(h('div', { style: { display: 'flex', gap: '7px', alignItems: 'center', marginBottom: '6px' } }, chk, thumb, nm, pr, (invOn ? st : null)));
          });
        }
        draw();
        modal('🛒 ' + (subtitle || 'Review products'), h('div', { style: { maxHeight: '60vh', overflow: 'auto' } }, catAll, catAllList, wrap), [['✅ Add selected', async function (close) {
          var chosen = drafts.filter(function (d) { return d._on !== false && String(d.name || '').trim(); });
          if (!chosen.length) { toast('Nothing selected'); return; }
          try { var r = await api('api_wapack_products_bulk_add', { products: chosen, source: 'url', category: catAll.value.trim() || null }); toast('Added ' + r.added + ' products'); close(); render(); }
          catch (e) { toast(e.message); }
        }, 'primary']]);
      }

      function scanModal() {
        var fileI = h('input', { type: 'file', accept: 'image/*', style: { fontSize: '13px' } });
        var status = h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '10px' } }, '');
        var listWrap = h('div', { style: { marginTop: '10px' } });
        var drafts = [];
        function drawList() {
          listWrap.innerHTML = '';
          if (!drafts.length) return;
          listWrap.appendChild(h('div', { style: { fontWeight: 700, fontSize: '13px', margin: '4px 0 6px' } }, 'Found ' + drafts.length + ' item(s) — edit, then add:'));
          drafts.forEach(function (d, i) {
            var nm = h('input', { value: d.name, style: Object.assign(inpS(), { flex: '1' }) });
            var pr = h('input', { value: d.price_inr != null ? d.price_inr : '', placeholder: '₹', inputmode: 'numeric', style: Object.assign(inpS(), { width: '80px' }) });
            nm.oninput = function () { drafts[i].name = nm.value; }; pr.oninput = function () { drafts[i].price_inr = pr.value; };
            listWrap.appendChild(h('div', { style: { display: 'flex', gap: '6px', marginBottom: '6px' } }, nm, pr,
              btn('✕', function () { drafts.splice(i, 1); drawList(); })));
          });
          listWrap.appendChild(btn('✅ Add ' + drafts.length + ' product(s)', async function () {
            try { var r = await api('api_wapack_products_bulk_add', { products: drafts.filter(function (d) { return d.name; }) }); toast('Added ' + r.added + ' products'); closeScan(); render(); }
            catch (e) { toast(e.message); }
          }, 'primary'));
        }
        var closeScan = function () {};
        fileI.onchange = function () {
          var f = fileI.files && fileI.files[0]; if (!f) return;
          status.textContent = 'Reading image…';
          var rd = new FileReader();
          rd.onload = async function () {
            status.textContent = '🔍 Scanning for products…';
            try { var r = await api('api_wapack_product_scan', { image_base64: rd.result, mime_type: f.type || 'image/jpeg' }); drafts = r.drafts || []; status.textContent = drafts.length ? '' : 'No items detected — try a clearer photo.'; drawList(); }
            catch (e) { status.textContent = ''; toast(e.message); }
          };
          rd.readAsDataURL(f);
        };
        var m = modal('📷 Scan image / menu', h('div', {},
          h('div', { style: { fontSize: '12.5px', color: '#475569', marginBottom: '10px' } }, 'Upload a photo of your menu or product list. On mobile you can take a photo directly. We read the items and prices for you to review.'),
          fileI, status, listWrap), []);
        closeScan = (m && m.close) ? m.close : function () {};
      }

      /* ---------------- Orders ---------------- */
      async function renderOrders(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let orders;
        try { orders = (await api('api_wapack_orders_list')).orders || []; }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        body.innerHTML = '';
        if (!orders.length) { body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } }, 'No orders yet. Share your store link to start receiving orders.')])); return; }
        orders.forEach(function (o) {
          var statusColors = { placed: ['#fef3c7', '#92400e'], packed: ['#dbeafe', '#1e40af'], shipped: ['#e0e7ff', '#4338ca'], delivered: ['#dcfce7', '#166534'], returned: ['#fef9c3', '#854d0e'], cancelled: ['#fef2f2', '#dc2626'] };
          var sc = statusColors[o.status] || ['#f1f5f9', '#475569'];
          var statusSel = sel([['placed', 'Placed'], ['packed', 'Packed'], ['shipped', 'Shipped'], ['delivered', 'Delivered'], ['returned', 'Returned (restock)'], ['cancelled', 'Cancelled (restock)']], o.status);
          statusSel.onchange = async function () {
            try { var r = await api('api_wapack_order_setStatus', { id: o.id, status: statusSel.value }); toast(r && r.stock_restored ? 'Updated · stock added back' : 'Updated'); render(); }
            catch (e) { toast(e.message); }
          };
          var courierLine = (o.courier_name || o.tracking_number)
            ? h('div', { style: { fontSize: '12px', color: '#475569', marginTop: '4px' } }, '🚚 ' + (o.courier_name || '') + (o.tracking_number ? (' · ' + o.tracking_number) : '') + (o.tracking_url ? '' : ''))
            : null;
          body.appendChild(h('div', { style: { background: '#fff', border: '1px solid #d1fae5', borderRadius: '12px', padding: '12px 14px', marginBottom: '8px' } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' } },
              h('b', {}, o.order_ref || ('#' + o.id)), pill(o.status, sc[0], sc[1])),
            h('div', { style: { fontSize: '12.5px', color: '#64748b', margin: '2px 0 8px' } }, (o.customer_name || '') + ' · 📞 ' + (o.phone || '') + ' · ' + (o.payment_mode || '')),
            h('div', { style: { fontSize: '12.5px' } }, (o.items || []).map(function (it) { return it.name + ' × ' + it.qty; }).join(', ')),
            o.address ? h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '4px' } }, '📍 ' + o.address) : null,
            courierLine,
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px', gap: '6px', flexWrap: 'wrap' } },
              h('b', { style: { color: WA_D } }, money(o.total_inr)),
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                btn('🚚 Courier', function () { courierModal(o); }),
                statusSel))));
        });
      }
      function courierModal(o) {
        var cn = h('input', { value: o.courier_name || '', placeholder: 'Courier (e.g. Delhivery, DTDC)', style: inpS() });
        var tn = h('input', { value: o.tracking_number || '', placeholder: 'Tracking number', style: inpS() });
        var tu = h('input', { value: o.tracking_url || '', placeholder: 'Tracking link (optional)', style: inpS() });
        modal('🚚 Courier · ' + (o.order_ref || ('#' + o.id)), h('div', {},
          h('div', { style: { marginBottom: '8px' } }, cn), h('div', { style: { marginBottom: '8px' } }, tn), h('div', {}, tu)),
          [['💾 Save', async function (close) { try { await api('api_wapack_order_setCourier', { id: o.id, courier_name: cn.value, tracking_number: tn.value, tracking_url: tu.value }); toast('Courier saved'); close(); render(); } catch (e) { toast(e.message); } }, 'primary']]);
      }

      render();
    };
  });
})();
