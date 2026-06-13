/* OPPORTUNITIES_v1 — Standalone SPA module for multi-opportunity + multi-pipeline.
 * Loaded as a separate script tag from index.html. Self-contained IIFE.
 *
 * What this ships in P2:
 *  - Patches window.openLeadModal to inject a "💼 Opportunities" panel into
 *    every lead modal, when CRM.config.OPPORTUNITIES_ENABLED === '1'.
 *  - Lists all opportunities for the lead with stage / amount / owner / probability.
 *  - + New Opportunity button opens an inline form (no separate modal needed —
 *    keeps the lead modal a single coherent surface).
 *  - Per-row: Edit, Change Stage (quick-pick), Mark Won, Mark Lost.
 *
 * Lazy lookups via _api/_h/_esc/_toast at call time, NOT at IIFE load time
 * (this was the bug that bit Student 360 — script loaded before app.js had
 * defined window.api / window.h, so closure captured undefined).
 */
(function () {
  'use strict';

  // ── Lazy global lookups (avoid Student-360-style load-order bug) ──
  function _api(name, ...args) {
    if (typeof window.api !== 'function') {
      console.warn('[opp] api() not yet defined');
      return Promise.reject(new Error('CRM not ready'));
    }
    return window.api(name, ...args);
  }
  function _h() { return window.h ? window.h.apply(window, arguments) : null; }
  function _esc(s) { return window.esc ? window.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
  function _toast(msg, kind) { if (window.toast) window.toast(msg, kind); else console.log('[toast]', msg); }
  function _fmtMoney(n) { const v = Number(n) || 0; return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 0 }); }
  function _fmtDate(d) { if (!d) return '—'; try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); } catch (_) { return d; } }

  // Self-cached flag — populated by _probeEnabled() lazily.
  let _enabledCache = null;
  async function _probeEnabled() {
    if (_enabledCache !== null) return _enabledCache;
    try {
      // First check CRM.config if the host exposes it
      if (window.CRM && window.CRM.config && (window.CRM.config.OPPORTUNITIES_ENABLED === '1' || window.CRM.config.OPPORTUNITIES_ENABLED === 1)) {
        _enabledCache = true; return true;
      }
      // Otherwise probe the backend directly
      if (typeof window.api === 'function') {
        const r = await window.api('api_opportunities_status').catch(() => null);
        _enabledCache = !!(r && r.enabled);
        return _enabledCache;
      }
    } catch (_) {}
    _enabledCache = false; return false;
  }
  function _isEnabled() { return _enabledCache === true; }

  // ── Cache pipelines + users so render is instant ──
  const _cache = { pipelines: null, users: null, types: null, products: null };
  async function _warm() {
    try {
      if (!_cache.pipelines) {
        _cache.pipelines = await _api('api_pipelines_list').catch(() => []);
      }
      if (!_cache.types) {
        _cache.types = await _api('api_oppTypes_list').catch(() => []);
      }
      if (!_cache.users) {
        try {
          const ulist = await _api('api_users_list').catch(() => []);
          _cache.users = Array.isArray(ulist) ? ulist : (ulist && ulist.rows ? ulist.rows : []);
        } catch (_) { _cache.users = []; }
      }
      if (!_cache.products) {
        try {
          const plist = await _api('api_products_list').catch(() => []);
          _cache.products = Array.isArray(plist) ? plist : (plist && plist.rows ? plist.rows : []);
        } catch (_) { _cache.products = []; }
      }
    } catch (e) { console.warn('[opp] warm failed', e); }
  }

  // ── Render the Opportunities panel inside the lead modal ──
  async function _renderPanelInto(panel, leadId) {
    panel.innerHTML = '<div style="padding:12px;color:#666">Loading opportunities…</div>';
    await _warm();
    let opps = [];
    try { opps = await _api('api_opp_byLead', leadId); } catch (e) { panel.innerHTML = '<div style="padding:12px;color:#c00">Could not load opportunities: ' + _esc(e.message || e) + '</div>'; return; }

    const pipelines = _cache.pipelines || [];
    const users = _cache.users || [];
    const types = _cache.types || [];
    const defaultPipeline = pipelines.find(p => p.is_default) || pipelines[0] || null;

    // Wipe + rebuild
    panel.innerHTML = '';

    // Header bar
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 8px;border-bottom:1px solid #eee;background:linear-gradient(135deg,#f8fafc 0%,#eef2ff 100%);border-radius:8px 8px 0 0';
    header.innerHTML = '<div style="font-weight:700;font-size:1.05rem;color:#1e293b">💼 Opportunities '
      + '<span style="font-weight:400;color:#64748b;font-size:.85rem;margin-left:6px">' + opps.length + ' deal' + (opps.length === 1 ? '' : 's') + '</span></div>';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn primary sm';
    addBtn.style.cssText = 'padding:6px 14px;font-size:.85rem';
    addBtn.textContent = '+ New Opportunity';
    addBtn.onclick = () => _openOppEditor(leadId, null, pipelines, users, types, defaultPipeline, () => _renderPanelInto(panel, leadId), _cache.products || []);
    header.appendChild(addBtn);
    panel.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.style.cssText = 'padding:8px 0';

    if (!opps.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:24px 16px;text-align:center;color:#94a3b8';
      empty.innerHTML = 'No opportunities yet for this lead.<br><span style="font-size:.85rem">Click <b>+ New Opportunity</b> to track a deal — useful when a lead is interested in more than one product or has both a new-business and a renewal deal.</span>';
      body.appendChild(empty);
    } else {
      opps.forEach(o => body.appendChild(_renderOppRow(o, pipelines, users, types, () => _renderPanelInto(panel, leadId))));
    }

    panel.appendChild(body);
  }

  function _renderOppRow(o, pipelines, users, types, refresh) {
    const row = document.createElement('div');
    const isClosed = Number(o.closed_won) === 1 || Number(o.closed_lost) === 1;
    const accent = Number(o.closed_won) === 1 ? '#10b981' : (Number(o.closed_lost) === 1 ? '#ef4444' : '#3b82f6');
    row.style.cssText = 'margin:8px 12px;padding:12px;background:#fff;border:1px solid #e2e8f0;border-left:4px solid ' + accent + ';border-radius:6px;display:grid;grid-template-columns:1fr auto;gap:10px';

    // Left: name + stage + meta
    const left = document.createElement('div');
    const nameLine = document.createElement('div');
    nameLine.style.cssText = 'font-weight:600;color:#1e293b;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    nameLine.innerHTML = _esc(o.name || 'Untitled opportunity')
      + ' <span style="font-size:.7rem;font-weight:500;background:' + accent + '20;color:' + accent + ';padding:2px 8px;border-radius:99px;text-transform:uppercase">'
      + _esc(o.stage_name || 'No stage') + (Number(o.closed_won) === 1 ? ' ✓' : (Number(o.closed_lost) === 1 ? ' ✗' : ''))
      + '</span>';
    if (Number(o.probability) > 0 && !isClosed) {
      nameLine.innerHTML += ' <span style="font-size:.7rem;color:#64748b">' + Number(o.probability) + '% likely</span>';
    }
    left.appendChild(nameLine);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:.82rem;color:#475569;margin-top:6px;display:flex;flex-wrap:wrap;gap:14px';
    meta.innerHTML = '<span>💰 <b style="color:#0f172a">' + _fmtMoney(o.amount) + '</b></span>'
      + (o.product_name ? '<span>📦 <b>' + _esc(o.product_name) + '</b></span>' : '')
      + '<span>👤 ' + _esc(o.owner_name || 'Unassigned') + '</span>'
      + '<span>📈 ' + _esc(o.pipeline_name || 'Default') + '</span>'
      + (o.expected_close_date ? '<span>🎯 Close by ' + _fmtDate(o.expected_close_date) + '</span>' : '')
      + (o.actual_close_date ? '<span>✓ Closed ' + _fmtDate(o.actual_close_date) + '</span>' : '');
    left.appendChild(meta);

    if (o.description) {
      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:.82rem;color:#64748b;margin-top:6px;font-style:italic';
      desc.textContent = '"' + (String(o.description).length > 140 ? String(o.description).slice(0, 137) + '…' : o.description) + '"';
      left.appendChild(desc);
    }
    row.appendChild(left);

    // Right: actions
    const right = document.createElement('div');
    right.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-width:140px;align-items:flex-end';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn ghost sm';
    editBtn.style.cssText = 'padding:4px 10px;font-size:.78rem';
    editBtn.textContent = '✎ Edit';
    editBtn.onclick = () => _openOppEditor(o.lead_id, o, pipelines, users, types, null, refresh, _cache.products || []);
    right.appendChild(editBtn);

    if (!isClosed) {
      // Stage picker
      const stageSel = document.createElement('select');
      stageSel.style.cssText = 'padding:4px 8px;font-size:.78rem;border:1px solid #d1d5db;border-radius:4px;background:#fff';
      const pipeline = pipelines.find(p => Number(p.id) === Number(o.pipeline_id));
      const stages = pipeline ? (pipeline.stages || []) : [];
      stageSel.innerHTML = '<option value="">Change stage…</option>' + stages.map(s => '<option value="' + s.id + '"' + (Number(s.id) === Number(o.stage_id) ? ' disabled' : '') + '>' + _esc(s.name) + (s.is_terminal_win ? ' ✓' : (s.is_terminal_loss ? ' ✗' : '')) + '</option>').join('');
      stageSel.onchange = async () => {
        const v = stageSel.value;
        if (!v) return;
        try {
          await _api('api_opp_changeStage', { id: o.id, to_stage_id: Number(v) });
          _toast('Stage updated');
          refresh();
        } catch (e) { _toast('Failed: ' + (e.message || e), 'err'); }
      };
      right.appendChild(stageSel);

      // Quick close buttons
      const closeRow = document.createElement('div');
      closeRow.style.cssText = 'display:flex;gap:4px';
      const wonBtn = document.createElement('button');
      wonBtn.type = 'button';
      wonBtn.className = 'btn sm';
      wonBtn.style.cssText = 'background:#10b981;color:#fff;padding:4px 10px;font-size:.75rem;border:none;border-radius:4px;cursor:pointer';
      wonBtn.textContent = '✓ Won';
      wonBtn.onclick = async () => {
        if (!confirm('Mark "' + (o.name || 'this opportunity') + '" as WON?')) return;
        try { await _api('api_opp_close', { id: o.id, outcome: 'won' }); _toast('Closed won 🎉'); refresh(); } catch (e) { _toast('Failed: ' + (e.message || e), 'err'); }
      };
      const lostBtn = document.createElement('button');
      lostBtn.type = 'button';
      lostBtn.className = 'btn sm';
      lostBtn.style.cssText = 'background:#ef4444;color:#fff;padding:4px 10px;font-size:.75rem;border:none;border-radius:4px;cursor:pointer';
      lostBtn.textContent = '✗ Lost';
      lostBtn.onclick = async () => {
        const reason = prompt('Reason for lost?\n(Optional — e.g. price, competitor, no budget)');
        if (reason === null) return; // cancelled
        try { await _api('api_opp_close', { id: o.id, outcome: 'lost', lost_reason: reason || null }); _toast('Marked lost'); refresh(); } catch (e) { _toast('Failed: ' + (e.message || e), 'err'); }
      };
      closeRow.appendChild(wonBtn);
      closeRow.appendChild(lostBtn);
      right.appendChild(closeRow);
    } else {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn ghost sm';
      delBtn.style.cssText = 'padding:4px 10px;font-size:.78rem;color:#dc2626';
      delBtn.textContent = '🗑 Delete';
      delBtn.onclick = async () => {
        if (!confirm('Delete this opportunity permanently?')) return;
        try { await _api('api_opp_delete', o.id); _toast('Deleted'); refresh(); } catch (e) { _toast('Failed: ' + (e.message || e), 'err'); }
      };
      right.appendChild(delBtn);
    }

    row.appendChild(right);
    return row;
  }

  // ── Editor: inline form rendered into a backdrop modal ──
  function _openOppEditor(leadId, opp, pipelines, users, types, defaultPipeline, onSaved, products) {
    products = products || [];
    const isEdit = !!(opp && opp.id);
    const pipeline_id = (opp && opp.pipeline_id) || (defaultPipeline && defaultPipeline.id) || (pipelines[0] && pipelines[0].id);
    const pipeline = pipelines.find(p => Number(p.id) === Number(pipeline_id)) || pipelines[0];
    const stages = pipeline ? (pipeline.stages || []) : [];

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;z-index:10001;padding:20px';

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = 'background:#fff;border-radius:10px;width:520px;max-width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)';

    const closeBackdrop = () => { try { backdrop.remove(); } catch (_) {} };
    backdrop.onclick = (e) => { if (e.target === backdrop) closeBackdrop(); };

    modal.innerHTML = '<div style="padding:16px 20px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between">'
      + '<div style="font-weight:700;color:#0f172a">' + (isEdit ? '✎ Edit Opportunity' : '+ New Opportunity') + '</div>'
      + '<button type="button" id="oppClose" style="background:transparent;border:none;font-size:1.2rem;cursor:pointer;color:#64748b">×</button>'
      + '</div>'
      + '<div style="padding:18px 20px;display:flex;flex-direction:column;gap:14px">'
      + '<div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Name <span style="color:#dc2626">*</span></label>'
      + '<input id="oppName" type="text" placeholder="e.g. New annual subscription, Renewal 2027" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem" value="' + _esc((opp && opp.name) || '') + '"></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      + '  <div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Type</label>'
      + '    <select id="oppType" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem"><option value="">— None —</option>'
      + types.map(t => '<option value="' + t.id + '"' + ((opp && Number(opp.opportunity_type_id) === Number(t.id)) ? ' selected' : '') + '>' + _esc(t.icon || '') + ' ' + _esc(t.name) + '</option>').join('')
      + '    </select></div>'
      + '  <div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Owner</label>'
      + '    <select id="oppOwner" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem"><option value="">— Unassigned —</option>'
      + users.map(u => '<option value="' + u.id + '"' + ((opp && Number(opp.owner_user_id) === Number(u.id)) ? ' selected' : '') + '>' + _esc(u.name || u.email) + '</option>').join('')
      + '    </select></div></div>'
      + '<div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Product</label>'
      + '<select id="oppProduct" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem">'
      + '<option value="">— None / Multi-product (use Description) —</option>'
      + products.map(pr => '<option value="' + pr.id + '" data-price="' + (Number(pr.price) || 0) + '"' + ((opp && Number(opp.product_id) === Number(pr.id)) ? ' selected' : '') + '>' + _esc(pr.name) + (Number(pr.price) ? ' — ₹' + (Number(pr.price)).toLocaleString('en-IN') : '') + '</option>').join('')
      + '</select></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      + '  <div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Pipeline</label>'
      + '    <select id="oppPipeline" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem">'
      + pipelines.map(p => '<option value="' + p.id + '"' + (Number(p.id) === Number(pipeline_id) ? ' selected' : '') + '>' + _esc(p.name) + '</option>').join('')
      + '    </select></div>'
      + '  <div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Stage</label>'
      + '    <select id="oppStage" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem">'
      + stages.map(s => '<option value="' + s.id + '"' + ((opp && Number(opp.stage_id) === Number(s.id)) ? ' selected' : '') + '>' + _esc(s.name) + ' (' + Number(s.win_probability || 0) + '%)' + '</option>').join('')
      + '    </select></div></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      + '  <div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Amount (₹)</label>'
      + '    <input id="oppAmount" type="number" min="0" step="100" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem" value="' + _esc((opp && opp.amount) || '') + '"></div>'
      + '  <div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Expected close</label>'
      + '    <input id="oppCloseDate" type="date" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem" value="' + ((opp && opp.expected_close_date) ? String(opp.expected_close_date).slice(0,10) : '') + '"></div></div>'
      + '<div><label style="font-size:.85rem;font-weight:600;color:#334155;display:block;margin-bottom:4px">Description</label>'
      + '<textarea id="oppDesc" rows="2" placeholder="Optional notes about this deal" style="width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:.9rem;resize:vertical">' + _esc((opp && opp.description) || '') + '</textarea></div>'
      + '</div>'
      + '<div style="padding:14px 20px;border-top:1px solid #eee;display:flex;justify-content:flex-end;gap:8px">'
      + '<button type="button" id="oppCancel" class="btn ghost">Cancel</button>'
      + '<button type="button" id="oppSave" class="btn primary">' + (isEdit ? 'Save changes' : 'Create opportunity') + '</button>'
      + '</div>';

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    modal.querySelector('#oppClose').onclick = closeBackdrop;
    modal.querySelector('#oppCancel').onclick = closeBackdrop;

    // When product changes, auto-fill amount with product's price (only if amount empty)
    modal.querySelector('#oppProduct').onchange = function () {
      const selOpt = this.options[this.selectedIndex];
      const price = Number(selOpt && selOpt.getAttribute('data-price')) || 0;
      const amountInput = modal.querySelector('#oppAmount');
      if (price > 0 && (!amountInput.value || Number(amountInput.value) === 0)) {
        amountInput.value = price;
      }
    };
    // Re-populate stages when pipeline changes
    modal.querySelector('#oppPipeline').onchange = function () {
      const newPipe = pipelines.find(p => Number(p.id) === Number(this.value));
      const stages2 = newPipe ? (newPipe.stages || []) : [];
      modal.querySelector('#oppStage').innerHTML = stages2.map(s => '<option value="' + s.id + '">' + _esc(s.name) + ' (' + Number(s.win_probability || 0) + '%)' + '</option>').join('');
    };

    modal.querySelector('#oppSave').onclick = async function () {
      const name = modal.querySelector('#oppName').value.trim();
      if (!name) { _toast('Name is required', 'err'); return; }
      const payload = {
        lead_id: leadId,
        name: name,
        opportunity_type_id: modal.querySelector('#oppType').value ? Number(modal.querySelector('#oppType').value) : null,
        owner_user_id: modal.querySelector('#oppOwner').value ? Number(modal.querySelector('#oppOwner').value) : null,
        product_id: modal.querySelector('#oppProduct').value ? Number(modal.querySelector('#oppProduct').value) : null,
        pipeline_id: Number(modal.querySelector('#oppPipeline').value),
        stage_id: Number(modal.querySelector('#oppStage').value),
        amount: Number(modal.querySelector('#oppAmount').value || 0),
        expected_close_date: modal.querySelector('#oppCloseDate').value || null,
        description: modal.querySelector('#oppDesc').value.trim() || null
      };
      if (isEdit) payload.id = opp.id;
      this.disabled = true; this.textContent = 'Saving…';
      try {
        await _api('api_opp_save', payload);
        _toast(isEdit ? 'Saved' : 'Opportunity created');
        closeBackdrop();
        if (typeof onSaved === 'function') onSaved();
      } catch (e) { _toast('Save failed: ' + (e.message || e), 'err'); this.disabled = false; this.textContent = isEdit ? 'Save changes' : 'Create opportunity'; }
    };

    // Auto-focus name field
    setTimeout(() => { try { modal.querySelector('#oppName').focus(); } catch (_) {} }, 50);
  }

  // ── Patch openLeadModal to inject the panel ──
  function _patchLeadModal() {
    if (typeof window.openLeadModal !== 'function') {
      // app.js not ready yet — retry shortly
      setTimeout(_patchLeadModal, 200);
      return;
    }
    if (window._oppLeadModalPatched) return;
    window._oppLeadModalPatched = true;

    const _orig = window.openLeadModal;
    window.openLeadModal = async function patchedForOpportunities(id) {
      const r = await _orig.apply(this, arguments);
      // After the modal renders, inject our panel — only when:
      //  - feature flag is on
      //  - this is an existing lead (id present), not a brand-new one
      if (!id) return r;
      const enabled = await _probeEnabled();
      if (!enabled) return r;
      setTimeout(() => {
        try {
          // Find the most recently opened modal body
          const modalBody = document.querySelector('.modal-backdrop:last-of-type .modal');
          if (!modalBody) return;
          if (modalBody.querySelector('.opp-panel-wrap')) return; // already injected

          const wrap = document.createElement('div');
          wrap.className = 'opp-panel-wrap';
          wrap.style.cssText = 'margin:16px 0;background:#fff;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden';

          // Append before .actions footer if present, else at end.
          // Use actions.parentNode so nesting depth doesnt matter.
          const actions = modalBody.querySelector('.actions');
          if (actions && actions.parentNode) actions.parentNode.insertBefore(wrap, actions);
          else modalBody.appendChild(wrap);

          _renderPanelInto(wrap, id);
        } catch (e) { console.warn('[opp] inject failed', e); }
      }, 220);
      return r;
    };
  }

  // Kick off the patch once DOM + app.js are likely ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(_patchLeadModal, 100);
  } else {
    document.addEventListener('DOMContentLoaded', () => setTimeout(_patchLeadModal, 100));
  }

  // Expose for manual testing in console
  window.OPP_v1 = { renderPanelInto: _renderPanelInto, openEditor: _openOppEditor, isEnabled: _isEnabled, probe: _probeEnabled, warm: _warm };
})();
