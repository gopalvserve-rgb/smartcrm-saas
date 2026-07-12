/*
 * public/tenant/callSettings.js — CALLS_HUB_v1 (2026-07-12)
 *
 * ONE place for every call/mobile setting. Before this, they were scattered:
 *
 *   Auto-add lead (inbound/outbound/min-sec/status/duplicates)
 *                                  -> Settings > "Auto-Assign Rules"   (!)
 *   Auto-add lead: mode            -> Settings > "Pending Call Queue"  (!)
 *   Save only lead-matched calls   -> a toggle on the Call Activity PAGE
 *   SIM 1 / SIM 2 selection        -> only inside the floating Sync popup
 *   Auto-sync on app open          -> nowhere at all
 *   View SIM 1 vs SIM 2 data       -> did not exist
 *
 * This adds a "Calls & Mobile" tab to Settings that gathers all of them, plus a
 * SIM filter on Call Activity. Isolated bolt-on: it injects itself into the
 * Settings rail and the Call Activity filter bar rather than editing app.js
 * (58k lines, shared, and its local copy has diverged from main).
 *
 * DEVICE settings (SIM choice, auto-sync) are per-rep and live on the phone via
 * the LeadCRMNative bridge. TENANT settings are admin-only and go through
 * api_admin_setConfig. The tab shows each rep only what they can actually change.
 */
