/* STU360_PAGE_v2 — Student 360 as a FULL PAGE route (not modal)
 *
 * Exposes:
 *   window.openStudent360(leadId)             — navigates to #/student360/<id>
 *   window.renderStudent360Page(view, leadId) — renders the page content
 *                                                into the view container
 *
 * The hash-route plumbing lives in app.js (VIEWS.student360 calls the
 * renderer with the lead id parsed from the URL).
 */
(function () {
  'use strict';

  // Lazy lookups so we work even if student360.js races app.js loading
  function h() { return window.h.apply(this, arguments); }
  function esc(v) { return (window.esc || (x => String(x ?? '')))(v); }
  function api() { return window.api.apply(this, arguments); }
  function fmtDate(v, o) { return (window.fmtDate || (x => x ? new Date(x).toLocaleDateString() : ''))(v, o); }
  function toast(m, k) { if (typeof window.toast === 'function') return window.toast(m, k); alert(m); }
  function money(v) { return '₹' + Number(v || 0).toLocaleString('en-IN'); }

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let DATA = null;
  let VIEW_EL = null;

  // ── Public entrypoint — navigate to full-page route ────────────────────
  window.openStudent360 = function (leadId) {
    if (!leadId) {
      if (typeof window._origOpenLeadModal === 'function') return window._origOpenLeadModal();
      return;
    }
    location.hash = '#/student360/' + leadId;
  };

  // ── Renderer — called by VIEWS.student360 in app.js ────────────────────
  window.renderStudent360Page = async function (view, leadId) {
    VIEW_EL = view;
    view.innerHTML = '';
    if (!leadId) {
      view.appendChild(h('div', { style: { padding: '40px', textAlign: 'center', color: '#64748b' } },
        'No student selected. Open from the Students list.'));
      return;
    }
    view.appendChild(h('div', { style: { padding: '40px', textAlign: 'center', color: '#64748b' } },
      h('div', { style: { fontSize: '32px', marginBottom: '12px' } }, '🎓'),
      h('div', {}, 'Loading Student 360…')));

    try {
      DATA = await api('api_student360_get', leadId);
      if (!DATA || !DATA.ok) throw new Error((DATA && DATA.error) || 'Failed to load');
      _renderPage();
    } catch (e) {
      view.innerHTML = '';
      view.appendChild(h('div', { style: { padding: '40px', color: '#dc2626', textAlign: 'center' } },
        h('div', { style: { fontSize: '32px', marginBottom: '12px' } }, '⚠'),
        h('div', {}, 'Could not load Student 360: ' + e.message),
        h('button', { class: 'btn', style: { marginTop: '16px' }, onclick: () => history.back() }, '← Back')));
    }
  };

  async function _refresh() {
    if (!DATA || !DATA.lead) return;
    DATA = await api('api_student360_get', DATA.lead.id);
    _renderPage();
  }

  // ── Tiny inline edit modal ────────────────────────────────────────────
  function _editModal(title, fields, initial, onSave) {
    const overlay = h('div', { class: 'modal-backdrop',
      onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) overlay.remove(); } });
    const inputs = {};
    const body = h('div', { class: 'modal modal-md' },
      h('div', { class: 'modal-head' },
        h('h3', {}, title),
        h('button', { class: 'btn icon', onclick: () => overlay.remove() }, '✕')),
      h('div', { class: 'modal-body', style: { padding: '14px 18px' } },
        fields.map(f => {
          let input;
          const v = initial[f.name] != null ? initial[f.name] : '';
          if (f.type === 'select') input = h('select', { class: 'inp' },
            (f.opts || []).map(o => h('option', { value: o.value, selected: String(o.value) === String(v) }, o.label)));
          else if (f.type === 'textarea') input = h('textarea', { class: 'inp', rows: f.rows || 3 }, v);
          else if (f.type === 'number') input = h('input', { class: 'inp', type: 'number', value: v, min: f.min, max: f.max, step: f.step || 1 });
          else if (f.type === 'date') input = h('input', { class: 'inp', type: 'date', value: v ? String(v).slice(0,10) : '' });
          else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: Number(v) === 1 });
          else input = h('input', { class: 'inp', type: 'text', value: v, placeholder: f.placeholder || '' });
          inputs[f.name] = input;
          return h('div', { style: { marginBottom: '12px' } },
            h('label', { style: { display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '4px', fontWeight: '600' } }, f.label),
            input);
        })),
      h('div', { class: 'modal-foot', style: { padding: '12px 18px', borderTop: '1px solid #e2e8f0', display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          const row = Object.assign({}, initial);
          for (const f of fields) {
            const inp = inputs[f.name];
            if (f.type === 'checkbox') row[f.name] = inp.checked ? 1 : 0;
            else if (f.type === 'number') row[f.name] = inp.value === '' ? null : Number(inp.value);
            else row[f.name] = inp.value;
          }
          try { await onSave(row); overlay.remove(); await _refresh(); }
          catch (e) { toast(e.message || 'Save failed', 'err'); }
        } }, 'Save')));
    overlay.appendChild(body);
    document.body.appendChild(overlay);
  }

  function _saveEntity(entity, row) { return api('api_student360_save', { entity, row }); }
  function _deleteEntity(entity, id) { return api('api_student360_delete', { entity, id }); }

  function _pill(t, color) {
    return h('span', { style: { display: 'inline-block', padding: '3px 9px', borderRadius: '999px',
      fontSize: '10px', fontWeight: '700', background: color, color: '#fff', letterSpacing: '0.3px' } }, t);
  }

  // ── HEADER (sticky) — back button + name + risk pill + actions ────────
  function _renderHeader(derived) {
    const L = DATA.lead, P = DATA.profile || {};
    const risk = Number(P.risk_score || 0);
    const riskCls = risk >= 70 ? 'high' : risk >= 40 ? 'med' : 'low';
    const riskLabel = riskCls === 'high' ? 'AT RISK' : riskCls === 'med' ? 'WATCH' : 'HEALTHY';
    const riskColor = riskCls === 'high' ? '#dc2626' : riskCls === 'med' ? '#f59e0b' : '#16a34a';

    const photo = P.photo_url
      ? h('img', { src: P.photo_url, style: { width: '60px', height: '60px', borderRadius: '50%', objectFit: 'cover', border: '3px solid #fff', boxShadow: '0 0 0 2px ' + riskColor } })
      : h('div', { style: { width: '60px', height: '60px', borderRadius: '50%',
          background: 'linear-gradient(135deg,#6366f1,#a855f7)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: '700', border: '3px solid #fff', boxShadow: '0 0 0 2px ' + riskColor } },
        (L.name || '?').charAt(0).toUpperCase());

    return h('div', { style: {
      position: 'sticky', top: 0, zIndex: 50, background: '#fff',
      borderBottom: '1px solid #e2e8f0', padding: '10px 20px',
      display: 'flex', alignItems: 'center', gap: '14px',
      boxShadow: '0 1px 4px rgba(0,0,0,0.04)'
    } },
      h('button', { class: 'btn icon', title: 'Back to Students',
        onclick: () => { try { history.back(); } catch (_) { location.hash = '#/edustudents'; } } }, '←'),
      photo,
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontSize: '18px', fontWeight: '700' } }, L.name || 'Unnamed'),
        h('div', { style: { fontSize: '11px', color: '#64748b', marginTop: '2px' } },
          (P.enrollment_no ? '🎓 ' + P.enrollment_no + '  •  ' : '') +
          (P.batch_code ? 'Batch ' + P.batch_code + '  •  ' : '') +
          (L.phone || ''))),
      h('div', { style: { padding: '6px 14px', borderRadius: '20px', fontSize: '11px', fontWeight: '700',
        background: riskColor, color: '#fff' } }, riskLabel + ' ' + risk + '/100'),
      h('button', { class: 'btn icon', title: 'Recompute risk',
        onclick: async () => { await api('api_student360_riskCompute', L.id); await _refresh(); toast('Risk score recomputed'); } }, '↻'),
      h('button', { class: 'btn sm', onclick: () => {
        if (typeof window._origOpenLeadModal === 'function') window._origOpenLeadModal(L.id);
      } }, '✎ Quick Edit')
    );
  }

  // ── HERO — gradient banner with KPI tiles + AI insight ────────────────
  function _renderHero(D) {
    const att = (DATA.attendanceSummary && Number(DATA.attendanceSummary.total) > 0)
      ? Math.round((Number(DATA.attendanceSummary.present) / Number(DATA.attendanceSummary.total)) * 100) : null;
    const avgScore = (() => {
      const rows = DATA.testScores || [];
      if (!rows.length) return null;
      let sum = 0, n = 0;
      rows.forEach(r => { const mx = Number(r.max_marks); if (mx > 0) { sum += (Number(r.score) / mx) * 100; n++; } });
      return n > 0 ? Math.round(sum / n) : null;
    })();
    const engHrs = (DATA.engagement || []).reduce((s, e) => s + Number(e.hours_studied || 0), 0);
    const tile = (label, value, sub, accent, icon) => h('div', { style: {
      background: 'rgba(255,255,255,0.10)', backdropFilter: 'blur(6px)',
      padding: '14px 16px', borderRadius: '14px', borderLeft: '4px solid ' + accent
    } },
      h('div', { style: { fontSize: '11px', opacity: '0.75', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' } },
        (icon || '') + ' ' + label),
      h('div', { style: { fontSize: '24px', fontWeight: '800', marginTop: '6px', lineHeight: 1 } }, value),
      sub ? h('div', { style: { fontSize: '11px', opacity: '0.7', marginTop: '4px' } }, sub) : null
    );

    // AI banner content
    let factors = {};
    try { factors = typeof DATA.profile?.risk_factors_json === 'string'
      ? JSON.parse(DATA.profile.risk_factors_json)
      : (DATA.profile?.risk_factors_json || {}); } catch (_) {}
    const aiBits = [];
    if (factors.attendance_pct != null && factors.attendance_pct < 75)
      aiBits.push('attendance has dipped to ' + factors.attendance_pct + '%');
    if (factors.assignments_overdue > 0)
      aiBits.push(factors.assignments_overdue + ' overdue assignments');
    if (D.overdueCount > 0) aiBits.push(D.overdueCount + ' overdue installment' + (D.overdueCount > 1 ? 's' : ''));
    const aiMsg = aiBits.length ? '⚠ Action needed: ' + aiBits.join(', ') + '.' : '✨ Student is on track. Keep nudging engagement.';
    const aiBg = aiBits.length ? 'linear-gradient(135deg,#fef3c7,#fde68a)' : 'linear-gradient(135deg,#dcfce7,#bbf7d0)';
    const aiCol = aiBits.length ? '#78350f' : '#15803d';

    return h('div', {},
      h('div', { style: {
        background: 'linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#312e81 100%)',
        color: '#fff', padding: '24px 28px', margin: '16px 20px 0', borderRadius: '16px',
        boxShadow: '0 10px 30px rgba(15,23,42,0.15)'
      } },
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px' } },
          tile('Attendance', att == null ? '—' : att + '%', 'Last 60 days', '#10b981', '📅'),
          tile('Avg Score', avgScore == null ? '—' : avgScore + '%', (DATA.testScores || []).length + ' tests', '#3b82f6', '📝'),
          tile('Fee Pending', money(D.feeDue), money(D.feePaid) + ' of ' + money(D.feeBilled) + ' paid', D.feeDue > 0 ? '#dc2626' : '#10b981', '💰'),
          tile('Study (90d)', engHrs.toFixed(1) + 'h', (DATA.engagement || []).length + ' active days', '#a855f7', '⏱')
        )
      ),
      // AI banner
      h('div', { style: {
        margin: '14px 20px 0', padding: '14px 18px', background: aiBg, borderRadius: '12px',
        display: 'flex', alignItems: 'center', gap: '12px', color: aiCol
      } },
        h('span', { style: { fontSize: '22px' } }, '✨'),
        h('div', { style: { flex: 1, fontSize: '13px', fontWeight: '600' } }, aiMsg))
    );
  }

  // ── Sub-nav tabs (sticky below header) ────────────────────────────────
  function _renderTabs() {
    const tabs = [
      { id: 'overview', label: '🎯 Overview' },
      { id: 'fees', label: '💰 Fees' },
      { id: 'academics', label: '📚 Academics' },
      { id: 'engagement', label: '🔥 Engagement' },
      { id: 'family', label: '👨‍👩‍👧 Family' },
      { id: 'comms', label: '💬 Communications' },
      { id: 'journey', label: '🔍 Lead Journey' }
    ];
    return h('div', { style: {
      position: 'sticky', top: '78px', zIndex: 40, background: '#fff',
      borderBottom: '1px solid #e2e8f0', padding: '0 20px',
      display: 'flex', gap: '4px', overflowX: 'auto', whiteSpace: 'nowrap'
    } },
      tabs.map(t => h('a', {
        href: 'javascript:void(0)',
        'data-tab': t.id,
        style: {
          padding: '10px 14px', fontSize: '12px', fontWeight: '600',
          color: '#64748b', textDecoration: 'none', borderBottom: '2px solid transparent',
          transition: 'all 0.15s', cursor: 'pointer', userSelect: 'none'
        },
        onclick: (ev) => {
          ev.preventDefault(); ev.stopPropagation();
          const target = document.getElementById('stu360_' + t.id);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },
        onmouseover: (ev) => { ev.target.style.color = '#4f46e5'; ev.target.style.borderColor = '#4f46e5'; },
        onmouseout: (ev) => { ev.target.style.color = '#64748b'; ev.target.style.borderColor = 'transparent'; }
      }, t.label))
    );
  }

  // ── Section wrapper ───────────────────────────────────────────────────
  function _section(id, title, headerActions, body) {
    return h('div', { id: 'stu360_' + id, style: {
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: '14px',
      margin: '16px 0', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.04)'
    } },
      h('div', { style: {
        display: 'flex', alignItems: 'center', padding: '14px 20px',
        borderBottom: '1px solid #f1f5f9', background: '#fafbff'
      } },
        h('div', { style: { flex: 1, fontWeight: '700', fontSize: '15px', color: '#0f172a' } }, title),
        headerActions || ''
      ),
      h('div', { style: { padding: '18px 20px' } }, body)
    );
  }
  const _addBtn = (label, onClick) => h('button', { class: 'btn sm primary',
    style: { padding: '5px 12px', fontSize: '12px' }, onclick: onClick }, '+ ' + label);
  const _delBtn = (onClick) => h('button', { class: 'btn icon sm', title: 'Delete',
    style: { color: '#ef4444' }, onclick: onClick }, '✕');
  const _editBtn = (onClick) => h('button', { class: 'btn icon sm', title: 'Edit', onclick: onClick }, '✎');

  // ── PROFILE ───────────────────────────────────────────────────────────
  function _renderProfile() {
    const L = DATA.lead, P = DATA.profile || {};
    const rows = [
      ['Phone', L.phone || '—'], ['Email', L.email || '—'],
      ['Date of Birth', P.dob ? fmtDate(P.dob, 'short') : '—'],
      ['Gender', P.gender || '—'], ['Blood', P.blood_group || '—'],
      ['Grade', P.grade_level || '—'], ['Academic Yr', P.academic_year || '—'],
      ['Language', P.language_pref || '—'], ['Hostel Room', P.hostel_room || '—'],
      ['Emergency', P.emergency_contact || '—']
    ];
    return _section('overview', '👤 Student Profile',
      _editBtn(() => _editModal('Edit Profile',
        [
          { name: 'dob', label: 'Date of Birth', type: 'date' },
          { name: 'gender', label: 'Gender', type: 'select', opts: [{value:'',label:'—'},{value:'male',label:'Male'},{value:'female',label:'Female'},{value:'other',label:'Other'}] },
          { name: 'blood_group', label: 'Blood Group' },
          { name: 'photo_url', label: 'Photo URL' },
          { name: 'address', label: 'Address', type: 'textarea' },
          { name: 'emergency_contact', label: 'Emergency Contact' },
          { name: 'hostel_room', label: 'Hostel Room' },
          { name: 'enrollment_no', label: 'Enrollment #' },
          { name: 'batch_code', label: 'Batch Code' },
          { name: 'academic_year', label: 'Academic Year' },
          { name: 'grade_level', label: 'Grade / Class' },
          { name: 'language_pref', label: 'Language' },
          { name: 'bio', label: 'Short Bio', type: 'textarea' }
        ],
        Object.assign({ lead_id: L.id }, P),
        async (row) => { row.lead_id = L.id; await _saveEntity('profile_extras', row); })),
      h('div', {},
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 24px' } },
          rows.map(([k, v]) =>
            h('div', { style: { display: 'flex', justifyContent: 'space-between', borderBottom: '1px dotted #e2e8f0', padding: '6px 0' } },
              h('span', { style: { color: '#64748b', fontSize: '12px' } }, k),
              h('span', { style: { fontWeight: '600', fontSize: '13px' } }, v))
          )),
        P.bio ? h('div', { style: { marginTop: '14px', padding: '12px 14px', background: 'linear-gradient(135deg,#f8fafc,#eef2ff)', borderRadius: '8px', fontSize: '13px', color: '#475569', fontStyle: 'italic', borderLeft: '3px solid #6366f1' } }, '"' + esc(P.bio) + '"') : null));
  }

  // ── LEAD JOURNEY ──────────────────────────────────────────────────────
  function _renderJourney() {
    const created = DATA.lead.created_at;
    const acts = DATA.activity || [];
    const enrolls = DATA.enrollments || [];
    const firstEnroll = enrolls.length ? enrolls[enrolls.length - 1] : null;
    const insts = DATA.installments || [];
    const paidInsts = insts.filter(i => (i.status || '').toLowerCase() === 'paid');

    const events = [];
    events.push({ at: created, label: '🆕 Lead created', sub: 'Source: ' + (DATA.lead.source || 'Direct'), color: '#3b82f6' });
    if (firstEnroll) events.push({
      at: firstEnroll.created_at || firstEnroll.start_date,
      label: '🎓 Enrolled in ' + (firstEnroll.course_name || firstEnroll.plan_name || 'Course'),
      sub: 'Plan ' + money(firstEnroll.total_amount), color: '#10b981'
    });
    paidInsts.forEach(p => events.push({
      at: p.paid_at || p.created_at,
      label: '💰 Installment #' + p.seq + ' paid',
      sub: money(p.paid_amount), color: '#16a34a'
    }));
    events.sort((a, b) => new Date(a.at) - new Date(b.at));

    const stages = ['New', 'Contacted', 'Qualified', 'Demo', 'Proposal', 'Enrolled'];
    const currentStage = firstEnroll ? 5 : 0;

    // 7-step conversion funnel with chevrons
    const funnelStrip = h('div', { style: { display: 'flex', gap: '2px', margin: '0 0 16px', overflowX: 'auto' } },
      stages.map((s, i) => {
        const done = i <= currentStage;
        return h('div', { style: {
          flex: '1', minWidth: '110px', padding: '10px 12px',
          background: done ? 'linear-gradient(135deg,#16a34a,#10b981)' : '#e0e7ff',
          color: done ? '#fff' : '#3730a3',
          borderRadius: '6px', textAlign: 'center', fontSize: '11px', fontWeight: '700',
          boxShadow: done ? '0 2px 6px rgba(16,163,74,0.3)' : 'none'
        } }, (i+1) + '. ' + s);
      })
    );

    // Source card
    const sourceCard = h('div', { style: {
      padding: '14px 16px', background: 'linear-gradient(135deg,#f0f9ff,#e0f2fe)',
      borderRadius: '12px', marginBottom: '14px', border: '1px solid #bae6fd',
      display: 'flex', alignItems: 'center', gap: '14px'
    } },
      h('div', { style: { fontSize: '32px' } }, '📍'),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontSize: '12px', color: '#0c4a6e', fontWeight: '600', textTransform: 'uppercase' } }, 'Lead Source'),
        h('div', { style: { fontSize: '15px', fontWeight: '700', marginTop: '2px' } }, esc(DATA.lead.source || 'Direct')),
        h('div', { style: { fontSize: '11px', color: '#64748b', marginTop: '2px' } },
          'Created ' + fmtDate(created) + (firstEnroll ? ' • Enrolled ' + fmtDate(firstEnroll.created_at, 'short') : ''))
      ),
      firstEnroll ? h('div', { style: { textAlign: 'right' } },
        h('div', { style: { fontSize: '11px', color: '#64748b' } }, 'Time to convert'),
        h('div', { style: { fontSize: '18px', fontWeight: '800', color: '#0369a1' } },
          Math.max(1, Math.round((new Date(firstEnroll.created_at) - new Date(created)) / 86400000)) + ' days')
      ) : null
    );

    // Vertical milestone timeline
    const timeline = events.length > 0
      ? h('div', { style: { borderLeft: '3px solid #e2e8f0', paddingLeft: '18px', marginLeft: '10px' } },
          events.map(ev =>
            h('div', { style: { position: 'relative', marginBottom: '14px' } },
              h('div', { style: { position: 'absolute', left: '-26px', top: '4px', width: '14px', height: '14px',
                borderRadius: '50%', background: ev.color, border: '3px solid #fff', boxShadow: '0 0 0 2px ' + ev.color } }),
              h('div', { style: { fontSize: '11px', color: '#94a3b8' } }, fmtDate(ev.at)),
              h('div', { style: { fontSize: '14px', fontWeight: '700', marginTop: '2px' } }, ev.label),
              ev.sub ? h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '2px' } }, ev.sub) : null)))
      : null;

    return _section('journey', '🔍 Lead Journey', null,
      h('div', {},
        funnelStrip, sourceCard, timeline,
        acts.length ? h('details', { style: { marginTop: '14px' } },
          h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: '#64748b', fontWeight: '600' } },
            '▸ Show ' + acts.length + ' detailed activity events'),
          h('table', { style: { width: '100%', fontSize: '12px', marginTop: '8px' } },
            h('tbody', {}, acts.slice(0, 20).map(a =>
              h('tr', {},
                h('td', { style: { padding: '4px 8px', color: '#64748b', whiteSpace: 'nowrap' } }, fmtDate(a.at, 'relative')),
                h('td', { style: { padding: '4px 8px', fontWeight: '600' } }, esc(a.activity_type || a.action_type || '')),
                h('td', { style: { padding: '4px 8px', color: '#475569' } }, esc((a.detail || a.summary || '').slice(0, 80))))))
          )) : null));
  }

  // ── COURSES & FEES ────────────────────────────────────────────────────
  function _renderFees(D) {
    const enrolls = DATA.enrollments || [];
    const insts = DATA.installments || [];
    const summary = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px', marginBottom: '14px' } },
      h('div', { style: { padding: '14px', background: 'linear-gradient(135deg,#eff6ff,#dbeafe)', borderRadius: '10px', borderLeft: '4px solid #3b82f6' } },
        h('div', { style: { fontSize: '11px', color: '#1e40af', fontWeight: '700', textTransform: 'uppercase' } }, 'Total Billed'),
        h('div', { style: { fontSize: '20px', fontWeight: '800', marginTop: '4px', color: '#1e3a8a' } }, money(D.feeBilled))),
      h('div', { style: { padding: '14px', background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', borderRadius: '10px', borderLeft: '4px solid #16a34a' } },
        h('div', { style: { fontSize: '11px', color: '#15803d', fontWeight: '700', textTransform: 'uppercase' } }, '✓ Paid'),
        h('div', { style: { fontSize: '20px', fontWeight: '800', marginTop: '4px', color: '#14532d' } }, money(D.feePaid))),
      h('div', { style: { padding: '14px', background: D.feeDue > 0 ? 'linear-gradient(135deg,#fef2f2,#fee2e2)' : 'linear-gradient(135deg,#f0fdf4,#dcfce7)', borderRadius: '10px', borderLeft: '4px solid ' + (D.feeDue > 0 ? '#dc2626' : '#16a34a') } },
        h('div', { style: { fontSize: '11px', color: D.feeDue > 0 ? '#991b1b' : '#15803d', fontWeight: '700', textTransform: 'uppercase' } }, D.feeDue > 0 ? '⚠ Pending' : '✓ All Paid'),
        h('div', { style: { fontSize: '20px', fontWeight: '800', marginTop: '4px', color: D.feeDue > 0 ? '#7f1d1d' : '#14532d' } }, money(D.feeDue) + (D.overdueCount ? '  · ' + D.overdueCount + ' overdue' : '')))
    );

    return _section('fees', '💰 Courses & Fees', null,
      h('div', {},
        summary,
        enrolls.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '13px', textAlign: 'center', padding: '20px' } }, 'No enrollments yet — use the Education pack 💰 Fees tab to enrol.')
          : enrolls.map(e => h('div', { style: { padding: '14px 16px', background: '#f8fafc', borderRadius: '10px', marginBottom: '10px', borderLeft: '4px solid #6366f1' } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('div', {},
                  h('div', { style: { fontWeight: '700', fontSize: '15px' } }, e.course_name || e.plan_name || 'Course'),
                  h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '3px' } },
                    (e.batch_name ? '🎓 ' + e.batch_name + '  •  ' : '') +
                    'Enrolled ' + fmtDate(e.start_date || e.created_at, 'short'))),
                h('div', { style: { textAlign: 'right' } },
                  h('div', { style: { fontWeight: '800', fontSize: '16px', color: '#1e293b' } }, money(e.total_amount)),
                  _pill((e.status || 'active').toUpperCase(), e.status === 'cancelled' ? '#94a3b8' : e.status === 'completed' ? '#16a34a' : '#3b82f6'))))),
        insts.length > 0 ? h('div', { style: { marginTop: '12px' } },
          h('div', { style: { fontSize: '12px', color: '#64748b', fontWeight: '700', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' } },
            '📅 Installment Timeline (' + insts.length + ')'),
          h('table', { style: { width: '100%', fontSize: '13px', borderCollapse: 'collapse', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' } },
            h('thead', {}, h('tr', { style: { background: '#f8fafc' } },
              ['#', 'Due Date', 'Amount', 'Paid', 'Outstanding', 'Status', ''].map(k =>
                h('th', { style: { textAlign: 'left', padding: '10px', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.3px' } }, k)))),
            h('tbody', {}, insts.map(i => {
              const isOverdue = (i.status || '').toLowerCase() !== 'paid' && i.due_date && new Date(i.due_date) < new Date();
              const out = Number(i.amount || 0) - Number(i.paid_amount || 0);
              const statusColor = (i.status === 'paid') ? '#16a34a' : isOverdue ? '#dc2626' : '#f59e0b';
              const statusText = (i.status === 'paid') ? 'PAID' : isOverdue ? 'OVERDUE' : 'DUE';
              return h('tr', { style: isOverdue ? { background: '#fef2f2' } : {} },
                h('td', { style: { padding: '10px', fontWeight: '700' } }, i.seq),
                h('td', { style: { padding: '10px' } }, fmtDate(i.due_date, 'short')),
                h('td', { style: { padding: '10px' } }, money(i.amount)),
                h('td', { style: { padding: '10px', color: '#16a34a', fontWeight: '600' } }, money(i.paid_amount)),
                h('td', { style: { padding: '10px', fontWeight: '700', color: out > 0 ? '#dc2626' : '#16a34a' } }, money(out)),
                h('td', { style: { padding: '10px' } }, _pill(statusText, statusColor)),
                h('td', { style: { padding: '10px' } },
                  out > 0 ? h('button', { class: 'btn sm primary', style: { padding: '4px 10px', fontSize: '11px' },
                    onclick: async () => {
                      if (!confirm('Mark installment #' + i.seq + ' as PAID (' + money(out) + ')?')) return;
                      try { await api('api_edu_installment_markPaid', { id: i.id, amount: out }); await _refresh(); }
                      catch (e) { alert(e.message || 'Mark paid failed'); }
                    } }, '✓ Mark Paid') : null));
            })))
        ) : h('div', { style: { color: '#94a3b8', fontSize: '12px', fontStyle: 'italic', textAlign: 'center', padding: '14px' } }, 'No installment schedule yet.')
      ));
  }

  // ── ACADEMICS (Attendance + Tests + Assignments + Schedule + Skills) ──
  function _renderAcademics() {
    const att = DATA.attendanceSummary || {};
    const total = Number(att.total || 0);
    const pct = total > 0 ? Math.round((Number(att.present) / total) * 100) : 0;
    const cells = (DATA.attendance || []).slice(0, 30).reverse();
    const tests = DATA.testScores || [];
    const asst = DATA.assignments || [];
    const sched = DATA.schedule || [];
    const skills = DATA.skills || [];
    const L = DATA.lead;

    const attBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px' } }, '📅 Attendance (last 60 days)'),
        h('div', { style: { fontSize: '14px', fontWeight: '800', color: pct >= 75 ? '#16a34a' : pct >= 60 ? '#f59e0b' : '#dc2626' } }, pct + '%'),
        h('div', { style: { flex: 1 } }),
        h('span', { style: { fontSize: '11px', color: '#64748b' } }, total + ' marked · ' + (att.present || 0) + ' present · ' + (att.absent || 0) + ' absent')),
      cells.length ? h('div', { style: { display: 'flex', gap: '3px', flexWrap: 'wrap' } },
        cells.map(c => h('div', { title: c.date + ' — ' + c.status,
          style: { width: '16px', height: '16px', borderRadius: '3px',
            background: c.status === 'present' ? '#16a34a' : c.status === 'late' ? '#f59e0b' : c.status === 'absent' ? '#dc2626' : '#cbd5e1' } })))
        : h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No attendance marked yet'));

    const testsBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { fontWeight: '700', fontSize: '13px', marginBottom: '8px' } }, '📝 Test Scores'),
      tests.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No tests recorded yet')
        : h('table', { style: { width: '100%', fontSize: '12px' } },
            h('tbody', {}, tests.map(r => {
              const p = Number(r.max_marks) > 0 ? Math.round((Number(r.score) / Number(r.max_marks)) * 100) : null;
              return h('tr', {},
                h('td', { style: { padding: '4px 6px', fontWeight: '600' } }, esc(r.test_title || 'Test')),
                h('td', { style: { padding: '4px 6px', color: '#64748b' } }, fmtDate(r.test_date, 'short')),
                h('td', { style: { padding: '4px 6px' } }, r.score + ' / ' + r.max_marks),
                h('td', { style: { padding: '4px 6px' } }, p == null ? '' : _pill(p + '%', p >= 75 ? '#16a34a' : p >= 50 ? '#f59e0b' : '#dc2626')));
            }))));

    const asstBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '📋 Assignments'),
        _addBtn('Add', () => _editModal('New Assignment', [
          { name: 'title', label: 'Title' },
          { name: 'due_date', label: 'Due Date', type: 'date' },
          { name: 'status', label: 'Status', type: 'select', opts: [{value:'pending',label:'Pending'},{value:'submitted',label:'Submitted'},{value:'late',label:'Late'},{value:'graded',label:'Graded'}] },
          { name: 'score', label: 'Score', type: 'number' }, { name: 'max_score', label: 'Max Score', type: 'number' },
          { name: 'feedback', label: 'Feedback', type: 'textarea' }
        ], { lead_id: L.id, status: 'pending' }, async (row) => { row.lead_id = L.id; await _saveEntity('assignments', row); }))),
      asst.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No assignments yet')
        : asst.map(r => h('div', { style: { padding: '8px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.title)),
              h('div', { style: { fontSize: '11px', color: '#64748b' } },
                'Due ' + fmtDate(r.due_date, 'short') + (r.score != null ? ' • Score ' + r.score + '/' + r.max_score : ''))),
            _pill(r.status.toUpperCase(), r.status === 'graded' ? '#16a34a' : r.status === 'late' ? '#dc2626' : '#3b82f6'),
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('assignments', r.id); _refresh(); } }))));

    const grouped = {};
    sched.forEach(r => { (grouped[r.day_of_week] = grouped[r.day_of_week] || []).push(r); });
    const schedBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '📆 Weekly Schedule'),
        _addBtn('Slot', () => _editModal('New Slot', [
          { name: 'day_of_week', label: 'Day', type: 'select', opts: DAYS.map((d,i)=>({value:i,label:d})) },
          { name: 'time_start', label: 'Start (HH:MM)', placeholder: '09:00' }, { name: 'time_end', label: 'End (HH:MM)', placeholder: '10:30' },
          { name: 'course_name', label: 'Course / Subject' }, { name: 'room', label: 'Room' },
          { name: 'type', label: 'Type', type: 'select', opts: [{value:'class',label:'Class'},{value:'lab',label:'Lab'},{value:'tutorial',label:'Tutorial'},{value:'exam',label:'Exam'}] }
        ], { lead_id: L.id, day_of_week: 1 }, async (row) => { row.lead_id = L.id; await _saveEntity('schedule', row); }))),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '4px' } },
        DAYS.map((d, idx) => {
          const items = grouped[idx] || [];
          return h('div', { style: { background: '#fff', borderRadius: '6px', padding: '6px', minHeight: '70px', border: '1px solid #e2e8f0' } },
            h('div', { style: { fontSize: '10px', fontWeight: '700', color: '#64748b', textAlign: 'center', borderBottom: '1px solid #e2e8f0', paddingBottom: '2px', marginBottom: '4px' } }, d),
            items.map(it => h('div', {
              style: { background: '#e0e7ff', padding: '4px 6px', borderRadius: '4px', margin: '3px 0', fontSize: '10px', cursor: 'pointer' },
              onclick: async () => { if (confirm('Delete this slot?')) { await _deleteEntity('schedule', it.id); _refresh(); } } },
              h('div', { style: { fontWeight: '700' } }, it.time_start + '–' + it.time_end),
              h('div', {}, esc(it.course_name || '')),
              it.room ? h('div', { style: { color: '#64748b' } }, esc(it.room)) : null)));
        })));

    const skillsBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '🎯 Skills'),
        _addBtn('Skill', () => _editModal('New Skill', [
          { name: 'name', label: 'Skill Name' },
          { name: 'level', label: 'Level (0-100)', type: 'number', min: 0, max: 100 },
          { name: 'category', label: 'Category' }, { name: 'color', label: 'Color', placeholder: '#3b82f6' }
        ], { lead_id: L.id, level: 50 }, async (row) => { row.lead_id = L.id; await _saveEntity('skills', row); }))),
      skills.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No skills tracked yet')
        : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            skills.map(r => h('div', {
              onclick: async () => { if (confirm('Remove "' + r.name + '"?')) { await _deleteEntity('skills', r.id); _refresh(); } },
              style: { background: r.color || '#dbeafe', color: '#1e3a8a', padding: '6px 12px', borderRadius: '999px',
                fontSize: '12px', fontWeight: '600', cursor: 'pointer' } }, esc(r.name) + ' · ' + r.level + '%'))));

    return _section('academics', '📚 Academics', null,
      h('div', {}, attBlock, testsBlock, asstBlock, schedBlock, skillsBlock));
  }

  // ── ENGAGEMENT (engagement + goals + achievements + scholarships) ─────
  function _renderEngagement() {
    const eng = DATA.engagement || [];
    const goals = DATA.goals || [];
    const ach = DATA.achievements || [];
    const sch = DATA.scholarships || [];
    const L = DATA.lead;

    const engBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { fontWeight: '700', fontSize: '13px', marginBottom: '8px' } }, '⏱ Study Engagement (90d)'),
      eng.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No engagement data')
        : h('div', { style: { fontSize: '13px' } },
            h('strong', {}, eng.reduce((s, e) => s + Number(e.hours_studied || 0), 0).toFixed(1) + ' hours'),
            ' across ', h('strong', {}, eng.length + ' active days')));

    const goalsBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '🎯 Goals'),
        _addBtn('Goal', () => _editModal('New Goal', [
          { name: 'goal_text', label: 'Goal' }, { name: 'target_date', label: 'Target', type: 'date' },
          { name: 'progress', label: 'Progress %', type: 'number', min: 0, max: 100 },
          { name: 'status', label: 'Status', type: 'select', opts: [{value:'active',label:'Active'},{value:'achieved',label:'Achieved'},{value:'dropped',label:'Dropped'}] }
        ], { lead_id: L.id, status: 'active' }, async (row) => { row.lead_id = L.id; await _saveEntity('goals', row); }))),
      goals.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No goals yet')
        : goals.map(r => h('div', { style: { padding: '8px 0', borderBottom: '1px solid #e2e8f0' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('div', { style: { flex: 1, fontWeight: '600', fontSize: '13px' } }, esc(r.goal_text)),
              _pill(r.status.toUpperCase(), r.status === 'achieved' ? '#16a34a' : r.status === 'dropped' ? '#94a3b8' : '#3b82f6'),
              _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('goals', r.id); _refresh(); } })),
            h('div', { style: { height: '6px', background: '#e2e8f0', borderRadius: '3px', marginTop: '6px' } },
              h('div', { style: { height: '100%', width: (Number(r.progress) || 0) + '%', background: '#3b82f6', borderRadius: '3px' } })),
            h('div', { style: { fontSize: '11px', color: '#64748b', marginTop: '4px' } },
              (r.progress || 0) + '% • target ' + fmtDate(r.target_date, 'short')))));

    const achBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '🎖 Achievements'),
        _addBtn('Add', () => _editModal('New Achievement', [
          { name: 'title', label: 'Title' }, { name: 'awarded_on', label: 'Awarded On', type: 'date' },
          { name: 'icon', label: 'Icon (emoji)', placeholder: '🏆' },
          { name: 'category', label: 'Category' }, { name: 'description', label: 'Description', type: 'textarea' }
        ], { lead_id: L.id }, async (row) => { row.lead_id = L.id; await _saveEntity('achievements', row); }))),
      ach.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No achievements yet')
        : ach.map(r => h('div', { style: { padding: '10px', background: 'linear-gradient(135deg,#fef3c7,#fde68a)', borderRadius: '8px', marginBottom: '6px', display: 'flex', gap: '10px' } },
            h('div', { style: { fontSize: '22px' } }, r.icon || '🏆'),
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '700', fontSize: '13px' } }, esc(r.title)),
              h('div', { style: { fontSize: '11px', color: '#78350f' } }, esc(r.description || '') + ' • ' + fmtDate(r.awarded_on, 'short'))),
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('achievements', r.id); _refresh(); } }))));

    const schBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '🏆 Scholarships'),
        _addBtn('Add', () => _editModal('New Scholarship', [
          { name: 'name', label: 'Name' }, { name: 'amount', label: 'Amount (₹)', type: 'number' },
          { name: 'status', label: 'Status', type: 'select', opts: [{value:'applied',label:'Applied'},{value:'awarded',label:'Awarded'},{value:'rejected',label:'Rejected'},{value:'expired',label:'Expired'}] },
          { name: 'awarded_at', label: 'Awarded On', type: 'date' }, { name: 'valid_until', label: 'Valid Until', type: 'date' }
        ], { lead_id: L.id, status: 'applied' }, async (row) => { row.lead_id = L.id; await _saveEntity('scholarships', row); }))),
      sch.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No scholarships')
        : sch.map(r => h('div', { style: { padding: '8px 0', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.name)),
              h('div', { style: { fontSize: '11px', color: '#64748b' } }, money(r.amount) + (r.valid_until ? ' • till ' + fmtDate(r.valid_until, 'short') : ''))),
            _pill(r.status.toUpperCase(), r.status === 'awarded' ? '#16a34a' : r.status === 'rejected' ? '#dc2626' : '#f59e0b'),
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('scholarships', r.id); _refresh(); } }))));

    return _section('engagement', '🔥 Engagement & Achievements', null,
      h('div', {}, engBlock, goalsBlock, achBlock, schBlock));
  }

  // ── FAMILY & MENTORS & DOCS ───────────────────────────────────────────
  function _renderFamily() {
    const fam = DATA.family || [];
    const ment = DATA.mentors || [];
    const docs = DATA.docs || [];
    const L = DATA.lead;

    const famBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '👨‍👩‍👧 Family Contacts'),
        _addBtn('Add', () => _editModal('New Family Member', [
          { name: 'name', label: 'Name' }, { name: 'relation', label: 'Relation', placeholder: 'Father, Mother…' },
          { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email' },
          { name: 'is_primary', label: 'Primary Contact', type: 'checkbox' }, { name: 'is_emergency', label: 'Emergency Contact', type: 'checkbox' }
        ], { lead_id: L.id }, async (row) => { row.lead_id = L.id; await _saveEntity('family', row); }))),
      fam.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No family contacts')
        : fam.map(r => h('div', { style: { padding: '8px 0', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.name) + (Number(r.is_primary) ? ' ⭐' : '') + (Number(r.is_emergency) ? ' 🚨' : '')),
              h('div', { style: { fontSize: '11px', color: '#64748b' } },
                esc(r.relation || '') + (r.phone ? ' • ' + esc(r.phone) : '') + (r.email ? ' • ' + esc(r.email) : ''))),
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('family', r.id); _refresh(); } }))));

    const mentBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px', marginBottom: '12px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '👨‍🏫 Mentors'),
        _addBtn('Add', () => _editModal('New Mentor', [
          { name: 'mentor_name', label: 'Mentor Name' }, { name: 'role', label: 'Role' }, { name: 'since', label: 'Since', type: 'date' }
        ], { lead_id: L.id }, async (row) => { row.lead_id = L.id; await _saveEntity('mentors', row); }))),
      ment.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No mentors')
        : ment.map(r => h('div', { style: { padding: '8px 0', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.user_name || r.mentor_name)),
              h('div', { style: { fontSize: '11px', color: '#64748b' } }, esc(r.role || '') + (r.since ? ' • since ' + fmtDate(r.since, 'short') : ''))),
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('mentors', r.id); _refresh(); } }))));

    const docsBlock = h('div', { style: { padding: '14px', background: '#f8fafc', borderRadius: '10px' } },
      h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
        h('div', { style: { fontWeight: '700', fontSize: '13px', flex: 1 } }, '📁 Documents Vault'),
        _addBtn('Add', () => _editModal('New Document', [
          { name: 'name', label: 'Document Name' }, { name: 'url', label: 'URL / Link' },
          { name: 'category', label: 'Category', placeholder: 'ID, Marksheet, Photo…' }, { name: 'verified', label: 'Verified', type: 'checkbox' }
        ], { lead_id: L.id }, async (row) => { row.lead_id = L.id; await _saveEntity('docs', row); }))),
      docs.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No documents')
        : docs.map(r => h('div', { style: { padding: '8px 0', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: '8px' } },
            h('span', { style: { fontSize: '18px' } }, '📄'),
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '600', fontSize: '13px' } },
                r.url ? h('a', { href: r.url, target: '_blank', style: { color: '#3b82f6' } }, esc(r.name)) : esc(r.name)),
              h('div', { style: { fontSize: '11px', color: '#64748b' } }, esc(r.category || '') + ' • ' + fmtDate(r.uploaded_at, 'short'))),
            Number(r.verified) === 1 ? _pill('VERIFIED', '#16a34a') : null,
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('docs', r.id); _refresh(); } }))));

    return _section('family', '👨‍👩‍👧 Family, Mentors & Documents', null,
      h('div', {}, famBlock, mentBlock, docsBlock));
  }

  // ── COMMUNICATIONS ────────────────────────────────────────────────────
  function _renderComms() {
    const rows = DATA.communications || [];
    return _section('comms', '💬 Communications', null,
      rows.length === 0 ? h('div', { style: { color: '#94a3b8', fontSize: '13px' } }, 'No comms logged yet')
        : h('div', { style: { maxHeight: '300px', overflowY: 'auto' } },
            rows.map(r => h('div', { style: { padding: '8px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' } },
              h('span', { style: { color: '#64748b', marginRight: '8px' } }, fmtDate(r.at, 'relative')),
              h('span', { style: { color: '#3b82f6', fontWeight: '700', marginRight: '8px' } },
                (r.channel === 'whatsapp' ? '💬' : r.channel === 'call' ? '☎️' : r.channel === 'email' ? '✉️' : '💬') + ' ' + r.channel),
              h('span', { style: { color: r.direction === 'in' ? '#16a34a' : '#64748b' } }, esc(r.summary || ''))))));
  }

  // ── Master render ─────────────────────────────────────────────────────
  function _renderPage() {
    if (!VIEW_EL || !DATA) return;
    VIEW_EL.innerHTML = '';

    // Compute derived fee totals
    const D = {
      feeBilled: (DATA.enrollments || []).reduce((acc, e) => acc + Number(e.total_amount || 0), 0),
      feePaid: (DATA.installments || []).reduce((acc, i) => acc + Number(i.paid_amount || 0), 0),
      feeDue: (DATA.installments || []).reduce((acc, i) =>
        (i.status || '').toLowerCase() !== 'paid'
          ? acc + (Number(i.amount || 0) - Number(i.paid_amount || 0)) : acc, 0),
      overdueCount: (DATA.installments || []).filter(i =>
        (i.status || '').toLowerCase() !== 'paid' && i.due_date && new Date(i.due_date) < new Date()).length
    };

    VIEW_EL.appendChild(_renderHeader(D));
    VIEW_EL.appendChild(_renderTabs());
    VIEW_EL.appendChild(_renderHero(D));
    const container = h('div', { style: { padding: '0 20px 40px', maxWidth: '1400px', margin: '0 auto' } },
      _renderProfile(),
      _renderFees(D),
      _renderAcademics(),
      _renderEngagement(),
      _renderFamily(),
      _renderComms(),
      _renderJourney()  // STU360_PAGE_v2_FIX2: moved Lead Journey to bottom per user request
    );
    VIEW_EL.appendChild(container);
  }

  // ── Patch openLeadModal delegation (kept for safety) ──────────────────
  function _maybeDelegate() {
    if (!window.openLeadModal || window._origOpenLeadModal) return;
    window._origOpenLeadModal = window.openLeadModal;
    window.openLeadModal = function (id) {
      try {
        const packs = window.CRM && window.CRM.installedPacks;
        const isEdu = packs && ((packs instanceof Set && packs.has('education')) || (Array.isArray(packs) && packs.includes('education')));
        if (isEdu && id) return window.openStudent360(id);
      } catch (_) {}
      return window._origOpenLeadModal.apply(this, arguments);
    };
  }
  if (window.openLeadModal) _maybeDelegate();
  else {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (window.openLeadModal) { _maybeDelegate(); clearInterval(iv); }
      else if (tries > 50) clearInterval(iv);
    }, 200);
  }
})();
