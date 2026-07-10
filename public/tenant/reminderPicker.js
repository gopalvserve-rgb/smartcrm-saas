/* ======================================================================
 * REMINDER_FLOWS_v1 — Rep-side flow picker (2026-07-05)
 * ----------------------------------------------------------------------
 * Standalone add-on: attaches to the existing "Next follow-up" input in
 * the Lead Edit modal and adds a "🔔 Reminders" dropdown so the rep can
 * opt into a reminder flow when they set a follow-up.
 *
 * Zero changes to app.js. Uses MutationObserver to detect when the lead
 * modal opens, then finds the datetime-local input for next_followup_at
 * and injects a sibling <select> element right after it.
 *
 * On save, if the rep picked a flow, we intercept the save and call
 * api_leads_setFollowup (atomic) BEFORE the normal api_leads_update
 * runs, so the reminders get scheduled + the follow-up is stored.
 *
 * The regular Save button still runs its normal update — that will just
 * see next_followup_at is already what we set, so no double-write.
 * ====================================================================== */
(function () {
  'use strict';
  if (window.REMINDER_PICKER_v1) return;
  window.REMINDER_PICKER_v1 = { version: '1.0' };

  function _slug() { try { var m = location.pathname.match(/\/t\/([^\/]+)/); return m ? m[1] : ''; } catch (e) { return ''; } }
  function _tok() { var s = _slug(); try { return (s && localStorage.getItem('crm_token_' + s)) || localStorage.getItem('crm_token') || ''; } catch (e) { return ''; } }
  async function _api(name, payload) {
    if (window.api && typeof window.api === 'function') return await window.api(name, payload || {});
    var r = await fetch('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Auth-Token': _tok() },
      body: JSON.stringify({ fn: name, args: [_tok(), payload || {}] }) });
    var j = await r.json();
    if (j && j.error) throw new Error(j.error);
    return j.result !== undefined ? j.result : j;
  }
  function toast(msg, kind) {
    if (window.toast && typeof window.toast === 'function') return window.toast(msg, kind);
    var div = document.createElement('div');
    div.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;background:' +
      (kind === 'err' ? '#dc2626' : '#15803d') + ';color:#fff;border-radius:8px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:13.5px';
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(function () { div.remove(); }, 3200);
  }

  var FLOW_CACHE = null;
  var FLOW_CACHE_AT = 0;
  async function _loadFlows() {
    // Cache flows for 60s to avoid hammering the API on every modal open
    if (FLOW_CACHE && (Date.now() - FLOW_CACHE_AT) < 60000) return FLOW_CACHE;
    try {
      var d = await _api('api_reminderFlows_list');
      FLOW_CACHE = (d.items || []).filter(function (f) { return Number(f.is_active); });
      FLOW_CACHE_AT = Date.now();
      return FLOW_CACHE;
    } catch (_) { return []; }
  }

  /* ── Locate the "Next follow-up" input in the lead modal ── */
  function _findFollowupInput(root) {
    root = root || document;
    // Try known IDs first
    var el = root.querySelector('#lead-next-followup, #lead-followup, #next-followup, [name="next_followup_at"]');
    if (el) return el;
    // Fall back: find every datetime-local input and pick the one whose surrounding label mentions "follow"
    var inputs = root.querySelectorAll('input[type="datetime-local"]');
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      var container = inp.closest('div,label,tr,li') || inp.parentElement;
      var text = container ? container.textContent.toLowerCase() : '';
      if (text.indexOf('follow') >= 0) return inp;
    }
    return null;
  }

  /* ── Find the lead ID the modal is editing (best-effort) ── */
  function _findLeadId(scope) {
    scope = scope || document;
    // Try hidden input
    var hid = scope.querySelector('[name="id"], #lead-id, [data-lead-id]');
    if (hid && (hid.value || hid.dataset.leadId)) return Number(hid.value || hid.dataset.leadId);
    // Try modal data-attr
    var modal = scope.querySelector('.lead-modal, .modal-backdrop, [data-lead-id]');
    if (modal && modal.dataset.leadId) return Number(modal.dataset.leadId);
    // Try URL hash
    var m = location.hash.match(/id=(\d+)/);
    if (m) return Number(m[1]);
    // Try global
    if (window.CRM && CRM.currentLeadId) return Number(CRM.currentLeadId);
    return null;
  }

  /* ── Inject the picker sibling below the follow-up input ── */
  async function _inject(input) {
    if (input.dataset.rpInjected === '1') return;
    input.dataset.rpInjected = '1';

    var flows = await _loadFlows();
    if (!flows.length) return; // no flows to pick from

    // Wrap element that sits directly below the input
    var wrap = document.createElement('div');
    wrap.className = 'rp-wrap';
    wrap.style.cssText = 'margin-top:.4rem;padding:.5rem .65rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;font-size:.85rem';
    wrap.innerHTML =
      '<label style="display:flex;align-items:center;gap:.4rem;font-weight:600;color:#1e40af;margin-bottom:.35rem">' +
        '🔔 Reminders <span style="font-weight:400;color:#64748b;font-size:.75rem">(optional — auto-nudge before follow-up)</span>' +
      '</label>' +
      '<select data-rp-flow="1" style="width:100%;padding:.35rem .5rem;border:1px solid #cbd5e1;border-radius:5px;background:#fff;font-family:inherit">' +
        '<option value="">— None —</option>' +
        flows.map(function (f) {
          var rungs = (f.rungs || []).map(function (r) {
            var m = Math.abs(r.offset_minutes);
            return r.offset_minutes === 0 ? 'at time' :
                   m >= 60 ? Math.round(m / 60) + 'h' : m + 'm';
          }).join(' + ');
          var chan = [Number(f.channel_wa) ? 'WA' : '', Number(f.channel_email) ? 'Email' : ''].filter(Boolean).join('+');
          /* REMINDER_PICKER_NONE_DEFAULT_v1 (2026-07-09) — do NOT auto-select
           * the tenant's default flow. Default is '— None —' across all
           * tenants. Only pre-select if the lead ALREADY had this flow
           * attached (rep picked it before), which the caller signals via
           * data-rp-existing-flow-id on the input. */
          var _existing = Number(input.dataset.rpExistingFlowId || 0);
          var _selected = (_existing && Number(f.id) === _existing);
          var label = f.name + (rungs ? '  (' + rungs + ' · ' + chan + ')' : '') + (Number(f.is_default) ? '  ★ default' : '');
          return '<option value="' + f.id + '"' + (_selected ? ' selected' : '') + '>' + label + '</option>';
        }).join('') +
      '</select>' +
      '<div data-rp-preview="1" style="font-size:.75rem;color:#1e40af;margin-top:.35rem"></div>';

    // Insert directly after the input
    var parent = input.parentElement;
    if (input.nextSibling) parent.insertBefore(wrap, input.nextSibling);
    else parent.appendChild(wrap);

    var sel = wrap.querySelector('[data-rp-flow]');
    var preview = wrap.querySelector('[data-rp-preview]');

    function updatePreview() {
      var fid = Number(sel.value);
      if (!fid) { preview.textContent = ''; return; }
      var f = flows.find(function (x) { return Number(x.id) === fid; });
      if (!f) return;
      var recipients = [Number(f.send_to_lead) ? 'Lead' : '', Number(f.send_to_owner) ? 'Owner' : ''].filter(Boolean).join(' & ');
      var rungs = (f.rungs || []).map(function (r) {
        var m = Math.abs(r.offset_minutes);
        return r.offset_minutes === 0 ? 'at time' : m >= 60 ? Math.round(m / 60) + 'h before' : m + 'm before';
      }).join(', ');
      preview.textContent = 'Will fire: ' + rungs + ' → to ' + recipients;
    }
    sel.onchange = updatePreview;
    updatePreview();

    // Store the picked flow ID on the input so the Save interceptor can read it
    sel.addEventListener('change', function () {
      input.dataset.rpFlowId = sel.value || '';
    });
    input.dataset.rpFlowId = sel.value || '';
  }

  /* ── Save interceptor. When user hits Save inside the lead modal AND
   *    they picked a reminder flow, we call api_leads_setFollowup(atomic)
   *    right after the normal update. That schedules reminders + writes
   *    the audit remark. ── */
  function _interceptSave(input) {
    // Find the Save button in the same modal
    var modal = input.closest('.modal-backdrop, .modal, .lead-modal, form') || input.parentElement;
    if (!modal) return;
    var saveBtn = modal.querySelector('button.primary, button[type="submit"], .btn.primary');
    if (!saveBtn || saveBtn.dataset.rpBound === '1') return;
    saveBtn.dataset.rpBound = '1';

    // Capture-phase click listener so we run AFTER app.js finishes its own save
    saveBtn.addEventListener('click', function () {
      setTimeout(async function () {
        try {
          var fid = Number(input.dataset.rpFlowId || 0);
          if (!fid) return;   // no flow picked → nothing to schedule
          var leadId = _findLeadId(modal);
          if (!leadId) return;
          var followupAt = input.value;
          if (!followupAt) return;
          var r = await _api('api_leads_setFollowup', {
            lead_id:          leadId,
            followup_at:      new Date(followupAt).toISOString(),
            reminder_flow_id: fid
          });
          if (r && r.scheduled > 0) {
            toast('🔔 ' + r.scheduled + ' reminder' + (r.scheduled > 1 ? 's' : '') + ' queued');
          } else if (r && r.skipped_past > 0) {
            toast('⚠ Follow-up time is in the past — no reminders scheduled', 'err');
          }
        } catch (e) {
          console.warn('[reminderPicker] setFollowup failed:', e.message);
        }
      }, 800);   // wait for the app.js api_leads_update to complete
    }, true);   // capture phase so we run before bubble handlers block us
  }

  /* ── Watcher: whenever a follow-up input appears in the DOM, wire it ── */
  var _observer = null;
  function _scan() {
    var input = _findFollowupInput();
    if (!input) return;
    _inject(input).catch(function (e) { console.warn('[reminderPicker] inject failed:', e.message); });
    _interceptSave(input);
  }
  function _startWatching() {
    if (_observer) return;
    _scan();
    _observer = new MutationObserver(function () { _scan(); });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  function _ready(fn) {
    if (window.api) return fn();
    setTimeout(function () { _ready(fn); }, 200);
  }
  _ready(function () {
    // Start the watcher after the first paint so we don't fight the SPA boot
    setTimeout(_startWatching, 1000);
  });
})();
