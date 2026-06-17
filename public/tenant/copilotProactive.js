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
      // CP4_TOKEN_KEY_FIX_v1 (2026-06-16) — read the scoped per-tenant
      // token first (e.g. 'crm_token_vserve'), falling back to the legacy
      // 'crm_token'. Mirrors what public/tenant/app.js does. Without
      // this, every api_copilot_* call returned 'Invalid or expired token'
      // even though the user was signed in, because we were sending an
      // empty/stale legacy key while the real token lived under the
      // tenant-scoped name.
      // CP4_TOKEN_KEY_FIX_v2 (2026-06-16) — use the SAME resolution order
      // as app.js's api() helper:
      //   1. window.CRM.token (in-memory, freshest after login/refresh)
      //   2. localStorage 'crm_token_<slug>' (per-workspace scoped key)
      //   3. localStorage 'crm_token' (legacy/global fallback)
      //   4. window.CRM._slug-derived path as a last-resort
      let slug = '';
      try { slug = (window.CRM && window.CRM._slug) || (location.pathname.match(/^\/t\/([^\/]+)/) || [])[1] || ''; } catch (_) {}
      let token = '';
      try { token = (window.CRM && window.CRM.token) || ''; } catch (_) {}
      if (!token && slug) {
        try { token = localStorage.getItem('crm_token_' + slug) || ''; } catch (_) {}
      }
      if (!token) {
        try { token = localStorage.getItem('crm_token') || ''; } catch (_) {}
      }
      const path = (location.pathname.match(/^\/t\/[^\/]+/) || [''])[0] || '';
      // CP4_TOKEN_POSITIONAL_FIX_v3 (2026-06-17) — the tenant dispatcher
      // (routes/saas/tenantApi.js:280) ignores HTTP headers and reads the
      // token from args[0] only. The earlier "header-only" approach made
      // every api_copilot_* call look unauthenticated → "Invalid or
      // expired token" → "Your session may have refreshed" friendly
      // message. Mirror what public/tenant/app.js's api() helper does:
      // prepend the token to the args array. Headers stay too; they're
      // harmless.
      const callArgs = (args === null) ? [] : (Array.isArray(args) ? args : [args]);
      const body = { fn, args: [token, ...callArgs] };
      const res = await fetch(path + '/api', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': token,
          'Authorization': 'Bearer ' + token
        },
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

      // LEAD_AI_HUB_v3 (2026-06-17) — Section 0: MISSED FOLLOW-UP
      // alarm renders as a bright red banner ABOVE everything else
      // when the lead has a follow-up due in the past and no action
      // was taken since. This is the single most actionable thing the
      // rep needs to see.
      if (sum && sum.ok && sum.missed_followup) {
        const mf = sum.missed_followup;
        parts.push(
          '<div style="background:#fef2f2;border:2px solid #fecaca;border-left:4px solid #dc2626;border-radius:10px;padding:12px 14px">' +
            '<div style="font-size:.72rem;color:#dc2626;font-weight:800;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">🚨 MISSED FOLLOW-UP</div>' +
            '<div style="color:#7f1d1d;font-size:.9rem;line-height:1.45;font-weight:600">Due at ' + _esc(mf.due_at_ist || '') + ' — ' + Math.max(1, Number(mf.hours_overdue || 0)) + 'h overdue, no action taken since.</div>' +
          '</div>'
        );
      }

      // LEAD_AI_HUB_v2 (2026-06-17) — Section 1a: Last Activity recap.
      // This is built from real DB facts (last remark, follow-up,
      // last incoming WA, last call) so the rep sees the source-of-truth
      // even when Gemini fails. Render each bullet on its own line.
      if (sum && sum.ok && sum.last_activity_line) {
        const lines = String(sum.last_activity_line).split(/\n+/).filter(Boolean);
        if (lines.length) {
          let inner = '';
          lines.forEach(ln => {
            inner += '<div style="color:#1e1b4b;font-size:.85rem;line-height:1.45;padding:3px 0">' + _esc(ln) + '</div>';
          });
          parts.push(
            '<div style="background:#fff;border-radius:10px;padding:10px 14px;border-left:3px solid #0ea5e9">' +
              '<div style="font-size:.7rem;color:#0ea5e9;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">📋 LAST ACTIVITY</div>' +
              inner +
            '</div>'
          );
        }
      }

      // Section 1b: AI Summary
      if (sum && sum.ok && sum.summary) {
        parts.push(
          '<div style="background:#fff;border-radius:10px;padding:12px 14px;border-left:3px solid #6366f1">' +
            '<div style="font-size:.7rem;color:#6366f1;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">📝 AI SUMMARY</div>' +
            '<div style="color:#1e1b4b;font-size:.9rem;line-height:1.5">' + _esc(sum.summary) + '</div>' +
          '</div>'
        );
      } else {
        // CP4_FRIENDLY_ERROR_v1 (2026-06-16) — translate the raw backend
        // error into something a salesperson can act on. Echoing the JWT
        // error verbatim scares users; explain what to do instead.
        let rawErr = (sum && sum.error) ? String(sum.error) : '';
        let friendly;
        if (/Invalid or expired token|No token|Not signed in/i.test(rawErr)) {
          friendly = '⚠ Your session may have refreshed. Please reload this page and try again.';
        } else if (rawErr) {
          friendly = rawErr;
        } else {
          friendly = 'Could not generate AI summary right now. Check Gemini API key in Settings.';
        }
        parts.push('<div style="background:#fff;border-radius:10px;padding:12px 14px;color:#94a3b8;font-style:italic">' + _esc(friendly) + '</div>');
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

      // LEAD_AI_HUB_v2 — Section 3: Draft message ONLY when backend
      // says show_draft=true (incoming WA in last 48h unanswered). The
      // earlier behaviour showed a message even when not relevant,
      // which made it look like the recommended next step.
      if (sum && sum.ok && sum.draft_msg && sum.show_draft) {
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
  // CP4_CLEANUP_v1 (2026-06-17) — the floating 🔔 signal badge is
  // retired. The same signals now live inside the Copilot drawer
  // (auto-opened once per day with the Day Summary bubble) and the
  // existing app.js #btn-notif covers in-app notifications. A second
  // top-right bell was just visual clutter. Function preserved as a
  // no-op so anything that still calls it stays safe.
  async function refreshSignals() {
    const stale = document.getElementById('cp4-signal-badge');
    if (stale) stale.remove();
    const sheet = document.getElementById('cp4-signal-sheet');
    if (sheet) sheet.remove();
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

  // CP4_DAYSUM_v1 (2026-06-17) — the inline purple "Good evening,
  // N things to focus on today" banner has been retired. The same
  // signals are now consolidated into a once-per-day Copilot-style
  // overlay (see _renderDaySummaryPanel / _maybeShowDaySummary).
  // We keep renderBriefing() defined but unreferenced so other call
  // sites that might import it don't blow up; the overlay is the
  // canonical surface now.
  function _onHash() { /* no-op — banner retired in CP4_DAYSUM_v1 */ }

  // Slide a Copilot-style overlay in once per calendar day per tenant.
  // Groups items by kind: 📥 unanswered WhatsApps, ⏰ follow-ups due,
  // 🔥 hot leads needing attention.
  function _groupCard(icon, color, label, items) {
    let html = '<div style="margin-top:4px"><div style="font-size:.72rem;color:' + color + ';font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">' + icon + ' ' + _esc(label) + ' (' + items.length + ')</div>';
    items.forEach(it => {
      html += '<div style="background:#f8fafc;border-left:3px solid ' + color + ';border-radius:8px;padding:10px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:10px">';
      html += '<div style="flex:1;min-width:0"><div style="font-weight:600;color:#0f172a;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _esc(it.title || '') + '</div>';
      html += '<div style="font-size:.78rem;color:#64748b;margin-top:2px">' + _esc(it.reason || '') + '</div></div>';
      html += '<button data-cp4-ds-lead="' + (it.lead_id || '') + '" data-cp4-ds-sig="' + (it.signal_id || it.id || '') + '" style="background:#fff;border:1px solid ' + color + ';color:' + color + ';padding:5px 12px;border-radius:7px;cursor:pointer;font-size:.78rem;font-weight:600;white-space:nowrap">' + _esc(it.action_label || 'Open') + '</button>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  // CP4_DAYSUM_v2 (2026-06-17) — instead of a centered popup, we now
  // open the Copilot floating drawer (which holds the chat history)
  // and append the day summary as a "model" message bubble. The user
  // explicitly asked for the items to live inside Copilot, not in a
  // separate overlay.
  function _waitForEl(selector, timeoutMs) {
    return new Promise(resolve => {
      const have = document.querySelector(selector);
      if (have) return resolve(have);
      const t0 = Date.now();
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) { obs.disconnect(); resolve(el); }
        else if (Date.now() - t0 > (timeoutMs || 4000)) { obs.disconnect(); resolve(null); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(document.querySelector(selector)); }, timeoutMs || 4000);
    });
  }

  async function _showDaySummaryInCopilot(data) {
    // Bail if the Copilot FAB never mounted on this page (rare race).
    const fab = await _waitForEl('#copilot-fab', 5000);
    if (!fab) return false;

    // If the drawer isn't open yet, click the FAB to open it. Then wait
    // for #copilot-log to render. The drawer is removed on every close,
    // so checking for the drawer is the right "is open" signal.
    let drawer = document.getElementById('copilot-drawer');
    if (!drawer) {
      try { fab.click(); } catch (_) {}
      drawer = await _waitForEl('#copilot-drawer', 3000);
    }
    const log = await _waitForEl('#copilot-log', 3000);
    if (!log) return false;

    const items = Array.isArray(data && data.items) ? data.items : [];
    const buckets = { old_customer_msg: [], followup_due: [], hot_score_jump: [], other: [] };
    items.forEach(it => { (buckets[it.kind] || buckets.other).push(it); });

    const sections = [];
    if (buckets.old_customer_msg.length) sections.push(_groupCard('📥', '#10b981', 'Unanswered WhatsApp', buckets.old_customer_msg));
    if (buckets.followup_due.length)     sections.push(_groupCard('⏰', '#f59e0b', 'Follow-ups due today', buckets.followup_due));
    const hot = buckets.hot_score_jump.concat(buckets.other);
    if (hot.length) sections.push(_groupCard('🔥', '#ef4444', 'Hot leads needing attention', hot));

    // Build the message bubble styled like a Copilot "model" message
    // (white background, left-aligned, slight shadow) but a touch
    // wider so the grouped cards breathe.
    const bubble = document.createElement('div');
    bubble.className = 'copilot-msg model cp4-daysum-bubble';
    bubble.style.cssText = 'align-self:flex-start;background:#fff;color:#0f172a;padding:12px 14px;border-radius:12px;max-width:95%;font-size:.86rem;line-height:1.4;box-shadow:0 1px 2px rgba(15,23,42,.08);border:1px solid #e2e8f0;display:flex;flex-direction:column;gap:10px;width:100%';
    bubble.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #f1f5f9">' +
        '<div style="font-size:1.1rem">🤖</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:.92rem;color:#1e1b4b">' + _esc(data.greeting || 'Day Summary') + '</div>' +
          '<div style="font-size:.72rem;color:#64748b">' + items.length + ' thing' + (items.length === 1 ? '' : 's') + ' to focus on today</div>' +
        '</div>' +
      '</div>' +
      (sections.length
        ? sections.join('')
        : '<div style="text-align:center;color:#64748b;padding:14px 8px"><div style="font-size:1.4rem">✨</div><div style="margin-top:4px">Nothing urgent right now.</div></div>');

    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;

    // Wire per-item Open buttons in the bubble.
    bubble.querySelectorAll('[data-cp4-ds-lead]').forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const lid = btn.getAttribute('data-cp4-ds-lead');
      const sid = btn.getAttribute('data-cp4-ds-sig');
      if (sid) _api('api_copilot_signal_act', { id: Number(sid) });
      if (lid && Number(lid)) location.hash = '#/leads/' + lid;
    });
    return true;
  }


  // CP4_DAYSUM_v4 (2026-06-17) — bulletproof drawer-mount injection.
  // Previous versions only fired _maybeShowDaySummary once 1.5s after
  // init. Two failure modes:
  //   (a) Copilot FAB still booting → injection timed out silently
  //   (b) User closed + reopened drawer → fresh drawer has no bubble
  //       because the appended node died with the old drawer.
  // Fix: MutationObserver on document.body watches for any
  // #copilot-drawer being added. Each time one mounts, if today's
  // flag isn't set, inject a fresh bubble. Robust whether the drawer
  // is opened automatically by us or manually by the user.

  let _drawerObs = null;
  let _autoOpenFired = false;

  // CP4_DAYSUM_v5 (2026-06-17) — flip from per-DAY (localStorage)
  // to per-SESSION (sessionStorage). User feedback was that the bubble
  // showed only ONCE per day, which felt too rare. With sessionStorage
  // the auto-open + bubble fire on every fresh browser session and
  // stay quiet during the same session's refresh/nav.
  function _sessionKey() {
    let slug = '';
    try { slug = (window.CRM && window.CRM._slug) || (location.pathname.match(/^\/t\/([^\/]+)/) || [])[1] || ''; } catch (_) {}
    return 'cp4_daysum_sess_' + slug;
  }
  function _flagGet() {
    try { return sessionStorage.getItem(_sessionKey()) === '1'; } catch (_) { return false; }
  }
  function _flagSet() {
    try { sessionStorage.setItem(_sessionKey(), '1'); } catch (_) {}
  }
  function _flagClear() {
    try { sessionStorage.removeItem(_sessionKey()); } catch (_) {}
    try {
      // Also wipe legacy localStorage day-flags from older versions
      // so they don't keep blocking after upgrade.
      Object.keys(localStorage).forEach(k => { if (k.indexOf('cp4_daysum_') === 0) localStorage.removeItem(k); });
    } catch (_) {}
  }

  async function _injectDaySummaryIntoDrawer(drawer) {
    if (!_enabled()) return;
    if (!drawer) return;
    if (drawer.getAttribute('data-cp4-injected') === '1') return;

    if (_flagGet()) return;

    // Wait for the drawer's log container to render.
    const log = await _waitForEl('#copilot-log', 3000);
    if (!log) return;
    if (drawer.getAttribute('data-cp4-injected') === '1') return;
    drawer.setAttribute('data-cp4-injected', '1');

    const data = await _api('api_copilot_briefing', { force: false });
    if (!data || !data.ok) {
      drawer.removeAttribute('data-cp4-injected'); // allow retry on next mount
      return;
    }

    const items = Array.isArray(data && data.items) ? data.items : [];
    const buckets = { old_customer_msg: [], followup_due: [], hot_score_jump: [], other: [] };
    items.forEach(it => { (buckets[it.kind] || buckets.other).push(it); });

    const sections = [];
    if (buckets.old_customer_msg.length) sections.push(_groupCard('📥', '#10b981', 'Unanswered WhatsApp', buckets.old_customer_msg));
    if (buckets.followup_due.length)     sections.push(_groupCard('⏰', '#f59e0b', 'Follow-ups due today', buckets.followup_due));
    const hot = buckets.hot_score_jump.concat(buckets.other);
    if (hot.length) sections.push(_groupCard('🔥', '#ef4444', 'Hot leads needing attention', hot));

    const bubble = document.createElement('div');
    bubble.className = 'copilot-msg model cp4-daysum-bubble';
    bubble.style.cssText = 'align-self:flex-start;background:#fff;color:#0f172a;padding:12px 14px;border-radius:12px;max-width:100%;font-size:.86rem;line-height:1.4;box-shadow:0 1px 2px rgba(15,23,42,.08);border:1px solid #e2e8f0;display:flex;flex-direction:column;gap:10px;width:100%';
    bubble.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #f1f5f9">' +
        '<div style="font-size:1.1rem">🤖</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:.92rem;color:#1e1b4b">' + _esc(data.greeting || 'Day Summary') + '</div>' +
          '<div style="font-size:.72rem;color:#64748b">' + items.length + ' thing' + (items.length === 1 ? '' : 's') + ' to focus on today</div>' +
        '</div>' +
      '</div>' +
      (sections.length
        ? sections.join('')
        : '<div style="text-align:center;color:#64748b;padding:14px 8px"><div style="font-size:1.4rem">✨</div><div style="margin-top:4px">Nothing urgent right now. Have a productive day.</div></div>');

    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;

    bubble.querySelectorAll('[data-cp4-ds-lead]').forEach(btn => btn.onclick = e => {
      e.stopPropagation();
      const lid = btn.getAttribute('data-cp4-ds-lead');
      const sid = btn.getAttribute('data-cp4-ds-sig');
      if (sid) _api('api_copilot_signal_act', { id: Number(sid) });
      if (lid && Number(lid)) location.hash = '#/leads/' + lid;
    });

    _flagSet();
  }

  function _startDrawerObserver() {
    if (!_enabled()) return;
    if (_drawerObs) return;
    // First-shot: if drawer already exists, inject immediately.
    const existing = document.getElementById('copilot-drawer');
    if (existing) _injectDaySummaryIntoDrawer(existing);
    _drawerObs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.id === 'copilot-drawer') {
              _injectDaySummaryIntoDrawer(node);
            } else if (node.querySelector) {
              const inner = node.querySelector('#copilot-drawer');
              if (inner) _injectDaySummaryIntoDrawer(inner);
            }
          }
        }
      }
    });
    _drawerObs.observe(document.body, { childList: true, subtree: false });
  }

  // CP4_DAYSUM_v5 — persistent FAB observer. Instead of a one-shot
  // _waitForEl with an 8s timeout (which silently gave up on slow
  // boots), we observe the DOM continuously until either:
  //   (a) the FAB appears → click it, mark session flag will be set
  //       by _injectDaySummaryIntoDrawer after the bubble lands
  //   (b) the drawer appears (user opened it themselves) → no-op,
  //       the drawer observer will inject
  //   (c) the session flag gets set (we showed the bubble) → stop
  let _autoOpenObs = null;
  async function _maybeAutoOpenCopilot() {
    if (!_enabled()) return;
    if (_autoOpenFired) return;
    if (_flagGet()) return;
    if (document.getElementById('copilot-drawer')) {
      // Drawer already open at boot — drawer observer will handle inject.
      return;
    }
    const tryClick = () => {
      if (_autoOpenFired) return true;
      if (_flagGet()) { _autoOpenFired = true; return true; }
      if (document.getElementById('copilot-drawer')) {
        _autoOpenFired = true;
        return true;
      }
      const fab = document.getElementById('copilot-fab');
      if (fab) {
        _autoOpenFired = true;
        try { fab.click(); } catch (_) {}
        return true;
      }
      return false;
    };
    if (tryClick()) return;
    // FAB not ready — observe and click as soon as it shows up.
    _autoOpenObs = new MutationObserver(() => {
      if (tryClick()) {
        try { _autoOpenObs && _autoOpenObs.disconnect(); } catch (_) {}
        _autoOpenObs = null;
      }
    });
    _autoOpenObs.observe(document.body, { childList: true, subtree: true });
    // Safety: stop observing after 60s so we don't run forever.
    setTimeout(() => { try { _autoOpenObs && _autoOpenObs.disconnect(); } catch (_) {} _autoOpenObs = null; }, 60000);
  }

  // Kept for backward compat — any older code that called this still
  // works; now it just delegates to the new auto-open + observer flow.
  async function _maybeShowDaySummary() {
    _startDrawerObserver();
    _maybeAutoOpenCopilot();
  }

  // Manual reset / instant test helper. From DevTools console run:
  //   coachReset()
  // → clears today's flag, resets injection markers, opens Copilot.
  window.coachReset = function () {
    try {
      _flagClear();
      _autoOpenFired = false;
      try { _autoOpenObs && _autoOpenObs.disconnect(); } catch (_) {}
      _autoOpenObs = null;
      const d = document.getElementById('copilot-drawer');
      if (d) d.removeAttribute('data-cp4-injected');
      console.log('[coach] CP4_DAYSUM_v5 — flag cleared, re-firing auto-open…');
      _startDrawerObserver();
      _maybeAutoOpenCopilot();
    } catch (e) { console.error('[coach] reset failed', e); }
  };

  async function init() {
    await _fetchEnabledOnce();
    if (!_enabled()) return;
    _patchLeadModalOpen();
    refreshSignals();
    _signalPoll = setInterval(refreshSignals, 90000);
    // CP4_DAYSUM_v1 — wait for the SPA shell to settle before
    // popping the overlay. 1500ms is enough that the user sees the
    // CRM render first; the overlay slides in over the top.
    setTimeout(_maybeShowDaySummary, 1500);
    // LEAD_AI_HUB_v3 — sprinkle the ✨ AI Summary button onto
    // every lead row on the listing page.
    setTimeout(_startListingObserver, 600);
  }

  // LEAD_AI_HUB_v3 — public entry point: any code can call
  // window.coachOpenLeadSummary(leadId) to open the AI Hub overlay
  // for that lead without needing the modal to be open. Used by the
  // listing-page sparkle button and could be called from anywhere.
  async function _renderLeadSummaryOverlay(leadId) {
    const old = document.getElementById('cp4-lead-overlay');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'cp4-lead-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);display:flex;align-items:flex-start;justify-content:center;padding:30px 16px;overflow:auto';
    overlay.innerHTML =
      '<div style="background:#fff;border-radius:16px;max-width:620px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden">' +
        '<div style="padding:14px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#fff;position:sticky;top:0;z-index:1">' +
          '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">' +
            '<div style="font-size:1.4rem">✨</div>' +
            '<div><div style="font-weight:700;font-size:1rem">AI Lead Summary</div><div style="font-size:.75rem;opacity:.85">Lead #' + leadId + '</div></div>' +
          '</div>' +
          '<button id="cp4-lead-overlay-close" style="background:rgba(255,255,255,.2);border:0;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:1.2rem">×</button>' +
        '</div>' +
        '<div id="cp4-lead-overlay-body" style="padding:16px 18px"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('#cp4-lead-overlay-close').onclick = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const body = overlay.querySelector('#cp4-lead-overlay-body');
    // Reuse _renderLeadAiHub by faking a "modal body" structure with
    // a .modal-head sentinel so it injects into the right place.
    body.innerHTML = '<div class="modal-head" style="display:none"></div>';
    await _renderLeadAiHub(body, Number(leadId));
  }
  window.coachOpenLeadSummary = _renderLeadSummaryOverlay;

  // LEAD_AI_HUB_v5 (2026-06-17) — inject a sparkle ✨ AI button into
  // the NAME cell (first <td> after td-check) so it's always visible
  // next to the lead name. The previous attempt put it in td.td-actions
  // which is rightmost and gets scrolled off-screen on wide column
  // layouts (the user couldn't see it because their visible columns
  // ended at COUNTRY).
  //
  // The actual DOM (per public/tenant/app.js _buildLeadRow):
  //   <tr>
  //     <td class="td-check"><input class="row-check" data-id="N"/></td>
  //     <td>{NAME col cell}</td>          ← we inject here
  //     <td>{PHONE col cell}</td>
  //     ...
  //     <td class="td-actions">{✎ etc}</td>
  // The Name cell is the FIRST <td> that isn't td-check.
  function _injectListingButtons() {
    if (!_enabled()) return;
    const checkboxes = document.querySelectorAll('input.row-check[data-id]');
    checkboxes.forEach(cb => {
      const tr = cb.closest('tr');
      if (!tr) return;
      if (tr.getAttribute('data-cp4-injected') === '1') return;
      const leadId = cb.getAttribute('data-id');
      if (!leadId) return;

      // Find the first td that isn't the checkbox cell — that's the
      // visible name/first column for this row. Skip td.td-check.
      let nameCell = null;
      for (const td of tr.children) {
        if (td.tagName !== 'TD') continue;
        if (td.classList.contains('td-check')) continue;
        nameCell = td;
        break;
      }
      if (!nameCell) return;

      const btn = document.createElement('button');
      btn.className = 'btn cp4-aibtn';
      btn.title = 'Generate AI Summary for this lead';
      btn.innerHTML = '✨ AI';
      btn.style.cssText = 'background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:0;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:.72rem;font-weight:700;margin-left:6px;line-height:1.3;vertical-align:middle;box-shadow:0 1px 3px rgba(99,102,241,.4);letter-spacing:.3px;display:inline-block';
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        _renderLeadSummaryOverlay(Number(leadId));
      };
      // Append at END of name cell so it sits to the right of the
      // lead name (after any "Show history" pill / "Very hot" badge).
      nameCell.appendChild(btn);
      tr.setAttribute('data-cp4-injected', '1');
    });
  }

  // Observe DOM mutations and re-run the injector. The leads list
  // re-renders on filter/sort changes; the observer covers that case
  // without us having to hook into the SPA's view-render lifecycle.
  function _startListingObserver() {
    if (!_enabled()) return;
    try { _injectListingButtons(); } catch {}
    const obs = new MutationObserver(() => {
      try { _injectListingButtons(); } catch {}
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 600));
  } else {
    setTimeout(init, 600);
  }
})();
