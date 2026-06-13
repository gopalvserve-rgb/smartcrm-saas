/* STU360_LIVE_v1 — Student 360 view (Education pack)
 *
 * Exposes window.openStudent360(leadId) which replaces the standard
 * Lead modal with a full V2 layout. Loaded only when industry pack
 * === 'education'. Reads everything from api_student360_get and
 * patches via api_student360_save / _delete / _riskCompute.
 *
 * Layout (mirrors Student_360_Mockup_v2.html):
 *   - Hero strip: photo + name + risk pill + 4 KPI tiles
 *   - AI banner (top-of-page insight)
 *   - Lead History journey funnel (pre-enrolment)
 *   - Profile (basic + extras)
 *   - Courses (enrollments) + Fees (installments)
 *   - Attendance (last 60d summary + bar)
 *   - Test Scores
 *   - Assignments
 *   - Schedule (weekly grid)
 *   - Skills cloud
 *   - Scholarships
 *   - Family contacts (student_family + edu_parents merged)
 *   - Mentors
 *   - Goals
 *   - Achievements
 *   - Documents vault
 *   - Communications hub (last 100)
 */
(function () {
  'use strict';

  // ── helpers (lazy — student360.js may load before app.js so capture by reference, not value)
  function h() { return window.h.apply(this, arguments); }
  function esc(v) { return (window.esc || (x => String(x ?? '')))(v); }
  function api() { return window.api.apply(this, arguments); }
  function fmtDate(v, o) { return (window.fmtDate || (x => x ? new Date(x).toLocaleDateString() : ''))(v, o); }

  function toast(msg, kind) {
    if (typeof window.toast === 'function') return window.toast(msg, kind);
    alert(msg);
  }

  const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // ── data store ────────────────────────────────────────────────────────
  // Held during a modal session; refetched on save.
  let DATA = null;
  let MODAL = null;

  async function _load(leadId) {
    DATA = await api('api_student360_get', leadId);
    if (!DATA || !DATA.ok) {
      toast('Could not load Student 360: ' + (DATA && DATA.error || 'unknown'), 'err');
      return null;
    }
    return DATA;
  }

  async function _saveEntity(entity, row) {
    return api('api_student360_save', { entity, row });
  }
  async function _deleteEntity(entity, id) {
    return api('api_student360_delete', { entity, id });
  }
  async function _refresh() {
    const id = DATA && DATA.lead && DATA.lead.id;
    if (!id) return;
    await _load(id);
    _rebuild();
  }

  // ── tiny edit modal helper ────────────────────────────────────────────
  // fields: [{name,label,type,opts}], onSave receives row
  function _editModal(title, fields, initial, onSave) {
    const overlay = h('div', { class: 'modal-backdrop',
      onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) overlay.remove(); }
    });
    const inputs = {};
    const body = h('div', { class: 'modal modal-md' },
      h('div', { class: 'modal-head' },
        h('h3', {}, title),
        h('button', { class: 'btn icon', onclick: () => overlay.remove() }, '✕')
      ),
      h('div', { class: 'modal-body', style: { padding: '14px 18px' } },
        fields.map(f => {
          let input;
          const v = initial[f.name] != null ? initial[f.name] : '';
          if (f.type === 'select') {
            input = h('select', { class: 'inp' },
              (f.opts || []).map(o =>
                h('option', { value: o.value, selected: String(o.value) === String(v) }, o.label)
              )
            );
          } else if (f.type === 'textarea') {
            input = h('textarea', { class: 'inp', rows: f.rows || 3 }, v);
          } else if (f.type === 'number') {
            input = h('input', { class: 'inp', type: 'number', value: v, min: f.min, max: f.max, step: f.step || 1 });
          } else if (f.type === 'date') {
            input = h('input', { class: 'inp', type: 'date', value: v ? String(v).slice(0,10) : '' });
          } else if (f.type === 'checkbox') {
            input = h('input', { type: 'checkbox', checked: Number(v) === 1 });
          } else {
            input = h('input', { class: 'inp', type: 'text', value: v, placeholder: f.placeholder || '' });
          }
          inputs[f.name] = input;
          return h('div', { style: { marginBottom: '12px' } },
            h('label', { style: { display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '4px', fontWeight: '600' } }, f.label),
            input
          );
        })
      ),
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
          try {
            await onSave(row);
            overlay.remove();
            await _refresh();
          } catch (e) {
            toast(e.message || 'Save failed', 'err');
          }
        } }, 'Save')
      )
    );
    overlay.appendChild(body);
    document.body.appendChild(overlay);
  }

  // ── section renderers ─────────────────────────────────────────────────

  function _renderHero() {
    const L = DATA.lead, P = DATA.profile || {};
    const risk = Number(P.risk_score || 0);
    const riskCls = risk >= 70 ? 'high' : risk >= 40 ? 'med' : 'low';
    const riskLabel = risk >= 70 ? 'AT RISK' : risk >= 40 ? 'WATCH' : 'HEALTHY';

    const attPct = (DATA.attendanceSummary && Number(DATA.attendanceSummary.total) > 0)
      ? Math.round((Number(DATA.attendanceSummary.present) / Number(DATA.attendanceSummary.total)) * 100)
      : null;
    const avgScore = (() => {
      const rows = DATA.testScores || [];
      if (!rows.length) return null;
      let sum = 0, n = 0;
      rows.forEach(r => {
        const mx = Number(r.max_marks);
        if (mx > 0) { sum += (Number(r.score) / mx) * 100; n++; }
      });
      return n > 0 ? Math.round(sum / n) : null;
    })();
    // Fee Due = ALL unpaid outstanding (covers 'due' + 'overdue' + anything not 'paid')
    const feeDue = (DATA.installments || []).reduce((acc, i) => {
      if ((i.status || '').toLowerCase() !== 'paid') {
        acc += Number(i.amount || 0) - Number(i.paid_amount || 0);
      }
      return acc;
    }, 0);
    const feePaid = (DATA.installments || []).reduce((acc, i) => acc + Number(i.paid_amount || 0), 0);
    const feeBilled = (DATA.enrollments || []).reduce((acc, e) => acc + Number(e.total_amount || 0), 0);
    const overdueCount = (DATA.installments || []).filter(i => {
      if ((i.status || '').toLowerCase() === 'paid') return false;
      return i.due_date && new Date(i.due_date) < new Date();
    }).length;
    DATA._derivedFees = { feeDue, feePaid, feeBilled, overdueCount };
    const engHrs = (DATA.engagement || []).reduce((s, e) => s + Number(e.hours_studied || 0), 0);

    const photo = P.photo_url
      ? h('img', { src: P.photo_url, style: { width: '88px', height: '88px', borderRadius: '50%', objectFit: 'cover', border: '3px solid #fff' } })
      : h('div', { style: { width: '88px', height: '88px', borderRadius: '50%',
          background: 'linear-gradient(135deg,#6366f1,#a855f7)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '32px', fontWeight: '700', border: '3px solid #fff' } },
        (L.name || '?').charAt(0).toUpperCase());

    return h('div', { class: 'stu-hero', style: {
      background: 'linear-gradient(135deg,#0f172a 0%,#1e293b 100%)',
      color: '#fff', padding: '20px 24px', borderRadius: '12px 12px 0 0' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '18px' } },
        photo,
        h('div', { style: { flex: '1', minWidth: 0 } },
          h('div', { style: { fontSize: '22px', fontWeight: '700' } }, L.name || 'Unnamed'),
          h('div', { style: { fontSize: '13px', opacity: '0.7', marginTop: '4px' } },
            (P.enrollment_no ? '🎓 ' + P.enrollment_no : '') +
            (P.batch_code ? '  •  Batch ' + P.batch_code : '') +
            (L.phone ? '  •  ' + L.phone : '')
          )
        ),
        h('div', { class: 'risk-pill ' + riskCls, style: {
          padding: '8px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: '700',
          background: riskCls === 'high' ? '#dc2626' : riskCls === 'med' ? '#f59e0b' : '#16a34a'
        } }, riskLabel + ' ' + risk + '/100'),
        h('button', { class: 'btn icon', onclick: async () => {
          await api('api_student360_riskCompute', L.id);
          await _refresh();
          toast('Risk score recomputed');
        }, title: 'Recompute risk', style: { background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', padding: '6px 10px' } }, '↻')
      ),
      // KPI strip
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '12px', marginTop: '18px' } },
        _kpi('Attendance', attPct == null ? '—' : attPct + '%', '#10b981'),
        _kpi('Avg Score', avgScore == null ? '—' : avgScore + '%', '#3b82f6'),
        _kpi('Fee Due', '₹' + (feeDue || 0).toLocaleString('en-IN'), feeDue > 0 ? '#f59e0b' : '#10b981'),
        _kpi('Study (90d)', engHrs.toFixed(1) + 'h', '#a855f7')
      )
    );
  }
  function _kpi(label, value, color) {
    return h('div', { style: {
      background: 'rgba(255,255,255,0.08)', padding: '12px 14px', borderRadius: '10px',
      borderLeft: '3px solid ' + color
    } },
      h('div', { style: { fontSize: '11px', opacity: '0.65', textTransform: 'uppercase', letterSpacing: '0.5px' } }, label),
      h('div', { style: { fontSize: '20px', fontWeight: '700', marginTop: '4px' } }, value)
    );
  }

  function _renderAiBanner() {
    const P = DATA.profile || {};
    let factors = {};
    try { factors = typeof P.risk_factors_json === 'string' ? JSON.parse(P.risk_factors_json) : (P.risk_factors_json || {}); } catch (_) {}
    const msg = (() => {
      const bits = [];
      if (factors.attendance_pct != null && factors.attendance_pct < 75)
        bits.push('attendance has slipped to ' + factors.attendance_pct + '%');
      if (factors.assignments_overdue > 0)
        bits.push(factors.assignments_overdue + ' overdue assignments');
      if (factors.fees_overdue > 0)
        bits.push(factors.fees_overdue + ' overdue installments');
      if (!bits.length) return 'Student is on track. Keep nudging engagement.';
      return 'Heads up: ' + bits.join(', ') + '. Consider a parent call.';
    })();
    return h('div', { style: {
      background: 'linear-gradient(135deg,#fef3c7,#fde68a)', padding: '12px 18px',
      borderLeft: '4px solid #f59e0b', margin: '0 16px', borderRadius: '8px', marginTop: '14px',
      display: 'flex', alignItems: 'center', gap: '12px'
    } },
      h('span', { style: { fontSize: '22px' } }, '✨'),
      h('div', { style: { flex: 1, fontSize: '13px', color: '#78350f' } }, msg)
    );
  }

  function _section(title, headerActions, body) {
    return h('div', { class: 'stu-sec', style: {
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: '10px',
      margin: '12px 0', overflow: 'hidden'
    } },
      h('div', { style: {
        display: 'flex', alignItems: 'center', padding: '12px 16px',
        borderBottom: '1px solid #e2e8f0', background: '#f8fafc'
      } },
        h('div', { style: { flex: 1, fontWeight: '700', fontSize: '14px', color: '#0f172a' } }, title),
        headerActions || ''
      ),
      h('div', { style: { padding: '14px 16px' } }, body)
    );
  }

  function _addBtn(label, onClick) {
    return h('button', { class: 'btn sm primary', onclick: onClick,
      style: { padding: '4px 10px', fontSize: '12px' } }, '+ ' + label);
  }
  function _delBtn(onClick) {
    return h('button', { class: 'btn icon sm', onclick: onClick, title: 'Delete',
      style: { color: '#ef4444' } }, '✕');
  }
  function _editBtn(onClick) {
    return h('button', { class: 'btn icon sm', onclick: onClick, title: 'Edit' }, '✎');
  }

  // ── Lead History (pre-enrolment + post-enrolment milestones) ──────────
  function _renderLeadHistory() {
    const created = DATA.lead.created_at;
    const acts = DATA.activity || [];
    const enrolls = DATA.enrollments || [];
    const firstEnroll = enrolls.length ? enrolls[enrolls.length - 1] : null;  // earliest = last in DESC order
    const insts = DATA.installments || [];
    const paidInsts = insts.filter(i => (i.status || '').toLowerCase() === 'paid');
    const lastPayment = paidInsts.length ? paidInsts[paidInsts.length - 1] : null;

    // Build the timeline events
    const events = [];
    events.push({ at: created, label: '🆕 Lead created', source: DATA.lead.source || 'Direct' });
    if (firstEnroll) {
      events.push({
        at: firstEnroll.created_at || firstEnroll.start_date,
        label: '🎓 Enrolled — ' + (firstEnroll.course_name || firstEnroll.plan_name || 'Course'),
        amount: '₹' + Number(firstEnroll.total_amount || 0).toLocaleString('en-IN')
      });
    }
    paidInsts.forEach(p => {
      events.push({
        at: p.paid_at || p.created_at,
        label: '💰 Installment #' + p.seq + ' paid',
        amount: '₹' + Number(p.paid_amount || 0).toLocaleString('en-IN')
      });
    });
    // Sort chronologically
    events.sort((a, b) => new Date(a.at) - new Date(b.at));

    const stages = ['New', 'Contacted', 'Qualified', 'Demo', 'Proposal', 'Enrolled'];
    const currentStage = firstEnroll ? 5 : 0;  // Enrolled if has enrollment, else stuck at New

    return _section('🔍 Lead Journey', null,
      h('div', {},
        // funnel chip strip
        h('div', { style: { display: 'flex', gap: '4px', marginBottom: '14px', overflowX: 'auto' } },
          stages.map((s, i) =>
            h('div', { style: {
              flex: '1', minWidth: '90px', padding: '8px 6px',
              background: i <= currentStage ? '#16a34a' : '#e0e7ff',
              color: i <= currentStage ? '#fff' : '#3730a3',
              borderRadius: '6px', textAlign: 'center', fontSize: '11px', fontWeight: '700'
            } }, (i+1) + '. ' + s)
          )
        ),
        // Summary line
        h('div', { style: { fontSize: '12px', color: '#64748b', marginBottom: '10px', padding: '8px 10px', background: '#f8fafc', borderRadius: '6px' } },
          h('span', { style: { fontWeight: '700', color: '#0f172a' } }, '📍 Source: '),
          esc(DATA.lead.source || 'Direct'),
          h('span', { style: { margin: '0 8px', color: '#cbd5e1' } }, '•'),
          h('span', { style: { fontWeight: '700', color: '#0f172a' } }, 'Created: '),
          fmtDate(created),
          firstEnroll ? [
            h('span', { style: { margin: '0 8px', color: '#cbd5e1' } }, '•'),
            h('span', { style: { fontWeight: '700', color: '#16a34a' } }, '🎓 Enrolled: '),
            fmtDate(firstEnroll.created_at || firstEnroll.start_date, 'short')
          ] : null
        ),
        // Milestone timeline (vertical)
        events.length > 0
          ? h('div', { style: { borderLeft: '2px solid #e2e8f0', paddingLeft: '14px', marginLeft: '6px' } },
              events.map(ev =>
                h('div', { style: { position: 'relative', marginBottom: '10px' } },
                  h('div', { style: { position: 'absolute', left: '-21px', top: '4px', width: '12px', height: '12px',
                    borderRadius: '50%', background: '#3b82f6', border: '2px solid #fff', boxShadow: '0 0 0 2px #3b82f6' } }),
                  h('div', { style: { fontSize: '11px', color: '#64748b' } }, fmtDate(ev.at)),
                  h('div', { style: { fontSize: '13px', fontWeight: '600', marginTop: '2px' } },
                    ev.label + (ev.amount ? ' — ' + ev.amount : '') + (ev.source ? ' from ' + ev.source : ''))
                )
              )
            )
          : null,
        // Recent activity table (collapsed)
        acts.length
          ? h('details', { style: { marginTop: '10px' } },
              h('summary', { style: { cursor: 'pointer', fontSize: '11px', color: '#64748b', fontWeight: '600' } },
                '▸ Show ' + acts.length + ' detailed activity events'),
              h('table', { style: { width: '100%', fontSize: '12px', marginTop: '6px' } },
                h('tbody', {},
                  acts.slice(0, 20).map(a =>
                    h('tr', {},
                      h('td', { style: { padding: '4px 6px', color: '#64748b', whiteSpace: 'nowrap' } }, fmtDate(a.at, 'relative')),
                      h('td', { style: { padding: '4px 6px', fontWeight: '600' } }, esc(a.activity_type || a.action_type || '')),
                      h('td', { style: { padding: '4px 6px', color: '#475569' } }, esc((a.detail || a.summary || '').slice(0, 80)))
                    )
                  )
                )
              )
            )
          : null
      )
    );
  }

  // ── Profile (basics + extras) ─────────────────────────────────────────
  function _renderProfile() {
    const L = DATA.lead, P = DATA.profile || {};
    const rows = [
      ['Phone', L.phone || '—'],
      ['Email', L.email || '—'],
      ['DOB', P.dob ? fmtDate(P.dob, 'short') : '—'],
      ['Gender', P.gender || '—'],
      ['Blood', P.blood_group || '—'],
      ['Grade', P.grade_level || '—'],
      ['Academic Yr', P.academic_year || '—'],
      ['Language', P.language_pref || '—'],
      ['Hostel Room', P.hostel_room || '—'],
      ['Emergency', P.emergency_contact || '—']
    ];
    return _section('👤 Profile',
      _editBtn(() => _editModal('Edit Student Profile',
        [
          { name: 'dob', label: 'Date of Birth', type: 'date' },
          { name: 'gender', label: 'Gender', type: 'select', opts: [
              {value:'',label:'—'},{value:'male',label:'Male'},{value:'female',label:'Female'},{value:'other',label:'Other'} ] },
          { name: 'blood_group', label: 'Blood Group', type: 'text' },
          { name: 'photo_url', label: 'Photo URL', type: 'text' },
          { name: 'address', label: 'Address', type: 'textarea' },
          { name: 'emergency_contact', label: 'Emergency Contact', type: 'text' },
          { name: 'hostel_room', label: 'Hostel Room', type: 'text' },
          { name: 'enrollment_no', label: 'Enrollment #', type: 'text' },
          { name: 'batch_code', label: 'Batch Code', type: 'text' },
          { name: 'academic_year', label: 'Academic Year', type: 'text' },
          { name: 'grade_level', label: 'Grade / Class', type: 'text' },
          { name: 'language_pref', label: 'Language', type: 'text' },
          { name: 'bio', label: 'Short Bio', type: 'textarea' }
        ],
        Object.assign({ lead_id: L.id }, P),
        async (row) => { row.lead_id = L.id; await _saveEntity('profile_extras', row); }
      )),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '8px 18px' } },
        rows.map(([k, v]) =>
          h('div', { style: { display: 'flex', justifyContent: 'space-between', borderBottom: '1px dotted #e2e8f0', padding: '4px 0' } },
            h('span', { style: { color: '#64748b', fontSize: '12px' } }, k),
            h('span', { style: { fontWeight: '600', fontSize: '12px' } }, v)
          )
        )
      ),
      P.bio ? h('div', { style: { marginTop: '12px', padding: '10px', background: '#f8fafc', borderRadius: '6px', fontSize: '12px', color: '#475569', fontStyle: 'italic' } }, '“' + esc(P.bio) + '”') : null
    );
  }

  // ── Courses + Fees ────────────────────────────────────────────────────
  function _renderCoursesFees() {
    const enrolls = DATA.enrollments || [];
    const insts = DATA.installments || [];
    const D = DATA._derivedFees || { feeBilled: 0, feePaid: 0, feeDue: 0, overdueCount: 0 };
    const _money = v => '₹' + Number(v || 0).toLocaleString('en-IN');
    // Billed / Paid / Pending mini summary
    const summary = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '8px', marginBottom: '12px' } },
      h('div', { style: { padding: '10px 12px', background: '#f8fafc', borderRadius: '8px', borderLeft: '3px solid #3b82f6' } },
        h('div', { style: { fontSize: '10px', color: '#64748b', fontWeight: '600', textTransform: 'uppercase' } }, 'Total Billed'),
        h('div', { style: { fontSize: '16px', fontWeight: '700', marginTop: '2px' } }, _money(D.feeBilled))),
      h('div', { style: { padding: '10px 12px', background: '#f0fdf4', borderRadius: '8px', borderLeft: '3px solid #16a34a' } },
        h('div', { style: { fontSize: '10px', color: '#15803d', fontWeight: '600', textTransform: 'uppercase' } }, 'Paid'),
        h('div', { style: { fontSize: '16px', fontWeight: '700', marginTop: '2px', color: '#16a34a' } }, _money(D.feePaid))),
      h('div', { style: { padding: '10px 12px', background: D.feeDue > 0 ? '#fef2f2' : '#f0fdf4', borderRadius: '8px',
                          borderLeft: '3px solid ' + (D.feeDue > 0 ? '#dc2626' : '#16a34a') } },
        h('div', { style: { fontSize: '10px', color: D.feeDue > 0 ? '#991b1b' : '#15803d', fontWeight: '600', textTransform: 'uppercase' } }, 'Pending'),
        h('div', { style: { fontSize: '16px', fontWeight: '700', marginTop: '2px', color: D.feeDue > 0 ? '#dc2626' : '#16a34a' } }, _money(D.feeDue) + (D.overdueCount ? '  ⚠' : '')))
    );

    return _section('📚 Courses & Fees', null,
      h('div', {},
        summary,
        enrolls.length === 0
          ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No enrollments yet — use the Education pack 💰 Fees tab to enrol.')
          : enrolls.map(e =>
              h('div', { style: { padding: '12px', background: '#f8fafc', borderRadius: '8px', marginBottom: '8px' } },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('div', {},
                    h('div', { style: { fontWeight: '700', fontSize: '14px' } }, e.course_name || e.plan_name || 'Course'),
                    h('div', { style: { fontSize: '11px', color: '#64748b', marginTop: '2px' } },
                      (e.batch_name ? '🎓 ' + e.batch_name + '  •  ' : '') +
                      (e.start_date ? 'Enrolled ' + fmtDate(e.start_date, 'short') : 'Enrolled ' + fmtDate(e.created_at, 'short')))
                  ),
                  h('div', { style: { textAlign: 'right' } },
                    h('div', { style: { fontWeight: '700', fontSize: '14px' } }, _money(e.total_amount)),
                    _pill(e.status || 'active', e.status === 'cancelled' ? '#94a3b8' : e.status === 'completed' ? '#16a34a' : '#3b82f6')
                  )
                )
              )
            ),
        // Installment timeline — always show if any rows exist
        insts.length > 0
          ? h('div', { style: { marginTop: '8px' } },
              h('div', { style: { fontSize: '11px', color: '#64748b', fontWeight: '600', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.3px' } },
                '📅 Installment Timeline (' + insts.length + ')'),
              h('table', { style: { width: '100%', fontSize: '12px', borderCollapse: 'collapse' } },
                h('thead', {},
                  h('tr', {},
                    ['#', 'Due Date', 'Amount', 'Paid', 'Outstanding', 'Status', ''].map(k =>
                      h('th', { style: { textAlign: 'left', padding: '6px', borderBottom: '1px solid #e2e8f0', color: '#64748b', fontSize: '10px', textTransform: 'uppercase' } }, k))
                  )
                ),
                h('tbody', {},
                  insts.map(i => {
                    const isOverdue = (i.status || '').toLowerCase() !== 'paid' && i.due_date && new Date(i.due_date) < new Date();
                    const out = Number(i.amount || 0) - Number(i.paid_amount || 0);
                    const statusColor = (i.status === 'paid') ? '#16a34a' : isOverdue ? '#dc2626' : '#f59e0b';
                    const statusText = (i.status === 'paid') ? 'PAID' : isOverdue ? 'OVERDUE' : 'DUE';
                    return h('tr', { style: isOverdue ? { background: '#fef2f2' } : {} },
                      h('td', { style: { padding: '6px', fontWeight: '600' } }, i.seq),
                      h('td', { style: { padding: '6px' } }, fmtDate(i.due_date, 'short')),
                      h('td', { style: { padding: '6px' } }, _money(i.amount)),
                      h('td', { style: { padding: '6px', color: '#16a34a' } }, _money(i.paid_amount)),
                      h('td', { style: { padding: '6px', fontWeight: '600', color: out > 0 ? '#dc2626' : '#16a34a' } }, _money(out)),
                      h('td', { style: { padding: '6px' } }, _pill(statusText, statusColor)),
                      h('td', { style: { padding: '6px' } },
                        out > 0 ? h('button', { class: 'btn sm', style: { padding: '2px 8px', fontSize: '10px' },
                          onclick: async () => {
                            if (!confirm('Mark installment #' + i.seq + ' as PAID (₹' + Number(out).toLocaleString('en-IN') + ')?')) return;
                            try {
                              await api('api_edu_installment_markPaid', { id: i.id, amount: out });
                              await _refresh();
                            } catch (e) { alert(e.message || 'Mark paid failed'); }
                          } }, '✍ Mark Paid') : null
                      )
                    );
                  })
                )
              )
            )
          : h('div', { style: { color: '#94a3b8', fontSize: '12px', fontStyle: 'italic', marginTop: '8px' } }, 'No installment schedule generated yet.')
      )
    );
  }

  // ── Attendance ────────────────────────────────────────────────────────
  function _renderAttendance() {
    const s = DATA.attendanceSummary || {};
    const total = Number(s.total || 0);
    const pct = total > 0 ? Math.round((Number(s.present) / total) * 100) : 0;
    const cells = (DATA.attendance || []).slice(0, 30).reverse();
    return _section('📅 Attendance (last 60 days)', null,
      h('div', {},
        h('div', { style: { display: 'flex', gap: '14px', marginBottom: '12px', fontSize: '12px' } },
          h('div', {}, h('strong', {}, total), ' marked'),
          h('div', { style: { color: '#16a34a' } }, h('strong', {}, s.present || 0), ' present'),
          h('div', { style: { color: '#dc2626' } }, h('strong', {}, s.absent || 0), ' absent'),
          h('div', {}, h('strong', {}, pct + '%'), ' attendance')
        ),
        cells.length
          ? h('div', { style: { display: 'flex', gap: '3px', flexWrap: 'wrap' } },
              cells.map(c => h('div', {
                title: c.date + ' — ' + c.status,
                style: { width: '14px', height: '14px', borderRadius: '3px',
                  background: c.status === 'present' ? '#16a34a' : c.status === 'late' ? '#f59e0b' : c.status === 'absent' ? '#dc2626' : '#cbd5e1' }
              }))
            )
          : h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No attendance marked yet')
      )
    );
  }

  // ── Test Scores ───────────────────────────────────────────────────────
  function _renderTests() {
    const rows = DATA.testScores || [];
    return _section('📝 Test Scores', null,
      rows.length === 0
        ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No tests recorded yet')
        : h('table', { style: { width: '100%', fontSize: '12px' } },
            h('tbody', {},
              rows.map(r => {
                const pct = Number(r.max_marks) > 0 ? Math.round((Number(r.score) / Number(r.max_marks)) * 100) : null;
                return h('tr', {},
                  h('td', { style: { padding: '6px', fontWeight: '600' } }, esc(r.test_title || 'Test')),
                  h('td', { style: { padding: '6px', color: '#64748b' } }, fmtDate(r.test_date, 'short')),
                  h('td', { style: { padding: '6px' } }, r.score + ' / ' + r.max_marks),
                  h('td', { style: { padding: '6px' } }, pct == null ? '' : _pill(pct + '%', pct >= 75 ? '#16a34a' : pct >= 50 ? '#f59e0b' : '#dc2626'))
                );
              })
            )
          )
    );
  }

  // ── Assignments ───────────────────────────────────────────────────────
  function _renderAssignments() {
    const rows = DATA.assignments || [];
    const L = DATA.lead;
    return _section('📋 Assignments',
      _addBtn('Assignment', () => _editModal('New Assignment',
        [
          { name: 'title', label: 'Title' },
          { name: 'due_date', label: 'Due Date', type: 'date' },
          { name: 'status', label: 'Status', type: 'select', opts: [
              {value:'pending',label:'Pending'},{value:'submitted',label:'Submitted'},
              {value:'late',label:'Late'},{value:'graded',label:'Graded'} ] },
          { name: 'score', label: 'Score', type: 'number' },
          { name: 'max_score', label: 'Max Score', type: 'number' },
          { name: 'feedback', label: 'Feedback', type: 'textarea' }
        ],
        { lead_id: L.id, status: 'pending' },
        async (row) => { row.lead_id = L.id; await _saveEntity('assignments', row); }
      )),
      rows.length === 0
        ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No assignments yet')
        : h('div', {},
            rows.map(r => h('div', { style: { padding: '8px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' } },
              h('div', { style: { flex: 1 } },
                h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.title)),
                h('div', { style: { fontSize: '11px', color: '#64748b' } },
                  'Due ' + fmtDate(r.due_date, 'short') +
                  (r.score != null ? ' • Score ' + r.score + '/' + r.max_score : '')
                )
              ),
              _pill(r.status, r.status === 'graded' ? '#16a34a' : r.status === 'late' ? '#dc2626' : '#3b82f6'),
              _delBtn(async () => { if (confirm('Delete assignment?')) { await _deleteEntity('assignments', r.id); _refresh(); } })
            ))
          )
    );
  }

  // ── Schedule ──────────────────────────────────────────────────────────
  function _renderSchedule() {
    const rows = DATA.schedule || [];
    const L = DATA.lead;
    const grouped = {};
    rows.forEach(r => { (grouped[r.day_of_week] = grouped[r.day_of_week] || []).push(r); });
    return _section('📆 Weekly Schedule',
      _addBtn('Slot', () => _editModal('New Schedule Slot',
        [
          { name: 'day_of_week', label: 'Day', type: 'select', opts: DAYS.map((d,i)=>({value:i,label:d})) },
          { name: 'time_start', label: 'Start (HH:MM)', placeholder: '09:00' },
          { name: 'time_end', label: 'End (HH:MM)', placeholder: '10:30' },
          { name: 'course_name', label: 'Course / Subject' },
          { name: 'room', label: 'Room' },
          { name: 'type', label: 'Type', type: 'select', opts: [
            {value:'class',label:'Class'},{value:'lab',label:'Lab'},{value:'tutorial',label:'Tutorial'},{value:'exam',label:'Exam'} ] }
        ],
        { lead_id: L.id, day_of_week: 1 },
        async (row) => { row.lead_id = L.id; await _saveEntity('schedule', row); }
      )),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: '4px' } },
        DAYS.map((d, idx) => {
          const items = grouped[idx] || [];
          return h('div', { style: { background: '#f8fafc', borderRadius: '6px', padding: '6px', minHeight: '80px' } },
            h('div', { style: { fontSize: '11px', fontWeight: '700', color: '#64748b' } }, d),
            items.map(it => h('div', {
              style: { background: '#e0e7ff', padding: '4px 6px', borderRadius: '4px', margin: '4px 0', fontSize: '10px', cursor: 'pointer' },
              onclick: async () => { if (confirm('Delete this slot?')) { await _deleteEntity('schedule', it.id); _refresh(); } }
            },
              h('div', { style: { fontWeight: '700' } }, it.time_start + '–' + it.time_end),
              h('div', {}, esc(it.course_name || '')),
              it.room ? h('div', { style: { color: '#64748b' } }, esc(it.room)) : null
            ))
          );
        })
      )
    );
  }

  // ── Skills cloud ──────────────────────────────────────────────────────
  function _renderSkills() {
    const rows = DATA.skills || [];
    const L = DATA.lead;
    return _section('🎯 Skills',
      _addBtn('Skill', () => _editModal('New Skill',
        [
          { name: 'name', label: 'Skill Name' },
          { name: 'level', label: 'Level (0-100)', type: 'number', min: 0, max: 100 },
          { name: 'category', label: 'Category', placeholder: 'e.g. Coding, Maths, Soft' },
          { name: 'color', label: 'Color', placeholder: '#3b82f6' }
        ],
        { lead_id: L.id, level: 50 },
        async (row) => { row.lead_id = L.id; await _saveEntity('skills', row); }
      )),
      rows.length === 0
        ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No skills tracked yet')
        : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            rows.map(r => h('div', {
              onclick: async () => { if (confirm('Remove "' + r.name + '" skill?')) { await _deleteEntity('skills', r.id); _refresh(); } },
              style: {
                background: r.color || '#dbeafe',
                color: '#1e3a8a',
                padding: '6px 12px', borderRadius: '999px',
                fontSize: '12px', fontWeight: '600', cursor: 'pointer',
                border: '1px solid rgba(0,0,0,0.05)'
              }
            }, esc(r.name) + ' · ' + r.level + '%'))
          )
    );
  }

  // ── Scholarships ──────────────────────────────────────────────────────
  function _renderScholarships() {
    const rows = DATA.scholarships || [];
    const L = DATA.lead;
    return _section('🏆 Scholarships',
      _addBtn('Scholarship', () => _editModal('New Scholarship',
        [
          { name: 'name', label: 'Name' },
          { name: 'amount', label: 'Amount (₹)', type: 'number' },
          { name: 'status', label: 'Status', type: 'select', opts: [
              {value:'applied',label:'Applied'},{value:'awarded',label:'Awarded'},
              {value:'rejected',label:'Rejected'},{value:'expired',label:'Expired'} ] },
          { name: 'awarded_at', label: 'Awarded On', type: 'date' },
          { name: 'valid_until', label: 'Valid Until', type: 'date' }
        ],
        { lead_id: L.id, status: 'applied' },
        async (row) => { row.lead_id = L.id; await _saveEntity('scholarships', row); }
      )),
      rows.length === 0
        ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No scholarships')
        : rows.map(r => h('div', { style: { padding: '8px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' } },
            h('div', { style: { flex: 1 } },
              h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.name)),
              h('div', { style: { fontSize: '11px', color: '#64748b' } },
                '₹' + Number(r.amount).toLocaleString('en-IN') +
                (r.valid_until ? ' • till ' + fmtDate(r.valid_until, 'short') : '')
              )
            ),
            _pill(r.status, r.status === 'awarded' ? '#16a34a' : r.status === 'rejected' ? '#dc2626' : '#f59e0b'),
            _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('scholarships', r.id); _refresh(); } })
          ))
    );
  }

  // ── Family + Mentors + Goals + Achievements + Docs (compact list pattern)
  function _listSection(title, entity, rows, fields, makeRow) {
    const L = DATA.lead;
    return _section(title,
      _addBtn(entity, () => _editModal('New', fields, { lead_id: L.id },
        async (row) => { row.lead_id = L.id; await _saveEntity(entity, row); })),
      rows.length === 0
        ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'None yet')
        : rows.map(r => makeRow(r))
    );
  }

  function _renderFamily() {
    return _listSection('👨‍👩‍👧 Family',
      'family', DATA.family || [],
      [
        { name: 'name', label: 'Name' },
        { name: 'relation', label: 'Relation', placeholder: 'Father, Mother, etc.' },
        { name: 'phone', label: 'Phone' },
        { name: 'email', label: 'Email' },
        { name: 'is_primary', label: 'Primary Contact', type: 'checkbox' },
        { name: 'is_emergency', label: 'Emergency Contact', type: 'checkbox' }
      ],
      r => h('div', { style: { padding: '8px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.name) + (Number(r.is_primary) ? ' ⭐' : '')),
          h('div', { style: { fontSize: '11px', color: '#64748b' } },
            esc(r.relation || '') + (r.phone ? ' • ' + esc(r.phone) : '') + (r.email ? ' • ' + esc(r.email) : ''))
        ),
        _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('family', r.id); _refresh(); } })
      )
    );
  }

  function _renderMentors() {
    return _listSection('👨‍🏫 Mentors',
      'mentors', DATA.mentors || [],
      [
        { name: 'mentor_name', label: 'Mentor Name' },
        { name: 'role', label: 'Role', placeholder: 'Class Teacher, Academic Coach…' },
        { name: 'since', label: 'Since', type: 'date' }
      ],
      r => h('div', { style: { padding: '8px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: '600', fontSize: '13px' } }, esc(r.user_name || r.mentor_name)),
          h('div', { style: { fontSize: '11px', color: '#64748b' } }, esc(r.role || '') + (r.since ? ' • since ' + fmtDate(r.since, 'short') : ''))
        ),
        _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('mentors', r.id); _refresh(); } })
      )
    );
  }

  function _renderGoals() {
    return _listSection('🎯 Goals',
      'goals', DATA.goals || [],
      [
        { name: 'goal_text', label: 'Goal' },
        { name: 'target_date', label: 'Target', type: 'date' },
        { name: 'progress', label: 'Progress %', type: 'number', min: 0, max: 100 },
        { name: 'status', label: 'Status', type: 'select', opts: [
            {value:'active',label:'Active'},{value:'achieved',label:'Achieved'},{value:'dropped',label:'Dropped'} ] }
      ],
      r => h('div', { style: { padding: '8px', borderBottom: '1px solid #f1f5f9' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('div', { style: { flex: 1, fontWeight: '600', fontSize: '13px' } }, esc(r.goal_text)),
          _pill(r.status, r.status === 'achieved' ? '#16a34a' : r.status === 'dropped' ? '#94a3b8' : '#3b82f6'),
          _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('goals', r.id); _refresh(); } })
        ),
        h('div', { style: { height: '6px', background: '#e2e8f0', borderRadius: '3px', marginTop: '6px' } },
          h('div', { style: { height: '100%', width: (Number(r.progress) || 0) + '%', background: '#3b82f6', borderRadius: '3px' } })
        ),
        h('div', { style: { fontSize: '11px', color: '#64748b', marginTop: '4px' } },
          (r.progress || 0) + '% • target ' + fmtDate(r.target_date, 'short'))
      )
    );
  }

  function _renderAchievements() {
    return _listSection('🎖 Achievements',
      'achievements', DATA.achievements || [],
      [
        { name: 'title', label: 'Title' },
        { name: 'awarded_on', label: 'Awarded On', type: 'date' },
        { name: 'icon', label: 'Icon (emoji)', placeholder: '🏆' },
        { name: 'category', label: 'Category' },
        { name: 'description', label: 'Description', type: 'textarea' }
      ],
      r => h('div', { style: { padding: '10px', background: '#fef3c7', borderRadius: '6px', marginBottom: '6px', display: 'flex', gap: '10px' } },
        h('div', { style: { fontSize: '22px' } }, r.icon || '🏆'),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: '700', fontSize: '13px' } }, esc(r.title)),
          h('div', { style: { fontSize: '11px', color: '#78350f' } }, esc(r.description || '') + ' • ' + fmtDate(r.awarded_on, 'short'))
        ),
        _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('achievements', r.id); _refresh(); } })
      )
    );
  }

  function _renderDocs() {
    return _listSection('📁 Documents Vault',
      'docs', DATA.docs || [],
      [
        { name: 'name', label: 'Document Name' },
        { name: 'url', label: 'URL / Link' },
        { name: 'category', label: 'Category', placeholder: 'ID, Marksheet, Photo…' },
        { name: 'verified', label: 'Verified', type: 'checkbox' }
      ],
      r => h('div', { style: { padding: '8px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: '8px' } },
        h('span', { style: { fontSize: '18px' } }, '📄'),
        h('div', { style: { flex: 1 } },
          h('div', { style: { fontWeight: '600', fontSize: '13px' } },
            r.url
              ? h('a', { href: r.url, target: '_blank', style: { color: '#3b82f6' } }, esc(r.name))
              : esc(r.name)
          ),
          h('div', { style: { fontSize: '11px', color: '#64748b' } },
            esc(r.category || '') + ' • ' + fmtDate(r.uploaded_at, 'short'))
        ),
        Number(r.verified) === 1 ? _pill('Verified', '#16a34a') : null,
        _delBtn(async () => { if (confirm('Delete?')) { await _deleteEntity('docs', r.id); _refresh(); } })
      )
    );
  }

  function _renderComms() {
    const rows = DATA.communications || [];
    return _section('💬 Communications', null,
      rows.length === 0
        ? h('div', { style: { color: '#94a3b8', fontSize: '12px' } }, 'No comms logged yet')
        : h('div', { style: { maxHeight: '220px', overflowY: 'auto' } },
            rows.map(r => h('div', { style: { padding: '6px 0', borderBottom: '1px solid #f1f5f9', fontSize: '12px' } },
              h('span', { style: { color: '#64748b', marginRight: '6px' } }, fmtDate(r.at, 'relative')),
              h('span', { style: { color: '#3b82f6', fontWeight: '600', marginRight: '6px' } },
                (r.channel === 'whatsapp' ? '💬' : r.channel === 'call' ? '☎️' : r.channel === 'email' ? '✉️' : '💬') + ' ' + r.channel),
              h('span', { style: { color: r.direction === 'in' ? '#16a34a' : '#64748b' } }, esc(r.summary || ''))
            ))
          )
    );
  }

  function _pill(text, color) {
    return h('span', { style: {
      display: 'inline-block', padding: '2px 8px', borderRadius: '999px',
      fontSize: '10px', fontWeight: '700', background: color, color: '#fff'
    } }, text);
  }

  // ── master rebuild ────────────────────────────────────────────────────
  function _rebuild() {
    if (!MODAL || !DATA) return;
    const container = MODAL.querySelector('.stu-body');
    container.innerHTML = '';
    container.appendChild(_renderHero());
    container.appendChild(_renderAiBanner());
    // 2-column grid for body
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', padding: '0 16px 16px' } });
    // left column
    const left = h('div', {},
      _renderLeadHistory(),
      _renderProfile(),
      _renderCoursesFees(),
      _renderAttendance(),
      _renderTests(),
      _renderAssignments(),
      _renderSchedule()
    );
    // right column
    const right = h('div', {},
      _renderSkills(),
      _renderScholarships(),
      _renderFamily(),
      _renderMentors(),
      _renderGoals(),
      _renderAchievements(),
      _renderDocs(),
      _renderComms()
    );
    grid.appendChild(left);
    grid.appendChild(right);
    container.appendChild(grid);

    // Responsive: single column under 900px
    if (MODAL.offsetWidth < 900) grid.style.gridTemplateColumns = '1fr';
  }

  // ── public entrypoint ─────────────────────────────────────────────────
  window.openStudent360 = async function (leadId) {
    console.log('[STU360] openStudent360 called with leadId=', leadId);
    if (!leadId) {
      // Falling back to regular new-lead modal for "+ New Lead" clicks
      if (typeof window._origOpenLeadModal === 'function') return window._origOpenLeadModal();
      return;
    }
    if (!window.h || !window.api) {
      alert('Student 360 cannot load yet — try refreshing the page.');
      return;
    }
    try {
      return await _openStudent360Inner(leadId);
    } catch (err) {
      console.error('[STU360] error', err);
      alert('Student 360 error: ' + (err && err.message || err));
    }
  };

  async function _openStudent360Inner(leadId) {
    const overlay = h('div', { class: 'modal-backdrop',
      onclick: ev => { if (ev.target.classList.contains('modal-backdrop')) overlay.remove(); } });
    const wrap = h('div', { class: 'modal modal-xl', style: {
      width: '95vw', maxWidth: '1280px', height: '92vh', display: 'flex', flexDirection: 'column'
    } });
    wrap.appendChild(h('div', { class: 'modal-head', style: { padding: '10px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center' } },
      h('h3', { style: { margin: 0, flex: 1, fontSize: '15px' } }, '🎓 Student 360'),
      h('button', { class: 'btn icon', onclick: () => overlay.remove() }, '✕')
    ));
    const body = h('div', { class: 'stu-body', style: { flex: 1, overflowY: 'auto', background: '#f1f5f9' } },
      h('div', { style: { padding: '40px', textAlign: 'center', color: '#64748b' } }, 'Loading Student 360…')
    );
    wrap.appendChild(body);
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);
    MODAL = wrap;
    const d = await _load(leadId);
    if (!d) { overlay.remove(); return; }
    _rebuild();
  }

  // ── delegate openLeadModal when industry pack === 'education' ─────────
  function _maybeDelegate() {
    if (!window.openLeadModal || window._origOpenLeadModal) return;
    window._origOpenLeadModal = window.openLeadModal;
    window.openLeadModal = function (id) {
      try {
        const packs = window.CRM && window.CRM.installedPacks;
        const isEdu = packs && (
          (packs instanceof Set && packs.has('education')) ||
          (Array.isArray(packs) && packs.includes('education'))
        );
        if (isEdu && id) return window.openStudent360(id);
      } catch (_) {}
      return window._origOpenLeadModal.apply(this, arguments);
    };
  }
  // Patch as soon as app.js has loaded; retry until ready
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
