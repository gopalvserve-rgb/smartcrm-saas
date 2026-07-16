/* ============================================================================
 * WORKSPACE_HUB_v1 (2026-07-15)
 * ============================================================================
 * The Workspace page — picker + 7 tabs. Implements WORKSPACE_HUB_v1_MOCKUP.html.
 *
 * WHY ITS OWN FILE (not app.js):
 *   app.js is 58,000 lines. Twice this week a whole-file upload from a stale local
 *   checkout silently reverted other people's work (LEADS_CARD_SELECT_v1,
 *   WA_TEMPLATE_VIEW_v1, TKT_AUTOCLOSE_v1 …). A separate module is small enough to
 *   diff at a glance and cannot take the SPA down with it. Same reasoning as the
 *   pack-isolation standard and wbChatV2.js.
 *
 * WHY IT REUSES EXISTING ENDPOINTS RATHER THAN NEW ONES:
 *   Everything here already had a backend — api_campaigns_list (with computed
 *   per-workspace KPIs), reportAdvanced (kpis/funnel/status_rows/user_rows),
 *   uploadLeads (preview + duplicate policy), resetUnclosed (re-churn),
 *   campaign_agents. The gap was never the data; VIEWS.campaigns just rendered the
 *   Settings CRUD table. Writing a second set of report queries here would drift
 *   from Reports — that exact mistake put 108 recordings on the wrong customer this
 *   week. One source of truth.
 *
 * OBSERVED CONTRACTS (probed live on tenant `mahajan`, do NOT assume):
 *   api_campaigns_list()            -> BARE ARRAY [{ id, name, distribution_mode,
 *                                        is_active, agent_count, lead_count,
 *                                        leads_unassigned, leads_assigned,
 *                                        leads_final, leads_hidden, leads_duplicate,
 *                                        leads_pullable, manager_name, ... }]
 *   api_campaigns_reportAdvanced({campaign_ids, user_ids, from, to})
 *                                   -> { ok, range, filters, kpis, funnel,
 *                                        status_rows, user_rows, product_rows,
 *                                        source_rows, campaign_rows, daily }
 *     kpis        = { total, unassigned, assigned, contacted, final, won, lost,
 *                     duplicates, conv_pct, avg_tat_secs }
 *     funnel[]    = { stage, cnt, pct_from_top }
 *     status_rows = { status_name, status_id, cnt }        <- NOT {name,count}
 *     user_rows   = { user_name, assigned_to, total, final_cnt, won_cnt }
 *     campaign_rows = { campaign_name, campaign_id, total, won_cnt }
 *   api_campaigns_resetUnclosed({campaign_id, apply, status_ids, idle_days,
 *                                user_id, skip_future_followups})
 *                                   -> { would_reset, sample[] } | { reset_count }
 * ========================================================================== */
