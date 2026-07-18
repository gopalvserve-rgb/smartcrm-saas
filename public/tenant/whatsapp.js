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
  });
})();