(function () {
  'use strict';

  var TAB_ID = 'callsmobile';

  // ---- plumbing -----------------------------------------------------------
  function slug() {
    var m = String(location.pathname || '').match(/^\/t\/([^\/]+)\//);
    return m ? m[1] : '';
  }
  function apiBase() {
    var m = String(location.pathname || '').match(/^\/t\/[^\/]+\//);
    return (m ? m[0] : '/') + 'api';
  }
  function token() {
    var s = slug();
    return (s && localStorage.getItem('crm_token_' + s)) || localStorage.getItem('crm_token') || '';
  }
  function api(fn, arg) {
    var args = (arguments.length > 1) ? [token(), arg] : [token()];
    return fetch(apiBase(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args })
    }).then(function (res) {
      return res.json().then(function (j) {
        if (!res.ok || j.error) throw new Error(j.error || ('HTTP ' + res.status));
        return j.result;
      });
    });
  }
  function toast(m, t) {
    if (typeof window.toast === 'function') { try { return window.toast(m, t); } catch (e) {} }
    try { console.log('[calls-hub]', m); } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isAdmin() {
    try { return !!(window.CRM && CRM.user && CRM.user.role === 'admin'); } catch (e) { return false; }
  }
  function inApp() {
    return !!(window.LeadCRMNative) || /Capacitor|LeadCRM/i.test(navigator.userAgent || '');
  }
  function hasNative() {
    return !!(window.LeadCRMNative && typeof window.LeadCRMNative.syncCallLog === 'function');
  }

  // ---- device (per-rep, stored on the phone) -------------------------------
  function getSims() {
    if (!window.LeadCRMNative || typeof LeadCRMNative.getSims !== 'function') return [];
    try { return JSON.parse(LeadCRMNative.getSims() || '[]'); } catch (e) { return []; }
  }
  function getAllowedCsv() {
    if (!window.LeadCRMNative || typeof LeadCRMNative.getSimSyncPref !== 'function') return '';
    try { return String(LeadCRMNative.getSimSyncPref() || ''); } catch (e) { return ''; }
  }
  function setAllowedCsv(csv) {
    if (window.LeadCRMNative && typeof LeadCRMNative.setSimSyncPref === 'function') {
      try { LeadCRMNative.setSimSyncPref(csv); return true; } catch (e) {}
    }
    return false;
  }
  // Shared with callLogSync.js — keep these key names in sync.
  function autoOnKey()   { return 'cls_auto_enabled_' + (slug() || 'x'); }
  function lastSyncKey() { return 'cls_auto_since_'   + (slug() || 'x'); }
  function autoSyncOn()  { return localStorage.getItem(autoOnKey()) !== '0'; }   // default ON
  function setAutoSync(on) { try { localStorage.setItem(autoOnKey(), on ? '1' : '0'); } catch (e) {} }
  function lastSyncText() {
    var v = Number(localStorage.getItem(lastSyncKey()) || 0);
    if (!v) return 'never';
    return new Date(v).toLocaleString('en-IN');
  }

  // ---- little DOM helpers -------------------------------------------------
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') n.style.cssText = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function card(title, subtitle) {
    var c = el('div', { class: 'card', style: 'padding:1rem;margin-bottom:1rem' });
    c.appendChild(el('h4', { style: 'margin:0 0 .25rem' }, esc(title)));
    if (subtitle) c.appendChild(el('div', { class: 'muted', style: 'margin-bottom:.75rem;font-size:.85rem' }, subtitle));
    return c;
  }
  function row(labelHtml, control) {
    var r = el('label', { style: 'display:flex;align-items:center;gap:.6rem;margin:.45rem 0;cursor:pointer' });
    r.appendChild(control);
    r.appendChild(el('span', { style: 'flex:1' }, labelHtml));
    return r;
  }
  function checkbox(checked) {
    var c = el('input');
    c.type = 'checkbox';
    c.checked = !!checked;
    return c;
  }

  // ---- the tab panel ------------------------------------------------------
  async function render(body) {
    body.innerHTML = '';
    var wrap = el('div', { class: 'admin-section' });
    wrap.appendChild(el('h2', { style: 'margin-top:0' }, '📱 Calls &amp; Mobile'));
    wrap.appendChild(el('div', { class: 'muted', style: 'margin-bottom:1rem' },
      'Everything about how calls get into the CRM — in one place. ' +
      '<b>This phone</b> settings are yours alone and are stored on your device. ' +
      '<b>Company</b> settings apply to everyone and can only be changed by an admin.'));
    body.appendChild(wrap);

    // ============ 1. THIS PHONE (every rep) ============
    var c1 = card('📶 This phone — SIM &amp; sync',
      'Set once. Your phone remembers it. Only calls on the SIM(s) you tick are copied into the CRM.');

    if (!inApp()) {
      c1.appendChild(el('div', { class: 'muted', style: 'padding:.6rem;background:#f8fafc;border-radius:8px' },
        'ℹ️ Open the CRM in the <b>mobile app</b> to choose your SIM and sync calls. ' +
        'These are phone settings, so they can\'t be set from a desktop browser.'));
    } else {
      var sims = getSims();
      var allowed = getAllowedCsv().split(',').map(function (s) { return s.trim(); }).filter(Boolean);

      if (!sims.length) {
        c1.appendChild(el('div', { class: 'muted' },
          'Could not read your SIM cards. Make sure the app has the Phone permission.'));
      } else {
        c1.appendChild(el('div', { style: 'font-weight:600;margin-bottom:.3rem' }, 'Sync calls from:'));
        var simBox = el('div', { style: 'margin-bottom:.7rem' });
        var boxes = [];
        sims.forEach(function (s) {
          var slot = String(s.slot);
          // Empty selection = no filter = every SIM. Show that as "all ticked".
          var on = allowed.length === 0 || allowed.indexOf(slot) >= 0;
          var cb = checkbox(on);
          cb.setAttribute('data-slot', slot);
          boxes.push(cb);
          var label = 'SIM ' + (Number(s.slot) + 1) + (s.carrier ? ' · <span class="muted">' + esc(s.carrier) + '</span>' : '');
          simBox.appendChild(row(label, cb));
        });
        c1.appendChild(simBox);

        var persist = function () {
          var picked = boxes.filter(function (b) { return b.checked; })
                            .map(function (b) { return b.getAttribute('data-slot'); });
          if (!picked.length) {
            toast('Pick at least one SIM, otherwise nothing will sync.', 'warn');
            boxes.forEach(function (b) { b.checked = true; });
            picked = boxes.map(function (b) { return b.getAttribute('data-slot'); });
          }
          // All ticked = no filter (store empty) so a newly-added SIM still syncs.
          var csv = (picked.length === boxes.length) ? '' : picked.join(',');
          setAllowedCsv(csv);
          toast('✅ SIM preference saved on this phone', 'ok');
        };
        boxes.forEach(function (b) { b.addEventListener('change', persist); });
      }

      // auto-sync toggle
      var autoCb = checkbox(autoSyncOn());
      autoCb.addEventListener('change', function () {
        setAutoSync(autoCb.checked);
        toast(autoCb.checked ? '✅ Auto-sync ON' : 'Auto-sync turned off', 'ok');
      });
      c1.appendChild(row(
        '<b>Sync my call log every time I open the app</b>' +
        '<div class="muted" style="font-size:.8rem">Copies number, time, call status and talk time from your phone. ' +
        'Recordings are never fetched, so it can\'t slow the app down.</div>',
        autoCb));

      var last = el('div', { class: 'muted', style: 'font-size:.8rem;margin:.5rem 0 .7rem' },
        'Last synced: <b>' + esc(lastSyncText()) + '</b>');
      c1.appendChild(last);

      var btnRow = el('div', { style: 'display:flex;gap:.4rem;flex-wrap:wrap' });
      [['Today', 1], ['Last 7 days', 7], ['Last 30 days', 30]].forEach(function (p) {
        var b = el('button', { class: 'btn sm' }, '🔄 Sync ' + p[0]);
        b.onclick = function () {
          if (!hasNative()) { toast('Call sync only works inside the mobile app.', 'warn'); return; }
          try { window.CRM_syncCallsNow(p[1]); } catch (e) { toast('Sync failed: ' + e.message, 'err'); }
        };
        btnRow.appendChild(b);
      });
      c1.appendChild(btnRow);
    }
    wrap.appendChild(c1);

    // ============ 2 + 3. COMPANY SETTINGS (admin only) ============
    if (!isAdmin()) {
      var note = card('🏢 Company call settings', null);
      note.appendChild(el('div', { class: 'muted' },
        'Which calls are saved, and whether unknown numbers become leads automatically, ' +
        'is set by your admin and applies to the whole team.'));
      wrap.appendChild(note);
      return;
    }

    var cfg = {}, statuses = [];
    try { cfg = await api('api_admin_getConfig') || {}; } catch (e) { cfg = {}; }
    try { statuses = await api('api_statuses_list') || []; } catch (e) { statuses = []; }

    var on = function (k, dflt) {
      var v = cfg[k];
      if (v == null || v === '') return !!dflt;   // CONFIG_EMPTYSTRING_TRAP: never String(v||'x')
      return String(v) === '1';
    };

    // --- which calls get saved ---
    var c2 = card('💾 Which calls get saved',
      'By default every call on the chosen SIM is copied in. Tighten it here if you only care about calls with known leads.');

    var capCb = checkbox(on('CALL_CAPTURE_LEAD_ONLY', false));
    c2.appendChild(row('Only save calls that match a CRM lead' +
      '<div class="muted" style="font-size:.8rem">Personal calls are ignored. Applies to live call capture.</div>', capCb));

    var syncOnlyCb = checkbox(on('CALLS_SYNC_LEAD_ONLY', false));
    c2.appendChild(row('Same rule for the phone call-log sync' +
      '<div class="muted" style="font-size:.8rem">Was previously impossible to save — the key was missing from the config allowlist.</div>', syncOnlyCb));

    var actCb = checkbox(on('CALL_ACTIVITY_LEAD_ONLY', false));
    c2.appendChild(row('Call Activity page shows lead-matched calls by default' +
      '<div class="muted" style="font-size:.8rem">A view filter only — nothing is deleted.</div>', actCb));
    wrap.appendChild(c2);

    // --- auto-add leads ---
    var c3 = card('➕ Auto-add leads from calls',
      'When a call comes from a number that is NOT in the CRM, create a lead for it automatically.');

    var modeSel = el('select', { class: 'input', style: 'max-width:16rem' });
    [['auto', 'Create the lead automatically'], ['manual', 'Ask me first (popup)']].forEach(function (o) {
      var op = el('option', { value: o[0] }, o[1]);
      if (String(cfg.CALLS_AUTOLEAD_MODE || 'auto').toLowerCase() === o[0]) op.setAttribute('selected', 'selected');
      modeSel.appendChild(op);
    });
    c3.appendChild(el('div', { style: 'margin:.3rem 0 .1rem;font-weight:600' }, 'Mode'));
    c3.appendChild(modeSel);

    var inCb  = checkbox(on('CALLS_AUTOLEAD_INBOUND', false));
    var outCb = checkbox(on('CALLS_AUTOLEAD_OUTBOUND', false));
    c3.appendChild(el('div', { style: 'margin:.8rem 0 .1rem;font-weight:600' }, 'Create a lead for…'));
    c3.appendChild(row('Incoming &amp; missed calls from unknown numbers', inCb));
    c3.appendChild(row('Outgoing calls to unknown numbers' +
      '<div class="muted" style="font-size:.8rem">Usually left off — most outbound calls are to leads you already have.</div>', outCb));

    var minInp = el('input', { class: 'input', style: 'width:6rem', type: 'number', min: '0', step: '1' });
    minInp.value = String(Number(cfg.CALLS_AUTOLEAD_MIN_SECONDS == null ? 5 : cfg.CALLS_AUTOLEAD_MIN_SECONDS) || 0);
    var minWrap = el('div', { style: 'display:flex;align-items:center;gap:.5rem;margin:.7rem 0' });
    minWrap.appendChild(el('span', {}, 'Only if the call lasted at least'));
    minWrap.appendChild(minInp);
    minWrap.appendChild(el('span', {}, 'seconds <span class="muted">(0 = include missed calls too)</span>'));
    c3.appendChild(minWrap);

    var stSel = el('select', { class: 'input', style: 'max-width:16rem' });
    stSel.appendChild(el('option', { value: '' }, '— Default (New) —'));
    (statuses || []).forEach(function (s) {
      var op = el('option', { value: String(s.id) }, esc(s.name || s.label || ('#' + s.id)));
      if (String(cfg.CALLS_AUTOLEAD_STATUS_ID || '') === String(s.id)) op.setAttribute('selected', 'selected');
      stSel.appendChild(op);
    });
    c3.appendChild(el('div', { style: 'margin:.5rem 0 .1rem;font-weight:600' }, 'New leads get this status'));
    c3.appendChild(stSel);

    var dupSel = el('select', { class: 'input', style: 'max-width:16rem' });
    [['attach', 'Attach the call to the existing lead'],
     ['skip',   'Do nothing'],
     ['new',    'Create another lead anyway']].forEach(function (o) {
      var op = el('option', { value: o[0] }, o[1]);
      if (String(cfg.CALLS_AUTOLEAD_ON_DUPLICATE || 'attach').toLowerCase() === o[0]) op.setAttribute('selected', 'selected');
      dupSel.appendChild(op);
    });
    c3.appendChild(el('div', { style: 'margin:.7rem 0 .1rem;font-weight:600' }, 'If the number already exists'));
    c3.appendChild(dupSel);
    wrap.appendChild(c3);

    // --- save ---
    var saveBar = el('div', { style: 'display:flex;gap:.5rem;align-items:center;margin-top:.5rem' });
    var save = el('button', { class: 'btn primary' }, '💾 Save company settings');
    save.onclick = async function () {
      save.disabled = true; save.textContent = 'Saving…';
      try {
        await api('api_admin_setConfig', {
          CALL_CAPTURE_LEAD_ONLY:     capCb.checked ? '1' : '0',
          CALLS_SYNC_LEAD_ONLY:       syncOnlyCb.checked ? '1' : '0',
          CALL_ACTIVITY_LEAD_ONLY:    actCb.checked ? '1' : '0',
          CALLS_AUTOLEAD_MODE:        modeSel.value,
          CALLS_AUTOLEAD_INBOUND:     inCb.checked ? '1' : '0',
          CALLS_AUTOLEAD_OUTBOUND:    outCb.checked ? '1' : '0',
          CALLS_AUTOLEAD_MIN_SECONDS: String(Number(minInp.value) || 0),
          CALLS_AUTOLEAD_STATUS_ID:   stSel.value || '0',
          CALLS_AUTOLEAD_ON_DUPLICATE: dupSel.value
        });
        try {
          window.CRM.brand = Object.assign(window.CRM.brand || {}, {
            CALL_CAPTURE_LEAD_ONLY:  capCb.checked ? '1' : '0',
            CALL_ACTIVITY_LEAD_ONLY: actCb.checked ? '1' : '0'
          });
        } catch (e) {}
        toast('✅ Saved — applies to the whole team', 'ok');
      } catch (e) {
        toast('Could not save: ' + e.message, 'err');
      }
      save.disabled = false; save.textContent = '💾 Save company settings';
    };
    saveBar.appendChild(save);
    wrap.appendChild(saveBar);
  }

  // ---- inject the tab into the Settings rail --------------------------------
  function injectTab() {
    if (String(location.hash).indexOf('admin') < 0) return;
    var rail = document.querySelector('.admin-settings-group');
    if (!rail || !rail.parentElement) return;
    if (document.querySelector('.admin-settings-item[data-tab="' + TAB_ID + '"]')) return;

    var btn = document.createElement('button');
    btn.className = 'admin-settings-item';
    btn.setAttribute('data-tab', TAB_ID);
    btn.setAttribute('data-label', '📱 calls & mobile');
    btn.setAttribute('data-search',
      'calls mobile sim sim1 sim2 sim 1 sim 2 call sync call log auto sync lead auto add ' +
      'auto create lead incoming outgoing missed call capture recording phone android');
    btn.textContent = '📱 Calls & Mobile';
    btn.onclick = function () { open(); };

    // Own group, pinned to the top of the rail — this is the thing people hunt for.
    var group = document.createElement('div');
    group.className = 'admin-settings-group';
    var title = document.createElement('div');
    title.className = 'admin-settings-group-title';
    title.textContent = 'Calls & Mobile';
    group.appendChild(title);
    group.appendChild(btn);
    rail.parentElement.insertBefore(group, rail);
  }

  function open() {
    var body = document.getElementById('admin-body');
    if (!body) return;
    document.querySelectorAll('.subtab,.admin-settings-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === TAB_ID);
    });
    body.innerHTML = '<div class="loading">Loading…</div>';
    render(body).catch(function (e) {
      body.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    });
  }

  // ---- SIM filter on the Call Activity page ---------------------------------
  // app.js stamps each row with data-sim (one-line change); we just add chips.
  function injectSimFilter() {
    if (String(location.hash).indexOf('callactivity') < 0) return;
    var bar = document.getElementById('ca-recent-filterbar');
    if (!bar || bar.querySelector('#cs-sim-filter')) return;

    var tbl = document.querySelector('#ca-recent table');
    if (!tbl) return;
    var slots = {};
    tbl.querySelectorAll('tbody tr[data-sim]').forEach(function (tr) {
      var s = tr.getAttribute('data-sim');
      if (s !== '') slots[s] = true;
    });
    var keys = Object.keys(slots).sort();
    if (!keys.length) return;   // nothing SIM-tagged yet — don't show a dead filter

    var box = document.createElement('span');
    box.id = 'cs-sim-filter';
    box.style.cssText = 'display:inline-flex;gap:.3rem;align-items:center;margin-left:.4rem';
    box.appendChild(Object.assign(document.createElement('span'),
      { className: 'muted', textContent: 'SIM' }));

    var opts = [['', 'All']].concat(keys.map(function (k) { return [k, 'SIM ' + (Number(k) + 1)]; }));
    var current = '';
    var btns = [];
    opts.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = o[1];
      b.onclick = function () {
        current = o[0];
        btns.forEach(function (x) { x.classList.toggle('primary', x === b); });
        tbl.querySelectorAll('tbody tr').forEach(function (tr) {
          var s = tr.getAttribute('data-sim');
          tr.style.display = (!current || s === current) ? '' : 'none';
        });
      };
      btns.push(b);
      box.appendChild(b);
    });
    btns[0].classList.add('primary');
    bar.appendChild(box);
  }

  // ---- boot ---------------------------------------------------------------
  var mo = new MutationObserver(function () {
    try { injectTab(); injectSimFilter(); } catch (e) {}
  });
  function start() {
    try { mo.observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener('hashchange', function () {
      setTimeout(function () { try { injectTab(); injectSimFilter(); } catch (e) {} }, 250);
    });
    setTimeout(function () { try { injectTab(); injectSimFilter(); } catch (e) {} }, 900);
    try { window.CRM_openCallSettings = open; } catch (e) {}
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