(function () {
  'use strict';

  /* ---- token: SPA scoped-token pattern. crm_token_<slug> first, then legacy.
   * Bit us on WA Catalogue + DEVICE_DIAG + COPILOT_v4 — do not "simplify" this. */
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

  async function api(fn, ...args) {
    /* Prefer the SPA's own helper when present — it already carries whatever auth the
     * session uses (super-admin "Login as" uses a cookie, not a JWT in localStorage). */
    if (typeof window.api === 'function') return window.api(fn, ...args);
    const res = await fetch(apiBase(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: [token()].concat(args) })
    });
    const j = await res.json();
    if (j && j.error) throw new Error(j.error);
    return j && j.result !== undefined ? j.result : j;
  }

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      if (k === 'style') n.style.cssText = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (html !== undefined && html !== null) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(m, t) {
    if (typeof window.toast === 'function') { try { return window.toast(m, t); } catch (_) {} }
    try { console.log('[workspace]', m); } catch (_) {}
  }
  function num(v) { return Number(v) || 0; }
  function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }
  function initials(s) {
    const p = String(s || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
  }
  const AV = ['#6366f1', '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#14b8a6'];

  /* ---- state ---- */
  const S = {
    ws: [], wsId: null, tab: 'overview',
    range: 'month', from: null, to: null,
    rep: null, loading: false,
    upload: { rows: null, file: null, dupPolicy: 'skip', preview: null },
    rechurn: { mode: 'idle7', dry: null }
  };

  function dateRange() {
    const now = new Date();
    const iso = d => d.toISOString().slice(0, 10);
    const dayAgo = n => iso(new Date(Date.now() - n * 86400000));
    switch (S.range) {
      case 'today':     return { from: iso(now), to: iso(now) };
      case 'yesterday': return { from: dayAgo(1), to: dayAgo(1) };
      case 'd7':        return { from: dayAgo(7), to: iso(now) };
      case 'month':     return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: iso(now) };
      case 'all':       return { from: '2020-01-01', to: iso(now) };
      case 'custom':    return { from: S.from || dayAgo(30), to: S.to || iso(now) };
      default:          return { from: dayAgo(30), to: iso(now) };
    }
  }

  function css() {
    if (document.getElementById('wsh-css')) return;
    const st = document.createElement('style');
    st.id = 'wsh-css';
    st.textContent = `
.wsh{--b:#6366f1;--ac:#10b981;--mut:#64748b;--ln:#e2e8f0;--wn:#f59e0b;--dg:#ef4444}
.wsh-top{display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.wsh-top h2{font-size:17px;font-weight:800;display:flex;align-items:center;gap:7px;margin:0}
.wsh-sp{flex:1}
.wsh-btn{border:1px solid var(--ln);background:#fff;padding:6px 12px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;color:#334155}
.wsh-btn:hover{background:#f8fafc}
.wsh-btn.p{background:var(--b);border-color:var(--b);color:#fff}
.wsh-btn.g{background:var(--ac);border-color:var(--ac);color:#fff}
.wsh-btn.w{background:#fff7ed;border-color:#fed7aa;color:#9a3412}
.wsh-btn:disabled{opacity:.5;cursor:not-allowed}
.wsh-pick{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid var(--ln);border-radius:11px;padding:10px 12px;margin-bottom:14px;flex-wrap:wrap}
.wsh-sel{border:1px solid var(--ln);border-radius:8px;padding:7px 10px;font-size:13px;font-weight:700;background:#fff;min-width:230px;max-width:100%}
.wsh-chip{border:1px solid var(--ln);border-radius:20px;padding:4px 11px;font-size:12px;background:#fff;cursor:pointer;color:#475569}
.wsh-chip.on{background:#eef2ff;border-color:#c7d2fe;color:#3730a3;font-weight:700}
.wsh-tabs{display:flex;gap:2px;border-bottom:2px solid var(--ln);margin-bottom:14px;overflow-x:auto}
.wsh-tab{padding:8px 15px;font-size:13px;font-weight:700;color:var(--mut);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;white-space:nowrap}
.wsh-tab.on{color:var(--b);border-bottom-color:var(--b)}
.wsh-kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin-bottom:14px}
@media(max-width:1100px){.wsh-kpis{grid-template-columns:repeat(3,1fr)}}
@media(max-width:640px){.wsh-kpis{grid-template-columns:repeat(2,1fr)}.wsh-row2{grid-template-columns:1fr!important}}
.wsh-kpi{background:#fff;border:1px solid var(--ln);border-radius:11px;padding:11px 12px}
.wsh-kpi.hi{background:linear-gradient(135deg,#eef2ff,#fff);border-color:#c7d2fe}
.wsh-kpi .l{font-size:10.5px;color:var(--mut);font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.wsh-kpi .v{font-size:21px;font-weight:800;margin-top:3px}
.wsh-kpi .d{font-size:10.5px;margin-top:2px;font-weight:600;color:var(--mut)}
.wsh-row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.wsh-card{background:#fff;border:1px solid var(--ln);border-radius:11px;overflow:hidden;margin-bottom:12px}
.wsh-card h3{font-size:12.5px;font-weight:800;padding:10px 13px;border-bottom:1px solid var(--ln);display:flex;align-items:center;gap:6px;margin:0}
.wsh-card h3 .sub{font-weight:500;color:var(--mut);font-size:11px;margin-left:auto}
.wsh-card table{width:100%;border-collapse:collapse;font-size:12.5px}
.wsh-card th{text-align:left;padding:7px 13px;background:#f8fafc;color:var(--mut);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;font-weight:700;border-bottom:1px solid var(--ln)}
.wsh-card td{padding:7px 13px;border-bottom:1px solid #f1f5f9}
.wsh-card tr:last-child td{border-bottom:0}
.wsh-clk{cursor:pointer}
.wsh-clk:hover{background:#f8fafc}
.wsh-who{display:flex;align-items:center;gap:7px}
.wsh-av{width:23px;height:23px;border-radius:50%;color:#fff;display:grid;place-items:center;font-size:10px;font-weight:800;flex:0 0 23px}
.wsh-bar{height:5px;border-radius:3px;background:#eef2f6;overflow:hidden;margin-top:3px}
.wsh-bar i{display:block;height:100%;background:var(--b)}
.wsh-pill{padding:2px 8px;border-radius:20px;font-size:10.5px;font-weight:700;display:inline-block;background:#f1f5f9;color:#475569}
.wsh-fn{padding:11px 13px}
.wsh-st{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.wsh-nm{width:112px;font-size:12px;font-weight:600;flex:0 0 112px}
.wsh-tr{flex:1;height:22px;background:#f1f5f9;border-radius:5px;overflow:hidden}
.wsh-fl{height:100%;background:linear-gradient(90deg,var(--b),#818cf8);display:flex;align-items:center;padding-left:8px;color:#fff;font-size:11px;font-weight:800}
.wsh-pc{width:44px;text-align:right;font-size:11.5px;color:var(--mut);font-weight:700}
.wsh-drop{border:2px dashed #c7d2fe;border-radius:11px;padding:26px;text-align:center;background:#f8faff;margin:12px 13px}
.wsh-drop.over{background:#eef2ff;border-color:var(--b)}
.wsh-drop .ic{font-size:30px}
.wsh-drop h4{font-size:14px;margin:7px 0 3px}
.wsh-drop p{font-size:12px;color:var(--mut);margin:0}
.wsh-warn{margin:12px 13px;padding:11px 13px;background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;font-size:12.5px;color:#9a3412}
.wsh-ok{margin:12px 13px;padding:11px 13px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:9px;font-size:12.5px;color:#065f46}
.wsh-mini{font-size:11px;color:var(--mut);padding:0 13px 12px}
.wsh-empty{padding:26px;text-align:center;color:var(--mut);font-size:13px}
.wsh-kv{display:flex;gap:7px;font-size:12.5px;padding:4px 0}
.wsh-kv b{min-width:150px}
.wsh-tag{background:#eef2ff;color:#3730a3;border-radius:5px;padding:1px 6px;font-size:10.5px;font-weight:700;font-family:ui-monospace,monospace}
.wsh-spin{padding:30px;text-align:center;color:var(--mut);font-size:13px}
`;
    document.head.appendChild(st);
  }

  /* ================= tabs ================= */
  const TABS = [
    ['overview', '📊 Overview'],
    ['user',     '👤 By user'],
    ['status',   '🎯 By status'],
    ['upload',   '⬆ Upload data'],
    ['rechurn',  '♻ Re-churn'],
    ['agents',   '👥 Agents'],
    ['settings', '⚙️ Settings']
  ];

  function currentWs() { return S.ws.find(w => Number(w.id) === Number(S.wsId)) || null; }

  /* ================= main render ================= */
  async function render(view) {
    css();
    view.innerHTML = '';
    const root = el('div', { class: 'wsh' });
    view.appendChild(root);

    // header
    const top = el('div', { class: 'wsh-top' });
    top.appendChild(el('h2', {}, '📁 Workspace'));
    top.appendChild(el('div', { class: 'wsh-sp' }));
    const bNew = el('button', { class: 'wsh-btn' }, '＋ New workspace');
    bNew.onclick = () => { S.tab = 'settings'; paint(); toast('Create it from the Settings tab below', 'ok'); };
    top.appendChild(bNew);
    const bUp = el('button', { class: 'wsh-btn g' }, '⬆ Upload data');
    bUp.onclick = () => { S.tab = 'upload'; paint(); };
    top.appendChild(bUp);
    const bRc = el('button', { class: 'wsh-btn w' }, '♻ Re-churn');
    bRc.onclick = () => { S.tab = 'rechurn'; paint(); };
    top.appendChild(bRc);
    root.appendChild(top);

    root.appendChild(el('div', { id: 'wsh-pick' }));
    root.appendChild(el('div', { id: 'wsh-tabs' }));
    root.appendChild(el('div', { id: 'wsh-body' }));

    // load workspaces
    try {
      const list = await api('api_campaigns_list', {});
      S.ws = Array.isArray(list) ? list : (list.rows || list.campaigns || []);
    } catch (e) {
      root.appendChild(el('div', { class: 'wsh-card' },
        '<div class="wsh-empty">Could not load workspaces: ' + esc(e.message) + '</div>'));
      return;
    }
    if (!S.ws.length) {
      document.getElementById('wsh-body').appendChild(el('div', { class: 'wsh-card' },
        '<div class="wsh-empty">No workspaces yet.<br><br>' +
        'A workspace groups leads so you can report on them, upload into them, and re-churn them.<br>' +
        'Create your first one from <b>Settings</b>.</div>'));
      paintTabs();
      return;
    }
    if (!S.wsId || !S.ws.some(w => Number(w.id) === Number(S.wsId))) S.wsId = S.ws[0].id;
    paint();
  }

  function paintPicker() {
    const host = document.getElementById('wsh-pick');
    if (!host) return;
    host.innerHTML = '';
    const box = el('div', { class: 'wsh-pick' });
    box.appendChild(el('span', { style: 'font-weight:700;font-size:12.5px' }, 'Workspace'));

    const sel = el('select', { class: 'wsh-sel' });
    S.ws.forEach(w => {
      const o = el('option', { value: String(w.id) },
        '📁 ' + esc(w.name) + ' (' + num(w.lead_count) + ' leads)' + (num(w.is_active) ? '' : ' — paused'));
      if (Number(w.id) === Number(S.wsId)) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = () => { S.wsId = Number(sel.value); S.rep = null; S.rechurn.dry = null; paint(); };
    box.appendChild(sel);

    box.appendChild(el('span', { style: 'width:1px;height:22px;background:#e2e8f0' }));
    [['today', 'Today'], ['yesterday', 'Yesterday'], ['d7', 'Last 7 days'], ['month', 'This month'], ['all', 'All time']]
      .forEach(([k, lbl]) => {
        const c = el('span', { class: 'wsh-chip' + (S.range === k ? ' on' : '') }, lbl);
        c.onclick = () => { S.range = k; S.rep = null; paint(); };
        box.appendChild(c);
      });

    box.appendChild(el('div', { class: 'wsh-sp' }));
    const w = currentWs();
    if (w) {
      box.appendChild(el('span', { style: 'font-size:11.5px;color:#64748b' },
        'Distribution: <b style="color:#0f172a">' + esc(String(w.distribution_mode || '—').replace(/_/g, ' ')) +
        '</b> · ' + num(w.agent_count) + ' agent' + (num(w.agent_count) === 1 ? '' : 's')));
    }
    host.appendChild(box);
  }

  function paintTabs() {
    const host = document.getElementById('wsh-tabs');
    if (!host) return;
    host.innerHTML = '';
    const bar = el('div', { class: 'wsh-tabs' });
    TABS.forEach(([k, lbl]) => {
      const t = el('div', { class: 'wsh-tab' + (S.tab === k ? ' on' : '') }, lbl);
      t.onclick = () => { S.tab = k; paint(); };
      bar.appendChild(t);
    });
    host.appendChild(bar);
  }

  function paint() {
    paintPicker();
    paintTabs();
    const body = document.getElementById('wsh-body');
    if (!body) return;
    body.innerHTML = '<div class="wsh-spin">Loading…</div>';
    const fn = { overview: tabOverview, user: tabUser, status: tabStatus, upload: tabUpload,
                 rechurn: tabRechurn, agents: tabAgents, settings: tabSettings }[S.tab] || tabOverview;
    Promise.resolve(fn(body)).catch(e => {
      body.innerHTML = '<div class="wsh-card"><div class="wsh-empty">Error: ' + esc(e.message) + '</div></div>';
    });
  }

  /* ---- shared: fetch the report for the selected workspace ---- */
  async function report() {
    const dr = dateRange();
    if (S.rep && S.rep._k === S.wsId + '|' + dr.from + '|' + dr.to) return S.rep;
    const r = await api('api_campaigns_reportAdvanced', {
      campaign_ids: [Number(S.wsId)], from: dr.from, to: dr.to
    });
    r._k = S.wsId + '|' + dr.from + '|' + dr.to;
    S.rep = r;
    return r;
  }

  function kpiCard(label, val, sub, cls) {
    return '<div class="wsh-kpi' + (cls || '') + '"><div class="l">' + label + '</div>' +
           '<div class="v">' + val + '</div><div class="d">' + (sub || '&nbsp;') + '</div></div>';
  }

  /* ================= OVERVIEW ================= */
  async function tabOverview(body) {
    const r = await report();
    const w = currentWs() || {};
    const k = r.kpis || {};
    const total = num(k.total);
    // "Re-churnable" = not in a final status. leads_pullable comes from the list API.
    const churnable = Math.max(0, total - num(k.final));

    body.innerHTML =
      '<div class="wsh-kpis">' +
        kpiCard('Total leads', total, num(w.lead_count) ? ('all-time: ' + num(w.lead_count)) : '&nbsp;', ' hi') +
        kpiCard('Unassigned', num(k.unassigned), num(k.unassigned) ? 'needs pull' : 'all assigned') +
        kpiCard('Assigned', num(k.assigned), pct(num(k.assigned), total) + '%') +
        kpiCard('Won', num(k.won), num(k.conv_pct) + '% conv') +
        kpiCard('Lost / Junk', num(k.lost), pct(num(k.lost), total) + '%') +
        kpiCard('Re-churnable', churnable, 'not final') +
      '</div>';

    // funnel
    const fn = (r.funnel || []);
    if (fn.length) {
      const c = el('div', { class: 'wsh-card' });
      c.appendChild(el('h3', {}, '🔻 Funnel <span class="sub"><span class="wsh-tag">reportAdvanced → funnel</span></span>'));
      const box = el('div', { class: 'wsh-fn' });
      fn.forEach((f, i) => {
        const p = num(f.pct_from_top);
        const last = i === fn.length - 1;
        box.appendChild(el('div', { class: 'wsh-st' },
          '<div class="wsh-nm">' + esc(f.stage) + '</div>' +
          '<div class="wsh-tr"><div class="wsh-fl" style="width:' + Math.max(p, 2) + '%' +
            (last ? ';background:linear-gradient(90deg,#059669,#34d399)' : '') + '">' + num(f.cnt) + '</div></div>' +
          '<div class="wsh-pc">' + p + '%</div>'));
      });
      c.appendChild(box);
      body.appendChild(c);
    }

    // quick split
    const g = el('div', { class: 'wsh-row2' });
    g.appendChild(miniTable('🎯 Status-wise', 'reportAdvanced → status_rows',
      (r.status_rows || []).slice(0, 6).map(s => [esc(s.status_name || '—'), num(s.cnt), pct(num(s.cnt), total)]), total,
      (row, i) => { const s = (r.status_rows || [])[i]; if (s) openLeads({ status_id: s.status_id }); }));
    g.appendChild(miniTable('🔗 Source-wise', 'reportAdvanced → source_rows',
      (r.source_rows || []).slice(0, 6).map(s => [esc(s.source || '—'), num(s.cnt), pct(num(s.cnt), total)]), total, null));
    body.appendChild(g);
  }

  function miniTable(title, tag, rows, total, onRow) {
    const c = el('div', { class: 'wsh-card' });
    c.appendChild(el('h3', {}, title + ' <span class="sub"><span class="wsh-tag">' + tag + '</span></span>'));
    if (!rows.length) { c.appendChild(el('div', { class: 'wsh-empty' }, 'No data in this range.')); return c; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Name</th><th>Leads</th><th>Share</th><th></th></tr></thead>';
    const tb = el('tbody');
    rows.forEach((r, i) => {
      const tr = el('tr', onRow ? { class: 'wsh-clk' } : {});
      tr.innerHTML = '<td>' + r[0] + '</td><td><b>' + r[1] + '</b></td><td>' + r[2] + '%</td>' +
                     '<td style="width:90px"><div class="wsh-bar"><i style="width:' + Math.min(r[2], 100) + '%"></i></div></td>';
      if (onRow) tr.onclick = () => onRow(r, i);
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    c.appendChild(t);
    return c;
  }

  /* ================= BY USER ================= */
  async function tabUser(body) {
    const r = await report();
    const rows = r.user_rows || [];
    body.innerHTML = '';
    const c = el('div', { class: 'wsh-card' });
    c.appendChild(el('h3', {}, '👤 User-wise <span class="sub"><span class="wsh-tag">reportAdvanced → user_rows</span></span>'));
    if (!rows.length) {
      c.appendChild(el('div', { class: 'wsh-empty' },
        'No leads assigned in this range.<br><span style="font-size:11.5px">Try a wider date range, or check the Agents tab.</span>'));
      body.appendChild(c);
      return;
    }
    const max = Math.max.apply(null, rows.map(x => num(x.total)).concat([1]));
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Agent</th><th>Leads</th><th>Final</th><th>Won</th><th>Conv</th></tr></thead>';
    const tb = el('tbody');
    rows.forEach((u, i) => {
      const tot = num(u.total), won = num(u.won_cnt);
      const tr = el('tr', { class: 'wsh-clk' });
      tr.innerHTML =
        '<td><div class="wsh-who"><div class="wsh-av" style="background:' + AV[i % AV.length] + '">' +
          esc(initials(u.user_name)) + '</div>' + esc(u.user_name || 'Unassigned') + '</div></td>' +
        '<td><b>' + tot + '</b><div class="wsh-bar"><i style="width:' + Math.round(tot / max * 100) + '%"></i></div></td>' +
        '<td>' + num(u.final_cnt) + '</td>' +
        '<td>' + won + '</td>' +
        '<td><b>' + pct(won, tot) + '%</b></td>';
      if (u.assigned_to) tr.onclick = () => openLeads({ assigned_to: u.assigned_to });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    c.appendChild(t);
    c.appendChild(el('div', { class: 'wsh-mini' }, 'Click a row → that agent’s leads in this workspace.'));
    body.appendChild(c);
  }

  /* ================= BY STATUS ================= */
  async function tabStatus(body) {
    const r = await report();
    const rows = r.status_rows || [];
    const total = num((r.kpis || {}).total);
    body.innerHTML = '';
    const c = el('div', { class: 'wsh-card' });
    c.appendChild(el('h3', {}, '🎯 Status-wise <span class="sub"><span class="wsh-tag">reportAdvanced → status_rows</span></span>'));
    if (!rows.length) { c.appendChild(el('div', { class: 'wsh-empty' }, 'No leads in this range.')); body.appendChild(c); return; }
    const t = el('table');
    t.innerHTML = '<thead><tr><th>Status</th><th>Leads</th><th>Share</th><th></th></tr></thead>';
    const tb = el('tbody');
    rows.forEach(s => {
      const n = num(s.cnt), p = pct(n, total);
      const tr = el('tr', { class: 'wsh-clk' });
      tr.innerHTML = '<td><span class="wsh-pill">' + esc(s.status_name || '—') + '</span></td>' +
                     '<td><b>' + n + '</b></td><td>' + p + '%</td>' +
                     '<td style="width:140px"><div class="wsh-bar"><i style="width:' + Math.min(p, 100) + '%"></i></div></td>';
      tr.onclick = () => openLeads({ status_id: s.status_id });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
    c.appendChild(t);
    c.appendChild(el('div', { class: 'wsh-mini' }, 'Click a status → filtered Leads list for this workspace.'));
    body.appendChild(c);
  }

  /* Deep-link into the existing Leads view, pre-filtered to this workspace. */
  function openLeads(extra) {
    try {
      const f = Object.assign({ campaign_ids: [Number(S.wsId)] }, extra || {});
      localStorage.setItem('crm_filters', JSON.stringify(f));
    } catch (_) {}
    if (typeof window.navigateTo === 'function') window.navigateTo('leads');
    else location.hash = '#/leads';
  }

  /* ================= UPLOAD ================= */
  async function tabUpload(body) {
    const w = currentWs() || {};
    body.innerHTML = '';
    const c = el('div', { class: 'wsh-card' });
    c.appendChild(el('h3', {}, '⬆ Upload data into this workspace <span class="sub"><span class="wsh-tag">api_campaigns_uploadLeads</span></span>'));

    const drop = el('div', { class: 'wsh-drop' },
      '<div class="ic">📄</div><h4>Drop your Excel / CSV here</h4>' +
      '<p>Rows land in <b>📁 ' + esc(w.name || '') + '</b> and distribute by <b>' +
      esc(String(w.distribution_mode || '—').replace(/_/g, ' ')) + '</b>.</p>');
    const pick = el('p', { style: 'margin-top:8px' });
    const inp = el('input', { type: 'file', accept: '.csv,.xlsx,.xls' });
    inp.style.display = 'none';
    const bPick = el('button', { class: 'wsh-btn p' }, 'Choose file');
    bPick.onclick = () => inp.click();
    pick.appendChild(bPick);
    pick.appendChild(inp);
    drop.appendChild(pick);
    c.appendChild(drop);

    const out = el('div', { id: 'wsh-up-out' });
    c.appendChild(out);
    c.appendChild(el('div', { class: 'wsh-mini' },
      'Preview first — nothing is written until you confirm. Duplicate handling is your choice here and ignores the tenant default.'));
    body.appendChild(c);

    ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f, out); });
    inp.onchange = () => { if (inp.files[0]) handleFile(inp.files[0], out); };
  }

  async function handleFile(file, out) {
    out.innerHTML = '<div class="wsh-spin">Reading ' + esc(file.name) + '…</div>';
    let rows;
    try { rows = await parseFile(file); }
    catch (e) { out.innerHTML = '<div class="wsh-warn">Could not read the file: ' + esc(e.message) + '</div>'; return; }
    if (!rows.length) { out.innerHTML = '<div class="wsh-warn">That file has no data rows.</div>'; return; }

    out.innerHTML = '<div class="wsh-spin">Checking ' + rows.length + ' rows against the CRM…</div>';
    let pv;
    try {
      pv = await api('api_campaigns_uploadLeads', {
        campaign_id: Number(S.wsId), rows: rows, preview: true, duplicate_policy: S.upload.dupPolicy
      });
    } catch (e) { out.innerHTML = '<div class="wsh-warn">Preview failed: ' + esc(e.message) + '</div>'; return; }

    S.upload.rows = rows;
    const nNew = num(pv.new_count ?? pv.to_insert ?? pv.inserted ?? (rows.length - num(pv.duplicate_count)));
    const nDup = num(pv.duplicate_count ?? pv.duplicates ?? 0);

    out.innerHTML = '';
    // column preview
    const map = el('div', { style: 'margin:0 13px 13px;border:1px solid #e2e8f0;border-radius:9px;overflow:hidden' });
    const keys = Object.keys(rows[0]).slice(0, 8);
    let html = '<table><thead><tr>' + keys.map(k => '<th>' + esc(k) + '</th>').join('') + '</tr></thead><tbody>';
    rows.slice(0, 3).forEach(r => {
      html += '<tr>' + keys.map(k => '<td>' + esc(String(r[k] ?? '').slice(0, 24)) + '</td>').join('') + '</tr>';
    });
    html += '</tbody></table>';
    map.innerHTML = html;
    out.appendChild(map);

    const ok = el('div', { class: 'wsh-ok' });
    ok.innerHTML = '<b>Preview — nothing saved yet.</b> ' + rows.length + ' rows · <b>' + nNew +
      ' new</b> · <b>' + nDup + ' duplicate' + (nDup === 1 ? '' : 's') + '</b> (already in CRM).<br>';
    const dupWrap = el('div', { style: 'margin-top:6px' });
    [['skip', 'Skip duplicates'], ['add', 'Add anyway']].forEach(([v, lbl]) => {
      const id = 'wsh-dup-' + v;
      const l = el('label', { style: 'margin-right:12px;font-size:12.5px;cursor:pointer' });
      const rb = el('input', { type: 'radio', name: 'wsh-dup', id: id });
      if (S.upload.dupPolicy === v) rb.checked = true;
      rb.onchange = () => { S.upload.dupPolicy = v; };
      l.appendChild(rb); l.appendChild(document.createTextNode(' ' + lbl));
      dupWrap.appendChild(l);
    });
    ok.appendChild(dupWrap);
    const bGo = el('button', { class: 'wsh-btn g', style: 'margin-top:8px' }, '✔ Import ' + nNew + ' leads');
    bGo.onclick = async () => {
      bGo.disabled = true; bGo.textContent = 'Importing…';
      try {
        const res = await api('api_campaigns_uploadLeads', {
          campaign_id: Number(S.wsId), rows: S.upload.rows, preview: false, duplicate_policy: S.upload.dupPolicy
        });
        const n = num(res.inserted ?? res.created ?? res.count);
        toast('✅ Imported ' + n + ' leads into this workspace', 'ok');
        S.rep = null; S.upload.rows = null;
        try { const l = await api('api_campaigns_list', {}); S.ws = Array.isArray(l) ? l : (l.rows || []); } catch (_) {}
        S.tab = 'overview'; paint();
      } catch (e) {
        bGo.disabled = false; bGo.textContent = '✔ Import ' + nNew + ' leads';
        toast('Import failed: ' + e.message, 'err');
      }
    };
    ok.appendChild(bGo);
    out.appendChild(ok);
  }

  /* CSV / XLSX → array of objects. XLSX only when SheetJS is already on the page. */
  function parseFile(file) {
    return new Promise((resolve, reject) => {
      const isX = /\.xlsx?$/i.test(file.name);
      const rd = new FileReader();
      rd.onerror = () => reject(new Error('read error'));
      rd.onload = () => {
        try {
          if (isX) {
            if (!window.XLSX) return reject(new Error('Excel support not loaded on this page — save as CSV and retry.'));
            const wb = window.XLSX.read(rd.result, { type: 'array' });
            const sh = wb.Sheets[wb.SheetNames[0]];
            return resolve(window.XLSX.utils.sheet_to_json(sh, { defval: '' }));
          }
          resolve(parseCsv(String(rd.result)));
        } catch (e) { reject(e); }
      };
      if (isX) rd.readAsArrayBuffer(file); else rd.readAsText(file);
    });
  }
  function parseCsv(txt) {
    const lines = txt.split(/\r?\n/).filter(l => l.trim() !== '');
    if (!lines.length) return [];
    const split = l => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur); return out;
    };
    const hdr = split(lines[0]).map(h => h.trim());
    return lines.slice(1).map(l => {
      const c = split(l); const o = {};
      hdr.forEach((h, i) => { if (h) o[h] = (c[i] || '').trim(); });
      return o;
    });
  }

  /* ================= RE-CHURN ================= */
  const CHURN_MODES = [
    ['idle7',  'No activity > 7 days',  { idle_days: 7 }],
    ['idle30', 'No activity > 30 days', { idle_days: 30 }],
    ['all',    'All unclosed',          {}]
  ];

  async function tabRechurn(body) {
    const w = currentWs() || {};
    body.innerHTML = '';
    const c = el('div', { class: 'wsh-card' });
    c.appendChild(el('h3', {}, '♻ Re-churn — put unclosed leads back in the pool ' +
      '<span class="sub"><span class="wsh-tag">api_campaigns_resetUnclosed</span></span>'));

    const warn = el('div', { class: 'wsh-warn' });
    warn.innerHTML =
      '<b>What re-churn does to every matching lead in 📁 ' + esc(w.name || '') + ':</b><br><br>' +
      '<div class="wsh-kv"><b>Un-assign from agent</b> → back to the free pool</div>' +
      '<div class="wsh-kv"><b>Clear pull history</b> → every agent can pull them again</div>' +
      '<div class="wsh-kv"><b>Keep workspace</b> → they stay in this workspace</div>' +
      '<div class="wsh-kv"><b>Never touched</b> → Won / Lost / Junk (final statuses)</div>' +
      '<div class="wsh-kv"><b>Protected</b> → leads with a future follow-up booked</div>';
    c.appendChild(warn);

    const pickBox = el('div', { style: 'padding:0 13px 13px' });
    pickBox.appendChild(el('div', { style: 'font-size:12.5px;font-weight:700;margin-bottom:6px' }, 'Re-churn which leads?'));
    const chips = el('div');
    CHURN_MODES.forEach(([k, lbl]) => {
      const ch = el('span', { class: 'wsh-chip' + (S.rechurn.mode === k ? ' on' : ''), style: 'margin-right:6px' }, lbl);
      ch.onclick = () => { S.rechurn.mode = k; S.rechurn.dry = null; paint(); };
      chips.appendChild(ch);
    });
    pickBox.appendChild(chips);

    const skipL = el('label', { style: 'display:block;margin-top:10px;font-size:12.5px;cursor:pointer' });
    const skipCb = el('input', { type: 'checkbox' });
    skipCb.checked = true; skipCb.id = 'wsh-skipfu';
    skipL.appendChild(skipCb);
    skipL.appendChild(document.createTextNode(' Protect leads with a future follow-up booked (recommended)'));
    pickBox.appendChild(skipL);

    const act = el('div', { style: 'margin-top:11px' });
    const bPrev = el('button', { class: 'wsh-btn' }, '👁 Preview');
    act.appendChild(bPrev);
    pickBox.appendChild(act);
    c.appendChild(pickBox);

    const res = el('div', { id: 'wsh-rc-out' });
    c.appendChild(res);
    c.appendChild(el('div', { class: 'wsh-mini' },
      'Preview always runs first and writes nothing. You will see the exact count before anything changes.'));
    body.appendChild(c);

    bPrev.onclick = async () => {
      bPrev.disabled = true; bPrev.textContent = 'Checking…';
      const mode = CHURN_MODES.find(m => m[0] === S.rechurn.mode) || CHURN_MODES[0];
      const payload = Object.assign({
        campaign_id: Number(S.wsId), apply: false,
        skip_future_followups: skipCb.checked
      }, mode[2]);
      try {
        const dry = await api('api_campaigns_resetUnclosed', payload);
        S.rechurn.dry = dry;
        renderDry(res, dry, payload);
      } catch (e) {
        res.innerHTML = '<div class="wsh-warn">Preview failed: ' + esc(e.message) + '</div>';
      }
      bPrev.disabled = false; bPrev.textContent = '👁 Preview';
    };
  }

  function renderDry(host, dry, payload) {
    const n = num(dry.would_reset);
    host.innerHTML = '';
    if (!n) {
      host.appendChild(el('div', { class: 'wsh-ok' }, '<b>Nothing to re-churn.</b> No leads match that filter.'));
      return;
    }
    const box = el('div', { class: 'wsh-ok' });
    box.innerHTML = '<b>Preview — nothing changed.</b> <b style="font-size:15px">' + n +
      '</b> lead' + (n === 1 ? '' : 's') + ' would go back to the pool.';
    host.appendChild(box);

    const sample = dry.sample || [];
    if (sample.length) {
      const t = el('table', { style: 'margin:0 13px 12px;width:calc(100% - 26px);border:1px solid #e2e8f0;border-radius:9px' });
      t.innerHTML = '<thead><tr><th>Lead</th><th>Phone</th><th>Status</th><th>Agent</th><th>Last touch</th></tr></thead>';
      const tb = el('tbody');
      sample.forEach(r => {
        const d = r.last_touch ? new Date(r.last_touch) : null;
        tb.appendChild(el('tr', {}, '<td>' + esc(r.name || '—') + '</td><td>' + esc(r.phone || '') + '</td>' +
          '<td><span class="wsh-pill">' + esc(r.status || '—') + '</span></td><td>' + esc(r.agent || '—') + '</td>' +
          '<td>' + (d ? d.toLocaleDateString('en-IN') : '—') + '</td>'));
      });
      t.appendChild(tb);
      host.appendChild(t);
      if (n > sample.length) {
        host.appendChild(el('div', { class: 'wsh-mini' }, 'Showing first ' + sample.length + ' of ' + n + '.'));
      }
    }

    const go = el('div', { style: 'padding:0 13px 14px' });
    const b = el('button', { class: 'wsh-btn w' }, '♻ Re-churn ' + n + ' lead' + (n === 1 ? '' : 's'));
    b.onclick = async () => {
      if (!confirm('Re-churn ' + n + ' leads?\n\nThey will be un-assigned from their agent and returned to the free pool. This cannot be undone.')) return;
      b.disabled = true; b.textContent = 'Re-churning…';
      try {
        const r = await api('api_campaigns_resetUnclosed', Object.assign({}, payload, { apply: true }));
        toast('♻ ' + num(r.reset_count) + ' leads returned to the pool', 'ok');
        S.rep = null; S.rechurn.dry = null;
        try { const l = await api('api_campaigns_list', {}); S.ws = Array.isArray(l) ? l : (l.rows || []); } catch (_) {}
        S.tab = 'overview'; paint();
      } catch (e) {
        b.disabled = false; b.textContent = '♻ Re-churn ' + n + ' leads';
        toast('Re-churn failed: ' + e.message, 'err');
      }
    };
    go.appendChild(b);
    host.appendChild(go);
  }

  /* ================= AGENTS ================= */
  async function tabAgents(body) {
    const w = currentWs() || {};
    body.innerHTML = '';
    let full = null;
    try { full = await api('api_campaigns_get', Number(S.wsId)); } catch (_) {}
    const agents = (full && (full.agents || full.campaign_agents)) || [];

    body.innerHTML =
      '<div class="wsh-kpis" style="grid-template-columns:repeat(4,1fr)">' +
        kpiCard('Agents', num(w.agent_count), 'on this workspace') +
        kpiCard('Distribution', '<span style="font-size:14px">' + esc(String(w.distribution_mode || '—').replace(/_/g, ' ')) + '</span>', '&nbsp;') +
        kpiCard('Pullable', num(w.leads_pullable), 'ready to pull') +
        kpiCard('Unassigned', num(w.leads_unassigned), 'in free pool') +
      '</div>';

    const c = el('div', { class: 'wsh-card' });
    c.appendChild(el('h3', {}, '👥 Agents on this workspace <span class="sub"><span class="wsh-tag">campaign_agents</span></span>'));
    if (!agents.length) {
      c.appendChild(el('div', { class: 'wsh-empty' },
        'No agents assigned.<br><span style="font-size:11.5px">Add them from the Settings tab — leads can’t distribute without agents.</span>'));
    } else {
      const t = el('table');
      t.innerHTML = '<thead><tr><th>Agent</th><th>Weight %</th><th>Active</th></tr></thead>';
      const tb = el('tbody');
      agents.forEach((a, i) => {
        tb.appendChild(el('tr', {}, '<td><div class="wsh-who"><div class="wsh-av" style="background:' + AV[i % AV.length] + '">' +
          esc(initials(a.user_name || a.name)) + '</div>' + esc(a.user_name || a.name || ('User ' + a.user_id)) + '</div></td>' +
          '<td>' + num(a.weight_pct) + '%</td>' +
          '<td>' + (num(a.is_active) ? '<span class="wsh-pill" style="background:#d1fae5;color:#065f46">active</span>'
                                     : '<span class="wsh-pill">paused</span>') + '</td>'));
      });
      t.appendChild(tb);
      c.appendChild(t);
    }
    c.appendChild(el('div', { class: 'wsh-mini' }, 'Membership + weights are edited on the Settings tab.'));
    body.appendChild(c);
  }

  /* ================= SETTINGS ================= */
  async function tabSettings(body) {
    body.innerHTML = '';
    /* Reuse the existing CRUD wholesale. It works, it is battle-tested, and replacing a
     * working admin screen to make room for a new page is how regressions happen. */
    if (typeof window.adminCampaigns === 'function') {
      try {
        const node = await window.adminCampaigns(() => { S.rep = null; render(document.getElementById('view') || body.parentNode); });
        body.appendChild(node);
        return;
      } catch (e) { /* fall through */ }
    }
    body.appendChild(el('div', { class: 'wsh-card' },
      '<div class="wsh-empty">Workspace settings module not loaded — refresh the page.</div>'));
  }

  /* ---- expose ---- */
  window.WorkspaceHub = { render: render };
  try { console.log('[workspaceHub] WORKSPACE_HUB_v1 loaded'); } catch (_) {}
})();
