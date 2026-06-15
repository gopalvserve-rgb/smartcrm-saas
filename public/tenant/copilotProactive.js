/* COPILOT_v4 Proactive Coach — SPA bolt-on
 * Renders Morning Briefing card on Dashboard + injects Lead AI Summary
 * panel into Lead modal + 🔔 signal badge in topbar. Gated behind
 * brand.COPILOT_PROACTIVE_ENABLED='1' (vserve beta).
 */
(function(){
  'use strict';

  function _enabled() {
    try {
      const b = (window.CRM && window.CRM.brand) || {};
      return String(b.COPILOT_PROACTIVE_ENABLED || '') === '1';
    } catch { return false; }
  }

  async function _api(fn, args) {
    args = args || {};
    try {
      const token = localStorage.getItem('crm_token') || '';
      const path = (location.pathname.match(/^\/t\/[^\/]+/) || [''])[0] || '';
      const res = await fetch(path + '/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify({ fn, args: [args] })
      });
      const j = await res.json();
      return j.result || j;
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // ── Phase 1: Morning Briefing card ─────────────────────────────
  let _lastBriefingDate = null;
  let _briefingMounted = false;

  async function renderBriefing(force) {
    if (!_enabled()) return;
    // Find dashboard view container
    const view = document.querySelector('main, .view, #view, [data-view="dashboard"], #main, body > .container');
    if (!view) return;

    // Remove old card
    const old = document.getElementById('cp4-briefing-card');
    if (old) old.remove();

    // Insert card placeholder at top of dashboard
    const card = document.createElement('div');
    card.id = 'cp4-briefing-card';
    card.style.cssText = 'background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#fff;border-radius:16px;padding:18px 22px;margin:0 0 18px 0;box-shadow:0 4px 20px rgba(79,70,229,.25);position:relative';
    card.innerHTML = '<div style="font-size:.9rem;opacity:.85">🤖 Your Coach</div>'
      + '<div style="font-size:1.3rem;font-weight:700;margin-top:4px">Loading your plan…</div>';
    view.insertBefore(card, view.firstChild);
    _briefingMounted = true;

    const data = await _api('api_copilot_briefing', { force: !!force });
    if (!data || !data.ok) {
      card.innerHTML = '<div style="font-size:.9rem;opacity:.85">🤖 Your Coach</div>'
        + '<div style="font-size:1rem;margin-top:6px">Proactive Coach not enabled on this account.</div>';
      return;
    }

    let html = '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px">';
    html += '<div style="flex:1">';
    html += '<div style="font-size:.85rem;opacity:.85">' + _esc(data.greeting || 'Hello') + '</div>';
    html += '<div style="font-size:1.25rem;font-weight:700;margin-top:4px">' + _esc(data.headline) + '</div>';
    html += '</div>';
    html += '<button id="cp4-refresh" style="background:rgba(255,255,255,.2);border:0;color:#fff;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:.85rem">↻ Refresh</button>';
    html += '</div>';

    if (data.items && data.items.length) {
      html += '<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">';
      data.items.forEach(it => {
        const sev = it.severity === 3 ? '🔥' : it.severity === 2 ? '⏰' : '📌';
        const bg = it.severity === 3 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.10)';
        html += '<div data-cp4-item="' + (it.signal_id || '') + '" data-cp4-lead="' + (it.lead_id || '') + '" style="background:' + bg + ';border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer">';
        html += '<div style="flex:1;min-width:0">';
        html += '<div style="font-weight:600;font-size:.95rem">' + sev + ' ' + _esc(it.title) + '</div>';
        html += '<div style="font-size:.82rem;opacity:.88;margin-top:2px">' + _esc(it.reason || '') + '</div>';
        html += '</div>';
        html += '<button data-cp4-act="' + (it.signal_id || '') + '" data-cp4-leadid="' + (it.lead_id || '') + '" style="background:#fff;color:#4f46e5;border:0;padding:6px 14px;border-radius:8px;font-weight:600;cursor:pointer;font-size:.82rem;white-space:nowrap">' + _esc(it.action_label || 'Open') + '</button>';
        html += '</div>';
      });
      html += '</div>';
    } else {
      html += '<div style="margin-top:14px;padding:14px;background:rgba(255,255,255,.1);border-radius:10px;text-align:center;opacity:.85">✨ Nothing urgent right now. Take a breath.</div>';
    }
    card.innerHTML = html;

    // Wire actions
    card.querySelector('#cp4-refresh').onclick = () => renderBriefing(true);
    card.querySelectorAll('[data-cp4-act]').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const sigId = btn.getAttribute('data-cp4-act');
        const leadId = btn.getAttribute('data-cp4-leadid');
        if (sigId) _api('api_copilot_signal_act', { id: Number(sigId) });
        if (leadId && Number(leadId)) {
          location.hash = '#/leads/' + leadId;
        }
      };
    });
    card.querySelectorAll('[data-cp4-item]').forEach(row => {
      row.onclick = () => {
        const leadId = row.getAttribute('data-cp4-lead');
        const sigId = row.getAttribute('data-cp4-item');
        if (sigId) _api('api_copilot_signal_act', { id: Number(sigId) });
        if (leadId && Number(leadId)) location.hash = '#/leads/' + leadId;
      };
    });
  }

  // ── Phase 2: Lead AI Summary panel inside lead modal ────────────
  async function tryInjectLeadSummary(leadId) {
    if (!_enabled()) return;
    if (!leadId) return;
    // Wait briefly for lead modal to render
    let tries = 0;
    while (tries < 20) {
      const modal = document.querySelector('.modal-content, .lead-modal, [data-lead-id="' + leadId + '"], #lead-modal-body');
      if (modal) { _injectSummaryInto(modal, leadId); return; }
      await new Promise(r => setTimeout(r, 200));
      tries++;
    }
  }

  async function _injectSummaryInto(modal, leadId) {
    if (modal.querySelector('#cp4-lead-summary-' + leadId)) return; // dedup
    const panel = document.createElement('div');
    panel.id = 'cp4-lead-summary-' + leadId;
    panel.style.cssText = 'background:linear-gradient(135deg,#eff6ff 0%,#f3e8ff 100%);border:1px solid #c7d2fe;border-radius:12px;padding:14px 16px;margin:0 0 12px 0';
    panel.innerHTML = '<div style="font-size:.85rem;color:#4338ca;font-weight:600">🤖 AI Summary <span style="font-weight:400;color:#6366f1;font-size:.78rem">loading…</span></div>';
    modal.insertBefore(panel, modal.firstChild);

    const data = await _api('api_copilot_lead_summary', { lead_id: Number(leadId) });
    if (!data || !data.ok) { panel.remove(); return; }

    let html = '<div style="display:flex;justify-content:space-between;align-items:start;gap:8px">';
    html += '<div style="font-size:.85rem;color:#4338ca;font-weight:700">🤖 AI Summary</div>';
    html += '<button id="cp4-sum-refresh" style="background:transparent;border:1px solid #c7d2fe;color:#4338ca;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:.75rem">↻</button>';
    html += '</div>';
    html += '<div style="margin-top:8px;color:#1e1b4b;font-size:.92rem;line-height:1.45">' + _esc(data.summary || '') + '</div>';
    if (data.next_action) {
      html += '<div style="margin-top:10px;padding:8px 10px;background:#fff;border-radius:8px;border:1px solid #ddd6fe">';
      html += '<div style="font-size:.75rem;color:#7c3aed;font-weight:600;margin-bottom:3px">📅 SUGGESTED NEXT</div>';
      html += '<div style="font-size:.88rem;color:#1e1b4b">' + _esc(data.next_action) + '</div>';
      html += '</div>';
    }
    if (data.draft_msg) {
      html += '<div style="margin-top:8px;padding:8px 10px;background:#fff;border-radius:8px;border:1px dashed #c4b5fd;cursor:pointer" title="Tap to copy">';
      html += '<div style="font-size:.75rem;color:#7c3aed;font-weight:600;margin-bottom:3px">💬 DRAFT MESSAGE (tap to copy)</div>';
      html += '<div id="cp4-draft-text" style="font-size:.88rem;color:#1e1b4b;font-style:italic">' + _esc(data.draft_msg) + '</div>';
      html += '</div>';
    }
    panel.innerHTML = html;
    const ref = panel.querySelector('#cp4-sum-refresh');
    if (ref) ref.onclick = (e) => {
      e.stopPropagation();
      panel.remove();
      _api('api_copilot_lead_summary', { lead_id: Number(leadId), force: true }).then(() => _injectSummaryInto(modal, leadId));
    };
    const draft = panel.querySelector('#cp4-draft-text');
    if (draft && data.draft_msg) {
      draft.parentElement.onclick = () => {
        navigator.clipboard.writeText(data.draft_msg).then(() => {
          const orig = draft.textContent;
          draft.textContent = '✓ Copied!';
          setTimeout(() => { draft.textContent = orig; }, 1200);
        });
      };
    }
  }

  // ── Phase 3+4: Signal badge in topbar + chip rail ──────────────
  let _signalPoll = null;
  async function refreshSignals() {
    if (!_enabled()) return;
    const data = await _api('api_copilot_signals_list', { limit: 12 });
    if (!data || !data.ok) return;
    const count = (data.signals || []).length;
    _renderBadge(count, data.signals || []);
  }

  function _renderBadge(count, signals) {
    let badge = document.getElementById('cp4-signal-badge');
    if (!badge) {
      // Mount near top-right of page
      badge = document.createElement('div');
      badge.id = 'cp4-signal-badge';
      badge.style.cssText = 'position:fixed;top:14px;right:16px;z-index:9000;background:#fff;border-radius:24px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:6px 14px;cursor:pointer;font-size:.88rem;font-weight:600;display:none;align-items:center;gap:6px';
      document.body.appendChild(badge);
      badge.onclick = () => _toggleSignalSheet(signals);
    }
    if (count > 0) {
      badge.style.display = 'inline-flex';
      badge.innerHTML = '🔔 <span style="background:#dc2626;color:#fff;padding:1px 8px;border-radius:10px;font-size:.78rem">' + count + '</span>';
      badge._signals = signals;
    } else {
      badge.style.display = 'none';
    }
  }

  function _toggleSignalSheet(signals) {
    let sheet = document.getElementById('cp4-signal-sheet');
    if (sheet) { sheet.remove(); return; }
    sheet = document.createElement('div');
    sheet.id = 'cp4-signal-sheet';
    sheet.style.cssText = 'position:fixed;top:50px;right:16px;width:340px;max-height:70vh;overflow-y:auto;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:12px;z-index:9001';
    let html = '<div style="font-weight:700;color:#1e1b4b;margin-bottom:10px;display:flex;justify-content:space-between"><span>🔔 Signals</span><span style="cursor:pointer;color:#94a3b8" onclick="document.getElementById(\'cp4-signal-sheet\').remove()">✕</span></div>';
    if (!signals || !signals.length) {
      html += '<div style="color:#64748b;padding:14px;text-align:center">No active signals.</div>';
    } else {
      signals.forEach(s => {
        html += '<div data-cp4-sig="' + s.id + '" data-cp4-lead="' + (s.lead_id || '') + '" style="padding:10px;border-bottom:1px solid #f1f5f9;cursor:pointer">';
        html += '<div style="font-weight:600;color:#1e1b4b;font-size:.88rem">' + _esc(s.title || '') + '</div>';
        html += '<div style="color:#64748b;font-size:.78rem;margin-top:2px">' + _esc(s.reason || '') + '</div>';
        html += '</div>';
      });
    }
    sheet.innerHTML = html;
    document.body.appendChild(sheet);
    sheet.querySelectorAll('[data-cp4-sig]').forEach(row => {
      row.onclick = () => {
        const id = Number(row.getAttribute('data-cp4-sig'));
        const lid = Number(row.getAttribute('data-cp4-lead'));
        if (id) _api('api_copilot_signal_act', { id });
        if (lid) location.hash = '#/leads/' + lid;
        sheet.remove();
      };
    });
  }

  // ── Glue: hashchange triggers ──────────────────────────────────
  function _onHash() {
    if (!_enabled()) return;
    const h = location.hash || '';
    if (h === '' || h === '#/' || h === '#/dashboard') {
      setTimeout(() => renderBriefing(false), 400);
    }
    const m = h.match(/^#\/leads\/(\d+)/);
    if (m) {
      tryInjectLeadSummary(Number(m[1]));
    }
  }

  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // ── Init ────────────────────────────────────────────────────────
  function init() {
    if (!_enabled()) return;
    window.addEventListener('hashchange', _onHash);
    setTimeout(_onHash, 800);
    // Signal poll every 90s
    refreshSignals();
    _signalPoll = setInterval(refreshSignals, 90000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 600));
  } else {
    setTimeout(init, 600);
  }
})();
