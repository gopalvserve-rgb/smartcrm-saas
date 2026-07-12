/* WB_CHAT_V2_MOBILE (2026-07-12) — Mobile-only WhatsApp Inbox redesign.
 *
 * Reproduces the approved mockup EXACTLY: dark stat header, 4-tile stat row,
 * filter chips, WhatsApp-style thread rows, chat screen with lead quick-info
 * banner (status pill + phone + Timeline + View Lead / number picker + agent
 * + Remark), messages area (template + incoming + outgoing bubbles), pill
 * composer with quick chips, plus 5 bottom-sheet overlays (Templates /
 * Options / Status picker / Number picker / Remarks) and a full lead
 * Timeline screen.
 *
 * Uses only existing tenant APIs — no new backend endpoints:
 *   api_wb_chat_threads, api_wb_chat_messages, api_wb_send,
 *   api_wb_sendTemplate, api_wb_botPauseStatus, api_wb_phones_list,
 *   api_wb_templates_list, api_statuses_list, api_users_list,
 *   api_leads_get, api_leads_update, api_leads_addRemark,
 *   api_leads_timeline, api_leads_remarks.
 *
 * Public entry: window.WB_CHAT_V2_MOBILE.render(view).
 */
(function () {
  'use strict';

  /* =============================================================
   * 1. TOKEN + API PLUMBING
   * ============================================================= */
  var SLUG = (function () {
    var m = location.pathname.match(/\/t\/([^\/]+)/);
    return m ? m[1] : '';
  })();
  function _tok() {
    return localStorage.getItem('crm_token_' + SLUG) ||
           localStorage.getItem('crm_token') || '';
  }
  function api(fn) {
    var args = Array.prototype.slice.call(arguments, 1);
    return fetch('/t/' + SLUG + '/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: [_tok()].concat(args) })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || j.error) throw new Error(j.error || 'API error');
        return j.result;
      });
    });
  }

  /* =============================================================
   * 2. h() DOM HELPER (SmartCRM convention)
   * ============================================================= */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.charAt(0) === 'o' && k.charAt(1) === 'n' && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v);
        }
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'value') el.value = v;
        else if (k === 'ref' && typeof v === 'function') v(el);
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c == null || c === false) continue;
      if (Array.isArray(c)) {
        for (var j = 0; j < c.length; j++) {
          var cc = c[j];
          if (cc == null || cc === false) continue;
          el.appendChild(typeof cc === 'string' || typeof cc === 'number'
            ? document.createTextNode(String(cc)) : cc);
        }
      } else {
        el.appendChild(typeof c === 'string' || typeof c === 'number'
          ? document.createTextNode(String(c)) : c);
      }
    }
    return el;
  }
  function svg(inner, attrs) {
    var wrap = document.createElement('div');
    var open = '<svg xmlns="http://www.w3.org/2000/svg"';
    for (var k in (attrs || {})) open += ' ' + k + '="' + attrs[k] + '"';
    wrap.innerHTML = open + '>' + inner + '</svg>';
    return wrap.firstChild;
  }
  function toast(msg, kind) {
    try {
      (window.toast || window.tenantToast || function (m) { console.log(m); })(msg, kind);
    } catch (_) {}
  }

  /* =============================================================
   * 3. COLOR TOKENS (verbatim from mockup)
   * ============================================================= */
  var C = {
    bgDark:      '#07111E',
    bgDark2:     '#0F2240',
    headerDark:  '#0A1628',
    green:       '#25D366',
    greenDark:   '#00A884',
    greenDarker: '#007A62',
    successBg:   '#D1FAE5',
    successFg:   '#065F46',
    successDark: '#16A34A',
    chatBg:      '#EFEAE2',
    listBg:      '#F0F2F5',
    cardBg:      '#ffffff',
    divider:     '#F3F4F6',
    dividerLight:'#F9FAFB',
    leadInfoBg:      '#EFF6FF',
    leadInfoBorder:  '#DBEAFE',
    leadBtn:         '#1D4ED8',
    timelineBtn:  { bg: '#E0F2FE', fg: '#0369A1' },
    remarkBtn:    { bg: '#FEF3C7', fg: '#92400E' },
    numBtn:       'rgba(37,211,102,0.12)',
    numBtnBorder: 'rgba(37,211,102,0.35)',
    hotBg:   '#FEE2E2', hotFg:   '#B91C1C',
    warmBg:  '#FEF3C7', warmFg:  '#92400E',
    qualBg:  '#D1FAE5', qualFg:  '#065F46',
    closedBg:'#F3F4F6', closedFg:'#374151',
    textPri:     '#111B21',
    textMeta:    '#667781',
    textDarkMeta:'#8BA5B8',
    textSecondary:'#6B7280',
    textMuted:   '#9CA3AF',
    readTick:    '#53BDEB',
    chipTpl:    { bg: '#EFF6FF', border: '#DBEAFE', fg: '#2563EB' },
    chipAttach: { bg: '#F0FDF4', border: '#BBF7D0', fg: '#15803D' },
    chipLoc:    { bg: '#FFF7ED', border: '#FED7AA', fg: '#C2410C' },
    chipAudio:  { bg: '#F5F3FF', border: '#DDD6FE', fg: '#7C3AED' },
    optResolved:{ bg: '#D1FAE5', fg: '#059669' },
    optAssign:  { bg: '#DBEAFE', fg: '#2563EB' },
    optNote:    { bg: '#FEF3C7', fg: '#D97706' },
    optFollow:  { bg: '#F3E8FF', fg: '#9333EA' },
    optBlock:   { bg: '#FEE2E2', fg: '#DC2626' },
    remarkAuthor:'#6366F1',
    remarkAccent:'#F59E0B'
  };

  /* =============================================================
   * 4. STATE
   * ============================================================= */
  var S = {
    // data
    threads: [],
    messages: [],
    templates: null,
    phones: [],
    statuses: [],
    users: [],
    lead: null,
    timeline: [],
    remarks: [],

    // active selection
    activeThread: null,
    /* WA_MOBILE_V1_2 — server-side search + pagination state */
    page: 1,
    pageSize: 50,
    hasMore: false,
    loadingMore: false,
    searchDebouncer: null,
    activePhone: null,
    activeLeadId: null,
    sendFromId: null,

    // UI state
    screen: 'list',        // list | chat | search | timeline
    filter: 'all',         // all | unread | open | resolved
    search: '',
    tplSearch: '',
    overlay: null,         // null | templates | options | status | number | remarks
    inputText: '',
    newRemark: '',

    // misc
    view: null,
    poller: null,
    lastRender: 0
  };

  /* =============================================================
   * 5. TIME + INITIALS + AVATAR HELPERS
   * ============================================================= */
  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function avatarColor(seed) {
    var palette = ['#EF4444','#F59E0B','#10B981','#3B82F6','#8B5CF6','#EC4899','#14B8A6','#F97316','#6366F1','#84CC16'];
    var n = 0, s = String(seed || '');
    for (var i = 0; i < s.length; i++) n = ((n << 5) - n + s.charCodeAt(i)) | 0;
    return palette[Math.abs(n) % palette.length];
  }
  function fmtChatTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
    }
    var y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    var diffD = Math.floor((now - d) / 86400000);
    if (diffD < 7) return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  function fmtMsgTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  function fmtRelativeShort(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var s = Math.floor((Date.now() - d) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  function fmtFull(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
    });
  }

  /* =============================================================
   * 6. STATUS PILL COLOR HELPERS
   * ============================================================= */
  function statusColors(name, apiColor) {
    var n = String(name || '').toLowerCase();
    // honour DB color when present
    if (apiColor) {
      return { bg: hexAlpha(apiColor, 0.15), fg: apiColor, border: hexAlpha(apiColor, 0.3) };
    }
    if (/hot|callback|urgent|fire/.test(n))           return { bg: C.hotBg,   fg: C.hotFg,   border:'#FECACA' };
    if (/warm|nurture|call.?back|follow/.test(n))     return { bg: C.warmBg,  fg: C.warmFg,  border:'#FDE68A' };
    if (/qual|won|hot lead|converted|paid|active/.test(n))
      return { bg: C.qualBg,  fg: C.qualFg,  border:'#A7F3D0' };
    if (/lost|junk|not.?int|closed|resolved/.test(n))
      return { bg: C.closedBg,fg: C.closedFg,border:'#E5E7EB' };
    if (/new/.test(n))                                 return { bg:'#DBEAFE', fg:'#1D4ED8', border:'#BFDBFE' };
    return { bg: C.closedBg, fg: C.closedFg, border:'#E5E7EB' };
  }
  function hexAlpha(hex, a) {
    hex = String(hex || '').replace('#','');
    if (hex.length === 3) hex = hex.split('').map(function(c){return c+c;}).join('');
    var r = parseInt(hex.slice(0,2),16),
        g = parseInt(hex.slice(2,4),16),
        b = parseInt(hex.slice(4,6),16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgba(107,114,128,'+a+')';
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function statusStage(name) {
    var n = String(name || '').toLowerCase();
    if (/resolv|closed|lost|won|junk/.test(n)) return 'resolved';
    if (/new|unread|open|contact|nurture|hot|warm|qual|prop/.test(n)) return 'open';
    return 'open';
  }
  function categoryColors(cat) {
    var n = String(cat || '').toUpperCase();
    if (n === 'MARKETING')     return { bg:'#FEF3C7', fg:'#92400E' };
    if (n === 'UTILITY')       return { bg:'#DBEAFE', fg:'#1E40AF' };
    if (n === 'AUTHENTICATION')return { bg:'#F3E8FF', fg:'#7E22CE' };
    return { bg:'#F3F4F6', fg:'#374151' };
  }

  /* =============================================================
   * 7. STYLE INJECTION
   * ============================================================= */
  function injectStyles() {
    if (document.getElementById('wbv2m-styles')) return;
    // Inter font
    if (!document.querySelector('link[data-wbv2m-font]')) {
      var lnk = document.createElement('link');
      lnk.setAttribute('data-wbv2m-font', '1');
      lnk.rel = 'stylesheet';
      lnk.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
      document.head.appendChild(lnk);
    }
    var css = ''
      + '@keyframes wbv2m-slideRight { from { transform: translateX(100%); } to { transform: translateX(0); } }'
      + '@keyframes wbv2m-slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }'
      + '@keyframes wbv2m-fadeIn { from { opacity: 0; } to { opacity: 1; } }'
      + '@keyframes wbv2m-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }'
      + '.wbv2m *, .wbv2m *::before, .wbv2m *::after { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }'
      + '.wbv2m { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: ' + C.textPri + '; }'
      + '.wbv2m ::-webkit-scrollbar { width: 0; height: 0; }'
      + '.wbv2m { scrollbar-width: none; -ms-overflow-style: none; }'
      + '.wbv2m input, .wbv2m textarea, .wbv2m button { font-family: inherit; }'
      + '.wbv2m button { -webkit-appearance: none; appearance: none; }'
      + '.wbv2m-row-tap:active { background: #F3F4F6 !important; }'
      + '.wbv2m-chip-tap:active { transform: scale(0.96); }'
      + '.wbv2m-btn-tap:active { transform: scale(0.97); }'
      + '.wbv2m-send-btn:active { transform: scale(0.92); }'
      + '.wbv2m-badge-pulse { animation: wbv2m-pulse 1.6s ease-in-out infinite; }'
      + '.wbv2m-screen { animation: wbv2m-slideRight 0.26s cubic-bezier(0.25,0.46,0.45,0.94); }'
      + '.wbv2m-sheet   { animation: wbv2m-slideUp    0.30s cubic-bezier(0.25,0.46,0.45,0.94); }'
      + '.wbv2m-fade    { animation: wbv2m-fadeIn     0.18s ease; }'
    ;
    var st = document.createElement('style');
    st.id = 'wbv2m-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* =============================================================
   * 8. SHARED SVG ICONS
   * ============================================================= */
  var ICON = {
    waLogo: function (fill) {
      return svg(
        '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="' + fill + '"></path>'
      + '<path d="M11.99 2C6.469 2 2 6.47 2 11.99c0 1.76.461 3.413 1.268 4.845L2 22l5.289-1.247C8.73 21.573 10.33 22 11.99 22 17.52 22 22 17.53 22 12.01 22 6.47 17.52 2 11.99 2zm0 18.01c-1.54 0-3.04-.418-4.35-1.209l-.312-.185-3.139.74.784-3.047-.203-.32C3.917 14.727 3.5 13.388 3.5 11.99 3.5 7.297 7.297 3.5 11.99 3.5c4.694 0 8.51 3.797 8.51 8.51 0 4.693-3.816 8.5-8.51 8.5z" fill="' + fill + '"></path>'
      , { width: 20, height: 20, viewBox: '0 0 24 24' });
    },
    search: function (stroke) {
      return svg(
        '<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.35-4.35"></path>',
        { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.2', 'stroke-linecap': 'round' });
    },
    compose: function (stroke) {
      return svg(
        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>'
      + '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
        { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.2', 'stroke-linecap': 'round' });
    },
    back: function (stroke) {
      return svg(
        '<path d="M19 12H5"></path><path d="M12 5l-7 7 7 7"></path>',
        { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    },
    phone: function (fill) {
      return svg(
        '<path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.58.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.01L6.6 10.8z"></path>',
        { width: 19, height: 19, viewBox: '0 0 24 24', fill: fill });
    },
    kebab: function (fill) {
      return svg(
        '<circle cx="12" cy="5" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="12" cy="19" r="1.8"></circle>',
        { width: 19, height: 19, viewBox: '0 0 24 24', fill: fill });
    },
    caret: function (stroke) {
      return svg('<path d="M6 9l6 6 6-6"></path>',
        { width: 9, height: 9, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '3.5', 'stroke-linecap': 'round' });
    },
    clock: function (stroke) {
      return svg(
        '<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>',
        { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin':'round' });
    },
    smallWa: function (fill) {
      return svg(
        '<path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51H7c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.87 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41z"></path>',
        { width: 11, height: 11, viewBox: '0 0 24 24', fill: fill });
    },
    pencil: function (stroke) {
      return svg(
        '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>'
      + '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
        { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap': 'round' });
    },
    file: function (fill) {
      return svg(
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"></path>'
      + '<polyline points="14 2 14 8 20 8"></polyline>'
      + '<line x1="16" y1="13" x2="8" y2="13"></line>'
      + '<line x1="16" y1="17" x2="8" y2="17"></line>',
        { width: 12, height: 12, viewBox: '0 0 24 24', fill: fill });
    },
    send: function () {
      return svg(
        '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path>',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'white' });
    },
    check: function (stroke) {
      return svg('<polyline points="20 6 9 17 4 12"></polyline>',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin':'round' });
    },
    checkThick: function (stroke) {
      return svg('<polyline points="20 6 9 17 4 12"></polyline>',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '3', 'stroke-linecap':'round','stroke-linejoin':'round' });
    },
    user: function (stroke) {
      return svg(
        '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill:'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap':'round','stroke-linejoin':'round' });
    },
    calendar: function (stroke) {
      return svg(
        '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>'
      + '<line x1="16" y1="2" x2="16" y2="6"></line>'
      + '<line x1="8" y1="2" x2="8" y2="6"></line>'
      + '<line x1="3" y1="10" x2="21" y2="10"></line>',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill:'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap':'round','stroke-linejoin':'round' });
    },
    block: function (stroke) {
      return svg(
        '<circle cx="12" cy="12" r="10"></circle>'
      + '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>',
        { width: 18, height: 18, viewBox: '0 0 24 24', fill:'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap':'round','stroke-linejoin':'round' });
    },
    chevron: function (stroke) {
      return svg('<path d="M9 18l6-6-6-6"></path>',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: stroke, 'stroke-width': '2.5', 'stroke-linecap':'round','stroke-linejoin':'round' });
    },
    smallSearchGrey: function () {
      return svg(
        '<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.35-4.35"></path>',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill:'none', stroke:'#9CA3AF','stroke-width':'2.5','stroke-linecap':'round' });
    },
    fileGrey: function () {
      return svg(
        '<path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>',
        { width: 11, height: 11, viewBox: '0 0 24 24', fill:'#9CA3AF' });
    }
  };

  /* =============================================================
   * 9. DATA LOADING
   * ============================================================= */
  function loadThreads(loadMoreOpts) {
    /* WA_MOBILE_V1_2 — search + pagination: send q/page/page_size + status */
    var opts = { scanLimit: 10000, show_all: true, page: S.page || 1, page_size: S.pageSize || 50 };
    if (S.search) opts.q = String(S.search).trim();
    if (S.filter && S.filter !== 'all') opts.status_filter = String(S.filter);
    if (loadMoreOpts && loadMoreOpts.page) opts.page = loadMoreOpts.page;
    return api('api_wb_chat_threads', opts)
      .then(function (list) {
        /* v1_3 — track hasMore for Load More button. */
        var incoming = Array.isArray(list) ? list : [];
        var isPageAppend = !!(loadMoreOpts && loadMoreOpts.page && loadMoreOpts.page > 1);
        if (isPageAppend) {
          S.threads = (S.threads || []).concat(incoming);
        } else {
          S.threads = incoming;
        }
        S.hasMore = incoming.length === (S.pageSize || 50);
        S.threads.sort(function (a, b) {
          var ta = new Date(a.last_msg_at || 0).getTime();
          var tb = new Date(b.last_msg_at || 0).getTime();
          return tb - ta;
        });
      })
      .catch(function () { S.threads = []; });
  }
  function loadMessages(phone) {
    return api('api_wb_chat_messages', phone)
      .then(function (r) {
        var arr = Array.isArray(r) ? r : (r && r.messages) || [];
        S.messages = arr;
      })
      .catch(function () { S.messages = []; });
  }
  function loadTemplates() {
    if (S.templates) return Promise.resolve();
    return api('api_wb_templates_list')
      .then(function (r) {
        S.templates = Array.isArray(r) ? r : (r && r.items) || [];
      })
      .catch(function () { S.templates = []; });
  }
  function loadPhones() {
    return api('api_wb_phones_list')
      .then(function (r) { S.phones = Array.isArray(r) ? r : []; })
      .catch(function () { S.phones = []; });
  }
  function loadStatuses() {
    return api('api_statuses_list')
      .then(function (r) { S.statuses = Array.isArray(r) ? r : []; })
      .catch(function () { S.statuses = []; });
  }
  function loadUsers() {
    return api('api_users_list')
      .then(function (r) { S.users = Array.isArray(r) ? r : []; })
      .catch(function () { S.users = []; });
  }
  function loadLead(id) {
    if (!id) { S.lead = null; return Promise.resolve(); }
    return api('api_leads_get', id)
      .then(function (r) { S.lead = r || null; })
      .catch(function () { S.lead = null; });
  }
  function loadTimeline(id) {
    if (!id) { S.timeline = []; return Promise.resolve(); }
    return api('api_leads_timeline', id)
      .then(function (r) {
        if (Array.isArray(r)) S.timeline = r;
        else if (r && Array.isArray(r.items)) S.timeline = r.items;
        else S.timeline = [];
      })
      .catch(function () { S.timeline = []; });
  }
  function loadRemarks(id) {
    if (!id) { S.remarks = []; return Promise.resolve(); }
    return api('api_leads_remarks', id)
      .then(function (r) {
        if (Array.isArray(r)) S.remarks = r;
        else if (r && Array.isArray(r.items)) S.remarks = r.items;
        else S.remarks = [];
      })
      .catch(function () { S.remarks = []; });
  }

  /* =============================================================
   * 10. FILTERED / DERIVED VIEWS
   * ============================================================= */
  function filteredThreads() {
    var q = String(S.search || '').trim().toLowerCase();
    return S.threads.filter(function (t) {
      // filter chip
      if (S.filter === 'unread') {
        var u = Number(t.unread || t.unread_count || 0);
        if (u <= 0) return false;
      } else if (S.filter === 'open') {
        if (statusStage(t.status_name) !== 'open') return false;
      } else if (S.filter === 'resolved') {
        if (statusStage(t.status_name) !== 'resolved') return false;
      }
      // search
      if (q) {
        var hay = ((t.lead_name || '') + ' ' + (t.phone || '') + ' ' + (t.company || '') + ' ' + (t.last_msg || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }
  function computeStats() {
    var stats = { unread: 0, open: 0, resolved: 0, total: 0 };
    S.threads.forEach(function (t) {
      stats.total++;
      var u = Number(t.unread || t.unread_count || 0);
      if (u > 0) stats.unread += u;
      var stage = statusStage(t.status_name);
      if (stage === 'open') stats.open++;
      else if (stage === 'resolved') stats.resolved++;
    });
    return stats;
  }
  function filteredTemplates() {
    var q = String(S.tplSearch || '').trim().toLowerCase();
    var arr = S.templates || [];
    if (!q) return arr;
    return arr.filter(function (t) {
      var hay = ((t.name || '') + ' ' + (t.body || '') + ' ' + (t.category || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  /* =============================================================
   * 11. LIST SCREEN
   * ============================================================= */
  function renderList() {
    var stats = computeStats();
    /* v2_0 — compact stat tiles */
    var stat = function (num, label, color) {
      return h('div', { style: {
        background:'rgba(255,255,255,0.08)', borderRadius:'8px',
        padding:'5px 6px', flex:'1', textAlign:'center'
      }},
        h('div', { style: { color: color, fontSize:'15px', fontWeight:'700', lineHeight:'1' } }, String(num || 0)),
        h('div', { style: { color: C.textDarkMeta, fontSize:'9px', marginTop:'1px', fontWeight:'500' } }, label)
      );
    };
    var chip = function (id, label) {
      var active = S.filter === id;
      return h('button', {
        class: 'wbv2m-chip-tap',
        style: {
          background: active ? C.headerDark : '#F3F4F6',
          color:      active ? '#fff'       : '#4B5563',
          border: 'none', borderRadius:'100px',
          padding:'6px 14px', fontSize:'12.5px', fontWeight:'600',
          cursor:'pointer', whiteSpace:'nowrap', flexShrink:'0',
          transition:'all 0.15s ease'
        },
        onclick: function () { S.filter = id; rerender(); }
      }, label);
    };
    var stripHeader = h('div', { style: {
      background: C.headerDark, padding: '8px 12px 10px', flexShrink: '0'
    }},
      h('div', { style: {
        display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:'6px'
      }},
        h('div', { style: { display:'flex', alignItems:'center', gap:'8px' }},
          /* v2_0 — compact logo */
          h('div', { style: {
            width:'32px', height:'32px', background:C.green, borderRadius:'8px',
            display:'flex', alignItems:'center', justifyContent:'center',
            boxShadow:'0 1px 4px rgba(37,211,102,0.3)'
          }}, ICON.waLogo('white', 18)),
          /* v2_1 — no more SmartCRM title, just the WA icon; version
           * badge kept ultra-subtle as data attribute on the container */
          h('span', {
            'data-wa-mobile-version': 'v2.1',
            style: { color: 'rgba(255,255,255,0.35)', fontSize:'9px', fontWeight:'600' }
          }, 'v2.1')
        ),
        /* v2_0 — FULL VIEW button removed per user request */
        null
      ),
      h('div', { style: { display:'flex', gap:'8px' }},
        stat(stats.unread,   'Unread',   C.green),
        stat(stats.open,     'Open',     '#F59E0B'),
        stat(stats.resolved, 'Resolved', '#10B981'),
        stat(stats.total,    'Total',    '#6366F1')
      ),
      /* v1_6 — INLINE SEARCH BOX right in the header, guaranteed visible */
      (function () {
        var searchWrap = h('div', {
          style: {
            marginTop:'6px', display:'flex', alignItems:'center', gap:'6px',
            background:'#fff', borderRadius:'10px', padding:'6px 10px',
            border:'1px solid rgba(255,255,255,0.35)'
          }
        });
        searchWrap.appendChild(h('span', { style: { fontSize:'16px', flexShrink:'0' }}, '🔍'));
        var searchInput = h('input', {
          type: 'text',
          value: S.search || '',
          placeholder: 'Search name, phone, or message…',
          /* Explicit dark-on-white for guaranteed visibility */
          style: {
            flex:'1', border:'none', outline:'none', background:'transparent',
            fontSize:'14px', color:'#111827', minWidth:'0', padding:'1px 0'
          },
          oninput: function (e) {
            S.search = e.target.value;
            /* Immediate local re-filter */
            rerender();
            /* Debounced server search */
            try { if (S.dSrchT) clearTimeout(S.dSrchT); } catch (_) {}
            S.dSrchT = setTimeout(function () {
              S.dSearch = S.search; S.page = 1;
              loadThreads().then(rerender).catch(function () {});
            }, 400);
          }
        });
        searchWrap.appendChild(searchInput);
        /* Big red X clear button when there's text */
        if (S.search) {
          var xBtn = h('button', {
            style: {
              background:'#DC2626', color:'#fff', border:'none', borderRadius:'50%',
              width:'26px', height:'26px', cursor:'pointer', fontSize:'14px',
              fontWeight:'700', display:'flex', alignItems:'center',
              justifyContent:'center', flexShrink:'0', lineHeight:'1'
            },
            onclick: function () {
              S.search = ''; S.dSearch = ''; S.page = 1;
              loadThreads().then(rerender);
            }
          }, '✕');
          searchWrap.appendChild(xBtn);
        }
        return searchWrap;
      })()
    );

    var chips = h('div', { style: {
      display:'flex', gap:'6px', padding:'8px 12px', background:'#fff',
      borderBottom:'1px solid #E5E7EB', flexShrink:'0', overflowX:'auto'
    }},
      chip('all',      'All'),
      chip('unread',   'Unread'),
      chip('open',     'Open'),
      chip('resolved', 'Resolved')
    );

    var list = h('div', { style: { flex:'1', overflowY:'auto', background:'#fff' }});
    var rows = filteredThreads();
    if (!rows.length) {
      list.appendChild(h('div', { style: { padding:'48px 24px', textAlign:'center' }},
        h('div', { style: { fontSize:'36px', marginBottom:'12px' }}, '💬'),
        h('div', { style: { fontSize:'15px', fontWeight:'600', color:'#374151', marginBottom:'6px' }}, 'No conversations yet'),
        h('div', { style: { fontSize:'13px', color:'#9CA3AF' }},
          S.filter === 'all' ? 'Messages will appear here when they arrive.' : 'Try a different filter')
      ));
    } else {
      rows.forEach(function (t) { list.appendChild(threadRow(t, false)); });
      /* v1_5 — inline pagination row at the BOTTOM of the scrollable list
       * (not floating). Follows the last conversation, respects scroll. */
      if (S.hasMore) {
        var loadRow = h('button', {
          style: {
            display:'block', width:'calc(100% - 32px)', margin:'12px 16px 20px',
            background:'#fff', border:'2px dashed #00A884', color:'#00A884',
            padding:'14px', borderRadius:'12px', fontSize:'14px', fontWeight:'700',
            cursor:'pointer'
          },
          onclick: function () {
            if (S.loadingMore) return;
            S.loadingMore = true;
            loadRow.textContent = 'Loading page ' + ((S.page || 1) + 1) + '…';
            var nextPage = (S.page || 1) + 1;
            loadThreads({ page: nextPage }).then(function () {
              S.page = nextPage;
              S.loadingMore = false;
              rerender();
            }).catch(function () {
              S.loadingMore = false;
              loadRow.textContent = '⚠ Retry — Load next page';
            });
          }
        }, '⬇ Load page ' + ((S.page || 1) + 1) + '  (next 50 chats)');
        list.appendChild(loadRow);
      } else if ((S.page || 1) > 1) {
        list.appendChild(h('div', {
          style: { textAlign:'center', color:'#9CA3AF', fontSize:'12px',
                   padding:'16px 12px 24px', fontStyle:'italic' }
        }, '— End of conversations · ' + rows.length + ' shown across ' + (S.page || 1) + ' pages —'));
      }
    }

    return h('div', { style: {
      position:'absolute', inset:'0',
      display:'flex', flexDirection:'column', background: C.listBg
    }}, stripHeader, chips, list);
  }

  function threadRow(t, compact) {
    var bg = t.lead_avatar_color || avatarColor(t.lead_name || t.phone);
    var stColors = statusColors(t.status_name, t.status_color);
    var unread = Number(t.unread || t.unread_count || 0);
    var badge = unread > 0;
    var timeColor = badge ? C.green : C.textMeta;
    var avatarSize = compact ? 46 : 52;
    var initSize = compact ? '15px' : '17px';
    var row = h('div', {
      class: 'wbv2m-row-tap',
      style: {
        display:'flex', padding:'12px 16px', borderBottom:'1px solid ' + C.divider,
        cursor:'pointer', alignItems:'center', gap:'12px', background:'#fff'
      },
      onclick: function () { openChat(t); }
    },
      // avatar
      h('div', { style: { position:'relative', flexShrink:'0' }},
        h('div', { style: {
          width: avatarSize + 'px', height: avatarSize + 'px', borderRadius:'50%',
          background: bg, display:'flex', alignItems:'center', justifyContent:'center',
          color:'#fff', fontWeight:'700', fontSize: initSize
        }}, initials(t.lead_name || t.phone)),
        !compact ? h('div', { style: {
          position:'absolute', bottom:'2px', right:'2px', width:'13px', height:'13px',
          borderRadius:'50%', background: C.green, border:'2px solid #fff'
        }}) : null
      ),
      // right side
      h('div', { style: { flex:'1', minWidth:'0' }},
        h('div', { style: { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'3px' }},
          h('span', { style: { fontWeight:'600', fontSize:'15px', color:C.textPri, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }},
            t.lead_name || t.phone || '(unnamed)'),
          h('span', { style: { fontSize:'11.5px', color: timeColor, flexShrink:'0', marginLeft:'8px', fontWeight:'500' }},
            fmtChatTime(t.last_msg_at))
        ),
        h('div', { style: { display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'5px' }},
          h('span', { style: { fontSize:'13px', color: C.textMeta, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', flex:'1', marginRight:'8px' }},
            t.last_msg || ''),
          badge ? h('div', { style: {
            background: C.green, color:'#fff', borderRadius:'100px',
            minWidth:'20px', height:'20px', fontSize:'11px', fontWeight:'700',
            display:'flex', alignItems:'center', justifyContent:'center',
            padding:'0 5px', flexShrink:'0'
          }}, String(unread)) : null
        ),
        h('div', { style: { display:'flex', alignItems:'center', gap:'5px', flexWrap:'nowrap', overflow:'hidden' }},
          h('span', { style: {
            background: stColors.bg, color: stColors.fg,
            fontSize:'10px', fontWeight:'700', padding:'2px 7px',
            borderRadius:'100px', flexShrink:'0'
          }}, t.status_name || 'New'),
          t.company ? h('span', { style: { fontSize:'11px', color:'#D1D5DB' }}, '·') : null,
          t.company ? h('span', { style: { fontSize:'11px', color:'#9CA3AF', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}, t.company) : null,
          t.assigned_name ? h('span', { style: { fontSize:'11px', color:'#D1D5DB' }}, '·') : null,
          t.assigned_name ? h('span', { style: { fontSize:'11px', color:'#9CA3AF', flexShrink:'0' }}, t.assigned_name) : null
        )
      )
    );
    return row;
  }

  /* =============================================================
   * 12. CHAT SCREEN
   * ============================================================= */
  function renderChat() {
    var t = S.activeThread || {};
    var bg = t.lead_avatar_color || avatarColor(t.lead_name || t.phone);
    var stColors = statusColors(t.status_name, t.status_color);

    // Header
    var header = h('div', { style: { background: C.headerDark, padding:'8px 8px 8px 4px', flexShrink:'0' }},
      h('div', { style: { display:'flex', alignItems:'center', gap:'4px' }},
        h('button', {
          class:'wbv2m-btn-tap',
          style: { background:'none', border:'none', cursor:'pointer', padding:'8px', display:'flex', alignItems:'center', flexShrink:'0' },
          onclick: function () { S.screen = 'list'; S.activeThread = null; S.activePhone = null; S.activeLeadId = null; rerender(); }
        }, ICON.back('white')),
        h('div', { style: {
          width:'38px', height:'38px', borderRadius:'50%', background: bg,
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'#fff', fontWeight:'700', fontSize:'14px', flexShrink:'0',
          cursor:'pointer', position:'relative'
        }},
          initials(t.lead_name || t.phone),
          h('div', { style: {
            position:'absolute', bottom:'1px', right:'1px', width:'10px', height:'10px',
            borderRadius:'50%', background: C.green, border:'2px solid ' + C.headerDark
          }})
        ),
        h('div', { style: { flex:'1', minWidth:'0', paddingLeft:'2px' }},
          h('div', { style: { color:'#fff', fontWeight:'600', fontSize:'15px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }},
            t.lead_name || t.phone || 'Unknown'),
          h('div', { style: { display:'flex', alignItems:'center', gap:'5px', marginTop:'1px' }},
            h('span', { style: {
              background: stColors.bg, color: stColors.fg,
              fontSize:'9px', fontWeight:'700', padding:'1px 6px', borderRadius:'100px', flexShrink:'0'
            }}, t.status_name || 'New'),
            t.company ? h('span', { style: { color: C.textDarkMeta, fontSize:'11px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}, t.company) : null
          )
        ),
        h('div', { style: { display:'flex', alignItems:'center', flexShrink:'0' }},
          h('button', {
            class:'wbv2m-btn-tap',
            style: { background:'none', border:'none', cursor:'pointer', padding:'8px', display:'flex', alignItems:'center' },
            onclick: function () {
              if (t.phone) window.location.href = 'tel:' + t.phone;
            }
          }, ICON.phone(C.textDarkMeta)),
          h('button', {
            class:'wbv2m-btn-tap',
            style: { background:'none', border:'none', cursor:'pointer', padding:'8px', display:'flex', alignItems:'center' },
            onclick: function () { S.overlay = 'options'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {} rerender(); }
          }, ICON.kebab(C.textDarkMeta))
        )
      )
    );

    // Lead quick-info banner (2 rows)
    var selectedNumberLabel = (function () {
      var pid = S.sendFromId || t.phone_number_id;
      var found = null;
      for (var i = 0; i < S.phones.length; i++) {
        var p = S.phones[i];
        if (String(p.id) === String(pid) || String(p.phone_number_id || '') === String(pid)) { found = p; break; }
      }
      if (found) return found.phone || found.display_phone_number || 'WA';
      if (S.phones.length) return S.phones[0].phone || S.phones[0].display_phone_number || 'WA';
      return 'WhatsApp';
    })();

    var agentName = (S.lead && S.lead.assigned_name) || t.assigned_name || 'Unassigned';
    var remarksCount = (S.remarks || []).length;

    var banner = h('div', { style: {
      background: C.leadInfoBg, padding:'8px 14px', borderBottom:'1px solid ' + C.leadInfoBorder, flexShrink:'0'
    }},
      // Row 1
      h('div', { style: { display:'flex', alignItems:'center', gap:'7px', marginBottom:'7px' }},
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            display:'flex', alignItems:'center', gap:'4px',
            background: stColors.bg, color: stColors.fg, border:'1px solid ' + stColors.border,
            borderRadius:'100px', padding:'4px 10px', fontSize:'11px', fontWeight:'700',
            cursor:'pointer', flexShrink:'0'
          },
          onclick: function () { S.overlay = 'status'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {} rerender(); }
        }, t.status_name || 'New', ICON.caret(stColors.fg)),
        h('span', { style: {
          fontSize:'11px', color:'#374151', fontWeight:'500', flex:'1',
          minWidth:'0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'
        }}, '📱 ' + (t.phone || '')),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background: C.timelineBtn.bg, border:'none', borderRadius:'7px',
            padding:'4px 9px', fontSize:'11px', fontWeight:'600', color: C.timelineBtn.fg,
            cursor:'pointer', display:'flex', alignItems:'center', gap:'3px', flexShrink:'0'
          },
          onclick: function () { S.screen = 'timeline'; rerender(); }
        }, ICON.clock(C.timelineBtn.fg), 'Timeline'),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background: C.leadBtn, color:'#fff', border:'none', borderRadius:'7px',
            padding:'4px 9px', fontSize:'11px', fontWeight:'600', cursor:'pointer', flexShrink:'0'
          },
          onclick: function () { openLead(S.activeLeadId); }
        }, 'Lead →')
      ),
      // Row 2
      h('div', { style: { display:'flex', alignItems:'center', gap:'7px' }},
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            display:'flex', alignItems:'center', gap:'5px',
            background: C.numBtn, border:'1px solid ' + C.numBtnBorder,
            borderRadius:'6px', padding:'4px 9px', cursor:'pointer', flexShrink:'0'
          },
          onclick: function () { S.overlay = 'number'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {} rerender(); }
        },
          ICON.smallWa(C.successDark),
          h('span', { style: { fontSize:'11px', fontWeight:'600', color:'#15803D' }}, selectedNumberLabel),
          ICON.caret('#15803D')
        ),
        h('span', { style: { fontSize:'11px', color:'#6B7280', flex:'1', minWidth:'0', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }},
          'Agent: ' + agentName),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background: C.remarkBtn.bg, border:'none', borderRadius:'7px',
            padding:'4px 9px', fontSize:'11px', fontWeight:'600', color: C.remarkBtn.fg,
            cursor:'pointer', display:'flex', alignItems:'center', gap:'3px', flexShrink:'0'
          },
          onclick: function () {
            S.overlay = 'remarks'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {}
            if (S.activeLeadId) loadRemarks(S.activeLeadId).then(rerender);
            else rerender();
          }
        }, ICON.pencil(C.remarkBtn.fg), 'Remark ' + remarksCount)
      )
    );

    // Messages
    var messagesArea = h('div', { style: {
      flex:'1', overflowY:'auto', background: C.chatBg,
      padding:'8px 0 6px', position:'relative'
    }},
      h('div', { style: { display:'flex', justifyContent:'center', marginBottom:'10px' }},
        h('span', { style: {
          background:'rgba(255,255,255,0.88)', color: C.textMeta, fontSize:'11px', fontWeight:'500',
          padding:'4px 14px', borderRadius:'100px', boxShadow:'0 1px 2px rgba(0,0,0,0.08)'
        }}, 'Today')
      )
    );
    (S.messages || []).forEach(function (m) {
      messagesArea.appendChild(renderMessage(m));
    });
    var end = h('div', { style: { height:'4px' }});
    messagesArea.appendChild(end);
    // scroll to bottom after mount
    setTimeout(function () { try { messagesArea.scrollTop = messagesArea.scrollHeight; } catch (_) {} }, 30);

    // Composer
    var composer = renderComposer();

    return h('div', { style: {
      position:'absolute', inset:'0', display:'flex', flexDirection:'column'
    }, class: 'wbv2m-screen'},
      header, banner, messagesArea, composer);
  }

  function renderMessage(m) {
    var dir = (m.direction || '').toLowerCase();
    var isIn = dir === 'in' || dir === 'inbound';
    var isOut = !isIn;
    var isTemplate = !!(m.template_name || m.is_template);
    var body = m.body || m.text || '';
    var time = fmtMsgTime(m.timestamp || m.created_at || m.sent_at);

    var justify = isOut ? 'flex-end' : 'flex-start';
    var row = h('div', { style: {
      display:'flex', justifyContent: justify, padding:'0 12px', marginBottom:'6px'
    }});

    if (isTemplate && isOut) {
      var bubble = h('div', { style: {
        maxWidth:'75%',
        background:'#fff',
        borderRadius:'12px 12px 4px 12px',
        overflow:'hidden',
        boxShadow:'0 1px 1px rgba(0,0,0,0.08)'
      }},
        h('div', { style: {
          background:'linear-gradient(135deg,' + C.greenDark + ' 0%,' + C.greenDarker + ' 100%)',
          padding:'7px 12px', display:'flex', alignItems:'center', gap:'6px'
        }},
          ICON.file('white'),
          h('span', { style: {
            color:'rgba(255,255,255,0.95)', fontSize:'10px', fontWeight:'600',
            textTransform:'uppercase', letterSpacing:'0.4px'
          }}, 'Template · ' + (m.template_name || 'sent'))
        ),
        h('div', { style: { padding:'10px 12px 8px' }},
          h('p', { style: {
            margin:'0 0 6px', fontSize:'13px', color: C.textPri, lineHeight:'1.55', whiteSpace:'pre-line'
          }}, body || '(template sent)'),
          h('div', { style: { display:'flex', justifyContent:'flex-end', alignItems:'center', gap:'3px', marginTop:'4px' }},
            h('span', { style: { fontSize:'10.5px', color: C.textMeta }}, time),
            h('span', { style: { color: C.readTick, fontSize:'14px', lineHeight:'1' }}, '✓✓')
          )
        )
      );
      row.appendChild(bubble);
      return row;
    }
    if (isIn) {
      var bIn = h('div', { style: {
        maxWidth:'75%', background:'#fff',
        borderRadius:'12px 12px 12px 4px',
        padding:'7px 10px 5px',
        boxShadow:'0 1px 1px rgba(0,0,0,0.08)'
      }},
        h('p', { style: { margin:'0 0 4px', fontSize:'14px', color: C.textPri, lineHeight:'1.5', whiteSpace:'pre-wrap' }}, body),
        h('span', { style: { fontSize:'10.5px', color: C.textMeta, display:'block', textAlign:'right' }}, time)
      );
      row.appendChild(bIn);
      return row;
    }
    // Outgoing text
    var bOut = h('div', { style: {
      maxWidth:'75%', background:'#D9FDD3',
      borderRadius:'12px 12px 4px 12px',
      padding:'7px 10px 5px',
      boxShadow:'0 1px 1px rgba(0,0,0,0.08)'
    }},
      h('p', { style: { margin:'0 0 4px', fontSize:'14px', color: C.textPri, lineHeight:'1.5', whiteSpace:'pre-wrap' }}, body),
      h('div', { style: { display:'flex', justifyContent:'flex-end', alignItems:'center', gap:'3px' }},
        h('span', { style: { fontSize:'10.5px', color: C.textMeta }}, time),
        h('span', { style: { color: C.readTick, fontSize:'14px', lineHeight:'1' }}, '✓✓')
      ),
      m.user_name ? h('div', { style: { fontSize:'10px', color: C.textMeta, marginTop:'2px' }}, 'via ' + m.user_name) : null
    );
    row.appendChild(bOut);
    return row;
  }

  function renderComposer() {
    var hasText = !!(S.inputText && S.inputText.trim());
    var sendBg = hasText ? C.green : '#E5E7EB';

    var input = h('input', {
      value: S.inputText || '',
      placeholder: 'Type a message…',
      style: {
        flex:'1', background:'none', border:'none', outline:'none',
        fontSize:'16px', color: C.textPri, minWidth:'0'
      },
      /* v1_4 — on focus, scroll the composer into view so the mobile keyboard
       * doesn't cover it. Also fontSize:16px prevents iOS zoom-on-focus. */
      onfocus: function (e) {
        try {
          setTimeout(function () {
            e.target.scrollIntoView({ block: 'end', behavior: 'smooth' });
          }, 300);
        } catch (_) {}
      },
      oninput: function (e) {
        S.inputText = e.target.value;
        // hot-swap send button color without full rerender
        try {
          var btn = e.target.parentNode.querySelector('.wbv2m-send-btn');
          btn.style.background = (e.target.value && e.target.value.trim()) ? C.green : '#E5E7EB';
        } catch (_) {}
      },
      onkeypress: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); handleSend(); }
      }
    });

    var chip = function (bg, border, fg, label, onclick) {
      return h('button', {
        class:'wbv2m-chip-tap',
        style: {
          background: bg, border:'1px solid ' + border, color: fg,
          borderRadius:'100px', padding:'5px 12px', fontSize:'12px', fontWeight:'600',
          cursor:'pointer', whiteSpace:'nowrap', flexShrink:'0',
          display:'flex', alignItems:'center', gap:'5px'
        },
        onclick: onclick || function () {}
      }, label);
    };
    var quickRow = h('div', { style: {
      display:'flex', gap:'6px', marginBottom:'8px', overflowX:'auto', paddingBottom:'2px'
    }},
      h('button', {
        class:'wbv2m-chip-tap',
        style: {
          background: C.chipTpl.bg, border:'1px solid ' + C.chipTpl.border, color: C.chipTpl.fg,
          borderRadius:'100px', padding:'5px 12px', fontSize:'12px', fontWeight:'600',
          cursor:'pointer', whiteSpace:'nowrap', flexShrink:'0',
          display:'flex', alignItems:'center', gap:'5px'
        },
        onclick: function () {
          S.overlay = 'templates'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {}
          if (!S.templates) loadTemplates().then(rerender);
          else rerender();
        }
      }, ICON.file(C.chipTpl.fg), 'Templates'),
      chip(C.chipAttach.bg, C.chipAttach.border, C.chipAttach.fg, '📎 Attach', function () { toast('Attachment picker opens on native platform', 'info'); }),
      chip(C.chipLoc.bg,    C.chipLoc.border,    C.chipLoc.fg,    '📍 Location', function () { toast('Location share opens on native platform', 'info'); }),
      chip(C.chipAudio.bg,  C.chipAudio.border,  C.chipAudio.fg,  '🎵 Audio', function () { toast('Audio recording opens on native platform', 'info'); })
    );

    var inputRow = h('div', { style: {
      display:'flex', alignItems:'center', gap:'8px',
      background: C.listBg, borderRadius:'24px', padding:'8px 10px 8px 12px'
    }},
      h('span', { style: { fontSize:'22px', cursor:'pointer', flexShrink:'0', lineHeight:'1' }}, '😊'),
      input,
      h('button', {
        class: 'wbv2m-send-btn',
        style: {
          background: sendBg, border:'none', borderRadius:'50%',
          width:'36px', height:'36px', display:'flex', alignItems:'center', justifyContent:'center',
          cursor:'pointer', flexShrink:'0', transition:'background 0.15s ease'
        },
        onclick: handleSend
      }, ICON.send())
    );

    return h('div', { style: {
      background:'#fff', padding:'8px 10px 10px', flexShrink:'0',
      /* v1_4 — safe-area padding so it clears iOS home indicator + Android nav bar */
      paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0))',
      borderTop:'1px solid ' + C.listBg,
      /* Make sure it stays above absolute-positioned parents */
      position:'relative', zIndex:'2'
    }}, quickRow, inputRow);
  }

  function handleSend() {
    var text = String(S.inputText || '').trim();
    if (!text) return;
    var t = S.activeThread;
    if (!t) return toast('No thread selected', 'err');
    var payload = {
      phone: t.phone,
      body: text
    };
    var pid = S.sendFromId || t.phone_number_id;
    if (pid) payload.phone_id = pid;
    var wasText = S.inputText;
    S.inputText = '';
    // optimistic message
    var opt = {
      direction: 'out',
      body: wasText,
      timestamp: new Date().toISOString(),
      status: 'sending',
      __optimistic: true
    };
    S.messages.push(opt);
    rerender();
    /* v1.1 (2026-07-12) — primary uses api_wb_chat_send with the shape
     * proven to work in the desktop module. Prior primary api_wb_send
     * doesn't exist on the server and returned "No Api Found". */
    var primary = { phone: t.phone, text: wasText, from_phone_number_id: pid || undefined };
    api('api_wb_chat_send', primary)
      .then(function () { return loadMessages(t.phone); })
      .then(rerender)
      .catch(function (err) {
        /* v1_4 — persistent, VERY visible error dialog with exact server msg. */
        var errMsg = (err && err.message) || 'unknown';
        try { console.error('[WA_MOBILE] send failed', err, 'payload:', primary); } catch (_) {}
        /* Remove the optimistic bubble */
        S.messages = S.messages.filter(function (m) { return !m.__optimistic; });
        /* Put text back into composer so user doesn't retype */
        S.inputText = wasText;
        rerender();
        /* Show a modal alert that requires acknowledgement */
        try {
          var backdrop = document.createElement('div');
          backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
          var box = document.createElement('div');
          box.style.cssText = 'background:#fff;border-radius:16px;padding:20px;max-width:340px;width:100%;box-shadow:0 8px 32px rgba(0,0,0,0.3);';
          box.innerHTML = '<div style="font-size:28px;text-align:center;margin-bottom:8px;">⚠️</div>' +
            '<div style="font-weight:700;color:#B91C1C;font-size:16px;margin-bottom:10px;text-align:center;">Send failed</div>' +
            '<div style="background:#FEF2F2;border:1px solid #FCA5A5;color:#7F1D1D;padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px;word-break:break-word;">' +
            (errMsg || 'unknown') + '</div>' +
            '<div style="color:#6B7280;font-size:12px;margin-bottom:14px;">The message text is back in the composer so you can retry.</div>' +
            '<button style="width:100%;padding:12px;background:#00A884;color:#fff;border:none;border-radius:10px;font-weight:600;font-size:15px;cursor:pointer;">OK</button>';
          backdrop.appendChild(box);
          box.querySelector('button').onclick = function () { try { backdrop.remove(); } catch (_) {} };
          backdrop.onclick = function (e) { if (e.target === backdrop) backdrop.remove(); };
          document.body.appendChild(backdrop);
        } catch (_) { toast('Send failed: ' + errMsg, 'err'); }
      });
  }

  /* =============================================================
   * 13. SEARCH SCREEN
   * ============================================================= */
  function renderSearch() {
    var rows = filteredThreads();
    var hasQ = !!String(S.search || '').trim();

    var header = h('div', { style: {
      background: C.headerDark, padding:'12px 10px',
      display:'flex', alignItems:'center', gap:'10px', flexShrink:'0'
    }},
      h('button', {
        class:'wbv2m-btn-tap',
        style: { background:'none', border:'none', cursor:'pointer', padding:'6px', display:'flex', alignItems:'center', flexShrink:'0' },
        onclick: function () { S.screen = 'list'; S.search = ''; rerender(); }
      }, ICON.back('white')),
      h('div', { style: {
        flex:'1', background:'rgba(255,255,255,0.12)', borderRadius:'100px',
        padding:'9px 14px', display:'flex', alignItems:'center', gap:'8px'
      }},
        ICON.search(C.textDarkMeta),
        h('input', {
          value: S.search || '',
          placeholder: 'Search contacts, companies…',
          style: {
            background:'none', border:'none', outline:'none',
            color:'#fff', fontSize:'15px', flex:'1', minWidth:'0'
          },
          oninput: function (e) {
          /* v1_2 — debounced (300ms) server search + local filter for
           * instant feedback. Local pass runs immediately; server call
           * fires only after typing pauses. */
          S.search = e.target.value;
          try {
            /* Local instant filter for feedback while typing. */
            var listEl = document.querySelector('.wbv2m-search-results');
            if (listEl) {
              listEl.innerHTML = '';
              var rows2 = filteredThreads();
              var hasQ2 = !!String(S.search || '').trim();
              if (!rows2.length) {
                listEl.appendChild(h('div', { style: { padding:'48px 24px', textAlign:'center' }},
                  h('div', { style: { fontSize:'36px', marginBottom:'12px' }}, '🔍'),
                  h('div', { style: { fontSize:'15px', fontWeight:'600', color:'#374151', marginBottom:'6px' }},
                    hasQ2 ? 'No results' : 'Start typing to search')
                ));
              } else {
                rows2.forEach(function (t) { listEl.appendChild(searchRow(t)); });
              }
              /* also update the results count line */
              var meta = document.querySelector('.wbv2m-search-meta');
              if (meta) {
                meta.textContent = hasQ2 ? (rows2.length + ' results for "' + S.search + '"') : 'Recent Conversations';
              }
            }
          } catch (_) {}
        }
        }),
        /* v1_4 — clear-search X button */
        S.search ? h('button', {
          style: {
            background: 'rgba(255,255,255,0.20)', border:'none', color:'#fff',
            width:'26px', height:'26px', borderRadius:'50%', cursor:'pointer',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'14px', flexShrink:'0'
          },
          onclick: function () {
            S.search = '';
            S.dSearch = '';
            S.page = 1;
            loadThreads().then(rerender);
          }
        }, '✕') : null
      )
    );

    var meta = hasQ
      ? h('div', { class:'wbv2m-search-meta', style: { padding:'12px 16px 8px', flexShrink:'0', fontSize:'11px', color:'#6B7280', fontWeight:'500' }},
          rows.length + ' results for "' + S.search + '"')
      : h('div', { class:'wbv2m-search-meta', style: { padding:'12px 16px 8px', flexShrink:'0', fontSize:'11px', color:'#9CA3AF', fontWeight:'600', textTransform:'uppercase', letterSpacing:'0.6px' }},
          'Recent Conversations');

    var list = h('div', { class:'wbv2m-search-results', style: { flex:'1', overflowY:'auto' }});
    if (!rows.length) {
      list.appendChild(h('div', { style: { padding:'48px 24px', textAlign:'center' }},
        h('div', { style: { fontSize:'36px', marginBottom:'12px' }}, '🔍'),
        h('div', { style: { fontSize:'15px', fontWeight:'600', color:'#374151', marginBottom:'6px' }},
          hasQ ? 'No results' : 'Start typing to search'),
        h('div', { style: { fontSize:'13px', color:'#9CA3AF' }},
          hasQ ? 'Try a different keyword.' : 'Contacts, companies, and messages are searchable.')
      ));
    } else {
      rows.forEach(function (t) { list.appendChild(searchRow(t)); });
    }

    return h('div', {
      class: 'wbv2m-fade',
      style: { position:'absolute', inset:'0', display:'flex', flexDirection:'column', background:'#fff' }
    }, header, meta, list);
  }
  function searchRow(t) {
    var bg = t.lead_avatar_color || avatarColor(t.lead_name || t.phone);
    var stColors = statusColors(t.status_name, t.status_color);
    return h('div', {
      class:'wbv2m-row-tap',
      style: { display:'flex', padding:'12px 16px', borderBottom:'1px solid ' + C.divider, cursor:'pointer', alignItems:'center', gap:'12px' },
      onclick: function () { openChat(t); }
    },
      h('div', { style: {
        width:'46px', height:'46px', borderRadius:'50%', background: bg,
        display:'flex', alignItems:'center', justifyContent:'center',
        color:'#fff', fontWeight:'700', fontSize:'15px', flexShrink:'0'
      }}, initials(t.lead_name || t.phone)),
      h('div', { style: { flex:'1', minWidth:'0' }},
        h('div', { style: { fontWeight:'600', fontSize:'15px', color:'#111', marginBottom:'2px' }}, t.lead_name || t.phone),
        h('div', { style: { fontSize:'12px', color:'#6B7280', marginBottom:'3px' }}, t.company || (t.phone || '')),
        h('div', { style: { fontSize:'12px', color:'#9CA3AF', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}, t.last_msg || '')
      ),
      h('span', { style: {
        background: stColors.bg, color: stColors.fg,
        fontSize:'10px', fontWeight:'700', padding:'2px 8px', borderRadius:'100px', flexShrink:'0'
      }}, t.status_name || 'New')
    );
  }
  function focusSearchInput() {
    setTimeout(function () {
      try {
        var el = S.view && S.view.querySelector('input[placeholder^="Search contacts"]');
        if (el && document.activeElement !== el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      } catch (_) {}
    }, 0);
  }

  /* =============================================================
   * 14. TIMELINE SCREEN
   * ============================================================= */
  function renderTimeline() {
    var t = S.activeThread || {};
    var items = (S.timeline || []).map(function (ev) {
      return normalizeTimelineItem(ev);
    });
    var count = items.length;

    var header = h('div', { style: { background: C.headerDark, padding:'10px 8px 10px 4px', flexShrink:'0' }},
      h('div', { style: { display:'flex', alignItems:'center', gap:'6px' }},
        h('button', {
          class:'wbv2m-btn-tap',
          style: { background:'none', border:'none', cursor:'pointer', padding:'8px', display:'flex', alignItems:'center', flexShrink:'0' },
          onclick: function () { S.screen = 'chat'; rerender(); }
        }, ICON.back('white')),
        h('div', { style: { flex:'1' }},
          h('div', { style: { color:'#fff', fontWeight:'700', fontSize:'16px' }}, 'Lead Timeline'),
          h('div', { style: { color: C.textDarkMeta, fontSize:'11px' }},
            (t.lead_name || t.phone || '') + (t.company ? ' · ' + t.company : ''))
        ),
        h('div', { style: {
          background:'rgba(255,255,255,0.1)', borderRadius:'8px', padding:'4px 12px', marginRight:'8px'
        }},
          h('span', { style: { color: C.green, fontSize:'12px', fontWeight:'600' }}, count + ' events'))
      )
    );

    var body = h('div', { style: { flex:'1', overflowY:'auto', padding:'20px 16px 32px' }});
    if (!items.length) {
      body.appendChild(h('div', { style: { padding:'48px 24px', textAlign:'center' }},
        h('div', { style: { fontSize:'36px', marginBottom:'12px' }}, '⏱'),
        h('div', { style: { fontSize:'15px', fontWeight:'600', color:'#374151', marginBottom:'6px' }}, 'No events yet'),
        h('div', { style: { fontSize:'13px', color:'#9CA3AF' }}, 'Timeline entries will appear as the lead moves forward.')
      ));
    } else {
      items.forEach(function (it, idx) {
        var isLast = idx === items.length - 1;
        body.appendChild(timelineRow(it, isLast));
      });
    }

    return h('div', {
      class: 'wbv2m-screen',
      style: { position:'absolute', inset:'0', background:'#F8FAFC', display:'flex', flexDirection:'column' }
    }, header, body);
  }
  function normalizeTimelineItem(ev) {
    var raw = String(ev.type || ev.event_type || ev.kind || '').toLowerCase();
    var icon = '📌', bg = '#EFF6FF';
    if (/call|dial|rec/.test(raw))          { icon = '📞'; bg = '#DBEAFE'; }
    else if (/wa|whats|message|reply/.test(raw)) { icon = '💬'; bg = '#D1FAE5'; }
    else if (/status/.test(raw))             { icon = '🏷';  bg = '#FEF3C7'; }
    else if (/remark|note/.test(raw))        { icon = '📝'; bg = '#FEF3C7'; }
    else if (/follow|remind|schedule/.test(raw)) { icon = '📅'; bg = '#F3E8FF'; }
    else if (/create|new|lead/.test(raw))    { icon = '✨';       bg = '#F3E8FF'; }
    else if (/assign/.test(raw))             { icon = '👤'; bg = '#DBEAFE'; }
    else if (/won|close|convert/.test(raw))  { icon = '✅';       bg = '#D1FAE5'; }
    else if (/lost|junk/.test(raw))          { icon = '❌';       bg = '#FEE2E2'; }
    var tag = null;
    if (ev.tag) tag = { text: ev.tag, bg:'#F3F4F6', color:'#374151' };
    else if (ev.status_name) {
      var sc = statusColors(ev.status_name, ev.status_color);
      tag = { text: ev.status_name, bg: sc.bg, color: sc.fg };
    }
    return {
      icon: icon, bg: bg,
      title: ev.title || ev.subject || raw.replace(/_/g,' ') || 'Event',
      desc:  ev.description || ev.body || ev.details || '',
      time:  fmtFull(ev.created_at || ev.timestamp || ev.at || ev.date),
      tag:   tag
    };
  }
  function timelineRow(it, isLast) {
    return h('div', { style: { display:'flex', gap:'0' }},
      h('div', { style: { display:'flex', flexDirection:'column', alignItems:'center', width:'44px', flexShrink:'0' }},
        h('div', { style: {
          width:'38px', height:'38px', borderRadius:'50%', background: it.bg,
          display:'flex', alignItems:'center', justifyContent:'center', fontSize:'17px', flexShrink:'0'
        }}, it.icon),
        !isLast ? h('div', { style: { width:'2px', flex:'1', background:'#E5E7EB', minHeight:'28px', marginTop:'3px' }}) : null
      ),
      h('div', { style: { flex:'1', padding:'4px 0 22px 12px' }},
        h('div', { style: { fontWeight:'600', fontSize:'14px', color:'#111', marginBottom:'2px' }}, it.title),
        it.desc ? h('div', { style: { fontSize:'12.5px', color:'#6B7280', marginBottom:'5px', lineHeight:'1.4' }}, it.desc) : null,
        h('div', { style: { display:'flex', alignItems:'center', gap:'4px', flexWrap:'wrap' }},
          ICON.clock('#9CA3AF'),
          h('span', { style: { fontSize:'11px', color:'#9CA3AF', fontWeight:'500' }}, it.time),
          it.tag ? h('span', { style: {
            background: it.tag.bg, color: it.tag.color, fontSize:'9.5px', fontWeight:'600',
            padding:'1px 7px', borderRadius:'100px', marginLeft:'4px'
          }}, it.tag.text) : null
        )
      )
    );
  }

  /* =============================================================
   * 15. OVERLAY: BACKDROP HELPER
   * ============================================================= */
  function overlayBackdrop(children) {
    return h('div', {
      style: { position:'absolute', inset:'0', zIndex:'50' }
    },
      h('div', {
        style: { position:'absolute', inset:'0', background:'rgba(0,0,0,0.45)' },
        onclick: function () { closeOverlay(); }
      }),
      children
    );
  }
  function closeOverlay() { S.overlay = null; rerender(); }

  /* =============================================================
   * 16. OVERLAY: TEMPLATES
   * ============================================================= */
  function overlayTemplates() {
    var tpls = filteredTemplates();
    var sheet = h('div', {
      class: 'wbv2m-sheet',
      style: {
        position:'absolute', bottom:'0', left:'0', right:'0',
        background:'#fff', borderRadius:'20px 20px 0 0',
        maxHeight:'75%', display:'flex', flexDirection:'column'
      }
    },
      h('div', { style: { width:'36px', height:'4px', background:'#E5E7EB', borderRadius:'100px', margin:'10px auto 0', flexShrink:'0' }}),
      h('div', { style: { padding:'12px 16px 10px', borderBottom:'1px solid ' + C.divider, flexShrink:'0' }},
        h('div', { style: { display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'10px' }},
          h('h3', { style: { margin:'0', fontSize:'17px', fontWeight:'700', color:'#111' }}, 'Send Template'),
          h('button', {
            class:'wbv2m-btn-tap',
            style: {
              background:'#F3F4F6', border:'none', cursor:'pointer',
              width:'28px', height:'28px', borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:'14px', color:'#6B7280'
            },
            onclick: closeOverlay
          }, '✕')
        ),
        h('div', { style: {
          background:'#F5F5F5', borderRadius:'10px', padding:'9px 14px',
          display:'flex', alignItems:'center', gap:'8px'
        }},
          ICON.smallSearchGrey(),
          h('input', {
            value: S.tplSearch || '',
            placeholder: 'Search templates…',
            style: { background:'none', border:'none', outline:'none', fontSize:'14px', color:'#111', flex:'1' },
            oninput: function (e) { S.tplSearch = e.target.value; rerender(); focusTemplateSearch(); }
          })
        )
      ),
      h('div', { style: { overflowY:'auto', flex:'1' }},
        (tpls.length ? tpls : []).map(templateCard),
        !tpls.length ? h('div', { style: { padding:'40px 24px', textAlign:'center' }},
          h('div', { style: { fontSize:'32px', marginBottom:'10px' }}, '📄'),
          h('div', { style: { fontSize:'14px', color:'#6B7280' }},
            S.templates === null ? 'Loading templates…' :
            S.tplSearch ? 'No templates match your search.' : 'No templates approved yet.')
        ) : null
      )
    );
    return overlayBackdrop(sheet);
  }
  function templateCard(tpl) {
    var cat = categoryColors(tpl.category);
    var vars = Array.isArray(tpl.variables) ? tpl.variables.length : 0;
    return h('div', {
      class:'wbv2m-row-tap',
      style: { padding:'14px 16px', borderBottom:'1px solid ' + C.dividerLight, cursor:'pointer' },
      onclick: function () { sendTemplate(tpl); }
    },
      h('div', { style: { display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'5px', gap:'8px' }},
        h('span', { style: { fontWeight:'600', fontSize:'14px', color:'#111', flex:'1' }}, tpl.name),
        h('span', { style: {
          background: cat.bg, color: cat.fg, fontSize:'9.5px', fontWeight:'700',
          padding:'2px 8px', borderRadius:'100px', whiteSpace:'nowrap', flexShrink:'0'
        }}, (tpl.category || 'OTHER').toString().toUpperCase())
      ),
      h('p', { style: {
        margin:'0 0 5px', fontSize:'12.5px', color:'#6B7280',
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', lineHeight:'1.4'
      }}, tpl.body || '(no preview)'),
      h('div', { style: { display:'flex', alignItems:'center', gap:'4px' }},
        ICON.fileGrey(),
        h('span', { style: { fontSize:'11px', color:'#9CA3AF' }}, vars + ' variable(s) · tap to send')
      )
    );
  }
  function focusTemplateSearch() {
    setTimeout(function () {
      try {
        var el = S.view && S.view.querySelector('input[placeholder^="Search templates"]');
        if (el && document.activeElement !== el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      } catch (_) {}
    }, 0);
  }
  function sendTemplate(tpl) {
    var t = S.activeThread;
    if (!t) return toast('No thread selected', 'err');
    var payload = {
      phone: t.phone,
      template_id: tpl.id,
      variables: {}
    };
    var pid = S.sendFromId || t.phone_number_id;
    if (pid) payload.phone_id = pid;
    /* v1.1 — chat_send is the real endpoint; pass templateName +
     * templateLanguage per the desktop module. */
    api('api_wb_chat_send', {
      phone: t.phone,
      templateName: tpl.name || tpl.template_name,
      templateLanguage: tpl.language || 'en_US',
      from_phone_number_id: pid || undefined
    })
      .then(function () {
        toast('Template sent', 'ok');
        closeOverlay();
        return loadMessages(t.phone);
      })
      .then(rerender)
      .catch(function (err) {
        toast('Send failed: ' + (err.message || 'unknown'), 'err');
      });
  }

  /* =============================================================
   * 17. OVERLAY: OPTIONS
   * ============================================================= */
  function overlayOptions() {
    var t = S.activeThread || {};
    var bg = t.lead_avatar_color || avatarColor(t.lead_name || t.phone);
    var stColors = statusColors(t.status_name, t.status_color);
    var row = function (icoBg, icoNode, title, sub, danger, onclick) {
      return h('button', {
        class:'wbv2m-row-tap',
        style: {
          width:'100%', background:'none', border:'none', padding:'14px 16px',
          display:'flex', alignItems:'center', gap:'14px', cursor:'pointer',
          textAlign:'left', borderBottom:'1px solid ' + C.dividerLight
        },
        onclick: onclick || function () {}
      },
        h('div', { style: {
          width:'38px', height:'38px', borderRadius:'10px', background: icoBg,
          display:'flex', alignItems:'center', justifyContent:'center', flexShrink:'0'
        }}, icoNode),
        h('div', { style: { flex:'1' }},
          h('div', { style: { fontSize:'15px', fontWeight:'600', color: danger ? '#DC2626' : '#111', marginBottom:'1px' }}, title),
          h('div', { style: { fontSize:'12px', color:'#9CA3AF' }}, sub)
        ),
        ICON.chevron('#D1D5DB')
      );
    };
    var agent = (S.lead && S.lead.assigned_name) || t.assigned_name || 'Unassigned';
    var sheet = h('div', {
      class: 'wbv2m-sheet',
      style: {
        position:'absolute', bottom:'0', left:'0', right:'0',
        background:'#fff', borderRadius:'20px 20px 0 0'
      }
    },
      h('div', { style: { width:'36px', height:'4px', background:'#E5E7EB', borderRadius:'100px', margin:'10px auto 0' }}),
      // Lead summary
      h('div', { style: {
        padding:'14px 16px', borderBottom:'1px solid ' + C.divider,
        display:'flex', alignItems:'center', gap:'12px'
      }},
        h('div', { style: {
          width:'44px', height:'44px', borderRadius:'50%', background: bg,
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'#fff', fontWeight:'700', fontSize:'16px', flexShrink:'0'
        }}, initials(t.lead_name || t.phone)),
        h('div', { style: { flex:'1', minWidth:'0' }},
          h('div', { style: { fontWeight:'700', fontSize:'15px', color:'#111', marginBottom:'2px' }}, t.lead_name || t.phone),
          h('div', { style: { fontSize:'12px', color:'#6B7280' }}, t.phone || '')
        ),
        h('span', { style: {
          background: stColors.bg, color: stColors.fg, fontSize:'11px',
          fontWeight:'700', padding:'4px 10px', borderRadius:'100px'
        }}, t.status_name || 'New')
      ),
      // Actions
      h('div', { style: { paddingBottom:'16px' }},
        row(C.optResolved.bg, ICON.check(C.optResolved.fg),
          'Mark as Resolved', 'Close this conversation', false,
          function () { markResolved(); }),
        row(C.optAssign.bg, ICON.user(C.optAssign.fg),
          'Assign to Agent', 'Currently: ' + agent, false,
          function () { S.overlay = 'assign'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {} rerender(); }),
        row(C.optNote.bg, ICON.pencil(C.optNote.fg),
          'Add Internal Note', 'Visible only to your team', false,
          function () {
            S.overlay = 'remarks'; try { history.pushState({ wa_screen: 'overlay', ts: Date.now() }, ''); } catch (_) {}
            if (S.activeLeadId) loadRemarks(S.activeLeadId).then(rerender);
            else rerender();
          }),
        row(C.optFollow.bg, ICON.calendar(C.optFollow.fg),
          'Schedule Follow-up', 'Set a reminder for this lead', false,
          function () { closeOverlay(); toast('Follow-up scheduler opens on lead detail', 'info'); }),
        row(C.optBlock.bg, ICON.block(C.optBlock.fg),
          'Block Contact', 'Stop receiving messages', true,
          function () { closeOverlay(); toast('Block flow: use lead detail on desktop', 'info'); })
      )
    );
    return overlayBackdrop(sheet);
  }
  function markResolved() {
    var lid = S.activeLeadId;
    if (!lid) { closeOverlay(); return toast('No lead attached to this thread', 'err'); }
    // find a "Resolved"/"Closed"/"Won" status
    var closer = null;
    for (var i = 0; i < S.statuses.length; i++) {
      var s = S.statuses[i];
      var n = String(s.name || '').toLowerCase();
      if (/resolv|closed|won|complete/.test(n)) { closer = s; break; }
    }
    if (!closer) { closeOverlay(); return toast('No Resolved status configured in this account', 'err'); }
    /* v1.1 — api_leads_update takes positional args: (lead_id, patch). */
    api('api_leads_update', lid, { status_id: closer.id })
      .then(function () {
        toast('Conversation marked resolved', 'ok');
        if (S.activeThread) {
          S.activeThread.status_name = closer.name;
          S.activeThread.status_color = closer.color;
        }
        closeOverlay();
        return loadThreads();
      }).then(rerender)
      .catch(function (err) { toast('Failed: ' + err.message, 'err'); });
  }

  /* =============================================================
   * 18. OVERLAY: STATUS PICKER
   * ============================================================= */
  function overlayStatusPicker() {
    var t = S.activeThread || {};
    var opts = (S.statuses || []).map(function (s) {
      var col = statusColors(s.name, s.color);
      var active = t.status_name && String(t.status_name).toLowerCase() === String(s.name).toLowerCase();
      return { id: s.id, label: s.name, color: s.color, bg: col.bg, fg: col.fg, dot: s.color || col.fg, active: active };
    });
    var sheet = h('div', {
      class: 'wbv2m-sheet',
      style: {
        position:'absolute', bottom:'0', left:'0', right:'0',
        background:'#fff', borderRadius:'20px 20px 0 0', paddingBottom:'16px'
      }
    },
      h('div', { style: { width:'36px', height:'4px', background:'#E5E7EB', borderRadius:'100px', margin:'10px auto 0' }}),
      h('div', { style: { padding:'14px 16px 10px', borderBottom:'1px solid ' + C.divider, display:'flex', justifyContent:'space-between', alignItems:'center' }},
        h('div', null,
          h('h3', { style: { margin:'0 0 2px', fontSize:'16px', fontWeight:'700', color:'#111' }}, 'Change Lead Status'),
          h('p', { style: { margin:'0', fontSize:'12px', color:'#6B7280' }}, 'Current: ' + (t.status_name || 'New'))
        ),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background:'#F3F4F6', border:'none', cursor:'pointer', width:'28px', height:'28px',
            borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'14px', color:'#6B7280'
          },
          onclick: closeOverlay
        }, '✕')
      ),
      h('div', null, opts.map(statusOptionRow))
    );
    return overlayBackdrop(sheet);
  }
  function statusOptionRow(opt) {
    return h('button', {
      class:'wbv2m-row-tap',
      style: {
        width:'100%', background:'none', border:'none', padding:'13px 16px',
        display:'flex', alignItems:'center', gap:'12px', cursor:'pointer',
        textAlign:'left', borderBottom:'1px solid ' + C.dividerLight
      },
      onclick: function () { changeStatus(opt); }
    },
      h('div', { style: {
        width:'12px', height:'12px', borderRadius:'50%',
        background: opt.dot || opt.fg, flexShrink:'0'
      }}),
      h('span', { style: { fontSize:'15px', fontWeight:'500', color:'#111', flex:'1' }}, opt.label),
      h('span', { style: {
        background: opt.bg, color: opt.fg, fontSize:'10px', fontWeight:'700',
        padding:'2px 9px', borderRadius:'100px'
      }}, opt.label),
      opt.active ? ICON.checkThick(C.greenDark) : null
    );
  }
  function changeStatus(opt) {
    var lid = S.activeLeadId;
    if (!lid) return toast('No lead attached', 'err');
api('api_leads_update', lid, { status_id: opt.id })
      .then(function () {
        toast('Status updated', 'ok');
        if (S.activeThread) {
          S.activeThread.status_name = opt.label;
          S.activeThread.status_color = opt.color;
        }
        closeOverlay();
        return loadThreads();
      }).then(rerender)
      .catch(function (err) { toast('Failed: ' + err.message, 'err'); });
  }

  /* =============================================================
   * 19. OVERLAY: NUMBER PICKER
   * ============================================================= */
  function overlayNumberPicker() {
    var t = S.activeThread || {};
    var currentId = S.sendFromId || t.phone_number_id;
    var sheet = h('div', {
      class: 'wbv2m-sheet',
      style: {
        position:'absolute', bottom:'0', left:'0', right:'0',
        background:'#fff', borderRadius:'20px 20px 0 0', paddingBottom:'24px'
      }
    },
      h('div', { style: { width:'36px', height:'4px', background:'#E5E7EB', borderRadius:'100px', margin:'10px auto 0' }}),
      h('div', { style: { padding:'14px 16px 10px', borderBottom:'1px solid ' + C.divider, display:'flex', justifyContent:'space-between', alignItems:'center' }},
        h('div', null,
          h('h3', { style: { margin:'0 0 2px', fontSize:'16px', fontWeight:'700', color:'#111' }}, 'Replying From'),
          h('p', { style: { margin:'0', fontSize:'12px', color:'#6B7280' }}, 'Select WhatsApp number to use')
        ),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background:'#F3F4F6', border:'none', cursor:'pointer', width:'28px', height:'28px',
            borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'14px', color:'#6B7280'
          },
          onclick: closeOverlay
        }, '✕')
      ),
      h('div', { style: { padding:'6px 0' }},
        (S.phones || []).map(function (p) { return numberOptionRow(p, currentId); }),
        !(S.phones || []).length ? h('div', { style: { padding:'32px 24px', textAlign:'center', color:'#6B7280', fontSize:'13px' }},
          'No WhatsApp senders configured.') : null
      )
    );
    return overlayBackdrop(sheet);
  }
  function numberOptionRow(p, currentId) {
    var num = p.phone || p.display_phone_number || 'WhatsApp';
    var label = p.label || (p.active ? 'Active number' : 'Business number');
    var active = String(p.id) === String(currentId) || String(p.phone_number_id || '') === String(currentId);
    return h('button', {
      class:'wbv2m-row-tap',
      style: {
        width:'100%', background:'none', border:'none', padding:'14px 16px',
        display:'flex', alignItems:'center', gap:'14px', cursor:'pointer',
        textAlign:'left', borderBottom:'1px solid ' + C.dividerLight
      },
      onclick: function () {
        S.sendFromId = p.id || p.phone_number_id;
        toast('Now sending from ' + num, 'ok');
        closeOverlay();
      }
    },
      h('div', { style: {
        width:'42px', height:'42px', borderRadius:'50%', background: C.successBg,
        display:'flex', alignItems:'center', justifyContent:'center', flexShrink:'0'
      }},
        svg('<path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51H7c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.87 1.21 3.07c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2.01-1.41.25-.7.25-1.29.17-1.41z"></path>',
          { width: 20, height: 20, viewBox:'0 0 24 24', fill: C.successDark })
      ),
      h('div', { style: { flex:'1', minWidth:'0' }},
        h('div', { style: { fontWeight:'600', fontSize:'15px', color:'#111', marginBottom:'2px' }}, num),
        h('div', { style: { fontSize:'12px', color:'#6B7280' }}, label)
      ),
      (active || p.active) ? h('div', { style: {
        background: C.successBg, borderRadius:'100px', padding:'4px 12px',
        fontSize:'11px', fontWeight:'700', color: C.successFg
      }}, 'Active') : null
    );
  }

  /* =============================================================
   * 20. OVERLAY: REMARKS
   * ============================================================= */
  function overlayRemarks() {
    var remarks = S.remarks || [];
    var list = h('div', { style: { flex:'1', overflowY:'auto', padding:'10px 16px 6px' }});
    if (!remarks.length) {
      list.appendChild(h('div', { style: { padding:'40px 24px', textAlign:'center' }},
        h('div', { style: { fontSize:'32px', marginBottom:'10px' }}, '📝'),
        h('div', { style: { fontSize:'14px', color:'#6B7280' }}, 'No remarks yet. Add the first one below.')
      ));
    } else {
      remarks.forEach(function (r) { list.appendChild(remarkCard(r)); });
    }

    var sheet = h('div', {
      class: 'wbv2m-sheet',
      style: {
        position:'absolute', bottom:'0', left:'0', right:'0',
        background:'#fff', borderRadius:'20px 20px 0 0',
        maxHeight:'80%', display:'flex', flexDirection:'column'
      }
    },
      h('div', { style: { width:'36px', height:'4px', background:'#E5E7EB', borderRadius:'100px', margin:'10px auto 0', flexShrink:'0' }}),
      h('div', { style: { padding:'14px 16px 10px', borderBottom:'1px solid ' + C.divider, display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:'0' }},
        h('div', null,
          h('h3', { style: { margin:'0 0 2px', fontSize:'16px', fontWeight:'700', color:'#111' }}, 'Internal Remarks'),
          h('p', { style: { margin:'0', fontSize:'12px', color:'#6B7280' }}, 'Only visible to your team · ' + remarks.length + ' saved')
        ),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background:'#F3F4F6', border:'none', cursor:'pointer', width:'28px', height:'28px',
            borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'14px', color:'#6B7280'
          },
          onclick: closeOverlay
        }, '✕')
      ),
      list,
      h('div', { style: { padding:'12px 16px 24px', borderTop:'1px solid ' + C.divider, flexShrink:'0', background:'#fff' }},
        h('textarea', {
          value: S.newRemark || '',
          placeholder: 'Add an internal remark about this lead…',
          rows: '3',
          style: {
            width:'100%', border:'1.5px solid #E5E7EB', borderRadius:'10px',
            padding:'10px 12px', fontSize:'14px', color:'#111', resize:'none',
            outline:'none', boxSizing:'border-box', lineHeight:'1.5'
          },
          oninput: function (e) { S.newRemark = e.target.value; }
        }),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            width:'100%', marginTop:'8px', background: C.headerDark, color:'#fff',
            border:'none', borderRadius:'10px', padding:'12px',
            fontSize:'14px', fontWeight:'600', cursor:'pointer'
          },
          onclick: saveRemark
        }, 'Save Remark')
      )
    );
    return overlayBackdrop(sheet);
  }
  function remarkCard(r) {
    var text = r.body || r.remark || r.text || '';
    var author = r.author_name || r.user_name || r.created_by_name || 'Team';
    var initial = String(author || 'T').charAt(0).toUpperCase();
    var time = fmtRelativeShort(r.created_at || r.at || r.timestamp);
    return h('div', { style: {
      background:'#FAFAFA', borderRadius:'10px', padding:'12px',
      marginBottom:'8px', borderLeft:'3px solid ' + C.remarkAccent
    }},
      h('p', { style: { margin:'0 0 8px', fontSize:'13.5px', color:'#111', lineHeight:'1.55' }}, text),
      h('div', { style: { display:'flex', alignItems:'center', gap:'6px' }},
        h('div', { style: {
          width:'20px', height:'20px', borderRadius:'50%', background: C.remarkAuthor,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:'9px', color:'#fff', fontWeight:'700', flexShrink:'0'
        }}, initial),
        h('span', { style: { fontSize:'11px', fontWeight:'600', color:'#374151' }}, author),
        h('span', { style: { fontSize:'11px', color:'#9CA3AF' }}, '· ' + time)
      )
    );
  }
  function saveRemark() {
    var body = String(S.newRemark || '').trim();
    if (!body) return toast('Type something first', 'err');
    var lid = S.activeLeadId;
    if (!lid) return toast('No lead linked to this chat', 'err');
    /* v1.1 — desktop's proven signature: positional (lead_id, {remark}). */
    api('api_leads_addRemark', lid, { remark: body })
      .then(function () {
        S.newRemark = '';
        toast('Remark saved', 'ok');
        return loadRemarks(lid);
      })
      .then(rerender)
      .catch(function (err) { toast('Failed: ' + (err.message || 'unknown'), 'err'); });
  }

  /* =============================================================
   * 20b. OVERLAY: ASSIGN AGENT (v1.1)
   * Real dropdown of team users. Admin/manager can reassign; picks
   * a user or Unassigned. Uses api_leads_update(lid, {assigned_to}).
   * ============================================================= */
  function overlayAssignPicker() {
    var t = S.activeThread || {};
    var lid = S.activeLeadId;
    var currentId = null;
    if (S.lead && S.lead.assigned_to != null) currentId = Number(S.lead.assigned_to);
    var users = (S.users || []).slice().sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
    var rows = [];
    // Unassigned row
    rows.push(agentRow({ id: null, name: 'Unassigned', is_null: true }, currentId));
    users.forEach(function (u) { rows.push(agentRow(u, currentId)); });

    var sheet = h('div', {
      class: 'wbv2m-sheet',
      style: {
        position:'absolute', bottom:'0', left:'0', right:'0', maxHeight:'70vh',
        background:'#fff', borderRadius:'20px 20px 0 0', paddingBottom:'16px',
        display:'flex', flexDirection:'column'
      }
    },
      h('div', { style: { width:'36px', height:'4px', background:'#E5E7EB', borderRadius:'100px', margin:'10px auto 0' }}),
      h('div', { style: { padding:'14px 16px 10px', borderBottom:'1px solid ' + C.divider,
                          display:'flex', justifyContent:'space-between', alignItems:'center', flexShrink:'0' }},
        h('div', null,
          h('h3', { style: { margin:'0 0 2px', fontSize:'16px', fontWeight:'700', color:'#111' }}, 'Assign to Agent'),
          h('p', { style: { margin:'0', fontSize:'12px', color:'#6B7280' }},
            'Current: ' + (t.assigned_name || 'Unassigned'))
        ),
        h('button', {
          class:'wbv2m-btn-tap',
          style: { background:'#F3F4F6', border:'none', cursor:'pointer', width:'28px', height:'28px',
                   borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center',
                   fontSize:'14px', color:'#6B7280' },
          onclick: closeOverlay
        }, '✕')
      ),
      h('div', { style: { flex:'1', overflowY:'auto' }}, rows)
    );
    return overlayBackdrop(sheet);
  }
  function agentRow(u, currentId) {
    var active = (u.id === currentId) || (u.is_null && (currentId == null || currentId === ''));
    var initial = String(u.name || '?').trim().charAt(0).toUpperCase() || '?';
    return h('button', {
      class:'wbv2m-row-tap',
      style: {
        width:'100%', background:'none', border:'none', padding:'11px 16px',
        display:'flex', alignItems:'center', gap:'12px', cursor:'pointer',
        textAlign:'left', borderBottom:'1px solid ' + C.dividerLight
      },
      onclick: function () { assignTo(u.id || null, u.name); }
    },
      h('div', { style: {
        width:'34px', height:'34px', borderRadius:'50%',
        background: u.is_null ? '#E5E7EB' : '#DBEAFE',
        color: u.is_null ? '#6B7280' : '#1E40AF',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:'14px', fontWeight:'700', flexShrink:'0'
      }}, u.is_null ? '–' : initial),
      h('span', { style: { fontSize:'14.5px', fontWeight:'500', color:'#111', flex:'1' }}, u.name || '–'),
      active ? ICON.checkThick(C.greenDark) : null
    );
  }
  function assignTo(uid, uname) {
    var lid = S.activeLeadId;
    if (!lid) return toast('No lead attached', 'err');
    api('api_leads_update', lid, { assigned_to: uid })
      .then(function () {
        toast('Reassigned to ' + (uname || 'Unassigned'), 'ok');
        if (S.activeThread) S.activeThread.assigned_name = uid ? uname : null;
        if (S.lead) S.lead.assigned_to = uid;
        closeOverlay();
        return loadThreads();
      })
      .then(rerender)
      .catch(function (err) { toast('Failed: ' + (err.message || 'unknown'), 'err'); });
  }

  /* =============================================================
   * 21. NAVIGATION HELPERS
   * ============================================================= */
  function openChat(t) {
    S.activeThread = t;
    S.activePhone = t.phone;
    S.activeLeadId = t.lead_id || null;
    S.screen = 'chat';
    S.overlay = null;
    S.messages = [];
    S.remarks = [];
    S.lead = null;
    /* v1_7 — push a marker so Android back returns to list, not out */
    try { history.pushState({ wa_screen: 'chat', ts: Date.now() }, ''); } catch (_) {}
    rerender();
    // fetch data in parallel
    Promise.all([
      loadMessages(t.phone),
      t.lead_id ? loadLead(t.lead_id) : Promise.resolve(),
      t.lead_id ? loadRemarks(t.lead_id) : Promise.resolve()
    ]).then(rerender).catch(function () {});
  }
  function openLead(id) {
    if (!id) return toast('No linked lead', 'err');
    // deep-link into the app's leads view when possible
    try {
      if (typeof window.openLeadModal === 'function') {
        window.openLeadModal(id);
        return;
      }
      if (typeof window.showLead === 'function') {
        window.showLead(id);
        return;
      }
    } catch (_) {}
    var base = '/t/' + SLUG + '/#leads?id=' + id;
    window.location.hash = 'leads?id=' + id;
    setTimeout(function () { window.location.href = base; }, 40);
  }

  /* =============================================================
   * 21b. FULLSCREEN TOGGLE (v1.1)
   * Adds a floating button that toggles S.fullscreen. When ON, we
   * add body class 'wa-mobile-fullscreen' which the stylesheet uses
   * to hide the SPA sidebar / topbar / any FABs, giving a pure
   * WhatsApp mobile experience. Click again to exit.
   * ============================================================= */
  function fullscreenToggleBtn() {
    var active = !!S.fullscreen;
    return h('button', {
      class: 'wbv2m-fs-toggle',
      title: active ? 'Exit full view' : 'Full view (hide app header)',
      style: {
        position:'fixed',
        top: '10px',
        right: '10px',
        zIndex: '9999',
        background: active ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.28)',
        color:'#fff',
        border:'none',
        borderRadius:'20px',
        width:'auto', height:'34px', padding:'0 10px',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:'16px', cursor:'pointer',
        boxShadow:'0 2px 6px rgba(0,0,0,0.25)',
        transition:'background 0.2s'
      },
      onclick: function () {
        S.fullscreen = !S.fullscreen;
        try {
          if (S.fullscreen) document.body.classList.add('wa-mobile-fullscreen');
          else document.body.classList.remove('wa-mobile-fullscreen');
        } catch (_) {}
        rerender();
      }
    },
    /* v1_4 — bigger, clearer icon + label */
    h('span', { style: { fontSize:'15px', lineHeight:'1' } }, active ? '⤢ Exit' : '⛶ Full'));
  }

  /* v1.1 — install fullscreen CSS once (idempotent). Hides SPA
   * chrome so mobile WA UI takes the entire viewport. */
  function installFsCss() {
    if (document.getElementById('wa-mobile-fs-css')) return;
    var s = document.createElement('style');
    s.id = 'wa-mobile-fs-css';
    /* v1_8 — SAFE fullscreen: no nuclear display:none. Just hide the
     * app's known chrome selectors and float the .wbv2m container above.
     * When body has class wa-mobile-fullscreen: 
     *  - Hide sidebar/topbar/footer/FABs
     *  - Fullscreen the wbv2m container via position:fixed
     */
    /* v1_9 — always hide classic WA sub-tabs on mobile viewports.
     * Applied when the module is loaded (viewport <=768 is our mobile). */
    if (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
      var mCss = document.createElement('style');
      mCss.id = 'wa-mobile-hide-classic';
      mCss.textContent =
        /* Hide any subtab strip inside the WA view — the classic tabs like
         * Connect Account / Templates / Bots / Message Bot. */
        '.subtabs, .subtab-strip, .sub-tabs, .wb-subtabs { display:none !important; }' +
        /* Hide any classic WA content leftover so it doesn't peek behind. */
        '#whatsbot-tabs, .whatsbot-tabs, .wb-tabs { display:none !important; }' +
        /* Ensure the view fills the page on mobile — no extra whitespace above. */
        '#view.wa-mobile-active { padding:0 !important; margin:0 !important; }' +
        /* Hide the SPA outer topbar on the WhatsApp page in mobile viewport */
        'body.wa-mobile-on-wa .topbar, body.wa-mobile-on-wa #topbar,' +
        'body.wa-mobile-on-wa .app-topbar { display:none !important; }';
      document.head.appendChild(mCss);
    }
    s.textContent =
      'body.wa-mobile-fullscreen #sidebar,' +
      'body.wa-mobile-fullscreen .topbar,' +
      'body.wa-mobile-fullscreen #topbar,' +
      'body.wa-mobile-fullscreen .app-topbar,' +
      'body.wa-mobile-fullscreen .app-sidebar,' +
      'body.wa-mobile-fullscreen .app-footer,' +
      'body.wa-mobile-fullscreen .fab,' +
      'body.wa-mobile-fullscreen .lead-add-fab,' +
      'body.wa-mobile-fullscreen #lead-add-fab-mobile,' +
      'body.wa-mobile-fullscreen .topbar-chip { display: none !important; }' +
      'body.wa-mobile-fullscreen { padding:0 !important; margin:0 !important; overflow:hidden !important; }' +
      /* Make the wbv2m container itself fill the viewport */
      'body.wa-mobile-fullscreen .wbv2m {' +
        ' position:fixed !important; top:0 !important; left:0 !important;' +
        ' right:0 !important; bottom:0 !important; width:100vw !important;' +
        ' height:100vh !important; z-index:99000 !important;' +
        ' background:#fff !important; margin:0 !important;' +
      '}' +
      /* Make sure parent chain doesn't clip the fixed child */
      'body.wa-mobile-fullscreen #view,' +
      'body.wa-mobile-fullscreen .shell,' +
      'body.wa-mobile-fullscreen main { overflow:visible !important; }' +
      /* iOS momentum scrolling for messages area */
      '.wbv2m * { -webkit-overflow-scrolling: touch; }';
    document.head.appendChild(s);
  }

  /* =============================================================
   * 22. MAIN RENDER
   * ============================================================= */
  function rerender() {
    if (!S.view) return;
    S.lastRender = Date.now();
    injectStyles();
    installFsCss();  /* v1.1 */
    /* v1.1 — outer wrap MUST have a real height so children with
     * flex:1 + overflow:auto actually scroll. Prior height:100%
     * collapsed because SPA view has no defined height. Adding CSS
     * class wbv2m-fs applies when Fullscreen mode is on. */
    var wrap = h('div', {
      class: 'wbv2m' + (S.fullscreen ? ' wbv2m-fs' : ''),
      style: {
        position: S.fullscreen ? 'fixed' : 'relative',
        top: S.fullscreen ? '0' : undefined,
        left: S.fullscreen ? '0' : undefined,
        right: S.fullscreen ? '0' : undefined,
        bottom: S.fullscreen ? '0' : undefined,
        width:'100%',
        height: '100vh',
        maxHeight: '100vh',
        background:'#fff',
        overflow:'hidden',
        zIndex: S.fullscreen ? '9998' : 'auto'
      }
    });
    // Screens
    var screenNode = null;
    if (S.screen === 'chat')          screenNode = renderChat();
    else if (S.screen === 'search')   screenNode = renderSearch();
    else if (S.screen === 'timeline') screenNode = renderTimeline();
    else                              screenNode = renderList();
    wrap.appendChild(screenNode);

    /* v1_5 — removed floating pagination; now inline at end of list */
    /* v1.1 — floating fullscreen toggle in top-right corner. Hides
     * the SPA sidebar + topbar + FAB by adding class wa-mobile-fullscreen
     * on <body>. Small ⤢ / ⤡ button so it stays visible on every screen. */
/* v2_1 — removed */
    // Overlays
    if (S.overlay === 'templates') wrap.appendChild(overlayTemplates());
    else if (S.overlay === 'options')  wrap.appendChild(overlayOptions());
    else if (S.overlay === 'status')   wrap.appendChild(overlayStatusPicker());
    else if (S.overlay === 'number')   wrap.appendChild(overlayNumberPicker());
    else if (S.overlay === 'assign')   wrap.appendChild(overlayAssignPicker());
    else if (S.overlay === 'remarks')  wrap.appendChild(overlayRemarks());

    S.view.replaceChildren(wrap);
    /* v2_0 — force-exit button removed with FULL VIEW feature */
    try { var oldBtn = document.getElementById('wbv2m-force-exit-fs'); if (oldBtn) oldBtn.remove(); } catch (_) {}
  }

  /* =============================================================
   * 23. POLLER (20 s silent refresh)
   * ============================================================= */
  function installPoller() {
    if (S.poller) return;
    /* WA_MOBILE_V1_4 — silent poll: only rerender when count changes,
     * never rerender if user is typing in the composer (prevents the
     * "screen jumps every 5-10 sec" bug). Rerenders are also gated to
     * not fire when an overlay is open (would close the sheet). */
    S.poller = setInterval(function () {
      if (document.hidden) return;
      /* Guard: don't disturb user while composing */
      try {
        var active = document.activeElement;
        if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      } catch (_) {}
      if (S.overlay) return;                    /* don't close overlays */
      if (S.loadingMore) return;                /* don't fight Load More */
      var prevListLen = (S.threads || []).length;
      var prevMsgLen = (S.messages || []).length;
      loadThreads().then(function () {
        var newListLen = (S.threads || []).length;
        if (S.screen === 'chat' && S.activePhone) {
          return loadMessages(S.activePhone).then(function () {
            var newMsgLen = (S.messages || []).length;
            /* Rerender ONLY when something actually changed. */
            if (newMsgLen !== prevMsgLen || newListLen !== prevListLen) rerender();
          });
        }
        if (S.screen === 'list' && newListLen !== prevListLen) rerender();
      }).catch(function () {});
    }, 20000);
    // clear on nav away
    try {
      window.addEventListener('hashchange', function () {
        /* v1_9 — remove body class when navigating away from WA */
        try {
          if (!/whatsbot/.test(String(location.hash || ''))) {
            document.body.classList.remove('wa-mobile-on-wa');
            document.body.classList.remove('wa-mobile-fullscreen');
          }
        } catch (_) {}
        if (!S.view || !document.body.contains(S.view)) {
          if (S.poller) { clearInterval(S.poller); S.poller = null; }
        }
      });
    } catch (_) {}
  }

  /* =============================================================
   * 24. PUBLIC ENTRY
   * ============================================================= */
  function render(view) {
    S.view = view;
    injectStyles();
    /* v1_9 — mark body so CSS can hide the classic WA topbar in mobile. */
    try { document.body.classList.add('wa-mobile-on-wa'); } catch (_) {}
    /* v1_7 — install a single popstate handler for back-button trapping.
     * Idempotent: won't stack multiple handlers if render fires twice. */
    if (!window.__wbv2m_backTrap) {
      window.__wbv2m_backTrap = function (ev) {
        try {
          /* If we're not inside the WA mobile module anymore, don't intercept. */
          if (!S.view || !document.body.contains(S.view)) return;
          /* Close overlay first if one is open */
          if (S.overlay) {
            S.overlay = null;
            history.pushState({ wa_screen: 'list', ts: Date.now() }, '');
            rerender();
            return;
          }
          /* If on chat / search / timeline, go back to list */
          if (S.screen === 'chat' || S.screen === 'search' || S.screen === 'timeline') {
            S.screen = 'list';
            S.activeThread = null;
            S.activePhone = null;
            S.activeLeadId = null;
            S.messages = [];
            S.lead = null;
            history.pushState({ wa_screen: 'list', ts: Date.now() }, '');
            rerender();
            return;
          }
          /* On list: don't intercept. Let SPA back-nav happen. */
        } catch (_) {}
      };
      try { window.addEventListener('popstate', window.__wbv2m_backTrap); } catch (_) {}
    }
    /* Push an initial list-state marker so the FIRST back press consumes it */
    try {
      if (!history.state || !history.state.wa_screen) {
        history.pushState({ wa_screen: 'list', ts: Date.now() }, '');
      }
    } catch (_) {}
    // initial loading state
    var boot = h('div', {
      class: 'wbv2m',
      style: {
        position:'relative', height:'100%', minHeight:'100vh', background:'#fff',
        display:'flex', flexDirection:'column'
      }
    },
      h('div', { style: { background: C.headerDark, padding:'14px 16px 12px', color:'#fff' }},
        h('div', { style: { display:'flex', alignItems:'center', gap:'8px' }},
          h('div', { style: {
            width:'30px', height:'30px', background: C.green, borderRadius:'8px',
            display:'flex', alignItems:'center', justifyContent:'center'
          }}, ICON.waLogo('white')),
          /* v2_1 — boot: just show a subtle loading tag; no SmartCRM branding */
          h('div', { style: { color: 'rgba(255,255,255,0.6)', fontSize:'11px', fontWeight:'500' }}, 'Loading…')
        )
      ),
      h('div', { style: {
        flex:'1', display:'flex', alignItems:'center', justifyContent:'center',
        background: C.listBg, color: C.textMeta, fontSize:'14px'
      }}, 'Loading conversations…')
    );
    view.replaceChildren(boot);
    // parallel fetch of ancillary data + threads
    Promise.all([
      loadThreads(),
      loadPhones(),
      loadStatuses(),
      loadUsers()
    ]).then(function () {
      rerender();
      installPoller();
    }).catch(function (err) {
      view.replaceChildren(h('div', {
        class:'wbv2m',
        style: { padding:'40px 24px', textAlign:'center', color: C.textPri }
      },
        h('div', { style: { fontSize:'36px', marginBottom:'12px' }}, '⚠️'),
        h('div', { style: { fontSize:'15px', fontWeight:'600', marginBottom:'6px' }}, 'Cannot load WhatsApp Inbox'),
        h('div', { style: { fontSize:'13px', color:'#6B7280', marginBottom:'16px' }}, (err && err.message) || 'Unknown error'),
        h('button', {
          class:'wbv2m-btn-tap',
          style: {
            background: C.green, color:'#fff', border:'none', borderRadius:'8px',
            padding:'10px 20px', fontSize:'14px', fontWeight:'600', cursor:'pointer'
          },
          onclick: function () { render(view); }
        }, 'Retry')
      ));
    });
    return view;
  }

  /* =============================================================
   * 25. EXPORT
   * ============================================================= */
  window.WB_CHAT_V2_MOBILE = {
    render: render,
    _state: S,           // exposed for diagnostics
    _api:  api,
    _colors: C
  };

})();
