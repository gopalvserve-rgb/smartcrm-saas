/* COPILOT_v4 Proactive Coach + LEAD_AI_HUB_v1
 * - Morning Briefing card on Dashboard
 * - Lead AI Hub panel inside Lead modal (summary + suggested action + draft + score)
 * - 🔔 Floating signal badge top-right
 * Gated behind brand.COPILOT_PROACTIVE_ENABLED='1' (vserve beta).
 */
(function(){
  'use strict';

  let _cachedEnabled = null;

  async function _api(fn, args) {
    args = args == null ? null : args;
    try {
      const token = localStorage.getItem('crm_token') || '';
      const path = (location.pathname.match(/^\/t\/[^\/]+/) || [''])[0] || '';
      const body = (args === null) ? { fn, args: [] } : { fn, args: Array.isArray(args) ? args : [args] };
      const res = await fetch(path + '/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-auth-token': token },
        body: JSON.stringify(body)
      });
      const j = await res.json();
      return j.result || j;
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async function _fetchEnabledOnce() {
    if (_cachedEnabled !== null) return _cachedEnabled;
    try {
      const r = await _api('api_admin_brand', null);
      _cachedEnabled = String((r && r.COPILOT_PROACTIVE_ENABLED) || '') === '1';
    } catch { _cachedEnabled = false; }
    return _cachedEnabled;
  }
  function _enabled() { return _cachedEnabled === true; }

  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  // ── Morning Briefing card on Dashboard ─────────────────────────
  async function renderBriefing(force) {
    if (!_enabled()) return;
    const view = document.querySelector('main, .view, #view, #main, body > .container');
    if (!view) return;
    const old = document.getElementById('cp4-briefing-card');
    if (old) old.remove();
    const card = document.createElement('div');
    card.id = 'cp4-briefing-card';
    card.style.cssText = 'background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#fff;border-radius:16px;padding:18px 22px;margin:0 0 18px 0;box-shadow:0 4px 20px rgba(79,70,229,.25)';
    card.innerHTML = '<div style="font-size:.9rem;opacity:.85">🤖 Your Coach</div><div style="font-size:1.3rem;font-weight:700;margin-top:4px">Loading your plan…</div>';
    view.insertBefore(card, view.firstChild);

    const data = await _api('api_copilot_briefing', { force: !!force });
    if (!data || !data.ok) { card.remove(); return; }

    let html = '<div style="display:flex;justify-content:space-between;align-items:start;gap:12px">';
    html += '<div style="flex:1"><div style="font-size:.85rem;opacity:.85">' + _esc(data.greeting || '') + '</div>';
    html += '<div style="font-size:1.25rem;font-weight:700;margin-top:4px">' + _esc(data.headline || '') + '</div></div>';
    html += '<button id="cp4-refresh" style="background:rgba(255,255,255,.2);border:0;color:#fff;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:.85rem">↻ Refresh</button></div>';

    if (data.items && data.items.length) {
      html += '<div style="margin-top:14px;display:flex;flex-direction:column;gap:8px">';
      data.items.forEach(it => {
        const sev = it.severity === 3 ? '🔥' : it.severity === 2 ? '⏰' : '📌';
        const bg = it.severity === 3 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.10)';
        html += '<div data-cp4-item="' + (it.signal_id || '') + '" data-cp4-lead="' + (it.lead_id || '') + '" style="background:' + bg + ';border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer">';
        html += '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.95rem">' + sev + ' ' + _esc(it.title || '') + '</div>';
        html += '<div style="font-size:.82rem;opacity:.88;margin-top:2px">' + _esc(it.reason || '') + '</div></div>';
        html += '<button data-cp4-act="' + (it.signal_id || '') + '" data-cp4-leadid="' + (it.lead_id || '') + '" style="background:#fff;color:#4f46e5;border:0;padding:6px 14px;border-radius:8px;font-weight:600;cursor:pointer;font-size:.82rem;white-space:nowrap">' + _esc(it.action_label || 'Open') + '</button></div>';
      });
      html += '</div>';
    } else {
      html += '<div style="margin-top:14px;padding:14px;background:rgba(255,255,255,.1);border-radius:10px;text-align:center;opacity:.85">✨ Nothing urgent right now.</div>';
    }
    card.innerHTML = html;
    card.querySelector('#cp4-refresh').onclick = () => renderBriefing(true);
    card.querySelectorAll('[data-cp4-act]').forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const sid = btn.getAttribute('data-cp4-act');
      const lid = btn.getAttribute('data-cp4-leadid');
      if (sid) _api('api_copilot_signal_act', { id: Number(sid) });
      if (lid && Number(lid)) location.hash = '#/leads/' + lid;
    });
    card.querySelectorAll('[data-cp4-item]').forEach(row => row.onclick = () => {
      const lid = row.getAttribute('data-cp4-lead');
      const sid = row.getAttribute('data-cp4-item');
      if (sid) _api('api_copilot_signal_act', { id: Number(sid) });
      if (lid && Number(lid)) location.hash = '#/leads/' + lid;
    });
  }

  // ── LEAD_AI_HUB_v1 — comprehensive AI panel inside Lead modal ──
  async function _renderLeadAiHub(modalBody, leadId) {
    if (!modalBody || !leadId) return;
    if (modalBody.querySelector('#cp4-lead-aihub-' + leadId)) return; // dedup

    const panel = document.createElement('div');
    panel.id = 'cp4-lead-aihub-' + leadId;
    panel.style.cssText = 'background:linear-gradient(135deg,#eef2ff 0%,#f5f3ff 50%,#fdf2f8 100%);border:1px solid #c7d2fe;border-radius:14px;padding:16px;margin:0 0 14px 0;position:relative;overflow:hidden';
    panel.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#6366f1,#8b5cf6,#ec4899);display:grid;place-items:center;color:#fff;font-size:18px">✨</div>' +
          '<div><div style="font-weight:700;color:#1e1b4b;font-size:.95rem">AI Assist</div>' +
          '<div style="font-size:.72rem;color:#6366f1">Powered by AI Coach</div></div>' +
        '</div>' +
        '<button id="cp4-aihub-refresh-' + leadId + '" style="background:#fff;border:1px solid #c7d2fe;color:#4338ca;padding:5px 12px;border-radius:7px;cursor:pointer;font-size:.78rem;font-weight:600">↻ Refresh</button>' +
      '</div>' +
      '<div id="cp4-aihub-body-' + leadId + '" style="display:flex;flex-direction:column;gap:10px">' +
        '<div style="padding:20px;text-align:center;color:#6366f1;font-style:italic">🧠 Analysing this lead…</div>' +
      '</div>';
    // Insert at the very top of the modal body, AFTER the modal-head
    const head = modalBody.querySelector('.modal-head');
    if (head && head.nextSibling) modalBody.insertBefore(panel, head.nextSibling);
    else modalBody.insertBefore(panel, modalBody.firstChild);

    async function _load(force) {
      const bodyDiv = panel.querySelector('#cp4-aihub-body-' + leadId);
      if (!bodyDiv) return;
      bodyDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#6366f1;font-style:italic">🧠 Analysing this lead…</div>';

      // Fetch in parallel: AI summary + AI Score breakdown
      const [sum, score] = await Promise.all([
        _api('api_copilot_lead_summary', { lead_id: Number(leadId), force: !!force }),
        _api('api_leadScore_get', Number(leadId)).catch(() => null)
      ]);

      const parts = [];

      // Section 1: Summary
      if (sum && sum.ok && sum.summary) {
        parts.push(
          '<div style="background:#fff;border-radius:10px;padding:12px 14px;border-left:3px solid #6366f1">' +
            '<div style="font-size:.7rem;color:#6366f1;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">📝 SUMMARY</div>' +
            '<div style="color:#1e1b4b;font-size:.9rem;line-height:1.5">' + _esc(sum.summary) + '</div>' +
          '</div>'
        );
      } else {
        const errMsg = (sum && sum.error) ? sum.error : 'Could not generate AI summary right now. Check Gemini API key in Settings.';
        parts.push('<div style="background:#fff;border-radius:10px;padding:12px 14px;color:#94a3b8;font-style:italic">' + _esc(errMsg) + '</div>');
      }

      // Section 2: Next action
      if (sum && sum.ok && sum.next_action) {
        parts.push(
          '<div style="background:#fff;border-radius:10px;padding:12px 14px;border-left:3px solid #ec4899">' +
            '<div style="font-size:.7rem;color:#ec4899;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">🎯 NEXT BEST ACTION</div>' +
            '<div style="color:#1e1b4b;font-size:.9rem;line-height:1.5">' + _esc(sum.next_action) + '</div>' +
          '</div>'
        );
      }

      // Section 3: Draft message (with copy + WA send)
      if (sum && sum.ok && sum.draft_msg) {
        parts.push(
          '<div style="background:#fff;border-radius:10px;padding:12px 14px;border-left:3px solid #10b981">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px;flex-wrap:wrap">' +
              '<div style="font-size:.7rem;color:#10b981;font-weight:700;text-transform:uppercase;letter-spacing:.5px">💬 SUGGESTED MESSAGE</div>' +
              '<div style="display:flex;gap:5px">' +
                '<button id="cp4-aihub-copy-' + leadId + '" style="background:#f0fdf4;color:#047857;border:1px solid #a7f3d0;padding:3px 10px;border-radius:6px;cursor:pointer;font-size:.72rem;font-weight:600">📋 Copy</button>' +
                '<button id="cp4-aihub-wa-' + leadId + '" style="background:#10b981;color:#fff;border:0;padding:3px 10px;border-radius:6px;cursor:pointer;font-size:.72rem;font-weight:600">📲 WA</button>' +
              '</div>' +
            '</div>' +
            '<div id="cp4-aihub-draft-' + leadId + '" style="color:#1e1b4b;font-size:.88rem;line-height:1.5;font-style:italic">' + _esc(sum.draft_msg) + '</div>' +
          '</div>'
        );
      }

      // Section 4: AI Score breakdown
      if (score && score.score != null) {
        const cat = score.category || score.smart_category || '';
        const bgCat = cat === 'Hot' ? '#ef4444' : cat === 'Warm' ? '#f59e0b' : cat === 'Nurture' ? '#3b82f6' : cat === 'Cold' ? '#94a3b8' : '#64748b';
        parts.push(
          '<div style="background:#fff;border-radius:10px;padding:12px 14px;border-left:3px solid ' + bgCat + '">' +
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
              '<div style="font-size:.7rem;color:' + bgCat + ';font-weight:700;text-transform:uppercase;letter-spacing:.5px">🌡 AI SCORE</div>' +
              '<div style="display:flex;align-items:baseline;gap:6px">' +
                '<span style="font-size:1.6rem;font-weight:800;color:' + bgCat + '">' + (score.score || 0) + '</span>' +
                '<span style="font-size:.7rem;color:#64748b">/100</span>' +
                (cat ? '<span style="background:' + bgCat + ';color:#fff;padding:2px 8px;border-radius:99px;font-size:.7rem;font-weight:700;margin-left:6px">' + _esc(cat) + '</span>' : '') +
              '</div>' +
            '</div>' +
            (score.reason ? '<div style="color:#475569;font-size:.78rem;line-height:1.4;margin-top:2px">' + _esc(score.reason) + '</div>' : '') +
          '</div>'
        );
      }

      // Section 5: Timeline shortcut
      parts.push(
        '<div style="display:flex;gap:8px;justify-content:center;margin-top:2px;flex-wrap:wrap">' +
          '<button id="cp4-aihub-timeline-' + leadId + '" style="background:#fff;border:1px solid #c7d2fe;color:#4338ca;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:.78rem;font-weight:600">📜 Show Activity Timeline</button>' +
        '</div>'
      );

      bodyDiv.innerHTML = parts.join('');

      // Wire buttons
      const draftEl = bodyDiv.querySelector('#cp4-aihub-draft-' + leadId);
      const copyBtn = bodyDiv.querySelector('#cp4-aihub-copy-' + leadId);
      if (copyBtn && draftEl) copyBtn.onclick = () => {
        try {
          navigator.clipboard.writeText(draftEl.textContent || '');
          const orig = copyBtn.textContent;
          copyBtn.textContent = '✓ Copied';
          setTimeout(() => { copyBtn.textContent = orig; }, 1200);
        } catch {}
      };
      const waBtn = bodyDiv.querySelector('#cp4-aihub-wa-' + leadId);
      if (waBtn && draftEl) waBtn.onclick = () => {
        const msg = draftEl.textContent || '';
        // Try the SPA's own openInitiateChatModal if present, else fall back to wa.me
        const phoneEl = document.querySelector('[name="phone"]') || document.querySelector('input[type="tel"]');
        const phone = phoneEl ? phoneEl.value : '';
        const clean = String(phone || '').replace(/\D/g, '');
        if (!clean) { alert('No phone number on this lead.'); return; }
        const url = 'https://wa.me/' + (clean.length === 10 ? '91' : '') + clean + '?text=' + encodeURIComponent(msg);
        try { window.open(url, '_blank'); } catch { location.href = url; }
      };
      const tlBtn = bodyDiv.querySelector('#cp4-aihub-timeline-' + leadId);
      if (tlBtn) tlBtn.onclick = () => _openTimelineModal(leadId);
    }

    panel.querySelector('#cp4-aihub-refresh-' + leadId).onclick = () => _load(true);
    _load(false);
  }

  async function _openTimelineModal(leadId) {
    const data = await _api('api_copilot_lead_timeline', { lead_id: Number(leadId), limit: 50 });
    const events = (data && data.events) || [];
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9100;display:grid;place-items:center;padding:10px';
    back.onclick = ev => { if (ev.target === back) back.remove(); };
    const m = document.createElement('div');
    m.style.cssText = 'background:#fff;border-radius:14px;width:min(560px,100%);max-height:80vh;overflow-y:auto;padding:18px';
    let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><h3 style="margin:0;font-size:1.05rem;color:#1e1b4b">📜 Activity Timeline</h3><button id="cp4-tl-close" style="background:transparent;border:0;cursor:pointer;font-size:1.2rem;color:#64748b">✕</button></div>';
    if (!events.length) html += '<div style="text-align:center;color:#94a3b8;padding:20px">No activity yet.</div>';
    else {
      html += '<div style="display:flex;flex-direction:column;gap:8px">';
      events.forEach(e => {
        const icon = e.kind === 'wa' ? '💬' : e.kind === 'call' ? '📞' : e.kind === 'remark' ? '📝' : e.kind === 'score' ? '🌡' : e.kind === 'status' ? '🏷' : '•';
        const dt = e.at ? new Date(e.at).toLocaleString() : '';
        let txt = '';
        if (e.kind === 'wa') txt = (e.dir === 'in' ? 'Customer: ' : 'Me: ') + (e.text || '').slice(0, 100);
        else if (e.kind === 'call') txt = (e.dir === 'in' ? 'Received' : 'Made') + ' call · ' + (e.duration || 0) + 's';
        else if (e.kind === 'remark') txt = (e.by ? e.by + ': ' : '') + (e.text || '').slice(0, 100);
        else if (e.kind === 'score') txt = 'Score ' + (e.old || '?') + '→' + (e.new || '?') + ' (' + (e.delta > 0 ? '+' : '') + e.delta + ')';
        else if (e.kind === 'status') txt = (e.from || '?') + ' → ' + (e.to || '?') + (e.by ? ' by ' + e.by : '');
        html += '<div style="display:flex;gap:10px;padding:8px 10px;background:#f8fafc;border-radius:8px"><div style="font-size:1.1rem">' + icon + '</div><div style="flex:1"><div style="font-size:.85rem;color:#1e1b4b">' + _esc(txt) + '</div><div style="font-size:.7rem;color:#94a3b8;margin-top:2px">' + dt + '</div></div></div>';
      });
      html += '</div>';
    }
    m.innerHTML = html;
    back.appendChild(m);
    document.body.appendChild(back);
    m.querySelector('#cp4-tl-close').onclick = () => back.remove();
  }

  // Patch openLeadModal so AI Hub injects on every lead modal open
  function _patchLeadModalOpen() {
    if (typeof window.openLeadModal !== 'function') {
      // Try again later — app.js may not have set it yet
      setTimeout(_patchLeadModalOpen, 1000);
      return;
    }
    const orig = window.openLeadModal;
    if (orig._cp4Patched) return;
    window.openLeadModal = async function cp4PatchedOpenLeadModal(id) {
      const result = await orig.apply(this, arguments);
      // Find the just-opened modal body and inject the AI Hub
      if (id && _enabled()) {
        setTimeout(() => {
          const modal = document.querySelector('.modal-backdrop .modal.modal-lg');
          if (modal) _renderLeadAiHub(modal, id);
        }, 300);
      }
      return result;
    };
    window.openLeadModal._cp4Patched = true;
  }

  // ── Signal badge ───────────────────────────────────────────────
  let _signalPoll = null;
  async function refreshSignals() {
    if (!_enabled()) return;
    const data = await _api('api_copilot_signals_list', { limit: 12 });
    if (!data || !data.ok) return;
    _renderBadge((data.signals || []).length, data.signals || []);
  }
  function _renderBadge(count, signals) {
    let badge = document.getElementById('cp4-signal-badge');
    if (!badge) {
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
    if (!signals || !signals.length) html += '<div style="color:#64748b;padding:14px;text-align:center">No active signals.</div>';
    else {
      signals.forEach(s => {
        html += '<div data-cp4-sig="' + s.id + '" data-cp4-lead="' + (s.lead_id || '') + '" style="padding:10px;border-bottom:1px solid #f1f5f9;cursor:pointer">';
        html += '<div style="font-weight:600;color:#1e1b4b;font-size:.88rem">' + _esc(s.title || '') + '</div>';
        html += '<div style="color:#64748b;font-size:.78rem;margin-top:2px">' + _esc(s.reason || '') + '</div></div>';
      });
    }
    sheet.innerHTML = html;
    document.body.appendChild(sheet);
    sheet.querySelectorAll('[data-cp4-sig]').forEach(row => row.onclick = () => {
      const id = Number(row.getAttribute('data-cp4-sig'));
      const lid = Number(row.getAttribute('data-cp4-lead'));
      if (id) _api('api_copilot_signal_act', { id });
      if (lid) location.hash = '#/leads/' + lid;
      sheet.remove();
    });
  }

  function _onHash() {
    if (!_enabled()) return;
    const h = location.hash || '';
    if (h === '' || h === '#/' || h === '#/dashboard') setTimeout(() => renderBriefing(false), 400);
  }

  async function init() {
    await _fetchEnabledOnce();
    if (!_enabled()) return;
    _patchLeadModalOpen();
    window.addEventListener('hashchange', _onHash);
    setTimeout(_onHash, 800);
    refreshSignals();
    _signalPoll = setInterval(refreshSignals, 90000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 600));
  } else {
    setTimeout(init, 600);
  }
})();
