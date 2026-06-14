/* LEAD_SCORING_v1 — Standalone SPA module.
 *
 * Loaded as separate script tag. Self-contained IIFE.
 *
 * What this ships in P1:
 *  - Score badge on every lead row in the leads list (🎯 84 · Hot)
 *  - Score Card panel inside the Lead modal (big number, category,
 *    "Why this lead is Hot" reason block, point breakdown, recompute btn)
 *  - /leadscoring sidebar page — High-Intent Dashboard
 *  - Patches openLeadModal to inject the Score Card
 *
 * All gated behind the LEAD_SCORING_ENABLED tenant flag.
 */
(function () {
  'use strict';

  function _api(name, ...args) {
    if (typeof window.api !== 'function') return Promise.reject(new Error('CRM not ready'));
    return window.api(name, ...args);
  }
  function _esc(s) { return window.esc ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
  function _toast(msg, kind) { if (window.toast) window.toast(msg, kind); else console.log('[toast]', msg); }

  let _enabledCache = null;
  async function _probeEnabled() {
    if (_enabledCache !== null) return _enabledCache;
    try {
      const r = await _api('api_leadScore_status').catch(() => null);
      _enabledCache = !!(r && r.enabled);
      return _enabledCache;
    } catch (_) { _enabledCache = false; return false; }
  }

  // ── Category colors ──
  const CATEGORY_COLORS = {
    Hot: { bg: '#dc2626', text: '#fff', accent: '#ef4444' },
    Warm: { bg: '#ea580c', text: '#fff', accent: '#f97316' },
    Nurture: { bg: '#ca8a04', text: '#fff', accent: '#eab308' },
    Cold: { bg: '#64748b', text: '#fff', accent: '#94a3b8' },
    Invalid: { bg: '#0f172a', text: '#fff', accent: '#475569' },
  };

  function _scoreBadgeHtml(score, category) {
    if (!score && score !== 0) return '';
    const c = CATEGORY_COLORS[category] || CATEGORY_COLORS.Cold;
    return `<span style="display:inline-flex;align-items:center;gap:4px;background:${c.bg};color:${c.text};padding:2px 8px;border-radius:99px;font-size:.75rem;font-weight:600" title="AI Score">🎯 ${score} · ${category || ''}</span>`;
  }

  // ── Inject score badge into lead row table ──
  // Lead list re-renders frequently. We use a MutationObserver to add badges
  // any time new lead rows appear in the DOM.
  function _injectBadgesIntoLeadList() {
    document.querySelectorAll('tr[data-lead-id]:not([data-score-badged])').forEach(row => {
      row.setAttribute('data-score-badged', '1');
      const leadId = row.getAttribute('data-lead-id');
      if (!leadId) return;
      // Read score from the row's data attributes if present, else fetch via api_leads_list cache
      const score = row.getAttribute('data-smart-score');
      const category = row.getAttribute('data-smart-category');
      if (!score || !category) return;
      const nameCell = row.querySelector('td:nth-child(2), td:nth-child(3)');
      if (!nameCell || nameCell.querySelector('.opp-score-badge')) return;
      const wrap = document.createElement('span');
      wrap.className = 'opp-score-badge';
      wrap.style.cssText = 'margin-left:6px;display:inline-block;vertical-align:middle';
      wrap.innerHTML = _scoreBadgeHtml(Number(score), category);
      nameCell.appendChild(wrap);
    });
  }

  // ── Score Card panel for Lead modal ──
  async function _renderScoreCard(panel, leadId) {
    panel.innerHTML = '<div style="padding:14px;color:#666;text-align:center">Loading score…</div>';
    let bundle;
    try { bundle = await _api('api_leadScore_get', leadId); } catch (e) { panel.innerHTML = '<div style="padding:14px;color:#c00">Could not load score: ' + _esc(e.message || e) + '</div>'; return; }
    if (!bundle || !bundle.ok) { panel.innerHTML = '<div style="padding:14px;color:#c00">' + _esc((bundle && bundle.error) || 'Score unavailable') + '</div>'; return; }
    const { lead, log, override } = bundle;
    const score = Number(lead.smart_score) || 0;
    const category = lead.smart_category || 'Cold';
    const c = CATEGORY_COLORS[category] || CATEGORY_COLORS.Cold;
    const breakdown = lead.score_breakdown_json || {};

    panel.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:0';

    // Header strip
    const head = document.createElement('div');
    head.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;background:linear-gradient(135deg,${c.bg} 0%,${c.accent} 100%);color:${c.text};border-radius:8px 8px 0 0`;
    head.innerHTML = `
      <div style="display:flex;align-items:center;gap:14px">
        <div style="font-size:2.1rem;font-weight:800;line-height:1">${score}<span style="font-size:.85rem;font-weight:500;opacity:.85"> / 100</span></div>
        <div>
          <div style="font-weight:700;text-transform:uppercase;letter-spacing:.5px;font-size:.85rem">${_esc(category)}${override ? ' (manual)' : ''}</div>
          <div style="font-size:.78rem;opacity:.85;margin-top:2px">${lead.score_updated_at ? 'Updated ' + new Date(lead.score_updated_at).toLocaleString('en-IN') : 'Not yet scored'}</div>
        </div>
      </div>`;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px';
    const recompBtn = document.createElement('button');
    recompBtn.type = 'button';
    recompBtn.style.cssText = 'background:rgba(255,255,255,0.2);color:#fff;border:1px solid rgba(255,255,255,0.4);padding:5px 10px;font-size:.78rem;border-radius:5px;cursor:pointer';
    recompBtn.textContent = '↻ Recompute';
    recompBtn.onclick = async () => {
      recompBtn.disabled = true; recompBtn.textContent = 'Computing…';
      try { await _api('api_leadScore_recompute', leadId); _toast('Score recomputed'); _renderScoreCard(panel, leadId); }
      catch (e) { _toast('Failed: ' + (e.message || e), 'err'); recompBtn.disabled = false; recompBtn.textContent = '↻ Recompute'; }
    };
    actions.appendChild(recompBtn);
    head.appendChild(actions);
    wrap.appendChild(head);

    // Reason block
    const reasonBox = document.createElement('div');
    reasonBox.style.cssText = 'padding:12px 16px;background:#fafafa;border-bottom:1px solid #eee';
    if (lead.score_reason) {
      reasonBox.innerHTML = '<div style="font-size:.75rem;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Why this lead is ' + _esc(category) + '</div>'
        + '<div style="font-size:.88rem;color:#0f172a;line-height:1.5">' + _esc(lead.score_reason) + '</div>';
    } else {
      reasonBox.innerHTML = '<div style="font-size:.85rem;color:#94a3b8;text-align:center">No score signals captured yet. Click ↻ Recompute to score this lead now.</div>';
    }
    wrap.appendChild(reasonBox);

    // Bucket breakdown
    if (breakdown && Object.keys(breakdown).length) {
      const bkt = document.createElement('div');
      bkt.style.cssText = 'padding:12px 16px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px';
      const buckets = [
        ['source', 'Source', '🌐'],
        ['fit', 'Fit', '🎯'],
        ['engagement', 'Engagement', '💬'],
        ['communication', 'Communication', '📞'],
        ['application', 'Commitment', '📋'],
        ['negative', 'Negative', '⚠️'],
      ];
      buckets.forEach(([k, label, icon]) => {
        const v = Number(breakdown[k]) || 0;
        const cell = document.createElement('div');
        const sign = v > 0 ? '+' : '';
        const color = v > 0 ? '#15803d' : v < 0 ? '#dc2626' : '#94a3b8';
        cell.style.cssText = 'background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:8px;text-align:center';
        cell.innerHTML = `<div style="font-size:.7rem;color:#64748b">${icon} ${label}</div><div style="font-weight:700;color:${color};font-size:1rem">${sign}${v}</div>`;
        bkt.appendChild(cell);
      });
      if (breakdown.decay > 0) {
        const d = document.createElement('div');
        d.style.cssText = 'grid-column:1/-1;text-align:center;font-size:.78rem;color:#94a3b8;margin-top:4px';
        d.textContent = `Decay applied: −${breakdown.decay} (inactive ${breakdown.daysSilent || '?'} days)`;
        bkt.appendChild(d);
      }
      wrap.appendChild(bkt);
    }

    // Manual override (admin only)
    const me = (window.CRM && window.CRM.me) || {};
    if (me.role === 'admin' || me.role === 'manager') {
      const ovr = document.createElement('div');
      ovr.style.cssText = 'padding:10px 16px;background:#f8fafc;border-top:1px solid #eee;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
      ovr.innerHTML = '<div style="font-size:.78rem;color:#64748b;font-weight:600">Manual override:</div>';
      const sel = document.createElement('select');
      sel.style.cssText = 'padding:4px 8px;font-size:.8rem;border:1px solid #d1d5db;border-radius:5px';
      sel.innerHTML = '<option value="">— Auto —</option>' + Object.keys(CATEGORY_COLORS).map(c => `<option value="${c}"${override && override.override_category === c ? ' selected' : ''}>${c}</option>`).join('');
      sel.onchange = async () => {
        const v = sel.value;
        if (!v) {
          await _api('api_leadScore_override_clear', leadId).catch(() => {});
          _toast('Override cleared'); _renderScoreCard(panel, leadId);
        } else {
          const reason = prompt('Reason for override?', override?.reason || '');
          if (reason === null) { sel.value = override?.override_category || ''; return; }
          try { await _api('api_leadScore_override_save', { lead_id: leadId, category: v, reason }); _toast('Override saved'); _renderScoreCard(panel, leadId); }
          catch (e) { _toast('Failed: ' + (e.message || e), 'err'); sel.value = override?.override_category || ''; }
        }
      };
      ovr.appendChild(sel);
      if (override) {
        const tag = document.createElement('span');
        tag.style.cssText = 'font-size:.72rem;color:#64748b;font-style:italic;margin-left:auto';
        tag.textContent = '"' + (override.reason || '') + '"';
        ovr.appendChild(tag);
      }
      wrap.appendChild(ovr);
    }

    // Recent log
    if (log && log.length) {
      const det = document.createElement('details');
      det.style.cssText = 'padding:10px 16px;border-top:1px solid #eee';
      det.innerHTML = '<summary style="cursor:pointer;font-size:.78rem;font-weight:600;color:#475569">Recent score changes (' + log.length + ')</summary>';
      const list = document.createElement('div');
      list.style.cssText = 'margin-top:8px;font-size:.78rem;color:#475569';
      log.slice(0, 10).forEach(l => {
        const d = new Date(l.changed_at).toLocaleString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
        const delta = Number(l.delta) || 0;
        const sign = delta > 0 ? '+' : '';
        const color = delta > 0 ? '#15803d' : delta < 0 ? '#dc2626' : '#94a3b8';
        list.innerHTML += `<div style="padding:3px 0;border-bottom:1px dashed #e2e8f0"><span style="color:#94a3b8">${d}</span> · <b style="color:${color}">${sign}${delta}</b> → ${l.new_score} <span style="color:#64748b">(${_esc(l.trigger_event || 'auto')})</span></div>`;
      });
      det.appendChild(list);
      wrap.appendChild(det);
    }

    panel.appendChild(wrap);
  }

  // ── Patch openLeadModal to inject Score Card ──
  function _patchLeadModal() {
    if (typeof window.openLeadModal !== 'function') { setTimeout(_patchLeadModal, 200); return; }
    if (window._lsLeadModalPatched) return;
    window._lsLeadModalPatched = true;
    const _orig = window.openLeadModal;
    window.openLeadModal = async function patchedForLeadScoring(id) {
      const r = await _orig.apply(this, arguments);
      if (!id) return r;
      const enabled = await _probeEnabled();
      if (!enabled) return r;
      setTimeout(() => {
        try {
          const modalBody = document.querySelector('.modal-backdrop:last-of-type .modal');
          if (!modalBody || modalBody.querySelector('.ls-score-card')) return;
          const wrap = document.createElement('div');
          wrap.className = 'ls-score-card';
          wrap.style.cssText = 'margin:16px 0;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05)';
          // Insert above .opp-panel-wrap if present, else above .actions
          const oppPanel = modalBody.querySelector('.opp-panel-wrap');
          const actions = modalBody.querySelector('.actions');
          if (oppPanel && oppPanel.parentNode) oppPanel.parentNode.insertBefore(wrap, oppPanel);
          else if (actions && actions.parentNode) actions.parentNode.insertBefore(wrap, actions);
          else modalBody.appendChild(wrap);
          _renderScoreCard(wrap, id);
        } catch (e) { console.warn('[ls] inject failed', e); }
      }, 240);
      return r;
    };
  }

  // ── /leadscoring High-Intent Dashboard view ──
  function _renderHotLeadsDashboard(view) {
    if (!view) return;
    view.innerHTML = '<div style="padding:20px;text-align:center;color:#666">Loading High-Intent Leads…</div>';
    (async () => {
      const enabled = await _probeEnabled();
      if (!enabled) {
        view.innerHTML = '<div style="padding:40px;text-align:center;color:#94a3b8"><h2>AI Lead Scoring is not enabled</h2><p>An admin must enable AI Lead Scoring in Settings before this dashboard is populated.</p></div>';
        return;
      }
      const [status, rows] = await Promise.all([
        _api('api_leadScore_status').catch(() => null),
        _api('api_leadScore_hotList', { limit: 200 }).catch(() => []),
      ]);
      view.innerHTML = '';

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'padding:16px 20px;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(135deg,#1e293b 0%,#0f172a 100%);color:#fff;border-radius:8px;margin-bottom:16px';
      header.innerHTML = `
        <div>
          <div style="font-size:1.4rem;font-weight:800">🎯 High-Intent Leads</div>
          <div style="font-size:.85rem;opacity:.75;margin-top:2px">Leads ranked by AI Score — call the top ones first</div>
        </div>
        <div style="display:flex;gap:16px;text-align:right">
          <div><div style="font-size:1.6rem;font-weight:800;color:#ef4444">${status?.hotCount || 0}</div><div style="font-size:.72rem;opacity:.75">Hot</div></div>
          <div><div style="font-size:1.6rem;font-weight:800;color:#f97316">${status?.warmCount || 0}</div><div style="font-size:.72rem;opacity:.75">Warm</div></div>
        </div>`;
      view.appendChild(header);

      if (!rows.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:40px;text-align:center;color:#94a3b8;background:#fff;border:1px solid #e2e8f0;border-radius:8px';
        empty.innerHTML = '<h3>No Hot or Warm leads yet</h3><p>As leads engage (calls, WhatsApp replies, form opens, etc.) their score will climb and they\'ll appear here.</p><button class="btn primary" id="lsRunBackfill" style="margin-top:12px">Run backfill (score all leads now)</button>';
        view.appendChild(empty);
        const btn = empty.querySelector('#lsRunBackfill');
        btn.onclick = async () => {
          btn.disabled = true; btn.textContent = 'Scoring…';
          try { const r = await _api('api_leadScore_backfill', { limit: 500 }); _toast('Scored ' + r.scored + ' leads'); _renderHotLeadsDashboard(view); }
          catch (e) { _toast('Failed: ' + (e.message || e), 'err'); btn.disabled = false; btn.textContent = 'Run backfill'; }
        };
        return;
      }

      // Table
      const tbl = document.createElement('div');
      tbl.style.cssText = 'background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden';
      let html = '<table style="width:100%;border-collapse:collapse">';
      html += '<thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">';
      html += '<th style="text-align:left;padding:10px;font-size:.78rem;color:#64748b">Score</th>';
      html += '<th style="text-align:left;padding:10px;font-size:.78rem;color:#64748b">Lead</th>';
      html += '<th style="text-align:left;padding:10px;font-size:.78rem;color:#64748b">Phone</th>';
      html += '<th style="text-align:left;padding:10px;font-size:.78rem;color:#64748b">Status</th>';
      html += '<th style="text-align:left;padding:10px;font-size:.78rem;color:#64748b">Owner</th>';
      html += '<th style="text-align:left;padding:10px;font-size:.78rem;color:#64748b">Reason</th>';
      html += '<th style="text-align:right;padding:10px;font-size:.78rem;color:#64748b">Action</th>';
      html += '</tr></thead><tbody>';
      rows.forEach(r => {
        const c = CATEGORY_COLORS[r.smart_category] || CATEGORY_COLORS.Cold;
        html += `<tr style="border-bottom:1px solid #f1f5f9" data-lead-id="${r.id}">`;
        html += `<td style="padding:10px"><span style="background:${c.bg};color:${c.text};padding:3px 10px;border-radius:99px;font-size:.78rem;font-weight:700">${r.smart_score} · ${_esc(r.smart_category)}</span></td>`;
        html += `<td style="padding:10px"><a href="#/leads" onclick="event.preventDefault();window.openLeadModal(${r.id})" style="color:#3b82f6;text-decoration:none;font-weight:600">${_esc(r.name || 'Unnamed')}</a></td>`;
        html += `<td style="padding:10px;font-family:monospace;font-size:.85rem">${_esc(r.phone || '')}</td>`;
        html += `<td style="padding:10px;font-size:.82rem;color:#475569">${_esc(r.status_name || '')}</td>`;
        html += `<td style="padding:10px;font-size:.82rem;color:#475569">${_esc(r.owner_name || 'Unassigned')}</td>`;
        html += `<td style="padding:10px;font-size:.78rem;color:#64748b;max-width:300px">${_esc((r.score_reason || '').slice(0, 100))}${r.score_reason && r.score_reason.length > 100 ? '…' : ''}</td>`;
        html += `<td style="padding:10px;text-align:right"><button class="btn primary sm" onclick="window.openLeadModal(${r.id})" style="font-size:.75rem;padding:4px 10px">Open</button></td>`;
        html += '</tr>';
      });
      html += '</tbody></table>';
      tbl.innerHTML = html;
      view.appendChild(tbl);
    })();
  }

  // ── /leadscoring/settings — Settings page ──
  function _renderSettings(view) {
    if (!view) return;
    view.innerHTML = '<div style="padding:20px;text-align:center;color:#666">Loading settings…</div>';
    (async () => {
      const settings = await _api('api_leadScore_settings_get').catch(() => null);
      const status = await _api('api_leadScore_status').catch(() => null);
      view.innerHTML = '';

      const card = document.createElement('div');
      card.style.cssText = 'background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;max-width:800px;margin:20px auto';
      card.innerHTML = `
        <h2 style="margin:0 0 4px;font-size:1.3rem;color:#0f172a">🎯 AI Lead Scoring Settings</h2>
        <p style="margin:0 0 20px;color:#64748b;font-size:.9rem">Configure how leads are scored and prioritized.</p>

        <div style="display:flex;align-items:center;gap:12px;padding:12px;background:${status?.enabled ? '#dcfce7' : '#fef3c7'};border-radius:6px;margin-bottom:20px">
          <input type="checkbox" id="lsEnabled" ${status?.enabled ? 'checked' : ''}>
          <label for="lsEnabled" style="font-weight:600;color:#0f172a;cursor:pointer">Enable AI Lead Scoring</label>
          <span style="margin-left:auto;font-size:.78rem;color:#64748b">${status?.ruleCount || 0} rules active · ${status?.hotCount || 0} Hot · ${status?.warmCount || 0} Warm</span>
        </div>

        <h3 style="font-size:1rem;margin:16px 0 8px;color:#0f172a">Category Thresholds</h3>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">Hot ≥</label><input type="number" id="lsHot" value="${settings?.hot_threshold || 80}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">Warm ≥</label><input type="number" id="lsWarm" value="${settings?.warm_threshold || 60}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">Nurture ≥</label><input type="number" id="lsNurture" value="${settings?.nurture_threshold || 40}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
        </div>

        <h3 style="font-size:1rem;margin:16px 0 8px;color:#0f172a">SLA (response time)</h3>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">Hot — minutes</label><input type="number" id="lsHotSla" value="${settings?.hot_sla_minutes || 5}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">Warm — minutes</label><input type="number" id="lsWarmSla" value="${settings?.warm_sla_minutes || 60}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">Nurture — hours</label><input type="number" id="lsNurtureSla" value="${settings?.nurture_sla_hours || 24}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
        </div>

        <h3 style="font-size:1rem;margin:16px 0 8px;color:#0f172a">Inactivity Decay</h3>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">7d silent: −</label><input type="number" id="lsDecay7" value="${settings?.decay_7d_points || 10}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">15d silent: −</label><input type="number" id="lsDecay15" value="${settings?.decay_15d_points || 25}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
          <div><label style="font-size:.78rem;font-weight:600;color:#334155">30d silent: −</label><input type="number" id="lsDecay30" value="${settings?.decay_30d_points || 40}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:5px"></div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #eee;padding-top:16px">
          <a href="#/leadscoring" style="color:#3b82f6;font-size:.85rem">← Back to High-Intent Dashboard</a>
          <div style="display:flex;gap:8px">
            <button class="btn ghost" id="lsBackfill">Backfill all leads now</button>
            <button class="btn primary" id="lsSave">Save Settings</button>
          </div>
        </div>`;
      view.appendChild(card);

      card.querySelector('#lsSave').onclick = async () => {
        const payload = {
          is_enabled: card.querySelector('#lsEnabled').checked ? 1 : 0,
          hot_threshold: Number(card.querySelector('#lsHot').value) || 80,
          warm_threshold: Number(card.querySelector('#lsWarm').value) || 60,
          nurture_threshold: Number(card.querySelector('#lsNurture').value) || 40,
          hot_sla_minutes: Number(card.querySelector('#lsHotSla').value) || 5,
          warm_sla_minutes: Number(card.querySelector('#lsWarmSla').value) || 60,
          nurture_sla_hours: Number(card.querySelector('#lsNurtureSla').value) || 24,
          decay_7d_points: Number(card.querySelector('#lsDecay7').value) || 10,
          decay_15d_points: Number(card.querySelector('#lsDecay15').value) || 25,
          decay_30d_points: Number(card.querySelector('#lsDecay30').value) || 40,
        };
        try { await _api('api_leadScore_settings_save', payload); _toast('Settings saved'); _enabledCache = null; _renderSettings(view); }
        catch (e) { _toast('Failed: ' + (e.message || e), 'err'); }
      };
      card.querySelector('#lsBackfill').onclick = async () => {
        const btn = card.querySelector('#lsBackfill');
        btn.disabled = true; btn.textContent = 'Scoring…';
        try { const r = await _api('api_leadScore_backfill', { limit: 1000 }); _toast('Scored ' + r.scored + ' leads — go check High-Intent Dashboard'); btn.disabled = false; btn.textContent = 'Backfill all leads now'; }
        catch (e) { _toast('Failed: ' + (e.message || e), 'err'); btn.disabled = false; btn.textContent = 'Backfill all leads now'; }
      };
    })();
  }

  // ── Register VIEWS ──
  function _registerViews() {
    if (!window.VIEWS) { setTimeout(_registerViews, 200); return; }
    window.VIEWS.leadscoring = async (view) => _renderHotLeadsDashboard(view);
    window.VIEWS.leadscoringsettings = async (view) => _renderSettings(view);
  }

  // ── Boot ──
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => { _patchLeadModal(); _registerViews(); }, 100);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => { _patchLeadModal(); _registerViews(); }, 100));
  }

  // Expose for debugging
  window.LS_v1 = {
    recompute: (id) => _api('api_leadScore_recompute', id),
    probe: _probeEnabled,
    status: () => _api('api_leadScore_status'),
    renderDashboard: (view) => _renderHotLeadsDashboard(view),
    renderSettings: (view) => _renderSettings(view),
  };
})();
