/* ============================================================================
 * HOLIDAY_PACK_v1 — isolated SPA module (2026-06-27)
 *
 * Loaded by public/tenant/index.html as a second <script> after app.js.
 * All Holiday/Travel pack VIEWS live here so app.js never grows.
 *
 * What's inside:
 *   - VIEWS.packholiday      (Overview — KPI dashboard + Seed button)
 *   - VIEWS.tourbookings     (Bookings list — filterable, click into detail)
 *   - VIEWS.tourdestinations (Destinations catalog)
 *   - VIEWS.touritinerary    (Itinerary Builder — day-by-day plan)
 *   - VIEWS.tourpayments     (Payments & Collection — outstanding tracker)
 *   - VIEWS.tourreports      (Upcoming / Collection / Itinerary status / Leaderboard)
 *   - VIEWS.tourinsights     (AI Insights — rule-based)
 *
 * Backend APIs live in routes/packs/holiday.js
 * ============================================================================ */

(function () {
  'use strict';

  function ready(fn) {
    if (window.VIEWS && window.api && window.h) return fn();
    setTimeout(() => ready(fn), 60);
  }

  ready(function () {
    const VIEWS = window.VIEWS;
    const api   = window.api;
    const h     = window.h;
    const toast = window.toast || function (m) { console.log(m); };

    const TEAL  = '#0d9488';
    const TEAL2 = '#0f766e';

    function fmtINR(n) {
      const v = Number(n || 0);
      if (v >= 10000000) return '₹' + (v / 10000000).toFixed(2) + ' Cr';
      if (v >= 100000)   return '₹' + (v / 100000).toFixed(2) + ' L';
      return '₹' + Math.round(v).toLocaleString('en-IN');
    }
    function fmtINRfull(n) { return '₹' + Math.round(Number(n || 0)).toLocaleString('en-IN'); }
    function num(n) { return Number(n || 0).toLocaleString('en-IN'); }

    function kpiTile(label, val, sub, color) {
      color = color || TEAL;
      return h('div', { style: {
        background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px',
        padding: '12px 14px', minWidth: '140px', flex: '1', position: 'relative',
        overflow: 'hidden', borderTop: '3px solid ' + color
      } },
        h('div', { style: { fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '.4px', fontWeight: 600 } }, label),
        h('div', { style: { fontSize: '22px', fontWeight: 700, marginTop: '4px', color: '#0f172a' } }, String(val)),
        h('div', { style: { fontSize: '11.5px', marginTop: '4px', color: '#64748b' } }, sub || '')
      );
    }

    function pill(text, kind) {
      const map = {
        ok:     { bg: '#ecfdf5', fg: '#15803d' },
        warn:   { bg: '#fffbeb', fg: '#b45309' },
        bad:    { bg: '#fef2f2', fg: '#dc2626' },
        info:   { bg: '#eff6ff', fg: '#1d4ed8' },
        purple: { bg: '#faf5ff', fg: '#7e22ce' },
        gray:   { bg: '#f1f5f9', fg: '#475569' },
        teal:   { bg: '#f0fdfa', fg: '#0d9488' }
      };
      const c = map[kind] || map.gray;
      return h('span', { style: {
        background: c.bg, color: c.fg, padding: '2px 8px', borderRadius: '99px',
        fontSize: '11px', fontWeight: 600, display: 'inline-block'
      } }, text);
    }

    function btn(label, onclick, kind) {
      const isPrimary = kind === 'primary';
      const style = isPrimary
        ? { background: 'linear-gradient(135deg,#14b8a6,#0d9488)', color: '#fff',
            border: 0, padding: '7px 12px', borderRadius: '7px', fontWeight: 600,
            fontSize: '12.5px', cursor: 'pointer' }
        : { background: '#fff', border: '1px solid #ccfbf1', color: '#0f172a',
            padding: '7px 12px', borderRadius: '7px', fontWeight: 600,
            fontSize: '12.5px', cursor: 'pointer' };
      return h('button', { style, onclick }, label);
    }

    function topbar(crumb, title, actions) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '14px', paddingBottom: '12px',
        borderBottom: '1px solid #ccfbf1' } },
        h('div', {},
          h('div', { style: { fontSize: '12px', color: '#64748b' } }, crumb),
          h('h1', { style: { fontSize: '20px', margin: '4px 0 0' } }, title)
        ),
        h('div', { style: { display: 'flex', gap: '6px' } }, ...(actions || []))
      );
    }

    // Standard date filter (per pack_design_standard_v1)
    function dateFilter(stateKey, onChange) {
      const opts = [
        ['today',     'Today'], ['yesterday', 'Yesterday'],
        ['7d',        'Last 7d'], ['30d',       'Last 30d'],
        ['mtd',       'This month'], ['qtd',       'This quarter'],
        ['custom',    'Custom…']
      ];
      let stored = 'mtd';
      try { stored = localStorage.getItem('holi_df_' + stateKey) || 'mtd'; } catch (_) {}
      const seg = h('div', { style: { display: 'flex', background: '#ccfbf1',
        padding: '3px', borderRadius: '8px', width: 'fit-content' } });
      opts.forEach(function (o) {
        const isOn = o[0] === stored;
        seg.appendChild(h('button', {
          style: {
            padding: '6px 10px', border: 0,
            background: isOn ? '#fff' : 'transparent',
            color: isOn ? TEAL2 : '#475569',
            borderRadius: '6px', fontSize: '12px', fontWeight: 600,
            cursor: 'pointer', boxShadow: isOn ? '0 1px 2px rgba(0,0,0,.06)' : 'none'
          },
          onclick: function () {
            try { localStorage.setItem('holi_df_' + stateKey, o[0]); } catch (_) {}
            if (onChange) onChange(o[0]);
          }
        }, o[1]));
      });
      return seg;
    }

    // ════════════════════════════════════════════════════════════════
    //  PACKAGE_BUILDER_v1 — shared helpers (modal + form inputs)
    // ════════════════════════════════════════════════════════════════
    const ACTIVITY_KINDS = ['arrival', 'sightseeing', 'meal', 'transfer',
                            'leisure', 'adventure', 'shopping', 'departure'];
    const MEAL_PLANS = [['', 'No meals'], ['bb', 'Breakfast only'],
                        ['hb', 'Breakfast + Dinner'], ['fb', 'All meals']];
    const COMPONENT_KINDS = [['hotel', '🏨 Hotels'], ['activity', '🏛️ Activities'],
                             ['transfer', '🚗 Transfers'], ['meal', '🍽️ Meals'], ['other', '📌 Other']];

    function kindEmoji(k) {
      const m = { arrival: '✈️', departure: '🛫', sightseeing: '🏛️',
        meal: '🍽️', transfer: '🚗', leisure: '🌴',
        adventure: '🪂', shopping: '🛍️', hotel: '🏨', other: '📌' };
      return m[k] || '📌';
    }

    function inp(value, ph) {
      return h('input', { value: value == null ? '' : String(value),
        placeholder: ph || '', style: {
          width: '100%', padding: '7px 9px', border: '1px solid #ccfbf1',
          borderRadius: '7px', fontSize: '13px', boxSizing: 'border-box' } });
    }
    function sel(options, value) {
      // options: array of [val,label] or [val]
      const s = h('select', { style: {
        width: '100%', padding: '7px 9px', border: '1px solid #ccfbf1',
        borderRadius: '7px', fontSize: '13px', background: '#fff', boxSizing: 'border-box' } });
      options.forEach(function (o) {
        const v = Array.isArray(o) ? o[0] : o;
        const l = Array.isArray(o) ? (o[1] || o[0]) : o;
        const opt = h('option', { value: v }, l);
        if (String(v) === String(value == null ? '' : value)) opt.selected = true;
        s.appendChild(opt);
      });
      return s;
    }
    function field(label, el) {
      return h('div', {},
        h('label', { style: { display: 'block', fontSize: '10.5px',
          textTransform: 'uppercase', letterSpacing: '.4px', color: '#64748b',
          fontWeight: 700, marginBottom: '3px' } }, label),
        el);
    }
    function grid(children, cols) {
      return h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(' + (cols || 2) + ', 1fr)', gap: '10px' } }, ...children);
    }

    // Self-contained modal. body = DOM node. actions = [ [label, fn, kind] ].
    function modal(title, body, actions) {
      const overlay = h('div', { style: {
        position: 'fixed', inset: '0', background: 'rgba(15,23,42,.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        zIndex: 9999, padding: '40px 16px', overflowY: 'auto' } });
      function close() { try { document.body.removeChild(overlay); } catch (_) {} }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      const foot = h('div', { style: { display: 'flex', justifyContent: 'flex-end',
        gap: '8px', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid #ecfdf5' } });
      (actions || []).forEach(function (a) {
        foot.appendChild(btn(a[0], function () { a[1](close); }, a[2]));
      });
      foot.appendChild(btn('Cancel', close));
      const box = h('div', { style: {
        background: '#fff', borderRadius: '14px', padding: '18px',
        width: '100%', maxWidth: '640px', boxShadow: '0 20px 60px rgba(0,0,0,.25)' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: '14px' } },
          h('h3', { style: { margin: 0, fontSize: '15px' } }, title),
          h('button', { onclick: close, style: { border: 0, background: 'transparent',
            fontSize: '20px', cursor: 'pointer', color: '#94a3b8', lineHeight: 1 } }, '×')),
        body, foot);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      return { close: close };
    }

    // ════════════════════════════════════════════════════════════════
    //  OVERVIEW
    // ════════════════════════════════════════════════════════════════
    VIEWS.packholiday = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / Overview', '✈️ Travel & Holiday Overview', [
        btn('🌱 Seed Demo Data', async function () {
          if (!confirm('Insert ~25 bookings across destinations, with itineraries and payments?')) return;
          try { const r = await api('api_tour_seedDemo');
            if (r.skipped) toast('Demo data already present');
            else if (r.ok) { toast('✓ Seeded · refreshing'); setTimeout(function(){ window.location.reload(); }, 800); }
          } catch (e) { toast('Seed failed: ' + e.message); }
        }),
        btn('+ New Booking', function () { try { window.location.hash = '#/tourbookings'; } catch (_) {} }, 'primary')
      ]));

      const df = h('div', { style: { marginBottom: '12px' } });
      df.appendChild(dateFilter('overview', function () {}));
      view.appendChild(df);

      let s;
      try { s = await api('api_tour_summary'); }
      catch (e) {
        view.appendChild(h('p', { class: 'muted' }, 'Could not load summary: ' + e.message));
        return;
      }
      const b = s.bookings || {}, m = s.money || {}, i = s.itineraries || {};

      view.appendChild(h('div', { style: { display: 'flex', gap: '12px',
        flexWrap: 'wrap', marginBottom: '16px' } },
        kpiTile('Bookings (lifetime)',  String(b.bookings_total || 0), (b.bookings_active || 0) + ' active'),
        kpiTile('Bookings (mo)',        String(b.bookings_month || 0), fmtINR(b.revenue_month || 0)),
        kpiTile('Travelling now',       String(b.travelling_now || 0), 'right now', '#16a34a'),
        kpiTile('Upcoming 30d',         String(b.upcoming_30d || 0), 'next 30 days'),
        kpiTile('Outstanding',          fmtINR(m.outstanding || 0), 'pending balance', '#dc2626'),
        kpiTile('Overdue',              fmtINR(m.overdue || 0), 'past balance due', '#dc2626'),
        kpiTile('Visa pending',         String(m.visa_pending || 0), 'awaiting approval', '#b45309'),
        kpiTile('Bookings w/o itin',    String(i.itin_no_plan || 0), 'plan them today', '#b45309')
      ));

      // Quick link cards
      const links = h('div', { style: { display: 'grid',
        gridTemplateColumns: 'repeat(4,1fr)', gap: '10px' } });
      const linkCard = function (icon, label, hash) {
        const c = h('div', {
          style: { background: '#fff', border: '1px solid #ccfbf1',
            borderRadius: '10px', padding: '14px', cursor: 'pointer',
            textAlign: 'center', transition: 'all .15s' },
          onclick: function () { try { window.location.hash = hash; } catch (_) {} }
        },
          h('div', { style: { fontSize: '28px' } }, icon),
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginTop: '4px' } }, label)
        );
        c.onmouseenter = function () { c.style.background = '#f0fdfa'; };
        c.onmouseleave = function () { c.style.background = '#fff'; };
        return c;
      };
      links.appendChild(linkCard('🎫', 'Bookings', '#/tourbookings'));
      links.appendChild(linkCard('🌍', 'Destinations', '#/tourdestinations'));
      links.appendChild(linkCard('🗺️', 'Itinerary Builder', '#/touritinerary'));
      links.appendChild(linkCard('💰', 'Payments & Collection', '#/tourpayments'));
      view.appendChild(links);
    };

    // ════════════════════════════════════════════════════════════════
    //  BOOKINGS — list
    // ════════════════════════════════════════════════════════════════
    VIEWS.tourbookings = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / Bookings', '🎫 Bookings', [
        btn('+ New Booking', function () { openBookingCreate(refresh); }, 'primary')
      ]));

      const toolbar = h('div', { style: { display: 'flex', gap: '8px',
        alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } });
      const statusSel = h('select', { style: selStyle(), onchange: refresh });
      [['', 'All statuses'], ['enquiry', 'Enquiry'], ['quoted', 'Quoted'],
       ['booked', 'Booked'], ['confirmed', 'Confirmed'], ['traveling', 'Travelling'],
       ['completed', 'Completed'], ['cancelled', 'Cancelled']].forEach(function (c) {
        statusSel.appendChild(h('option', { value: c[0] }, c[1]));
      });
      toolbar.appendChild(statusSel);
      toolbar.appendChild(btn('🔄 Refresh', refresh));
      view.appendChild(toolbar);

      const tblWrap = h('div', { style: { background: '#fff',
        border: '1px solid #ccfbf1', borderRadius: '10px', overflow: 'hidden' } });
      view.appendChild(tblWrap);

      async function refresh() {
        tblWrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let data;
        try {
          const args = {};
          if (statusSel.value) args.status = statusSel.value;
          data = await api('api_tour_booking_list', args);
        } catch (e) {
          tblWrap.innerHTML = '';
          tblWrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        tblWrap.innerHTML = '';
        if (!data.bookings || !data.bookings.length) {
          tblWrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#64748b' } },
            'No bookings match — click Seed Demo Data on Overview to populate.'));
          return;
        }
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } });
        tbl.appendChild(h('thead', {}, h('tr', { style: { background: '#f0fdfa' } },
          ['Booking', 'Customer', 'Destination', 'Travel', 'PAX', 'Total', 'Balance', 'Visa', 'Itin', 'Status']
            .map(function (l) {
              return h('th', { style: { textAlign: 'left', padding: '10px 12px',
                borderBottom: '1px solid #ccfbf1', fontSize: '11.5px', textTransform: 'uppercase',
                letterSpacing: '.4px', color: '#475569', fontWeight: 600 } }, l);
            })
        )));
        const tbody = h('tbody', {});
        data.bookings.forEach(function (b) {
          const tr = h('tr', { style: { cursor: 'pointer' },
            onclick: function () { openBookingDetail(b, refresh); } },
            h('td', { style: td() }, h('b', {}, b.booking_no || ('#' + b.id))),
            h('td', { style: td() },
              h('div', {}, b.lead_name || '—'),
              h('div', { style: { fontSize: '11px', color: '#64748b' } }, b.lead_phone || '')),
            h('td', { style: td() }, (b.flag || '') + ' ' + (b.destination_name || '—')),
            h('td', { style: td() },
              b.travel_start_date ? String(b.travel_start_date).slice(0, 10) : '—'),
            h('td', { style: td() }, String(b.travellers || 1)),
            h('td', { style: td() }, fmtINR(b.total_inr)),
            h('td', { style: td() },
              Number(b.balance_inr) > 0
                ? h('span', { style: { color: '#dc2626', fontWeight: 600 } }, fmtINR(b.balance_inr))
                : pill('Paid ✓', 'ok')),
            h('td', { style: td() }, visaPill(b.visa_status)),
            h('td', { style: td() },
              b.id ? h('button', {
                style: { background: 'transparent', border: '1px solid #ccfbf1',
                  borderRadius: '6px', padding: '4px 8px', fontSize: '11.5px',
                  cursor: 'pointer', color: TEAL2 },
                onclick: function (ev) { ev.stopPropagation();
                  window.location.hash = '#/touritinerary?booking_id=' + b.id; }
              }, '🗺️ Plan') : '—'),
            h('td', { style: td() }, statusPill(b.status))
          );
          tr.onmouseenter = function () { tr.style.background = '#f0fdfa'; };
          tr.onmouseleave = function () { tr.style.background = '#fff'; };
          tbody.appendChild(tr);
        });
        tbl.appendChild(tbody);
        tblWrap.appendChild(tbl);
      }
      function td() { return { padding: '10px 12px', borderBottom: '1px solid #ecfdf5' }; }
      function selStyle() {
        return { padding: '7px 10px', border: '1px solid #ccfbf1',
          borderRadius: '7px', fontSize: '13px', background: '#fff' };
      }
      function visaPill(v) {
        if (v === 'approved') return pill('✓ Visa', 'ok');
        if (v === 'pending')  return pill('⏳ Visa', 'warn');
        if (v === 'rejected') return pill('✗ Visa', 'bad');
        return pill('N/A', 'gray');
      }
      function statusPill(s) {
        const m = { enquiry: 'gray', quoted: 'info', booked: 'teal',
          confirmed: 'teal', traveling: 'warn', completed: 'ok', cancelled: 'bad' };
        return pill(s || 'enquiry', m[s] || 'gray');
      }
      refresh();
    };

    async function openBookingCreate(onDone) {
      let destinations = [];
      try { const r = await api('api_tour_destinations_list'); destinations = r.destinations || []; } catch (_) {}

      const m = h('div', { style: { position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); } });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '540px', maxWidth: '94vw', padding: '20px 24px' } });
      card.appendChild(h('h3', { style: { margin: '0 0 14px' } }, '🎫 New Booking'));

      const F = {};
      function row(label, child, key) {
        if (key) F[key] = child;
        return h('div', { style: { display: 'grid',
          gridTemplateColumns: '160px 1fr', gap: '10px', padding: '8px 0',
          borderBottom: '1px solid #ecfdf5', alignItems: 'center' } },
          h('div', { style: { fontSize: '12.5px', color: '#475569', fontWeight: 600 } }, label),
          child);
      }
      function input(val, opts) {
        return h('input', Object.assign({
          value: val == null ? '' : String(val), type: 'text',
          style: { width: '100%', padding: '7px 9px', border: '1px solid #ccfbf1',
            borderRadius: '7px', fontSize: '13px' }
        }, opts || {}));
      }
      const destSel = h('select', { style: { width: '100%', padding: '7px 9px',
        border: '1px solid #ccfbf1', borderRadius: '7px', fontSize: '13px', background: '#fff' } });
      destinations.forEach(function (d) {
        destSel.appendChild(h('option', { value: d.id }, (d.flag || '') + ' ' + d.name));
      });

      card.appendChild(row('Lead ID', input(''), 'lead_id'));
      card.appendChild(row('Destination', destSel, 'destination_id'));
      card.appendChild(row('PAX', input('2', { type: 'number' }), 'travellers'));
      card.appendChild(row('Travel start', input('', { type: 'date' }), 'travel_start_date'));
      card.appendChild(row('Travel end', input('', { type: 'date' }), 'travel_end_date'));
      card.appendChild(row('Total ₹', input('50000', { type: 'number' }), 'total_inr'));
      card.appendChild(row('Advance ₹', input('15000', { type: 'number' }), 'advance_inr'));

      const actions = h('div', { style: { display: 'flex', gap: '8px',
        marginTop: '14px', justifyContent: 'flex-end' } });
      actions.appendChild(btn('Cancel', function () { m.remove(); }));
      actions.appendChild(btn('Create', async function () {
        try {
          await api('api_tour_booking_create', {
            lead_id: Number(F.lead_id.value) || null,
            destination_id: Number(F.destination_id.value) || null,
            travellers: Number(F.travellers.value),
            travel_start_date: F.travel_start_date.value || null,
            travel_end_date: F.travel_end_date.value || null,
            total_inr: Number(F.total_inr.value),
            advance_inr: Number(F.advance_inr.value),
            status: 'booked'
          });
          toast('Booking created');
          m.remove();
          if (onDone) onDone();
        } catch (e) { toast(e.message); }
      }, 'primary'));
      card.appendChild(actions);

      m.appendChild(card);
      document.body.appendChild(m);
    }

    async function openBookingDetail(b, onDone) {
      const m = h('div', { style: { position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center',
        justifyContent: 'center', zIndex: 9999 },
        onclick: function (ev) { if (ev.target === m) m.remove(); } });
      const card = h('div', { style: { background: '#fff', borderRadius: '12px',
        width: '700px', maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto',
        padding: '20px 24px' } });
      card.appendChild(h('h3', { style: { margin: '0 0 6px' } },
        '🎫 ' + (b.booking_no || ('Booking #' + b.id))));
      card.appendChild(h('div', { style: { fontSize: '13px', color: '#64748b', marginBottom: '14px' } },
        (b.flag || '') + ' ' + (b.destination_name || '—') + ' · ' +
        (b.lead_name || '') + ' · ' + (b.travellers || 1) + ' pax'));

      // KPIs
      card.appendChild(h('div', { style: { display: 'flex', gap: '10px', marginBottom: '14px' } },
        kpiTile('Total', fmtINR(b.total_inr), ''),
        kpiTile('Advance', fmtINR(b.advance_inr), '', '#16a34a'),
        kpiTile('Balance', fmtINR(b.balance_inr), '', Number(b.balance_inr) > 0 ? '#dc2626' : '#16a34a'),
        kpiTile('Travel', b.travel_start_date ? String(b.travel_start_date).slice(0, 10) : '—', '')
      ));

      // Payments
      card.appendChild(h('h4', { style: { margin: '12px 0 6px' } }, '💰 Payments'));
      const payWrap = h('div'); card.appendChild(payWrap);
      try {
        const r = await api('api_tour_payment_list', { booking_id: b.id });
        const ps = r.payments || [];
        if (!ps.length) payWrap.appendChild(h('p', { class: 'muted', style: { fontSize: '12.5px' } }, 'No payments recorded.'));
        else {
          const ul = h('div', { style: { background: '#f0fdfa', borderRadius: '8px', padding: '8px' } });
          ps.forEach(function (p) {
            ul.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between',
              padding: '6px 4px', fontSize: '12.5px', borderBottom: '1px solid #ccfbf1' } },
              h('span', {}, String(p.paid_at).slice(0, 10) + ' · ' + (p.mode || '—') + (p.ref_no ? ' · ' + p.ref_no : '')),
              h('b', {}, fmtINRfull(p.amount_inr))));
          });
          payWrap.appendChild(ul);
        }
      } catch (e) { payWrap.appendChild(h('p', { class: 'muted' }, e.message)); }

      // Quick-record payment
      if (Number(b.balance_inr) > 0) {
        const amtInput = h('input', { type: 'number', value: String(b.balance_inr),
          style: { padding: '7px 9px', border: '1px solid #ccfbf1', borderRadius: '7px', fontSize: '13px', width: '160px' } });
        const recRow = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } },
          h('span', { style: { fontSize: '12.5px' } }, 'Record payment:'),
          amtInput,
          btn('💰 Record', async function () {
            try { await api('api_tour_payment_record', { booking_id: b.id,
              amount_inr: Number(amtInput.value), mode: 'bank' });
              toast('Payment recorded');
              m.remove();
              if (onDone) onDone();
            } catch (e) { toast(e.message); }
          }, 'primary')
        );
        card.appendChild(recRow);
      }

      // Status actions
      const actions = h('div', { style: { display: 'flex', gap: '6px',
        marginTop: '16px', flexWrap: 'wrap', justifyContent: 'space-between' } });
      const left = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
      ['booked','confirmed','traveling','completed','cancelled'].forEach(function (st) {
        if (b.status === st) return;
        left.appendChild(btn(st.charAt(0).toUpperCase() + st.slice(1), async function () {
          try { await api('api_tour_booking_setStatus', { booking_id: b.id, status: st });
            toast('Status → ' + st); m.remove(); if (onDone) onDone();
          } catch (e) { toast(e.message); }
        }));
      });
      actions.appendChild(left);
      actions.appendChild(btn('Close', function () { m.remove(); }));
      card.appendChild(actions);

      m.appendChild(card);
      document.body.appendChild(m);
    }

    // ════════════════════════════════════════════════════════════════
    //  DESTINATIONS
    // ════════════════════════════════════════════════════════════════
    VIEWS.tourdestinations = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / Destinations', '🌍 Destinations Catalog', [
        btn('🔄 Refresh', function () { refresh(); })
      ]));

      const wrap = h('div'); view.appendChild(wrap);

      async function refresh() {
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let data;
        try { data = await api('api_tour_destinations_list'); }
        catch (e) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        wrap.innerHTML = '';
        if (!data.destinations || !data.destinations.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#64748b' } },
            'No destinations seeded.'));
          return;
        }
        const grid = h('div', { style: { display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' } });
        data.destinations.forEach(function (d) {
          const card = h('div', {
            style: { background: '#fff', border: '1px solid #ccfbf1', borderRadius: '12px',
              padding: '14px', cursor: 'pointer', transition: 'all .15s' },
            onclick: function () { /* future: open detail */ }
          },
            h('div', { style: { fontSize: '40px' } }, d.flag || '🌍'),
            h('h3', { style: { margin: '4px 0', fontSize: '15px' } }, d.name),
            h('div', { style: { fontSize: '11.5px', color: '#64748b', marginBottom: '8px' } }, d.country || ''),
            h('div', { style: { fontSize: '12px', display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' } },
              pill(d.kind || 'leisure', 'teal'),
              pill((d.avg_days || '?') + 'N', 'gray')),
            h('div', { style: { fontSize: '13px', fontWeight: 700, color: TEAL2 } },
              'Avg ' + fmtINR(d.avg_price_inr || 0) + ' / pp'),
            h('p', { style: { fontSize: '11.5px', color: '#64748b', marginTop: '6px',
              maxHeight: '36px', overflow: 'hidden' } }, d.notes || '')
          );
          card.onmouseenter = function () { card.style.background = '#f0fdfa'; };
          card.onmouseleave = function () { card.style.background = '#fff'; };
          grid.appendChild(card);
        });
        wrap.appendChild(grid);
      }
      refresh();
    };

    // ════════════════════════════════════════════════════════════════
    //  PACKAGE_BUILDER_v1 — Packages catalogue, day templates & library
    // ════════════════════════════════════════════════════════════════
    VIEWS.tourpackages = async function (view) {
      let tab = 'packages';       // packages | library
      let editingPkg = null;      // package object → show its day-template editor
      let destinations = [];

      function tabStyle(on) {
        return { padding: '8px 14px', borderRadius: '7px', border: 0, cursor: 'pointer',
          fontSize: '12.5px', fontWeight: 700,
          background: on ? 'linear-gradient(180deg,#14b8a6,#0d9488)' : 'transparent',
          color: on ? '#fff' : '#475569' };
      }
      function card(children) {
        return h('div', { style: { background: '#fff', border: '1px solid #ccfbf1',
          borderRadius: '10px', padding: '14px', marginBottom: '12px' } }, ...children);
      }

      async function loadDestinations() {
        try { destinations = (await api('api_tour_destinations_list')).destinations || []; }
        catch (_) { destinations = []; }
      }

      function render() {
        view.innerHTML = '';
        view.appendChild(topbar('Holiday / Packages & Library', '📦 Packages & Library', [
          btn('🔄 Refresh', function () { editingPkg = null; render(); })
        ]));
        const tabs = h('div', { style: { display: 'flex', gap: '6px', background: '#fff',
          padding: '6px', borderRadius: '10px', border: '1px solid #ccfbf1',
          marginBottom: '14px', width: 'fit-content' } });
        [['packages', '📦 Packages'], ['library', '🧱 Component Library']].forEach(function (t) {
          tabs.appendChild(h('button', { style: tabStyle(tab === t[0]),
            onclick: function () { tab = t[0]; editingPkg = null; render(); } }, t[1]));
        });
        view.appendChild(tabs);
        const body = h('div'); view.appendChild(body);
        if (tab === 'packages') { editingPkg ? renderTemplate(body) : renderCatalogue(body); }
        else renderLibrary(body);
      }

      // ---- Packages catalogue -------------------------------------
      async function renderCatalogue(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading packages…</div>';
        let packages = [];
        try { packages = (await api('api_tour_packages_list')).packages || []; }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        // day counts (few packages — parallel is fine)
        const counts = {};
        await Promise.all(packages.map(async function (p) {
          try { counts[p.id] = ((await api('api_tour_packageDays_get', { package_id: p.id })).days || []).length; }
          catch (_) { counts[p.id] = 0; }
        }));

        body.innerHTML = '';
        body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: '12px' } },
          h('div', { style: { fontSize: '12.5px', color: '#64748b' } },
            packages.length + ' package' + (packages.length === 1 ? '' : 's')),
          btn('＋ New Package', function () { packageModal(null); }, 'primary')));

        if (!packages.length) {
          body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } },
            'No packages yet. Click "＋ New Package" to create one clients can choose from.')]));
          return;
        }

        const g = h('div', { style: { display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: '14px' } });
        packages.forEach(function (p) {
          const n = counts[p.id] || 0;
          g.appendChild(h('div', { style: { background: '#fff', border: '1px solid #ccfbf1',
            borderRadius: '12px', overflow: 'hidden' } },
            h('div', { style: { height: '70px', background: 'linear-gradient(135deg,#0d9488,#5eead4)',
              position: 'relative' } },
              h('span', { style: { position: 'absolute', top: '8px', left: '10px', fontSize: '22px' } }, p.flag || '🌍'),
              h('span', { style: { position: 'absolute', top: '9px', right: '9px' } },
                pill(p.kind || 'package', 'teal'))),
            h('div', { style: { padding: '12px' } },
              h('h3', { style: { margin: '0 0 3px', fontSize: '14px' } }, p.name || 'Untitled'),
              h('div', { style: { fontSize: '12px', color: '#64748b', marginBottom: '8px' } },
                (p.destination_name || '—') + ' · ' + (p.duration_nights || '?') + 'N'),
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                h('b', { style: { color: TEAL, fontSize: '15px' } }, fmtINRfull(p.price_inr)),
                n ? pill(n + ' day' + (n === 1 ? '' : 's'), 'ok') : pill('no days yet', 'warn')),
              h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } },
                btn('🗓 Build days', function () { editingPkg = p; render(); }, 'primary'),
                btn('✏️', function () { packageModal(p); }),
                btn('⧉', function () { duplicatePackage(p); }))
            )));
        });
        body.appendChild(g);
      }

      function packageModal(p) {
        p = p || {};
        const fName = inp(p.name, 'e.g. Bali 5N Honeymoon');
        const fDest = sel([['', '— Destination —']].concat(destinations.map(function (d) {
          return [d.id, (d.flag || '') + ' ' + d.name]; })), p.destination_id || '');
        const fKind = sel(['honeymoon', 'family', 'leisure', 'adventure', 'business'], p.kind || 'leisure');
        const fNights = inp(p.duration_nights, 'Nights');
        const fPax = inp(p.pax == null ? 2 : p.pax, 'Pax');
        const fPrice = inp(p.price_inr, 'Base price ₹');
        const fInc = inp(p.inclusions, 'Transfers | Breakfast | …');
        const fExc = inp(p.exclusions, 'Airfare | Visa | …');
        const bodyEl = h('div', {},
          grid([field('Package name', fName), field('Destination', fDest)], 2),
          h('div', { style: { height: '10px' } }),
          grid([field('Type', fKind), field('Nights', fNights), field('Pax', fPax), field('Base price (₹)', fPrice)], 4),
          h('div', { style: { height: '10px' } }),
          grid([field('Inclusions (pipe-separated)', fInc), field('Exclusions', fExc)], 2));
        modal(p.id ? 'Edit Package' : 'New Package', bodyEl, [
          ['💾 Save package', async function (close) {
            if (!fName.value.trim()) { toast('Name required'); return; }
            try {
              await api('api_tour_packages_save', {
                id: p.id || 0, name: fName.value.trim(), destination_id: fDest.value || null,
                kind: fKind.value, duration_nights: fNights.value, pax: fPax.value,
                price_inr: fPrice.value, inclusions: fInc.value, exclusions: fExc.value });
              toast('Saved'); close(); render();
            } catch (e) { toast(e.message); }
          }, 'primary']
        ]);
      }

      async function duplicatePackage(p) {
        try {
          const nr = await api('api_tour_packages_save', {
            name: (p.name || 'Package') + ' (copy)', destination_id: p.destination_id,
            kind: p.kind, duration_nights: p.duration_nights, pax: p.pax,
            price_inr: p.price_inr, inclusions: p.inclusions, exclusions: p.exclusions });
          const newId = nr.id;
          const tpl = await api('api_tour_packageDays_get', { package_id: p.id });
          for (const d of (tpl.days || [])) {
            const dr = await api('api_tour_packageDay_save', {
              package_id: newId, day_no: d.day_no, city: d.city, hotel_name: d.hotel_name,
              room_type: d.room_type, meal_plan: d.meal_plan, transport: d.transport,
              sightseeing: d.sightseeing, day_cost_inr: d.day_cost_inr, inclusions: d.inclusions, notes: d.notes });
            const acts = (tpl.activities || []).filter(function (a) { return a.package_day_id === d.id; });
            for (const a of acts) {
              await api('api_tour_packageActivity_save', {
                package_day_id: dr.id, seq: a.seq, time_str: a.time_str, kind: a.kind, title: a.title, detail: a.detail });
            }
          }
          toast('Package duplicated'); render();
        } catch (e) { toast(e.message); }
      }

      // ---- Package day-by-day template editor ----------------------
      async function renderTemplate(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading template…</div>';
        let data;
        try { data = await api('api_tour_packageDays_get', { package_id: editingPkg.id }); }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        const days = data.days || [], acts = data.activities || [];

        body.innerHTML = '';
        body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' } },
          h('div', {}, btn('← Back to packages', function () { editingPkg = null; render(); }),
            h('span', { style: { marginLeft: '10px', fontWeight: 700 } },
              (editingPkg.flag || '') + ' ' + editingPkg.name),
            h('span', { style: { marginLeft: '8px' } }, pill(days.length + ' day' + (days.length === 1 ? '' : 's'), 'teal'))),
          btn('＋ Add Day', function () { pkgDayModal(null, days.length + 1); }, 'primary')));

        if (!days.length) {
          body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } },
            'No template days yet. Add days here — every booking that uses this package inherits them.')]));
          return;
        }
        days.forEach(function (d) {
          const dayActs = acts.filter(function (a) { return a.package_day_id === d.id; });
          body.appendChild(dayCardView(d, dayActs, {
            onEditDay: function () { pkgDayModal(d, d.day_no); },
            onDelDay: async function () {
              if (!confirm('Delete Day ' + d.day_no + '?')) return;
              try { await api('api_tour_packageDay_delete', { id: d.id }); toast('Deleted'); render(); } catch (e) { toast(e.message); }
            },
            onAddAct: function () { pkgActModal(null, d.id, dayActs.length + 1); },
            onEditAct: function (a) { pkgActModal(a, d.id, a.seq); },
            onDelAct: async function (a) {
              try { await api('api_tour_packageActivity_delete', { id: a.id }); toast('Removed'); render(); } catch (e) { toast(e.message); }
            }
          }));
        });
      }

      function pkgDayModal(d, dayNo) {
        d = d || {};
        const els = dayFormEls(d);
        modal(d.id ? 'Edit Day ' + dayNo : 'Add Day ' + dayNo, dayFormBody(els), [
          ['💾 Save day', async function (close) {
            try {
              await api('api_tour_packageDay_save', Object.assign(
                { id: d.id || 0, package_id: editingPkg.id, day_no: dayNo }, dayFormValues(els)));
              toast('Saved'); close(); render();
            } catch (e) { toast(e.message); }
          }, 'primary']
        ]);
      }

      function pkgActModal(a, dayId, seq) {
        a = a || {};
        const els = actFormEls(a);
        modal(a.id ? 'Edit Activity' : 'Add Activity', actFormBody(els), [
          ['💾 Save', async function (close) {
            try {
              await api('api_tour_packageActivity_save', Object.assign(
                { id: a.id || 0, package_day_id: dayId, seq: seq }, actFormValues(els)));
              toast('Saved'); close(); render();
            } catch (e) { toast(e.message); }
          }, 'primary']
        ]);
      }

      // ---- Component library ---------------------------------------
      let libKind = '';
      async function renderLibrary(body) {
        body.innerHTML = '<div style="padding:1rem;color:#64748b">Loading library…</div>';
        let comps = [];
        try { comps = (await api('api_tour_components_list', libKind ? { kind: libKind } : {})).components || []; }
        catch (e) { body.innerHTML = ''; body.appendChild(card([h('div', { style: { color: '#dc2626' } }, e.message)])); return; }
        body.innerHTML = '';
        body.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' } },
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            [['', 'All']].concat(COMPONENT_KINDS).map(function (k) {
              const on = libKind === k[0];
              return h('button', { onclick: function () { libKind = k[0]; render(); },
                style: { border: '1px solid #ccfbf1', borderRadius: '99px', padding: '4px 11px',
                  fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                  background: on ? TEAL : '#fff', color: on ? '#fff' : '#475569' } }, k[1]);
            })),
          btn('＋ New Component', function () { componentModal(null); }, 'primary')));

        if (!comps.length) {
          body.appendChild(card([h('div', { style: { textAlign: 'center', color: '#64748b', padding: '18px' } },
            'No components yet. Add reusable hotels, activities, transfers & meals to pick from in any package or trip.')]));
          return;
        }
        const g = h('div', { style: { display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: '10px' } });
        comps.forEach(function (c) {
          g.appendChild(h('div', { style: { border: '1px solid #ccfbf1', borderRadius: '10px',
            padding: '10px', background: '#fff', display: 'flex', gap: '10px' } },
            h('div', { style: { fontSize: '20px' } }, kindEmoji(c.kind)),
            h('div', { style: { flex: 1 } },
              h('h3', { style: { margin: '0 0 2px', fontSize: '13.5px' } }, c.name),
              h('div', { style: { fontSize: '12px', color: '#64748b' } },
                [c.city, c.rate_inr ? fmtINRfull(c.rate_inr) + (c.rate_unit ? '/' + c.rate_unit : '') : null]
                  .filter(Boolean).join(' · ')),
              c.description ? h('div', { style: { fontSize: '11.5px', color: '#94a3b8', marginTop: '2px' } }, c.description) : null),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              btn('✏️', function () { componentModal(c); }),
              btn('🗑', async function () {
                if (!confirm('Delete ' + c.name + '?')) return;
                try { await api('api_tour_component_delete', { id: c.id }); toast('Deleted'); render(); } catch (e) { toast(e.message); }
              }))));
        });
        body.appendChild(g);
      }

      function componentModal(c) {
        c = c || {};
        const fKind = sel(COMPONENT_KINDS, c.kind || 'hotel');
        const fName = inp(c.name, 'e.g. The Royal Purnama');
        const fCity = inp(c.city, 'City');
        const fRate = inp(c.rate_inr, 'Rate ₹');
        const fUnit = sel([['', 'unit'], ['night', 'per night'], ['pax', 'per pax'],
                           ['trip', 'per trip'], ['day', 'per day']], c.rate_unit || '');
        const fPhoto = inp(c.photo_url, 'Photo URL (optional)');
        const fDesc = inp(c.description, 'Short description');
        const bodyEl = h('div', {},
          grid([field('Type', fKind), field('Name', fName)], 2),
          h('div', { style: { height: '10px' } }),
          grid([field('City', fCity), field('Rate (₹)', fRate), field('Rate unit', fUnit)], 3),
          h('div', { style: { height: '10px' } }),
          field('Description', fDesc),
          h('div', { style: { height: '10px' } }),
          field('Photo URL', fPhoto));
        modal(c.id ? 'Edit Component' : 'New Component', bodyEl, [
          ['💾 Save', async function (close) {
            if (!fName.value.trim()) { toast('Name required'); return; }
            try {
              await api('api_tour_component_save', {
                id: c.id || 0, kind: fKind.value, name: fName.value.trim(), city: fCity.value,
                rate_inr: fRate.value, rate_unit: fUnit.value, photo_url: fPhoto.value, description: fDesc.value });
              toast('Saved'); close(); render();
            } catch (e) { toast(e.message); }
          }, 'primary']
        ]);
      }

      await loadDestinations();
      render();
    };

    // ── Shared day/activity form builders (used by templates + itinerary) ──
    function dayFormEls(d) {
      d = d || {};
      return {
        date: inp(d.day_date ? String(d.day_date).slice(0, 10) : '', 'YYYY-MM-DD'),
        city: inp(d.city, 'City'),
        hotel: inp(d.hotel_name, 'Hotel name'),
        room: inp(d.room_type, 'Room type'),
        meal: sel(MEAL_PLANS, d.meal_plan || ''),
        transport: inp(d.transport, 'e.g. Private AC car'),
        sightseeing: inp(d.sightseeing, 'Key sights'),
        cost: inp(d.day_cost_inr, 'Day cost ₹'),
        inclusions: inp(d.inclusions, 'Inclusions / notes for this day')
      };
    }
    function dayFormBody(e, showDate) {
      const rows = [];
      if (showDate) rows.push(grid([field('Day date', e.date), field('City', e.city)], 2));
      else rows.push(grid([field('City', e.city), field('Hotel', e.hotel)], 2));
      rows.push(h('div', { style: { height: '10px' } }));
      if (showDate) rows.push(grid([field('Hotel', e.hotel), field('Room type', e.room),
        field('Meal plan', e.meal), field('Day cost (₹)', e.cost)], 4));
      else rows.push(grid([field('Room type', e.room), field('Meal plan', e.meal),
        field('Day cost (₹)', e.cost)], 3));
      rows.push(h('div', { style: { height: '10px' } }));
      rows.push(grid([field('Transport', e.transport), field('Sightseeing', e.sightseeing)], 2));
      rows.push(h('div', { style: { height: '10px' } }));
      rows.push(field('Inclusions / notes', e.inclusions));
      return h('div', {}, ...rows);
    }
    function dayFormValues(e) {
      return {
        day_date: e.date ? e.date.value : null, city: e.city.value, hotel_name: e.hotel.value,
        room_type: e.room.value, meal_plan: e.meal.value, transport: e.transport.value,
        sightseeing: e.sightseeing.value, day_cost_inr: e.cost.value, inclusions: e.inclusions.value
      };
    }
    function actFormEls(a) {
      a = a || {};
      return {
        time: inp(a.time_str, 'e.g. 09:00 AM'),
        kind: sel(ACTIVITY_KINDS, a.kind || 'sightseeing'),
        title: inp(a.title, 'Activity title'),
        detail: inp(a.detail, 'Details (optional)')
      };
    }
    function actFormBody(e) {
      return h('div', {},
        grid([field('Time', e.time), field('Type', e.kind)], 2),
        h('div', { style: { height: '10px' } }),
        field('Title', e.title),
        h('div', { style: { height: '10px' } }),
        field('Detail', e.detail));
    }
    function actFormValues(e) {
      return { time_str: e.time.value, kind: e.kind.value, title: e.title.value, detail: e.detail.value };
    }

    // Reusable day card (read view) with edit/delete/activity actions
    function dayCardView(d, dayActs, cb) {
      const meta = [d.hotel_name || 'No hotel', d.room_type, mealLabel(d.meal_plan)].filter(Boolean).join(' · ');
      const chips = [];
      if (d.transport)   chips.push('🚗 ' + d.transport);
      if (d.sightseeing) chips.push('🏛️ ' + d.sightseeing);
      if (d.day_cost_inr) chips.push('💰 ' + fmtINRfull(d.day_cost_inr));
      const actRows = dayActs.length
        ? dayActs.map(function (a) {
            return h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center',
              padding: '6px 0', borderBottom: '1px solid #ecfdf5', fontSize: '12.5px' } },
              h('div', { style: { color: TEAL2, fontWeight: 600, minWidth: '70px' } }, a.time_str || ''),
              h('div', { style: { fontSize: '14px' } }, kindEmoji(a.kind)),
              h('div', { style: { flex: 1 } },
                h('b', {}, a.title),
                a.detail ? h('div', { style: { color: '#64748b', fontSize: '11.5px' } }, a.detail) : null),
              cb.onEditAct ? btn('✏️', function () { cb.onEditAct(a); }) : null,
              cb.onDelAct ? btn('🗑', function () { cb.onDelAct(a); }) : null);
          })
        : [h('div', { style: { color: '#64748b', fontSize: '12px', fontStyle: 'italic' } }, 'No activities yet.')];
      return h('div', { style: { background: '#fff', border: '1px solid #ccfbf1',
        borderRadius: '10px', padding: '14px', marginBottom: '10px' } },
        h('div', { style: { display: 'flex', justifyContent: 'space-between',
          alignItems: 'flex-start', marginBottom: '6px', gap: '8px', flexWrap: 'wrap' } },
          h('div', {},
            h('h4', { style: { margin: 0, fontSize: '14px' } },
              'Day ' + d.day_no + ' · ' + (d.city || '—') +
              (d.day_date ? '  ' : '')),
            d.day_date ? h('span', { style: { fontSize: '11.5px', color: '#94a3b8' } }, String(d.day_date).slice(0, 10)) : null,
            h('div', { style: { fontSize: '12px', color: '#64748b', marginTop: '2px' } }, meta)),
          h('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } },
            cb.onMoveUp ? btn('↑', cb.onMoveUp) : null,
            cb.onMoveDown ? btn('↓', cb.onMoveDown) : null,
            btn('✏️ Edit day', cb.onEditDay),
            btn('＋ Activity', cb.onAddAct),
            btn('🗑', cb.onDelDay))),
        chips.length ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap',
          margin: '4px 0 8px' } }, ...chips.map(function (c) { return pill(c, 'gray'); })) : null,
        d.inclusions ? h('div', { style: { fontSize: '11.5px', color: '#475569', marginBottom: '6px' } }, '✔ ' + d.inclusions) : null,
        h('div', {}, ...actRows));
    }
    function mealLabel(m) {
      const map = { bb: 'Breakfast', hb: 'Breakfast + Dinner', fb: 'All meals' };
      return m ? (map[m] || m) : null;
    }

    // ════════════════════════════════════════════════════════════════
    //  ITINERARY BUILDER
    // ════════════════════════════════════════════════════════════════
    VIEWS.touritinerary = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / Itinerary Builder', '🗺️ Itinerary Builder', [
        btn('🔄 Refresh', function () { load(); })
      ]));

      // Pick a booking (URL param ?booking_id or dropdown)
      let bookingId = null;
      try {
        const m = window.location.hash.match(/[?&]booking_id=(\d+)/);
        if (m) bookingId = Number(m[1]);
      } catch (_) {}

      const picker = h('div', { style: { display: 'flex', gap: '8px',
        alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } });
      // NB: named bookingSel (not `sel`) — a local `sel` would shadow the
      // module-level sel() form-helper used by the apply-package bar below.
      const bookingSel = h('select', { style: { padding: '7px 10px',
        border: '1px solid #ccfbf1', borderRadius: '7px', fontSize: '13px',
        background: '#fff', minWidth: '300px' },
        onchange: function () { bookingId = Number(bookingSel.value); load(); }
      });
      picker.appendChild(h('span', { style: { fontSize: '12.5px', color: '#475569' } }, 'Booking:'));
      picker.appendChild(bookingSel);
      view.appendChild(picker);

      try {
        const r = await api('api_tour_booking_list',
          { status: '' });  // all bookings
        const opts = r.bookings || [];
        if (!opts.length) bookingSel.appendChild(h('option', { value: '' }, '(no bookings yet)'));
        opts.forEach(function (b) {
          const o = h('option', { value: b.id },
            (b.booking_no || ('#' + b.id)) + ' — ' + (b.lead_name || '?') +
            ' · ' + (b.destination_name || '—'));
          if (b.id === bookingId) o.selected = true;
          bookingSel.appendChild(o);
        });
        if (!bookingId && opts.length) bookingId = opts[0].id;
      } catch (_) {}

      const wrap = h('div'); view.appendChild(wrap);

      async function load() {
        if (!bookingId) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#64748b' } },
            'Select a booking to plan its itinerary.'));
          return;
        }
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let data;
        try { data = await api('api_tour_itinerary_byBooking', { booking_id: bookingId }); }
        catch (e) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        wrap.innerHTML = '';
        const itn = data.itinerary || {};
        const days = data.days || [];
        const acts = data.activities || [];
        const cfields = data.cfields || [];

        // ---- Itinerary edit helpers (close over itn / load) ----
        function itinDayModal(d, dayNo) {
          d = d || {};
          const els = dayFormEls(d);
          // custom fields
          const cvals = (function () { try { return d.custom_json ? JSON.parse(d.custom_json) : {}; } catch (_) { return {}; } })();
          const cInputs = {};
          const cfBody = [];
          if (cfields.length) {
            cfields.forEach(function (cf) {
              const el = inp(cvals[cf.field_key] || '', cf.label);
              cInputs[cf.field_key] = el;
              cfBody.push(field(cf.label, el));
            });
          }
          const body = h('div', {},
            dayFormBody(els, true),
            cfields.length ? h('div', { style: { marginTop: '14px', paddingTop: '12px',
              borderTop: '1px dashed #ccfbf1' } },
              h('div', { style: { fontSize: '10.5px', textTransform: 'uppercase',
                letterSpacing: '.4px', color: '#64748b', fontWeight: 700, marginBottom: '8px' } },
                '🧩 Custom fields'),
              grid(cfBody, 2)) : null);
          modal(d.id ? 'Edit Day ' + dayNo : 'Add Day ' + dayNo, body, [
            ['💾 Save day', async function (close) {
              const custom = {};
              Object.keys(cInputs).forEach(function (k) { custom[k] = cInputs[k].value; });
              try {
                await api('api_tour_itinerary_upsertDay', Object.assign(
                  { id: d.id || 0, itinerary_id: itn.id, day_no: dayNo, custom_json: custom },
                  dayFormValues(els)));
                toast('Saved'); close(); load();
              } catch (e) { toast(e.message); }
            }, 'primary']
          ]);
        }
        function itinActModal(a, dayId) {
          a = a || {};
          const els = actFormEls(a);
          modal(a.id ? 'Edit Activity' : 'Add Activity', actFormBody(els), [
            ['💾 Save', async function (close) {
              try {
                if (a.id) {
                  await api('api_tour_itinerary_updateActivity', Object.assign({ id: a.id, seq: a.seq || 1 }, actFormValues(els)));
                } else {
                  await api('api_tour_itinerary_addActivity', Object.assign(
                    { day_id: dayId, seq: (acts.filter(function (x) { return x.day_id === dayId; }).length + 1) }, actFormValues(els)));
                }
                toast('Saved'); close(); load();
              } catch (e) { toast(e.message); }
            }, 'primary']
          ]);
        }
        async function reorder(idx, dir) {
          const arr = days.map(function (d) { return d.id; });
          const j = idx + dir;
          if (j < 0 || j >= arr.length) return;
          const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
          try { await api('api_tour_itinerary_reorderDays', { order: arr }); load(); }
          catch (e) { toast(e.message); }
        }

        // ---- Header ----
        wrap.appendChild(h('div', { style: { background: '#fff',
          border: '1px solid #ccfbf1', borderRadius: '10px', padding: '14px', marginBottom: '12px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between',
            alignItems: 'center', marginBottom: '8px', gap: '8px', flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0, fontSize: '14px' } }, '📋 ' + (itn.title || 'Itinerary')),
            h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              statusBadge(itn.status),
              btn('🧩 Custom fields', function () { cfieldsModal(); }))),
          h('div', { style: { fontSize: '12.5px', color: '#64748b' } },
            days.length + ' day' + (days.length === 1 ? '' : 's') + ' planned · ' +
            acts.length + ' activit' + (acts.length === 1 ? 'y' : 'ies') +
            (itn.package_id ? ' · seeded from a package' : ''))
        ));

        // ---- Apply-package bar ----
        let packages = [];
        try { packages = (await api('api_tour_packages_list')).packages || []; } catch (_) {}
        const pkgSel = sel([['', '— pick a package —']].concat(packages.map(function (p) {
          return [p.id, (p.flag || '') + ' ' + p.name + ' · ' + (p.duration_nights || '?') + 'N']; })), '');
        pkgSel.style.minWidth = '260px'; pkgSel.style.width = 'auto';
        wrap.appendChild(h('div', { style: { background: 'linear-gradient(180deg,#f0fdfa,#fff)',
          border: '2px dashed #14b8a6', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' } },
          h('div', { style: { fontWeight: 700, fontSize: '13px', marginBottom: '2px' } }, '📦 Start from a package'),
          h('div', { style: { fontSize: '11.5px', color: '#64748b', marginBottom: '10px' } },
            'Loads all template days & activities. Everything stays editable for this client.'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
            pkgSel,
            btn('✨ Apply package', async function () {
              const pid = Number(pkgSel.value || 0);
              if (!pid) { toast('Pick a package first'); return; }
              try {
                let res = await api('api_tour_itinerary_seedFromPackage', { booking_id: bookingId, package_id: pid });
                if (res && res.needs_replace) {
                  if (!confirm('This trip already has ' + res.existing_days + ' day(s). Replace them with the package template?')) return;
                  res = await api('api_tour_itinerary_seedFromPackage', { booking_id: bookingId, package_id: pid, replace: true });
                }
                if (res && res.ok) { toast('Applied · ' + res.days + ' days'); load(); }
                else toast((res && res.error) || 'Could not apply package');
              } catch (e) { toast(e.message); }
            }, 'primary'))));

        if (!days.length) {
          wrap.appendChild(h('div', { style: { background: '#f0fdfa',
            border: '1px dashed #ccfbf1', borderRadius: '10px',
            padding: '24px', textAlign: 'center', color: '#64748b' } },
            'No days yet. Apply a package above, or click "＋ Add Day" to build manually.'));
        }

        days.forEach(function (d, idx) {
          const dayActs = acts.filter(function (a) { return a.day_id === d.id; });
          wrap.appendChild(dayCardView(d, dayActs, {
            onMoveUp:   idx > 0 ? function () { reorder(idx, -1); } : null,
            onMoveDown: idx < days.length - 1 ? function () { reorder(idx, 1); } : null,
            onEditDay:  function () { itinDayModal(d, d.day_no); },
            onDelDay:   async function () {
              if (!confirm('Delete Day ' + d.day_no + '?')) return;
              try { await api('api_tour_itinerary_deleteDay', { id: d.id }); toast('Deleted'); load(); } catch (e) { toast(e.message); }
            },
            onAddAct:   function () { itinActModal(null, d.id); },
            onEditAct:  function (a) { itinActModal(a, d.id); },
            onDelAct:   async function (a) {
              try { await api('api_tour_itinerary_deleteActivity', { id: a.id }); toast('Removed'); load(); } catch (e) { toast(e.message); }
            }
          }));
        });

        // Add day button
        wrap.appendChild(h('div', { style: { marginTop: '14px' } },
          btn('＋ Add Day', function () { itinDayModal(null, days.length + 1); }, 'primary')));

        // ---- Custom-field manager ----
        function cfieldsModal() {
          const listWrap = h('div');
          function drawList() {
            listWrap.innerHTML = '';
            if (!cfields.length) {
              listWrap.appendChild(h('div', { style: { color: '#64748b', fontSize: '12.5px', padding: '6px 0' } },
                'No custom fields yet. Add fields like Flight no., Visa status, Guide language…'));
            }
            cfields.forEach(function (cf) {
              listWrap.appendChild(h('div', { style: { display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #ecfdf5', fontSize: '13px' } },
                h('span', {}, cf.label + ' ', h('span', { style: { color: '#94a3b8', fontSize: '11px' } }, '(' + cf.field_key + ')')),
                btn('🗑', async function () {
                  try { await api('api_tour_itinCfield_delete', { id: cf.id }); toast('Deleted'); reloadCfields(); } catch (e) { toast(e.message); }
                })));
            });
          }
          async function reloadCfields() {
            try { const r = await api('api_tour_itinCfields_list'); cfields.length = 0; (r.fields || []).forEach(function (x) { cfields.push(x); }); drawList(); }
            catch (e) { toast(e.message); }
          }
          const newInput = inp('', 'New field label, e.g. Flight no.');
          const body = h('div', {},
            h('div', { style: { fontSize: '12px', color: '#64748b', marginBottom: '10px' } },
              'Custom fields appear on every day\'s editor for this pack.'),
            listWrap,
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
              newInput,
              btn('＋ Add', async function () {
                if (!newInput.value.trim()) return;
                try { await api('api_tour_itinCfield_save', { label: newInput.value.trim() }); newInput.value = ''; reloadCfields(); }
                catch (e) { toast(e.message); }
              }, 'primary')));
          drawList();
          modal('🧩 Itinerary custom fields', body, []);
        }
      }
      function statusBadge(s) {
        if (s === 'acknowledged') return pill('✓ Acknowledged', 'ok');
        if (s === 'sent')         return pill('📤 Sent', 'info');
        return pill('📝 Draft', 'gray');
      }
      function kindEmoji(k) {
        const m = { arrival: '✈️', departure: '🛫', sightseeing: '🏛️',
          meal: '🍽️', transfer: '🚗', leisure: '🌴',
          adventure: '🪂', shopping: '🛍️' };
        return m[k] || '📌';
      }
      load();
    };

    // ════════════════════════════════════════════════════════════════
    //  PAYMENTS & COLLECTION
    // ════════════════════════════════════════════════════════════════
    VIEWS.tourpayments = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / Payments', '💰 Payments & Collection', [
        btn('🔄 Refresh', function () { refresh(); })
      ]));

      const wrap = h('div'); view.appendChild(wrap);

      async function refresh() {
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        let data;
        try { data = await api('api_tour_report_collection'); }
        catch (e) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
          return;
        }
        wrap.innerHTML = '';
        const k = data.kpis || {};
        wrap.appendChild(h('div', { style: { display: 'flex', gap: '12px',
          flexWrap: 'wrap', marginBottom: '14px' } },
          kpiTile('Outstanding',   fmtINR(k.outstanding || 0), 'total pending balance'),
          kpiTile('Overdue',       fmtINR(k.overdue || 0), 'travel started, balance unpaid', '#dc2626'),
          kpiTile('Due 7d',        fmtINR(k.due_7d || 0), 'travel next 7 days', '#b45309'),
          kpiTile('Collected (mo)', fmtINR(k.collected_month || 0), 'this month', '#16a34a')
        ));

        const bookings = data.bookings || [];
        if (!bookings.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#64748b', background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px' } },
            'All caught up — no outstanding balances.'));
          return;
        }

        const tblWrap = h('div', { style: { background: '#fff',
          border: '1px solid #ccfbf1', borderRadius: '10px', overflow: 'hidden' } });
        const tbl = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } });
        tbl.appendChild(h('thead', {}, h('tr', { style: { background: '#f0fdfa' } },
          ['Booking', 'Customer', 'Destination', 'Travel', 'Days to', 'Total', 'Balance', 'Action']
            .map(function (l) {
              return h('th', { style: { textAlign: 'left', padding: '10px 12px',
                borderBottom: '1px solid #ccfbf1', fontSize: '11.5px', textTransform: 'uppercase',
                letterSpacing: '.4px', color: '#475569', fontWeight: 600 } }, l);
            })
        )));
        const tbody = h('tbody', {});
        bookings.forEach(function (b) {
          const dtt = Number(b.days_to_travel);
          tbody.appendChild(h('tr', {},
            h('td', { style: td() }, h('b', {}, b.booking_no || ('#' + b.id))),
            h('td', { style: td() }, b.lead_name || '—'),
            h('td', { style: td() }, (b.flag || '') + ' ' + (b.destination_name || '—')),
            h('td', { style: td() }, b.travel_start_date ? String(b.travel_start_date).slice(0, 10) : '—'),
            h('td', { style: td() },
              dtt < 0
                ? pill(Math.abs(dtt) + 'd ago', 'bad')
                : dtt <= 7
                  ? pill('in ' + dtt + 'd', 'warn')
                  : (dtt + 'd')),
            h('td', { style: td() }, fmtINR(b.total_inr)),
            h('td', { style: td() }, h('b', { style: { color: '#dc2626' } }, fmtINR(b.balance_inr))),
            h('td', { style: td() },
              h('button', {
                style: { background: 'linear-gradient(135deg,#14b8a6,#0d9488)', color: '#fff',
                  border: 0, padding: '4px 10px', borderRadius: '6px', fontSize: '11.5px',
                  fontWeight: 700, cursor: 'pointer' },
                onclick: async function () {
                  const amt = prompt('Amount received (₹):', b.balance_inr);
                  if (!amt) return;
                  try { await api('api_tour_payment_record', { booking_id: b.id,
                    amount_inr: Number(amt), mode: 'bank' });
                    toast('Payment recorded');
                    refresh();
                  } catch (e) { toast(e.message); }
                }
              }, '💰 Record')
            )
          ));
        });
        tbl.appendChild(tbody);
        tblWrap.appendChild(tbl);
        wrap.appendChild(tblWrap);
      }
      function td() { return { padding: '10px 12px', borderBottom: '1px solid #ecfdf5' }; }
      refresh();
    };

    // ════════════════════════════════════════════════════════════════
    //  TRAVEL REPORTS
    // ════════════════════════════════════════════════════════════════
    VIEWS.tourreports = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / Travel Reports', '📊 Travel Reports', []));

      const tabs = h('div', { style: { display: 'flex', gap: '6px',
        background: '#fff', padding: '6px', borderRadius: '10px',
        border: '1px solid #ccfbf1', marginBottom: '14px' } });
      const TABS = [
        ['upcoming',   '✈️ Upcoming'],
        ['collection', '💰 Collection'],
        ['itinerary',  '🗺️ Itinerary Status'],
        ['leaderboard','🏆 Agent Leaderboard']
      ];
      let active = 'upcoming';
      const wrap = h('div'); view.appendChild(tabs); view.appendChild(wrap);

      TABS.forEach(function (t) {
        const b = h('button', {
          style: tabStyle(active === t[0]),
          onclick: function () { active = t[0]; renderTabs(); render(); }
        }, t[1]);
        tabs.appendChild(b);
      });
      function tabStyle(on) {
        return {
          padding: '8px 14px', borderRadius: '7px',
          background: on ? 'linear-gradient(180deg,#14b8a6,#0d9488)' : 'transparent',
          color: on ? '#fff' : '#475569',
          border: 0, fontSize: '13px', fontWeight: 600, cursor: 'pointer'
        };
      }
      function renderTabs() {
        Array.from(tabs.children).forEach(function (b, i) {
          Object.assign(b.style, tabStyle(TABS[i][0] === active));
        });
      }

      async function render() {
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Loading…</div>';
        try {
          if (active === 'upcoming') await renderUpcoming();
          else if (active === 'collection') await renderCollection();
          else if (active === 'itinerary')  await renderItin();
          else                              await renderLeaderboard();
        } catch (e) {
          wrap.innerHTML = '';
          wrap.appendChild(h('div', { style: { padding: '1rem', color: '#dc2626' } }, e.message));
        }
      }

      async function renderUpcoming() {
        const r = await api('api_tour_report_upcoming', { days: 30 });
        wrap.innerHTML = '';
        if (!r.bookings || !r.bookings.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#64748b', background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px' } },
            'No upcoming trips in the next 30 days.'));
          return;
        }
        const tbl = makeTable(['Booking', 'Customer', 'Destination', 'Travel', 'Days to', 'PAX', 'Balance', 'Visa']);
        r.bookings.forEach(function (b) {
          tbl.tbody.appendChild(h('tr', {},
            cell(b.booking_no || ('#' + b.id), true),
            cell(b.lead_name || '—'),
            cell((b.flag || '') + ' ' + (b.destination_name || '—')),
            cell(b.travel_start_date ? String(b.travel_start_date).slice(0, 10) : '—'),
            cell(b.days_to_travel <= 7 ? pill('in ' + b.days_to_travel + 'd', 'warn') : b.days_to_travel + 'd'),
            cell(String(b.travellers || 1)),
            cell(fmtINR(b.balance_inr)),
            cell(visaPill(b.visa_status))
          ));
        });
        wrap.appendChild(tbl.wrap);
      }

      async function renderCollection() {
        const r = await api('api_tour_report_collection');
        wrap.innerHTML = '';
        const k = r.kpis || {};
        wrap.appendChild(h('div', { style: { display: 'flex', gap: '12px',
          flexWrap: 'wrap', marginBottom: '14px' } },
          kpiTile('Outstanding',    fmtINR(k.outstanding || 0), 'balance pending'),
          kpiTile('Overdue',        fmtINR(k.overdue || 0), 'travel past balance unpaid', '#dc2626'),
          kpiTile('Due 7d',         fmtINR(k.due_7d || 0), 'next 7 days', '#b45309'),
          kpiTile('Collected (mo)', fmtINR(k.collected_month || 0), 'this month', '#16a34a')
        ));
        if (!r.bookings || !r.bookings.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#64748b', background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px' } },
            'All bookings fully paid.'));
          return;
        }
        const tbl = makeTable(['Booking', 'Customer', 'Destination', 'Travel', 'Days to', 'Balance']);
        r.bookings.forEach(function (b) {
          tbl.tbody.appendChild(h('tr', {},
            cell(b.booking_no || ('#' + b.id), true),
            cell(b.lead_name || '—'),
            cell((b.flag || '') + ' ' + (b.destination_name || '—')),
            cell(b.travel_start_date ? String(b.travel_start_date).slice(0, 10) : '—'),
            cell(b.days_to_travel < 0 ? pill(Math.abs(b.days_to_travel) + 'd ago', 'bad')
                 : pill('in ' + b.days_to_travel + 'd', 'warn')),
            cell(h('b', { style: { color: '#dc2626' } }, fmtINR(b.balance_inr)))
          ));
        });
        wrap.appendChild(tbl.wrap);
      }

      async function renderItin() {
        const r = await api('api_tour_report_itineraryStatus');
        wrap.innerHTML = '';
        if (!r.rows || !r.rows.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#64748b', background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px' } },
            'No active bookings.'));
          return;
        }
        const tbl = makeTable(['Booking', 'Customer', 'Destination', 'Travel', 'Days to', 'Itin Status', 'Planned', 'Action']);
        r.rows.forEach(function (b) {
          const stsPill = !b.itinerary_id ? pill('No itinerary', 'bad')
            : b.itin_status === 'acknowledged' ? pill('✓ Read', 'ok')
            : b.itin_status === 'sent' ? pill('📤 Sent', 'info')
            : pill('📝 Draft', 'gray');
          const planned = (b.days_planned || 0) + ' / ' + (b.total_days || '?');
          tbl.tbody.appendChild(h('tr', {},
            cell(b.booking_no || ('#' + b.booking_id), true),
            cell(b.lead_name || '—'),
            cell((b.flag || '') + ' ' + (b.destination_name || '—')),
            cell(b.travel_start_date ? String(b.travel_start_date).slice(0, 10) : '—'),
            cell((b.days_to_travel || 0) + 'd'),
            cell(stsPill),
            cell(planned),
            cell(h('button', {
              style: { background: 'transparent', border: '1px solid #ccfbf1',
                borderRadius: '6px', padding: '4px 8px', fontSize: '11.5px',
                cursor: 'pointer', color: TEAL2 },
              onclick: function () {
                window.location.hash = '#/touritinerary?booking_id=' + b.booking_id;
              }
            }, '🗺️ Open'))
          ));
        });
        wrap.appendChild(tbl.wrap);
      }

      async function renderLeaderboard() {
        const r = await api('api_tour_report_agentLeaderboard', { days: 30 });
        wrap.innerHTML = '';
        if (!r.agents || !r.agents.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center',
            color: '#64748b', background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px' } },
            'No agent activity in last 30 days. Bookings need an assignee_user_id to count here.'));
          return;
        }
        const tbl = makeTable(['Rank', 'Agent', 'Bookings', 'Revenue', 'Avg ticket']);
        r.agents.forEach(function (a, i) {
          const trophy = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
          tbl.tbody.appendChild(h('tr', {},
            cell(String(trophy)),
            cell(a.name || '—', true),
            cell(String(a.bookings || 0)),
            cell(fmtINR(a.revenue || 0)),
            cell(fmtINR(a.avg_ticket || 0))
          ));
        });
        wrap.appendChild(tbl.wrap);
      }

      function makeTable(cols) {
        const w = h('div', { style: { background: '#fff', border: '1px solid #ccfbf1',
          borderRadius: '10px', overflow: 'hidden' } });
        const t = h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' } });
        t.appendChild(h('thead', {}, h('tr', { style: { background: '#f0fdfa' } },
          cols.map(function (l) {
            return h('th', { style: { textAlign: 'left', padding: '10px 12px',
              borderBottom: '1px solid #ccfbf1', fontSize: '11.5px',
              textTransform: 'uppercase', letterSpacing: '.4px', color: '#475569',
              fontWeight: 600 } }, l);
          })
        )));
        const tbody = h('tbody', {});
        t.appendChild(tbody);
        w.appendChild(t);
        return { wrap: w, tbody: tbody };
      }
      function cell(content, bold) {
        const c = h('td', { style: { padding: '10px 12px', borderBottom: '1px solid #ecfdf5' } });
        if (bold) c.appendChild(h('b', {}, content));
        else if (typeof content === 'object' && content && content.nodeType) c.appendChild(content);
        else c.textContent = String(content);
        return c;
      }
      function visaPill(v) {
        if (v === 'approved') return pill('✓ Approved', 'ok');
        if (v === 'pending')  return pill('⏳ Pending', 'warn');
        if (v === 'rejected') return pill('✗ Rejected', 'bad');
        return pill('N/A', 'gray');
      }
      renderTabs();
      render();
    };

    // ════════════════════════════════════════════════════════════════
    //  AI INSIGHTS — rule-based v1
    // ════════════════════════════════════════════════════════════════
    VIEWS.tourinsights = async function (view) {
      view.innerHTML = '';
      view.appendChild(topbar('Holiday / AI Insights', '🤖 AI Insights', [
        btn('🔄 Regenerate', function () { load(); })
      ]));
      const wrap = h('div'); view.appendChild(wrap);

      async function load() {
        wrap.innerHTML = '<div style="padding:1rem;color:#64748b">Computing…</div>';
        let summary = {}, collection = {}, itin = {};
        try { summary    = await api('api_tour_summary'); } catch (_) {}
        try { collection = await api('api_tour_report_collection'); } catch (_) {}
        try { itin       = await api('api_tour_report_itineraryStatus'); } catch (_) {}

        const insights = [];
        const b = summary.bookings || {};
        const m = summary.money || {};
        const ci = summary.itineraries || {};

        if ((b.upcoming_30d || 0) > 0) {
          insights.push({
            type: 'growth', emoji: '✈️',
            headline: (b.upcoming_30d) + ' trips in next 30 days',
            detail: 'Cross-check visas, hotel vouchers, and itineraries before departure.',
            action: 'Open Upcoming report'
          });
        }
        if ((m.overdue || 0) > 0) {
          insights.push({
            type: 'warning', emoji: '⚠️',
            headline: fmtINR(m.overdue) + ' overdue from travelled bookings',
            detail: 'Customers travelled with balance still unpaid. Risk: churn + bad debt.',
            action: 'Open Collection report + call today'
          });
        }
        if ((m.visa_pending || 0) > 0) {
          insights.push({
            type: 'warning', emoji: '🛂',
            headline: (m.visa_pending) + ' visas still pending',
            detail: 'Confirm visa lead time per destination. Trips < 21 days away with pending visa = high cancel risk.',
            action: 'Filter Bookings → Visa pending'
          });
        }
        if ((ci.itin_no_plan || 0) > 0) {
          insights.push({
            type: 'suggest', emoji: '🗺️',
            headline: (ci.itin_no_plan) + ' bookings have no itinerary',
            detail: 'Customer satisfaction drops sharply when itinerary is sent late. Plan within 3 days of booking.',
            action: 'Open Itinerary Builder'
          });
        }
        if ((b.travelling_now || 0) > 0) {
          insights.push({
            type: 'trend', emoji: '🌍',
            headline: b.travelling_now + ' guests currently travelling',
            detail: 'Send "Hope you are enjoying!" WA message on Day 2-3 of the trip — drives 22% more referrals.',
            action: 'Send on-trip WA template'
          });
        }
        insights.push({
          type: 'trend', emoji: '🤖',
          headline: 'Weekly Gemini-powered digest ships in v1.2',
          detail: 'Rule-based insights today. Next: trend lines, predictive forecasting, and natural-language Q&A on bookings.',
          action: 'Available with COPILOT_PROACTIVE_ENABLED'
        });

        wrap.innerHTML = '';
        if (!insights.length) {
          wrap.appendChild(h('div', { style: { padding: '24px', textAlign: 'center', color: '#64748b' } },
            'No insights yet. Seed data first to generate.'));
          return;
        }
        const grid = h('div', { style: { display: 'grid',
          gridTemplateColumns: '1fr 1fr', gap: '10px' } });
        const borderMap = { growth: '#10b981', warning: '#dc2626', suggest: '#a855f7', trend: '#0ea5e9' };
        insights.forEach(function (ins) {
          grid.appendChild(h('div', { style: {
            background: '#fff', border: '1px solid #ccfbf1', borderRadius: '10px',
            padding: '14px', borderLeft: '4px solid ' + (borderMap[ins.type] || TEAL)
          } },
            h('div', { style: { display: 'flex', gap: '10px' } },
              h('div', { style: { fontSize: '22px' } }, ins.emoji),
              h('div', { style: { flex: 1 } },
                h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, ins.headline),
                h('div', { style: { fontSize: '12.5px', color: '#475569' } }, ins.detail),
                h('div', { style: { marginTop: '8px', fontSize: '12px', fontWeight: 600,
                  borderTop: '1px solid #ccfbf1', paddingTop: '6px', color: TEAL2 } },
                  '→ ' + ins.action)
              )
            )
          ));
        });
        wrap.appendChild(grid);
      }
      load();
    };

    console.log('[HOLIDAY_PACK_v1] views wired:',
      'packholiday, tourbookings, tourdestinations, touritinerary, tourpayments, tourreports, tourinsights');
  });
})();
