/*
 * public/tenant/callLogSync.js — CALLLOG_SYNC_v1 (SPA bolt-on)
 *
 * Adds a "Sync Calls" button to the Call Activity page and a modal with:
 *   • date-range presets (Today / Yesterday / Last 7 / 30 days / Last 6 months / Custom)
 *   • a persistent per-SIM selector (Model A) — set SIM 1/2 once, it sticks
 *
 * On sync it asks the native app (LeadCRMNative.syncCallLog) to read the phone's
 * CallLog.Calls over the chosen range (respecting the saved SIM selection), then
 * POSTs the rows to api_call_logSyncBatch. Isolated file — does not touch app.js.
 *
 * Desktop / no-app: the button explains this runs in the mobile app.
 */
(function () {
  'use strict';

  // ---- helpers ------------------------------------------------------------
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
  function toast(msg, type) {
    if (typeof window.toast === 'function') { try { return window.toast(msg, type); } catch (e) {} }
    try { console.log('[callsync]', msg); } catch (e) {}
  }
  function hasNative() {
    return !!(window.LeadCRMNative && typeof window.LeadCRMNative.syncCallLog === 'function');
  }
  async function api(fn, arg) {
    var res = await fetch(apiBase(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: [token(), arg] })
    });
    var j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || ('HTTP ' + res.status));
    return j.result;
  }

  // ---- SIMs (Model A persistent selection) --------------------------------
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
      try { LeadCRMNative.setSimSyncPref(csv); } catch (e) {}
    }
  }

  // ---- date range presets -------------------------------------------------
  function ranges() {
    var now = new Date();
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var DAY = 86400000;
    return {
      today:    { label: 'Today',          since: startOfToday,             until: now.getTime() },
      yesterday:{ label: 'Yesterday',       since: startOfToday - DAY,       until: startOfToday - 1 },
      d7:       { label: 'Last 7 days',     since: now.getTime() - 7 * DAY,  until: now.getTime() },
      d30:      { label: 'Last 30 days',    since: now.getTime() - 30 * DAY, until: now.getTime() },
      m6:       { label: 'Last 6 months',   since: now.getTime() - 182 * DAY, until: now.getTime() }
    };
  }

  // ---- the sync itself ----------------------------------------------------
  function runSync(sinceMs, untilMs, btn) {
    if (!hasNative()) {
      toast('Call sync runs in the mobile app. Open the app and tap Sync Calls.', 'warn');
      return;
    }
    if (btn) { btn.disabled = true; btn.dataset._t = btn.textContent; btn.textContent = 'Reading call log…'; }
    var cb = '__clsSyncCb_' + Date.now();
    window[cb] = async function (json) {
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      var data;
      try { data = JSON.parse(json || '{}'); } catch (e) { data = { error: 'bad response' }; }
      if (data.error) { toast('Could not read call log: ' + data.error, 'err'); restore(); return; }
      var rows = data.rows || [];
      if (!rows.length) { toast('No calls found in that range on the selected SIM(s).', 'warn'); restore(); return; }
      try {
        var r = await api('api_call_logSyncBatch', { rows: rows });
        toast('✅ Synced ' + r.inserted + ' new call' + (r.inserted === 1 ? '' : 's') +
              ' · ' + r.skipped + ' already logged · ' + r.matched + ' matched a lead', 'ok');
        if (String(location.hash).indexOf('callactivity') >= 0 && typeof window.loadCallActivity === 'function') {
          try { window.loadCallActivity(); } catch (e) {}
        }
      } catch (e) { toast('Upload failed: ' + e.message, 'err'); }
      restore();
    };
    function restore() { if (btn && btn.dataset._t) { btn.disabled = false; btn.textContent = btn.dataset._t; } }
    try { LeadCRMNative.syncCallLog(sinceMs, untilMs, cb); }
    catch (e) { try { delete window[cb]; } catch (_) {} toast('Sync failed: ' + e.message, 'err'); restore(); }
  }

  // ---- modal --------------------------------------------------------------
  function openModal() {
    if (document.getElementById('cls-modal')) return;
    var R = ranges();
    var wrap = document.createElement('div');
    wrap.id = 'cls-modal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:1rem';
    var card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:14px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden;font-family:inherit';
    card.innerHTML =
      '<div style="padding:1rem 1.2rem;border-bottom:1px solid #eef2f7;display:flex;align-items:center;justify-content:space-between">' +
        '<div style="font-weight:700;font-size:1.05rem">📞 Sync Calls from Phone</div>' +
        '<button id="cls-x" style="border:none;background:none;font-size:1.4rem;cursor:pointer;color:#64748b;line-height:1">&times;</button>' +
      '</div>' +
      '<div style="padding:1.1rem 1.2rem">' +
        '<div id="cls-sim-box"></div>' +
        '<div style="font-weight:600;font-size:.85rem;color:#475569;margin:.9rem 0 .5rem">Choose a period to import</div>' +
        '<div id="cls-presets" style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem"></div>' +
        '<div style="margin-top:.7rem;font-size:.75rem;color:#94a3b8">Reads incoming, outgoing & missed calls from your phone log. Already-logged calls are skipped automatically.</div>' +
        '<div id="cls-custom" style="margin-top:.7rem;display:none;gap:.4rem;align-items:center;flex-wrap:wrap">' +
          '<input type="date" id="cls-from" class="input" style="padding:.3rem"> <span style="color:#94a3b8">to</span> <input type="date" id="cls-to" class="input" style="padding:.3rem">' +
          '<button id="cls-custom-go" class="btn sm primary">Sync</button>' +
        '</div>' +
      '</div>';
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    var close = function () { try { wrap.remove(); } catch (e) {} };
    card.querySelector('#cls-x').onclick = close;
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });

    // SIM box (Model A)
    var simBox = card.querySelector('#cls-sim-box');
    var sims = getSims();
    if (!hasNative()) {
      simBox.innerHTML = '<div style="background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:8px;padding:.6rem .7rem;font-size:.82rem">📱 Call sync works in the <b>mobile app</b>. Open the app on the rep\'s phone and tap <b>Sync Calls</b> there.</div>';
    } else if (!sims.length) {
      simBox.innerHTML = '<div style="font-size:.82rem;color:#64748b">No SIM info available (grant Phone permission). All calls will be synced.</div>';
    } else {
      var allowed = getAllowedCsv().split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var allMode = allowed.length === 0;
      var html = '<div style="font-weight:600;font-size:.85rem;color:#475569;margin-bottom:.4rem">SIM cards to sync <span style="font-weight:400;color:#94a3b8">(saved for next time)</span></div>';
      sims.forEach(function (s) {
        var on = allMode || allowed.indexOf(String(s.slot)) >= 0;
        html += '<label style="display:flex;align-items:center;gap:.5rem;padding:.35rem 0;font-size:.9rem;cursor:pointer">' +
                '<input type="checkbox" class="cls-sim" data-slot="' + s.slot + '" ' + (on ? 'checked' : '') + '> ' +
                (s.label || ('SIM ' + (s.slot + 1))) + '</label>';
      });
      simBox.innerHTML = html;
      var persist = function () {
        var csv = [].slice.call(simBox.querySelectorAll('.cls-sim'))
          .filter(function (c) { return c.checked; })
          .map(function (c) { return c.getAttribute('data-slot'); }).join(',');
        setAllowedCsv(csv);
      };
      [].slice.call(simBox.querySelectorAll('.cls-sim')).forEach(function (c) { c.addEventListener('change', persist); });
    }

    // presets
    var presets = card.querySelector('#cls-presets');
    Object.keys(R).forEach(function (k) {
      var b = document.createElement('button');
      b.className = 'btn sm';
      b.style.cssText = 'padding:.5rem;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;cursor:pointer;font-size:.85rem';
      b.textContent = R[k].label;
      b.onclick = function () { close(); runSync(R[k].since, R[k].until, null); };
      presets.appendChild(b);
    });
    // custom toggle
    var custBtn = document.createElement('button');
    custBtn.className = 'btn sm';
    custBtn.style.cssText = 'padding:.5rem;border:1px dashed #cbd5e1;border-radius:8px;background:#fff;cursor:pointer;font-size:.85rem';
    custBtn.textContent = 'Custom…';
    custBtn.onclick = function () {
      var box = card.querySelector('#cls-custom');
      box.style.display = box.style.display === 'none' ? 'flex' : 'none';
    };
    presets.appendChild(custBtn);

    card.querySelector('#cls-custom-go').onclick = function () {
      var f = card.querySelector('#cls-from').value, t = card.querySelector('#cls-to').value;
      if (!f || !t) { toast('Pick both dates', 'warn'); return; }
      var since = new Date(f + 'T00:00:00').getTime();
      var until = new Date(t + 'T23:59:59').getTime();
      if (since > until) { toast('From date is after To date', 'warn'); return; }
      close(); runSync(since, until, null);
    };
  }
  window.openCallSync = openModal;

  // ---- inject the button into the Call Activity page ----------------------
  function injectButton() {
    if (String(location.hash).indexOf('callactivity') < 0) return;
    var anchor = document.getElementById('ca-recent');
    var host = anchor && anchor.parentElement; // the "Recent calls" card
    if (!host) return;
    if (host.querySelector('#cls-sync-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'cls-sync-btn';
    btn.className = 'btn sm primary';
    btn.style.cssText = 'margin:0 0 .5rem;display:inline-flex;align-items:center;gap:.4rem';
    btn.innerHTML = '🔄 Sync Calls from Phone';
    btn.onclick = function () { openModal(); };
    host.insertBefore(btn, anchor);
  }

  var mo = new MutationObserver(function () { try { injectButton(); } catch (e) {} });
  function start() {
    try { mo.observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener('hashchange', function () { setTimeout(injectButton, 200); });
    setTimeout(injectButton, 800);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
