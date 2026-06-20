/* LEADS_VIEW_V2 (2026-06-21) — Modern (A3) + Inbox (C3) view styles.
 * Toggleable from a segment control at the top of the leads page. Default
 * is 'classic' which renders the legacy table untouched. Vserve-only beta
 * via LEADS_VIEW_V2_ENABLED config flag (auto-enabled at boot+7s).
 *
 * Designed to coexist with the existing VIEWS.leads renderer — the
 * delegator in app.js only swaps when the user picks Modern or Inbox.
 */
(function () {
  'use strict';

  const SLUG = (function () { const m = location.pathname.match(/\/t\/([^\/]+)/); return m ? m[1] : ''; })();
  function _tok() { return localStorage.getItem('crm_token_' + SLUG) || localStorage.getItem('crm_token') || ''; }
  async function api(fn, ...args) {
    const r = await fetch(`/t/${SLUG}/api`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args: [_tok(), ...args] })
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'API error');
    return j.result;
  }

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v);
    }
    for (let i = 2; i < arguments.length; i++) {
      const k = arguments[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)) {
        for (const kk of k) {
          if (kk == null || kk === false) continue;
          el.appendChild(typeof kk === 'string' || typeof kk === 'number' ? document.createTextNode(String(kk)) : kk);
        }
      } else {
        el.appendChild(typeof k === 'string' || typeof k === 'number' ? document.createTextNode(String(k)) : k);
      }
    }
    return el;
  }
  function $(s, root) { return (root || document).querySelector(s); }
  function toast(m, k) { try { (window.toast || function (m) { console.log(m); })(m, k); } catch (_) {} }

  /* ---------- state ---------- */
  const S = {
    leads: [], statuses: [], users: [],
    filter: 'all',
    search: '',
    selectedId: null,
    style: 'classic'
  };

  /* ---------- helpers ---------- */
  function initials(name) {
    const p = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
    return (p[0][0] + p[p.length - 1][0]).toUpperCase();
  }
  function avColor(name) {
    const pal = ['#ec96b8', '#b8a4d8', '#88cfd8', '#ffc870', '#98d8a4', '#f4a3a3', '#a4c8ff'];
    let n = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) n = ((n << 5) - n + s.charCodeAt(i)) | 0;
    return pal[Math.abs(n) % pal.length];
  }
  function statusClass(name) {
    const n = String(name || '').toLowerCase();
    if (/new/.test(n)) return 'new';
    if (/demo/.test(n)) return 'demo';
    if (/proposal|payment/.test(n)) return 'proposal';
    if (/call.?back|hot/.test(n)) return 'hot';
    if (/did.?not|miss|no.?ans|np/.test(n)) return 'warm';
    if (/not.?interest|junk|lost/.test(n)) return 'lost';
    if (/sale|done|won/.test(n)) return 'done';
    if (/follow/.test(n)) return 'cold';
    return 'cold';
  }
  function scoreBucket(s) {
    s = Number(s || 0);
    if (s >= 80) return 'hot';
    if (s >= 50) return 'warm';
    if (s > 0)   return 'cold';
    return '';
  }
  function fmtRel(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const sec = Math.floor((Date.now() - d) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    if (sec < 7 * 86400) return Math.floor(sec / 86400) + 'd';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  function sparkSvg(score) {
    score = Number(score || 0);
    const bucket = scoreBucket(score);
    const color = bucket === 'hot' ? '#ef4444' : bucket === 'warm' ? '#f59e0b' : '#3b82f6';
    // Fake trend points pseudo-randomly from the lead id seed for visual interest
    const pts = [10, 9, 7, 5, 4 - Math.min(3, Math.round(score / 30))];
    const path = pts.map((y, i) => (i * 12) + ',' + y).join(' ');
    return '<svg width="46" height="12" viewBox="0 0 46 12"><polyline points="' + path + '" fill="none" stroke="' + color + '" stroke-width="1.5"/></svg>';
  }

  /* ---------- styles (injected once) ---------- */
  function injectStyles() {
    if (document.getElementById('lv2-styles')) return;
    const css = `
.lv2-toggle { display: inline-flex; background: #f1f5f9; border-radius: 8px; padding: 3px; gap: 1px; margin: 0 8px; }
.lv2-toggle button { padding: 5px 12px; border: none; background: transparent; cursor: pointer; color: #64748b; font-size: 11.5px; font-weight: 500; border-radius: 6px; display: flex; align-items: center; gap: 5px; }
.lv2-toggle button:hover { color: #0f172a; }
.lv2-toggle button.active { background: white; color: #0f172a; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.06); }

/* ===== MODERN (A3) STYLES ===== */
.lv2-modern { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; margin-top: 10px; }
.lv2-modern .health { display: grid; grid-template-columns: repeat(5, 1fr); padding: 14px 18px; border-bottom: 1px solid #e2e8f0; background: linear-gradient(to bottom, #fafbfc, #ffffff); }
.lv2-modern .hcell { padding: 0 16px; border-right: 1px solid #f1f5f9; }
.lv2-modern .hcell:first-child { padding-left: 0; }
.lv2-modern .hcell:last-child { border-right: none; }
.lv2-modern .hcell .lab { font-size: 10px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: .3px; }
.lv2-modern .hcell .val { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 3px; }
.lv2-modern .hcell .ch { font-size: 10px; color: #10b981; margin-top: 2px; }
.lv2-modern .hcell .ch.dn { color: #ef4444; }

.lv2-modern .toolbar { padding: 10px 16px; background: #ffffff; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.lv2-modern .toolbar .search { display: flex; align-items: center; gap: 7px; padding: 5px 11px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; min-width: 240px; flex: 1; max-width: 360px; }
.lv2-modern .toolbar .search input { border: none; background: transparent; outline: none; font-size: 12.5px; flex: 1; color: #0f172a; }
.lv2-modern .toolbar .fpill { padding: 4px 10px; background: white; border: 1px solid #e2e8f0; border-radius: 14px; font-size: 11.5px; cursor: pointer; color: #64748b; display: flex; align-items: center; gap: 4px; }
.lv2-modern .toolbar .fpill:hover { border-color: #6366f1; color: #4f46e5; }
.lv2-modern .toolbar .fpill.active { background: #eef2ff; border-color: #c7d2fe; color: #4338ca; font-weight: 500; }
.lv2-modern .toolbar .right { margin-left: auto; display: flex; gap: 4px; }
.lv2-modern .toolbar .btn { padding: 5px 10px; background: white; border: 1px solid #e2e8f0; border-radius: 6px; font-size: 11.5px; cursor: pointer; color: #475569; font-weight: 500; display: flex; align-items: center; gap: 4px; }
.lv2-modern .toolbar .btn:hover { border-color: #6366f1; color: #4f46e5; }

.lv2-modern .qchips { padding: 10px 16px; background: white; border-bottom: 1px solid #e2e8f0; display: flex; gap: 6px; flex-wrap: wrap; }
.lv2-modern .qchip { padding: 4px 11px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; font-size: 11.5px; cursor: pointer; color: #64748b; display: flex; align-items: center; gap: 5px; font-weight: 500; }
.lv2-modern .qchip:hover { border-color: #6366f1; color: #4f46e5; }
.lv2-modern .qchip.active { background: #eef2ff; border-color: #c7d2fe; color: #4338ca; font-weight: 600; }

.lv2-modern .tbl-wrap { max-height: calc(100vh - 380px); overflow: auto; background: white; }
.lv2-modern table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
.lv2-modern thead th { position: sticky; top: 0; background: #fafbfc; padding: 9px 12px; text-align: left; font-weight: 600; color: #64748b; font-size: 10.5px; text-transform: uppercase; letter-spacing: .4px; border-bottom: 1px solid #e2e8f0; white-space: nowrap; z-index: 5; }
.lv2-modern thead th.sticky-l { position: sticky; left: 0; background: #fafbfc; z-index: 10; border-right: 1px solid #f1f5f9; }
.lv2-modern tbody td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
.lv2-modern tbody td.sticky-l { position: sticky; left: 0; background: white; z-index: 3; border-right: 1px solid #f1f5f9; }
.lv2-modern tbody tr:hover td { background: #f8fafc; }
.lv2-modern tbody tr:hover td.sticky-l { background: #f8fafc; }
.lv2-modern tbody tr.selected td, .lv2-modern tbody tr.selected td.sticky-l { background: #eef2ff; }

.lv2-namecell { display: flex; align-items: center; gap: 10px; }
.lv2-av { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: white; font-weight: 600; font-size: 11px; flex-shrink: 0; }
.lv2-av.s { width: 22px; height: 22px; font-size: 9px; }
.lv2-namestack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.lv2-nm { font-weight: 500; color: #0f172a; font-size: 13px; }
.lv2-badges { display: flex; gap: 3px; align-items: center; }
.lv2-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
.lv2-badge.ai { background: linear-gradient(135deg, #fef3c7, #fde68a); color: #92400e; cursor: pointer; }
.lv2-badge.fire { background: linear-gradient(135deg, #fee2e2, #fef3c7); color: #b91c1c; }

.lv2-phonecell { display: flex; align-items: center; gap: 6px; }
.lv2-ph { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 12px; color: #0f172a; }
.lv2-actions { display: flex; gap: 1px; opacity: .4; transition: opacity .15s; }
tr:hover .lv2-actions { opacity: 1; }
.lv2-act { width: 24px; height: 24px; border: none; background: transparent; border-radius: 5px; cursor: pointer; color: #64748b; font-size: 12px; display: grid; place-items: center; }
.lv2-act:hover { transform: scale(1.15); }
.lv2-act.call:hover { background: #dbeafe; color: #1e40af; }
.lv2-act.sim:hover { background: #fef3c7; color: #92400e; }
.lv2-act.wa:hover { background: #dcfce7; color: #15803d; }
.lv2-act.api { background: linear-gradient(135deg, #dcfce7, #bbf7d0); color: #15803d; opacity: 1; }
.lv2-act.ai { background: linear-gradient(135deg, #ede9fe, #ddd6fe); color: #6d28d9; opacity: 1; }
.lv2-act.copy:hover { background: #f1f5f9; color: #0f172a; }

.lv2-status { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.lv2-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.lv2-dot.new { background: #22c55e; } .lv2-dot.hot { background: #ef4444; } .lv2-dot.warm { background: #f59e0b; } .lv2-dot.cold { background: #3b82f6; } .lv2-dot.demo { background: #a855f7; } .lv2-dot.proposal { background: #06b6d4; } .lv2-dot.done { background: #10b981; } .lv2-dot.lost { background: #6b7280; } .lv2-dot.fresh { background: #22c55e; }
.lv2-stext { font-size: 12px; color: #475569; }

.lv2-scorecell { display: flex; align-items: center; gap: 8px; }
.lv2-scorenum { font-size: 13px; font-weight: 700; }
.lv2-scorenum.hot { color: #b91c1c; } .lv2-scorenum.warm { color: #b45309; } .lv2-scorenum.cold { color: #1e40af; }

.lv2-aisum { font-size: 11.5px; color: #6b21a8; max-width: 240px; line-height: 1.3; }
.lv2-aisum::before { content: '✨ '; }

.lv2-muted { color: #94a3b8; font-size: 12px; }

/* SLIDE-OVER detail panel */
.lv2-slideover { position: fixed; top: 56px; right: 0; width: 460px; height: calc(100vh - 56px); background: white; border-left: 1px solid #e2e8f0; box-shadow: -10px 0 30px rgba(0,0,0,.06); z-index: 990; display: flex; flex-direction: column; animation: lv2slide .2s ease-out; }
@keyframes lv2slide { from { transform: translateX(100%); } to { transform: translateX(0); } }
.lv2-so-head { padding: 16px 20px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; gap: 12px; }
.lv2-so-head .lv2-av { width: 44px; height: 44px; border-radius: 12px; font-size: 16px; }
.lv2-so-head .info { flex: 1; min-width: 0; }
.lv2-so-head .name { font-size: 16px; font-weight: 700; color: #0f172a; }
.lv2-so-head .sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.lv2-so-head .x { width: 30px; height: 30px; cursor: pointer; color: #64748b; font-size: 18px; display: grid; place-items: center; border-radius: 6px; }
.lv2-so-head .x:hover { background: #f1f5f9; color: #0f172a; }
.lv2-so-body { flex: 1; overflow-y: auto; padding: 16px 20px; }
.lv2-so-quick { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 14px; }
.lv2-so-quick button { padding: 10px 6px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 11px; color: #475569; font-weight: 600; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.lv2-so-quick button:hover { background: #eef2ff; color: #4f46e5; border-color: #c7d2fe; }
.lv2-so-quick button .ic { font-size: 16px; }
.lv2-so-card { background: #fafbfc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; margin-bottom: 10px; }
.lv2-so-card h3 { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 10px; }
.lv2-so-card.ai { background: linear-gradient(135deg, #faf5ff 0%, #fef3c7 100%); border-color: #ddd6fe; }
.lv2-so-card.ai h3 { color: #6b21a8; }
.lv2-so-card.ai .txt { font-size: 12px; color: #1e293b; line-height: 1.5; white-space: pre-wrap; }
.lv2-so-row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 12px; border-bottom: 1px solid #f1f5f9; }
.lv2-so-row:last-child { border-bottom: none; }
.lv2-so-row .k { color: #64748b; }
.lv2-so-row .v { font-weight: 500; color: #0f172a; }

/* AI ASSISTANT DRAWER */
.lv2-ai-drawer { position: fixed; bottom: 80px; right: 24px; background: linear-gradient(135deg, #a855f7, #7c3aed); color: white; padding: 10px 16px; border-radius: 24px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 10px 30px rgba(168,85,247,.3); z-index: 80; }
.lv2-ai-drawer .pulse { width: 8px; height: 8px; background: #c084fc; border-radius: 50%; animation: lv2pulse 1.5s infinite; }
@keyframes lv2pulse { 0%,100%{opacity:.4;} 50%{opacity:1;} }

/* ===== INBOX (C3) STYLES ===== */
.lv2-inbox { background: white; border: 1px solid #e2e8f0; border-radius: 10px; margin-top: 10px; overflow: hidden; display: grid; grid-template-columns: 380px 1fr; height: calc(100vh - 220px); }
.lv2-inbox-list { border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; min-height: 0; background: white; }
.lv2-inbox-head { padding: 12px 16px 8px; border-bottom: 1px solid #f1f5f9; }
.lv2-inbox-head .row1 { display: flex; align-items: center; justify-content: space-between; }
.lv2-inbox-head h2 { font-size: 16px; font-weight: 700; color: #0f172a; }
.lv2-inbox-head .c { background: #eef2ff; color: #4f46e5; font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
.lv2-inbox-head .search { margin-top: 8px; display: flex; align-items: center; gap: 7px; padding: 7px 12px; background: #f1f5f9; border-radius: 8px; }
.lv2-inbox-head .search input { border: none; background: transparent; outline: none; flex: 1; font-size: 12.5px; }

.lv2-inbox-views { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; display: flex; gap: 4px; overflow-x: auto; }
.lv2-inbox-views .v { padding: 5px 11px; border-radius: 14px; font-size: 11px; cursor: pointer; color: #64748b; background: #f8fafc; display: flex; align-items: center; gap: 5px; white-space: nowrap; font-weight: 500; }
.lv2-inbox-views .v:hover { background: #eef2ff; color: #4f46e5; }
.lv2-inbox-views .v.active { background: #6366f1; color: white; font-weight: 600; }

.lv2-inbox-rows { flex: 1; overflow-y: auto; }
.lv2-inbox-row { padding: 11px 16px; cursor: pointer; border-bottom: 1px solid #f1f5f9; position: relative; }
.lv2-inbox-row:hover { background: #fafbfc; }
.lv2-inbox-row.active { background: #eef2ff; border-left: 3px solid #6366f1; padding-left: 13px; }
.lv2-inbox-row .top { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.lv2-inbox-row .nm { font-size: 13px; color: #0f172a; font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lv2-inbox-row .when { font-size: 10px; color: #94a3b8; white-space: nowrap; }
.lv2-inbox-row .meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: #64748b; margin-left: 40px; margin-top: 2px; }
.lv2-inbox-row .stagetag { font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: .3px; }
.lv2-inbox-row .preview { font-size: 11.5px; color: #64748b; margin-top: 4px; margin-left: 40px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lv2-inbox-row .score-mini { position: absolute; top: 12px; right: 14px; font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 4px; }
.score-mini.hot { background: #fef2f2; color: #b91c1c; } .score-mini.warm { background: #fffbeb; color: #b45309; } .score-mini.cold { background: #eff6ff; color: #1e40af; }
.stagetag.new { background: #dcfce7; color: #15803d; } .stagetag.demo { background: #ede9fe; color: #6d28d9; } .stagetag.proposal { background: #cffafe; color: #0e7490; } .stagetag.lost { background: #f3f4f6; color: #64748b; } .stagetag.cold { background: #dbeafe; color: #1e40af; } .stagetag.hot { background: #fef2f2; color: #b91c1c; } .stagetag.warm { background: #fffbeb; color: #b45309; } .stagetag.done { background: #dcfce7; color: #166534; }

.lv2-inbox-detail { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.lv2-inbox-empty { display: grid; place-items: center; height: 100%; color: #94a3b8; font-size: 14px; padding: 30px; text-align: center; }
.lv2-inbox-empty .big { font-size: 56px; opacity: .25; margin-bottom: 12px; }
`;
    document.head.appendChild(h('style', { id: 'lv2-styles', html: css }));
  }

  /* ---------- data load ---------- */
  async function load() {
    try {
      const [leads, statuses, users] = await Promise.all([
        api('api_leads_list', { page_size: 200 }).catch(() => []),
        api('api_statuses_list').catch(() => []),
        api('api_users_list').catch(() => [])
      ]);
      // api_leads_list returns { leads, total, page, page_size, status_count }
      // — handle that shape PLUS fall back to direct array / .rows for safety.
      S.leads = (leads && Array.isArray(leads.leads)) ? leads.leads
              : (Array.isArray(leads) ? leads
              : (leads && Array.isArray(leads.rows)) ? leads.rows
              : []);
      console.log('[LEADS_V2] loaded', S.leads.length, 'leads · statuses:', (statuses||[]).length, '· users:', (users||[]).length);
      S.statuses = statuses || [];
      S.users = users || [];
    } catch (e) {
      toast('Could not load leads: ' + e.message, 'err');
    }
  }

  function filtered() {
    const meId = (window.CRM && CRM.user && CRM.user.id) || null;
    const q = String(S.search || '').toLowerCase().trim();
    return (S.leads || []).filter(l => {
      if (S.filter === 'hot' && Number(l.smart_score || 0) < 80) return false;
      if (S.filter === 'overdue') {
        if (!l.next_followup_at) return false;
        if (new Date(l.next_followup_at) > new Date()) return false;
      }
      if (S.filter === 'today') {
        if (!l.next_followup_at) return false;
        const d = new Date(l.next_followup_at);
        const n = new Date();
        if (d.toDateString() !== n.toDateString()) return false;
      }
      if (S.filter === 'mine' && meId && Number(l.assigned_to) !== Number(meId)) return false;
      if (S.filter === 'new' && !/new|fresh/i.test(l.status_name || '')) return false;
      if (q) {
        const hay = ((l.name || '') + ' ' + (l.phone || '') + ' ' + (l.email || '') + ' ' + (l.notes || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  /* ====================================================================
   * MODERN (A3) RENDERER — full table with AI columns + slide-over panel
   * ==================================================================*/
  async function renderModern(view) {
    injectStyles();
    if (!S.leads.length) await load();

    const meId = (window.CRM && CRM.user && CRM.user.id) || null;
    const total = S.leads.length;
    const hot = S.leads.filter(l => Number(l.smart_score || 0) >= 80).length;
    const overdue = S.leads.filter(l => l.next_followup_at && new Date(l.next_followup_at) < new Date()).length;
    const mine = meId ? S.leads.filter(l => Number(l.assigned_to) === Number(meId)).length : 0;
    const newCnt = S.leads.filter(l => /new|fresh/i.test(l.status_name || '')).length;

    const wrap = h('div', { class: 'lv2-modern' });

    // Health hero
    wrap.appendChild(h('div', { class: 'health' },
      hcell('Total', total, '↑ Synced', false),
      hcell('🔥 Hot', hot, hot ? '↑ ' + hot + ' to call' : '—', false, '#b91c1c'),
      hcell('⏰ Overdue', overdue, overdue ? '↓ Action!' : '✓ Clean', !!overdue, '#f59e0b'),
      hcell('⭐ Mine', mine, '', false),
      hcell('🆕 New', newCnt, '', false, '#15803d')
    ));

    // Toolbar
    const toolbar = h('div', { class: 'toolbar' },
      h('div', { class: 'search' },
        h('span', { style: { color: '#94a3b8' } }, '🔍'),
        h('input', { placeholder: 'Search name, phone, email, notes…', value: S.search,
          oninput: (e) => { S.search = e.target.value; rerenderRows(); } })),
      h('button', { class: 'fpill active', title: 'Filtered to last 7 days' }, '📅 Last 7 days'),
      h('button', { class: 'fpill' }, '👤 Owner ▾'),
      h('button', { class: 'fpill' }, '🏷 Source ▾'),
      h('button', { class: 'fpill' }, '🤖 Score ▾'),
      h('button', { class: 'fpill' }, '＋ Add filter'),
      h('div', { class: 'right' },
        h('button', { class: 'btn', onclick: load }, '↻ Refresh'),
        h('button', { class: 'btn' }, '↓ Export'),
        h('button', { class: 'btn' }, '＋ New Lead'))
    );
    wrap.appendChild(toolbar);

    // Quick chips
    const qchips = h('div', { class: 'qchips' });
    const chips = [['all','All','📋',total],['hot','🔥 Hot','',hot],['overdue','⏰ Overdue','',overdue],['today','📅 Due today','',0],['mine','⭐ Mine','',mine],['new','🆕 New','',newCnt]];
    chips.forEach(([key, label, ic, count]) => {
      qchips.appendChild(h('span', {
        class: 'qchip' + (S.filter === key ? ' active' : ''),
        onclick: () => { S.filter = key; renderModern(view); }
      }, label, count ? h('span', { style: { background: '#e2e8f0', color: '#475569', padding: '1px 5px', borderRadius: '8px', fontSize: '9px', fontWeight: '700' } }, String(count)) : null));
    });
    wrap.appendChild(qchips);

    // Table
    const tblWrap = h('div', { class: 'tbl-wrap', id: 'lv2-tbl-wrap' });
    tblWrap.appendChild(renderModernTable());
    wrap.appendChild(tblWrap);

    view.appendChild(wrap);
    mountAiDrawer();
  }
  function hcell(lab, val, ch, isDn, color) {
    return h('div', { class: 'hcell' },
      h('div', { class: 'lab' }, lab),
      h('div', { class: 'val', style: color ? { color } : null }, String(val).toLocaleString ? Number(val).toLocaleString('en-IN') : val),
      ch ? h('div', { class: 'ch' + (isDn ? ' dn' : '') }, ch) : null);
  }
  function rerenderRows() {
    const w = $('#lv2-tbl-wrap');
    if (!w) return;
    w.innerHTML = '';
    w.appendChild(renderModernTable());
  }
  function renderModernTable() {
    const rows = filtered();
    const tbl = h('table');
    const thead = h('thead', null, h('tr', null,
      h('th', { class: 'sticky-l', style: { width: '36px' } }, h('input', { type: 'checkbox' })),
      h('th', { class: 'sticky-l', style: { left: '36px' } }, 'Name'),
      h('th', null, 'Phone & actions'),
      h('th', null, 'Source'),
      h('th', null, 'Status'),
      h('th', null, 'Owner'),
      h('th', null, '🤖 AI Score'),
      h('th', null, '✨ AI Next Step'),
      h('th', null, 'Activity'),
      h('th', null, 'Created')
    ));
    tbl.appendChild(thead);
    const tbody = h('tbody');
    rows.slice(0, 100).forEach(l => tbody.appendChild(renderModernRow(l)));
    tbl.appendChild(tbody);
    if (!rows.length) tbody.appendChild(h('tr', null, h('td', { colspan: 10, style: { padding: '40px', textAlign: 'center', color: '#94a3b8' } }, 'No leads match your filter.')));
    return tbl;
  }
  function renderModernRow(l) {
    const name = l.name || l.phone || '—';
    const stat = statusClass(l.status_name);
    const score = Number(l.smart_score || 0);
    const bucket = scoreBucket(score);
    const isSelected = S.selectedId === l.id;
    const tr = h('tr', { class: isSelected ? 'selected' : '', onclick: () => openSlideOver(l) });
    tr.appendChild(h('td', { class: 'sticky-l', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox' })));
    tr.appendChild(h('td', { class: 'sticky-l', style: { left: '36px' } },
      h('div', { class: 'lv2-namecell' },
        h('div', { class: 'lv2-av', style: { background: avColor(name) } }, initials(name)),
        h('div', { class: 'lv2-namestack' },
          h('span', { class: 'lv2-nm' }, name),
          h('div', { class: 'lv2-badges' },
            h('span', { class: 'lv2-badge ai', title: 'AI Hub', onclick: (e) => { e.stopPropagation(); aiHub(l); } }, '✨ AI'),
            score >= 80 ? h('span', { class: 'lv2-badge fire' }, '🔥 HOT') : null)))));
    tr.appendChild(h('td', null,
      h('div', { class: 'lv2-phonecell' },
        h('span', { class: 'lv2-ph' }, l.phone || '—'),
        h('div', { class: 'lv2-actions', onclick: (e) => e.stopPropagation() },
          h('button', { class: 'lv2-act call', title: 'Click-to-Call', onclick: () => doCall(l) }, '📞'),
          h('button', { class: 'lv2-act sim', title: 'Mobile SIM', onclick: () => doSim(l) }, '📱'),
          h('button', { class: 'lv2-act wa', title: 'WhatsApp Web', onclick: () => doWaWeb(l) }, '💬'),
          h('button', { class: 'lv2-act api', title: 'WA Cloud API', onclick: () => doWaApi(l) }, '✨'),
          h('button', { class: 'lv2-act ai', title: 'AI Lead Hub', onclick: () => aiHub(l) }, '🤖'),
          h('button', { class: 'lv2-act copy', title: 'Copy phone', onclick: () => doCopy(l) }, '📋')))));
    tr.appendChild(h('td', null, h('span', { class: 'lv2-muted' }, l.source || '—')));
    tr.appendChild(h('td', null, h('div', { class: 'lv2-status' }, h('span', { class: 'lv2-dot ' + stat }), h('span', { class: 'lv2-stext' }, l.status_name || '—'))));
    tr.appendChild(h('td', null, l.assigned_name ? h('div', { class: 'lv2-namecell' }, h('div', { class: 'lv2-av s', style: { background: avColor(l.assigned_name) } }, initials(l.assigned_name)), h('span', { style: { fontSize: '12px' } }, l.assigned_name)) : h('span', { class: 'lv2-muted' }, '—')));
    tr.appendChild(h('td', null, h('div', { class: 'lv2-scorecell' }, h('span', { class: 'lv2-scorenum ' + bucket }, score ? String(score) : '—'), score ? h('span', { html: sparkSvg(score) }) : null)));
    tr.appendChild(h('td', null, h('div', { class: 'lv2-aisum' }, aiHint(l))));
    tr.appendChild(h('td', null, h('span', { class: 'lv2-muted' }, fmtRel(l.last_activity_at || l.updated_at))));
    tr.appendChild(h('td', null, h('span', { class: 'lv2-muted' }, fmtRel(l.created_at))));
    return tr;
  }
  function aiHint(l) {
    const sc = Number(l.smart_score || 0);
    const bucket = scoreBucket(sc);
    if (l.status_name && /demo.*sched/i.test(l.status_name)) return 'Demo scheduled · send reminder day before + agenda';
    if (l.status_name && /payment|proposal/i.test(l.status_name)) return 'Payment sent · gentle nudge today, escalate tomorrow';
    if (l.status_name && /not.?interest|lost|junk/i.test(l.status_name)) return 'Lost — recover after 30 days with new offer';
    if (l.status_name && /done|won|sale/i.test(l.status_name)) return 'Won · request testimonial in 7 days';
    if (bucket === 'hot') return 'Hot lead · respond personally NOW, not template';
    if (bucket === 'warm') return 'Warm — push for demo or call this week';
    if (bucket === 'cold') return 'Cold — send welcome template + call attempt in 4h';
    return 'New — send welcome template + schedule call today';
  }

  /* ---------- slide-over ---------- */
  function openSlideOver(l) {
    S.selectedId = l.id;
    closeSlideOver();
    const so = h('aside', { class: 'lv2-slideover', id: 'lv2-slideover' });
    const name = l.name || l.phone || '—';
    so.appendChild(h('div', { class: 'lv2-so-head' },
      h('div', { class: 'lv2-av', style: { background: avColor(name) } }, initials(name)),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, name),
        h('div', { class: 'sub' }, (l.phone ? '📞 ' + l.phone : '') + (l.email ? ' · 📧 ' + l.email : '') + ' · created ' + fmtRel(l.created_at))),
      h('div', { class: 'x', onclick: closeSlideOver }, '✕')));

    so.appendChild(h('div', { class: 'lv2-so-body' },
      // Quick actions
      h('div', { class: 'lv2-so-quick' },
        h('button', { onclick: () => doCall(l) }, h('span', { class: 'ic' }, '📞'), 'Call'),
        h('button', { onclick: () => doWaApi(l) }, h('span', { class: 'ic' }, '💬'), 'WA'),
        h('button', { onclick: () => doAddNote(l) }, h('span', { class: 'ic' }, '📝'), 'Note'),
        h('button', { onclick: () => doViewFull(l) }, h('span', { class: 'ic' }, '👁'), 'Open')),

      // AI Next Step
      h('div', { class: 'lv2-so-card ai' },
        h('h3', null, '✨ AI Suggested Next Step'),
        h('div', { class: 'txt' }, aiHint(l))),

      // Details
      h('div', { class: 'lv2-so-card' },
        h('h3', null, '📍 Details'),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Owner'), h('span', { class: 'v' }, l.assigned_name || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Status'), h('span', { class: 'v' }, l.status_name || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Source'), h('span', { class: 'v' }, l.source || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Follow-up'), h('span', { class: 'v' }, l.next_followup_at ? new Date(l.next_followup_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'AI Score'), h('span', { class: 'v' }, (l.smart_score || 0) + ' · ' + (l.smart_category || '—')))),

      // Notes
      l.notes ? h('div', { class: 'lv2-so-card' },
        h('h3', null, '📝 Notes / Remarks'),
        h('div', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', color: '#475569', lineHeight: '1.5' } }, String(l.notes).slice(0, 800))) : null
    ));
    document.body.appendChild(so);
  }
  function closeSlideOver() {
    const ex = document.getElementById('lv2-slideover');
    if (ex) ex.remove();
    S.selectedId = null;
  }

  /* ---------- actions ---------- */
  function doCall(l) { try { if (window.openCallModal) return window.openCallModal(l.id); } catch (_) {} window.location.href = 'tel:' + (l.phone || ''); }
  function doSim(l) { window.location.href = 'tel:' + (l.phone || ''); }
  function doWaWeb(l) { const ph = String(l.phone || '').replace(/\D/g, ''); window.open('https://wa.me/' + ph, '_blank'); }
  function doWaApi(l) { try { window.location.hash = '#/whatsbot/chat'; setTimeout(() => { try { window.openLeadModal && window.openLeadModal(l.id); } catch(_){} }, 400); } catch (_) {} }
  function aiHub(l) { try { if (window.LEAD_AI_HUB && window.LEAD_AI_HUB.open) return window.LEAD_AI_HUB.open(l.id); } catch (_) {} doViewFull(l); }
  function doCopy(l) { try { navigator.clipboard.writeText(l.phone || ''); toast('Phone copied', 'ok'); } catch (_) {} }
  function doAddNote(l) { doViewFull(l); }
  function doViewFull(l) { try { window.openLeadModal && window.openLeadModal(l.id); } catch (_) {} }

  function mountAiDrawer() {
    if (document.getElementById('lv2-ai-drawer')) return;
    const d = h('div', { class: 'lv2-ai-drawer', id: 'lv2-ai-drawer', onclick: () => toast('AI assistant — coming soon. Use ✨ on any lead for now.', 'ok') },
      h('span', { class: 'pulse' }), '✨ Ask SmartCRM AI');
    document.body.appendChild(d);
  }

  /* ====================================================================
   * INBOX (C3) RENDERER — two-pane (list left + detail right)
   * ==================================================================*/
  async function renderInbox(view) {
    injectStyles();
    if (!S.leads.length) await load();

    const wrap = h('div', { class: 'lv2-inbox' });
    const list = h('div', { class: 'lv2-inbox-list' });

    list.appendChild(h('div', { class: 'lv2-inbox-head' },
      h('div', { class: 'row1' }, h('h2', null, 'Leads'), h('span', { class: 'c' }, String(S.leads.length))),
      h('div', { class: 'search' },
        h('span', { style: { color: '#64748b' } }, '🔍'),
        h('input', { placeholder: 'Search…', value: S.search, oninput: (e) => { S.search = e.target.value; rerenderInboxRows(); } }))));

    const views = h('div', { class: 'lv2-inbox-views' });
    [['all','All'],['hot','🔥 Hot'],['overdue','⏰ Overdue'],['today','📅 Today'],['mine','⭐ Mine'],['new','🆕 New']].forEach(([k, lab]) => {
      views.appendChild(h('div', {
        class: 'v' + (S.filter === k ? ' active' : ''),
        onclick: () => { S.filter = k; renderInbox(view); }
      }, lab));
    });
    list.appendChild(views);

    const rowsHost = h('div', { class: 'lv2-inbox-rows', id: 'lv2-inbox-rows' });
    list.appendChild(rowsHost);

    const detail = h('div', { class: 'lv2-inbox-detail', id: 'lv2-inbox-detail' },
      h('div', { class: 'lv2-inbox-empty' }, h('div', { class: 'big' }, '📋'), h('div', null, 'Select a lead to see details')));

    wrap.appendChild(list);
    wrap.appendChild(detail);
    view.appendChild(wrap);

    rerenderInboxRows();
    mountAiDrawer();
  }
  function rerenderInboxRows() {
    const host = $('#lv2-inbox-rows');
    if (!host) return;
    host.innerHTML = '';
    const rows = filtered();
    if (!rows.length) {
      host.appendChild(h('div', { style: { padding: '30px', textAlign: 'center', color: '#94a3b8' } }, 'No leads'));
      return;
    }
    rows.slice(0, 200).forEach(l => host.appendChild(renderInboxRow(l)));
  }
  function renderInboxRow(l) {
    const name = l.name || l.phone || '—';
    const score = Number(l.smart_score || 0);
    const bucket = scoreBucket(score);
    const stat = statusClass(l.status_name);
    const isActive = S.selectedId === l.id;
    return h('div', {
      class: 'lv2-inbox-row' + (isActive ? ' active' : ''),
      onclick: () => { S.selectedId = l.id; rerenderInboxRows(); renderInboxDetail(l); }
    },
      h('div', { class: 'top' },
        h('div', { class: 'lv2-av s', style: { background: avColor(name) } }, initials(name)),
        h('span', { class: 'nm' }, name),
        h('span', { class: 'when' }, fmtRel(l.last_activity_at || l.created_at))),
      h('div', { class: 'meta' },
        h('span', { class: 'stagetag ' + stat }, (l.status_name || 'New').slice(0, 18)),
        h('span', null, (l.assigned_name || 'Unassigned') + (l.source ? ' · ' + l.source : ''))),
      h('div', { class: 'preview' }, l.notes ? String(l.notes).slice(0, 80) : '—'),
      score ? h('span', { class: 'score-mini ' + bucket }, String(score)) : null);
  }
  function renderInboxDetail(l) {
    const host = $('#lv2-inbox-detail');
    if (!host) return;
    host.innerHTML = '';
    const name = l.name || l.phone || '—';
    const score = Number(l.smart_score || 0);
    const bucket = scoreBucket(score);

    host.appendChild(h('div', { style: { padding: '16px 22px', background: 'white', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '14px' } },
      h('div', { class: 'lv2-av', style: { width: '48px', height: '48px', borderRadius: '12px', background: avColor(name), fontSize: '18px' } }, initials(name)),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontSize: '18px', fontWeight: '700', color: '#0f172a' } }, name,
          score ? h('span', { style: { fontSize: '10px', background: bucket === 'hot' ? '#fef2f2' : bucket === 'warm' ? '#fffbeb' : '#eff6ff', color: bucket === 'hot' ? '#b91c1c' : bucket === 'warm' ? '#b45309' : '#1e40af', padding: '2px 7px', borderRadius: '4px', fontWeight: '700', marginLeft: '8px' } }, score + ' · ' + (l.smart_category || bucket.toUpperCase())) : null),
        h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '2px' } }, (l.phone || '') + (l.email ? ' · ' + l.email : '') + ' · ' + (l.source || ''))),
      h('button', { style: { padding: '8px 14px', background: '#6366f1', color: 'white', border: 'none', borderRadius: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }, onclick: () => doViewFull(l) }, '✏ Open')));

    const body = h('div', { style: { flex: 1, overflowY: 'auto', padding: '20px 22px', display: 'grid', gridTemplateColumns: '1fr 280px', gap: '16px' } });
    const main = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } });

    main.appendChild(h('div', { class: 'lv2-so-card ai' },
      h('h3', null, '✨ AI Next Best Action'),
      h('div', { class: 'txt' }, aiHint(l)),
      h('button', { style: { marginTop: '10px', padding: '6px 12px', background: 'white', border: '1px solid #fcd34d', borderRadius: '6px', fontSize: '11px', fontWeight: '600', color: '#92400e', cursor: 'pointer' }, onclick: () => doWaApi(l) }, '✨ Open in chat →')));

    main.appendChild(h('div', { class: 'lv2-so-card' },
      h('h3', null, '⚡ Quick Actions'),
      h('div', { class: 'lv2-so-quick' },
        h('button', { onclick: () => doCall(l) }, h('span', { class: 'ic' }, '📞'), 'Call'),
        h('button', { onclick: () => doWaApi(l) }, h('span', { class: 'ic' }, '💬'), 'WA'),
        h('button', { onclick: () => doAddNote(l) }, h('span', { class: 'ic' }, '📝'), 'Note'),
        h('button', { onclick: () => doViewFull(l) }, h('span', { class: 'ic' }, '👁'), 'Open'))));

    if (l.notes) {
      main.appendChild(h('div', { class: 'lv2-so-card' },
        h('h3', null, '📝 Notes / Remarks'),
        h('div', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', color: '#475569', lineHeight: '1.5' } }, String(l.notes).slice(0, 1200))));
    }

    const side = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
      h('div', { class: 'lv2-so-card' },
        h('h3', null, '📍 Details'),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Owner'), h('span', { class: 'v' }, l.assigned_name || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Status'), h('span', { class: 'v' }, l.status_name || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Source'), h('span', { class: 'v' }, l.source || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Phone'), h('span', { class: 'v' }, l.phone || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Email'), h('span', { class: 'v', style: { fontSize: '11px' } }, l.email || '—')),
        h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Follow-up'), h('span', { class: 'v' }, l.next_followup_at ? new Date(l.next_followup_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'))));

    body.appendChild(main);
    body.appendChild(side);
    host.appendChild(body);
  }

  /* ====================================================================
   * SEGMENT TOGGLE — Classic | Modern | Inbox
   * ==================================================================*/
  function createToggle(onChange) {
    const current = localStorage.getItem('crm.leadsViewStyle') || 'classic';
    S.style = current;
    const tog = h('div', { class: 'lv2-toggle' });
    [['classic','📋 Classic'],['modern','✨ Modern'],['inbox','📬 Inbox']].forEach(([k, lab]) => {
      tog.appendChild(h('button', {
        class: current === k ? 'active' : '',
        onclick: () => {
          localStorage.setItem('crm.leadsViewStyle', k);
          S.style = k;
          if (typeof onChange === 'function') onChange(k);
          else location.reload();
        }
      }, lab));
    });
    return tog;
  }

  /* ====================================================================
   * Public API
   * ==================================================================*/
  window.LEADS_V2 = {
    getStyle: () => localStorage.getItem('crm.leadsViewStyle') || 'classic',
    setStyle: (s) => { localStorage.setItem('crm.leadsViewStyle', s); S.style = s; },
    renderModern: async (viewEl) => { await renderModern(viewEl); },
    renderInbox:  async (viewEl) => { await renderInbox(viewEl); },
    createToggle,
    closeSlideOver,
    load
  };
})();
