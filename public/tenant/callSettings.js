/*
 * public/tenant/callSettings.js — CALLS_HUB_v3 / USER_CALL_PREFS_v1 (2026-07-12)
 *
 * Settings > "Calls & Mobile" — ONE place for every call/mobile setting.
 *
 * v3 makes these PER USER. They used to be one company-wide switch, which was
 * wrong: every rep has their own phone, their own SIMs and their own way of
 * working. Now each setting resolves as:
 *
 *      the rep's own choice, if they made one
 *      -> otherwise the company default (set by an admin)
 *
 * "Company default" is a real third state, not the same as Off. Every control
 * below is a 3-way choice so the difference stays visible.
 *
 * Admins additionally get: the company-default card, and a rep picker so they
 * can configure someone else's settings for them.
 *
 * Before this tab existed these lived in FOUR different screens:
 *   auto-add-lead in/out/min/status/dupes -> Settings > "Auto-Assign Rules"
 *   auto-add-lead mode                    -> Settings > "Pending Call Queue"
 *   lead-only capture toggles             -> the Call Activity page itself
 *   SIM 1 / SIM 2                         -> the floating Sync popup only
 *   auto-sync on open                     -> nowhere
 *
 * Isolated bolt-on: injects into the Settings rail + Call Activity filter bar
 * rather than editing app.js (58k lines, shared).
 */
