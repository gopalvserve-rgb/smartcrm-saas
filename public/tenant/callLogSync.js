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
 * CALLLOG_AUTOSYNC_ON_OPEN_v2 (2026-07-12): also runs SILENTLY on every app open
 * and every return-from-background, so reps never have to tap anything. This lives
 * in the SPA (not native) on purpose -- LeadCRMNative.syncCallLog() already ships in
 * the installed APK, so auto-sync works on the phones people ALREADY have. No
 * reinstall needed. Reads ONLY the call log (number / timestamp / type / duration).
 * It never touches recordings, so it cannot hang the app.
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
  /* STALE_APK_MSG_v1 (2026-07-13) — inside the app shell but with no LeadCRMNative
   * bridge means exactly one thing: the installed APK is older than the build that
   * added syncCallLog. Both the dialog banner and runSync() used to tell the rep to
   * "open the app on the phone and tap Sync Calls" — which they were ALREADY DOING,
   * standing inside the app, reading that message. It's advice for desktop web shown
   * to a phone. Distinguish the two cases and tell a stale build to UPDATE. */
  function inAppShell() {
    try {
      if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return true;
      if (window.Capacitor) return true;
      if (/Capacitor|CapacitorWebView/i.test(navigator.userAgent || '')) return true;
    } catch (e) {}
    return false;
  }
  function staleApk() { return inAppShell() && !hasNative(); }
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
  function runSync(sinceMs, untilMs, btn, opts) {
    opts = opts || {};
    var silent = !!opts.silent;
    var say = function (m, t) { if (!silent) toast(m, t); else { try { console.log('[callsync]', m); } catch (e) {} } };
    if (!hasNative()) {
      say(staleApk()
        ? 'Your app is out of date and cannot read the call log. Please update the app.'
        : 'Call sync runs in the mobile app. Open the app and tap Sync Calls.', 'warn');
      if (opts.done) opts.done(null);
      return;
    }
    if (btn) { btn.disabled = true; btn.dataset._t = btn.textContent; btn.textContent = 'Reading call log…'; }
    var cb = '__clsSyncCb_' + Date.now();
    window[cb] = async function (json) {
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      var data;
      try { data = JSON.parse(json || '{}'); } catch (e) { data = { error: 'bad response' }; }
      if (data.error) { say('Could not read call log: ' + data.error, 'err'); restore(); if (opts.done) opts.done(null); return; }
      var rows = data.rows || [];
      if (!rows.length) { say('No calls found in that range on the selected SIM(s).', 'warn'); restore(); if (opts.done) opts.done({ inserted: 0, repaired: 0 }); return; }
      try {
        var r = await api('api_call_logSyncBatch', { rows: rows });
        var fixed = Number(r.repaired || 0);
        var added = Number(r.inserted || 0);
        if (silent) {
          // Only speak up when something actually changed; otherwise stay quiet.
          if (added || fixed) {
            toast('🔄 ' + added + ' new call' + (added === 1 ? '' : 's') +
                  (fixed ? ' · ' + fixed + ' fixed' : '') + ' synced from your phone', 'ok');
          }
          try { console.log('[callsync] auto:', JSON.stringify(r)); } catch (e) {}
        } else {
          toast('✅ Synced ' + added + ' new call' + (added === 1 ? '' : 's') +
                (fixed ? ' · ' + fixed + ' fixed' : '') +
                ' · ' + r.skipped + ' already logged · ' + r.matched + ' matched a lead', 'ok');
        }
        if (String(location.hash).indexOf('callactivity') >= 0 && typeof window.loadCallActivity === 'function') {
          try { window.loadCallActivity(); } catch (e) {}
        }
        if (opts.done) opts.done(r);
      } catch (e) { say('Upload failed: ' + e.message, 'err'); if (opts.done) opts.done(null); }
      restore();
    };
    function restore() { if (btn && btn.dataset._t) { btn.disabled = false; btn.textContent = btn.dataset._t; } }
    try { LeadCRMNative.syncCallLog(sinceMs, untilMs, cb); }
    catch (e) { try { delete window[cb]; } catch (_) {} say('Sync failed: ' + e.message, 'err'); restore(); if (opts.done) opts.done(null); }
  }

  // ---- CALLLOG_AUTOSYNC_ON_OPEN_v2 ---------------------------------------
  // Sync the phone's call log automatically on every app open / resume.
  //
  // Why this lives in JS and not in the APK: LeadCRMNative.syncCallLog() is
  // ALREADY in the installed app (that's what the Sync button calls), so doing
  // it here means auto-sync starts working on the phones people already have --
  // no reinstall, no waiting for a store/APK rollout.
  //
  // AUTOSYNC_EVERY_OPEN_v3 (2026-07-12) — three bugs that made this NOT fire on
  // every open, all fixed here:
  //
  //   1. There was a 3-MINUTE persistent debounce. Close + reopen inside 3
  //      minutes and the sync was skipped. That is not "every open". The guard
  //      is now IN-MEMORY ONLY and just 15s -- long enough to collapse the
  //      visibilitychange + focus + capacitor-resume events that all fire
  //      together on a single resume, short enough that every genuine open
  //      syncs. A fresh app launch resets it, so a cold open ALWAYS syncs.
  //
  //   2. The debounce timestamp was written BEFORE the sync ran, so a FAILED
  //      sync still burned the window. Now only success advances the watermark.
  //
  //   3. On a cold launch we checked for the auth token once at +2.5s and gave
  //      up silently if login/bootstrap hadn't finished -- so a slow login meant
  //      that whole session never synced. Now we retry until the token shows up.
  //
  // Reads the CallLog content provider only -- number, timestamp, type,
  // duration, SIM. NO recording files are touched, so it can't hang the app.
  var DAY = 86400000;
  var AUTO_MIN_GAP_MS = 15 * 1000;   // in-memory only: collapses duplicate resume events
  var autoRunning = false;
  var lastRunAt = 0;                 // in-memory -> a fresh launch always syncs

  function autoKey(k) { return 'cls_auto_' + k + '_' + (slug() || 'x'); }
  function lsGetNum(k) { var v = Number(localStorage.getItem(autoKey(k)) || 0); return isFinite(v) ? v : 0; }
  function lsSetNum(k, v) { try { localStorage.setItem(autoKey(k), String(v)); } catch (e) {} }

  function autoSync(reason) {
    if (autoRunning) return;
    if (!hasNative()) return;                                  // desktop web
    // CALLS_HUB_v1 — respect the rep's toggle in Settings > Calls & Mobile.
    // Default ON; only an explicit '0' turns it off.
    try {
      if (localStorage.getItem('cls_auto_enabled_' + (slug() || 'x')) === '0') return;
    } catch (e) {}
    if (!token()) { waitForTokenThenSync(reason); return; }    // bug 3: retry, don't give up

    var now = Date.now();
    if (lastRunAt && (now - lastRunAt) < AUTO_MIN_GAP_MS) return;  // duplicate resume event

    // Window: from the last successful sync (minus 15 min of slack) to now.
    var lastOk = lsGetNum('since');
    var since  = lastOk ? (lastOk - 15 * 60 * 1000) : (now - 7 * DAY);

    /* BACKSYNC_HEAL_v1 (2026-07-13) — the watermark could strand calls FOREVER.
     * A sync that the server accepts but which stores nothing (because a policy
     * rejected every row — e.g. sync_directions was empty, or "only CRM leads" hid
     * a number that only became a lead later) still counted as SUCCESS, so
     * lsSetNum('since', now) advanced the watermark straight past those calls.
     * They were never stored server-side and would never be offered again: the
     * gap was unrecoverable without the rep manually running a date-range sync.
     * Live case: komal, 12 Jul — 100% of her calls were skipped for ~17 hours.
     *
     * So the watermark is now an OPTIMISATION, not a promise: always re-offer the
     * last MIN_LOOKBACK. The server dedups (`if (dup.length) { skipped++; continue; }`),
     * so re-sent rows cost one cheap query and insert nothing. Any policy change now
     * back-fills itself on the rep's next app open, with no manual step.
     * Still CallLog only — number/time/type/duration/SIM. No recordings, cannot hang. */
    var MIN_LOOKBACK_MS = 3 * DAY;
    var reScan = now - MIN_LOOKBACK_MS;
    if (since > reScan) since = reScan;

    var floor  = now - 7 * DAY;                    // never look back further
    if (since < floor) since = floor;

    autoRunning = true;
    lastRunAt = now;
    try { console.log('[callsync] auto-sync (' + reason + ') since ' + new Date(since).toISOString()); } catch (e) {}

    runSync(since, now, null, {
      silent: true,
      done: function (r) {
        autoRunning = false;
        if (r) {
          lsSetNum('since', now);                  // bug 2: only advance on SUCCESS
        } else {
          lastRunAt = 0;                           // bug 2: a failure must not block the next try
        }
      }
    });
  }

  // Bug 3: on a cold launch the SPA may not have written the token yet. Poll for
  // it (every 1.5s, up to 30s) instead of silently skipping the whole session.
  var tokenWaitTimer = null;
  function waitForTokenThenSync(reason) {
    if (tokenWaitTimer) return;
    var tries = 0;
    tokenWaitTimer = setInterval(function () {
      tries++;
      if (token()) {
        clearInterval(tokenWaitTimer); tokenWaitTimer = null;
        autoSync(reason + '+token-ready');
      } else if (tries >= 20) {                    // 20 x 1.5s = 30s
        clearInterval(tokenWaitTimer); tokenWaitTimer = null;
        try { console.log('[callsync] gave up waiting for token'); } catch (e) {}
      }
    }, 1500);
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
    if (staleApk()) {
      // Out-of-date APK: the rep IS in the app. Telling them to "open the app" is useless.
      simBox.innerHTML =
        '<div style="background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:8px;padding:.7rem .8rem;font-size:.82rem;line-height:1.5">' +
          '⚠️ <b>Your app is out of date.</b><br>This version can\'t read your phone\'s call log, so your calls are not reaching the CRM. ' +
          'Update the app, allow the <b>Call log</b> permission, and your recent calls will sync in automatically.' +
          '<a href="/LeadCRM.apk" download style="display:block;margin-top:.6rem;background:#dc2626;color:#fff;text-align:center;padding:.5rem;border-radius:7px;text-decoration:none;font-weight:700">⬇ Update the app now</a>' +
        '</div>';
    } else if (!hasNative()) {
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
    /* STALE_APK_MSG_v1 — on a stale build every preset is a no-op (runSync bails at the
     * native guard). Offering "Today / Yesterday / Last 7 days" that silently do nothing
     * is exactly what made this look like a broken button rather than an old app. */
    if (staleApk()) {
      presets.style.display = 'none';
      var per = card.querySelector('#cls-presets') && card.querySelector('#cls-presets').previousElementSibling;
      if (per) per.style.display = 'none';
    }
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

  // ---- floating "Sync Calls" button for EVERY user inside the mobile app ---
  // Call syncing is a per-rep action (each rep syncs their own phone + picks
  // their own SIM), so it must be available to all roles — not just the
  // admin/manager-only Call Activity page. Shown only inside the app.
  function isMobileApp() {
    return !!(window.LeadCRMNative) || /Capacitor|LeadCRM/i.test(navigator.userAgent || '');
  }
  function injectFab() {
    if (!isMobileApp()) return;                 // desktop web: no FAB
    if (!token()) return;                        // only when logged in
    if (document.getElementById('cls-fab')) return;
    var fab = document.createElement('button');
    fab.id = 'cls-fab';
    fab.title = 'Sync calls — tap to open, drag to move';
    fab.innerHTML = '🔄 Sync Calls';
    fab.style.cssText = 'position:fixed;z-index:99998;background:#4f46e5;color:#fff;border:none;border-radius:999px;padding:.55rem .9rem;font-size:.8rem;font-weight:600;box-shadow:0 6px 18px rgba(79,70,229,.45);cursor:grab;display:inline-flex;align-items:center;gap:.35rem;touch-action:none;user-select:none;-webkit-user-select:none';
    document.body.appendChild(fab);

    // Position it (restore last spot, else default bottom-left) and keep it on-screen.
    function place(left, top) {
      var w = fab.offsetWidth || 120, hh = fab.offsetHeight || 40;
      left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
      top = Math.max(4, Math.min(top, window.innerHeight - hh - 4));
      fab.style.left = left + 'px'; fab.style.top = top + 'px';
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
    }
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('cls_fab_pos') || 'null'); } catch (e) {}
    if (saved && typeof saved.left === 'number') place(saved.left, saved.top);
    else place(12, window.innerHeight - 72);

    // Drag to move (pointer events = touch + mouse). A tap (no real movement)
    // opens the modal; a drag repositions and remembers the spot.
    var sx = 0, sy = 0, ol = 0, ot = 0, moved = false, dragging = false;
    fab.addEventListener('pointerdown', function (e) {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = fab.getBoundingClientRect(); ol = r.left; ot = r.top;
      fab.style.cursor = 'grabbing';
      try { fab.setPointerCapture(e.pointerId); } catch (_) {}
    });
    fab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (moved) { place(ol + dx, ot + dy); e.preventDefault(); }
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false; fab.style.cursor = 'grab';
      try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) {
        var r = fab.getBoundingClientRect();
        try { localStorage.setItem('cls_fab_pos', JSON.stringify({ left: r.left, top: r.top })); } catch (_) {}
      } else {
        openModal();
      }
    }
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', endDrag);
  }

  // ---- mobile UI tweak: hide the Classic/Modern/Inbox leads toggle on phones -
  // Injected here (not in the shared styles.css) to avoid touching that large file.
  // !important is required because app.js sets the toggle's display inline.
  function injectMobileCss() {
    if (document.getElementById('cls-mobile-css')) return;
    var st = document.createElement('style');
    st.id = 'cls-mobile-css';
    st.textContent = '@media (max-width: 768px){#lv2-topbar-toggle{display:none !important;}}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---- APK_UPDATE_SUPPRESS_v1 ---------------------------------------------
  // The "Update Available" modal re-appears on EVERY app launch and every
  // return-from-background (app.js runs _apkUpdateCheck on resume, and "Later"
  // is only remembered in sessionStorage, which is wiped each session).
  // Per request: suppress it completely. Done from here because app.js must not
  // be touched (local copy has diverged from main).
  function suppressApkUpdatePrompt() {
    // 1) Neutralise the checker itself. The resume re-check reads
    //    window._apkUpdateCheck at call time, so this override wins.
    try { window._apkUpdateCheck = function () {}; } catch (e) {}
    // 2) Hide + remove anything the very first check (which runs before this
    //    bolt-on loads) may already have rendered.
    if (!document.getElementById('cls-noupdate-css')) {
      var st = document.createElement('style');
      st.id = 'cls-noupdate-css';
      st.textContent = '#apk-update-modal{display:none !important;}';
      (document.head || document.documentElement).appendChild(st);
    }
    var kill = function () {
      var m = document.getElementById('apk-update-modal');
      if (m) { try { m.remove(); } catch (e) {} }
    };
    kill();
    try {
      new MutationObserver(kill).observe(document.body || document.documentElement, { childList: true });
    } catch (e) {}
  }

  var mo = new MutationObserver(function () { try { injectButton(); injectFab(); } catch (e) {} });
  function start() {
    try { suppressApkUpdatePrompt(); } catch (e) {}
    try { injectMobileCss(); } catch (e) {}
    try { mo.observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener('hashchange', function () { setTimeout(function () { injectButton(); injectFab(); }, 200); });
    setTimeout(function () { injectButton(); injectFab(); }, 800);

    // CALLLOG_AUTOSYNC_ON_OPEN_v2 — fire on open, and again whenever the app is
    // brought back to the foreground. Delayed 2.5s on boot so login/bootstrap
    // finishes first (we need the token) and the UI paints before we do work.
    setTimeout(function () { try { autoSync('app-open'); } catch (e) {} }, 2500);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        setTimeout(function () { try { autoSync('app-resume'); } catch (e) {} }, 800);
      }
    });
    window.addEventListener('focus', function () {
      setTimeout(function () { try { autoSync('window-focus'); } catch (e) {} }, 800);
    });
    // Capacitor fires this on native resume even when visibilitychange doesn't.
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.addListener('appStateChange', function (st) {
          if (st && st.isActive) {
            setTimeout(function () { try { autoSync('capacitor-resume'); } catch (e) {} }, 800);
          }
        });
      }
    } catch (e) {}
  }
  // Exposed so support can force a sync from the console: CRM_syncCallsNow()
  try {
    window.CRM_syncCallsNow = function (days) {
      var n = Date.now();
      runSync(n - (Number(days) || 7) * DAY, n, null, {});
    };
    window.CRM_autoSyncCalls = autoSync;
  } catch (e) {}

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
