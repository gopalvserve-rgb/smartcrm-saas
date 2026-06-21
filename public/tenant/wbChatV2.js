/* WB_CHAT_V2 (2026-06-20) — 3-column WhatsApp chat redesign.
 *
 * Delegated from app.js wbChat() when WB_CHAT_V2_ENABLED='1'.
 * Vserve-only beta — flipped on at server boot via
 * utils/wbChatV2VserveAutoEnable.js.
 *
 * Reuses every existing tenant API (no new backend endpoints).
 * Module exposes window.WB_CHAT_V2.render().
 */
(function () {
  'use strict';

  /* ---------- token + api ---------- */
  const SLUG = (function () { const m = location.pathname.match(/\/t\/([^\/]+)/); return m ? m[1] : ''; })();
  function _tok() { return localStorage.getItem('crm_token_' + SLUG) || localStorage.getItem('crm_token') || ''; }
  async function api(fn, ...args) {
    const r = await fetch(`/t/${SLUG}/api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn, args: [_tok(), ...args] })
    });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || 'API error');
    return j.result;
  }

  /* ---------- DOM helper ---------- */
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
  function toast(msg, kind) { try { (window.toast || window.tenantToast || function (m) { console.log(m); })(msg, kind); } catch (_) {} }

  /* ---------- state ---------- */
  const S = {
    threads: [],
    threadsRaw: [],     // unfiltered
    tab: 'recent',      // recent (7d) | history (30d)
    filter: 'all',      // all | unread | mine
    search: '',
    activeLeadId: null,
    activeThread: null,
    messages: [],
    lead: null,
    statuses: [],
    users: [],
    aiScore: null,
    activity: [],
    me: null,
    filterAssignee: null,
    filterPhoneId: null,
    phones: [],
    templates: null,
    aiSummary: null,
    statusById: {},
    userById: {}
  };

  /* ---------- helpers ---------- */
  function fmtRelative(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const now = new Date();
    const sec = Math.floor((now - d) / 1000);
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    if (sec < 7 * 86400) {
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
      return dow;
    }
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  // v2.1 — Standard date+time+relative format: '20 Jun, 2:58 PM (1d)'
  function fmtDateTimeRel(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return String(iso);
    const datePart = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    const timePart = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    const sec = Math.floor((Date.now() - d) / 1000);
    let rel = '';
    if (sec < 60) rel = 'just now';
    else if (sec < 3600) rel = Math.floor(sec / 60) + 'm';
    else if (sec < 86400) rel = Math.floor(sec / 3600) + 'h';
    else if (sec < 7 * 86400) rel = Math.floor(sec / 86400) + 'd';
    else { const days = Math.floor(sec / 86400); rel = days + 'd'; }
    return datePart + ', ' + timePart + (rel ? ' (' + rel + ')' : '');
  }
  function fmtFullDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtFriendlyDate(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffD = Math.round((that - today) / 86400000);
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    if (diffD === 0) return 'Today, ' + time;
    if (diffD === 1) return 'Tomorrow, ' + time;
    if (diffD === -1) return 'Yesterday, ' + time;
    if (diffD > 1 && diffD < 7) return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ', ' + time;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ', ' + time;
  }
  function isoToLocalDtInput(iso) {
    if (!iso) return '';
    const d = new Date(iso); if (isNaN(d)) return '';
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function localDtInputToIso(s) {
    if (!s) return null;
    const d = new Date(s); if (isNaN(d)) return null;
    return d.toISOString();
  }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function avatarColor(name) {
    const palette = ['#ec96b8', '#b8a4d8', '#88cfd8', '#ffc870', '#98d8a4', '#f4a3a3', '#a4c8ff', '#ffae9e'];
    let h = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return palette[Math.abs(h) % palette.length];
  }
  function statusClass(name) {
    const n = String(name || '').toLowerCase();
    if (/new/.test(n)) return 'new';
    if (/demo|appoint/.test(n)) return 'demo';
    if (/proposal|quot/.test(n)) return 'proposal';
    if (/call.?back|hot/.test(n)) return 'hot';
    if (/did.?not|miss|no.?ans/.test(n)) return 'warm';
    if (/not.?interest|lost|junk/.test(n)) return 'lost';
    if (/follow|cold/.test(n)) return 'cold';
    return 'cold';
  }
  function tatChipClass(ms) {
    if (ms < 30 * 60 * 1000) return 'ok';
    if (ms < 2 * 3600 * 1000) return 'warn';
    return 'bad';
  }
  function tatLabel(ms) {
    if (!ms || ms < 0) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return m + 'm';
    const hr = Math.round(m / 60);
    if (hr < 24) return hr + 'h';
    return Math.round(hr / 24) + 'd';
  }

  /* ---------- styles ---------- */
  function injectStyles() {
    if (document.getElementById('wbv2-styles')) return;
    const css = `
.wbv2-shell { display: grid; grid-template-columns: 340px 1fr 340px; height: calc(100vh - 130px); min-height: 600px; background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #2a3942; border: 1px solid #e9edef; border-radius: 8px; overflow: hidden; }
@media (max-width: 1280px) { .wbv2-shell { grid-template-columns: 300px 1fr 320px; } }
@media (max-width: 1100px) { .wbv2-shell { grid-template-columns: 280px 1fr; } .wbv2-lead { display: none; } }

/* ============== THREADS ============== */
.wbv2-threads { border-right: 1px solid #e9edef; background: #ffffff; display: flex; flex-direction: column; min-height: 0; }
.wbv2-th-head { padding: 12px 14px 8px; background: #f0f2f5; border-bottom: 1px solid #e9edef; }
.wbv2-th-head .brand { display: flex; align-items: center; justify-content: space-between; }
.wbv2-th-head .b-info { display: flex; align-items: center; gap: 10px; min-width: 0; }
.wbv2-th-head .b-logo { width: 32px; height: 32px; border-radius: 50%; background: #00a884; color: white; display: grid; place-items: center; font-weight: 700; font-size: 14px; flex-shrink: 0; }
.wbv2-th-head .b-name { font-weight: 600; font-size: 14px; color: #111b21; }
.wbv2-th-head .b-num { font-size: 11px; color: #667781; }
.wbv2-th-head .ico { width: 32px; height: 32px; display: grid; place-items: center; cursor: pointer; color: #54656f; border-radius: 50%; font-size: 14px; user-select: none; }
.wbv2-th-head .ico:hover { background: #e9edef; }
.wbv2-th-head .ico.spinning { animation: wbv2-spin 0.7s linear infinite; color: #00a884; }
@keyframes wbv2-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.wbv2-search { padding: 8px 12px; background: white; }
.wbv2-search .box { display: flex; align-items: center; gap: 10px; padding: 7px 14px; background: #f0f2f5; border-radius: 8px; }
.wbv2-search input { flex: 1; border: none; background: transparent; font-size: 13px; outline: none; }

.wbv2-pills { padding: 8px 12px 10px; display: flex; align-items: center; gap: 6px; background: white; border-bottom: 1px solid #e9edef; flex-wrap: wrap; }
.wbv2-pills .pill { padding: 5px 12px; background: white; color: #54656f; border: 1px solid #e9edef; border-radius: 18px; font-size: 11px; cursor: pointer; font-weight: 500; }
.wbv2-pills .pill.active { background: #d9fdd3; color: #00553a; border-color: #d9fdd3; font-weight: 600; }
.wbv2-pills .pill .c { background: #ef4444; color: white; padding: 1px 5px; border-radius: 8px; margin-left: 3px; font-size: 9px; font-weight: 700; }

.wbv2-tabs { display: flex; background: white; border-bottom: 1px solid #e9edef; }
.wbv2-tabs .tab { flex: 1; padding: 10px 8px; text-align: center; font-size: 12px; font-weight: 600; color: #667781; cursor: pointer; border-bottom: 3px solid transparent; }
.wbv2-tabs .tab:hover { background: #f5f6f6; color: #111b21; }
.wbv2-tabs .tab.active { color: #00a884; border-bottom-color: #00a884; }
.wbv2-tabs .tab .sub { font-size: 10px; font-weight: 400; color: #8696a0; margin-left: 3px; }

.wbv2-list { flex: 1; overflow-y: auto; min-height: 0; }
.wbv2-list .empty { padding: 30px 20px; text-align: center; color: #8696a0; font-size: 13px; }
.wbv2-row { padding: 12px 14px; border-bottom: 1px solid #f5f6f6; cursor: pointer; position: relative; }
.wbv2-row:hover { background: #f5f6f6; }
.wbv2-row.active { background: #f0f2f5; }
.wbv2-row .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.wbv2-chip-status { font-size: 10px !important; padding: 3px 9px !important; letter-spacing: .3px; }
.wbv2-chip-empty { background: #f1f5f9 !important; color: #94a3b8 !important; text-transform: none !important; font-weight: 500 !important; font-style: italic; }

.wbv2-row .owner { font-size: 10px; color: #667781; white-space: nowrap; }
.wbv2-row .body { display: flex; align-items: center; gap: 10px; }
.wbv2-row .av { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; color: white; font-weight: 600; font-size: 14px; flex-shrink: 0; }
.wbv2-row .text { flex: 1; min-width: 0; }
.wbv2-row .name { font-weight: 500; font-size: 14px; color: #111b21; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wbv2-row .preview { font-size: 12px; color: #667781; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
.wbv2-row .source { display: inline-block; font-size: 9px; font-weight: 600; padding: 1px 6px; border-radius: 8px; background: #f0f2f5; color: #54656f; margin-top: 3px; }
.wbv2-row .right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
.wbv2-row .when { font-size: 11px; color: #667781; white-space: nowrap; }
@keyframes wbv2-spin { to { transform: rotate(360deg); } }
@keyframes wbv2-pulse-new { 0%, 100% { box-shadow: inset 4px 0 0 0 #ef4444, 0 0 0 0 rgba(239,68,68,.4); } 50% { box-shadow: inset 4px 0 0 0 #ef4444, 0 0 0 4px rgba(239,68,68,0); } }
.wbv2-row.new-msg { background: linear-gradient(90deg, #fee2e2 0%, #fff7ed 60%); border-left: 4px solid #ef4444 !important; animation: wbv2-pulse-new 1.4s ease-in-out infinite; }
.wbv2-new-pill { background: linear-gradient(135deg, #ef4444, #f97316); color: white; font-size: 9px; font-weight: 800; padding: 2px 8px; border-radius: 10px; letter-spacing: .5px; text-transform: uppercase; box-shadow: 0 1px 4px rgba(239,68,68,.5); animation: wbv2-newpill-bounce 1.2s ease-in-out infinite; white-space: nowrap; }
@keyframes wbv2-newpill-bounce { 0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(239,68,68,.5); } 50% { transform: scale(1.08); box-shadow: 0 0 0 4px rgba(239,68,68,0); } }
.wbv2-row.new-msg .name { color: #991b1b; font-weight: 700; }
.wbv2-row .unread { background: #00a884; color: white; font-size: 10px; padding: 1px 7px; border-radius: 10px; font-weight: 600; min-width: 18px; text-align: center; }
.wbv2-row .ai { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 8px; }
.wbv2-row .ai.hot  { background: #fde7e7; color: #c04444; }
.wbv2-row .ai.warm { background: #fff4e0; color: #b88217; }
.wbv2-row .ai.cold { background: #e0eaff; color: #2e5db8; }

.wbv2-chip { font-size: 9px; font-weight: 700; padding: 2px 8px; border-radius: 10px; letter-spacing: .3px; text-transform: uppercase; white-space: nowrap; }
.wbv2-chip.warm     { background: #fff4e0; color: #b88217; }
.wbv2-chip.hot      { background: #fde7e7; color: #c04444; }
.wbv2-chip.cold     { background: #e0eaff; color: #2e5db8; }
.wbv2-chip.new      { background: #d9fdd3; color: #00553a; }
.wbv2-chip.demo     { background: #ece1ff; color: #6938b8; }
.wbv2-chip.proposal { background: #d4f3f7; color: #146a76; }
.wbv2-chip.lost     { background: #eef0f2; color: #54656f; }

/* ============== CHAT ============== */
.wbv2-chat { background: #efeae2; display: flex; flex-direction: column; min-height: 0; position: relative; }
.wbv2-c-head { padding: 10px 18px; background: #f0f2f5; border-bottom: 1px solid #e9edef; display: flex; align-items: center; gap: 12px; }
.wbv2-c-head .info { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
.wbv2-c-head .av { width: 40px; height: 40px; border-radius: 50%; color: white; display: grid; place-items: center; font-weight: 600; font-size: 16px; flex-shrink: 0; }
.wbv2-c-head .nw { min-width: 0; }
.wbv2-c-head .nm { font-weight: 600; font-size: 15px; color: #111b21; }
.wbv2-c-head .sub { font-size: 11px; color: #667781; margin-top: 1px; }
.wbv2-tat { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 10px; }
.wbv2-tat.ok   { background: #d9fdd3; color: #00553a; }
.wbv2-tat.warn { background: #fff4e0; color: #b88217; }
.wbv2-tat.bad  { background: #fde7e7; color: #c04444; }
.wbv2-c-head .btn { padding: 6px 12px; background: white; border: 1px solid #e9edef; border-radius: 18px; font-size: 12px; cursor: pointer; color: #54656f; display: flex; align-items: center; gap: 5px; font-weight: 500; }
.wbv2-c-head .btn:hover { background: #f5f6f6; }
.wbv2-c-head .ico { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; color: #54656f; cursor: pointer; }
.wbv2-c-head .ico:hover { background: #e9edef; }

.wbv2-c-substate { padding: 6px 18px; background: #f0f2f5; border-bottom: 1px solid #e9edef; display: flex; align-items: center; gap: 10px; font-size: 11px; color: #667781; flex-wrap: wrap; }

.wbv2-c-body { flex: 1; overflow-y: auto; padding: 16px 22px; min-height: 0; }
.wbv2-c-empty { display: grid; place-items: center; height: 100%; color: #667781; font-size: 14px; padding: 30px; text-align: center; }
.wbv2-c-empty .big { font-size: 64px; opacity: .25; margin-bottom: 12px; }

.wbv2-date { text-align: center; margin: 14px 0; }
.wbv2-date span { display: inline-block; background: rgba(255,255,255,.85); color: #54656f; font-size: 11px; padding: 4px 10px; border-radius: 6px; font-weight: 500; box-shadow: 0 1px 0 rgba(11,20,26,.05); }

.wbv2-msg { max-width: 70%; margin-bottom: 6px; padding: 6px 8px 8px 10px; border-radius: 8px; font-size: 13.5px; line-height: 1.4; box-shadow: 0 1px .5px rgba(11,20,26,.13); color: #111b21; word-wrap: break-word; }
.wbv2-msg.in  { background: white; border-top-left-radius: 0; }
.wbv2-msg.out { background: #d9fdd3; margin-left: auto; border-top-right-radius: 0; }
.wbv2-msg.tpl { background: #d1f4cc; }
.wbv2-msg .who { font-size: 11px; font-weight: 600; color: #00a884; margin-bottom: 2px; }
.wbv2-msg .who.tpl { color: #6938b8; }
.wbv2-msg .body { white-space: pre-wrap; }
.wbv2-msg .meta { font-size: 10px; color: #667781; text-align: right; margin-top: 3px; }
.wbv2-msg .ticks { color: #53bdeb; font-size: 12px; }

.wbv2-closed { background: #fff8eb; border-top: 1px solid #ffe0a3; padding: 14px 22px; }
.wbv2-closed .title { font-size: 13px; font-weight: 600; color: #b86e00; margin-bottom: 4px; }
.wbv2-closed .desc { font-size: 11px; color: #856515; line-height: 1.5; }
.wbv2-closed .acts { display: flex; gap: 10px; margin-top: 10px; }
.wbv2-closed button { padding: 8px 16px; border: none; border-radius: 18px; font-size: 12px; font-weight: 600; cursor: pointer; }
.wbv2-closed .btn-now { background: #00a884; color: white; }
.wbv2-closed .btn-tpl { background: white; color: #00a884; border: 1px solid #00a884 !important; }

.wbv2-composer { padding: 10px 16px; background: #f0f2f5; border-top: 1px solid #e9edef; display: flex; align-items: center; gap: 8px; }
.wbv2-composer .ico { width: 38px; height: 38px; display: grid; place-items: center; color: #54656f; cursor: pointer; border-radius: 50%; }
.wbv2-composer .ico:hover { background: #e9edef; }
.wbv2-composer input { flex: 1; padding: 10px 14px; border: none; border-radius: 20px; background: white; font-size: 14px; outline: none; }
.wbv2-composer .send { background: #00a884; color: white; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; font-size: 16px; display: grid; place-items: center; }
.wbv2-composer .send:hover { background: #008f72; }

/* ============== LEAD PANEL ============== */
.wbv2-lead { border-left: 1px solid #e9edef; background: white; display: flex; flex-direction: column; overflow-y: auto; min-height: 0; }
.wbv2-l-empty { padding: 30px 20px; text-align: center; color: #8696a0; font-size: 13px; }
.wbv2-l-head { padding: 18px 16px 14px; border-bottom: 1px solid #f0f2f5; text-align: center; background: #f8f9fa; }
.wbv2-l-head .av { width: 64px; height: 64px; border-radius: 50%; color: white; font-size: 24px; font-weight: 600; display: grid; place-items: center; margin: 0 auto 10px; }
.wbv2-l-head .nm { font-weight: 600; font-size: 16px; color: #111b21; }
.wbv2-l-head .ph { font-size: 12px; color: #00a884; margin-top: 3px; }
.wbv2-l-head .crt { font-size: 10px; color: #8696a0; margin-top: 4px; }
.wbv2-l-head .acts { display: flex; gap: 8px; margin-top: 12px; }
.wbv2-l-head .acts button { flex: 1; padding: 8px 12px; border-radius: 18px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; }
.wbv2-l-head .btn-call { background: #00a884; color: white; }
.wbv2-l-head .btn-view { background: white; color: #00a884; border: 1px solid #00a884; }

.wbv2-qe { padding: 12px 14px; background: #f8f9fa; border-bottom: 1px solid #f0f2f5; display: flex; flex-direction: column; gap: 10px; }
.wbv2-qe .f { display: flex; flex-direction: column; gap: 4px; }
.wbv2-qe .lab { font-size: 10px; font-weight: 700; color: #8696a0; text-transform: uppercase; letter-spacing: .4px; }
.wbv2-qe select, .wbv2-qe input[type="datetime-local"], .wbv2-qe input[type="date"] {
  width: 100%; padding: 8px 12px; background: white; border: 1px solid #e9edef; border-radius: 8px;
  font-size: 13px; color: #111b21; font-weight: 500; cursor: pointer; outline: none;
  -webkit-appearance: none; appearance: none;
}
.wbv2-qe select:hover, .wbv2-qe input:hover { border-color: #00a884; }
.wbv2-qe select { background-image: linear-gradient(45deg, transparent 50%, #8696a0 50%), linear-gradient(135deg, #8696a0 50%, transparent 50%); background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; padding-right: 28px; }
.wbv2-qe select.chip-demo { background-color: #ece1ff; color: #6938b8; border-color: #d4c3f5; font-weight: 700; }
.wbv2-qe select.chip-new  { background-color: #d9fdd3; color: #00553a; border-color: #b5e5b3; font-weight: 700; }
.wbv2-qe select.chip-hot  { background-color: #fde7e7; color: #c04444; border-color: #f5c5c5; font-weight: 700; }
.wbv2-qe select.chip-warm { background-color: #fff4e0; color: #b88217; border-color: #f5e0a3; font-weight: 700; }
.wbv2-qe select.chip-cold { background-color: #e0eaff; color: #2e5db8; border-color: #c5d5f5; font-weight: 700; }
.wbv2-qe select.chip-proposal { background-color: #d4f3f7; color: #146a76; border-color: #a3e5ed; font-weight: 700; }
.wbv2-qe select.chip-lost { background-color: #eef0f2; color: #54656f; border-color: #d0d4d8; font-weight: 600; }
.wbv2-qe input.fu-overdue { background: #fde7e7; color: #c04444; border-color: #f5c5c5; font-weight: 600; }

.wbv2-addnote { padding: 10px 12px; background: white; border-bottom: 1px solid #f0f2f5; }
.wbv2-addnote button { width: 100%; padding: 10px 14px; background: #00a884; color: white; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; }
.wbv2-addnote button:hover { background: #008f72; }

.wbv2-sec { padding: 12px 16px; border-bottom: 1px solid #f0f2f5; }
.wbv2-sec .lab { font-size: 10px; font-weight: 700; color: #8696a0; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
.wbv2-sec .lab .tog { color: #8696a0; font-size: 11px; cursor: pointer; }
.wbv2-sec .lab .tog:hover { color: #00a884; }

.wbv2-ai { display: flex; align-items: center; gap: 12px; padding: 12px; background: linear-gradient(135deg, #fff8eb 0%, #d9fdd3 100%); border-radius: 12px; border: 1px solid #d9fdd3; }
.wbv2-ai .score { font-size: 26px; font-weight: 800; color: #00553a; line-height: 1; }
.wbv2-ai .meta { flex: 1; }
.wbv2-ai .meta b { font-size: 11px; color: #00553a; text-transform: uppercase; }
.wbv2-ai .meta div { font-size: 10.5px; color: #5a7361; margin-top: 2px; }

.wbv2-note { background: #f8f9fa; border-left: 3px solid #00a884; padding: 8px 10px; border-radius: 4px; margin-top: 6px; font-size: 11.5px; color: #2a3942; }
.wbv2-note b { color: #111b21; font-size: 11px; }
.wbv2-note .w { color: #8696a0; font-size: 10px; }

.wbv2-act { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f7f8f9; font-size: 11.5px; }
.wbv2-act:last-child { border-bottom: none; }
.wbv2-act .ico { width: 28px; height: 28px; border-radius: 50%; background: #f0f2f5; display: grid; place-items: center; font-size: 12px; flex-shrink: 0; }
.wbv2-act .b { flex: 1; min-width: 0; }
.wbv2-act .h { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.wbv2-act .who { font-weight: 600; color: #111b21; font-size: 11.5px; }
.wbv2-act .w { font-size: 10px; color: #8696a0; white-space: nowrap; }
.wbv2-act .d { color: #667781; margin-top: 2px; }

.wbv2-row-kv { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; font-size: 12.5px; }
.wbv2-row-kv .k { color: #667781; }
.wbv2-row-kv .v { color: #111b21; font-weight: 500; }

/* Modal for Add Note */
.wbv2-modal-bg { position: fixed; inset: 0; background: rgba(11,20,26,.4); display: grid; place-items: center; z-index: 9999; }
.wbv2-modal { background: white; border-radius: 12px; padding: 20px; min-width: 380px; max-width: 90vw; box-shadow: 0 10px 40px rgba(0,0,0,.2); }
.wbv2-modal h3 { font-size: 15px; margin: 0 0 12px; color: #111b21; }
.wbv2-modal textarea { width: 100%; min-height: 100px; padding: 10px 12px; border: 1px solid #e9edef; border-radius: 8px; font-size: 13px; font-family: inherit; outline: none; resize: vertical; }
.wbv2-modal textarea:focus { border-color: #00a884; }
.wbv2-modal .acts { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
.wbv2-modal .btn-save { padding: 8px 16px; background: #00a884; color: white; border: none; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.wbv2-modal .btn-cancel { padding: 8px 16px; background: white; color: #54656f; border: 1px solid #e9edef; border-radius: 8px; font-size: 13px; cursor: pointer; }
`;
    document.head.appendChild(h('style', { id: 'wbv2-styles', html: css }));
  }

  /* ---------- shell ---------- */
  function shell() {
    const root = h('div', { class: 'wbv2-shell' },
      h('aside', { class: 'wbv2-threads', id: 'wbv2-threads' }, threadsPlaceholder()),
      h('section', { class: 'wbv2-chat', id: 'wbv2-chat' }, chatEmpty()),
      h('aside', { class: 'wbv2-lead', id: 'wbv2-lead' }, leadEmpty())
    );
    return root;
  }
  function threadsPlaceholder() {
    return h('div', { class: 'wbv2-list' }, h('div', { class: 'empty' }, 'Loading conversations…'));
  }
  function chatEmpty() {
    return h('div', { class: 'wbv2-c-empty' },
      h('div', { class: 'big' }, '💬'),
      h('div', null, 'Select a conversation to start'));
  }
  function leadEmpty() {
    return h('div', { class: 'wbv2-l-empty' }, 'Lead details will appear here.');
  }

  /* ---------- LEFT — threads ---------- */
  // v2.0 — flag any thread whose unread_count went UP between polls
  function _wbv2DiffNew(prevList, newList) {
    try {
      const prevMap = {};
      (prevList || []).forEach(function (t) { prevMap[t.lead_id] = Number(t.unread_count || 0); });
      const newSince = S._newSince || {};
      (newList || []).forEach(function (t) {
        const prevU = prevMap[t.lead_id] || 0;
        const nowU  = Number(t.unread_count || 0);
        if (nowU > prevU) newSince[t.lead_id] = Date.now();
      });
      S._newSince = newSince;
    } catch (_) {}
  }
  async function loadThreads() {
    try {
      const tenantBrand = (window.CRM && CRM.brand) || {};
      const opts = { scanLimit: 10000, show_all: true };
      const list = await api('api_wb_chat_threads', opts);
      const _prev = S.threadsRaw || [];
      S.threadsRaw = Array.isArray(list) ? list : [];
      _wbv2DiffNew(_prev, S.threadsRaw);
      // v2.0 — install silent auto-poll once. Refreshes thread list +
      // active chat every 20s so reps don't need to click Refresh.
      if (!S._wbv2_poller) {
        S._wbv2_poller = setInterval(async function () {
          try {
            const opts2 = { scanLimit: 10000, show_all: true };
            const list2 = await api('api_wb_chat_threads', opts2).catch(function () { return null; });
            if (Array.isArray(list2)) {
              const _prev2 = S.threadsRaw || [];
              S.threadsRaw = list2;
              _wbv2DiffNew(_prev2, S.threadsRaw);
              renderThreads();
              // v2.3 — also nudge the global topbar badge so the
              // 💬 unread count updates instantly when on the WA tab.
              try { if (typeof window._refreshWaBadge === 'function') window._refreshWaBadge(); } catch (_) {}
            }
            if (S.activeThread && S.activeThread.phone) {
              const r2 = await api('api_wb_chat_messages', S.activeThread.phone).catch(function () { return null; });
              const fresh = Array.isArray(r2) ? r2 : (r2 && r2.messages) || [];
              if (fresh.length && fresh.length !== S.messages.length) {
                S.messages = fresh;
                renderChat();
              }
            }
          } catch (_) { /* silent */ }
        }, 20000);
        try {
          window.addEventListener('hashchange', function () {
            if (!String(location.hash || '').includes('whatsbot') && S._wbv2_poller) {
              clearInterval(S._wbv2_poller); S._wbv2_poller = null;
            }
          });
        } catch (_) {}
      }
      renderThreads();
    } catch (e) {
      const c = $('#wbv2-threads');
      if (c) { c.innerHTML = ''; c.appendChild(h('div', { class: 'wbv2-list' }, h('div', { class: 'empty', style: { color: '#c04444' } }, 'Could not load: ' + e.message))); }
    }
  }
  function renderThreads() {
    const host = $('#wbv2-threads');
    if (!host) return;
    host.innerHTML = '';

    // Header — try CRM.brand, CRM._earlyBrand, then fall back to placeholder.
    // Both objects may exist depending on whether warmCache has finished.
    const brand = (function () {
      const c = (window.CRM || {});
      const b1 = c.brand || {};
      const b2 = c._earlyBrand || {};
      return Object.assign({}, b2, b1);   // b1 wins if both set
    })();
    const name  = brand.COMPANY_NAME || 'WhatsApp Inbox';
    const phone = brand.COMPANY_PHONE || '';
    const logoChar = (name || 'C').trim().charAt(0).toUpperCase();
    host.appendChild(h('div', { class: 'wbv2-th-head' },
      h('div', { class: 'brand' },
        h('div', { class: 'b-info' },
          h('div', { class: 'b-logo' }, logoChar),
          h('div', null,
            h('div', { class: 'b-name' }, name),
            h('div', { class: 'b-num' }, phone))),
        h('div', null,
          h('span', {
            class: 'ico', id: 'wbv2-refresh-btn', title: 'Refresh conversations',
            onclick: async (ev) => {
              const btn = ev.currentTarget;
              if (btn.classList.contains('spinning')) return;
              btn.classList.add('spinning');
              try {
                await loadThreads();
                if (S.activeThread) {
                  try { await loadMessages(S.activeThread); } catch (_) {}
                  try { await loadLead(S.activeLeadId); } catch (_) {}
                }
                toast('✓ Refreshed (' + (S.threadsRaw || []).length + ' conversations)', 'ok');
              } catch (e) {
                toast('Refresh failed: ' + e.message, 'err');
              } finally {
                try { (document.getElementById('wbv2-refresh-btn') || btn).classList.remove('spinning'); } catch (_) {}
              }
            }
          }, '↻'),
          h('span', { class: 'ico', title: 'Menu' }, '⋮')))));

    // Search
    host.appendChild(h('div', { class: 'wbv2-search' },
      h('div', { class: 'box' },
        h('span', { style: { color: '#54656f' } }, '🔍'),
        h('input', { placeholder: 'Search by name, phone, or message',
          value: S.search,
          oninput: (e) => { S.search = e.target.value; renderThreadList(); } }))));

    // Filter pills + assignee + phone selectors
    const unreadCount = (S.threadsRaw || []).filter(t => Number(t.unread_count || 0) > 0).length;
    const usersForFilter = S.users.length ? S.users : ((window.CRM && CRM.cache && CRM.cache.users) || []);
    const phonesForFilter = S.phones || [];

    const pillsRow = h('div', { class: 'wbv2-pills' },
      pill('All', 'all'),
      pill('Unread', 'unread', unreadCount > 0 ? unreadCount : null),
      pill('Mine', 'mine'));
    host.appendChild(pillsRow);

    // Second row: dropdowns for Agent + Phone Number — gives a clean two-tier
    // filter without overflowing the narrow left panel.
    const dropRow = h('div', { class: 'wbv2-pills', style: { paddingTop: '0' } });
    const selStyle = { padding: '6px 10px', background: 'white', color: '#54656f', border: '1px solid #e9edef', borderRadius: '8px', fontSize: '11px', cursor: 'pointer', outline: 'none', flex: '1', minWidth: '0' };
    const asSel = h('select', {
      style: selStyle,
      title: 'Filter by assigned agent',
      onchange: (e) => { S.filterAssignee = e.target.value || null; renderThreadList(); }
    }, h('option', { value: '' }, '👤 All agents (' + usersForFilter.length + ')'),
       ...usersForFilter.map(u => h('option', { value: u.id, selected: String(S.filterAssignee) === String(u.id) ? 'selected' : null }, u.name)));
    const phSel = h('select', {
      style: selStyle,
      title: 'Filter by WhatsApp phone number',
      onchange: (e) => { S.filterPhoneId = e.target.value || null; renderThreadList(); }
    }, h('option', { value: '' }, '📱 All numbers (' + phonesForFilter.length + ')'),
       ...phonesForFilter.map(p => h('option', { value: p.id, selected: String(S.filterPhoneId) === String(p.id) ? 'selected' : null }, (p.verified_name || p.display_phone_number || p.id).slice(0, 20))));
    dropRow.appendChild(asSel);
    dropRow.appendChild(phSel);
    host.appendChild(dropRow);

    // Recent / History tabs
    host.appendChild(h('div', { class: 'wbv2-tabs' },
      tab('🕒 Recent', 'recent', '(7d)'),
      tab('📜 History', 'history', '(30d)')));

    // List container
    const listEl = h('div', { class: 'wbv2-list', id: 'wbv2-list' });
    host.appendChild(listEl);
    renderThreadList();
  }
  function pill(label, key, count) {
    return h('span', {
      class: 'pill' + (S.filter === key ? ' active' : ''),
      onclick: () => { S.filter = key; renderThreads(); }
    }, label, count ? h('span', { class: 'c' }, String(count)) : null);
  }
  function tab(label, key, sub) {
    return h('div', {
      class: 'tab' + (S.tab === key ? ' active' : ''),
      onclick: () => { S.tab = key; renderThreadList(); }
    }, label, h('span', { class: 'sub' }, sub));
  }
  function renderThreadList() {
    const listEl = $('#wbv2-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const now = Date.now();
    const cutoffMs = (S.tab === 'recent' ? 7 : 30) * 86400 * 1000;
    const meId = (S.me && S.me.id) || null;
    const q = String(S.search || '').toLowerCase().trim();

    // v2.3 — Sort: unread/new threads ALWAYS bubble to top, then by
    // last_activity_at desc. Without this an old thread with new
    // unread messages could be 50 rows down because timestamp wasn't
    // updated by the WA webhook handler.
    const _sortedSrc = (S.threadsRaw || []).slice().sort(function (a, b) {
      const aU = Number(a.unread_count || 0);
      const bU = Number(b.unread_count || 0);
      const aNew = (S._newSince && S._newSince[a.lead_id]) ? 1 : 0;
      const bNew = (S._newSince && S._newSince[b.lead_id]) ? 1 : 0;
      // Tier 1: green-pulse "just arrived" wins
      if (aNew !== bNew) return bNew - aNew;
      // Tier 2: thread with more unread on top
      if (aU !== bU) return bU - aU;
      // Tier 3: most recent activity
      const aT = new Date(a.last_activity_at || a.last_msg_at || a.updated_at || 0).getTime();
      const bT = new Date(b.last_activity_at || b.last_msg_at || b.updated_at || 0).getTime();
      return bT - aT;
    });
    let rows = _sortedSrc.filter(t => {
      const last = t.last_activity_at || t.last_msg_at || t.updated_at;
      if (last) {
        const age = now - new Date(last).getTime();
        if (age > cutoffMs) return false;
      }
      if (S.filter === 'unread' && !Number(t.unread_count || 0)) return false;
      if (S.filter === 'mine' && meId && Number(t.assigned_to || 0) !== Number(meId)) return false;
      if (S.filterAssignee && Number(t.assigned_to || 0) !== Number(S.filterAssignee)) return false;
      if (S.filterPhoneId && String(t.phone_number_id || '') !== String(S.filterPhoneId)) return false;
      if (q) {
        const hay = ((t.lead_name || '') + ' ' + (t.phone || '') + ' ' + (t.last_message || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });

    if (!rows.length) {
      listEl.appendChild(h('div', { class: 'empty' }, S.threadsRaw.length ? 'No conversations match your filter.' : 'No conversations yet.'));
      return;
    }

    // v2.2 — backfill status_name from S.statusById when the API response
    // didn't include it (some threads come back with only status_id).
    rows.forEach(function (t) {
      if (!t.status_name && t.status_id && S.statusById && S.statusById[t.status_id]) {
        t.status_name = S.statusById[t.status_id].name;
        t.status_color = S.statusById[t.status_id].color || t.status_color;
      }
    });
    rows.forEach(t => listEl.appendChild(rowEl(t)));
  }
  function rowEl(t) {
    const name = t.lead_name || t.profile_name || t.phone || '—';
    // v2.2 — second-chance backfill in case the first pre-pass missed
    let statusName = t.status_name || '';
    let statusColor = t.status_color || '';
    if (!statusName && t.status_id && S.statusById && S.statusById[t.status_id]) {
      statusName  = S.statusById[t.status_id].name || '';
      statusColor = S.statusById[t.status_id].color || statusColor;
    }
    const sc = statusClass(statusName);
    const ownerName = t.assigned_name || t.user_name || '';
    const source = t.source || t.lead_source || '';
    const preview = t.last_message_preview || t.last_message || '';
    const previewIcon = t.last_message_type === 'template' ? '📋 '
                     : t.last_message_type === 'image'    ? '🖼 '
                     : t.last_message_type === 'audio'    ? '🎤 '
                     : t.last_message_type === 'video'    ? '🎬 '
                     : t.last_message_type === 'document' ? '📎 '
                     : '';
    const unread = Number(t.unread_count || 0);
    const score  = Number(t.ai_score || 0);
    const bucket = score >= 80 ? 'hot' : score >= 50 ? 'warm' : score > 0 ? 'cold' : '';

    const isActive = S.activeLeadId && Number(S.activeLeadId) === Number(t.lead_id);

    // v2.0 — green pulse highlight when a NEW inbound msg just arrived
    const isNew = !!(S._newSince && S._newSince[t.lead_id]);
    // v2.2 — status chip uses actual status.color when present; falls back to
    // heuristic class colors. ALWAYS renders so the user can see it on every row.
    const statusStyle = statusColor ? {
      background: _hexLight(statusColor),
      color: statusColor,
      border: '1px solid ' + _hexLight(statusColor, 0.7)
    } : null;
    const statusChip = statusName
      ? h('span', { class: 'wbv2-chip wbv2-chip-status ' + sc, style: statusStyle, title: 'Status: ' + statusName }, statusName)
      : h('span', { class: 'wbv2-chip wbv2-chip-status wbv2-chip-empty', title: 'No status set' }, '— No status —');
    return h('div', {
      class: 'wbv2-row' + (isActive ? ' active' : '') + (isNew && !isActive ? ' new-msg' : ''),
      onclick: () => activateThread(t)
    },
      h('div', { class: 'top' },
        statusChip,
        ownerName ? h('span', { class: 'owner' }, ownerName) : null),
      h('div', { class: 'body' },
        h('div', { class: 'av', style: { background: avatarColor(name) } }, initials(name)),
        h('div', { class: 'text' },
          h('div', { class: 'name' }, name),
          h('div', { class: 'preview' }, (previewIcon + (preview || ' ')).slice(0, 80)),
          source ? h('span', { class: 'source' }, source.toUpperCase().slice(0, 12)) : null),
        h('div', { class: 'right' },
          h('span', { class: 'when' }, fmtRelative(t.last_activity_at || t.last_msg_at || t.updated_at)),
          // v2.5 — NEW pill takes priority when a fresh inbound just arrived.
          // Persistent pulse so the user spots it even at a glance.
          isNew
            ? h('span', { class: 'wbv2-new-pill', title: 'New message just arrived' }, '\u26a1 NEW')
            : (unread > 0 ? h('span', { class: 'unread' }, String(unread)) :
                (bucket ? h('span', { class: 'ai ' + bucket }, String(score)) : null)))));
  }
  // v2.2 — hex → light pastel for chip backgrounds (alpha 1=palest, 0.7=border)
  function _hexLight(hex, alpha) {
    if (!hex || hex[0] !== '#') return hex;
    try {
      const h6 = hex.length === 4 ? '#' + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3] : hex;
      const r = parseInt(h6.slice(1, 3), 16);
      const g = parseInt(h6.slice(3, 5), 16);
      const b = parseInt(h6.slice(5, 7), 16);
      const a = (alpha === undefined ? 0.85 : alpha);
      const mix = function (c) { return Math.round(c + (255 - c) * a); };
      return 'rgb(' + mix(r) + ',' + mix(g) + ',' + mix(b) + ')';
    } catch (_) { return hex; }
  }
  async function activateThread(t) {
    S.activeLeadId = t.lead_id;
    S.activeThread = t;
    if (S._newSince && S._newSince[t.lead_id]) delete S._newSince[t.lead_id];
    S.lead = null; S.messages = []; S.aiScore = null; S.activity = [];
    renderThreadList();              // re-render to show active state
    renderChat();                    // shows loading
    renderLead();                    // shows loading
    await Promise.all([loadMessages(t), loadLead(t.lead_id)]);
  }

  /* ---------- MIDDLE — chat ---------- */
  async function loadMessages(t) {
    try {
      const r = await api('api_wb_chat_messages', t.phone);
      S.messages = Array.isArray(r) ? r : (r && r.messages) || [];
      renderChat();
    } catch (e) {
      const c = $('#wbv2-chat');
      if (c) { c.innerHTML = ''; c.appendChild(h('div', { class: 'wbv2-c-empty', style: { color: '#c04444' } }, 'Could not load chat: ' + e.message)); }
    }
  }
  function renderChat() {
    const host = $('#wbv2-chat');
    if (!host) return;
    host.innerHTML = '';

    if (!S.activeThread) {
      host.appendChild(chatEmpty());
      return;
    }
    const t = S.activeThread;
    const name = t.lead_name || t.profile_name || t.phone || '—';

    // TAT calc: time since last inbound that has no outbound after it
    const tatMs = computeTat(S.messages);

    host.appendChild(h('div', { class: 'wbv2-c-head' },
      h('div', { class: 'info' },
        h('div', { class: 'av', style: { background: avatarColor(name) } }, initials(name)),
        h('div', { class: 'nw' },
          h('div', { class: 'nm' }, name),
          h('div', { class: 'sub' }, (t.phone ? '+' + String(t.phone).replace(/^\+?/, '') : '') +
                                      (t.last_activity_at ? ' · last seen ' + fmtRelative(t.last_activity_at) : ''))),
        h('span', { class: 'wbv2-tat ' + (tatMs == null ? 'ok' : tatChipClass(tatMs)) },
          '⚡ ' + (tatMs == null ? '0m' : tatLabel(tatMs)) + ' TAT')),
      h('button', { class: 'btn', title: 'Mark as resolved (UI flag)',
        onclick: () => { toast('Resolved (local flag only — backend wiring next)', 'ok'); } }, '✓ Resolve'),
      h('button', { class: 'btn',
        onclick: openAssigneePopup }, '👤 ' + (t.assigned_name || 'Unassigned'), ' ▾'),
      h('div', { class: 'ico', title: 'Search' }, '🔍'),
      h('div', { class: 'ico', title: 'Open lead', onclick: () => {
        if (typeof window.openLeadModal === 'function') { try { window.openLeadModal(S.activeLeadId); return; } catch (_) {} }
        try { window.location.hash = '#/leads'; setTimeout(() => { try { window.openLeadModal && window.openLeadModal(S.activeLeadId); } catch (_) {} }, 500); } catch (_) {}
      } }, '⋮')));

    // sub-state bar
    const stats = S.lead ? '· ' + (S.lead.call_count || 0) + ' calls · ' + (S.messages.length) + ' msgs' : '';
    host.appendChild(h('div', { class: 'wbv2-c-substate' },
      (t.status_name ? h('span', { class: 'wbv2-chip ' + statusClass(t.status_name) }, t.status_name) : h('span', null)),
      h('span', null, t.last_activity_at ? 'Last activity ' + fmtRelative(t.last_activity_at) : ''),
      h('span', { style: { marginLeft: 'auto' } }, stats)));

    // body
    const body = h('div', { class: 'wbv2-c-body', id: 'wbv2-c-body' });
    host.appendChild(body);
    renderMessages(body);

    // v1.3 (2026-06-20) — closed-window banner removed per user feedback.
    // Composer is always on with full toolbar: emoji, attach (image / video /
    // document), template picker, text, voice, send. The 24h Meta restriction
    // surfaces only when Meta rejects a non-template send — we toast the error
    // and prompt the user to send a template instead, but we never block the UI.
    host.appendChild(h('div', { class: 'wbv2-composer' },
      h('div', { class: 'ico', title: 'Emoji', onclick: () => toast('Emoji picker coming soon', 'ok') }, '😊'),
      h('div', { class: 'ico', title: 'Attach a file', onclick: openAttachMenu }, '📎'),
      h('div', { class: 'ico', title: 'Send a template', onclick: openTemplatePicker }, '📋'),
      h('input', { id: 'wbv2-msg-input', placeholder: 'Type a message',
        onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } } }),
      h('div', { class: 'ico', title: 'Voice note coming soon', onclick: () => toast('Voice notes coming soon', 'ok') }, '🎤'),
      h('button', { class: 'send', onclick: sendMessage, title: 'Send' }, '➤')));

    // scroll to bottom
    setTimeout(() => { body.scrollTop = body.scrollHeight; }, 50);
  }
  function renderMessages(body) {
    body.innerHTML = '';
    if (!S.messages.length) {
      body.appendChild(h('div', { class: 'wbv2-c-empty' }, 'No messages yet.'));
      return;
    }
    let lastDate = '';
    S.messages.forEach(m => {
      const ts = m.created_at || m.timestamp || m.ts;
      const d = ts ? new Date(ts) : null;
      const dateKey = d ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() : '';
      if (dateKey && dateKey !== lastDate) {
        body.appendChild(h('div', { class: 'wbv2-date' }, h('span', null, dateKey)));
        lastDate = dateKey;
      }
      body.appendChild(messageEl(m));
    });
  }
  function messageEl(m) {
    const dir = m.direction === 'out' ? 'out' : 'in';
    const isTpl = m.message_type === 'template' || /template/i.test(m.type || '');
    const cls = 'wbv2-msg ' + dir + (isTpl ? ' tpl' : '');
    const body = m.body || m.text || '';
    const whoName = dir === 'out' ? (m.user_name || (m.user_id ? '' : '📱 Mobile') || 'You') : (S.activeThread && S.activeThread.lead_name) || '';
    const ts = m.created_at || m.timestamp || m.ts;
    const ticks = m.read_at ? '✓✓' : m.delivered_at ? '✓✓' : m.status === 'sent' ? '✓' : '';
    return h('div', { class: cls },
      dir === 'out' && whoName ? h('div', { class: 'who' + (isTpl ? ' tpl' : '') }, isTpl ? '📋 Template · ' + whoName : whoName) : null,
      h('div', { class: 'body' }, body),
      h('div', { class: 'meta' },
        ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '',
        ticks ? h('span', { class: 'ticks', style: { marginLeft: '4px' } }, ticks) : null));
  }
  function computeTat(msgs) {
    if (!msgs || !msgs.length) return null;
    // Find the latest inbound; if there's no out after it, TAT = now - inbound
    let lastIn = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.direction === 'in') { lastIn = m; break; }
      if (m.direction === 'out') return 0; // outbound came after last inbound
    }
    if (!lastIn) return null;
    const ts = lastIn.created_at || lastIn.timestamp || lastIn.ts;
    if (!ts) return null;
    return Math.max(0, Date.now() - new Date(ts).getTime());
  }
  function isClosedWindow(msgs) {
    if (!msgs || !msgs.length) return false;
    // Find last INBOUND timestamp; if > 24h ago, closed
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.direction === 'in') {
        const ts = m.created_at || m.timestamp || m.ts;
        if (!ts) return false;
        return (Date.now() - new Date(ts).getTime()) > 24 * 3600 * 1000;
      }
    }
    return true; // never any inbound — closed by default
  }
  async function sendMessage() {
    const inp = $('#wbv2-msg-input');
    if (!inp) return;
    const text = String(inp.value || '').trim();
    if (!text) return;
    const t = S.activeThread;
    if (!t) return;
    inp.value = '';
    try {
      await api('api_wb_chat_send', { to: t.phone, text });
      // Optimistic append + reload from server
      S.messages.push({ direction: 'out', body: text, created_at: new Date().toISOString(), status: 'sent', user_name: (S.me && S.me.name) || 'You' });
      renderChat();
      // Refresh in background
      setTimeout(() => loadMessages(t), 800);
    } catch (e) {
      inp.value = text;
      toast('Send failed: ' + e.message, 'err');
    }
  }
  /* v1.3 — Attach menu: image, video, document */
  function openAttachMenu() {
    if (!S.activeThread) return;
    const bg = h('div', { class: 'wbv2-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } },
      h('div', { class: 'wbv2-modal', style: { minWidth: '320px' } },
        h('h3', null, '📎 Attach a file'),
        h('div', { style: { display: 'grid', gap: '8px', marginTop: '8px' } },
          attachOption('🖼  Image', 'image/*', 'image'),
          attachOption('🎬  Video', 'video/*', 'video'),
          attachOption('📎  Document', '*/*', 'document')),
        h('div', { class: 'acts' },
          h('button', { class: 'btn-cancel', onclick: () => bg.remove() }, 'Cancel'))));
    document.body.appendChild(bg);
    function attachOption(label, accept, mediaType) {
      return h('button', {
        style: { padding: '14px 16px', background: '#f8f9fa', border: '1px solid #e9edef', borderRadius: '10px', fontSize: '14px', cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '10px' },
        onmouseover: function () { this.style.background = '#eef9f4'; this.style.borderColor = '#bbf7d0'; },
        onmouseout:  function () { this.style.background = '#f8f9fa'; this.style.borderColor = '#e9edef'; },
        onclick: () => { bg.remove(); pickFile(accept, mediaType); }
      }, label);
    }
  }
  function pickFile(accept, mediaType) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.style.display = 'none';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) { try { document.body.removeChild(inp); } catch (_) {} return; }
      try { document.body.removeChild(inp); } catch (_) {}
      await uploadAndSend(f, mediaType);
    };
    document.body.appendChild(inp);
    inp.click();
  }
  async function uploadAndSend(file, mediaType) {
    const t = S.activeThread;
    if (!t) return;
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    toast('Uploading ' + file.name + ' (' + sizeMB + ' MB)…', 'ok');
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Match existing app.js wbChat upload path — no tenant prefix needed;
      // server middleware resolves tenant from the request.
      const r = await fetch('/api/wa/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + _tok() },
        body: fd
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || ('upload failed (HTTP ' + r.status + ')'));
      // Now send via api_wb_chat_send with media_id
      await api('api_wb_chat_send', {
        phone: t.phone,
        media_id: j.wa_media_id,
        media_type: mediaType,
        filename: j.filename || file.name,
        text: ''
      });
      toast('Sent ' + (file.name || mediaType), 'ok');
      setTimeout(() => loadMessages(t), 800);
    } catch (e) {
      toast('Send failed: ' + e.message, 'err');
    }
  }

  async function openTemplatePicker() {
    try {
      if (!S.templates) S.templates = await api('api_wb_templates_list').catch(() => []);
      const tpls = (S.templates || []).filter(x => String(x.status || '').toUpperCase() === 'APPROVED');
      if (!tpls.length) return toast('No approved templates found.', 'err');
      // Simple modal: show list, click to send
      const bg = h('div', { class: 'wbv2-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } },
        h('div', { class: 'wbv2-modal' },
          h('h3', null, 'Select a template'),
          h('div', { style: { maxHeight: '50vh', overflowY: 'auto', border: '1px solid #e9edef', borderRadius: '8px' } },
            ...tpls.map(t => h('div', {
              style: { padding: '10px 12px', borderBottom: '1px solid #f0f2f5', cursor: 'pointer' },
              onmouseover: function () { this.style.background = '#f0f2f5'; },
              onmouseout: function () { this.style.background = ''; },
              onclick: () => { bg.remove(); sendTemplate(t); }
            }, h('div', { style: { fontWeight: 600, fontSize: '13px' } }, t.name || t.template_name),
               h('div', { style: { fontSize: '11px', color: '#667781', marginTop: '2px' } }, (t.language || '') + ' · ' + (t.category || '')))))
          ,
          h('div', { class: 'acts' },
            h('button', { class: 'btn-cancel', onclick: () => bg.remove() }, 'Cancel'))));
      document.body.appendChild(bg);
    } catch (e) { toast('Could not load templates: ' + e.message, 'err'); }
  }
  async function sendTemplate(tpl) {
    const t = S.activeThread;
    if (!t) return;
    try {
      await api('api_wb_chat_send', { to: t.phone, templateName: tpl.name || tpl.template_name, templateLanguage: tpl.language });
      toast('Template sent', 'ok');
      setTimeout(() => loadMessages(t), 800);
    } catch (e) { toast('Template send failed: ' + e.message, 'err'); }
  }
  async function openAssigneePopup() {
    if (!S.users.length) {
      try { S.users = await api('api_users_list') || []; } catch (_) { return toast('Cannot load users', 'err'); }
    }
    const t = S.activeThread;
    const bg = h('div', { class: 'wbv2-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } },
      h('div', { class: 'wbv2-modal' },
        h('h3', null, 'Reassign chat'),
        h('select', { id: 'wbv2-as-sel', style: { width: '100%', padding: '10px 12px', border: '1px solid #e9edef', borderRadius: '8px', fontSize: '13px' } },
          h('option', { value: '' }, '— Unassigned —'),
          ...S.users.map(u => h('option', { value: u.id, selected: Number(u.id) === Number(t.assigned_to) ? 'selected' : null }, u.name + (u.email ? ' (' + u.email + ')' : '')))),
        h('div', { class: 'acts' },
          h('button', { class: 'btn-cancel', onclick: () => bg.remove() }, 'Cancel'),
          h('button', { class: 'btn-save', onclick: async () => {
            const v = $('#wbv2-as-sel').value || null;
            try {
              await api('api_leads_update', S.activeLeadId, { assigned_to: v ? Number(v) : null });
              t.assigned_to = v ? Number(v) : null;
              const u = S.users.find(x => Number(x.id) === Number(v));
              t.assigned_name = u ? u.name : null;
              if (S.lead) { S.lead.assigned_to = t.assigned_to; S.lead.assigned_name = t.assigned_name; }
              bg.remove();
              renderChat(); renderLead(); renderThreadList();
              toast('Reassigned', 'ok');
            } catch (e) { toast('Failed: ' + e.message, 'err'); }
          } }, 'Save'))));
    document.body.appendChild(bg);
  }

  /* ---------- RIGHT — lead panel ---------- */
  async function loadLead(leadId) {
    try {
      const [lead, statuses, users, aiScore] = await Promise.all([
        api('api_leads_get', leadId).catch(() => null),
        S.statuses.length ? Promise.resolve(S.statuses) : api('api_statuses_list').catch(() => []),
        S.users.length    ? Promise.resolve(S.users)    : api('api_users_list').catch(() => []),
        api('api_leadScore_get', leadId).catch(() => null)
      ]);
      S.lead = lead && lead.lead ? lead.lead : lead;   // tolerate both shapes
      S.statuses = statuses || [];
      S.users = users || [];
      S.statusById = {}; S.statuses.forEach(s => { S.statusById[s.id] = s; });
      S.userById = {};   S.users.forEach(u => { S.userById[u.id] = u; });
      // AI Score lives under .lead.smart_score (api_leadScore_get response)
      S.aiScore = (aiScore && aiScore.lead) ? aiScore.lead : aiScore;
      // v2.1 — Pull activity from MULTIPLE sources so the timeline is
      // never empty: copilot timeline + remarks + recordings (with
      // duration). The copilot timeline alone can be score-only on
      // leads that never had a call/WA/remark, which left the panel
      // looking blank to the user.
      try {
        const [tl, remarks, recs] = await Promise.all([
          api('api_copilot_lead_timeline', { lead_id: leadId, limit: 50 }).catch(function () { return null; }),
          api('api_leads_remarks', leadId).catch(function () { return null; }),
          api('api_my_recordings', 200).catch(function () { return null; })
        ]);
        const tlEvents = (tl && Array.isArray(tl.events)) ? tl.events : (Array.isArray(tl) ? tl : []);
        const rmList   = Array.isArray(remarks) ? remarks : (remarks && (remarks.rows || remarks.remarks)) || [];
        const recList  = Array.isArray(recs) ? recs : (recs && (recs.rows || recs.recordings)) || [];
        const leadRecs = recList.filter(function (r) { return Number(r.lead_id) === Number(leadId); });
        const merged = tlEvents.slice();
        // Add remarks not yet represented in timeline (dedupe by created_at + text)
        const tlRemarkKey = {};
        tlEvents.filter(function (ev) { return ev.kind === 'remark'; }).forEach(function (ev) {
          tlRemarkKey[(ev.at || '') + '|' + String(ev.text || '').slice(0, 40)] = true;
        });
        rmList.forEach(function (r) {
          const at = r.created_at || r.at || r.ts;
          const text = r.remark || r.text || r.note || '';
          if (!tlRemarkKey[(at || '') + '|' + String(text).slice(0, 40)]) {
            merged.push({ kind: 'remark', at: at, text: text, by: r.created_by_name || r.user_name || r.author || '' });
          }
        });
        // Attach recordings to call events when within 10min, else emit synthetic call rows
        const usedRecs = {};
        merged.filter(function (ev) { return ev.kind === 'call' && !ev.recording; }).forEach(function (ev) {
          const callTs = new Date(ev.at).getTime();
          let best = null; let bestDiff = Infinity;
          leadRecs.forEach(function (rec) {
            if (usedRecs[rec.id]) return;
            const recTs = new Date(rec.created_at).getTime();
            const diff = Math.abs(callTs - recTs);
            if (diff < bestDiff && diff < 10 * 60 * 1000) { best = rec; bestDiff = diff; }
          });
          if (best) {
            usedRecs[best.id] = true;
            ev.recording = '/api/recordings/' + best.id + '/audio';
            ev.recording_id = best.id;
            if (!ev.duration && best.duration_s) ev.duration = best.duration_s;
          }
        });
        leadRecs.filter(function (r) { return !usedRecs[r.id]; }).slice(0, 10).forEach(function (r) {
          merged.push({
            kind: 'call', at: r.created_at, dir: r.direction || 'out',
            duration: r.duration_s, recording: '/api/recordings/' + r.id + '/audio',
            recording_id: r.id
          });
        });
        merged.sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
        S.activity = merged;
      } catch (_) { S.activity = []; }
      // AI Summary — v2.0 auto-fires on lead open (no button click required)
      S.aiSummary = null;
      S.aiSummaryLoading = true;
      S.aiSummaryError = null;
      renderLead();
      api('api_copilot_lead_summary', { lead_id: leadId }).then(function (r) {
        if (Number(S.activeLeadId) !== Number(leadId)) return;
        S.aiSummary = (r && (r.summary || r.text || r.body)) || '(no summary returned)';
        S.aiSummaryLoading = false;
        renderLead();
      }).catch(function (e) {
        if (Number(S.activeLeadId) !== Number(leadId)) return;
        S.aiSummary = null;
        S.aiSummaryLoading = false;
        S.aiSummaryError = (e && e.message) || 'AI summary failed';
        renderLead();
      });
    } catch (e) {
      const c = $('#wbv2-lead');
      if (c) { c.innerHTML = ''; c.appendChild(h('div', { class: 'wbv2-l-empty', style: { color: '#c04444' } }, 'Could not load lead: ' + e.message)); }
    }
  }
  function renderLead() {
    const host = $('#wbv2-lead');
    if (!host) return;
    host.innerHTML = '';
    if (!S.lead) {
      host.appendChild(h('div', { class: 'wbv2-l-empty' }, S.activeLeadId ? 'Loading lead…' : 'Select a conversation to see lead details.'));
      return;
    }
    const l = S.lead;
    const name = l.name || l.phone || '—';

    // Header
    host.appendChild(h('div', { class: 'wbv2-l-head' },
      h('div', { class: 'av', style: { background: avatarColor(name) } }, initials(name)),
      h('div', { class: 'nm' }, name),
      h('div', { class: 'ph' }, '📞 ' + (l.phone || '—')),
      h('div', { class: 'crt' }, 'Created ' + fmtRelative(l.created_at)),
      h('div', { class: 'acts' },
        h('button', { class: 'btn-call', onclick: () => { try { window.openCallModal && window.openCallModal(l.id); } catch (_) { window.location.href = 'tel:' + l.phone; } } }, '📞 Call'),
        h('button', { class: 'btn-view', onclick: () => {
          if (typeof window.openLeadModal === 'function') {
            try { window.openLeadModal(l.id); return; } catch (_) {}
          }
          // Fallback: open leads view + try a delayed openLeadModal call
          try { window.location.hash = '#/leads'; setTimeout(() => { try { window.openLeadModal && window.openLeadModal(l.id); } catch (_) {} }, 500); } catch (_) {}
        } }, '👁 View'))));

    // Quick-edit panel — Status (dropdown) + Next Follow-up Date (datetime) + Assigned To (dropdown)
    const curStatus = S.statusById[l.status_id];
    const sClass = curStatus ? statusClass(curStatus.name) : '';
    const fuIso = l.next_followup_at;
    const fuOverdue = fuIso && new Date(fuIso) < new Date();

    const qe = h('div', { class: 'wbv2-qe' },
      h('div', { class: 'f' },
        h('span', { class: 'lab' }, '🎯 Status'),
        h('select', {
          class: 'chip-' + sClass,
          onchange: async (e) => {
            const v = e.target.value;
            try { await api('api_leads_update', l.id, { status_id: Number(v) }); l.status_id = Number(v); renderLead(); toast('Status updated', 'ok'); reloadActiveThread(); } catch (err) { toast(err.message, 'err'); }
          }
        }, ...S.statuses.map(s => h('option', { value: s.id, selected: Number(s.id) === Number(l.status_id) ? 'selected' : null }, s.name)))),
      h('div', { class: 'f' },
        h('span', { class: 'lab' }, '⏰ Next Follow-up Date'),
        h('input', {
          type: 'datetime-local',
          class: fuOverdue ? 'fu-overdue' : '',
          value: isoToLocalDtInput(fuIso),
          onchange: async (e) => {
            const iso = localDtInputToIso(e.target.value);
            try { await api('api_leads_update', l.id, { next_followup_at: iso }); l.next_followup_at = iso; renderLead(); toast('Follow-up updated', 'ok'); reloadActiveThread(); } catch (err) { toast(err.message, 'err'); }
          }
        })),
      h('div', { class: 'f' },
        h('span', { class: 'lab' }, '👤 Assigned To'),
        h('select', {
          onchange: async (e) => {
            const v = e.target.value;
            try { await api('api_leads_update', l.id, { assigned_to: v ? Number(v) : null }); l.assigned_to = v ? Number(v) : null; const u = S.userById[v]; l.assigned_name = u ? u.name : null; renderLead(); toast('Reassigned', 'ok'); reloadActiveThread(); } catch (err) { toast(err.message, 'err'); }
          }
        }, h('option', { value: '' }, '— Unassigned —'),
           ...S.users.map(u => h('option', { value: u.id, selected: Number(u.id) === Number(l.assigned_to) ? 'selected' : null }, u.name)))));
    host.appendChild(qe);

    // Add Note button
    host.appendChild(h('div', { class: 'wbv2-addnote' },
      h('button', { onclick: openAddNote }, '📝 Add Note / Remark')));

    // Notes — v1.7 moved here (right below Add Note action) per user request.
    // Renders leads.notes (single rolling field maintained by api_leads_addRemark).
    if (l.notes) {
      host.appendChild(h('div', { class: 'wbv2-sec' },
        h('div', { class: 'lab' }, h('span', null, '📝 Notes / Remarks')),
        h('div', { class: 'wbv2-note', style: { whiteSpace: 'pre-wrap', maxHeight: '180px', overflowY: 'auto' } }, String(l.notes).slice(0, 2000))));
    }

    // AI Score (api_leadScore_get returns under .lead with smart_score / smart_category)
    const score = S.aiScore ? Number(S.aiScore.smart_score || S.aiScore.score || 0) : 0;
    if (score > 0) {
      const cat = String(S.aiScore.smart_category || '').toLowerCase();
      const label = cat === 'hot' ? '🔥 HOT LEAD' : cat === 'warm' ? '☀️ WARM LEAD' : cat === 'cold' ? '🧊 COLD LEAD' : (score >= 80 ? '🔥 HOT LEAD' : score >= 50 ? '☀️ WARM LEAD' : '🧊 COLD LEAD');
      host.appendChild(h('div', { class: 'wbv2-sec' },
        h('div', { class: 'lab' }, '🤖 AI Score'),
        h('div', { class: 'wbv2-ai' },
          h('div', { class: 'score' }, String(score)),
          h('div', { class: 'meta' },
            h('b', null, label),
            h('div', null, S.aiScore.score_reason || S.aiScore.reason || '')))));
    }

    // AI Summary — v2.0 auto-fires on lead open
    host.appendChild(h('div', { class: 'wbv2-sec' },
      h('div', { class: 'lab' }, '✨ AI Summary'),
      S.aiSummary
        ? h('div', { style: { padding: '10px 12px', background: 'linear-gradient(135deg, #f0f4ff 0%, #fff8f0 100%)', border: '1px solid #d4dffd', borderRadius: '10px', fontSize: '12px', color: '#1e293b', lineHeight: '1.5', whiteSpace: 'pre-wrap' } }, S.aiSummary)
        : S.aiSummaryLoading
          ? h('div', { style: { padding: '10px 12px', background: 'linear-gradient(135deg, #f0f4ff 0%, #fff8f0 100%)', border: '1px solid #d4dffd', borderRadius: '10px', fontSize: '12px', color: '#6366f1', display: 'flex', alignItems: 'center', gap: '8px' } },
              h('span', { style: { display: 'inline-block', width: '12px', height: '12px', border: '2px solid #c7d2fe', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'wbv2-spin 0.7s linear infinite' } }),
              '⏳ Generating summary…')
          : h('button', {
              style: { width: '100%', padding: '10px 14px', background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)', color: 'white', border: 'none', borderRadius: '10px', fontSize: '13px', fontWeight: '600', cursor: 'pointer' },
              onclick: async function () {
                this.disabled = true; this.textContent = '⏳ Asking AI…';
                S.aiSummaryLoading = true;
                try {
                  const r = await api('api_copilot_lead_summary', { lead_id: l.id });
                  S.aiSummary = (r && (r.summary || r.text || r.body)) || 'No summary returned.';
                  S.aiSummaryLoading = false;
                  renderLead();
                } catch (e) { S.aiSummaryLoading = false; this.disabled = false; this.textContent = S.aiSummaryError ? '✨ Retry AI Summary' : '✨ Generate AI Summary'; toast(e.message, 'err'); }
              }
            }, S.aiSummaryError ? '✨ Retry AI Summary' : '✨ Generate AI Summary')));

    // Recent Activity (v2.1 — ALWAYS show with scrollable container; empty state when no events)
    {
      const realEvents = Array.isArray(S.activity)
        ? S.activity.filter(function (ev) { return ev && ev.kind !== 'score'; })
        : [];
      const sec = h('div', { class: 'wbv2-sec' },
        h('div', { class: 'lab', style: { position: 'sticky', top: '0', background: 'white', zIndex: '2', borderBottom: '1px solid #f1f5f9', paddingBottom: '4px' } },
          h('span', null, '📊 Recent Activity'),
          h('span', { style: { fontSize: '10px', fontWeight: '500', color: '#94a3b8', marginLeft: '4px' } }, '(' + realEvents.length + ')'),
          realEvents.length
            ? h('span', { class: 'tog', onclick: function () { if (typeof window.openLeadModal === 'function') { try { window.openLeadModal(l.id); return; } catch (_) {} } try { window.location.hash = '#/leads'; setTimeout(function () { try { window.openLeadModal && window.openLeadModal(l.id); } catch (_) {} }, 500); } catch (_) {} } }, 'View full →')
            : null));
      if (!realEvents.length) {
        sec.appendChild(h('div', { style: { padding: '12px', textAlign: 'center', color: '#94a3b8', fontSize: '12px', background: '#f8fafc', borderRadius: '8px', marginTop: '6px' } }, 'No call / WhatsApp / note activity yet'));
      } else {
        const list = h('div', { style: { maxHeight: '320px', overflowY: 'auto', overflowX: 'hidden', paddingRight: '4px', marginRight: '-4px' } });
        realEvents.forEach(function (ev) { list.appendChild(activityRow(ev)); });
        sec.appendChild(list);
      }
      host.appendChild(sec);
    }

    // Last Call card (most recent call event with optional recording link)
    const calls = (S.activity || []).filter(ev => ev.kind === 'call');
    if (calls.length) {
      const c = calls[0];
      const dirLabel = c.dir === 'in' ? '📞 Incoming' : c.dir === 'out' ? '📞 Outgoing' : c.dir === 'missed' ? '📵 Missed' : '📞 Call';
      const durLabel = c.duration ? Math.floor(c.duration / 60) + 'm ' + (c.duration % 60) + 's' : '';
      host.appendChild(h('div', { class: 'wbv2-sec' },
        h('div', { class: 'lab' }, '📞 Last Call'),
        h('div', { style: { padding: '10px 12px', background: '#f8f9fa', borderRadius: '10px', border: '1px solid #e9edef' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
            h('b', { style: { fontSize: '12.5px' } }, dirLabel + (durLabel ? ' · ' + durLabel : '')),
            h('span', { style: { fontSize: '10px', color: '#8696a0' } }, fmtRelative(c.at))),
          c.recording ? h('audio', { controls: 'controls', src: c.recording, style: { width: '100%', marginTop: '8px', height: '32px' } }) :
                        h('div', { style: { fontSize: '11px', color: '#8696a0', marginTop: '4px' } }, 'No recording attached'))));
    }



    // Lead info / custom fields
    const kv = [];
    if (l.email)       kv.push(['Email', l.email]);
    if (l.source)      kv.push(['Source', l.source]);
    if (l.product_name)kv.push(['Product', l.product_name]);
    if (l.city)        kv.push(['City', l.city]);
    if (l.tags)        kv.push(['Tags', l.tags]);
    if (kv.length) {
      const sec = h('div', { class: 'wbv2-sec' }, h('div', { class: 'lab' }, 'ℹ️ Lead Info'));
      kv.forEach(([k, v]) => sec.appendChild(h('div', { class: 'wbv2-row-kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, String(v)))));
      host.appendChild(sec);
    }
  }
  function openAddNote() {
    if (!S.lead) return;
    const bg = h('div', { class: 'wbv2-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } },
      h('div', { class: 'wbv2-modal' },
        h('h3', null, '📝 Add Note for ' + (S.lead.name || S.lead.phone || 'this lead')),
        h('textarea', { id: 'wbv2-note-input', placeholder: 'Write a quick remark…', autofocus: true }),
        h('div', { class: 'acts' },
          h('button', { class: 'btn-cancel', onclick: () => bg.remove() }, 'Cancel'),
          h('button', { class: 'btn-save', onclick: async () => {
            const txt = String($('#wbv2-note-input').value || '').trim();
            if (!txt) return;
            try {
              await api('api_leads_addRemark', S.lead.id, { remark: txt });
              bg.remove();
              toast('Note added', 'ok');
              loadLead(S.lead.id);
            } catch (e) { toast(e.message, 'err'); }
          } }, 'Save Note'))));
    document.body.appendChild(bg);
    setTimeout(() => $('#wbv2-note-input').focus(), 50);
  }
  function activityRow(ev) {
    const k = ev.kind || '';
    const ico = k === 'wa'     ? (ev.dir === 'in' ? '💬' : '💚')
              : k === 'call'   ? (ev.dir === 'missed' ? '📵' : ev.dir === 'in' ? '📥' : '📤')
              : k === 'remark' ? '📝'
              : k === 'score'  ? '🎯'
              : k === 'status' ? '🏷️'
              : k === 'followup' ? '⏰'
              : k === 'assign' ? '👤'
              : '•';
    const who = k === 'wa' ? (ev.dir === 'in' ? 'WhatsApp received' : 'WhatsApp sent')
              : k === 'call' ? (ev.dir === 'in' ? 'Call incoming' : ev.dir === 'out' ? 'Call outgoing' : ev.dir === 'missed' ? 'Call missed' : 'Call')
              : k === 'remark' ? 'Remark added' + (ev.by ? ' · ' + ev.by : '')
              : k === 'status' ? 'Status changed' + (ev.new_status ? ' → ' + ev.new_status : (ev.label ? ' → ' + ev.label : ''))
              : k === 'followup' ? 'Follow-up ' + (ev.action || 'updated')
              : k === 'assign' ? 'Reassigned' + (ev.new_owner ? ' → ' + ev.new_owner : '')
              : k === 'score' ? 'AI Score changed (' + (ev.old_score || 0) + ' → ' + (ev.new_score || 0) + ')'
              : (ev.label || ev.kind || 'Activity');
    // v2.1 — rich call detail: 'Talk 1m 14s' + ▶ Play button when there's a recording
    let detail = null;
    if (k === 'call') {
      const dSec = Number(ev.duration || 0);
      const talk = dSec ? 'Talk ' + (dSec >= 3600 ? (Math.floor(dSec/3600)+'h '+Math.floor((dSec%3600)/60)+'m') : (Math.floor(dSec/60)+'m '+(dSec%60)+'s')) : 'no duration';
      const bits = [h('span', null, talk)];
      if (ev.recording) {
        bits.push(h('span', null, ' · '));
        bits.push(h('a', {
          href: 'javascript:void(0)',
          style: { color: '#6366f1', cursor: 'pointer', fontWeight: '600' },
          onclick: function () {
            try {
              const slug = (window.TENANT_SLUG ? '/t/' + window.TENANT_SLUG : '');
              const tok  = (window.CRM && CRM.token) ? CRM.token : '';
              let path = String(ev.recording || '').replace(/^\/t\/[^/]+/, '');
              if (!path.startsWith('/')) path = '/' + path;
              const url = slug + path + (tok ? (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok) : '');
              const a = new Audio(url); a.play().catch(function (e) { toast('Cannot play: ' + e.message, 'err'); });
            } catch (e) { toast('Play failed: ' + e.message, 'err'); }
          }
        }, '▶ Play'));
      }
      detail = h('div', { class: 'd' }, bits);
    } else if (k === 'wa' || k === 'remark') {
      detail = h('div', { class: 'd' }, String(ev.text || '').slice(0, 140));
    } else if (k === 'status') {
      detail = ev.old_status ? h('div', { class: 'd' }, 'was: ' + ev.old_status) : null;
    } else if (k === 'score') {
      detail = h('div', { class: 'd' }, ev.reason_text || ev.trigger_event || '');
    }
    return h('div', { class: 'wbv2-act' },
      h('div', { class: 'ico' }, ico),
      h('div', { class: 'b' },
        h('div', { class: 'h' },
          h('span', { class: 'who' }, who),
          h('span', { class: 'w', title: ev.at ? new Date(ev.at).toLocaleString('en-IN') : '' }, fmtDateTimeRel(ev.at))),
        detail));
  }

  function reloadActiveThread() {
    // refresh thread list so latest status/owner reflects in left panel
    if (S.activeThread) {
      const i = S.threadsRaw.findIndex(x => Number(x.lead_id) === Number(S.activeLeadId));
      if (i >= 0 && S.lead) {
        S.threadsRaw[i].status_name = S.statusById[S.lead.status_id] && S.statusById[S.lead.status_id].name || S.threadsRaw[i].status_name;
        S.threadsRaw[i].assigned_to = S.lead.assigned_to;
        S.threadsRaw[i].assigned_name = S.lead.assigned_name;
        S.activeThread = S.threadsRaw[i];
      }
      renderThreadList();
    }
  }

  /* ---------- entry point ---------- */
  /**
   * Returns the DOM element representing the 3-column WhatsApp chat shell.
   * Caller (legacy wbChat() in app.js) mounts it inside #wb-body, preserving
   * the parent sub-tab navigation (Connect / Templates / Bot Flows / etc).
   * Data loading happens asynchronously after the element is returned.
   */
  function render() {
    injectStyles();
    const root = shell();
    // Defer data loads so the shell mounts first (caller does replaceChildren).
    setTimeout(async () => {
      try { S.me = await api('api_me').catch(() => null); } catch (_) {}
      try { S.users  = await api('api_users_list').catch(() => []) || []; } catch (_) {}
      try { S.phones = await api('api_wb_phones_list').catch(() => []) || []; } catch (_) {}
      // v2.2 — eagerly load statuses so thread rows can backfill status_name
      // from status_id on first paint (without waiting for a lead click).
      try {
        S.statuses = await api('api_statuses_list').catch(() => []) || [];
        S.statusById = {}; S.statuses.forEach(function (s) { S.statusById[s.id] = s; });
        if ((S.threadsRaw || []).length) renderThreads();
      } catch (_) {}
      try { await loadThreads(); } catch (_) {}
      // Re-render pills row now that users + phones are in
      try { renderThreads(); } catch (_) {}
    }, 0);
    return root;
  }

  window.WB_CHAT_V2 = { render };
})();