(function () {
  'use strict';

  var TAB_ID = 'callsmobile';
  var INHERIT = '__inherit__';

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
  // app.js keeps `CRM` module-scoped — it is NOT on window — so the role has to
  // come from the JWT, which carries {id, email, role, t:<slug>}.
  function jwt() {
    try {
      var t = token();
      if (!t || t.split('.').length < 2) return {};
      return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) || {};
    } catch (e) { return {}; }
  }
  function isAdmin() { return String(jwt().role || '').toLowerCase() === 'admin'; }
  function myId()    { return Number(jwt().id) || 0; }

  function inApp()    { return !!(window.LeadCRMNative) || /Capacitor|LeadCRM/i.test(navigator.userAgent || ''); }
  function hasNative(){ return !!(window.LeadCRMNative && typeof window.LeadCRMNative.syncCallLog === 'function'); }

  // ---- the phone (SIM slots only exist on the device) -----------------------
  function getSims() {
    if (!window.LeadCRMNative || typeof LeadCRMNative.getSims !== 'function') return [];
    try { return JSON.parse(LeadCRMNative.getSims() || '[]'); } catch (e) { return []; }
  }
  function setDeviceSims(csv) {
    if (window.LeadCRMNative && typeof LeadCRMNative.setSimSyncPref === 'function') {
      try { LeadCRMNative.setSimSyncPref(csv); return true; } catch (e) {}
    }
    return false;
  }
  function lastSyncText() {
    var v = Number(localStorage.getItem('cls_auto_since_' + (slug() || 'x')) || 0);
    return v ? new Date(v).toLocaleString('en-IN') : 'never';
  }

  // ---- DOM helpers --------------------------------------------------------
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') n.style.cssText = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    if (html != null) n.innerHTML = html;
    return n;
  }
  function card(titleHtml, subtitleHtml) {
    var c = el('div', { class: 'card', style: 'padding:1rem;margin-bottom:1rem' });
    c.appendChild(el('h4', { style: 'margin:0 0 .25rem' }, titleHtml));
    if (subtitleHtml) c.appendChild(el('div', { class: 'muted', style: 'margin-bottom:.75rem;font-size:.85rem' }, subtitleHtml));
    return c;
  }

  /**
   * A 3-way control: Company default / Yes / No.
   * `mineVal` is the raw stored value (null => inheriting).
   * `companyVal` is the boolean the company default resolves to — shown inline
   * so the rep can see what "default" actually means for them right now.
   */
  function triState(labelHtml, mineVal, companyVal, hintHtml) {
    var wrap = el('div', { style: 'margin:.7rem 0' });
    var lab = el('div', { style: 'font-weight:600;margin-bottom:.15rem' }, labelHtml);
    wrap.appendChild(lab);
    if (hintHtml) wrap.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin-bottom:.3rem' }, hintHtml));

    var sel = el('select', { class: 'input', style: 'max-width:22rem' });
    var dflt = el('option', { value: INHERIT },
      'Use company default (' + (companyVal ? 'Yes' : 'No') + ')');
    var yes = el('option', { value: '1' }, 'Yes');
    var no  = el('option', { value: '0' }, 'No');
    sel.appendChild(dflt); sel.appendChild(yes); sel.appendChild(no);

    if (mineVal === null || mineVal === undefined) sel.value = INHERIT;
    else sel.value = (Number(mineVal) === 1) ? '1' : '0';

    wrap.appendChild(sel);
    wrap._sel = sel;
    wrap._get = function () { return sel.value === INHERIT ? null : sel.value; };
    return wrap;
  }

  function selectRow(labelHtml, mineVal, companyVal, options, hintHtml) {
    var wrap = el('div', { style: 'margin:.7rem 0' });
    wrap.appendChild(el('div', { style: 'font-weight:600;margin-bottom:.15rem' }, labelHtml));
    if (hintHtml) wrap.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin-bottom:.3rem' }, hintHtml));
    var sel = el('select', { class: 'input', style: 'max-width:22rem' });
    var lbl = (options.filter(function (o) { return o[0] === String(companyVal); })[0] || ['', companyVal])[1];
    sel.appendChild(el('option', { value: INHERIT }, 'Use company default (' + esc(lbl) + ')'));
    options.forEach(function (o) { sel.appendChild(el('option', { value: o[0] }, esc(o[1]))); });
    sel.value = (mineVal === null || mineVal === undefined || mineVal === '') ? INHERIT : String(mineVal);
    wrap.appendChild(sel);
    wrap._sel = sel;
    wrap._get = function () { return sel.value === INHERIT ? null : sel.value; };
    return wrap;
  }

  function numberRow(labelHtml, mineVal, companyVal, hintHtml) {
    var wrap = el('div', { style: 'margin:.7rem 0' });
    wrap.appendChild(el('div', { style: 'font-weight:600;margin-bottom:.15rem' }, labelHtml));
    if (hintHtml) wrap.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin-bottom:.3rem' }, hintHtml));
    var line = el('div', { style: 'display:flex;align-items:center;gap:.5rem;flex-wrap:wrap' });
    var useDflt = el('input'); useDflt.type = 'checkbox';
    var inp = el('input', { class: 'input', style: 'width:6rem', type: 'number', min: '0', step: '1' });
    var inheriting = (mineVal === null || mineVal === undefined);
    useDflt.checked = inheriting;
    inp.value = String(inheriting ? companyVal : mineVal);
    inp.disabled = inheriting;
    useDflt.addEventListener('change', function () {
      inp.disabled = useDflt.checked;
      if (useDflt.checked) inp.value = String(companyVal);
    });
    var l = el('label', { style: 'display:flex;align-items:center;gap:.35rem;cursor:pointer' });
    l.appendChild(useDflt);
    l.appendChild(el('span', { class: 'muted' }, 'Use company default (' + esc(companyVal) + ')'));
    line.appendChild(inp);
    line.appendChild(l);
    wrap.appendChild(line);
    wrap._get = function () { return useDflt.checked ? null : String(Number(inp.value) || 0); };
    return wrap;
  }

  /**
   * DIRECTION_SETS_v1 — a multi-select checkbox group over in / missed / out,
   * plus a "None of them" box that clears the lot.
   *
   * `mineCsv` is the rep's own value: null = inherit the company default,
   * '' = an explicit NONE (which is NOT the same as inherit).
   */
  function dirGroup(titleHtml, hintHtml, mineCsv, effectiveArr) {
    var OPTS = [
      ['in',     'All Incoming calls'],
      ['missed', 'All Missed calls'],
      ['out',    'All Outgoing calls']
    ];
    // EFFECTIVE_RENDER_FIX_v1 (2026-07-12) — tick the boxes from the EFFECTIVE value
    // the server will actually act on, NOT the company default. They differ whenever a
    // legacy autolead_inbound/outbound flag is bridging: the boxes said "None of them"
    // while the server was busy creating leads on every call. Never show a state the
    // server does not hold.
    var inheriting = (mineCsv === null || mineCsv === undefined);
    var current = inheriting
      ? (effectiveArr || []).slice()
      : String(mineCsv).split(',').map(function (x) { return x.trim(); }).filter(Boolean);

    var wrap = el('div', { style: 'margin:.2rem 0 .4rem' });
    wrap.appendChild(el('div', { style: 'font-weight:600;margin-bottom:.15rem' }, titleHtml));
    if (hintHtml) wrap.appendChild(el('div', { class: 'muted', style: 'font-size:.82rem;margin-bottom:.5rem;line-height:1.5' }, hintHtml));

    var box = el('div', { style: 'display:flex;flex-direction:column;gap:.35rem' });
    var boxes = [];
    OPTS.forEach(function (o) {
      var cb = el('input'); cb.type = 'checkbox';
      cb.checked = current.indexOf(o[0]) >= 0;
      cb.setAttribute('data-dir', o[0]);
      boxes.push(cb);
      var lab = el('label', { style: 'display:flex;align-items:center;gap:.55rem;cursor:pointer;font-size:.92rem' });
      lab.appendChild(cb);
      lab.appendChild(el('span', {}, o[1]));
      box.appendChild(lab);
    });

    var noneCb = el('input'); noneCb.type = 'checkbox';
    noneCb.checked = current.length === 0;
    var noneLab = el('label', { style: 'display:flex;align-items:center;gap:.55rem;cursor:pointer;font-size:.92rem;padding-top:.3rem;margin-top:.2rem;border-top:1px dashed #e2e8f0' });
    noneLab.appendChild(noneCb);
    noneLab.appendChild(el('span', {}, '<b>None of them</b>'));
    box.appendChild(noneLab);
    wrap.appendChild(box);

    var inheritNote = el('div', { class: 'muted', style: 'font-size:.78rem;margin-top:.35rem' },
      inheriting ? '↳ Following the company default. Tick or untick anything to set your own.' : '');
    wrap.appendChild(inheritNote);

    var touched = !inheriting;
    function sync(fromNone) {
      if (fromNone && noneCb.checked) boxes.forEach(function (b) { b.checked = false; });
      var any = boxes.some(function (b) { return b.checked; });
      if (any) noneCb.checked = false;
      else noneCb.checked = true;
      touched = true;
      inheritNote.textContent = '';
      if (wrap._onchange) wrap._onchange();
    }
    boxes.forEach(function (b) { b.addEventListener('change', function () { sync(false); }); });
    noneCb.addEventListener('change', function () { sync(true); });

    wrap._picked = function () {
      return boxes.filter(function (b) { return b.checked; })
                  .map(function (b) { return b.getAttribute('data-dir'); });
    };
    // null = still inheriting (untouched). Otherwise a CSV — '' meaning NONE.
    wrap._get = function () { return touched ? wrap._picked().join(',') : null; };
    return wrap;
  }

  // ---- main panel ---------------------------------------------------------
  var _targetUserId = 0;   // whose settings the admin is editing (0 = me)

  async function render(body, opts) {
    opts = opts || {};
    var compact = !!opts.compact;   // Dialer > Settings on the phone: just my own stuff
    body.innerHTML = '<div class="loading">Loading…</div>';

    var uid = _targetUserId || myId();
    var data, statuses = [], users = [];
    try {
      data = await api('api_userCallPrefs_get', uid);
    } catch (e) {
      body.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
      return;
    }
    try { statuses = await api('api_statuses_list') || []; } catch (e) { statuses = []; }
    if (isAdmin()) { try { users = await api('api_users_list') || []; } catch (e) { users = []; } }

    var mine = data.mine || {};
    var co   = data.company || {};
    var editingSelf = (Number(data.user_id) === myId());

    body.innerHTML = '';
    var wrap = el('div', { class: 'admin-section' });
    wrap.appendChild(el('h2', { style: 'margin-top:0' }, '📱 Calls &amp; Mobile'));
    wrap.appendChild(el('div', { class: 'muted', style: 'margin-bottom:1rem' },
      'Every call setting in one place. <b>These are your own settings</b> — each rep has their own phone ' +
      'and their own way of working, so they are per user, not per company. ' +
      'Anything you leave on <i>“Use company default”</i> follows whatever the admin has set.'));
    body.appendChild(wrap);

    // ---- admin: whose settings am I editing? ----
    if (isAdmin() && users.length && !compact) {
      var pick = card('👤 Whose settings?', 'As an admin you can set these up on behalf of any rep.');
      var us = el('select', { class: 'input', style: 'max-width:22rem' });
      users.forEach(function (u) {
        var o = el('option', { value: String(u.id) },
          esc(u.name) + (Number(u.id) === myId() ? ' (me)' : '') + ' — ' + esc(u.role || ''));
        if (Number(u.id) === Number(data.user_id)) o.setAttribute('selected', 'selected');
        us.appendChild(o);
      });
      us.addEventListener('change', function () {
        _targetUserId = Number(us.value) || 0;
        render(body);
      });
      pick.appendChild(us);
      wrap.appendChild(pick);
    }

    // ============ 1. THE PHONE (device-only) ============
    var c1 = card('📶 This phone — SIM &amp; sync',
      'Which SIM(s) to copy calls from. This lives on the phone itself, so it has to be set in the mobile app.');

    if (!editingSelf) {
      c1.appendChild(el('div', { class: 'muted', style: 'padding:.6rem;background:#f8fafc;border-radius:8px' },
        'ℹ️ SIM choice can only be set on the rep’s own phone — the CRM can’t see another device’s SIM slots. ' +
        'Ask them to open <b>Settings → Calls &amp; Mobile</b> in the app. Everything below you <i>can</i> set for them.'));
    } else if (!inApp()) {
      c1.appendChild(el('div', { class: 'muted', style: 'padding:.6rem;background:#f8fafc;border-radius:8px' },
        'ℹ️ Open the CRM in the <b>mobile app</b> to pick your SIM and sync calls. These are phone settings, ' +
        'so they can’t be set from a desktop browser.'));
    } else {
      var sims = getSims();
      if (!sims.length) {
        c1.appendChild(el('div', { class: 'muted' }, 'Couldn’t read your SIM cards — check the app has the Phone permission.'));
      } else {
        c1.appendChild(el('div', { style: 'font-weight:600;margin-bottom:.3rem' }, 'Copy calls from:'));
        var saved = String(mine.sim_slots == null ? '' : mine.sim_slots)
                      .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        var boxes = [];
        sims.forEach(function (s) {
          var slot = String(s.slot);
          var cb = el('input'); cb.type = 'checkbox';
          cb.checked = (saved.length === 0) || (saved.indexOf(slot) >= 0);   // empty = all
          cb.setAttribute('data-slot', slot);
          boxes.push(cb);
          var lab = el('label', { style: 'display:flex;align-items:center;gap:.6rem;margin:.4rem 0;cursor:pointer' });
          lab.appendChild(cb);
          lab.appendChild(el('span', {}, 'SIM ' + (Number(s.slot) + 1) +
            (s.carrier ? ' · <span class="muted">' + esc(s.carrier) + '</span>' : '')));
          c1.appendChild(lab);
        });
        var persistSims = async function () {
          var picked = boxes.filter(function (b) { return b.checked; })
                            .map(function (b) { return b.getAttribute('data-slot'); });
          if (!picked.length) {
            toast('Pick at least one SIM, or nothing will sync.', 'warn');
            boxes.forEach(function (b) { b.checked = true; });
            picked = boxes.map(function (b) { return b.getAttribute('data-slot'); });
          }
          // All ticked = no filter (store '') so a SIM added later still syncs.
          var csv = (picked.length === boxes.length) ? '' : picked.join(',');
          setDeviceSims(csv);                                   // the phone enforces it
          try { await api('api_userCallPrefs_save', { userId: data.user_id, patch: { sim_slots: csv } }); } catch (e) {}
          toast('✅ SIM preference saved', 'ok');
        };
        boxes.forEach(function (b) { b.addEventListener('change', persistSims); });
      }
    }
    wrap.appendChild(c1);

    // ============ 2 + 3. THE TWO QUESTIONS THAT ACTUALLY MATTER ============
    // DIRECTION_SETS_v1 (2026-07-12) — replaces six dropdowns with two checkbox
    // groups. People think "which calls do I want to see" and "which calls should
    // become leads" — not "sync_lead_only" vs "autolead_inbound".
    var summary = el('div', { style: 'padding:.7rem .9rem;border-radius:10px;background:#eef2ff;border-left:4px solid #4f46e5;margin-bottom:1rem;font-size:.9rem;line-height:1.6' });
    wrap.appendChild(summary);

    var eff = data.effective || {};

    var c2 = card('📋 Show in Call Activity',
      'Which calls from your phone are copied into the CRM. Tick what you want to see.');
    var fShow = dirGroup('', '', mine.sync_directions, eff.sync_directions);
    c2.appendChild(fShow);

    // The 4th filter people actually ask for: only calls to/from numbers already in the CRM.
    var loCb = el('input'); loCb.type = 'checkbox';
    loCb.checked = !!eff.sync_lead_only;
    var loLab = el('label', { style: 'display:flex;align-items:flex-start;gap:.55rem;cursor:pointer;font-size:.92rem;margin-top:.7rem;padding-top:.6rem;border-top:1px solid #e2e8f0' });
    loLab.appendChild(loCb);
    var loTxt = el('div', {});
    loTxt.appendChild(el('div', { style: 'font-weight:600' }, 'Only calls that match a lead in the CRM'));
    loTxt.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;line-height:1.5' },
      'An extra filter on top of the ticks above. When ON, calls from numbers that are <b>not</b> a CRM lead ' +
      'are discarded and never appear in Call Activity — a good way to keep personal calls out. ' +
      'When OFF, every call you ticked above is saved.'));
    loLab.appendChild(loTxt);
    c2.appendChild(loLab);
    wrap.appendChild(c2);

    var c3 = card('➕ Create auto lead',
      'Which calls from <b>numbers not yet in the CRM</b> should automatically become a lead. ' +
      'This is separate — a call can show in Call Activity without becoming a lead.');
    var fLead = dirGroup('', '', mine.autolead_directions, eff.autolead_directions);
    c3.appendChild(fLead);

    // The lead-creation detail knobs only mean anything when at least one box is ticked.
    var adv = el('div', { style: 'border-top:1px dashed #cbd5e1;margin-top:.9rem;padding-top:.7rem' });
    var fMode = selectRow('How should the lead be created?', mine.autolead_mode, co.autolead_mode,
      [['auto', 'Create it automatically, no popup'], ['manual', 'Ask me first (review in Pending Call Queue)']]);
    adv.appendChild(fMode);
    var fMin = numberRow('Ignore calls shorter than (seconds)', mine.autolead_min_seconds, co.autolead_min_seconds,
      'Stops one-ring wrong numbers and spam becoming leads. 0 = create even for a missed call.');
    adv.appendChild(fMin);
    var stOpts = [['0', 'Default (New)']].concat((statuses || []).map(function (st) {
      return [String(st.id), String(st.name || st.label || ('#' + st.id))];
    }));
    var fStatus = selectRow('Which status should these new leads get?', mine.autolead_status_id, String(co.autolead_status_id || '0'), stOpts);
    adv.appendChild(fStatus);
    var fDup = selectRow('If that number is already a lead', mine.autolead_on_duplicate, co.autolead_on_duplicate,
      [['attach', 'Attach the call to the existing lead (recommended)'],
       ['skip',   'Do nothing'],
       ['new',    'Create a second lead anyway']]);
    adv.appendChild(fDup);
    c3.appendChild(adv);
    wrap.appendChild(c3);

    // ============ 4. ADVANCED (rarely touched) ============
    var c4 = card('⚙️ Advanced', 'You almost never need these.');
    var fAutoSync = triState('Sync my call log every time I open the app',
      mine.autosync_on_open, co.autosync_on_open,
      'Off means nothing is copied from your phone unless you press Sync yourself.');
    c4.appendChild(fAutoSync);
    // (sync_lead_only now lives as a checkbox in "Show in Call Activity" — one control,
    //  one setting. Two controls for one policy is how settings drift apart.)
    var fCapLO = triState('Same rule for calls captured live', mine.capture_lead_only, co.capture_lead_only);
    c4.appendChild(fCapLO);
    var fActLO = triState('Open the Call Activity page with unknown numbers hidden',
      mine.activity_lead_only, co.activity_lead_only, 'A view filter only. Nothing is deleted.');
    c4.appendChild(fActLO);
    wrap.appendChild(c4);

    // ---- live plain-English summary + show/hide the lead detail knobs ----
    var NAME = { in: 'incoming', missed: 'missed', out: 'outgoing' };
    function list(arr) {
      if (!arr.length) return 'nothing';
      var n = arr.map(function (d) { return NAME[d]; });
      return n.length === 1 ? n[0] : (n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]);
    }
    function refresh() {
      var show = fShow._picked();
      var lead = fLead._picked();
      adv.style.display = lead.length ? '' : 'none';

      summary.innerHTML =
        '<b>What these settings do right now</b><br>' +
        '📋 Call Activity will show your <b>' + list(show) + '</b> calls' +
        (loCb.checked ? ', but <b>only from numbers already in the CRM</b>.' : ' — from any number.') +
        (show.length ? '' : ' <span style="color:#b45309">Nothing will be saved.</span>') +
        '<br>➕ ' + (lead.length
          ? 'A lead <b>is</b> created automatically for unknown numbers on <b>' + list(lead) + '</b> calls.'
          : '<b>No leads</b> are created automatically from calls.');
    }
    loCb.addEventListener('change', refresh);
    fShow._onchange = refresh;
    fLead._onchange = refresh;
    refresh();

    // ---- save ----
    var saveBtn = el('button', { class: 'btn primary' },
      '💾 Save ' + (editingSelf ? 'my settings' : 'this rep’s settings'));
    saveBtn.onclick = async function () {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
      try {
        await api('api_userCallPrefs_save', {
          userId: data.user_id,
          patch: {
            // DIRECTION_SETS_v1 — the two checkbox groups.
            sync_directions:       fShow._get(),
            autolead_directions:   fLead._get(),
            autosync_on_open:      fAutoSync._get(),
            sync_lead_only:        loCb.checked ? '1' : '0',
            capture_lead_only:     fCapLO._get(),
            activity_lead_only:    fActLO._get(),
            autolead_mode:         fMode._get(),
            autolead_min_seconds:  fMin._get(),
            autolead_status_id:    fStatus._get(),
            autolead_on_duplicate: fDup._get()
          }
        });
        // keep the phone's local auto-sync flag in step with the saved value
        if (editingSelf) {
          var v = fAutoSync._get();
          var eff = (v === null) ? !!co.autosync_on_open : (v === '1');
          try { localStorage.setItem('cls_auto_enabled_' + (slug() || 'x'), eff ? '1' : '0'); } catch (e) {}
        }
        toast('✅ Saved', 'ok');
        render(body, opts);
      } catch (e) {
        toast('Could not save: ' + e.message, 'err');
        saveBtn.disabled = false;
      }
    };
    wrap.appendChild(saveBtn);

    // ---- sync now (own phone only) ----
    if (editingSelf && inApp()) {
      var syncCard = card('🔄 Sync now', 'Last synced: <b>' + esc(lastSyncText()) + '</b>');
      var btnRow = el('div', { style: 'display:flex;gap:.4rem;flex-wrap:wrap' });
      [['Today', 1], ['Last 7 days', 7], ['Last 30 days', 30]].forEach(function (p) {
        var b = el('button', { class: 'btn sm' }, '🔄 ' + p[0]);
        b.onclick = function () {
          if (!hasNative()) { toast('Call sync only works inside the mobile app.', 'warn'); return; }
          try { window.CRM_syncCallsNow(p[1]); } catch (e) { toast('Sync failed: ' + e.message, 'err'); }
        };
        btnRow.appendChild(b);
      });
      syncCard.appendChild(btnRow);
      wrap.appendChild(syncCard);
    }

    // ============ 4. COMPANY DEFAULTS (admin only, desktop) ============
    if (!isAdmin() || compact) return;

    var c4 = card('🏢 Company defaults',
      'What applies to any rep who hasn’t chosen for themselves — and to everyone who joins later. ' +
      'Changing this does NOT override a rep who has already made their own choice.');

    var dAuto = el('select', { class: 'input', style: 'max-width:22rem' });
    var dSync = el('select', { class: 'input', style: 'max-width:22rem' });
    var dIn   = el('select', { class: 'input', style: 'max-width:22rem' });
    var dOut  = el('select', { class: 'input', style: 'max-width:22rem' });
    function yn(sel, val) {
      sel.appendChild(el('option', { value: '1' }, 'Yes'));
      sel.appendChild(el('option', { value: '0' }, 'No'));
      sel.value = val ? '1' : '0';
    }
    yn(dAuto, co.autosync_on_open);
    yn(dSync, co.sync_lead_only);
    yn(dIn,   co.autolead_inbound);
    yn(dOut,  co.autolead_outbound);

    [['Auto-sync the call log on app open', dAuto],
     ['Only sync calls that match a lead',  dSync],
     ['Auto-add leads from incoming/missed unknown numbers', dIn],
     ['Auto-add leads from outgoing unknown numbers',        dOut]
    ].forEach(function (p) {
      var w = el('div', { style: 'margin:.6rem 0' });
      w.appendChild(el('div', { style: 'font-weight:600;margin-bottom:.15rem' }, p[0]));
      w.appendChild(p[1]);
      c4.appendChild(w);
    });

    var saveCo = el('button', { class: 'btn', style: 'margin-top:.5rem' }, '🏢 Save company defaults');
    saveCo.onclick = async function () {
      saveCo.disabled = true; saveCo.textContent = 'Saving…';
      try {
        await api('api_admin_setConfig', {
          CALLS_AUTOSYNC_ON_OPEN:  dAuto.value,
          CALLS_SYNC_LEAD_ONLY:    dSync.value,
          CALLS_AUTOLEAD_INBOUND:  dIn.value,
          CALLS_AUTOLEAD_OUTBOUND: dOut.value
        });
        toast('✅ Company defaults saved', 'ok');
        render(body);
      } catch (e) {
        toast('Could not save: ' + e.message, 'err');
        saveCo.disabled = false; saveCo.textContent = '🏢 Save company defaults';
      }
    };
    c4.appendChild(saveCo);
    wrap.appendChild(c4);
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
      'auto create lead incoming outgoing missed call capture phone android per user');
    btn.textContent = '📱 Calls & Mobile';
    btn.onclick = function () { openTab(); };

    var group = document.createElement('div');
    group.className = 'admin-settings-group';
    var title = document.createElement('div');
    title.className = 'admin-settings-group-title';
    title.textContent = 'Calls & Mobile';
    group.appendChild(title);
    group.appendChild(btn);
    rail.parentElement.insertBefore(group, rail);
  }

  function openTab() {
    var body = document.getElementById('admin-body');
    if (!body) return;
    _targetUserId = 0;
    document.querySelectorAll('.subtab,.admin-settings-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === TAB_ID);
    });
    render(body).catch(function (e) {
      body.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    });
  }

  // ---- Dialer > ⚙️ Settings (the phone) -------------------------------------
  // This is where reps actually look for phone settings — the Dialer already owns
  // the caller-card and recording toggles, so SIM choice / call sync / auto-add-lead
  // belong next to them, not buried in the desktop Settings screen.
  function injectDialerSettings() {
    if (String(location.hash).indexOf('dialer') < 0) return;
    var host = document.querySelector('.dialer-settings');
    if (!host) return;                                   // not on the ⚙️ tab
    if (host.querySelector('#cs-dialer-card')) return;   // already injected

    var box = document.createElement('div');
    box.id = 'cs-dialer-card';
    box.className = 'settings-card';
    box.style.cssText = 'border-left:4px solid #4f46e5';
    box.innerHTML = '<div style="font-weight:700;margin-bottom:.15rem">📱 Calls, SIM &amp; CRM sync</div>' +
      '<div class="muted" style="font-size:.82rem;margin-bottom:.6rem">' +
      'Which SIM to copy calls from, and whether unknown numbers become leads. These are ' +
      '<b>your own</b> settings — they don\'t affect anyone else.</div>';
    var inner = document.createElement('div');
    box.appendChild(inner);
    host.appendChild(box);

    render(inner, { compact: true }).catch(function (e) {
      inner.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
    });
  }

  // ---- SIM filter on Call Activity -----------------------------------------
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
    // (Even with zero SIM-tagged rows we still render the chips — that is precisely
    //  the case where the user needs to see that everything on screen is a ghost.)

    var box = document.createElement('span');
    box.id = 'cs-sim-filter';
    box.style.cssText = 'display:inline-flex;gap:.3rem;align-items:center;margin-left:.4rem';
    var lab = document.createElement('span');
    lab.className = 'muted'; lab.textContent = 'SIM';
    box.appendChild(lab);

    // SIM_ONLY_DEFAULT_v2 (2026-07-13) — the SIM-only default is now OFF. Read this
    // before you ever turn it back on.
    //
    // v1 defaulted this view to "On SIM", on measured evidence that 349/349 call-log
    // rows carried a SIM and 0/151 live-receiver rows did — so "has a SIM" looked like
    // an exact proxy for "a real call from the phone".
    //
    // THAT PREMISE IS FALSE. The SIM slot is read from CallLog.PHONE_ACCOUNT_ID, which
    // needs the PHONE permission (READ_PHONE_STATE) — separate from the CALL LOG
    // permission. Grant Call Log but not Phone, and you get perfectly real call-log rows
    // with sim = null. Neetu (vserve, 2026-07-13) did exactly that: 14 genuine calls,
    // correct numbers, matched to leads — every one of them hidden by this filter. The
    // KPI count (server-side) said 14 while the table (client-filtered) showed nothing.
    // "Count showing, data not showing" is the signature of this bug.
    //
    // It is also REDUNDANT: reports.js already restricts Call Activity to
    // src IN ('calllog','calllog-fix') (CALLLOG_ONLY_v1), so live-receiver rows cannot
    // reach this table at all. The filter it was written to apply is applied upstream.
    //
    // The chips stay for manual SIM 1 / SIM 2 filtering. The DEFAULT is now All.
    // The storage key is bumped so reps who already have 'sim' saved are reset — a
    // default change alone would not have reached them.
    var MODES = [
      ['sim',  'On SIM'],     // any SIM  -> the real calls
      ['',     'All']         // everything, incl. rows with no SIM
    ].concat(keys.map(function (k) { return [k, 'SIM ' + (Number(k) + 1)]; }));

    var hint = document.createElement('span');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:.78rem;margin-left:.35rem';

    function apply(mode) {
      var hidden = 0, shown = 0;
      tbl.querySelectorAll('tbody tr').forEach(function (tr) {
        var sim = tr.getAttribute('data-sim');
        var ok;
        if (mode === 'sim')      ok = (sim !== '' && sim !== null);
        else if (mode === '')    ok = true;
        else                     ok = (sim === mode);
        tr.style.display = ok ? '' : 'none';
        if (ok) shown++; else hidden++;
      });
      hint.textContent = (mode === 'sim' && hidden)
        ? '(' + hidden + ' hidden — no SIM recorded. Grant the Phone permission on the rep\'s handset to capture SIM.)'
        : '';
      try { localStorage.setItem('ca_sim_mode_v2', mode); } catch (e) {}
    }

    var saved = '';   // SIM_ONLY_DEFAULT_v2 — default is All
    try { var v = localStorage.getItem('ca_sim_mode_v2'); if (v !== null) saved = v; } catch (e) {}
    if (!MODES.some(function (m) { return m[0] === saved; })) saved = '';

    var btns = [];
    MODES.forEach(function (o) {
      var b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = o[1];
      if (o[0] === 'sim') b.title = 'Only calls that really happened on your phone (they carry a SIM). Hides ghost rows from the live receiver.';
      b.onclick = function () {
        btns.forEach(function (x) { x.classList.toggle('primary', x === b); });
        apply(o[0]);
      };
      if (o[0] === saved) b.classList.add('primary');
      btns.push(b);
      box.appendChild(b);
    });
    box.appendChild(hint);
    bar.appendChild(box);
    apply(saved);
  }

  // ---- boot ---------------------------------------------------------------
  var mo = new MutationObserver(function () {
    try { injectTab(); injectSimFilter(); injectDialerSettings(); } catch (e) {}
  });
  function start() {
    try { mo.observe(document.getElementById('app') || document.body, { childList: true, subtree: true }); } catch (e) {}
    window.addEventListener('hashchange', function () {
      setTimeout(function () { try { injectTab(); injectSimFilter(); injectDialerSettings(); } catch (e) {} }, 250);
    });
    setTimeout(function () { try { injectTab(); injectSimFilter(); injectDialerSettings(); } catch (e) {} }, 900);
    try { window.CRM_openCallSettings = openTab; } catch (e) {}
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
