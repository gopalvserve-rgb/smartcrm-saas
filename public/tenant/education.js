/* ====================================================================== */
/* EDU_PACK_v2 SPA (2026-06-27) — Education Pack v2 isolated module       */
/* ---------------------------------------------------------------------- */
/* Pattern (matches solar.js / realestate.js / holiday.js):               */
/*  - Own namespace window.EDU_V2                                         */
/*  - Each VIEW registered onto window.VIEWS                              */
/*  - _api helper reads crm_token_<slug> first, falls back to crm_token   */
/*  - No DOM mutations until VIEW is opened (zero boot cost)              */
/* ====================================================================== */
(function(){
  'use strict';
  if (window.EDU_V2) return;

  // -- token (SPA scoped-token pattern)
  function _slug() {
    try {
      var m = location.pathname.match(/\/t\/([^\/]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  function _tok() {
    var s = _slug();
    try {
      var t = (s && localStorage.getItem('crm_token_' + s)) || localStorage.getItem('crm_token') || '';
      return t;
    } catch (e) { return ''; }
  }
  async function _api(name, payload) {
    var base = (location.pathname.match(/^\/t\/[^\/]+/) || [''])[0];
    var url = base + '/api/' + name;
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': _tok() },
      body: JSON.stringify(payload || {})
    });
    var j = await r.json();
    if (j && j.error) throw new Error(j.error);
    return j;
  }

  // -- inject styles once
  function _injectCss() {
    if (document.getElementById('edu-v2-css')) return;
    var css = document.createElement('style'); css.id = 'edu-v2-css';
    css.textContent = `
      .edu-v2{font:13.5px/1.45 -apple-system,Inter,sans-serif;color:#1c1917}
      .edu-v2 .topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #ddd6fe}
      .edu-v2 .crumb{font-size:12px;color:#78716c}
      .edu-v2 .crumb b{color:#1c1917;font-weight:600}
      .edu-v2 h1{margin:4px 0 0;font-size:20px}
      .edu-v2 .card{background:#fff;border:1px solid #ddd6fe;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 4px 14px rgba(124,58,237,.08);padding:14px;margin-bottom:14px}
      .edu-v2 h2{font-size:15px;margin:0 0 10px}
      .edu-v2 .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
      .edu-v2 .kpi{background:#fff;border:1px solid #ddd6fe;border-radius:10px;padding:12px;position:relative;overflow:hidden}
      .edu-v2 .kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#a855f7,#7c3aed)}
      .edu-v2 .kpi .lbl{font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
      .edu-v2 .kpi .val{font-size:22px;font-weight:700;margin-top:4px}
      .edu-v2 .kpi .trend{font-size:11.5px;margin-top:4px;color:#78716c}
      .edu-v2 .tbl{width:100%;border-collapse:collapse;font-size:13px}
      .edu-v2 .tbl th{text-align:left;padding:9px 8px;border-bottom:1px solid #ddd6fe;color:#57534e;font-size:11.5px;text-transform:uppercase;letter-spacing:.4px;font-weight:600;background:#f5f3ff}
      .edu-v2 .tbl td{padding:9px 8px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
      .edu-v2 .tbl tr:hover td{background:#faf5ff;cursor:pointer}
      .edu-v2 .btn{padding:7px 12px;border:0;border-radius:7px;font-size:12.5px;font-weight:600;cursor:pointer}
      .edu-v2 .btn.primary{background:linear-gradient(135deg,#a855f7,#7c3aed);color:#fff}
      .edu-v2 .btn.ghost{background:#fff;border:1px solid #ddd6fe;color:#1c1917}
      .edu-v2 .btn.green{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff}
      .edu-v2 .btn.red{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff}
      .edu-v2 .btn.sm{font-size:11.5px;padding:4px 8px}
      .edu-v2 .pill{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:600}
      .edu-v2 .pill.ok{background:#ecfdf5;color:#15803d}
      .edu-v2 .pill.warn{background:#fffbeb;color:#b45309}
      .edu-v2 .pill.bad{background:#fef2f2;color:#dc2626}
      .edu-v2 .pill.info{background:#eff6ff;color:#1d4ed8}
      .edu-v2 .pill.gray{background:#f1f5f9;color:#475569}
      .edu-v2 .pill.purple{background:#faf5ff;color:#7e22ce}
      .edu-v2 .small{font-size:11.5px;color:#78716c}
      .edu-v2 .filterbar{display:flex;flex-wrap:wrap;gap:8px;background:#fff;padding:10px 12px;border:1px solid #ddd6fe;border-radius:10px;margin-bottom:12px;align-items:center}
      .edu-v2 .filterbar select,.edu-v2 .filterbar input{padding:6px 9px;border:1px solid #ddd6fe;border-radius:6px;font-size:13px}
      .edu-v2 .wiz-steps{display:flex;align-items:center;gap:0;background:#fff;border:1px solid #ddd6fe;border-radius:10px;padding:14px;margin-bottom:14px}
      .edu-v2 .wiz-step{flex:1;display:flex;flex-direction:column;align-items:center;position:relative;gap:6px}
      .edu-v2 .wiz-step .circle{width:30px;height:30px;border-radius:50%;background:#e5e7eb;color:#6b7280;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;z-index:2}
      .edu-v2 .wiz-step.done .circle{background:#10b981;color:#fff}
      .edu-v2 .wiz-step.active .circle{background:#7c3aed;color:#fff;box-shadow:0 0 0 4px #ddd6fe}
      .edu-v2 .wiz-step .lbl{font-size:11px;color:#57534e;font-weight:600;text-align:center}
      .edu-v2 .wiz-step::after{content:'';position:absolute;top:15px;left:50%;right:-50%;height:2px;background:#e5e7eb;z-index:1}
      .edu-v2 .wiz-step.done::after{background:#10b981}
      .edu-v2 .wiz-step:last-child::after{display:none}
      .edu-v2 .doc-check{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #ddd6fe;border-radius:8px;margin-bottom:6px;background:#fff}
      .edu-v2 .doc-check .icon{width:36px;height:36px;border-radius:6px;background:#f5f3ff;display:flex;align-items:center;justify-content:center;font-size:18px}
      .edu-v2 .doc-check.verified .icon{background:#ecfdf5}
      .edu-v2 .doc-check.rejected .icon{background:#fef2f2}
      .edu-v2 .doc-check.pending .icon{background:#fef3c7}
      .edu-v2 .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .edu-v2 .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
      .edu-v2 .form-row{padding:8px 0}
      .edu-v2 .form-row label{font-size:11.5px;color:#57534e;font-weight:600;display:block;margin-bottom:3px}
      .edu-v2 .form-row input,.edu-v2 .form-row select,.edu-v2 .form-row textarea{width:100%;padding:7px 9px;border:1px solid #ddd6fe;border-radius:7px;font-size:13px;font-family:inherit}
      .edu-v2 .enr-stages{display:grid;grid-template-columns:repeat(5,1fr);gap:0;margin-bottom:14px}
      .edu-v2 .enr-stage{background:#fff;border:1px solid #ddd6fe;padding:14px;text-align:center;position:relative;border-right:0}
      .edu-v2 .enr-stage:first-child{border-radius:10px 0 0 10px}
      .edu-v2 .enr-stage:last-child{border-radius:0 10px 10px 0;border-right:1px solid #ddd6fe}
      .edu-v2 .enr-stage.done{background:linear-gradient(180deg,#ecfdf5,#fff)}
      .edu-v2 .enr-stage.active{background:linear-gradient(180deg,#f5f3ff,#fff);border-bottom:3px solid #7c3aed}
      .edu-v2 .enr-stage .em{font-size:24px}
      .edu-v2 .enr-stage .lbl{font-size:11px;font-weight:700;text-transform:uppercase;color:#57534e;margin-top:4px}
      .edu-v2 .modal-bg{position:fixed;inset:0;background:rgba(28,25,23,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}
      .edu-v2 .modal{background:#fff;border-radius:14px;max-width:680px;width:100%;max-height:90vh;overflow-y:auto;padding:18px;box-shadow:0 30px 60px rgba(0,0,0,.3)}
      .edu-v2 .modal h2{margin:0 0 12px;font-size:17px}
      .edu-v2 .modal .modal-actions{display:flex;gap:6px;margin-top:12px;justify-content:flex-end}
      .edu-v2 .empty{padding:30px;text-align:center;color:#78716c}
      .edu-v2 .empty .em{font-size:32px;margin-bottom:6px}
    `;
    document.head.appendChild(css);
  }

  // -- escape HTML
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' }); } catch (e) { return String(d); }
  }
  function fmtMoney(n) {
    if (n == null) return '—';
    return '₹' + Number(n).toLocaleString('en-IN');
  }

  // -- minimal toast (uses host toast if available, else inline)
  function toast(msg, kind) {
    if (window.toast && typeof window.toast === 'function') return window.toast(msg, kind);
    if (window.notify) return window.notify(msg, kind);
    var div = document.createElement('div');
    div.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;background:'+(kind==='err'?'#dc2626':'#15803d')+';color:#fff;border-radius:8px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.2);font-size:13.5px';
    div.textContent = msg; document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
  }

  // -- modal helpers
  function openModal(html) {
    var bg = document.createElement('div'); bg.className = 'modal-bg';
    bg.innerHTML = '<div class="modal edu-v2">' + html + '</div>';
    bg.addEventListener('click', function(e){ if (e.target===bg) bg.remove(); });
    document.body.appendChild(bg);
    return bg;
  }
  function closeModal() {
    var bg = document.querySelector('.modal-bg');
    if (bg) bg.remove();
  }

  // -- mount helper
  function mount(view, html) {
    _injectCss();
    var root = document.getElementById('view') || document.querySelector('[data-view-root]') || document.body;
    var div = document.createElement('div');
    div.className = 'edu-v2';
    div.setAttribute('data-edu-view', view);
    div.innerHTML = html;
    root.innerHTML = '';
    root.appendChild(div);
    return div;
  }

  // ===================== VIEWS =====================

  // -------- Edu Overview (KPIs) --------
  async function viewEduOverview() {
    mount('overview', '<div class="topbar"><div><div class="crumb">Education / <b>Overview</b></div><h1>🎓 Edu Overview</h1></div></div><div id="edu-ov-kpi" class="kpi-grid"><div class="kpi"><div class="small">Loading…</div></div></div><div id="edu-ov-funnel" class="card"><div class="small">Loading funnel…</div></div>');
    try {
      var s = await _api('api_edu_v2_summary', { period: 'this_month' });
      var k = document.getElementById('edu-ov-kpi');
      k.innerHTML = [
        ['Applications (mo)', s.applications||0, ''],
        ['Submitted', s.submitted||0, ''],
        ['Admitted', s.admitted||0, ''],
        ['Enrollments (mo)', s.enrollments||0, '']
      ].map(([l,v,t]) => '<div class="kpi"><div class="lbl">'+l+'</div><div class="val">'+v+'</div><div class="trend">'+t+'</div></div>').join('');
      document.getElementById('edu-ov-funnel').innerHTML =
        '<h2>🎯 Admission Funnel</h2>' +
        '<div class="small">Applications: <b>'+(s.applications||0)+'</b> → Submitted: <b>'+(s.submitted||0)+'</b> → Admitted: <b>'+(s.admitted||0)+'</b></div>' +
        '<p class="small" style="margin-top:8px">For full funnel chart and trend analysis, open <b>Admission Reports</b>.</p>';
    } catch (e) {
      document.getElementById('edu-ov-kpi').innerHTML = '<div class="kpi"><div class="small" style="color:#dc2626">Error: '+esc(e.message)+'</div></div>';
    }
  }

  // -------- Applications List --------
  function _appStatusPill(s) {
    var map = {
      draft: ['gray', 'Draft'],
      submitted: ['info', 'Submitted'],
      documents_pending: ['warn', 'Docs Pending'],
      documents_verified: ['purple', 'Docs Verified'],
      fee_paid: ['info', 'Fee Paid'],
      admitted: ['ok', '✓ Admitted'],
      class_started: ['ok', '✓ Class Started']
    };
    var m = map[String(s||'').toLowerCase()] || ['gray', s||'—'];
    return '<span class="pill '+m[0]+'">'+esc(m[1])+'</span>';
  }
  async function viewEduApplications() {
    mount('applications', '<div class="topbar"><div><div class="crumb">Education / <b>Applications</b></div><h1>📋 Applications</h1></div><div><button class="btn primary" id="edu-app-new">+ New Application</button></div></div><div class="filterbar"><input id="edu-app-q" placeholder="Search by name / phone / email…" style="flex:1;max-width:320px" /><select id="edu-app-status"><option value="">All status</option><option>draft</option><option>submitted</option><option>documents_pending</option><option>documents_verified</option><option>admitted</option></select><button class="btn ghost" id="edu-app-reload">↻</button></div><div class="card" style="padding:0"><table class="tbl" id="edu-app-tbl"><thead><tr><th>Student</th><th>Phone</th><th>Course</th><th>Step</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody><tr><td colspan="7" class="empty"><div class="em">⏳</div>Loading…</td></tr></tbody></table></div>');
    var load = async () => {
      var q = document.getElementById('edu-app-q').value.trim();
      var status = document.getElementById('edu-app-status').value;
      var tb = document.querySelector('#edu-app-tbl tbody');
      tb.innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
      try {
        var r = await _api('api_edu_applications_list', { q, status, limit: 200 });
        var items = r.items || [];
        if (!items.length) { tb.innerHTML = '<tr><td colspan="7" class="empty"><div class="em">📋</div>No applications yet. Click <b>+ New Application</b>.</td></tr>'; return; }
        tb.innerHTML = items.map(a => `
          <tr data-id="${a.id}">
            <td><b>${esc(a.student_name||'—')}</b><div class="small">${esc(a.email||'')}</div></td>
            <td>${esc(a.phone||'—')}</td>
            <td>${esc(a.course||'—')}</td>
            <td><span class="pill gray">Step ${a.current_step||1}/6</span></td>
            <td>${_appStatusPill(a.status)}</td>
            <td>${fmtDate(a.created_at)}</td>
            <td><button class="btn ghost sm" data-act="open">Open</button></td>
          </tr>`).join('');
        tb.querySelectorAll('tr[data-id]').forEach(tr => {
          tr.addEventListener('click', () => openApplication(Number(tr.getAttribute('data-id'))));
        });
      } catch (e) {
        tb.innerHTML = '<tr><td colspan="7" class="empty" style="color:#dc2626">Error: '+esc(e.message)+'</td></tr>';
      }
    };
    document.getElementById('edu-app-reload').addEventListener('click', load);
    document.getElementById('edu-app-q').addEventListener('input', () => { clearTimeout(window._eduAppT); window._eduAppT = setTimeout(load, 400); });
    document.getElementById('edu-app-status').addEventListener('change', load);
    document.getElementById('edu-app-new').addEventListener('click', () => newApplicationModal(load));
    load();
  }

  function newApplicationModal(onSave) {
    var bg = openModal(`
      <h2>+ New Application</h2>
      <div class="grid2">
        <div class="form-row"><label>Student Name *</label><input id="na-name" /></div>
        <div class="form-row"><label>Phone</label><input id="na-phone" /></div>
        <div class="form-row"><label>Email</label><input id="na-email" /></div>
        <div class="form-row"><label>Parent Phone</label><input id="na-pph" /></div>
        <div class="form-row"><label>Course *</label><input id="na-course" placeholder="e.g. NEET 2026 Foundation" /></div>
        <div class="form-row"><label>10th %</label><input id="na-pct" type="number" step="0.1" /></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="na-cancel">Cancel</button>
        <button class="btn primary" id="na-save">Create</button>
      </div>
    `);
    bg.querySelector('#na-cancel').addEventListener('click', closeModal);
    bg.querySelector('#na-save').addEventListener('click', async () => {
      var nm = bg.querySelector('#na-name').value.trim();
      if (!nm) return toast('Student name required', 'err');
      try {
        await _api('api_edu_applications_create', {
          student_name: nm,
          phone: bg.querySelector('#na-phone').value.trim() || null,
          email: bg.querySelector('#na-email').value.trim() || null,
          parent_phone: bg.querySelector('#na-pph').value.trim() || null,
          course: bg.querySelector('#na-course').value.trim() || null,
          prev_pct: parseFloat(bg.querySelector('#na-pct').value) || null
        });
        toast('Application created');
        closeModal();
        if (onSave) onSave();
      } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    });
  }

  async function openApplication(id) {
    try {
      var r = await _api('api_edu_applications_get', { id });
      var a = r.item; var docs = r.documents || [];
      var step = a.current_step || 1;
      var stepNames = ['Personal','Education','Documents','Fee Plan','Review','Submit'];
      var wiz = '<div class="wiz-steps">' + stepNames.map((nm,i) => {
        var cls = (i+1 < step) ? 'done' : (i+1 === step ? 'active' : '');
        var label = (i+1 < step) ? '✓' : String(i+1);
        return '<div class="wiz-step '+cls+'"><div class="circle">'+label+'</div><div class="lbl">'+nm+'</div></div>';
      }).join('') + '</div>';

      var docList = docs.length ? docs.map(d => {
        var cls = d.status === 'verified' ? 'verified' : (d.status === 'rejected' ? 'rejected' : 'pending');
        var pillCls = d.status === 'verified' ? 'ok' : (d.status === 'rejected' ? 'bad' : 'warn');
        var pillText = d.status === 'verified' ? '✓ Verified' : (d.status === 'rejected' ? 'Rejected' : (d.status === 'uploaded' ? 'Uploaded' : 'Pending'));
        var actBtn = d.status === 'verified'
          ? '<button class="btn ghost sm" data-rej="'+d.id+'">Re-verify</button>'
          : '<button class="btn green sm" data-ver="'+d.id+'">✓ Verify</button>';
        return '<div class="doc-check '+cls+'"><div class="icon">'+(d.status==='verified'?'✓':(d.status==='rejected'?'✗':'⏳'))+'</div><div style="flex:1"><b>'+esc(d.doc_name)+'</b>'+(d.mandatory?' <span class="pill bad" style="font-size:9px;padding:1px 5px">Required</span>':'')+'<div class="small">'+esc(d.doc_type||'')+(d.rejected_reason?' · '+esc(d.rejected_reason):'')+'</div></div><span class="pill '+pillCls+'">'+pillText+'</span>'+actBtn+'</div>';
      }).join('') : '<div class="small">No documents in checklist yet.</div>';

      var html = `
        <h2>📋 ${esc(a.student_name||'Application')} — ${esc(a.course||'')}</h2>
        ${wiz}
        <div class="grid2">
          <div>
            <h2>📷 Document Checklist</h2>
            ${docList}
          </div>
          <div>
            <h2>📋 Application Snapshot</h2>
            <table class="tbl">
              <tbody>
                <tr><td>Name</td><td><b>${esc(a.student_name||'')}</b></td></tr>
                <tr><td>Phone</td><td>${esc(a.phone||'—')}</td></tr>
                <tr><td>Email</td><td>${esc(a.email||'—')}</td></tr>
                <tr><td>Parent</td><td>${esc(a.parent_phone||'—')}</td></tr>
                <tr><td>Course</td><td>${esc(a.course||'—')}</td></tr>
                <tr><td>10th %</td><td><b>${a.prev_pct?a.prev_pct+'%':'—'}</b></td></tr>
                <tr><td>Status</td><td>${_appStatusPill(a.status)}</td></tr>
                <tr><td>Step</td><td>${step} of 6</td></tr>
                <tr><td>Created</td><td>${fmtDate(a.created_at)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" id="ap-close">Close</button>
          <button class="btn primary" id="ap-submit">Submit Application</button>
        </div>`;
      var bg = openModal(html);
      bg.querySelector('#ap-close').addEventListener('click', closeModal);
      bg.querySelector('#ap-submit').addEventListener('click', async () => {
        try { var r2 = await _api('api_edu_applications_submit', { id }); toast('Submitted ('+r2.status+')'); closeModal(); viewEduApplications(); }
        catch (e) { toast('Submit failed: '+e.message, 'err'); }
      });
      bg.querySelectorAll('[data-ver]').forEach(btn => btn.addEventListener('click', async () => {
        try { await _api('api_edu_appDocs_verify', { id: Number(btn.getAttribute('data-ver')) }); closeModal(); openApplication(id); }
        catch (e) { toast('Verify failed: '+e.message, 'err'); }
      }));
      bg.querySelectorAll('[data-rej]').forEach(btn => btn.addEventListener('click', async () => {
        var rsn = prompt('Reason for rejection (optional):') || null;
        try { await _api('api_edu_appDocs_reject', { id: Number(btn.getAttribute('data-rej')), reason: rsn }); closeModal(); openApplication(id); }
        catch (e) { toast('Reject failed: '+e.message, 'err'); }
      }));
    } catch (e) {
      toast('Load failed: ' + e.message, 'err');
    }
  }

  // -------- Enrollments (post-application tracking) --------
  async function viewEduEnrollments() {
    mount('enrollments', '<div class="topbar"><div><div class="crumb">Education / <b>Enrollments</b></div><h1>📜 Enrollment Management</h1></div></div><div class="card" id="edu-enr-summary"><div class="small">Loading…</div></div><div class="card"><h2>Recent Applications → Ready for admission letter</h2><table class="tbl" id="edu-enr-tbl"><thead><tr><th>Student</th><th>Course</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody><tr><td colspan="5" class="empty">Loading…</td></tr></tbody></table></div>');
    try {
      var s = await _api('api_edu_v2_summary', { period: 'this_month' });
      document.getElementById('edu-enr-summary').innerHTML =
        '<div class="kpi-grid">' +
        '<div class="kpi"><div class="lbl">Applications (mo)</div><div class="val">'+(s.applications||0)+'</div></div>' +
        '<div class="kpi"><div class="lbl">Submitted</div><div class="val">'+(s.submitted||0)+'</div></div>' +
        '<div class="kpi"><div class="lbl">Admitted</div><div class="val">'+(s.admitted||0)+'</div></div>' +
        '<div class="kpi"><div class="lbl">Enrollments</div><div class="val">'+(s.enrollments||0)+'</div></div>' +
        '</div>';
      var r = await _api('api_edu_applications_list', { status: 'documents_verified', limit: 50 });
      var items = r.items || [];
      var tb = document.querySelector('#edu-enr-tbl tbody');
      if (!items.length) { tb.innerHTML = '<tr><td colspan="5" class="empty"><div class="em">📜</div>No applications waiting for admission letter.<div class="small">Submit + verify documents on an application to make it eligible.</div></td></tr>'; return; }
      tb.innerHTML = items.map(a => `<tr><td><b>${esc(a.student_name||'—')}</b></td><td>${esc(a.course||'—')}</td><td>${_appStatusPill(a.status)}</td><td>${fmtDate(a.created_at)}</td><td><button class="btn primary sm" data-letter="${a.id}">📄 Issue Admission Letter</button></td></tr>`).join('');
      tb.querySelectorAll('[data-letter]').forEach(btn => btn.addEventListener('click', async () => {
        var appId = Number(btn.getAttribute('data-letter'));
        if (!confirm('Issue admission letter for this application? A roll number will be auto-assigned.')) return;
        try {
          var resp = await _api('api_edu_enrollment_issueAdmissionLetter', { application_id: appId, enrollment_id: appId, sent_via: 'whatsapp', prefix: 'STD' });
          toast('Admission letter issued · Roll: ' + resp.roll_number);
          viewEduEnrollments();
        } catch (e) { toast('Issue failed: '+e.message, 'err'); }
      }));
    } catch (e) {
      document.getElementById('edu-enr-summary').innerHTML = '<div class="small" style="color:#dc2626">Error: '+esc(e.message)+'</div>';
    }
  }

  // -------- Scholarships --------
  async function viewEduScholarships() {
    mount('scholarships', '<div class="topbar"><div><div class="crumb">Education / <b>Scholarships</b></div><h1>📜 Scholarships</h1></div><div><button class="btn primary" id="edu-sch-new">+ New Scholarship</button></div></div><div class="card" style="padding:0"><table class="tbl" id="edu-sch-tbl"><thead><tr><th>Name</th><th>Type</th><th>Eligibility</th><th>Discount</th><th>Auto</th><th></th></tr></thead><tbody><tr><td colspan="6" class="empty">Loading…</td></tr></tbody></table></div>');
    var load = async () => {
      try {
        var r = await _api('api_edu_scholarships_list');
        var items = r.items || [];
        var tb = document.querySelector('#edu-sch-tbl tbody');
        if (!items.length) { tb.innerHTML = '<tr><td colspan="6" class="empty">No scholarships yet.</td></tr>'; return; }
        tb.innerHTML = items.map(s => `<tr data-id="${s.id}">
          <td><b>${esc(s.name)}</b></td>
          <td><span class="pill purple">${esc(s.sch_type||'—')}</span></td>
          <td>${esc(s.eligibility||'—')}</td>
          <td><b>${s.discount_pct||0}%</b></td>
          <td>${s.auto_eligible?'<span class="pill ok">Auto</span>':'<span class="pill gray">Manual</span>'}</td>
          <td><button class="btn ghost sm" data-edit="${s.id}">Edit</button> <button class="btn red sm" data-del="${s.id}">×</button></td>
        </tr>`).join('');
        tb.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', e => {
          e.stopPropagation();
          var id = Number(b.getAttribute('data-edit'));
          var s = items.find(x => x.id === id);
          schModal(s, load);
        }));
        tb.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async e => {
          e.stopPropagation();
          if (!confirm('Deactivate this scholarship?')) return;
          try { await _api('api_edu_scholarships_delete', { id: Number(b.getAttribute('data-del')) }); toast('Removed'); load(); }
          catch (er) { toast('Failed: '+er.message, 'err'); }
        }));
      } catch (e) { document.querySelector('#edu-sch-tbl tbody').innerHTML = '<tr><td colspan="6" class="empty" style="color:#dc2626">'+esc(e.message)+'</td></tr>'; }
    };
    document.getElementById('edu-sch-new').addEventListener('click', () => schModal(null, load));
    load();
  }
  function schModal(s, onSave) {
    s = s || {};
    var bg = openModal(`
      <h2>${s.id?'Edit':'+ New'} Scholarship</h2>
      <div class="grid2">
        <div class="form-row"><label>Name *</label><input id="sm-nm" value="${esc(s.name||'')}" /></div>
        <div class="form-row"><label>Type</label>
          <select id="sm-tp">
            <option value="merit"${s.sch_type==='merit'?' selected':''}>Merit</option>
            <option value="sports"${s.sch_type==='sports'?' selected':''}>Sports</option>
            <option value="sibling"${s.sch_type==='sibling'?' selected':''}>Sibling</option>
            <option value="need"${s.sch_type==='need'?' selected':''}>Need-based</option>
            <option value="early"${s.sch_type==='early'?' selected':''}>Early Bird</option>
            <option value="other"${s.sch_type==='other'?' selected':''}>Other</option>
          </select>
        </div>
        <div class="form-row"><label>Discount %</label><input id="sm-pct" type="number" step="0.1" value="${s.discount_pct||0}" /></div>
        <div class="form-row"><label>Fixed Discount (₹)</label><input id="sm-amt" type="number" value="${s.discount_amt||0}" /></div>
        <div class="form-row" style="grid-column:span 2"><label>Eligibility</label><input id="sm-el" value="${esc(s.eligibility||'')}" placeholder="e.g. 10th >= 85%" /></div>
        <div class="form-row" style="grid-column:span 2"><label><input id="sm-auto" type="checkbox"${s.auto_eligible?' checked':''} /> Auto-apply if eligibility met</label></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="sm-cancel">Cancel</button>
        <button class="btn primary" id="sm-save">${s.id?'Save':'Create'}</button>
      </div>
    `);
    bg.querySelector('#sm-cancel').addEventListener('click', closeModal);
    bg.querySelector('#sm-save').addEventListener('click', async () => {
      var nm = bg.querySelector('#sm-nm').value.trim();
      if (!nm) return toast('Name required', 'err');
      try {
        await _api('api_edu_scholarships_save', {
          id: s.id || null,
          name: nm,
          sch_type: bg.querySelector('#sm-tp').value,
          discount_pct: parseFloat(bg.querySelector('#sm-pct').value)||0,
          discount_amt: parseFloat(bg.querySelector('#sm-amt').value)||0,
          eligibility: bg.querySelector('#sm-el').value.trim(),
          auto_eligible: bg.querySelector('#sm-auto').checked
        });
        toast('Saved'); closeModal(); if (onSave) onSave();
      } catch (e) { toast('Save failed: '+e.message, 'err'); }
    });
  }

  // -------- Batches --------
  async function viewEduBatches() {
    mount('batches', '<div class="topbar"><div><div class="crumb">Education / <b>Batches</b></div><h1>🗂 Batches</h1></div><div><button class="btn primary" id="edu-b-new">+ New Batch</button></div></div><div class="card" style="padding:0"><table class="tbl" id="edu-b-tbl"><thead><tr><th>Name</th><th>Code</th><th>Course</th><th>Schedule</th><th>Capacity</th><th>Status</th><th></th></tr></thead><tbody><tr><td colspan="7" class="empty">Loading…</td></tr></tbody></table></div>');
    var load = async () => {
      try {
        var r = await _api('api_edu_batches_list');
        var items = r.items || [];
        var tb = document.querySelector('#edu-b-tbl tbody');
        if (!items.length) { tb.innerHTML = '<tr><td colspan="7" class="empty"><div class="em">🗂</div>No batches yet. Add a batch like "NEET 2026 Morning" to assign students.</td></tr>'; return; }
        tb.innerHTML = items.map(b => `<tr>
          <td><b>${esc(b.name)}</b></td>
          <td>${esc(b.code||'—')}</td>
          <td>${esc(b.course||'—')}</td>
          <td>${esc(b.days||'')} ${esc(b.start_time||'')}-${esc(b.end_time||'')}</td>
          <td>${b.enrolled_ct||0} / ${b.capacity||0}</td>
          <td>${b.status==='open'?'<span class="pill ok">Open</span>':'<span class="pill gray">'+esc(b.status||'')+'</span>'}</td>
          <td><button class="btn ghost sm" data-edit="${b.id}">Edit</button> <button class="btn red sm" data-del="${b.id}">×</button></td>
        </tr>`).join('');
        tb.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
          var b = items.find(x => x.id === Number(btn.getAttribute('data-edit')));
          batchModal(b, load);
        }));
        tb.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
          if (!confirm('Delete this batch?')) return;
          try { await _api('api_edu_batches_delete', { id: Number(btn.getAttribute('data-del')) }); toast('Deleted'); load(); }
          catch (e) { toast('Delete failed: '+e.message, 'err'); }
        }));
      } catch (e) { document.querySelector('#edu-b-tbl tbody').innerHTML = '<tr><td colspan="7" class="empty" style="color:#dc2626">'+esc(e.message)+'</td></tr>'; }
    };
    document.getElementById('edu-b-new').addEventListener('click', () => batchModal(null, load));
    load();
  }
  function batchModal(b, onSave) {
    b = b || {};
    var bg = openModal(`
      <h2>${b.id?'Edit':'+ New'} Batch</h2>
      <div class="grid2">
        <div class="form-row"><label>Name *</label><input id="bm-nm" value="${esc(b.name||'')}" /></div>
        <div class="form-row"><label>Code</label><input id="bm-cd" value="${esc(b.code||'')}" /></div>
        <div class="form-row" style="grid-column:span 2"><label>Course</label><input id="bm-co" value="${esc(b.course||'')}" /></div>
        <div class="form-row"><label>Start Time</label><input id="bm-st" placeholder="08:00" value="${esc(b.start_time||'')}" /></div>
        <div class="form-row"><label>End Time</label><input id="bm-et" placeholder="10:00" value="${esc(b.end_time||'')}" /></div>
        <div class="form-row"><label>Days</label><input id="bm-dy" placeholder="Mon-Sat" value="${esc(b.days||'')}" /></div>
        <div class="form-row"><label>Capacity</label><input id="bm-cp" type="number" value="${b.capacity||30}" /></div>
        <div class="form-row"><label>Start Date</label><input id="bm-sd" type="date" value="${b.start_date?String(b.start_date).slice(0,10):''}" /></div>
        <div class="form-row"><label>End Date</label><input id="bm-ed" type="date" value="${b.end_date?String(b.end_date).slice(0,10):''}" /></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="bm-cancel">Cancel</button>
        <button class="btn primary" id="bm-save">${b.id?'Save':'Create'}</button>
      </div>
    `);
    bg.querySelector('#bm-cancel').addEventListener('click', closeModal);
    bg.querySelector('#bm-save').addEventListener('click', async () => {
      var nm = bg.querySelector('#bm-nm').value.trim();
      if (!nm) return toast('Name required', 'err');
      try {
        await _api('api_edu_batches_save', {
          id: b.id || null,
          name: nm,
          code: bg.querySelector('#bm-cd').value.trim(),
          course: bg.querySelector('#bm-co').value.trim(),
          start_time: bg.querySelector('#bm-st').value.trim(),
          end_time: bg.querySelector('#bm-et').value.trim(),
          days: bg.querySelector('#bm-dy').value.trim(),
          capacity: parseInt(bg.querySelector('#bm-cp').value, 10) || 30,
          start_date: bg.querySelector('#bm-sd').value || null,
          end_date: bg.querySelector('#bm-ed').value || null,
          status: 'open'
        });
        toast('Saved'); closeModal(); if (onSave) onSave();
      } catch (e) { toast('Save failed: '+e.message, 'err'); }
    });
  }

  // -------- Pack-level utilities --------
  async function viewEduPackHome() {
    mount('packhome', `
      <div class="topbar"><div><div class="crumb">Education / <b>Pack Setup</b></div><h1>🎓 Education Pack v2</h1></div></div>
      <div class="card">
        <h2>One-click setup</h2>
        <p class="small">First time? Apply the 14-stage Education lead pipeline and seed default scholarships + batches.</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button class="btn primary" id="pe-stages">Apply 14-stage Edu Lead Pipeline</button>
          <button class="btn ghost" id="pe-seed">Seed Demo Data (showcase only)</button>
        </div>
        <div id="pe-out" class="small" style="margin-top:10px"></div>
      </div>
      <div class="card">
        <h2>Quick links</h2>
        <p class="small">Use the sidebar to navigate, or click below:</p>
        <ul style="line-height:1.9">
          <li><a href="#" data-go="eduapplications">📋 Applications</a></li>
          <li><a href="#" data-go="eduenrollments">📜 Enrollments</a></li>
          <li><a href="#" data-go="eduscholarships">📜 Scholarships</a></li>
          <li><a href="#" data-go="edubatches">🗂 Batches</a></li>
        </ul>
      </div>
    `);
    document.querySelectorAll('[data-go]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      var v = a.getAttribute('data-go');
      if (window.go && typeof window.go === 'function') return window.go(v);
      if (window.VIEWS && window.VIEWS[v]) return window.VIEWS[v]();
    }));
    document.getElementById('pe-stages').addEventListener('click', async () => {
      try { var r = await _api('api_edu_v2_resetStages'); document.getElementById('pe-out').textContent = '✓ Applied '+r.stages+' Edu stages. Reload to see them in Lead form.'; toast('Stages applied'); }
      catch (e) { toast('Failed: '+e.message, 'err'); }
    });
    document.getElementById('pe-seed').addEventListener('click', async () => {
      if (!confirm('Seed demo: 4 batches, 10 sample applications + scholarships? Safe — won\'t duplicate existing data.')) return;
      try { var r = await _api('api_edu_v2_seedDemo'); document.getElementById('pe-out').textContent = '✓ Seeded '+r.batches_seeded+' batches + '+r.applications_inserted+' applications.'; toast('Demo seeded'); }
      catch (e) { toast('Failed: '+e.message, 'err'); }
    });
  }

  // ===================== VIEWS REGISTRY =====================
  function _registerViews() {
    var V = window.VIEWS = window.VIEWS || {};
    V.packedu        = viewEduPackHome;
    V.eduoverview2   = viewEduOverview;
    V.eduapplications = viewEduApplications;
    V.eduenrollments  = viewEduEnrollments;
    V.eduscholarships = viewEduScholarships;
    V.edubatches      = viewEduBatches;
  }

  // ===================== INIT =====================
  window.EDU_V2 = {
    viewEduOverview, viewEduApplications, viewEduEnrollments, viewEduScholarships, viewEduBatches, viewEduPackHome,
    _api, _tok
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _registerViews);
  } else {
    _registerViews();
  }
})();
