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
    leads: [], statuses: [], users: [], sources: [], tags: [], campaigns: [],
    // Quick chip filter
    filter: 'all',
    // Status segment chip (the row of NEW/NP/FOLLOWUP/etc at the top)
    statusChip: 'all',
    // Search string
    search: '',
    // Multi-select dropdown filters
    // v1.3 — multi-select filters (arrays); empty array = no filter
    fStatus: [],     // array of status_ids
    fSource: [],     // array of source names
    fOwner:  [],     // array of user_ids
    fTag:    [],
    fCampaign: [],
    fScore:  [],     // ['hot','warm','cold']
    fFollowup: '',   // single: 'overdue' | 'today' | 'week' | 'none' | ''
    fQualified: '',  // single: 'yes' | 'no' | ''
    fDateFrom: '',
    fDateTo: '',
    fDatePreset: '', // 'today' | 'yesterday' | '7d' | '30d' | 'all' | ''
    // v1.5 — pagination
    page: 1,
    pageSize: Number(localStorage.getItem('crm.lv2.pageSize')) || 25,
    // Active row in detail panel
    selectedId: null,
    style: 'classic',
    // v1.3 — Focus mode (hide chrome) + collapsibles + saved views
    focusMode: localStorage.getItem('crm.lv2.focus') === '1',
    // v3.7 — both collapsed by default. Use sessionStorage so a page
    // refresh ALWAYS starts collapsed (only stays open within the same
    // tab session), matching user expectation that headers auto-close
    // on refresh / new page.
    chipsCollapsed: sessionStorage.getItem('crm.lv2.chipsCollapsed') !== '0',
    filtersCollapsed: sessionStorage.getItem('crm.lv2.filtersCollapsed') !== '0',
    visibleColumns: (function(){ try { return JSON.parse(localStorage.getItem('crm.lv2.visibleColumns')) || ['phone','source','status','owner','score','aistep','activity','created']; } catch(_) { return ['phone','source','status','owner','score','aistep','activity','created']; } })(),
    visibleFilters: (function(){ try { return JSON.parse(localStorage.getItem('crm.lv2.visibleFilters')) || ['status','source','owner','score','tag','campaign','followup','qualified']; } catch(_) { return ['status','source','owner','score','tag','campaign','followup','qualified']; } })(),
    savedViews: (function(){ try { return JSON.parse(localStorage.getItem('crm.lv2.savedViews')) || []; } catch(_) { return []; } })()
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
  // v3.10 — Standard date+time+relative format: "20 Jun, 2:58 PM (1d)"
  // Used everywhere we need user-friendly absolute timestamps. The
  // relative part keeps the at-a-glance recency, the absolute part
  // gives precision when scanning columns or hovering rows.
  function fmtDateTimeRel(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return String(iso);
    const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    const timePart = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    const rel = fmtRel(iso);
    return datePart + ', ' + timePart + (rel ? ' (' + rel + ')' : '');
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
    // v3.4 — clean up any stale Ask-AI pill from previous versions
    try { var ex = document.getElementById('lv2-ai-drawer'); if (ex) ex.remove(); } catch (_) {}
    if (document.getElementById('lv2-styles')) return;
    const css = `
.lv2-toggle { display: inline-flex; background: #f1f5f9; border-radius: 8px; padding: 3px; gap: 1px; margin: 0 8px; }
.lv2-toggle button { padding: 5px 12px; border: none; background: transparent; cursor: pointer; color: #64748b; font-size: 11.5px; font-weight: 500; border-radius: 6px; display: flex; align-items: center; gap: 5px; }
.lv2-toggle button:hover { color: #0f172a; }
.lv2-toggle button.active { background: white; color: #0f172a; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.06); }

/* ===== MODERN (A3) STYLES ===== */
.lv2-modern { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; margin-top: 10px; display: flex; flex-direction: column; height: calc(100vh - 100px); }
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

.lv2-modern .tbl-wrap { flex: 1; overflow: auto; background: white; min-height: 0; }
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
/* v3.15 — DRAMATIC theme system. Each theme repaints: page bg, hero card,
   table header, avatars (rings), name color, status pills, score chips, row
   bucket tints, hover states, qchip active, filter pills, bulk bar accent,
   action button gradients. Theme switch transitions over 0.25s. */

/* Universal smooth transition on theme-affected props */
.lv2-wrap, .lv2-hero, .lv2-tbl tr, .lv2-av, .lv2-scorechip, .qchip, .lv2-act,
.lv2-tbl thead th, .lv2-namestack .lv2-nm {
  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease !important;
}

/* ═══════════════════════ EMERALD ═══════════════════════ */
body.lv2-theme-emerald .lv2-wrap { background: linear-gradient(180deg, #f0fdf4 0%, #ffffff 200px) !important; }
body.lv2-theme-emerald .lv2-hero { background: linear-gradient(135deg, #d1fae5, #ecfdf5, #ffffff) !important; border-color: #6ee7b7 !important; }
body.lv2-theme-emerald .lv2-hero .num { color: #047857 !important; }
body.lv2-theme-emerald .lv2-hero .lab { color: #065f46 !important; }
body.lv2-theme-emerald .lv2-tbl thead th { background: linear-gradient(180deg, #d1fae5, #ecfdf5) !important; color: #065f46 !important; border-bottom: 2px solid #10b981 !important; }
body.lv2-theme-emerald .lv2-namestack .lv2-nm { color: #064e3b !important; }
body.lv2-theme-emerald .lv2-tbl tr.bucket-hot { background: linear-gradient(90deg, #ecfdf5, transparent) !important; border-left: 3px solid #10b981 !important; }
body.lv2-theme-emerald .lv2-tbl tr.bucket-warm { background: linear-gradient(90deg, #f0fdf4, transparent) !important; }
body.lv2-theme-emerald .lv2-tbl tr:hover { background: #d1fae5 !important; }
body.lv2-theme-emerald .lv2-scorechip.hot { background: #10b981 !important; color: white !important; border-color: #047857 !important; }
body.lv2-theme-emerald .lv2-scorechip.warm { background: #6ee7b7 !important; color: #065f46 !important; border-color: #10b981 !important; }
body.lv2-theme-emerald .lv2-scorechip.cold { background: #ecfdf5 !important; color: #047857 !important; border-color: #a7f3d0 !important; }
body.lv2-theme-emerald .qchip.active { background: linear-gradient(135deg, #10b981, #34d399) !important; color: white !important; border-color: #10b981 !important; box-shadow: 0 2px 8px rgba(16,185,129,.4) !important; }
body.lv2-theme-emerald .lv2-act.api { background: linear-gradient(135deg, #10b981, #34d399) !important; color: white !important; box-shadow: 0 1px 3px rgba(16,185,129,.4) !important; }
body.lv2-theme-emerald .lv2-act.ai { background: linear-gradient(135deg, #047857, #059669) !important; color: white !important; }
body.lv2-theme-emerald .lv2-av { box-shadow: 0 0 0 3px #d1fae5 !important; }
body.lv2-theme-emerald #lv2-bulkbar { background: linear-gradient(135deg, #047857, #065f46) !important; box-shadow: 0 10px 30px rgba(4,120,87,.4) !important; }

/* ═══════════════════════ SUNSET ═══════════════════════ */
body.lv2-theme-sunset .lv2-wrap { background: linear-gradient(180deg, #fff7ed 0%, #ffffff 200px) !important; }
body.lv2-theme-sunset .lv2-hero { background: linear-gradient(135deg, #fed7aa, #fff7ed, #ffffff) !important; border-color: #fb923c !important; }
body.lv2-theme-sunset .lv2-hero .num { color: #c2410c !important; }
body.lv2-theme-sunset .lv2-hero .lab { color: #9a3412 !important; }
body.lv2-theme-sunset .lv2-tbl thead th { background: linear-gradient(180deg, #fed7aa, #fff7ed) !important; color: #9a3412 !important; border-bottom: 2px solid #f97316 !important; }
body.lv2-theme-sunset .lv2-namestack .lv2-nm { color: #7c2d12 !important; }
body.lv2-theme-sunset .lv2-tbl tr.bucket-hot { background: linear-gradient(90deg, #ffedd5, transparent) !important; border-left: 3px solid #f97316 !important; }
body.lv2-theme-sunset .lv2-tbl tr.bucket-warm { background: linear-gradient(90deg, #fff7ed, transparent) !important; }
body.lv2-theme-sunset .lv2-tbl tr:hover { background: #fed7aa !important; }
body.lv2-theme-sunset .lv2-scorechip.hot { background: #f97316 !important; color: white !important; border-color: #c2410c !important; }
body.lv2-theme-sunset .lv2-scorechip.warm { background: #fdba74 !important; color: #9a3412 !important; border-color: #fb923c !important; }
body.lv2-theme-sunset .lv2-scorechip.cold { background: #fff7ed !important; color: #c2410c !important; border-color: #fed7aa !important; }
body.lv2-theme-sunset .qchip.active { background: linear-gradient(135deg, #f97316, #fb923c) !important; color: white !important; border-color: #f97316 !important; box-shadow: 0 2px 8px rgba(249,115,22,.4) !important; }
body.lv2-theme-sunset .lv2-act.api { background: linear-gradient(135deg, #f97316, #fb923c) !important; color: white !important; }
body.lv2-theme-sunset .lv2-act.ai { background: linear-gradient(135deg, #c2410c, #ea580c) !important; color: white !important; }
body.lv2-theme-sunset .lv2-av { box-shadow: 0 0 0 3px #fed7aa !important; }
body.lv2-theme-sunset #lv2-bulkbar { background: linear-gradient(135deg, #c2410c, #9a3412) !important; box-shadow: 0 10px 30px rgba(194,65,12,.4) !important; }

/* ═══════════════════════ ROSE ═══════════════════════ */
body.lv2-theme-rose .lv2-wrap { background: linear-gradient(180deg, #fff1f2 0%, #ffffff 200px) !important; }
body.lv2-theme-rose .lv2-hero { background: linear-gradient(135deg, #fecdd3, #fff1f2, #ffffff) !important; border-color: #fb7185 !important; }
body.lv2-theme-rose .lv2-hero .num { color: #be123c !important; }
body.lv2-theme-rose .lv2-hero .lab { color: #9f1239 !important; }
body.lv2-theme-rose .lv2-tbl thead th { background: linear-gradient(180deg, #fecdd3, #fff1f2) !important; color: #9f1239 !important; border-bottom: 2px solid #e11d48 !important; }
body.lv2-theme-rose .lv2-namestack .lv2-nm { color: #881337 !important; }
body.lv2-theme-rose .lv2-tbl tr.bucket-hot { background: linear-gradient(90deg, #ffe4e6, transparent) !important; border-left: 3px solid #e11d48 !important; }
body.lv2-theme-rose .lv2-tbl tr.bucket-warm { background: linear-gradient(90deg, #fff1f2, transparent) !important; }
body.lv2-theme-rose .lv2-tbl tr:hover { background: #fecdd3 !important; }
body.lv2-theme-rose .lv2-scorechip.hot { background: #e11d48 !important; color: white !important; border-color: #9f1239 !important; }
body.lv2-theme-rose .lv2-scorechip.warm { background: #fda4af !important; color: #9f1239 !important; border-color: #fb7185 !important; }
body.lv2-theme-rose .lv2-scorechip.cold { background: #fff1f2 !important; color: #be123c !important; border-color: #fecdd3 !important; }
body.lv2-theme-rose .qchip.active { background: linear-gradient(135deg, #e11d48, #f43f5e) !important; color: white !important; border-color: #e11d48 !important; box-shadow: 0 2px 8px rgba(225,29,72,.4) !important; }
body.lv2-theme-rose .lv2-act.api { background: linear-gradient(135deg, #e11d48, #f43f5e) !important; color: white !important; }
body.lv2-theme-rose .lv2-act.ai { background: linear-gradient(135deg, #9f1239, #be123c) !important; color: white !important; }
body.lv2-theme-rose .lv2-av { box-shadow: 0 0 0 3px #ffe4e6 !important; }
body.lv2-theme-rose #lv2-bulkbar { background: linear-gradient(135deg, #be123c, #881337) !important; box-shadow: 0 10px 30px rgba(190,18,60,.4) !important; }

/* ═══════════════════════ MONO ═══════════════════════ */
body.lv2-theme-mono .lv2-wrap { background: #f8fafc !important; }
body.lv2-theme-mono .lv2-hero { background: linear-gradient(135deg, #e2e8f0, #f8fafc, #ffffff) !important; border-color: #94a3b8 !important; }
body.lv2-theme-mono .lv2-hero .num { color: #0f172a !important; }
body.lv2-theme-mono .lv2-hero .lab { color: #475569 !important; }
body.lv2-theme-mono .lv2-tbl thead th { background: linear-gradient(180deg, #e2e8f0, #f1f5f9) !important; color: #0f172a !important; border-bottom: 2px solid #0f172a !important; }
body.lv2-theme-mono .lv2-namestack .lv2-nm { color: #0f172a !important; font-weight: 600; }
body.lv2-theme-mono .lv2-tbl tr.bucket-hot, body.lv2-theme-mono .lv2-tbl tr.bucket-warm, body.lv2-theme-mono .lv2-tbl tr.bucket-cold { background: white !important; }
body.lv2-theme-mono .lv2-tbl tr.bucket-hot { border-left: 3px solid #0f172a !important; }
body.lv2-theme-mono .lv2-tbl tr:hover { background: #f1f5f9 !important; }
body.lv2-theme-mono .lv2-scorechip.hot, body.lv2-theme-mono .lv2-scorechip.warm, body.lv2-theme-mono .lv2-scorechip.cold { background: #f1f5f9 !important; color: #0f172a !important; border-color: #cbd5e1 !important; }
body.lv2-theme-mono .qchip.active { background: #0f172a !important; color: white !important; border-color: #0f172a !important; box-shadow: 0 2px 8px rgba(15,23,42,.4) !important; }
body.lv2-theme-mono .lv2-act.api { background: #0f172a !important; color: white !important; }
body.lv2-theme-mono .lv2-act.ai { background: #334155 !important; color: white !important; }
body.lv2-theme-mono .lv2-av { box-shadow: 0 0 0 3px #e2e8f0 !important; filter: grayscale(.5); }
body.lv2-theme-mono #lv2-bulkbar { background: #0f172a !important; }

/* ═══════════════════════ DEFAULT (Indigo) — explicit so theme switch always wins ═══════════════════════ */
body.lv2-theme-default .lv2-wrap { background: linear-gradient(180deg, #eef2ff 0%, #ffffff 200px) !important; }
body.lv2-theme-default .lv2-hero { background: linear-gradient(135deg, #ddd6fe, #eef2ff, #ffffff) !important; border-color: #a5b4fc !important; }
body.lv2-theme-default .lv2-hero .num { color: #4338ca !important; }
body.lv2-theme-default .lv2-tbl thead th { background: linear-gradient(180deg, #ddd6fe, #eef2ff) !important; color: #3730a3 !important; border-bottom: 2px solid #6366f1 !important; }
body.lv2-theme-default .lv2-namestack .lv2-nm { color: #1e1b4b !important; }
body.lv2-theme-default .lv2-tbl tr.bucket-hot { background: linear-gradient(90deg, #eef2ff, transparent) !important; border-left: 3px solid #6366f1 !important; }
body.lv2-theme-default .lv2-tbl tr:hover { background: #ede9fe !important; }
body.lv2-theme-default .lv2-scorechip.hot { background: #6366f1 !important; color: white !important; border-color: #4338ca !important; }
body.lv2-theme-default .qchip.active { background: linear-gradient(135deg, #4338ca, #6366f1) !important; color: white !important; border-color: #4338ca !important; box-shadow: 0 2px 8px rgba(67,56,202,.4) !important; }
body.lv2-theme-default .lv2-act.api { background: linear-gradient(135deg, #4338ca, #6366f1) !important; color: white !important; }
body.lv2-theme-default .lv2-act.ai { background: linear-gradient(135deg, #3730a3, #4338ca) !important; color: white !important; }
body.lv2-theme-default .lv2-av { box-shadow: 0 0 0 3px #ddd6fe !important; }
body.lv2-theme-default #lv2-bulkbar { background: linear-gradient(135deg, #4338ca, #3730a3) !important; box-shadow: 0 10px 30px rgba(67,56,202,.4) !important; }

.lv2-badges { display: flex; gap: 3px; align-items: center; }
.lv2-badge { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; }
.lv2-badge.ai { background: linear-gradient(135deg, #fef3c7, #fde68a); color: #92400e; cursor: pointer; }
.lv2-badge.fire { background: linear-gradient(135deg, #fee2e2, #fef3c7); color: #b91c1c; }

.lv2-phonecell { display: flex; align-items: center; gap: 6px; }
.lv2-ph { font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 14px; font-weight: 500; color: #0f172a; letter-spacing: .2px; }
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
.lv2-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.lv2-dot.new { background: #22c55e; } .lv2-dot.hot { background: #ef4444; } .lv2-dot.warm { background: #f59e0b; } .lv2-dot.cold { background: #3b82f6; } .lv2-dot.demo { background: #a855f7; } .lv2-dot.proposal { background: #06b6d4; } .lv2-dot.done { background: #10b981; } .lv2-dot.lost { background: #6b7280; } .lv2-dot.fresh { background: #22c55e; }
.lv2-stext { font-size: 14px; font-weight: 500; color: #1e293b; }

.lv2-scorecell { display: flex; align-items: center; gap: 8px; }
.lv2-scorenum { font-size: 13px; font-weight: 700; }
.lv2-scorenum.hot { color: #b91c1c; } .lv2-scorenum.warm { color: #b45309; } .lv2-scorenum.cold { color: #1e40af; }
/* v1.9 — Bold score chip + row bucket accent (no more sparkline) */
.lv2-scorechip { font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 12px; letter-spacing: .3px; white-space: nowrap; display: inline-block; }
.lv2-scorechip.hot  { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
.lv2-scorechip.warm { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }
.lv2-scorechip.cold { background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
.lv2-modern tbody tr.bucket-hot  td.sticky-l { box-shadow: inset 3px 0 0 #ef4444; }
.lv2-modern tbody tr.bucket-warm td.sticky-l { box-shadow: inset 3px 0 0 #f59e0b; }
.lv2-modern tbody tr.bucket-cold td.sticky-l { box-shadow: inset 3px 0 0 #3b82f6; }
.lv2-modern tbody tr.bucket-hot:hover  td { background: #fff5f5; }
.lv2-modern tbody tr.bucket-hot:hover  td.sticky-l { background: #fff5f5; }
.lv2-modern tbody tr.bucket-warm:hover td { background: #fffbeb; }
.lv2-modern tbody tr.bucket-warm:hover td.sticky-l { background: #fffbeb; }

.lv2-aisum { font-size: 11.5px; color: #6b21a8; max-width: 240px; line-height: 1.3; }
.lv2-aisum::before { content: '✨ '; }

.lv2-muted { color: #94a3b8; font-size: 12px; }

/* SLIDE-OVER detail panel */
.lv2-slideover { position: fixed; top: 56px; right: 0; width: 460px; height: calc(100vh - 56px); background: white; border-left: 1px solid #e2e8f0; box-shadow: -10px 0 30px rgba(0,0,0,.06); z-index: 990; display: flex; flex-direction: column; animation: lv2slide .2s ease-out; }
.lv2-slideover.bucket-hot  { border-left: 4px solid #ef4444; }
.lv2-slideover.bucket-warm { border-left: 4px solid #f59e0b; }
.lv2-slideover.bucket-cold { border-left: 4px solid #3b82f6; }
.lv2-slideover .lv2-so-head.bucket-hot  { background: linear-gradient(to bottom, #fef2f2, white); }
.lv2-slideover .lv2-so-head.bucket-warm { background: linear-gradient(to bottom, #fffbeb, white); }
.lv2-slideover .lv2-so-head.bucket-cold { background: linear-gradient(to bottom, #eff6ff, white); }
@keyframes lv2spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
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
      /* LEADS_V2_HEADER_v4 (2026-06-27) — fetch brand fresh BEFORE first render so
         the LEADS_V2_HEADER_V4_ENABLED flag is available to _headerV4Enabled().
         Without this, CRM.brand / CRM._earlyBrand are empty on first paint and
         the new compact header never activates. Same race we fixed for WB_CHAT_V2. */
      const [leads, statuses, users, sources, tags, campaigns, brand] = await Promise.all([
        api('api_leads_list', { page_size: 500 }).catch(() => []),
        api('api_statuses_list').catch(() => []),
        api('api_users_list').catch(() => []),
        api('api_sources_list').catch(() => []),
        api('api_leads_distinctTags').catch(() => []),
        api('api_campaigns_list').catch(() => []),
        api('api_admin_brand').catch(() => null)
      ]);
      if (brand && typeof brand === 'object') {
        try {
          window.CRM = window.CRM || {};
          CRM.brand = Object.assign(CRM.brand || {}, brand);
          CRM._earlyBrand = Object.assign(CRM._earlyBrand || {}, brand);
          if (brand.LEADS_V2_HEADER_V4_ENABLED === '1') _v4HdrFlagCached = '1';
        } catch (_) {}
      }
      // api_leads_list returns { leads, total, page, page_size, status_count }
      // — handle that shape PLUS fall back to direct array / .rows for safety.
      S.leads = (leads && Array.isArray(leads.leads)) ? leads.leads
              : (Array.isArray(leads) ? leads
              : (leads && Array.isArray(leads.rows)) ? leads.rows
              : []);
      console.log('[LEADS_V2] loaded', S.leads.length, 'leads · statuses:', S.statuses.length, '· users:', S.users.length, '· sources:', S.sources.length, '· tags:', S.tags.length, '· campaigns:', S.campaigns.length);
      // Shape-tolerant unwrap: each endpoint may return an array directly,
      // an object with .rows / .items / .leads / .campaigns / etc., or null.
      const _asArray = (v, key) => {
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') {
          if (Array.isArray(v[key])) return v[key];
          if (Array.isArray(v.rows)) return v.rows;
          if (Array.isArray(v.items)) return v.items;
          if (Array.isArray(v.list)) return v.list;
        }
        return [];
      };
      S.statuses  = _asArray(statuses,  'statuses');
      S.users     = _asArray(users,     'users');
      S.sources   = _asArray(sources,   'sources');
      S.tags      = _asArray(tags,      'tags');
      S.campaigns = _asArray(campaigns, 'campaigns');

      // v3.4 — populate last_wa_message per lead by joining
      // api_wb_chat_threads (phone-keyed) so the Last WhatsApp column
      // shows real data instead of '—'.
      try {
        const threads = await api('api_wb_chat_threads', { scanLimit: 10000, show_all: true }).catch(() => []);
        const arr = _asArray(threads, 'threads');
        const byPhone = {};
        arr.forEach(function (t) {
          if (!t.phone) return;
          const k = String(t.phone).replace(/\D/g, '').slice(-10);
          if (!byPhone[k]) byPhone[k] = t;
        });
        // v3.12 — Only surface ACTUAL WhatsApp conversation, not the auto-sent
        // welcome template. Three rules: (a) only attach if customer was last to
        // message (last_direction='in') OR there are unread messages, OR
        // (b) the last message body doesn't look like an auto-template (short
        // & doesn't start with 'Auto Lead Capture'). Otherwise leave the
        // column blank — user wants 'blank when there is no WhatsApp'.
        S.leads.forEach(function (l) {
          if (!l.phone) return;
          const k = String(l.phone).replace(/\D/g, '').slice(-10);
          const t = byPhone[k];
          if (!t) return;
          const msg = String(t.last_message || t.last_message_preview || '').trim();
          const isAutoTemplate = /Auto Lead Capture/i.test(msg) || msg.length > 220;
          const hasRealConvo = (t.last_direction === 'in') || Number(t.unread || t.unread_count || 0) > 0 || !isAutoTemplate;
          if (hasRealConvo && msg) {
            l.last_wa_message = msg;
            l.last_wa_at = t.last_at || t.last_activity_at || t.last_msg_at || t.updated_at;
            l.last_wa_direction = t.last_direction || '';
          }
        });
        console.log('[LEADS_V2] joined', arr.length, 'WA threads onto', S.leads.length, 'leads');
      } catch (e) { console.warn('[LEADS_V2] WA thread join failed:', e.message); }
    } catch (e) {
      toast('Could not load leads: ' + e.message, 'err');
    }
  }

  function filtered() {
    const meId = (window.CRM && CRM.user && CRM.user.id) || null;
    const q = String(S.search || '').toLowerCase().trim();
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekEnd = new Date(today0); weekEnd.setDate(weekEnd.getDate() + 7);
    return (S.leads || []).filter(l => {
      // Quick chip
      if (S.filter === 'hot' && Number(l.smart_score || 0) < 80) return false;
      if (S.filter === 'overdue') {
        if (!l.next_followup_at) return false;
        if (new Date(l.next_followup_at) > now) return false;
      }
      if (S.filter === 'today') {
        if (!l.next_followup_at) return false;
        const d = new Date(l.next_followup_at);
        if (d.toDateString() !== now.toDateString()) return false;
      }
      if (S.filter === 'mine' && meId && Number(l.assigned_to) !== Number(meId)) return false;
      if (S.filter === 'new' && !/new|fresh/i.test(l.status_name || '')) return false;
      // Status chip row (matches Classic chips)
      if (S.statusChip && S.statusChip !== 'all') {
        const sn = String(l.status_name || '').toLowerCase();
        const target = String(S.statusChip).toLowerCase();
        if (sn !== target) return false;
      }
      // v1.3 — array filters: match if ANY selected value matches
      const hasAny = (arr) => Array.isArray(arr) && arr.length > 0;
      if (hasAny(S.fStatus) && !S.fStatus.map(String).includes(String(l.status_id))) return false;
      if (hasAny(S.fSource)) {
        const sn = String(l.source || '').toLowerCase();
        if (!S.fSource.map(s => String(s).toLowerCase()).includes(sn)) return false;
      }
      if (hasAny(S.fOwner) && !S.fOwner.map(String).includes(String(l.assigned_to))) return false;
      if (hasAny(S.fTag)) {
        const t = String(l.tags || '').toLowerCase();
        if (!S.fTag.some(tag => t.indexOf(String(tag).toLowerCase()) >= 0)) return false;
      }
      if (hasAny(S.fCampaign)) {
        const cv = String(l.campaign_id || l.campaign_name || '').toLowerCase();
        if (!S.fCampaign.some(c => cv.indexOf(String(c).toLowerCase()) >= 0)) return false;
      }
      if (hasAny(S.fScore)) {
        const sc = Number(l.smart_score || 0);
        const bucket = sc >= 80 ? 'hot' : sc >= 50 ? 'warm' : sc > 0 ? 'cold' : '';
        if (!S.fScore.includes(bucket)) return false;
      }
      // Follow-up state
      if (S.fFollowup === 'overdue') {
        if (!l.next_followup_at) return false;
        if (new Date(l.next_followup_at) > now) return false;
      } else if (S.fFollowup === 'today') {
        if (!l.next_followup_at) return false;
        if (new Date(l.next_followup_at).toDateString() !== now.toDateString()) return false;
      } else if (S.fFollowup === 'week') {
        if (!l.next_followup_at) return false;
        const d = new Date(l.next_followup_at);
        if (d < today0 || d > weekEnd) return false;
      } else if (S.fFollowup === 'none') {
        if (l.next_followup_at) return false;
      }
      // Qualified
      if (S.fQualified === 'yes' && !l.qualified) return false;
      if (S.fQualified === 'no' && l.qualified) return false;
      // Date range (created_at)
      if (S.fDateFrom && new Date(l.created_at) < new Date(S.fDateFrom)) return false;
      if (S.fDateTo) {
        const dTo = new Date(S.fDateTo); dTo.setHours(23, 59, 59);
        if (new Date(l.created_at) > dTo) return false;
      }
      // Search — LEADS_SEARCH_WIDEN_v1 (2026-06-21): widened to remark,
      // city, state, company, address, source, campaign and description.
      if (q) {
        const hay = (
          (l.name || '') + ' ' +
          (l.phone || '') + ' ' +
          (l.whatsapp || '') + ' ' +
          (l.email || '') + ' ' +
          (l.notes || '') + ' ' +
          (l.recent_remark || '') + ' ' +
          (l.tags || '') + ' ' +
          (l.description || '') + ' ' +
          (l.city || '') + ' ' +
          (l.state || '') + ' ' +
          (l.company || '') + ' ' +
          (l.address || '') + ' ' +
          (l.source || '') + ' ' +
          (l.campaign_name || '') + ' ' +
          (l.campaign_id || '') + ' ' +
          (l.form_name || '')
        ).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  /* ---------- shared status chips + filter bar (used by Modern + Inbox) ---------- */
  /* LEADS_V2_HEADER_v4 — Option C compact sticky header.
   * One-row layout: title+count, search, inline chips (Hot/Overdue/Due today/New/Mine
   * with counts), divider, Status/Date/Owner dropdowns, Filters(N) popover, Refresh +
   * New Lead + ⋮ on right. Sticks to top on scroll. Activated by tenant config
   * LEADS_V2_HEADER_V4_ENABLED='1' (auto-set on vserve). Falls back to the legacy
   * 3-row header otherwise.
   */
  /* Module-level cache so flag survives CRM.brand being reset between renders. */
  let _v4HdrFlagCached = null;
  function _headerV4Enabled() {
    try {
      if (_v4HdrFlagCached === '1') return true;
      const C = window.CRM || {};
      const b = (C.brand || C._earlyBrand || {});
      const v = String(b.LEADS_V2_HEADER_V4_ENABLED || '');
      if (v === '1') { _v4HdrFlagCached = '1'; return true; }
      // Async hydrate-and-re-render fallback (no await — best effort on next render)
      if (_v4HdrFlagCached === null && typeof api === 'function') {
        _v4HdrFlagCached = 'fetching';
        api('api_admin_brand').then(r => {
          if (r && r.LEADS_V2_HEADER_V4_ENABLED === '1') {
            _v4HdrFlagCached = '1';
            try {
              window.CRM = window.CRM || {};
              CRM.brand = Object.assign(CRM.brand || {}, r);
              CRM._earlyBrand = Object.assign(CRM._earlyBrand || {}, r);
              const v = document.getElementById('view');
              if (v && S.style === 'modern') renderModern(v);
            } catch (_) {}
          } else {
            _v4HdrFlagCached = '0';
          }
        }).catch(() => { _v4HdrFlagCached = '0'; });
      }
      return false;
    } catch (_) { return false; }
  }

  // ---- Popover for "+ More filters" (reuses existing buildFilterBar inside a panel) ----
  function _openMoreFiltersPopover(anchorEl, onChange) {
    try {
      // Close any existing popover
      const ex = document.getElementById('lv2-mfilters-pop');
      if (ex) { ex.remove(); return; }
      const rect = anchorEl.getBoundingClientRect();
      const pop = h('div', {
        id: 'lv2-mfilters-pop',
        style: {
          position: 'fixed', top: (rect.bottom + 6) + 'px', right: '12px',
          width: 'min(720px, calc(100vw - 24px))', maxHeight: '70vh', overflow: 'auto',
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px',
          boxShadow: '0 10px 30px rgba(0,0,0,.18)', zIndex: '1000', padding: '0'
        }
      });
      // Force filter bar open inside the popover
      const prev = S.filtersCollapsed;
      S.filtersCollapsed = false;
      pop.appendChild(buildFilterBar(onChange));
      S.filtersCollapsed = prev;
      // Close-on-outside-click
      const closer = (ev) => {
        if (ev.target.closest && ev.target.closest('#lv2-mfilters-pop')) return;
        if (ev.target.closest && ev.target.closest('#lv2-mfilters-btn')) return;
        try { pop.remove(); } catch(_){}
        document.removeEventListener('mousedown', closer, true);
      };
      setTimeout(() => document.addEventListener('mousedown', closer, true), 50);
      document.body.appendChild(pop);
    } catch (e) { console.error('[LEADS_V2_HEADER_v4] popover failed:', e); }
  }

  function buildCompactHeader(onChange) {
    try {
      // Count chips
      const total = (Array.isArray(S.leads) ? S.leads : []).length;
      const _heat = (l) => Number(l && l.smart_score || 0);
      const hot = (S.leads || []).filter(l => _heat(l) >= 80).length;
      const overdue = (S.leads || []).filter(l => {
        if (!l.next_followup_at) return false;
        try { return new Date(l.next_followup_at).getTime() < Date.now(); } catch (_) { return false; }
      }).length;
      const todayStr = (() => { const d = new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
      const dueToday = (S.leads || []).filter(l => l.next_followup_at && String(l.next_followup_at).slice(0,10) === todayStr).length;
      const _myId = (window.CRM && CRM.user && CRM.user.id) || 0;
      const mine = (S.leads || []).filter(l => Number(l.assigned_to) === Number(_myId)).length;
      const newCnt = (S.leads || []).filter(l => l.status_name && /new/i.test(l.status_name)).length;

      const wrap = h('div', {
        id: 'lv2-compact-hdr',
        style: {
          position: 'sticky', top: '0', zIndex: '40',
          background: '#fff', borderBottom: '1px solid #e2e8f0',
          padding: '9px 14px', display: 'flex', alignItems: 'center', gap: '6px',
          flexWrap: 'wrap', overflowX: 'auto', boxShadow: '0 1px 3px rgba(0,0,0,.03)'
        }
      });

      // Title + badge
      wrap.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: '700', fontSize: '14px', whiteSpace: 'nowrap', color: '#0f172a' } },
        'Leads',
        h('span', { style: { background: '#dbeafe', color: '#1e40af', padding: '1px 8px', borderRadius: '999px', fontSize: '10.5px', fontWeight: '700' } }, String(total))));

      // Search
      const search = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '7px', minWidth: '160px', maxWidth: '220px', flexShrink: '1' } },
        h('span', { style: { color: '#94a3b8', fontSize: '11px' } }, '🔍'),
        h('input', {
          placeholder: 'Search…', value: S.search,
          style: { border: 'none', background: 'transparent', outline: 'none', fontSize: '12px', width: '100%', minWidth: '0', color: '#0f172a' },
          oninput: (e) => { S.search = e.target.value; if (onChange) onChange(); }
        }));
      wrap.appendChild(search);

      // Inline chips
      const _chip = (key, lab, count, accent) => {
        const on = S.filter === key;
        return h('span', {
          style: {
            display: 'inline-flex', alignItems: 'center', gap: '5px',
            padding: '4px 10px', borderRadius: '999px',
            background: on ? accent.bg : '#f8fafc',
            border: '1px solid ' + (on ? accent.bd : '#e2e8f0'),
            color: on ? accent.fg : '#475569',
            fontSize: '11.5px', fontWeight: on ? '700' : '500', cursor: 'pointer', whiteSpace: 'nowrap'
          },
          onclick: () => { S.filter = on ? 'all' : key; if (onChange) onChange(); }
        },
          lab,
          h('span', { style: { background: on ? 'rgba(255,255,255,.55)' : '#e2e8f0', color: on ? accent.fg : '#475569', fontSize: '10px', fontWeight: '700', padding: '1px 6px', borderRadius: '8px' } }, String(count)));
      };
      wrap.appendChild(_chip('hot',     '🔥 Hot',     hot,     { bg: '#fef2f2', fg: '#b91c1c', bd: '#fecaca' }));
      wrap.appendChild(_chip('overdue', '⏱',         overdue, { bg: '#fffbeb', fg: '#b45309', bd: '#fde68a' }));
      wrap.appendChild(_chip('today',   '📅',         dueToday,{ bg: '#eff6ff', fg: '#1e40af', bd: '#bfdbfe' }));
      wrap.appendChild(_chip('new',     '✨',         newCnt,  { bg: '#f5f3ff', fg: '#6d28d9', bd: '#ddd6fe' }));
      wrap.appendChild(_chip('mine',    '⭐ Mine',    mine,    { bg: '#f0fdf4', fg: '#15803d', bd: '#bbf7d0' }));

      // Divider
      wrap.appendChild(h('span', { style: { width: '1px', height: '20px', background: '#e2e8f0', margin: '0 4px' } }));

      // Status dropdown — multi-select via inline popover; for now native <select> for single
      const statuses = Array.isArray(S.statuses) ? S.statuses : [];
      const statusSel = h('select', {
        style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: '7px', padding: '5px 9px', fontSize: '12px', color: '#0f172a', cursor: 'pointer', flexShrink: '0', maxWidth: '160px' },
        onchange: (e) => {
          const v = e.target.value;
          if (!v) S.fStatus = [];
          else S.fStatus = [v];
          if (onChange) onChange();
        }
      },
        h('option', { value: '' }, '📊 Status: Any' + (S.fStatus && S.fStatus.length ? ' · ' + S.fStatus.length : '')),
        ...statuses.map(st => h('option', { value: String(st.name), selected: Array.isArray(S.fStatus) && S.fStatus.includes(st.name) }, st.name)));
      wrap.appendChild(statusSel);

      // Date dropdown — presets via applyDatePreset
      const dateSel = h('select', {
        style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: '7px', padding: '5px 9px', fontSize: '12px', color: '#0f172a', cursor: 'pointer', flexShrink: '0', maxWidth: '140px' },
        onchange: (e) => { applyDatePreset(e.target.value); if (onChange) onChange(); }
      },
        h('option', { value: '',          selected: !S.fDatePreset },          '📅 Any time'),
        h('option', { value: 'today',     selected: S.fDatePreset === 'today' }, 'Today'),
        h('option', { value: 'yesterday', selected: S.fDatePreset === 'yesterday' }, 'Yesterday'),
        h('option', { value: '7d',        selected: S.fDatePreset === '7d' },    'Last 7 days'),
        h('option', { value: '30d',       selected: S.fDatePreset === '30d' },   'Last 30 days'));
      wrap.appendChild(dateSel);

      // Owner dropdown
      const users = Array.isArray(S.users) ? S.users : [];
      const ownerSel = h('select', {
        style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: '7px', padding: '5px 9px', fontSize: '12px', color: '#0f172a', cursor: 'pointer', flexShrink: '0', maxWidth: '140px' },
        onchange: (e) => {
          const v = e.target.value;
          S.fOwner = v ? [Number(v)] : [];
          if (onChange) onChange();
        }
      },
        h('option', { value: '' }, '👤 Any user'),
        ...users.map(u => h('option', { value: String(u.id), selected: Array.isArray(S.fOwner) && S.fOwner.map(Number).includes(Number(u.id)) }, u.name)));
      wrap.appendChild(ownerSel);

      // + More filters button
      const moreActive = countActiveFilters();
      const moreBtn = h('button', {
        id: 'lv2-mfilters-btn',
        style: {
          background: '#fff', color: '#475569', border: '1px dashed #cbd5e1', borderRadius: '7px',
          padding: '5px 11px', fontSize: '12px', cursor: 'pointer', fontWeight: '500',
          display: 'inline-flex', alignItems: 'center', gap: '5px'
        },
        onclick: function (ev) { _openMoreFiltersPopover(ev.currentTarget, onChange); }
      },
        '⚙ Filters',
        moreActive ? h('span', { style: { background: '#4f46e5', color: '#fff', fontSize: '10px', padding: '1px 7px', borderRadius: '999px', fontWeight: '700' } }, String(moreActive)) : null);
      wrap.appendChild(moreBtn);

      // Spacer
      wrap.appendChild(h('span', { style: { flex: '1', minWidth: '8px' } }));

      // Refresh
      wrap.appendChild(h('button', {
        style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: '7px', padding: '5px 10px', fontSize: '12px', cursor: 'pointer', color: '#475569' },
        title: 'Refresh',
        onclick: () => { try { load(); } catch (_) {} }
      }, '⟳'));

      // + New Lead
      wrap.appendChild(h('button', {
        style: { background: '#4f46e5', color: '#fff', border: '1px solid #4f46e5', borderRadius: '7px', padding: '5px 12px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' },
        onclick: () => { try { if (typeof window.openLeadModal === 'function') window.openLeadModal(); } catch (e) { toast('Could not open: ' + e.message, 'err'); } }
      }, '＋ New Lead'));

      // 🔀 Merge selected (bulk action)
      const mergeBtn = h('button', {
        style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: '7px', padding: '5px 11px', fontSize: '12px', cursor: 'pointer', color: '#475569', fontWeight: '500', display: 'inline-flex', alignItems: 'center', gap: '5px' },
        title: 'Merge selected leads into one (select 2+ rows first)',
        onclick: () => {
          try {
            // Mirror the global bulkMergePrompt in app.js. Modern row checkboxes use class lv2-rowsel.
            const ids = Array.from(document.querySelectorAll('input.lv2-rowsel:checked, .tbl-wrap input[type=checkbox]:checked'))
              .map(el => Number(el.dataset && el.dataset.leadId || el.value))
              .filter(n => n > 0);
            if (ids.length < 2) { toast('Select at least 2 leads to merge', 'err'); return; }
            // Hand off to the global merge prompt if it can read selection from a custom shim
            window._lv2MergeIds = ids;
            if (typeof window.bulkMergePrompt === 'function') {
              // Override selectedIds() temporarily so bulkMergePrompt sees our Modern checkboxes
              const _origSel = window.selectedIds;
              window.selectedIds = () => ids;
              try { window.bulkMergePrompt(); }
              finally { setTimeout(() => { try { window.selectedIds = _origSel; } catch(_){} }, 100); }
            } else { toast('Merge function not loaded', 'err'); }
          } catch (e) { toast('Merge failed: ' + e.message, 'err'); }
        }
      }, '🔀 Merge');
      wrap.appendChild(mergeBtn);

      // ⋮ More menu (Export + Theme)
      const more = h('button', {
        style: { background: '#fff', border: '1px solid #cbd5e1', borderRadius: '7px', padding: '5px 10px', fontSize: '14px', cursor: 'pointer', color: '#475569', fontWeight: '700', lineHeight: '1' },
        title: 'More',
        onclick: function (ev) {
          const ex = document.getElementById('lv2-more-menu'); if (ex) { ex.remove(); return; }
          const r = ev.currentTarget.getBoundingClientRect();
          const m = h('div', {
            id: 'lv2-more-menu',
            style: { position: 'fixed', top: (r.bottom + 5) + 'px', right: '12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 6px 18px rgba(0,0,0,.12)', padding: '5px', zIndex: '1000', minWidth: '160px' }
          });
          const mi = (lab, fn) => h('div', {
            style: { padding: '7px 10px', cursor: 'pointer', fontSize: '12px', color: '#0f172a', borderRadius: '5px' },
            onmouseenter: (e) => { e.target.style.background = '#f1f5f9'; },
            onmouseleave: (e) => { e.target.style.background = 'transparent'; },
            onclick: () => { try { m.remove(); } catch(_){} try { fn(); } catch(_) {} }
          }, lab);
          m.appendChild(mi('↓ Export CSV', () => { try { if (typeof window.lv2ExportCsv === 'function') window.lv2ExportCsv(); else toast('Export not available', 'err'); } catch(_){} }));
          m.appendChild(mi('🎯 Focus mode', () => { S.focusMode = !S.focusMode; if (onChange) onChange(); }));
          document.body.appendChild(m);
          setTimeout(() => {
            const close = (e) => { if (e.target.closest && e.target.closest('#lv2-more-menu')) return; try { m.remove(); } catch(_){} document.removeEventListener('mousedown', close, true); };
            document.addEventListener('mousedown', close, true);
          }, 50);
        }
      }, '⋮');
      wrap.appendChild(more);

      return wrap;
    } catch (e) {
      console.error('[LEADS_V2_HEADER_v4] compact header failed, falling back:', e);
      return h('div', { style: { padding: '6px 14px', color: '#c04444', fontSize: '11px' } }, 'Header error: ' + e.message);
    }
  }

  function buildStatusChipBar(onChange) {
    try {
      const counts = {};
      (Array.isArray(S.leads) ? S.leads : []).forEach(l => {
        const k = l.status_name || 'No status';
        counts[k] = (counts[k] || 0) + 1;
      });
      // v1.3 — collapsible: tiny header + chevron; body hidden if S.chipsCollapsed
      const wrap = h('div', { class: 'lv2-chipswrap', style: { background: '#ffffff', borderBottom: '1px solid #e2e8f0' } });
      const head = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 14px', cursor: 'pointer', userSelect: 'none' },
        onclick: () => { S.chipsCollapsed = !S.chipsCollapsed; try { sessionStorage.setItem('crm.lv2.chipsCollapsed', S.chipsCollapsed ? '1' : '0'); } catch(_){} if (onChange) onChange(); }
      },
        h('span', { style: { fontSize: '10.5px', fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' } },
          (S.chipsCollapsed ? '▸' : '▾') + ' Status segments' + (S.statusChip !== 'all' ? ' · ' + S.statusChip : '')),
        h('span', { style: { fontSize: '10px', color: '#94a3b8' } }, S.chipsCollapsed ? 'Click to expand' : 'Click to collapse'));
      wrap.appendChild(head);
      if (!S.chipsCollapsed) {
        const bar = h('div', { class: 'lv2-statuschips', style: { display: 'flex', gap: '6px', padding: '0 14px 8px', overflowX: 'auto', flexWrap: 'wrap' } });
        bar.appendChild(makeStatusChip('all', 'All', S.leads.length, onChange));
        (Array.isArray(S.statuses) ? S.statuses : []).forEach(s => {
          const c = counts[s.name] || 0;
          bar.appendChild(makeStatusChip(s.name, s.name, c, onChange));
        });
        wrap.appendChild(bar);
      }
      return wrap;
    } catch (e) {
      console.error('[LEADS_V2] buildStatusChipBar failed:', e);
      return h('div', { style: { padding: '6px 14px', color: '#c04444', fontSize: '11px' } }, 'Status chips error: ' + e.message);
    }
  }
  function makeStatusChip(key, label, count, onChange) {
    const isActive = S.statusChip === key;
    const sc = statusClass(label);
    return h('span', {
      style: {
        padding: '4px 12px', borderRadius: '14px', fontSize: '11.5px',
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px',
        background: isActive ? '#4338ca' : '#f8fafc',
        border: '1px solid ' + (isActive ? '#4338ca' : '#e2e8f0'),
        color: isActive ? 'white' : '#475569',
        fontWeight: isActive ? '700' : '500',
        whiteSpace: 'nowrap',
        boxShadow: isActive ? '0 1px 3px rgba(67,56,202,.3)' : 'none'
      },
      onclick: () => { S.statusChip = key; if (onChange) onChange(); }
    },
      h('span', { class: 'lv2-dot ' + sc, style: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block' } }),
      label,
      h('span', { style: { background: isActive ? 'white' : '#e2e8f0', color: '#64748b', fontSize: '9px', fontWeight: '700', padding: '1px 5px', borderRadius: '8px' } }, String(count)));
  }

  function countActiveFilters() {
    let n = 0;
    if (S.search) n++;
    if (S.fDatePreset || S.fDateFrom || S.fDateTo) n++;
    ['fStatus','fSource','fOwner','fScore','fTag','fCampaign'].forEach(k => { if (Array.isArray(S[k]) && S[k].length) n++; });
    if (S.fFollowup) n++;
    if (S.fQualified) n++;
    if (S.statusChip && S.statusChip !== 'all') n++;
    return n;
  }

  function applyDatePreset(preset) {
    S.fDatePreset = preset;
    const now = new Date();
    const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    if (preset === 'today') { S.fDateFrom = fmt(now); S.fDateTo = fmt(now); }
    else if (preset === 'yesterday') { const y = new Date(now); y.setDate(y.getDate()-1); S.fDateFrom = fmt(y); S.fDateTo = fmt(y); }
    else if (preset === '7d') { const f = new Date(now); f.setDate(f.getDate()-7); S.fDateFrom = fmt(f); S.fDateTo = fmt(now); }
    else if (preset === '30d') { const f = new Date(now); f.setDate(f.getDate()-30); S.fDateFrom = fmt(f); S.fDateTo = fmt(now); }
    else { S.fDateFrom = ''; S.fDateTo = ''; }
  }

  function buildFilterBar(onChange) {
    try {
    // v2.1 — collapsible. Tiny header with active-filter count + chevron;
    // body only renders when filtersCollapsed=false.
    const outer = h('div', { style: { background: '#ffffff', borderBottom: '1px solid #e2e8f0' } });
    const activeCount = countActiveFilters();
    const head = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', cursor: 'pointer', userSelect: 'none' },
      onclick: () => { S.filtersCollapsed = !S.filtersCollapsed; try { sessionStorage.setItem('crm.lv2.filtersCollapsed', S.filtersCollapsed ? '1' : '0'); } catch(_){} if (onChange) onChange(); }
    },
      h('span', { style: { fontSize: '10.5px', fontWeight: '600', color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px' } },
        (S.filtersCollapsed ? '▸' : '▾') + ' 🔍 Filters' + (activeCount ? ' (' + activeCount + ' active)' : '')),
      h('span', { style: { fontSize: '10px', color: '#94a3b8' } },
        S.filtersCollapsed ? 'Click to expand' : 'Click to collapse'));
    outer.appendChild(head);
    if (S.filtersCollapsed) return outer;

    // Returns a comprehensive filter row with ALL filters wired to S + onChange.
    const wrap = h('div', { style: { padding: '6px 14px 10px', display: 'flex', flexDirection: 'column', gap: '8px' } });

    // Row 1: search + date presets + From/To
    const row1 = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } });
    row1.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', minWidth: '200px', maxWidth: '260px', flex: '0 0 260px', boxSizing: 'border-box' } },
      h('span', { style: { color: '#94a3b8', fontSize: '12px' } }, '🔍'),
      h('input', { placeholder: 'Search name, phone, email, remark, tag, city, campaign…', value: S.search,
        style: { border: 'none', background: 'transparent', outline: 'none', fontSize: '12px', width: '100%', minWidth: '0', color: '#0f172a' },
        oninput: (e) => { S.search = e.target.value; if (onChange) onChange(); } })));
    // Date preset pills
    const datePresets = [['today','Today'],['yesterday','Yesterday'],['7d','Last 7d'],['30d','Last 30d'],['all','All']];
    datePresets.forEach(([k, lab]) => {
      const isActive = S.fDatePreset === k;
      row1.appendChild(h('button', {
        style: {
          padding: '4px 12px',
          background: isActive ? '#4338ca' : 'white',
          color: isActive ? 'white' : '#64748b',
          border: '1px solid ' + (isActive ? '#4338ca' : '#e2e8f0'),
          borderRadius: '14px', fontSize: '11px', cursor: 'pointer',
          fontWeight: isActive ? '700' : '500',
          boxShadow: isActive ? '0 1px 3px rgba(67,56,202,.3)' : 'none'
        },
        onclick: () => { applyDatePreset(k); if (onChange) onChange(); }
      }, lab));
    });
    // Custom range
    row1.appendChild(h('span', { style: { fontSize: '11px', color: '#94a3b8', margin: '0 4px' } }, 'or'));
    row1.appendChild(h('input', { type: 'date', value: S.fDateFrom, title: 'From date',
      style: { padding: '4px 6px', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11px', width: '130px', flex: '0 0 130px', boxSizing: 'border-box' },
      onchange: (e) => { S.fDateFrom = e.target.value; S.fDatePreset = ''; if (onChange) onChange(); } }));
    row1.appendChild(h('span', { style: { fontSize: '11px', color: '#64748b', margin: '0 2px' } }, '→'));
    row1.appendChild(h('input', { type: 'date', value: S.fDateTo, title: 'To date',
      style: { padding: '4px 6px', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11px', width: '130px', flex: '0 0 130px', boxSizing: 'border-box' },
      onchange: (e) => { S.fDateTo = e.target.value; S.fDatePreset = ''; if (onChange) onChange(); } }));
    wrap.appendChild(row1);

    // Row 2: multi-select filter chips (only the ones in visibleFilters)
    const row2 = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } });

    // helper to add a multi-select filter chip
    const visFilters = Array.isArray(S.visibleFilters) ? S.visibleFilters : [];
    const addMulti = (key, icon, label, opts, stateKey) => {
      if (!visFilters.includes(key)) return;
      const selectedCount = Array.isArray(S[stateKey]) ? S[stateKey].length : 0;
      const chipLabel = selectedCount ? (label + ': ' + selectedCount + ' selected') : (icon + ' ' + label);
      row2.appendChild(h('button', {
        style: {
          padding: '5px 12px',
          background: selectedCount ? '#4338ca' : 'white',
          color: selectedCount ? 'white' : '#64748b',
          border: '1px solid ' + (selectedCount ? '#4338ca' : '#e2e8f0'),
          borderRadius: '14px', fontSize: '11.5px', cursor: 'pointer',
          fontWeight: selectedCount ? '700' : '500',
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          boxShadow: selectedCount ? '0 1px 3px rgba(67,56,202,.3)' : 'none'
        },
        // v3.13 — stop propagation so the document-level click-outside
        // handler inside openMultiSelectPopover doesn't fire on the
        // same click that opened it.
        onclick: (ev) => { ev.stopPropagation(); openMultiSelectPopover(ev.currentTarget, label, opts, S[stateKey] || [], (sel) => { S[stateKey] = sel; if (onChange) onChange(); }); }
      }, chipLabel, h('span', { style: { color: selectedCount ? 'rgba(255,255,255,.7)' : '#94a3b8' } }, '▾')));
    };

    // Build option arrays
    const statusOpts = (Array.isArray(S.statuses) ? S.statuses : []).map(s => [s.id, s.name]);
    const srcSet = new Set();
    (Array.isArray(S.sources) ? S.sources : []).forEach(s => {
      const name = (typeof s === 'string') ? s : (s && (s.name || s.label || s.value)) || '';
      if (name) srcSet.add(name);
    });
    (S.leads || []).forEach(l => { if (l.source) srcSet.add(l.source); });
    const srcOpts = Array.from(srcSet).map(s => [s, s]);
    const ownerOpts = (Array.isArray(S.users) ? S.users : []).map(u => [u.id, u.name]);
    const scoreOpts = [['hot', '🔥 Hot (80+)'], ['warm', '☀️ Warm (50-79)'], ['cold', '🧊 Cold (1-49)']];
    const tagOpts = [];
    (Array.isArray(S.tags) ? S.tags : []).forEach(t => {
      const name = (typeof t === 'string') ? t : (t && (t.name || t.tag || t.value)) || '';
      if (name) tagOpts.push([name, name]);
    });
    const cmpOpts = [];
    (Array.isArray(S.campaigns) ? S.campaigns : []).forEach(c => {
      const id = (c && (c.id || c.campaign_id)) || (typeof c === 'string' ? c : '');
      const name = (typeof c === 'string') ? c : (c && (c.name || c.title || c.label)) || '';
      if (name) cmpOpts.push([id || name, name]);
    });

    addMulti('status',   '🎯', 'Status',   statusOpts, 'fStatus');
    addMulti('source',   '🏷', 'Source',   srcOpts,    'fSource');
    addMulti('owner',    '👤', 'Owner',    ownerOpts,  'fOwner');
    addMulti('score',    '🤖', 'AI Score', scoreOpts,  'fScore');
    addMulti('tag',      '🔖', 'Tag',      tagOpts,    'fTag');
    addMulti('campaign', '📣', 'Campaign', cmpOpts,    'fCampaign');

    // Single-select follow-up + qualified (keep as small selects)
    if (visFilters.includes('followup')) {
      row2.appendChild(filterSelect('⏰', 'Follow-up', S.fFollowup, [['', 'All follow-ups'], ['overdue', '⚠ Overdue'], ['today', '📅 Due today'], ['week', '📆 This week'], ['none', '— No follow-up'] ],
        (v) => { S.fFollowup = v; if (onChange) onChange(); }));
    }
    if (visFilters.includes('qualified')) {
      row2.appendChild(filterSelect('✅', 'Qualified', S.fQualified, [['', 'Any qualified'], ['yes', '✓ Qualified'], ['no', '✗ Not qualified']],
        (v) => { S.fQualified = v; if (onChange) onChange(); }));
    }

    // Right-side actions: Customize filters, Save view, Reset, count
    const right = h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } });
    right.appendChild(h('button', {
      style: { padding: '5px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11.5px', cursor: 'pointer', color: '#64748b' },
      onclick: (ev) => openCustomizeFiltersPopover(ev.currentTarget, onChange)
    }, '👁 Filters'));
    right.appendChild(h('button', {
      style: { padding: '5px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11.5px', cursor: 'pointer', color: '#64748b' },
      onclick: (ev) => openCustomizeColumnsPopover(ev.currentTarget, onChange)
    }, '📊 Columns'));
    right.appendChild(h('button', {
      style: { padding: '5px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11.5px', cursor: 'pointer', color: '#64748b' },
      onclick: () => openSavedViewsPopover(onChange)
    }, '⭐ Views (' + (S.savedViews||[]).length + ')'));
    right.appendChild(h('button', {
      style: { padding: '5px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '11.5px', cursor: 'pointer', color: '#64748b' },
      onclick: () => {
        S.statusChip = 'all'; S.search = ''; S.fStatus = []; S.fSource = []; S.fOwner = [];
        S.fTag = []; S.fCampaign = []; S.fScore = []; S.fFollowup = ''; S.fQualified = '';
        S.fDateFrom = ''; S.fDateTo = ''; S.fDatePreset = ''; S.filter = 'all';
        if (onChange) onChange();
      }
    }, '↻ Reset'));
    const matched = filtered().length;
    right.appendChild(h('span', { style: { fontSize: '11px', color: '#94a3b8', whiteSpace: 'nowrap' } },
      matched + ' / ' + (S.leads || []).length));
    row2.appendChild(right);
    wrap.appendChild(row2);

    outer.appendChild(wrap);
    return outer;
    } catch (e) {
      console.error('[LEADS_V2] buildFilterBar failed:', e);
      return h('div', { style: { padding: '6px 14px', color: '#c04444', fontSize: '11px' } }, 'Filter bar error: ' + e.message);
    }
  }
  function filterSelect(icon, lab, val, opts, onChange) {
    // v3.7 — active state: indigo background + white-ish bg + bold border
    const sel = h('select', {
      style: {
        padding: '4px 10px',
        background: val ? '#4338ca' : 'white',
        color: val ? 'white' : '#475569',
        border: '1px solid ' + (val ? '#4338ca' : '#e2e8f0'),
        borderRadius: '14px', fontSize: '11.5px', cursor: 'pointer', outline: 'none',
        maxWidth: '160px', fontWeight: val ? '700' : '500',
        boxShadow: val ? '0 1px 3px rgba(67,56,202,.3)' : 'none'
      },
      onchange: (e) => onChange(e.target.value)
    });
    opts.forEach(([v, lab2]) => sel.appendChild(h('option', { value: v, selected: String(v) === String(val) ? 'selected' : null }, lab2)));
    // Prepend label icon — wrap in a flex container
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '3px' } },
      h('span', { style: { fontSize: '11px', color: '#94a3b8' } }, icon),
      sel);
  }

  /* ===== v1.3 popovers — multi-select, customize-filters, saved-views ===== */
  function _closePopovers() {
    document.querySelectorAll('.lv2-popover').forEach(p => p.remove());
  }
  function openMultiSelectPopover(anchorEl, title, opts, currentSelected, onApply) {
    _closePopovers();
    const r = anchorEl.getBoundingClientRect();
    const sel = new Set((currentSelected || []).map(String));
    const pop = h('div', {
      class: 'lv2-popover',
      onclick: (e) => e.stopPropagation(),  // v3.15 — clicks inside the popover never bubble out
      style: {
        position: 'fixed', top: (r.bottom + 4) + 'px', left: r.left + 'px',
        background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px',
        boxShadow: '0 10px 30px rgba(0,0,0,.12)', padding: '8px', minWidth: '240px', maxWidth: '320px',
        maxHeight: '360px', overflowY: 'auto', zIndex: '10000'
      }
    });
    pop.appendChild(h('div', { style: { fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', padding: '4px 6px 8px' } }, title));
    // Select all / Clear
    pop.appendChild(h('div', { style: { display: 'flex', gap: '6px', padding: '0 6px 8px', borderBottom: '1px solid #f1f5f9', marginBottom: '4px' } },
      h('button', { style: { padding: '3px 8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '10px', cursor: 'pointer', color: '#64748b' },
        onclick: () => { opts.forEach(([v]) => sel.add(String(v))); rebuild(); } }, '✓ All'),
      h('button', { style: { padding: '3px 8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '10px', cursor: 'pointer', color: '#64748b' },
        onclick: () => { sel.clear(); rebuild(); } }, '✗ None')));
    const listEl = h('div');
    pop.appendChild(listEl);
    function rebuild() {
      listEl.innerHTML = '';
      if (!opts.length) {
        listEl.appendChild(h('div', { style: { padding: '12px', color: '#94a3b8', fontSize: '11px', textAlign: 'center' } }, 'No options'));
      }
      opts.forEach(([v, label]) => {
        const k = String(v);
        const checked = sel.has(k);
        listEl.appendChild(h('label', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 6px', cursor: 'pointer', fontSize: '12.5px', borderRadius: '4px' },
          onmouseover: function () { this.style.background = '#f8fafc'; },
          onmouseout:  function () { this.style.background = ''; }
        },
          h('input', { type: 'checkbox', checked: checked ? 'checked' : null, style: { accentColor: '#5e6ad2' },
            onchange: (e) => { if (e.target.checked) sel.add(k); else sel.delete(k); } }),
          h('span', null, label)));
      });
    }
    rebuild();
    // Apply / Cancel
    pop.appendChild(h('div', { style: { display: 'flex', gap: '6px', padding: '8px 6px 4px', borderTop: '1px solid #f1f5f9', marginTop: '4px' } },
      h('button', { style: { flex: '1', padding: '5px 10px', background: '#1e293b', color: 'white', border: 'none', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', fontWeight: '600' },
        onclick: (ev) => { ev.stopPropagation(); const arr = Array.from(sel); console.log('[LEADS_V2] filter applied:', title, arr); onApply(arr); _closePopovers(); } }, 'Apply'),
      h('button', { style: { padding: '5px 10px', background: 'white', color: '#64748b', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11px', cursor: 'pointer' },
        onclick: (ev) => { ev.stopPropagation(); _closePopovers(); } }, 'Cancel')));
    document.body.appendChild(pop);
    // Click-outside to close
    setTimeout(() => {
      const off = (e) => { if (!pop.contains(e.target)) { _closePopovers(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 50);
  }

  function openCustomizeFiltersPopover(anchorEl, onChange) {
    _closePopovers();
    const r = anchorEl.getBoundingClientRect();
    const allFilters = [
      ['status',    '🎯 Status'],
      ['source',    '🏷 Source'],
      ['owner',     '👤 Owner'],
      ['score',     '🤖 AI Score'],
      ['tag',       '🔖 Tag'],
      ['campaign',  '📣 Campaign'],
      ['followup',  '⏰ Follow-up'],
      ['qualified', '✅ Qualified']
    ];
    const visible = new Set(Array.isArray(S.visibleFilters) ? S.visibleFilters : []);
    const pop = h('div', { class: 'lv2-popover', style: {
      position: 'fixed', top: (r.bottom + 4) + 'px', right: '24px',
      background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px',
      boxShadow: '0 10px 30px rgba(0,0,0,.12)', padding: '10px', minWidth: '220px', zIndex: '10000'
    } });
    pop.appendChild(h('div', { style: { fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', padding: '0 4px 8px' } }, 'Visible filters'));
    allFilters.forEach(([k, lab]) => {
      pop.appendChild(h('label', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 4px', cursor: 'pointer', fontSize: '12px' }
      },
        h('input', { type: 'checkbox', checked: visible.has(k) ? 'checked' : null, style: { accentColor: '#5e6ad2' },
          onchange: (e) => {
            if (e.target.checked) visible.add(k); else visible.delete(k);
            S.visibleFilters = Array.from(visible);
            try { localStorage.setItem('crm.lv2.visibleFilters', JSON.stringify(S.visibleFilters)); } catch(_){}
            if (onChange) onChange();
          } }),
        h('span', null, lab)));
    });
    document.body.appendChild(pop);
    setTimeout(() => {
      const off = (e) => { if (!pop.contains(e.target)) { _closePopovers(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 50);
  }

  function openCustomizeColumnsPopover(anchorEl, onChange) {
    _closePopovers();
    const r = anchorEl.getBoundingClientRect();
    const allCols = [
      ['phone',     '📞 Phone & actions'],
      ['source',    '🏷 Source'],
      ['status',    '🎯 Status'],
      ['owner',     '👤 Owner'],
      ['score',     '🤖 AI Score'],
      ['aistep',    '✨ AI Next Step'],
      ['followup',  '⏰ Next Follow-up'],
      ['lastwa',    '💬 Last WhatsApp'],
      ['notes',     '📝 Notes / Remark'],
      ['email',     '📧 Email'],
      ['tags',      '🔖 Tags'],
      ['city',      '🗺 City'],
      ['product',   '📦 Product'],
      ['activity',  '🕒 Last activity'],
      ['created',   '🗓 Created']
    ];
    const visible = new Set(Array.isArray(S.visibleColumns) ? S.visibleColumns : []);
    const pop = h('div', { class: 'lv2-popover', style: {
      position: 'fixed', top: (r.bottom + 4) + 'px', right: '24px',
      background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px',
      boxShadow: '0 10px 30px rgba(0,0,0,.12)', padding: '10px', minWidth: '240px', zIndex: '10000'
    } });
    pop.appendChild(h('div', { style: { fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', padding: '0 4px 8px' } }, 'Visible columns'));
    pop.appendChild(h('div', { style: { fontSize: '10px', color: '#94a3b8', padding: '0 4px 6px', borderBottom: '1px solid #f1f5f9', marginBottom: '4px' } }, 'Checkbox + Name are always visible.'));
    allCols.forEach(([k, lab]) => {
      pop.appendChild(h('label', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 4px', cursor: 'pointer', fontSize: '12px' }
      },
        h('input', { type: 'checkbox', checked: visible.has(k) ? 'checked' : null, style: { accentColor: '#5e6ad2' },
          onchange: (e) => {
            if (e.target.checked) visible.add(k); else visible.delete(k);
            S.visibleColumns = Array.from(visible);
            try { localStorage.setItem('crm.lv2.visibleColumns', JSON.stringify(S.visibleColumns)); } catch(_){}
            if (onChange) onChange();
          } }),
        h('span', null, lab)));
    });
    pop.appendChild(h('div', { style: { display: 'flex', gap: '6px', padding: '8px 4px 4px', borderTop: '1px solid #f1f5f9', marginTop: '4px' } },
      h('button', { style: { flex: '1', padding: '5px 8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', color: '#475569' },
        onclick: () => { allCols.forEach(([k]) => visible.add(k)); S.visibleColumns = Array.from(visible); try { localStorage.setItem('crm.lv2.visibleColumns', JSON.stringify(S.visibleColumns)); } catch(_){} _closePopovers(); if (onChange) onChange(); } }, '✓ Show all'),
      h('button', { style: { flex: '1', padding: '5px 8px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', color: '#475569' },
        onclick: () => { visible.clear(); S.visibleColumns = []; try { localStorage.setItem('crm.lv2.visibleColumns', JSON.stringify([])); } catch(_){} _closePopovers(); if (onChange) onChange(); } }, '✗ Hide all')));
    document.body.appendChild(pop);
    setTimeout(() => {
      const off = (e) => { if (!pop.contains(e.target)) { _closePopovers(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 50);
  }

  function openSavedViewsPopover(onChange) {
    _closePopovers();
    const pop = h('div', { class: 'lv2-popover', style: {
      position: 'fixed', top: '90px', right: '24px',
      background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px',
      boxShadow: '0 10px 30px rgba(0,0,0,.12)', padding: '10px', minWidth: '260px', zIndex: '10000'
    } });
    pop.appendChild(h('div', { style: { fontSize: '11px', fontWeight: '700', color: '#64748b', textTransform: 'uppercase', padding: '0 4px 8px' } }, 'Saved Views'));
    const views = Array.isArray(S.savedViews) ? S.savedViews : [];
    if (!views.length) {
      pop.appendChild(h('div', { style: { padding: '12px', fontSize: '11px', color: '#94a3b8', textAlign: 'center' } }, 'No saved views yet'));
    } else {
      views.forEach((v, i) => {
        pop.appendChild(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 4px', borderBottom: '1px solid #f1f5f9' } },
          h('button', { style: { flex: '1', padding: '5px 8px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11.5px', cursor: 'pointer', color: '#475569', textAlign: 'left' },
            onclick: () => {
              Object.assign(S, v.state);
              try { localStorage.setItem('crm.lv2.lastView', v.name); } catch(_){}
              _closePopovers();
              if (onChange) onChange();
            } }, '⭐ ' + v.name),
          h('button', { style: { padding: '5px 8px', background: 'white', border: '1px solid #fecaca', color: '#b91c1c', borderRadius: '5px', fontSize: '10px', cursor: 'pointer' },
            onclick: () => {
              S.savedViews.splice(i, 1);
              try { localStorage.setItem('crm.lv2.savedViews', JSON.stringify(S.savedViews)); } catch(_){}
              _closePopovers();
              openSavedViewsPopover(onChange);
            } }, '✕')));
      });
    }
    // + Save current
    pop.appendChild(h('button', {
      style: { width: '100%', padding: '7px', background: '#1e293b', color: 'white', border: 'none', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', fontWeight: '600', marginTop: '8px' },
      onclick: () => {
        const name = (prompt('Name this view:') || '').trim();
        if (!name) return;
        const state = {
          statusChip: S.statusChip, search: S.search, filter: S.filter,
          fStatus: S.fStatus, fSource: S.fSource, fOwner: S.fOwner, fTag: S.fTag,
          fCampaign: S.fCampaign, fScore: S.fScore, fFollowup: S.fFollowup, fQualified: S.fQualified,
          fDateFrom: S.fDateFrom, fDateTo: S.fDateTo, fDatePreset: S.fDatePreset
        };
        S.savedViews = (S.savedViews || []).filter(v => v.name !== name);
        S.savedViews.push({ name, state });
        try { localStorage.setItem('crm.lv2.savedViews', JSON.stringify(S.savedViews)); } catch(_){}
        _closePopovers();
        if (onChange) onChange();
      }
    }, '＋ Save current view'));
    document.body.appendChild(pop);
    setTimeout(() => {
      const off = (e) => { if (!pop.contains(e.target)) { _closePopovers(); document.removeEventListener('click', off); } };
      document.addEventListener('click', off);
    }, 50);
  }

  /* ====================================================================
   * MODERN (A3) RENDERER — full table with AI columns + slide-over panel
   * ==================================================================*/
  async function renderModern(view) {
    injectStyles();
    if (!S.leads.length) await load();

    // v1.6 — clear view to prevent duplicate-render stacking when called from
    // onFilterChange (which previously appended ANOTHER full modern view
    // BELOW the existing one — visible bug in user screenshot).
    view.innerHTML = '';

    const meId = (window.CRM && CRM.user && CRM.user.id) || null;
    const total = S.leads.length;
    const hot = S.leads.filter(l => Number(l.smart_score || 0) >= 80).length;
    const overdue = S.leads.filter(l => l.next_followup_at && new Date(l.next_followup_at) < new Date()).length;
    const mine = meId ? S.leads.filter(l => Number(l.assigned_to) === Number(meId)).length : 0;
    const newCnt = S.leads.filter(l => /new|fresh/i.test(l.status_name || '')).length;

    const wrap = h('div', { class: 'lv2-modern' });

    // v1.3 — compact micro stats (80% smaller than before); Focus mode hides entirely
    // LEADS_V2_HEADER_v4 — skip when compact header is on (counts already inline)
    const _hideMicroForV4 = (typeof _headerV4Enabled === 'function') && _headerV4Enabled();
    /* When v4 header is on, auto-exit any sticky focus mode so the user is
       never stuck inside the legacy focus UI (Exit button there can hang). */
    if (_hideMicroForV4 && S.focusMode) {
      S.focusMode = false;
      try { localStorage.setItem('crm.lv2.focus', '0'); } catch (_) {}
    }
    if (!S.focusMode && !_hideMicroForV4) {
      const micro = h('div', { style: { display: 'flex', gap: '14px', padding: '6px 14px', background: '#fafbfc', borderBottom: '1px solid #f1f5f9', fontSize: '11px', alignItems: 'center' } },
        miniStat('Total', total, '#0f172a'),
        miniStat('🔥 Hot', hot, '#b91c1c'),
        miniStat('⏰ Overdue', overdue, '#f59e0b'),
        miniStat('⭐ Mine', mine, '#0f172a'),
        miniStat('🆕 New', newCnt, '#15803d'),
        h('span', { style: { marginLeft: 'auto', fontSize: '10px', color: '#94a3b8' } }, 'Synced 2m ago'),
        // Focus toggle right side
        h('button', {
          style: { padding: '4px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '14px', fontSize: '11px', cursor: 'pointer', color: '#64748b', fontWeight: '500' },
          title: 'Hide chrome (Focus mode)',
          onclick: () => { S.focusMode = true; try { localStorage.setItem('crm.lv2.focus', '1'); } catch(_){} renderModern(view); }
        }, '🎯 Focus mode'));
      wrap.appendChild(micro);
    } else if (!_hideMicroForV4) {
      // Tiny strip with EXIT focus button only
      const strip = h('div', { style: { display: 'flex', gap: '14px', padding: '4px 14px', background: '#fef3c7', borderBottom: '1px solid #fde68a', fontSize: '11px', alignItems: 'center', justifyContent: 'space-between' } },
        h('span', { style: { color: '#92400e', fontWeight: '600' } }, '🎯 Focus mode active · ' + total + ' leads loaded'),
        h('button', {
          style: { padding: '4px 10px', background: 'white', border: '1px solid #fde68a', borderRadius: '14px', fontSize: '11px', cursor: 'pointer', color: '#92400e', fontWeight: '600' },
          onclick: () => { S.focusMode = false; try { localStorage.setItem('crm.lv2.focus', '0'); } catch(_){} renderModern(view); }
        }, '✕ Exit Focus'));
      wrap.appendChild(strip);
    }

    // Status chip row (matches Classic chips) — hidden in Focus mode
    // v1.5 — full re-render so filter bar (count, active pills, date inputs) reflects state
    const onFilterChange = () => { S.page = 1; renderModern(view); };
    /* LEADS_V2_HEADER_v4 — Option C compact sticky header.
       When the flag is on, render a single compact bar that replaces the legacy
       status-chip + filter-bar + qchips trio. Legacy path continues otherwise. */
    const _useV4Hdr = (typeof _headerV4Enabled === 'function') && _headerV4Enabled();
    if (_useV4Hdr && !S.focusMode) {
      wrap.appendChild(buildCompactHeader(onFilterChange));
    }
    if (!_useV4Hdr && !S.focusMode) wrap.appendChild(buildStatusChipBar(onFilterChange));
    // v3.16 — Focus mode: ALWAYS show Hot/Warm/Nurture sections.
    // Bypass the score-based statusChip ('hot'/'warm' chip) so all three
    // buckets remain visible even when a status chip is active — focus
    // mode is meant to categorize ACROSS scores. Other filters (date,
    // owner, source, search, status_id) still apply. Empty buckets show
    // a clear empty state instead of being hidden.
    if (S.focusMode) {
      // v3.17 — Snapshot + temporarily clear ALL score-based filters so all 3
      // buckets populate. Restore after. Three signals are score-based and
      // would otherwise strip warm/nurture BEFORE the bucket split:
      //   - S.statusChip ('hot' | 'warm' | 'cold')
      //   - S.filter ('hot' quick-chip — filtered() line: if S.filter==='hot' && score<80 return false)
      //   - S.fScore ['hot','warm','cold'] multi-select chip
      // Date / owner / source / specific status_id / qualified / followup
      // are NOT score-based, so they stay active.
      const _savedChip   = S.statusChip;
      const _savedFilter = S.filter;
      const _savedScore  = S.fScore;
      if (_savedChip === 'hot' || _savedChip === 'warm' || _savedChip === 'cold' || _savedChip === 'nurture') {
        S.statusChip = 'all';
      }
      if (_savedFilter === 'hot') {
        S.filter = 'all';
      }
      // Clear multi-select score filter too
      if (Array.isArray(_savedScore) && _savedScore.length) {
        S.fScore = [];
      }
      const rows = filtered();
      S.statusChip = _savedChip;  // restore
      S.filter     = _savedFilter;
      S.fScore     = _savedScore;
      console.log('[LEADS_V2] focus mode: rows=' + rows.length + ' (after bypassing score-based filters)');

      // Sort within each bucket: highest score first
      const sortByScore = (a, b) => Number(b.smart_score || 0) - Number(a.smart_score || 0);
      const hot     = rows.filter(l => Number(l.smart_score || 0) >= 80).sort(sortByScore);
      const warm    = rows.filter(l => { const s = Number(l.smart_score || 0); return s >= 50 && s < 80; }).sort(sortByScore);
      const nurture = rows.filter(l => Number(l.smart_score || 0) < 50).sort(sortByScore);

      const buildSection = (title, hint, list, accent) => {
        // v3.16 — ALWAYS render the section, even when empty, so the user
        // sees the full Hot → Warm → Nurture funnel structure.
        const sec = h('div', { style: { marginBottom: '16px', background: 'white', borderRadius: '12px', border: '1px solid ' + accent.border, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,.04)' } });
        sec.appendChild(h('div', {
          style: { padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: accent.bg, color: accent.fg, fontSize: '14px', fontWeight: '700' }
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', { style: { fontSize: '18px' } }, accent.emoji),
            h('span', null, title),
            h('span', { style: { fontSize: '11px', fontWeight: '500', opacity: '.85' } }, '· ' + hint)),
          h('span', { style: { background: 'rgba(255,255,255,.7)', padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: '700' } }, list.length + ' lead' + (list.length === 1 ? '' : 's'))));
        if (!list.length) {
          sec.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '12px' } },
            'No leads in this bucket match your current filters'));
        } else {
          const tbl = h('table', { class: 'lv2-tbl' });
          const tbody = h('tbody');
          // v3.19 — Cap at 8 rows per section so all 3 sections fit in the viewport
          // without scrolling. User exits focus mode for the full table.
          list.slice(0, 8).forEach(l => tbody.appendChild(renderModernRow(l)));
          tbl.appendChild(tbody);
          sec.appendChild(tbl);
          if (list.length > 8) sec.appendChild(h('div', { style: { padding: '8px 14px', textAlign: 'center', fontSize: '11px', color: '#94a3b8', borderTop: '1px solid #f1f5f9' } },
            'Showing top 8 of ' + list.length + ' (highest-score first) — exit focus mode to see all'));
        }
        return sec;
      };
      const focusWrap = h('div', { style: { padding: '0 14px 14px' } });
      // v3.19 — sticky summary bar at the top showing all 3 bucket counts.
      // Makes it impossible to miss that Warm/Nurture exist below the fold,
      // and each is clickable to jump to that section.
      const _scrollTo = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      focusWrap.appendChild(h('div', {
        style: { position: 'sticky', top: '0', zIndex: '50', display: 'flex', gap: '8px', padding: '8px 0', background: 'white', borderBottom: '1px solid #e2e8f0', marginBottom: '12px', flexWrap: 'wrap' }
      },
        h('button', {
          style: { padding: '8px 14px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '8px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' },
          onclick: () => _scrollTo('lv2-focus-hot')
        }, '🔥 Hot ', h('span', { style: { background: '#b91c1c', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '11px' } }, String(hot.length))),
        h('button', {
          style: { padding: '8px 14px', background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' },
          onclick: () => _scrollTo('lv2-focus-warm')
        }, '☀️ Warm ', h('span', { style: { background: '#b45309', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '11px' } }, String(warm.length))),
        h('button', {
          style: { padding: '8px 14px', background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', borderRadius: '8px', fontSize: '12px', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' },
          onclick: () => _scrollTo('lv2-focus-nurture')
        }, '❄️ Nurture ', h('span', { style: { background: '#1e40af', color: 'white', padding: '2px 8px', borderRadius: '10px', fontSize: '11px' } }, String(nurture.length))),
        h('span', { style: { marginLeft: 'auto', fontSize: '11px', color: '#94a3b8', alignSelf: 'center' } }, 'Click a bucket to jump · top 8 each shown')));
      // Wrap each buildSection result with the anchor id so the summary buttons can scroll to them.
      const _hotSec = buildSection('Hot leads',     'act NOW',          hot,     { emoji: '🔥', bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca' });
      if (_hotSec) _hotSec.id = 'lv2-focus-hot';
      focusWrap.appendChild(_hotSec);
      const _warmSec = buildSection('Warm leads',    'push this week',   warm,    { emoji: '☀️', bg: '#fffbeb', fg: '#b45309', border: '#fde68a' });
      if (_warmSec) _warmSec.id = 'lv2-focus-warm';
      focusWrap.appendChild(_warmSec);
      const _nurSec = buildSection('Nurture leads', 'keep warm',        nurture, { emoji: '❄️', bg: '#eff6ff', fg: '#1e40af', border: '#bfdbfe' });
      if (_nurSec) _nurSec.id = 'lv2-focus-nurture';
      focusWrap.appendChild(_nurSec);
      wrap.appendChild(focusWrap);
      view.appendChild(wrap);
      return;  // skip the regular table render
    }

    // Full filter bar — always visible (the user's main tool)
    if (!_useV4Hdr) wrap.appendChild(buildFilterBar(onFilterChange));

    // Quick chips — hidden in Focus mode
    const qchips = h('div', { class: 'qchips' });
    const chips = [['all','All','📋',total],['hot','🔥 Hot','',hot],['overdue','⏰ Overdue','',overdue],['today','📅 Due today','',0],['mine','⭐ Mine','',mine],['new','🆕 New','',newCnt]];
    chips.forEach(([key, label, ic, count]) => {
      qchips.appendChild(h('span', {
        class: 'qchip' + (S.filter === key ? ' active' : ''),
        onclick: () => { S.filter = key; renderModern(view); }
      }, label, count ? h('span', { style: { background: '#e2e8f0', color: '#475569', padding: '1px 5px', borderRadius: '8px', fontSize: '9px', fontWeight: '700' } }, String(count)) : null));
    });
    // + Refresh / Export / New
    qchips.appendChild(h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } },
      // v3.18 — Theme switcher is DESKTOP-ONLY. Hide on mobile screens.
      (function () {
        const _isMobile = (typeof window !== 'undefined') && (
          window.matchMedia && window.matchMedia('(max-width: 768px)').matches
          || window.innerWidth < 768
          || /Mobi|Android/i.test(navigator.userAgent || '')
        );
        // Still apply the saved theme on mobile (so colors are consistent
        // if the user later opens on desktop), but don't render the
        // picker UI. Return null so the toolbar layout is unaffected.
        const themes = [
          { key: 'default', color: '#4338ca', body: 'lv2-theme-default', label: 'Indigo' },
          { key: 'emerald', color: '#10b981', body: 'lv2-theme-emerald', label: 'Emerald' },
          { key: 'sunset',  color: '#f97316', body: 'lv2-theme-sunset',  label: 'Sunset' },
          { key: 'rose',    color: '#e11d48', body: 'lv2-theme-rose',    label: 'Rose' },
          { key: 'mono',    color: '#0f172a', body: 'lv2-theme-mono',    label: 'Mono' }
        ];
        const current = localStorage.getItem('crm.lv2.theme') || 'default';
        const _applyTheme = (k) => {
          themes.forEach(t => document.body.classList.remove(t.body));
          const found = themes.find(t => t.key === k) || themes[0];
          document.body.classList.add(found.body);
          try { localStorage.setItem('crm.lv2.theme', k); } catch (_) {}
        };
        _applyTheme(current);
        // v3.18 — bail out on mobile AFTER applying the saved theme so
        // colors stay consistent, but the picker UI is hidden.
        if (_isMobile) return null;
        const swatchRow = h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '14px' }, title: 'Theme — click a color to change' });
        swatchRow.appendChild(h('span', { style: { fontSize: '10px', color: '#94a3b8', marginRight: '2px' } }, '🎨'));
        themes.forEach(t => {
          swatchRow.appendChild(h('button', {
            title: t.label,
            style: { width: '14px', height: '14px', borderRadius: '50%', background: t.color, border: t.key === current ? '2px solid #1e293b' : '2px solid transparent', cursor: 'pointer', padding: '0', boxShadow: t.key === current ? '0 0 0 1px white inset' : 'none' },
            onclick: (e) => { e.stopPropagation(); _applyTheme(t.key); /* repaint swatch borders */ setTimeout(load, 0); }
          }));
        });
        return swatchRow;
      })(),
      h('button', { class: 'qchip', onclick: load }, '↻ Refresh'),
      h('button', { class: 'qchip' }, '↓ Export'),
      h('button', { class: 'qchip', style: { background: '#1e293b', color: 'white', borderColor: '#1e293b', cursor: 'pointer' },
        onclick: () => { try { if (typeof window.openLeadModal === 'function') window.openLeadModal(); else toast('New Lead modal not available', 'err'); } catch (e) { toast('Could not open: ' + e.message, 'err'); } }
      }, '＋ New Lead')));
    if (!_useV4Hdr && !S.focusMode) wrap.appendChild(qchips);

    // Table
    const tblWrap = h('div', { class: 'tbl-wrap', id: 'lv2-tbl-wrap' });
    tblWrap.appendChild(renderModernTable());
    wrap.appendChild(tblWrap);

    view.appendChild(wrap);
    // v3.4 — Ask AI floating pill removed per user request
  }
  function hcell(lab, val, ch, isDn, color) {
    return h('div', { class: 'hcell' },
      h('div', { class: 'lab' }, lab),
      h('div', { class: 'val', style: color ? { color } : null }, String(val).toLocaleString ? Number(val).toLocaleString('en-IN') : val),
      ch ? h('div', { class: 'ch' + (isDn ? ' dn' : '') }, ch) : null);
  }
  function miniStat(label, val, color) {
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' } },
      h('span', { style: { color: '#64748b' } }, label),
      h('b', { style: { color: color || '#0f172a', fontSize: '12px', fontWeight: '700' } },
        Number(val).toLocaleString('en-IN')));
  }
  function rerenderRows() {
    const w = $('#lv2-tbl-wrap');
    if (!w) return;
    w.innerHTML = '';
    w.appendChild(renderModernTable());
  }
  function renderModernTable() {
    const rows = filtered();
    const pageSize = Number(S.pageSize) || 25;
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    if (S.page > totalPages) S.page = totalPages;
    if (S.page < 1) S.page = 1;
    const startIdx = (S.page - 1) * pageSize;
    const pageRows = rows.slice(startIdx, startIdx + pageSize);

    const container = h('div');
    const tbl = h('table');
    const vc = new Set(Array.isArray(S.visibleColumns) ? S.visibleColumns : []);
    const headerRow = h('tr', null,
      h('th', { class: 'sticky-l', style: { width: '36px' } }, h('input', { type: 'checkbox' })),
      h('th', { class: 'sticky-l', style: { left: '36px' } }, 'Name'));
    if (vc.has('phone'))    headerRow.appendChild(h('th', null, 'Phone & actions'));
    if (vc.has('source'))   headerRow.appendChild(h('th', null, 'Source'));
    if (vc.has('status'))   headerRow.appendChild(h('th', null, 'Status'));
    if (vc.has('owner'))    headerRow.appendChild(h('th', null, 'Owner'));
    if (vc.has('score'))    headerRow.appendChild(h('th', null, '🤖 AI Score'));
    if (vc.has('aistep'))   headerRow.appendChild(h('th', null, '✨ AI Next Step'));
    if (vc.has('followup')) headerRow.appendChild(h('th', null, '⏰ Follow-up'));
    if (vc.has('lastwa'))   headerRow.appendChild(h('th', null, '💬 Last WhatsApp'));
    if (vc.has('notes'))    headerRow.appendChild(h('th', null, '📝 Notes'));
    if (vc.has('email'))    headerRow.appendChild(h('th', null, '📧 Email'));
    if (vc.has('tags'))     headerRow.appendChild(h('th', null, '🔖 Tags'));
    if (vc.has('city'))     headerRow.appendChild(h('th', null, '🗺 City'));
    if (vc.has('product'))  headerRow.appendChild(h('th', null, '📦 Product'));
    if (vc.has('activity')) headerRow.appendChild(h('th', null, 'Activity'));
    if (vc.has('created'))  headerRow.appendChild(h('th', null, 'Created'));
    const thead = h('thead', null, headerRow);
    tbl.appendChild(thead);
    const tbody = h('tbody');
    pageRows.forEach(l => tbody.appendChild(renderModernRow(l)));
    if (!rows.length) {
      const totalCols = 2 + (Array.isArray(S.visibleColumns) ? S.visibleColumns.length : 8);
      tbody.appendChild(h('tr', null, h('td', { colspan: totalCols, style: { padding: '40px', textAlign: 'center', color: '#94a3b8' } }, 'No leads match your filter.')));
    }
    tbl.appendChild(tbody);
    container.appendChild(tbl);

    // Pagination bar
    container.appendChild(renderPagination(rows.length, totalPages));
    return container;
  }

  function renderPagination(totalRows, totalPages) {
    const bar = h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', background: '#fafbfc', borderTop: '1px solid #e2e8f0', fontSize: '11.5px', color: '#64748b', position: 'sticky', bottom: '0' } });
    // Left — count + page size
    const left = h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      h('span', null, 'Showing ' + ((S.page - 1) * S.pageSize + 1) + '–' + Math.min(totalRows, S.page * S.pageSize) + ' of ' + totalRows));
    const sizeSel = h('select', {
      style: { padding: '3px 8px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '11px', background: 'white', cursor: 'pointer' },
      onchange: (e) => {
        S.pageSize = Number(e.target.value) || 25;
        try { localStorage.setItem('crm.lv2.pageSize', String(S.pageSize)); } catch(_){}
        S.page = 1;
        rerenderRows();
      }
    });
    [25, 50, 100, 200, 500].forEach(n => sizeSel.appendChild(h('option', { value: n, selected: n === S.pageSize ? 'selected' : null }, n + ' per page')));
    left.appendChild(sizeSel);
    bar.appendChild(left);

    // Right — page nav
    const right = h('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } });
    const pageBtn = (lab, p, disabled, isActive) => h('button', {
      style: {
        padding: '4px 10px',
        background: isActive ? '#1e293b' : 'white',
        color: isActive ? 'white' : (disabled ? '#cbd5e1' : '#475569'),
        border: '1px solid ' + (isActive ? '#1e293b' : '#e2e8f0'),
        borderRadius: '5px',
        fontSize: '11px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        minWidth: '28px',
        fontWeight: isActive ? '600' : '500',
        opacity: disabled ? '0.5' : '1'
      },
      onclick: disabled ? null : () => { S.page = p; rerenderRows(); }
    }, lab);
    right.appendChild(pageBtn('«', 1, S.page === 1));
    right.appendChild(pageBtn('‹', Math.max(1, S.page - 1), S.page === 1));
    // Page numbers — show window of 5 around current
    const winStart = Math.max(1, S.page - 2);
    const winEnd = Math.min(totalPages, winStart + 4);
    if (winStart > 1) right.appendChild(h('span', { style: { padding: '0 4px', color: '#94a3b8' } }, '…'));
    for (let p = winStart; p <= winEnd; p++) {
      right.appendChild(pageBtn(String(p), p, false, p === S.page));
    }
    if (winEnd < totalPages) right.appendChild(h('span', { style: { padding: '0 4px', color: '#94a3b8' } }, '…'));
    right.appendChild(pageBtn('›', Math.min(totalPages, S.page + 1), S.page === totalPages));
    right.appendChild(pageBtn('»', totalPages, S.page === totalPages));
    right.appendChild(h('span', { style: { fontSize: '11px', color: '#94a3b8', marginLeft: '8px' } }, 'Page ' + S.page + ' / ' + totalPages));
    bar.appendChild(right);
    return bar;
  }
  // v3.13 — Bulk action bar that slides up from bottom when any leads selected.
  function renderBulkBar() {
    const existing = document.getElementById('lv2-bulkbar');
    const sel = S.bulkSel || new Set();
    const count = sel.size;
    if (existing) existing.remove();
    if (!count) return;
    const bar = h('div', { id: 'lv2-bulkbar', style: {
      position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
      background: '#0f172a', color: 'white', padding: '10px 16px', borderRadius: '40px',
      boxShadow: '0 10px 30px rgba(0,0,0,.25)', zIndex: '9999',
      display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', fontWeight: '600',
      animation: 'lv2-bulk-pop .25s ease-out'
    } },
      h('span', { style: { background: '#1e293b', padding: '4px 10px', borderRadius: '12px', fontSize: '12px' } }, String(count) + ' selected'),
      h('button', { style: bulkBtn(), title: 'Assign to user', onclick: () => bulkAction('assign') }, '👤 Assign'),
      h('button', { style: bulkBtn(), title: 'Change status', onclick: () => bulkAction('status') }, '🎯 Status'),
      h('button', { style: bulkBtn(), title: 'Add tag', onclick: () => bulkAction('tag') }, '🔖 Tag'),
      h('button', { style: bulkBtn(), title: 'Share with user', onclick: () => bulkAction('share') }, '🤝 Share'),
      h('button', { style: bulkBtn(), title: 'Send WA template via API', onclick: () => bulkAction('waapi') }, '💬 WA API'),
      h('button', { style: bulkBtn(), title: 'Export CSV', onclick: () => bulkAction('export') }, '↓ Export'),
      h('button', { style: bulkBtn('danger'), title: 'Delete', onclick: () => bulkAction('delete') }, '🗑 Delete'),
      h('button', { style: { background: 'transparent', color: '#94a3b8', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '0 4px' }, title: 'Clear selection', onclick: () => { S.bulkSel.clear(); document.querySelectorAll('input[type=checkbox]').forEach(c => c.checked = false); renderBulkBar(); } }, '✕')
    );
    document.body.appendChild(bar);
  }
  function bulkBtn(kind) {
    return {
      background: kind === 'danger' ? '#dc2626' : '#334155', color: 'white',
      border: 'none', borderRadius: '20px', padding: '6px 12px', cursor: 'pointer',
      fontSize: '12px', fontWeight: '600'
    };
  }
  // v3.14 — Show a small modal with a real <select> instead of prompt()
  function _bulkModal(title, body, onSubmit) {
    const ov = h('div', { style: { position: 'fixed', inset: '0', background: 'rgba(15,23,42,.5)', zIndex: '99999', display: 'flex', alignItems: 'center', justifyContent: 'center' }, onclick: (e) => { if (e.target === ov) ov.remove(); } });
    const card = h('div', { style: { background: 'white', borderRadius: '12px', padding: '20px', minWidth: '340px', maxWidth: '440px', boxShadow: '0 25px 60px rgba(0,0,0,.3)' } },
      h('h3', { style: { margin: '0 0 14px', fontSize: '15px', color: '#0f172a' } }, title),
      body,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'flex-end' } },
        h('button', { style: { padding: '8px 16px', background: 'white', border: '1px solid #cbd5e1', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }, onclick: () => ov.remove() }, 'Cancel'),
        h('button', { style: { padding: '8px 16px', background: '#0f172a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }, onclick: () => { onSubmit(); ov.remove(); } }, 'Apply')));
    ov.appendChild(card); document.body.appendChild(ov);
  }

  function bulkAction(action) {
    const ids = Array.from(S.bulkSel || []);
    if (!ids.length) return;
    try {
      if (action === 'export') {
        const headers = ['Name','Phone','Email','Status','Owner','Source'];
        const rows = ids.map(id => {
          const l = (S.leads || []).find(x => Number(x.id) === Number(id)) || {};
          return [l.name||'', l.phone||'', l.email||'', l.status_name||'', l.assigned_name||'', l.source||''].map(v => '"' + String(v).replace(/"/g,'""') + '"').join(',');
        });
        const csv = headers.join(',') + '\n' + rows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'leads-selected-' + ids.length + '.csv'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
      if (action === 'assign') {
        const sel = h('select', { style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px' } },
          h('option', { value: '' }, '— Select user —'),
          ...(S.users || []).map(u => h('option', { value: u.id }, u.name)));
        _bulkModal('Assign ' + ids.length + ' leads', sel, () => {
          const uid = sel.value; if (!uid) return;
          api('api_leads_bulkUpdate', ids, { assigned_to: Number(uid) }).then(() => { toast('✓ Assigned ' + ids.length + ' leads', 'ok'); S.bulkSel.clear(); load(); renderBulkBar(); }).catch(e => toast(e.message, 'err'));
        });
        return;
      }
      if (action === 'status') {
        const sel = h('select', { style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px' } },
          h('option', { value: '' }, '— Select status —'),
          ...(S.statuses || []).map(s => h('option', { value: s.id }, s.name)));
        _bulkModal('Change status for ' + ids.length + ' leads', sel, () => {
          const sid = sel.value; if (!sid) return;
          api('api_leads_bulkUpdate', ids, { status_id: Number(sid) }).then(() => { toast('✓ Updated ' + ids.length + ' leads', 'ok'); S.bulkSel.clear(); load(); renderBulkBar(); }).catch(e => toast(e.message, 'err'));
        });
        return;
      }
      if (action === 'tag') {
        const inp = h('input', { type: 'text', placeholder: 'Tag name', style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px' } });
        _bulkModal('Add tag to ' + ids.length + ' leads', inp, () => {
          const tag = String(inp.value || '').trim(); if (!tag) return;
          api('api_leads_bulkUpdate', ids, { add_tag: tag }).catch(() =>
            Promise.all(ids.map(id => api('api_leads_addTag', { lead_id: id, tag: tag }).catch(()=>{})))).then(() => { toast('✓ Tagged ' + ids.length + ' leads', 'ok'); S.bulkSel.clear(); load(); renderBulkBar(); });
        });
        return;
      }
      if (action === 'share') {
        const sel = h('select', { style: { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', fontSize: '13px' } },
          h('option', { value: '' }, '— Select user to share with —'),
          ...(S.users || []).map(u => h('option', { value: u.id }, u.name)));
        _bulkModal('Share ' + ids.length + ' leads with…', sel, () => {
          const uid = sel.value; if (!uid) return;
          api('api_leads_bulkShare', ids, Number(uid)).then(() => { toast('✓ Shared ' + ids.length + ' leads', 'ok'); S.bulkSel.clear(); load(); renderBulkBar(); }).catch(e => toast(e.message, 'err'));
        });
        return;
      }
      if (action === 'waapi') {
        // Best-effort: queue a WA template send by opening Classic's bulk WA flow.
        if (window.CRM && typeof window.CRM.bulkSendWaTemplate === 'function') {
          window.CRM.bulkSendWaTemplate(ids); return;
        }
        toast('WA API bulk send — please use Classic view\'s "Send WA Template" for now', 'err');
        return;
      }
      if (action === 'delete') {
        if (!confirm('Delete ' + ids.length + ' leads? This cannot be undone.')) return;
        api('api_leads_bulkDelete', ids).then(() => { toast('✓ Deleted ' + ids.length + ' leads', 'ok'); S.bulkSel.clear(); load(); renderBulkBar(); }).catch(e => toast(e.message, 'err'));
        return;
      }
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderModernRow(l) {
    const name = l.name || l.phone || '—';
    const stat = statusClass(l.status_name);
    const score = Number(l.smart_score || 0);
    const bucket = scoreBucket(score);
    const isSelected = S.selectedId === l.id;
    const tr = h('tr', { class: (isSelected ? 'selected ' : '') + (bucket ? 'bucket-' + bucket : ''), onclick: () => openSlideOver(l) });
    const vc = new Set(Array.isArray(S.visibleColumns) ? S.visibleColumns : []);
    // v3.13 — checkbox now wires to S.bulkSel set + repaints bulk bar
    if (!S.bulkSel) S.bulkSel = new Set();
    const isInBulk = S.bulkSel.has(l.id);
    tr.appendChild(h('td', { class: 'sticky-l', onclick: (e) => e.stopPropagation() },
      h('input', { type: 'checkbox', checked: isInBulk ? 'checked' : null,
        onchange: (e) => {
          if (e.target.checked) S.bulkSel.add(l.id); else S.bulkSel.delete(l.id);
          renderBulkBar();
        } })));
    tr.appendChild(h('td', { class: 'sticky-l', style: { left: '36px' } },
      h('div', { class: 'lv2-namecell' },
        h('div', { class: 'lv2-av', style: { background: avColor(name), position: 'relative' } },
          initials(name),
          // v3.12 — green dot overlay when customer was last to WhatsApp
          (l.last_wa_direction === 'in') ? h('span', {
            style: { position: 'absolute', top: '-2px', right: '-2px', width: '10px', height: '10px', background: '#22c55e', border: '2px solid white', borderRadius: '50%', boxShadow: '0 1px 2px rgba(34,197,94,.5)' },
            title: 'Customer was last to WhatsApp — needs your reply'
          }) : null),
        h('div', { class: 'lv2-namestack' },
          h('span', { class: 'lv2-nm' }, name),
          // v3.6 — Heat chip from WA AI Bot (cold/warm/hot/very_hot/on_fire) +
          // Show history button when lead is_duplicate. Both mirror Classic.
          (function () {
            const badges = [];
            const heatMap = {
              cold:     { emoji: '❄️',     bg: '#dbeafe', fg: '#1e40af', label: 'Cold' },
              warm:     { emoji: '✨',     bg: '#fef3c7', fg: '#92400e', label: 'Warm' },
              hot:      { emoji: '🔥',     bg: '#fed7aa', fg: '#9a3412', label: 'Hot' },
              very_hot: { emoji: '🔥🔥',   bg: '#fecaca', fg: '#991b1b', label: 'Very hot' },
              on_fire:  { emoji: '🔥🔥🔥', bg: '#fca5a5', fg: '#7f1d1d', label: 'ON FIRE' }
            };
            if (l.heat_label && heatMap[l.heat_label]) {
              const m = heatMap[l.heat_label];
              const action = l.heat_action_required ? ' · ' + String(l.heat_action_required).replace(/_/g, ' ') : '';
              const tip = 'AI Bot Heat ' + (l.heat_score || 0) + '/100 — ' + (l.heat_signal || m.label) + action;
              badges.push(h('span', {
                style: { display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '2px 8px', borderRadius: '10px', background: m.bg, color: m.fg, fontWeight: '700', fontSize: '10px', cursor: 'help' },
                title: tip
              }, m.emoji + ' ' + m.label));
            } else if (score >= 80) {
              // Fallback: if no heat_label but smart_score is hot, show HOT
              badges.push(h('span', { class: 'lv2-badge fire' }, '🔥 HOT'));
            }
            // v3.12 — WhatsApp 'customer waiting for reply' indicator.
            // Shows a small green WhatsApp pill on the lead row whenever the
            // LAST WA message in that thread was inbound (customer was the
            // last to message). Mirrors what WA Inbox shows. Tooltip carries
            // the preview text + timestamp for at-a-glance context.
            if (l.last_wa_direction === 'in' && l.last_wa_at) {
              const wasAt = new Date(l.last_wa_at);
              const tip = '💬 New WhatsApp from customer · ' + (wasAt.toLocaleString('en-IN') || '') +
                          (l.last_wa_text ? '\n\n"' + String(l.last_wa_text).slice(0, 120) + '"' : '');
              badges.push(h('button', {
                title: tip,
                style: { padding: '2px 8px', fontSize: '10px', fontWeight: '700', background: '#dcfce7', color: '#15803d', border: '1px solid #86efac', borderRadius: '10px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '3px' },
                onclick: (e) => { e.stopPropagation(); try { (window.openDuplicateHistory || function(){})(l.id); } catch (_) {} /* open slide-over */ try { openSlideOver(l); } catch (_) {} }
              }, '💬 NEW WA'));
            }
            if (l.is_duplicate) {
              badges.push(h('button', {
                title: 'Click to see all past leads for this phone number',
                style: { padding: '1px 7px', fontSize: '9px', fontWeight: '700', background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b', borderRadius: '4px', cursor: 'pointer' },
                onclick: (e) => { e.stopPropagation(); try { (window.openDuplicateHistory || function(){})(l.id); } catch (_) {} }
              }, '🕘 Show history'));
            }
            return badges.length ? h('div', { class: 'lv2-badges', style: { display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', marginTop: '2px' } }, ...badges) : null;
          })()))));
    if (vc.has('phone')) {
      tr.appendChild(h('td', null,
        h('div', { class: 'lv2-phonecell' },
          h('span', { class: 'lv2-ph' }, l.phone || '—'),
          h('div', { class: 'lv2-actions', onclick: (e) => e.stopPropagation() },
            h('button', { class: 'lv2-act call', title: 'Click-to-Call', onclick: () => doCall(l) }, '📞'),
            h('button', { class: 'lv2-act sim', title: 'Mobile SIM', onclick: () => doSim(l) }, '📱'),
            h('button', { class: 'lv2-act wa', title: 'WhatsApp Web', onclick: () => doWaWeb(l) }, '💬'),
            h('button', { class: 'lv2-act api', title: 'Send via WhatsApp Cloud API (SmartCRM chat)', onclick: () => doWaApi(l) },
              h('span', { html: '<svg width="13" height="13" viewBox="0 0 32 32" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M16 0C7.2 0 0 7.2 0 16c0 2.8.7 5.5 2.1 7.9L0 32l8.3-2.2c2.3 1.3 4.9 1.9 7.7 1.9 8.8 0 16-7.2 16-16S24.8 0 16 0zm0 29.3c-2.5 0-4.9-.7-7-1.9l-.5-.3-5.2 1.4 1.4-5.1-.3-.5C3.2 20.7 2.7 18.4 2.7 16 2.7 8.7 8.7 2.7 16 2.7s13.3 6 13.3 13.3-6 13.3-13.3 13.3zm7.3-9.9c-.4-.2-2.4-1.2-2.7-1.3-.4-.1-.6-.2-.9.2-.3.4-1 1.3-1.2 1.5-.2.2-.4.3-.8.1-2.4-1.2-3.9-2.1-5.5-4.8-.4-.7.4-.7 1.2-2.2.1-.2.1-.5 0-.7-.1-.2-.9-2.2-1.3-3-.3-.8-.7-.7-.9-.7-.2 0-.5 0-.8 0-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.4 0 2 1.5 3.9 1.7 4.2.2.3 2.9 4.5 7.1 6.3 2.6 1.1 3.6 1.2 4.9 1 .8-.1 2.4-1 2.7-1.9.3-1 .3-1.8.2-1.9 0-.2-.3-.3-.7-.5z"/></svg>', style: { display: 'inline-flex' } })),
            h('button', { class: 'lv2-act ai', title: 'AI Quick Note — type status + remark + follow-up time', onclick: () => aiQuickNote(l) }, '🤖'),
            h('button', { class: 'lv2-act copy', title: 'Copy phone', onclick: () => doCopy(l) }, '📋')))));
    }
    if (vc.has('source')) tr.appendChild(h('td', null, h('span', { class: 'lv2-muted' }, l.source || '—')));
    if (vc.has('status')) {
      tr.appendChild(h('td', { onclick: (e) => e.stopPropagation() },
        h('div', { class: 'lv2-status', style: { cursor: 'pointer', padding: '4px 8px', borderRadius: '5px', display: 'inline-flex' },
          title: 'Click to change status',
          onmouseenter: function () { this.style.background = '#f1f5f9'; },
          onmouseleave: function () { this.style.background = 'transparent'; },
          onclick: (e) => { e.stopPropagation(); openStatusPicker(e.currentTarget, l); }
        },
          h('span', { class: 'lv2-dot ' + stat }),
          h('span', { class: 'lv2-stext' }, l.status_name || '—'),
          h('span', { style: { color: '#cbd5e1', marginLeft: '4px', fontSize: '10px' } }, '▾'))));
    }
    if (vc.has('owner'))  tr.appendChild(h('td', null, l.assigned_name ? h('div', { class: 'lv2-namecell' }, h('div', { class: 'lv2-av s', style: { background: avColor(l.assigned_name) } }, initials(l.assigned_name)), h('span', { style: { fontSize: '12px' } }, l.assigned_name)) : h('span', { class: 'lv2-muted' }, '—')));
    if (vc.has('score')) {
      const reason = l.score_reason || l.smart_reason || '';
      const tipText = score
        ? ('AI Score: ' + score + ' · ' + bucket.toUpperCase() + (reason ? '\n\nWhy:\n' + reason : '\n\n(No reason recorded)'))
        : 'No AI score yet';
      tr.appendChild(h('td', null,
        score
          ? h('span', { class: 'lv2-scorechip ' + bucket, title: tipText, onmouseenter: (e) => showScoreTip(e.currentTarget, l) }, String(score) + ' · ' + bucket.toUpperCase())
          : h('span', { class: 'lv2-muted', title: tipText }, '—')));
    }
    if (vc.has('aistep'))   tr.appendChild(h('td', null, h('div', { class: 'lv2-aisum' }, aiHint(l))));
    if (vc.has('followup')) {
      const overdue = l.next_followup_at && new Date(l.next_followup_at) < new Date();
      tr.appendChild(h('td', null, l.next_followup_at
        ? h('span', { style: { fontSize: '11.5px', color: overdue ? '#b91c1c' : '#0f172a', fontWeight: overdue ? '600' : '500' } },
            '📅 ' + new Date(l.next_followup_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
        : h('span', { class: 'lv2-muted' }, '—')));
    }
    // v3.14 — broader filter: 'Auto Lead Capture' may have bullet/whitespace
    // prefix ('• Auto Lead Capture …'), or appear inside the body. Strip
    // common leading punctuation before testing, AND test 'contains'.
    if (vc.has('lastwa')) {
      let waMsg = l.last_wa_message || l.last_wa_text || '';
      if (waMsg) {
        const raw = String(waMsg).trim();
        const stripped = raw.replace(/^[\s•·*\-—:]+/, '').trim();
        if (/Auto Lead Capture/i.test(raw) || stripped.length > 220) waMsg = '';
      }
      const waDir = l.last_wa_direction || '';
      const arrow = waDir === 'in' ? '⬅ ' : waDir === 'out' ? '➡ ' : '';
      tr.appendChild(h('td', null,
        waMsg
          ? h('span', { class: 'lv2-muted', style: { maxWidth: '200px', display: 'inline-block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle', color: waDir === 'in' ? '#15803d' : '#475569' }, title: arrow + waMsg }, arrow + waMsg)
          : h('span', { class: 'lv2-muted', style: { color: '#cbd5e1' } }, '—')));
    }
    if (vc.has('notes'))    tr.appendChild(h('td', null, h('span', { class: 'lv2-muted', style: { maxWidth: '220px', display: 'inline-block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'middle' }, title: l.notes || '' }, String(l.notes || '—').slice(0, 60))));
    if (vc.has('email'))    tr.appendChild(h('td', null, h('span', { class: 'lv2-muted', style: { fontSize: '11px' } }, l.email || '—')));
    if (vc.has('tags'))     tr.appendChild(h('td', null, h('span', { class: 'lv2-muted', style: { fontSize: '11px' } }, l.tags || '—')));
    if (vc.has('city'))     tr.appendChild(h('td', null, h('span', { class: 'lv2-muted' }, l.city || '—')));
    if (vc.has('product'))  tr.appendChild(h('td', null, h('span', { class: 'lv2-muted' }, l.product_name || '—')));
    // v3.10 — Activity + Created columns show full date+time+relative:
    // "20 Jun, 2:58 PM (1d)". Title attr also lets user hover to see
    // year + seconds for absolute precision.
    if (vc.has('activity')) {
      const aIso = l.last_activity_at || l.updated_at;
      tr.appendChild(h('td', null, h('span', { class: 'lv2-muted', title: aIso ? new Date(aIso).toLocaleString('en-IN') : '' }, fmtDateTimeRel(aIso))));
    }
    if (vc.has('created'))  {
      tr.appendChild(h('td', null, h('span', { class: 'lv2-muted', title: l.created_at ? new Date(l.created_at).toLocaleString('en-IN') : '' }, fmtDateTimeRel(l.created_at))));
    }
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

  function openStatusPicker(anchorEl, lead) {
    _closePopovers();
    try {
      const r = anchorEl.getBoundingClientRect();
      const pop = h('div', { class: 'lv2-popover', style: {
        position: 'fixed', top: (r.bottom + 4) + 'px', left: Math.max(8, r.left) + 'px',
        background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px',
        boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: '6px', minWidth: '180px',
        maxHeight: '320px', overflowY: 'auto', zIndex: '9999'
      } });
      pop.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.4px', padding: '4px 8px 6px' } }, 'Change status'));
      (Array.isArray(S.statuses) ? S.statuses : []).forEach(s => {
        const isCurrent = Number(s.id) === Number(lead.status_id);
        const sc = statusClass(s.name);
        pop.appendChild(h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
            cursor: 'pointer', borderRadius: '5px', fontSize: '12px',
            background: isCurrent ? '#eef2ff' : 'transparent',
            color: isCurrent ? '#4338ca' : '#0f172a',
            fontWeight: isCurrent ? '600' : '500'
          },
          onmouseover: function () { if (!isCurrent) this.style.background = '#f8fafc'; },
          onmouseout:  function () { if (!isCurrent) this.style.background = 'transparent'; },
          onclick: async () => {
            _closePopovers();
            try {
              await api('api_leads_update', lead.id, { status_id: s.id });
              lead.status_id = s.id;
              lead.status_name = s.name;
              toast('Status: ' + s.name, 'ok');
              rerenderRows();
            } catch (e) { toast(e.message, 'err'); }
          }
        },
          h('span', { class: 'lv2-dot ' + sc, style: { width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block' } }),
          h('span', null, s.name),
          isCurrent ? h('span', { style: { marginLeft: 'auto', color: '#4338ca', fontSize: '11px' } }, '✓') : null));
      });
      document.body.appendChild(pop);
      setTimeout(() => {
        const off = (e) => { if (!pop.contains(e.target)) { _closePopovers(); document.removeEventListener('click', off); } };
        document.addEventListener('click', off);
      }, 50);
    } catch (e) { console.warn('[LEADS_V2] openStatusPicker failed:', e.message); }
  }

  let _scoreTipEl = null;
  function showScoreTip(el, lead) {
    try {
      if (_scoreTipEl) { _scoreTipEl.remove(); _scoreTipEl = null; }
      const score = Number(lead.smart_score || 0);
      const bucket = score >= 80 ? 'hot' : score >= 50 ? 'warm' : score > 0 ? 'cold' : '';
      const reason = lead.score_reason || lead.smart_reason || '';
      if (!score && !reason) return;
      const r = el.getBoundingClientRect();
      const tip = h('div', {
        style: {
          position: 'fixed', top: (r.bottom + 6) + 'px', left: Math.max(8, r.left - 100) + 'px',
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0,0,0,.12)', padding: '10px 12px',
          fontSize: '11.5px', color: '#1e293b', maxWidth: '320px', zIndex: '9999',
          lineHeight: '1.5'
        }
      },
        h('div', { style: { fontWeight: '700', marginBottom: '4px', color: bucket === 'hot' ? '#b91c1c' : bucket === 'warm' ? '#b45309' : '#1e40af' } },
          (bucket === 'hot' ? '🔥' : bucket === 'warm' ? '☀️' : '🧊') + ' AI Score ' + score + ' · ' + bucket.toUpperCase()),
        h('div', { style: { fontSize: '10px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '.3px', fontWeight: '700', marginTop: '6px', marginBottom: '4px' } }, '✨ Why AI tagged this:'),
        h('div', { style: { whiteSpace: 'pre-wrap', color: '#475569' } }, reason || 'No reason recorded — recompute the score to refresh.'));
      document.body.appendChild(tip);
      _scoreTipEl = tip;
      const off = () => { if (_scoreTipEl) { _scoreTipEl.remove(); _scoreTipEl = null; } el.removeEventListener('mouseleave', off); };
      el.addEventListener('mouseleave', off);
    } catch (e) { console.warn('[LEADS_V2] showScoreTip failed:', e.message); }
  }

  /* ---------- slide-over (v1.7 — rich with timeline / AI summary / last WA / last call + recording) ---------- */
  function openSlideOver(l) {
    S.selectedId = l.id;
    closeSlideOver();
    const score = Number(l.smart_score || 0);
    const bucket = score >= 80 ? 'hot' : score >= 50 ? 'warm' : score > 0 ? 'cold' : '';
    const bucketLab = bucket === 'hot' ? '🔥 HOT' : bucket === 'warm' ? '☀️ WARM' : bucket === 'cold' ? '🧊 COLD' : '';
    const so = h('aside', { class: 'lv2-slideover bucket-' + (bucket || 'none'), id: 'lv2-slideover' });
    const name = l.name || l.phone || '—';
    so.appendChild(h('div', { class: 'lv2-so-head bucket-' + (bucket || 'none') },
      h('div', { class: 'lv2-av', style: { background: avColor(name) } }, initials(name)),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, name,
          bucket ? h('span', { class: 'lv2-scorechip ' + bucket, style: { marginLeft: '8px', fontSize: '10px', verticalAlign: 'middle', cursor: 'help' },
            title: 'AI Score: ' + score + ' · ' + bucketLab + (l.score_reason ? '\n\nWhy:\n' + l.score_reason : '') }, score + ' · ' + bucketLab) : null),
        h('div', { class: 'sub' }, (l.phone ? '📞 ' + l.phone : '') + (l.email ? ' · 📧 ' + l.email : '') + ' · created ' + fmtDateTimeRel(l.created_at))),
      h('div', { class: 'x', onclick: closeSlideOver }, '✕')));

    const body = h('div', { class: 'lv2-so-body', id: 'lv2-so-body' });
    so.appendChild(body);
    document.body.appendChild(so);

    // ---- Synchronous (immediate) content ----
    // Quick actions — v1.8: Call / WA Web / WA API / Quotation / Note / Open
    body.appendChild(h('div', { class: 'lv2-so-quick', style: { gridTemplateColumns: 'repeat(3, 1fr)' } },
      h('button', { onclick: () => doCall(l), title: 'Click-to-Call (web telephony)' },
        h('span', { class: 'ic' }, '📞'), 'Call'),
      h('button', { onclick: () => doWaWeb(l), title: 'WhatsApp Web (wa.me link)' },
        h('span', { class: 'ic' }, '💬'), 'WA Web'),
      h('button', { onclick: () => doWaApi(l), title: 'WhatsApp Cloud API — send via SmartCRM',
        style: { background: 'linear-gradient(135deg, #dcfce7, #bbf7d0)', color: '#15803d', borderColor: '#86efac' } },
        h('span', { class: 'ic', html: '<svg width="13" height="13" viewBox="0 0 32 32" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M16 0C7.2 0 0 7.2 0 16c0 2.8.7 5.5 2.1 7.9L0 32l8.3-2.2c2.3 1.3 4.9 1.9 7.7 1.9 8.8 0 16-7.2 16-16S24.8 0 16 0zm0 29.3c-2.5 0-4.9-.7-7-1.9l-.5-.3-5.2 1.4 1.4-5.1-.3-.5C3.2 20.7 2.7 18.4 2.7 16 2.7 8.7 8.7 2.7 16 2.7s13.3 6 13.3 13.3-6 13.3-13.3 13.3zm7.3-9.9c-.4-.2-2.4-1.2-2.7-1.3-.4-.1-.6-.2-.9.2-.3.4-1 1.3-1.2 1.5-.2.2-.4.3-.8.1-2.4-1.2-3.9-2.1-5.5-4.8-.4-.7.4-.7 1.2-2.2.1-.2.1-.5 0-.7-.1-.2-.9-2.2-1.3-3-.3-.8-.7-.7-.9-.7-.2 0-.5 0-.8 0-.3 0-.7.1-1.1.5-.4.4-1.4 1.4-1.4 3.4 0 2 1.5 3.9 1.7 4.2.2.3 2.9 4.5 7.1 6.3 2.6 1.1 3.6 1.2 4.9 1 .8-.1 2.4-1 2.7-1.9.3-1 .3-1.8.2-1.9 0-.2-.3-.3-.7-.5z"/></svg>', style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }), 'WA API'),
      h('button', { onclick: () => doQuotation(l), title: 'Create or send a quotation',
        style: { background: 'linear-gradient(135deg, #fef3c7, #fde68a)', color: '#92400e', borderColor: '#fde68a' } },
        h('span', { class: 'ic' }, '📋'), 'Quotation'),
      h('button', { onclick: () => doAddNote(l) }, h('span', { class: 'ic' }, '📝'), 'Note'),
      h('button', { onclick: () => doViewFull(l) }, h('span', { class: 'ic' }, '👁'), 'Open')));

    // AI Suggested Next Step (heuristic — instant)
    body.appendChild(h('div', { class: 'lv2-so-card ai' },
      h('h3', null, '✨ AI Suggested Next Step'),
      h('div', { class: 'txt' }, aiHint(l))));

    // AI Summary card — AUTO-fetches on open
    body.appendChild(h('div', { class: 'lv2-so-card', id: 'lv2-so-aisum',
      style: { background: 'linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%)', borderColor: '#c7d2fe' } },
      h('h3', { style: { color: '#4338ca' } }, '🤖 AI Summary'),
      h('div', { id: 'lv2-so-aisum-body', style: { fontSize: '12px', color: '#64748b', lineHeight: '1.5' } },
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
          h('span', { style: { width: '12px', height: '12px', border: '2px solid #c7d2fe', borderTopColor: '#6366f1', borderRadius: '50%', display: 'inline-block', animation: 'lv2spin 0.7s linear infinite' } }),
          '✨ Generating AI summary…'))));

    // QUICK EDIT card — compact inline controls for Status / Follow-up / Owner / Add Note
    const inputStyle = { padding: '4px 8px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '5px', fontSize: '11.5px', color: '#0f172a', outline: 'none', width: '100%', boxSizing: 'border-box' };
    const labStyle = { fontSize: '9.5px', fontWeight: '700', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.3px', marginBottom: '3px', display: 'block' };

    body.appendChild(h('div', { class: 'lv2-so-card', style: { padding: '10px 12px' } },
      h('h3', { style: { margin: '0 0 8px' } }, '⚡ Quick Edit'),
      // Status dropdown
      h('div', { style: { marginBottom: '8px' } },
        h('span', { style: labStyle }, '🎯 Status'),
        (() => {
          const sel = h('select', {
            style: inputStyle,
            onchange: async (e) => {
              const v = Number(e.target.value);
              try { await api('api_leads_update', l.id, { status_id: v }); l.status_id = v; const newSt = (S.statuses || []).find(s => Number(s.id) === v); l.status_name = newSt ? newSt.name : l.status_name; toast('Status updated', 'ok'); rerenderRows(); } catch (err) { toast(err.message, 'err'); }
            }
          });
          (Array.isArray(S.statuses) ? S.statuses : []).forEach(s => sel.appendChild(h('option', { value: s.id, selected: Number(s.id) === Number(l.status_id) ? 'selected' : null }, s.name)));
          return sel;
        })()),
      // Next Follow-up Date
      h('div', { style: { marginBottom: '8px' } },
        h('span', { style: labStyle }, '⏰ Next Follow-up'),
        h('input', {
          type: 'datetime-local',
          value: l.next_followup_at ? (function(d){ const pad = n => String(n).padStart(2,'0'); return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes()); })(new Date(l.next_followup_at)) : '',
          style: inputStyle,
          onchange: async (e) => {
            const iso = e.target.value ? new Date(e.target.value).toISOString() : null;
            try { await api('api_leads_update', l.id, { next_followup_at: iso }); l.next_followup_at = iso; toast('Follow-up updated', 'ok'); rerenderRows(); } catch (err) { toast(err.message, 'err'); }
          }
        })),
      // Owner dropdown
      h('div', { style: { marginBottom: '8px' } },
        h('span', { style: labStyle }, '👤 Owner'),
        (() => {
          const sel = h('select', {
            style: inputStyle,
            onchange: async (e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              try { await api('api_leads_update', l.id, { assigned_to: v }); l.assigned_to = v; const u = (S.users || []).find(u => Number(u.id) === v); l.assigned_name = u ? u.name : null; toast('Reassigned', 'ok'); rerenderRows(); } catch (err) { toast(err.message, 'err'); }
            }
          });
          sel.appendChild(h('option', { value: '' }, '— Unassigned —'));
          (Array.isArray(S.users) ? S.users : []).forEach(u => sel.appendChild(h('option', { value: u.id, selected: Number(u.id) === Number(l.assigned_to) ? 'selected' : null }, u.name)));
          return sel;
        })()),
      // Add Note inline
      h('div', { style: { marginBottom: '0' } },
        h('span', { style: labStyle }, '📝 Add Note / Remark'),
        h('div', { style: { display: 'flex', gap: '4px' } },
          h('input', { id: 'lv2-so-note-' + l.id, placeholder: 'Type and Enter to save…',
            style: inputStyle,
            onkeydown: async (e) => {
              if (e.key !== 'Enter') return;
              const txt = String(e.target.value || '').trim();
              if (!txt) return;
              try { await api('api_leads_addRemark', l.id, { remark: txt }); e.target.value = ''; l.notes = (txt + ' — ' + (l.notes || '')).slice(0, 5000); toast('Note added', 'ok'); rerenderRows(); openSlideOver(l); } catch (err) { toast(err.message, 'err'); }
            } }),
          h('button', {
            style: { padding: '4px 10px', background: '#6366f1', color: 'white', border: 'none', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', fontWeight: '600' },
            onclick: async () => {
              const inp = document.getElementById('lv2-so-note-' + l.id);
              const txt = String(inp && inp.value || '').trim();
              if (!txt) return;
              try { await api('api_leads_addRemark', l.id, { remark: txt }); inp.value = ''; toast('Note added', 'ok'); openSlideOver(l); rerenderRows(); } catch (err) { toast(err.message, 'err'); }
            }
          }, 'Save')))));

    // DETAILS card — read-only condensed view of remaining fields
    body.appendChild(h('div', { class: 'lv2-so-card', style: { padding: '10px 12px' } },
      h('h3', { style: { margin: '0 0 6px' } }, '📍 Other Details'),
      h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Source'), h('span', { class: 'v' }, l.source || '—')),
      h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'AI Score'), h('span', { class: 'v' }, (l.smart_score || 0) + ' · ' + (l.smart_category || '—'))),
      l.email ? h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Email'), h('span', { class: 'v', style: { fontSize: '10.5px' } }, l.email)) : null,
      l.city ? h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'City'), h('span', { class: 'v' }, l.city)) : null,
      l.tags ? h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Tags'), h('span', { class: 'v', style: { fontSize: '10.5px' } }, l.tags)) : null,
      l.product_name ? h('div', { class: 'lv2-so-row' }, h('span', { class: 'k' }, 'Product'), h('span', { class: 'v' }, l.product_name)) : null));

    // Notes
    if (l.notes) {
      body.appendChild(h('div', { class: 'lv2-so-card' },
        h('h3', null, '📝 Notes / Remarks'),
        h('div', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', color: '#475569', lineHeight: '1.5', maxHeight: '160px', overflowY: 'auto' } }, String(l.notes).slice(0, 2000))));
    }

    // Placeholders for async sections
    body.appendChild(h('div', { id: 'lv2-so-lastwa',  class: 'lv2-so-card' }, h('h3', null, '💬 Last WhatsApp'), h('div', { style: { fontSize: '11.5px', color: '#94a3b8' } }, 'Loading…')));
    body.appendChild(h('div', { id: 'lv2-so-lastcall', class: 'lv2-so-card' }, h('h3', null, '📞 Last Call'), h('div', { style: { fontSize: '11.5px', color: '#94a3b8' } }, 'Loading…')));
    body.appendChild(h('div', { id: 'lv2-so-activity', class: 'lv2-so-card' }, h('h3', null, '📊 Recent Activity'), h('div', { style: { fontSize: '11.5px', color: '#94a3b8' } }, 'Loading…')));

    // ---- Async load — AI Summary + timeline in parallel ----
    setTimeout(async () => {
      try {
        const r = await api('api_copilot_lead_summary', { lead_id: l.id }).catch(() => null);
        const text = (r && (r.summary || r.text || r.body)) || null;
        const host = document.getElementById('lv2-so-aisum-body');
        if (host) {
          host.innerHTML = '';
          if (text) {
            host.style.color = '#1e293b';
            host.appendChild(h('div', { style: { whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: '1.5' } }, text));
          } else {
            host.appendChild(h('div', { style: { color: '#94a3b8' } }, 'No AI summary available'));
          }
        }
      } catch (e) {
        const host = document.getElementById('lv2-so-aisum-body');
        if (host) { host.innerHTML = ''; host.appendChild(h('div', { style: { color: '#c04444' } }, 'AI summary failed: ' + e.message)); }
      }
    }, 0);

    setTimeout(async () => {
      try {
        const tl = await api('api_copilot_lead_timeline', { lead_id: l.id, limit: 30 }).catch(() => null);
        let events = (tl && Array.isArray(tl.events)) ? tl.events : (Array.isArray(tl) ? tl : []);

        // v3.1 — Phone-based WA fallback re-enabled. Previous removal in
        // v2.8 was wrong; the 'cross-lead content' the user saw was actually
        // a real WA template sent to their phone — just not what they
        // expected. Showing actual WA history is more useful than 'No
        // messages yet'. The phone is normalized inside api_wb_chat_messages
        // so cross-lead pollution is minimal.
        const hasWa = events.some(ev => ev.kind === 'wa');
        if (!hasWa && l.phone) {
          try {
            const wa = await api('api_wb_chat_messages', l.phone).catch(() => null);
            const arr = Array.isArray(wa) ? wa : (wa && (wa.messages || wa.rows)) || [];
            arr.slice(0, 30).forEach(m => {
              events.push({
                kind: 'wa',
                at: m.created_at || m.timestamp || m.ts,
                dir: m.direction || ((String(m.from_number || '').replace(/\D/g, '').slice(-10) === String(l.phone || '').replace(/\D/g, '').slice(-10)) ? 'in' : 'out'),
                text: m.body || m.text || ('[' + (m.message_type || 'media') + ']'),
                media: m.message_type,
                _fromPhone: true
              });
            });
            if (arr.length) events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
            console.log('[LEADS_V2] WA fallback fetched', arr.length, 'msgs for', l.phone);
          } catch (e) {
            console.warn('[LEADS_V2] WA fallback failed:', e.message);
          }
        }

        // v2.9 — call_events.recording_url is often EMPTY even when the
        // call has a recording attached via call_events.recording_id →
        // lead_recordings table. Fetch lead-scoped recordings via
        // api_my_recordings and match to call events by lead_id + closest
        // created_at timestamp. The recording playback URL is
        // /api/recordings/<id>/audio (tenant-resolved server-side).
        try {
          const recs = await api('api_my_recordings', 500).catch(() => []);
          const recList = Array.isArray(recs) ? recs : (recs && (recs.rows || recs.recordings)) || [];
          const leadRecs = recList.filter(r => Number(r.lead_id) === Number(l.id));
          if (leadRecs.length) {
            // Walk through call events and attach the closest recording
            const usedRecs = new Set();
            events.filter(ev => ev.kind === 'call' && !ev.recording).forEach(ev => {
              const callTs = new Date(ev.at).getTime();
              let best = null; let bestDiff = Infinity;
              leadRecs.forEach(rec => {
                if (usedRecs.has(rec.id)) return;
                const recTs = new Date(rec.created_at).getTime();
                const diff = Math.abs(callTs - recTs);
                // Only consider recordings within 10 minutes of the call event
                if (diff < bestDiff && diff < 10 * 60 * 1000) { best = rec; bestDiff = diff; }
              });
              if (best) {
                usedRecs.add(best.id);
                ev.recording = '/api/recordings/' + best.id + '/audio';
                ev.recording_id = best.id;
                if (!ev.duration && best.duration_s) ev.duration = best.duration_s;
              }
            });
            // For any RECORDINGS that don't match any call event, emit a
            // synthetic 'call' event so they appear in the timeline.
            leadRecs.filter(r => !usedRecs.has(r.id)).slice(0, 5).forEach(r => {
              events.push({
                kind: 'call',
                at: r.created_at,
                dir: r.direction || 'out',
                duration: r.duration_s,
                recording: '/api/recordings/' + r.id + '/audio',
                recording_id: r.id
              });
            });
            // Re-sort newest first
            events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
          }
        } catch (e) { console.warn('[LEADS_V2] recordings lookup failed:', e.message); }


        // Last WA
        const lastWa = events.find(ev => ev.kind === 'wa');
        const waHost = document.getElementById('lv2-so-lastwa');
        if (waHost) {
          waHost.innerHTML = '';
          waHost.appendChild(h('h3', null, '💬 Last WhatsApp'));
          if (!lastWa) {
            waHost.appendChild(h('div', { style: { fontSize: '11.5px', color: '#94a3b8' } }, 'No WhatsApp messages yet'));
          } else {
            const dirLabel = lastWa.dir === 'in' ? '⬅ Received' : '➡ Sent';
            waHost.appendChild(h('div', { style: { fontSize: '11px', color: '#64748b', marginBottom: '4px' } },
              dirLabel + ' · ' + fmtDateTimeRel(lastWa.at)));
            waHost.appendChild(h('div', { style: { fontSize: '12.5px', color: '#1e293b', whiteSpace: 'pre-wrap', background: '#f8fafc', padding: '8px 10px', borderRadius: '6px', borderLeft: '3px solid ' + (lastWa.dir === 'in' ? '#3b82f6' : '#10b981'), maxHeight: '120px', overflowY: 'auto' } },
              String(lastWa.text || '(media)').slice(0, 400)));
          }
        }

        // Last Call
        const lastCall = events.find(ev => ev.kind === 'call');
        const callHost = document.getElementById('lv2-so-lastcall');
        if (callHost) {
          callHost.innerHTML = '';
          callHost.appendChild(h('h3', null, '📞 Last Call'));
          if (!lastCall) {
            callHost.appendChild(h('div', { style: { fontSize: '11.5px', color: '#94a3b8' } }, 'No calls yet'));
          } else {
            const dirLabel = lastCall.dir === 'in' ? '📞 Incoming' : lastCall.dir === 'out' ? '📞 Outgoing' : lastCall.dir === 'missed' ? '📵 Missed' : '📞 Call';
            const dSec = Number(lastCall.duration || 0);
            const durLabel = dSec
              ? (dSec >= 3600 ? (Math.floor(dSec/3600)+'h ' + Math.floor((dSec%3600)/60) + 'm') : (Math.floor(dSec / 60) + 'm ' + (dSec % 60) + 's'))
              : 'no duration';
            // v3.9 — absolute date + time + relative for the LAST CALL header
            function _fmtDT(iso) {
              if (!iso) return '';
              const d = new Date(iso); if (isNaN(d)) return String(iso);
              const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
              const timePart = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
              return datePart + ' · ' + timePart;
            }
            callHost.appendChild(h('div', { style: { fontSize: '12px', color: '#1e293b', fontWeight: '600' } },
              dirLabel + ' · ' + durLabel));
            callHost.appendChild(h('div', { style: { fontSize: '10.5px', color: '#475569', marginTop: '3px', fontWeight: '500' } },
              '🕐 ' + _fmtDT(lastCall.at) + ' ',
              h('span', { style: { color: '#94a3b8', fontWeight: '400' } }, '(' + fmtRel(lastCall.at) + ' ago)')));
            if (lastCall.recording) {
              // v3.9 — build authenticated playback URL.
              // /api/recordings/:id/audio requires (a) tenant slug prefix when
              // served via /t/<slug>/ and (b) ?token=<crm_token> for auth.
              // Without these the <audio> element silently 401s and Play stays at 0:00/0:00.
              let _recUrl = lastCall.recording;
              try {
                const _slug = (typeof window !== 'undefined' && window.TENANT_SLUG) ? window.TENANT_SLUG : '';
                const _tok = (typeof window !== 'undefined' && (window.CRM && window.CRM.token)) ? window.CRM.token : '';
                // Strip any existing tenant prefix, then re-add it from window.TENANT_SLUG
                let _path = _recUrl.replace(/^\/t\/[^/]+/, '');
                if (!_path.startsWith('/')) _path = '/' + _path;
                _recUrl = (_slug ? '/t/' + _slug : '') + _path + (_tok ? (_path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(_tok) : '');
              } catch (_) {}
              const _audioEl = h('audio', { controls: 'controls', src: _recUrl, preload: 'metadata',
                style: { width: '100%', marginTop: '8px', height: '32px' } });
              callHost.appendChild(_audioEl);
              const auditId = 'lv2-audit-' + l.id;
              callHost.appendChild(h('div', { id: auditId, style: { marginTop: '8px' } },
                h('button', {
                  style: { width: '100%', padding: '5px 10px', background: 'linear-gradient(135deg, #ede9fe, #faf5ff)', color: '#6d28d9', border: '1px solid #ddd6fe', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', fontWeight: '600' },
                  onclick: async function () {
                    this.disabled = true; this.textContent = '⏳ Auditing…';
                    try {
                      const recId = lastCall.recording_id || lastCall.id;
                      if (!recId) { this.textContent = '⚠ No recording id'; return; }
                      const r = await api('api_recording_aiSummary', recId);
                      const host = document.getElementById(auditId);
                      if (!host) return;
                      host.innerHTML = '';
                      if (r && r.status === 'pending') {
                        host.appendChild(h('div', { style: { fontSize: '11px', color: '#92400e', padding: '6px 8px', background: '#fef3c7', borderRadius: '5px' } }, '⏳ Still processing — retry in a minute'));
                      } else if (r && r.status === 'failed') {
                        host.appendChild(h('div', { style: { fontSize: '11px', color: '#b91c1c', padding: '6px 8px', background: '#fef2f2', borderRadius: '5px' } }, '⚠ AI audit failed: ' + (r.error || 'unknown')));
                      } else {
                        host.appendChild(h('div', { style: { fontSize: '10px', fontWeight: '700', color: '#6d28d9', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: '5px' } }, '✨ AI Audit'));
                        if (r && r.summary) host.appendChild(h('div', { style: { fontSize: '11.5px', color: '#1e293b', lineHeight: '1.45', whiteSpace: 'pre-wrap', background: 'linear-gradient(135deg, #faf5ff, #f0f4ff)', padding: '6px 8px', borderRadius: '5px', border: '1px solid #ddd6fe' } }, r.summary));
                        if (r && r.key_insight) host.appendChild(h('div', { style: { fontSize: '10.5px', color: '#475569', marginTop: '4px' } }, '💡 ' + r.key_insight));
                        if (r && Array.isArray(r.action_items) && r.action_items.length) {
                          host.appendChild(h('div', { style: { fontSize: '10.5px', color: '#475569', marginTop: '4px' } },
                            h('b', null, 'Actions: '), r.action_items.slice(0,3).join(' · ')));
                        }
                      }
                    } catch (e) {
                      this.disabled = false; this.textContent = '✨ AI Audit recording';
                      toast(e.message, 'err');
                    }
                  }
                }, '✨ AI Audit recording')));
            } else {
              callHost.appendChild(h('div', { style: { fontSize: '11px', color: '#94a3b8', marginTop: '4px' } }, 'No recording attached'));
            }
          }
        }

        // Activity timeline (top 8)
        const actHost = document.getElementById('lv2-so-activity');
        if (actHost) {
          // v3.7 — hide kind='score' events; only show real activity
          // (call/wa/remark/status). Score changes are visible via the
          // AI Score chip's hover tooltip already.
          // v3.8 — show ALL events in a scrollable container instead of capping at 8.
          const realEvents = events.filter(ev => ev && ev.kind !== 'score');
          actHost.innerHTML = '';
          // Sticky header so the count + 'View full timeline' link stays
          // visible while the user scrolls through many events.
          actHost.appendChild(h('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: '8px', position: 'sticky', top: '0',
              background: 'white', paddingBottom: '6px', zIndex: '2',
              borderBottom: realEvents.length ? '1px solid #f1f5f9' : 'none'
            }
          },
            h('h3', { style: { margin: '0', display: 'inline-flex', alignItems: 'center', gap: '6px' } },
              '📊 Recent Activity',
              realEvents.length ? h('span', { style: { fontSize: '10px', fontWeight: '500', color: '#94a3b8' } }, '(' + realEvents.length + ')') : null
            ),
            realEvents.length ? h('a', { style: { fontSize: '10px', color: '#6366f1', cursor: 'pointer', textDecoration: 'none' }, onclick: () => doViewFull(l) }, 'View full timeline →') : null));
          if (!realEvents.length) {
            actHost.appendChild(h('div', { style: { fontSize: '11.5px', color: '#94a3b8' } }, 'No activity yet'));
          } else {
            // Scrollable list — caps height ~280px (~8 rows visible) and
            // lets the user scroll to see the rest. No artificial cap.
            const list = h('div', {
              style: {
                maxHeight: '280px', overflowY: 'auto', overflowX: 'hidden',
                paddingRight: '4px', marginRight: '-4px'
              }
            });
            realEvents.forEach(ev => list.appendChild(buildActRow(ev)));
            actHost.appendChild(list);
          }
        }
      } catch (e) {
        console.warn('[LEADS_V2] slide-over timeline load failed:', e.message);
      }
    }, 0);
  }

  function buildActRow(ev) {
    const k = ev.kind || '';
    const ico = k === 'wa'     ? (ev.dir === 'in' ? '💬' : '💚')
              : k === 'call'   ? (ev.dir === 'missed' ? '📵' : '📞')
              : k === 'remark' ? '📝'
              : k === 'score'  ? '🎯'
              : '•';
    const who = k === 'wa'     ? (ev.dir === 'in' ? 'WhatsApp received' : 'WhatsApp sent')
              : k === 'call'   ? (ev.dir === 'in' ? 'Call incoming' : ev.dir === 'out' ? 'Call outgoing' : ev.dir === 'missed' ? 'Call missed' : 'Call')
              : k === 'remark' ? ('Note' + (ev.by ? ' · ' + ev.by : ''))
              : k === 'score'  ? ('AI Score ' + (ev.old_score || 0) + ' → ' + (ev.new_score || 0))
              : (ev.label || ev.kind || 'Activity');
    const detail = k === 'wa'     ? String(ev.text || '').slice(0, 70)
                 : k === 'call'   ? ((ev.duration ? Math.floor(ev.duration/60)+'m '+(ev.duration%60)+'s' : 'no duration') + (ev.recording ? ' · ▶' : ''))
                 : k === 'remark' ? String(ev.text || '').slice(0, 70)
                 : k === 'score'  ? (ev.reason_text || ev.trigger_event || '')
                 : '';
    return h('div', { style: { display: 'flex', gap: '8px', padding: '7px 0', borderBottom: '1px solid #f1f5f9', fontSize: '11.5px' } },
      h('div', { style: { width: '24px', height: '24px', borderRadius: '50%', background: '#f1f5f9', display: 'grid', placeItems: 'center', fontSize: '11px', flexShrink: '0' } }, ico),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '6px' } },
          h('span', { style: { fontWeight: '600', color: '#0f172a' } }, who),
          h('span', { style: { fontSize: '10px', color: '#94a3b8' }, title: ev.at ? new Date(ev.at).toLocaleString('en-IN') : '' }, fmtDateTimeRel(ev.at))),
        detail ? h('div', { style: { color: '#64748b', marginTop: '2px' } }, detail) : null));
  }
  function closeSlideOver() {
    const ex = document.getElementById('lv2-slideover');
    if (ex) ex.remove();
    S.selectedId = null;
  }

  /* ---------- actions ---------- */
  function doCall(l) { try { if (window.openCallModal) return window.openCallModal(l.id); } catch (_) {} window.location.href = 'tel:' + (l.phone || ''); }
  function doQuotation(l) {
    try {
      if (typeof window.openQuotationModal === 'function') {
        return window.openQuotationModal(null, l);
      }
    } catch (_) {}
    // Fallback — open lead modal then user picks Quotations tab
    try {
      if (typeof window.openLeadModal === 'function') {
        window.openLeadModal(l.id);
        return;
      }
    } catch (_) {}
    toast('Quotation modal not available in this build', 'err');
  }
  function doSim(l) { window.location.href = 'tel:' + (l.phone || ''); }
  function doWaWeb(l) { const ph = String(l.phone || '').replace(/\D/g, ''); window.open('https://wa.me/' + ph, '_blank'); }
  function doWaApi(l) { try { window.location.hash = '#/whatsbot/chat'; setTimeout(() => { try { window.openLeadModal && window.openLeadModal(l.id); } catch(_){} }, 400); } catch (_) {} }
  function aiHub(l) {
    // Open the AI Hub overlay — used by the ✨ AI badge on the name.
    try {
      if (typeof window.coachOpenLeadSummary === 'function') {
        return window.coachOpenLeadSummary(l.id);
      }
    } catch (_) {}
    try {
      if (window.LEAD_AI_HUB && typeof window.LEAD_AI_HUB.open === 'function') {
        return window.LEAD_AI_HUB.open(l.id);
      }
    } catch (_) {}
    doViewFull(l);
  }
  function aiQuickNote(l) {
    // v3.3 — matches the Classic row's AI button behavior.
    // openQuickNoteInline lets the user type status + remark +
    // follow-up time and AI parses it into structured fields.
    if (typeof window.openQuickNoteInline !== 'function') {
      // Fallback chain: AI Hub overlay → lead modal
      return aiHub(l);
    }
    try {
      window.openQuickNoteInline(l);
    } catch (e) {
      return aiHub(l);
    }

    // v3.5 — openQuickNoteInline calls loadLeads() on success, which is
    // the CLASSIC-view refresher and does nothing in Modern. Watch for
    // the modal to close (user clicked Save and got a toast), then
    // refresh the leads list + re-render so status/follow-up/notes
    // changes show up immediately.
    let wasOpen = false;
    const checkInt = setInterval(() => {
      const open = !!document.querySelector('.modal-backdrop .qn-spark');
      if (open) { wasOpen = true; return; }
      if (wasOpen) {
        clearInterval(checkInt);
        // Modal closed — refresh leads + re-render the active style
        (async () => {
          try {
            await load();
            try { rerenderRows(); } catch (_) {}
            try { rerenderInboxRows && rerenderInboxRows(); } catch (_) {}
            // If the modal was opened from the slide-over, also refresh it
            if (S.selectedId && document.getElementById('lv2-slideover')) {
              const fresh = (S.leads || []).find(x => Number(x.id) === Number(S.selectedId));
              if (fresh) openSlideOver(fresh);
            }
          } catch (e) { console.warn('[LEADS_V2] post-quicknote refresh failed:', e.message); }
        })();
      }
    }, 400);
    // Safety: stop polling after 90s (user might have left the page)
    setTimeout(() => clearInterval(checkInt), 90000);
  }
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

    // v1.6 — clear view to prevent duplicate-render stacking
    view.innerHTML = '';

    const wrap = h('div', { class: 'lv2-inbox' });
    const list = h('div', { class: 'lv2-inbox-list' });

    list.appendChild(h('div', { class: 'lv2-inbox-head' },
      h('div', { class: 'row1' }, h('h2', null, 'Leads'), h('span', { class: 'c' }, String(S.leads.length))),
      h('div', { class: 'search' },
        h('span', { style: { color: '#64748b' } }, '🔍'),
        h('input', { placeholder: 'Search…', value: S.search, oninput: (e) => { S.search = e.target.value; rerenderInboxRows(); } }))));

    // Quick views (chip slicer)
    const views = h('div', { class: 'lv2-inbox-views' });
    [['all','All'],['hot','🔥 Hot'],['overdue','⏰ Overdue'],['today','📅 Today'],['mine','⭐ Mine'],['new','🆕 New']].forEach(([k, lab]) => {
      views.appendChild(h('div', {
        class: 'v' + (S.filter === k ? ' active' : ''),
        onclick: () => { S.filter = k; renderInbox(view); }
      }, lab));
    });
    list.appendChild(views);

    // FULL filter bar (status / source / owner / score / tag / campaign / followup / qualified)
    // Render inside the inbox list panel so user filters lead-list, detail stays in place.
    // v1.5 — full re-render so filter UI updates too
    const onFilterChange = () => { S.page = 1; renderInbox(view); };
    list.appendChild(buildStatusChipBar(onFilterChange));
    list.appendChild(buildFilterBar(onFilterChange));

    const rowsHost = h('div', { class: 'lv2-inbox-rows', id: 'lv2-inbox-rows' });
    list.appendChild(rowsHost);

    const detail = h('div', { class: 'lv2-inbox-detail', id: 'lv2-inbox-detail' },
      h('div', { class: 'lv2-inbox-empty' }, h('div', { class: 'big' }, '📋'), h('div', null, 'Select a lead to see details')));

    wrap.appendChild(list);
    wrap.appendChild(detail);
    view.appendChild(wrap);

    rerenderInboxRows();
    // v3.4 — Ask AI floating pill removed per user request
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
        h('span', { class: 'when', title: (l.last_activity_at || l.created_at) ? new Date(l.last_activity_at || l.created_at).toLocaleString('en-IN') : '' }, fmtRel(l.last_activity_at || l.created_at))),
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
